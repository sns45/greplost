/**
 * Import and export records for one file (tech spec 5.1).
 *
 * Static `import` / `export … from` statements come from the top-level pass;
 * `import("x")` and `require("x")` arrive from the call walker through
 * `recordModuleCall`. Nothing here resolves a specifier: that is the resolver's job.
 */

import type { Node } from "web-tree-sitter";
import type { ImportKind, ImportedSymbol } from "../schema.ts";
import type { TsContext } from "./ts.ts";
import { childOfType, field, lineOf, specifierName, stringOf } from "./ts-signature.ts";

/** Wrappers that sit between a `variable_declarator` and its `import()`/`require()` call. */
const VALUE_WRAPPERS: ReadonlySet<string> = new Set([
  "await_expression",
  "parenthesized_expression",
  "as_expression",
  "non_null_expression",
  "satisfies_expression",
]);

/**
 * Nodes that make everything below them a type, so an `import("x")` inside is an
 * `import("x").T` type reference rather than a runtime module load.
 */
const TYPE_CONTEXTS: ReadonlySet<string> = new Set([
  "type_annotation",
  "type_alias_declaration",
  "type_arguments",
  "type_parameters",
  "type_predicate",
  "type_predicate_annotation",
  "opting_type_annotation",
  "omitting_type_annotation",
  "index_type_query",
  "conditional_type",
  "object_type",
  "interface_body",
  "extends_type_clause",
  "implements_clause",
]);

/** `import type …` / `export type …`: the keyword is the statement's second token. */
function hasTypeKeyword(node: Node): boolean {
  const tokens = node.children.filter((child) => child.type !== "comment");
  const second = tokens[1];
  if (second === undefined) return false;
  // `export type * from "x"` is not in the 0.23 grammar and lands in an ERROR node.
  return second.type === "type" || (second.type === "ERROR" && second.text === "type");
}

// ----------------------------------------------------------------- imports

export function collectImportStatement(ctx: TsContext, node: Node): void {
  // `import m = require("x")`: the specifier hangs off the require clause.
  const requireClause = childOfType(node, "import_require_clause");
  if (requireClause !== null) {
    const specifierNode = field(requireClause, "source");
    if (specifierNode === null) return;
    const binding = childOfType(requireClause, "identifier");
    ctx.imports.push({
      specifier: stringOf(specifierNode),
      kind: "static",
      symbols: [{ name: "*", local: binding === null ? "*" : binding.text }],
      reexport: false,
      line: lineOf(node),
    });
    return;
  }

  const specifierNode = field(node, "source");
  if (specifierNode === null) return;
  const specifier = stringOf(specifierNode);
  const clause = childOfType(node, "import_clause");
  if (clause === null) {
    ctx.imports.push({ specifier, kind: "side-effect", symbols: [], reexport: false, line: lineOf(node) });
    return;
  }
  const kind: ImportKind = hasTypeKeyword(node) ? "type" : "static";
  ctx.imports.push({ specifier, kind, symbols: clauseSymbols(clause), reexport: false, line: lineOf(node) });
}

function clauseSymbols(clause: Node): ImportedSymbol[] {
  const symbols: ImportedSymbol[] = [];
  for (const part of clause.namedChildren) {
    if (part.type === "identifier") {
      symbols.push({ name: "default", local: part.text });
    } else if (part.type === "namespace_import") {
      const binding = childOfType(part, "identifier");
      if (binding !== null) symbols.push({ name: "*", local: binding.text });
    } else if (part.type === "named_imports") {
      for (const specifier of part.namedChildren) {
        if (specifier.type !== "import_specifier") continue;
        const name = field(specifier, "name");
        if (name === null) continue;
        const alias = field(specifier, "alias");
        symbols.push({
          name: specifierName(name),
          local: alias === null ? specifierName(name) : specifierName(alias),
        });
      }
    }
  }
  return symbols;
}

// ----------------------------------------------------------------- exports

export function collectExportStatement(ctx: TsContext, node: Node): void {
  const from = field(node, "source");
  const clause = childOfType(node, "export_clause");
  const namespaceExport = childOfType(node, "namespace_export");

  if (from !== null) {
    collectReexport(ctx, node, stringOf(from), clause, namespaceExport);
    return;
  }

  if (clause !== null) {
    for (const specifier of clause.namedChildren) {
      if (specifier.type !== "export_specifier") continue;
      const local = field(specifier, "name");
      if (local === null) continue;
      const alias = field(specifier, "alias");
      const localName = specifierName(local);
      const exportedName = alias === null ? localName : specifierName(alias);
      if (exportedName === "default") ctx.exports.push({ name: "default", kind: "default", local: localName });
      else if (alias === null) ctx.exports.push({ name: exportedName, kind: "named" });
      else ctx.exports.push({ name: exportedName, kind: "named", local: localName });
    }
    return;
  }

  const isDefault = node.children.some((child) => child.type === "default");
  const declaration = field(node, "declaration");
  if (declaration !== null) {
    const names =
      declaration.type === "ambient_declaration"
        ? declaration.namedChildren.flatMap((inner) => ctx.declare(inner, node, true))
        : ctx.declare(declaration, node, true);
    for (const name of names) {
      if (isDefault) ctx.exports.push({ name: "default", kind: "default", local: name });
      else ctx.exports.push({ name, kind: "named" });
    }
    return;
  }

  const value = field(node, "value");
  if (value !== null) {
    collectDefaultValue(ctx, node, value);
    return;
  }

  // `export = x`
  if (node.children[1]?.type === "=") {
    const target = node.namedChildren[0];
    ctx.exports.push({ name: "default", kind: "default", ...(target === undefined ? {} : { local: target.text }) });
  }
}

function collectReexport(
  ctx: TsContext,
  node: Node,
  specifier: string,
  clause: Node | null,
  namespaceExport: Node | null,
): void {
  const kind: ImportKind = hasTypeKeyword(node) ? "type" : "static";
  const symbols: ImportedSymbol[] = [];

  if (clause !== null) {
    for (const entry of clause.namedChildren) {
      if (entry.type !== "export_specifier") continue;
      const local = field(entry, "name");
      if (local === null) continue;
      const alias = field(entry, "alias");
      const localName = specifierName(local);
      const exportedName = alias === null ? localName : specifierName(alias);
      symbols.push({ name: localName, local: exportedName });
      if (exportedName === "default") {
        ctx.exports.push({ name: "default", kind: "default", local: localName, from: specifier });
      } else {
        ctx.exports.push({ name: exportedName, kind: "named", local: localName, from: specifier });
      }
    }
  } else if (namespaceExport !== null) {
    const binding = namespaceExport.namedChildren[0];
    const local = binding === undefined ? "*" : binding.text;
    symbols.push({ name: "*", local });
    // `export * as default from "x"` is a default export like any other.
    const exportKind = local === "default" ? "default" : "named";
    ctx.exports.push({ name: local, kind: exportKind, local: "*", from: specifier });
  } else {
    symbols.push({ name: "*", local: "*" });
    ctx.exports.push({ name: "*", kind: "star", from: specifier });
  }

  ctx.imports.push({ specifier, kind, symbols, reexport: true, line: lineOf(node) });
}

/** `export default <value>`: anonymous functions and classes become a `default` symbol. */
function collectDefaultValue(ctx: TsContext, node: Node, value: Node): void {
  if (value.type === "class" || value.type === "function_expression" || value.type === "generator_function") {
    const written = ctx.declareDefault(value, node);
    ctx.exports.push({ name: "default", kind: "default", ...(written === null ? {} : { local: written }) });
    return;
  }
  if (value.type === "identifier") {
    ctx.exports.push({ name: "default", kind: "default", local: value.text });
    return;
  }
  ctx.exports.push({ name: "default", kind: "default" });
}

/** `module.exports = …`, `module.exports.foo = …`, `exports.foo = …` (v1 CommonJS, best effort). */
export function collectCommonJsExport(ctx: TsContext, assignment: Node): void {
  const left = field(assignment, "left");
  if (left === null || left.type !== "member_expression") return;
  const object = field(left, "object");
  const property = field(left, "property");
  if (object === null || property === null) return;

  if (object.type === "identifier" && object.text === "module" && property.text === "exports") {
    const right = field(assignment, "right");
    const local = right !== null && right.type === "identifier" ? { local: right.text } : {};
    ctx.exports.push({ name: "default", kind: "default", ...local });
    return;
  }
  if (object.type === "identifier" && object.text === "exports") {
    ctx.exports.push({ name: property.text, kind: "named" });
    return;
  }
  if (object.type === "member_expression") {
    const inner = field(object, "object");
    const innerProperty = field(object, "property");
    if (inner?.type === "identifier" && inner.text === "module" && innerProperty?.text === "exports") {
      ctx.exports.push({ name: property.text, kind: "named" });
    }
  }
}

// ------------------------------------------------- import() and require()

/** `import("x")` and `require("x")` become import records, never call sites. */
export function recordModuleCall(ctx: TsContext, call: Node, form: "dynamic" | "require"): void {
  const args = field(call, "arguments");
  if (args === null) return;
  const literal = args.namedChildren[0];
  if (literal === undefined || literal.type !== "string") return;
  const specifier = stringOf(literal);

  // `type X = import("./mod").Foo` loads no module at runtime: it is a type import
  // of `Foo`, and the tsc-derived truth records it the same way.
  if (form === "dynamic" && inTypePosition(call)) {
    ctx.imports.push({
      specifier,
      kind: "type",
      symbols: typeImportSymbols(call),
      reexport: false,
      line: lineOf(call),
    });
    return;
  }

  // A bare `require("x");` statement binds nothing: it is a side effect.
  if (form === "require" && call.parent?.type === "expression_statement") {
    ctx.imports.push({ specifier, kind: "side-effect", symbols: [], reexport: false, line: lineOf(call) });
    return;
  }

  ctx.imports.push({
    specifier,
    kind: form === "dynamic" ? "dynamic" : "static",
    symbols: bindingSymbols(call),
    reexport: false,
    line: lineOf(call),
  });
}

/** True when the call is the operand of a type rather than of an expression. */
function inTypePosition(call: Node): boolean {
  for (let node = call.parent; node !== null; node = node.parent) {
    if (TYPE_CONTEXTS.has(node.type)) return true;
    // A type never contains a statement, so this is the end of the search.
    if (node.type === "statement_block" || node.type === "program") return false;
  }
  return false;
}

/** `import("x").T` imports `T`; anything less explicit imports the whole module. */
function typeImportSymbols(call: Node): ImportedSymbol[] {
  const parent = call.parent;
  if (parent !== null && parent.type === "member_expression") {
    const object = field(parent, "object");
    const property = field(parent, "property");
    if (object !== null && property !== null && object.id === call.id) {
      return [{ name: property.text, local: property.text }];
    }
  }
  return [{ name: "*", local: "*" }];
}

/** The `variable_declarator` this call initialises, looking through await/paren wrappers. */
function bindingTarget(call: Node): Node | null {
  let node: Node | null = call.parent;
  while (node !== null && VALUE_WRAPPERS.has(node.type)) node = node.parent;
  return node !== null && node.type === "variable_declarator" ? node : null;
}

function bindingSymbols(call: Node): ImportedSymbol[] {
  const declarator = bindingTarget(call);
  if (declarator !== null) {
    const name = field(declarator, "name");
    if (name !== null && name.type === "identifier") return [{ name: "*", local: name.text }];
    if (name !== null && name.type === "object_pattern") return patternSymbols(name);
  }
  return [{ name: "*", local: "*" }];
}

function patternSymbols(pattern: Node): ImportedSymbol[] {
  const symbols: ImportedSymbol[] = [];
  for (const part of pattern.namedChildren) {
    if (part.type === "shorthand_property_identifier_pattern") {
      symbols.push({ name: part.text, local: part.text });
    } else if (part.type === "pair_pattern") {
      const key = field(part, "key");
      const value = field(part, "value");
      if (key !== null && value !== null && value.type === "identifier") {
        symbols.push({ name: key.text, local: value.text });
      }
    }
  }
  return symbols.length === 0 ? [{ name: "*", local: "*" }] : symbols;
}
