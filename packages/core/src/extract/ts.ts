/**
 * TypeScript / TSX / JavaScript / JSX extraction (tech spec 5.1).
 *
 * Two passes over one tree:
 *  A. the program's own children -> declarations, static imports, exports.
 *     Only top-level declarations and class members are tracked; nothing inside a
 *     function body or a namespace body becomes a symbol.
 *  B. the whole tree -> call sites, dynamic `import()` and `require()` records,
 *     with the caller attributed to the nearest enclosing *tracked* declaration.
 *
 * Nothing here is inferred: a construct either matches a rule or is dropped.
 */

import type { Node, Tree } from "web-tree-sitter";
import type {
  CallSite,
  DeclKind,
  Declaration,
  ExportRecord,
  FileRecord,
  ImportKind,
  ImportRecord,
  ImportedSymbol,
  Lang,
} from "../schema.ts";
import { symbolId } from "../schema.ts";

/** Signatures longer than this are clipped to 199 characters plus an ellipsis. */
const MAX_SIGNATURE = 200;

/** A declaration plus the bookkeeping needed to collapse overload signatures. */
interface Entry {
  decl: Declaration;
  /** True for a bodiless `function_signature` (an overload or an ambient declaration). */
  overload: boolean;
}

/** Enclosing declaration context while walking for call sites. */
interface Ctx {
  caller: string;
  className: string;
}

const EMPTY_CTX: Ctx = { caller: "", className: "" };

/** Initialisers that make a variable a callable declaration (used for caller attribution). */
const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "generator_function"]);

/** Initialisers whose body is cut out of a variable's signature. */
const BODY_VALUES = new Set([...FUNCTION_VALUES, "class"]);

/** Wrappers that sit between a `variable_declarator` and its `import()`/`require()` call. */
const VALUE_WRAPPERS = new Set([
  "await_expression",
  "parenthesized_expression",
  "as_expression",
  "non_null_expression",
  "satisfies_expression",
]);

export function extractTs(
  path: string,
  lang: Lang,
  source: string,
  tree: Tree,
): Pick<FileRecord, "decls" | "imports" | "exports" | "calls"> {
  // `lang` only selects the grammar (done by the caller); the TS and TSX grammars
  // accept every JS dialect, so extraction itself is dialect-independent.
  void lang;

  const entries: Entry[] = [];
  const imports: ImportRecord[] = [];
  const exports: ExportRecord[] = [];
  const calls: CallSite[] = [];

  // ---------------------------------------------------------------- helpers

  const field = (node: Node, name: string): Node | null => node.childForFieldName(name);
  const lineOf = (node: Node): number => node.startPosition.row + 1;
  const spanOf = (node: Node): [number, number] => [node.startPosition.row + 1, node.endPosition.row + 1];

  function nameOf(node: Node): string | null {
    const name = field(node, "name");
    return name === null ? null : name.text;
  }

  function childOfType(node: Node, type: string): Node | null {
    for (const child of node.children) if (child.type === type) return child;
    return null;
  }

  /** Collapse whitespace, drop a trailing `;`, clip to MAX_SIGNATURE. */
  function clip(text: string): string {
    const flat = text.replace(/\s+/gu, " ").trim().replace(/;$/u, "").trim();
    return flat.length > MAX_SIGNATURE ? `${flat.slice(0, MAX_SIGNATURE - 1)}…` : flat;
  }

  function sliceExcluding(start: number, end: number, cuts: Array<[number, number]>): string {
    if (start >= end) return "";
    if (cuts.length === 0) return source.slice(start, end);
    const sorted = [...cuts].sort((a, b) => a[0] - b[0]);
    let out = "";
    let at = start;
    for (const [cutStart, cutEnd] of sorted) {
      if (cutEnd <= at || cutStart >= end) continue;
      if (cutStart > at) out += source.slice(at, cutStart);
      at = Math.max(at, cutEnd);
    }
    if (at < end) out += source.slice(at, end);
    return out;
  }

  /**
   * Header text of a declaration: from the outermost node (so `export` / `export
   * default` / `declare` are kept) to the byte before the body, minus leading
   * decorators, which say nothing about the shape of the symbol.
   */
  function signatureText(node: Node, outer: Node): string {
    const body = field(node, "body");
    const end = body === null ? outer.endIndex : body.startIndex;
    const cuts: Array<[number, number]> = [];
    const dropDecorators = (owner: Node): void => {
      for (const child of owner.children) {
        if (child.type === "decorator") cuts.push([child.startIndex, child.endIndex]);
        else if (child.type !== "comment") break;
      }
    };
    dropDecorators(outer);
    if (node !== outer) dropDecorators(node);
    return clip(sliceExcluding(outer.startIndex, Math.max(end, outer.startIndex), cuts));
  }

  /** `const a = 1, b = 2` gives each declarator its own `const b = 2` header. */
  function variableSignature(outer: Node, list: Node, declarator: Node): string {
    const first = childOfType(list, "variable_declarator");
    const prefixEnd = first === null ? list.endIndex : first.startIndex;
    const prefix = sliceExcluding(outer.startIndex, Math.max(prefixEnd, outer.startIndex), []);
    return clip(prefix + source.slice(declarator.startIndex, variableCut(declarator)));
  }

  function variableCut(declarator: Node): number {
    const value = field(declarator, "value");
    if (value !== null && BODY_VALUES.has(value.type)) {
      const body = field(value, "body");
      if (body !== null) return body.startIndex;
    }
    return declarator.endIndex;
  }

  function addEntry(
    name: string,
    kind: DeclKind,
    signature: string,
    span: [number, number],
    exported: boolean,
    parent?: string,
    overload = false,
  ): void {
    entries.push({
      decl: {
        id: symbolId(path, name),
        file: path,
        name,
        kind,
        signature,
        exported,
        span,
        ...(parent === undefined ? {} : { parent }),
      },
      overload,
    });
  }

  /** Text of a string literal without its quotes. */
  function stringOf(node: Node): string {
    const text = node.text;
    const quote = text[0];
    if (text.length >= 2 && (quote === '"' || quote === "'" || quote === "`") && text.endsWith(quote)) {
      return text.slice(1, -1);
    }
    const fragment = childOfType(node, "string_fragment");
    return fragment === null ? text : fragment.text;
  }

  /** Specifier names may be written as string literals (`export { a as "b" }`). */
  function specifierName(node: Node): string {
    return node.type === "string" ? stringOf(node) : node.text;
  }

  /** `import type …` / `export type …`: the keyword is the statement's second child. */
  function hasTypeKeyword(node: Node): boolean {
    const tokens = node.children.filter((child) => child.type !== "comment");
    const second = tokens[1];
    if (second === undefined) return false;
    // `export type * from "x"` is not in the 0.23 grammar and lands in an ERROR node.
    return second.type === "type" || (second.type === "ERROR" && second.text === "type");
  }

  // ------------------------------------------------------- pass A: top level

  function collectTop(node: Node): void {
    switch (node.type) {
      case "import_statement":
        collectImport(node);
        return;
      case "export_statement":
        collectExport(node);
        return;
      case "ambient_declaration":
        for (const inner of node.namedChildren) collectDeclaration(inner, node, false);
        return;
      case "expression_statement": {
        const inner = node.namedChildren.find((child) => child.type !== "comment");
        if (inner === undefined) return;
        // `namespace X {}` at the top level is wrapped in an expression statement.
        if (inner.type === "internal_module") collectDeclaration(inner, node, false);
        else if (inner.type === "assignment_expression") collectCommonJsExport(inner);
        return;
      }
      default:
        collectDeclaration(node, node, false);
    }
  }

  /** Adds the declarations of `node` and returns the names it declared. */
  function collectDeclaration(node: Node, outer: Node, exported: boolean): string[] {
    switch (node.type) {
      case "function_declaration":
      case "generator_function_declaration":
      case "function_signature": {
        const name = nameOf(node);
        if (name === null) return [];
        addEntry(
          name,
          "function",
          signatureText(node, outer),
          spanOf(outer),
          exported,
          undefined,
          node.type === "function_signature",
        );
        return [name];
      }
      case "class_declaration":
      case "abstract_class_declaration": {
        const name = nameOf(node);
        if (name === null) return [];
        addEntry(name, "class", signatureText(node, outer), spanOf(outer), exported);
        collectMethods(node, name, exported);
        return [name];
      }
      case "interface_declaration":
        return simpleDeclaration(node, outer, exported, "interface");
      case "type_alias_declaration":
        return simpleDeclaration(node, outer, exported, "type");
      case "enum_declaration":
        return simpleDeclaration(node, outer, exported, "enum");
      case "internal_module":
        return simpleDeclaration(node, outer, exported, "namespace");
      case "lexical_declaration":
      case "variable_declaration": {
        const kind = variableKind(node);
        const names: string[] = [];
        for (const declarator of node.children) {
          if (declarator.type !== "variable_declarator") continue;
          const name = field(declarator, "name");
          // Destructuring patterns bind names the map cannot attribute; they are skipped.
          if (name === null || name.type !== "identifier") continue;
          addEntry(name.text, kind, variableSignature(outer, node, declarator), spanOf(outer), exported);
          names.push(name.text);
        }
        return names;
      }
      default:
        return [];
    }
  }

  function simpleDeclaration(node: Node, outer: Node, exported: boolean, kind: DeclKind): string[] {
    const name = nameOf(node);
    if (name === null) return [];
    addEntry(name, kind, signatureText(node, outer), spanOf(outer), exported);
    return [name];
  }

  function variableKind(node: Node): DeclKind {
    const keyword = node.children[0]?.text ?? "";
    if (keyword === "let") return "let";
    if (keyword === "var") return "var";
    return "const";
  }

  function collectMethods(classNode: Node, className: string, exported: boolean): void {
    const body = field(classNode, "body");
    if (body === null) return;
    for (const member of body.namedChildren) {
      if (member.type !== "method_definition") continue;
      const name = field(member, "name");
      if (name === null) continue;
      // Computed and literal member names cannot be addressed as a symbol path.
      if (name.type !== "property_identifier" && name.type !== "private_property_identifier") continue;
      addEntry(`${className}.${name.text}`, "method", signatureText(member, member), spanOf(member), exported, className);
    }
  }

  // ------------------------------------------------------------- imports

  function collectImport(node: Node): void {
    // `import m = require("x")`: the specifier hangs off the require clause.
    const requireClause = childOfType(node, "import_require_clause");
    if (requireClause !== null) {
      const specifierNode = field(requireClause, "source");
      if (specifierNode === null) return;
      const binding = childOfType(requireClause, "identifier");
      imports.push({
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
      imports.push({ specifier, kind: "side-effect", symbols: [], reexport: false, line: lineOf(node) });
      return;
    }
    const kind: ImportKind = hasTypeKeyword(node) ? "type" : "static";
    imports.push({ specifier, kind, symbols: clauseSymbols(clause), reexport: false, line: lineOf(node) });
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

  // ------------------------------------------------------------- exports

  function collectExport(node: Node): void {
    const from = field(node, "source");
    const clause = childOfType(node, "export_clause");
    const namespaceExport = childOfType(node, "namespace_export");

    if (from !== null) {
      collectReexport(node, stringOf(from), clause, namespaceExport);
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
        if (exportedName === "default") exports.push({ name: "default", kind: "default", local: localName });
        else if (alias === null) exports.push({ name: exportedName, kind: "named" });
        else exports.push({ name: exportedName, kind: "named", local: localName });
      }
      return;
    }

    const isDefault = node.children.some((child) => child.type === "default");
    const declaration = field(node, "declaration");
    if (declaration !== null) {
      const names =
        declaration.type === "ambient_declaration"
          ? declaration.namedChildren.flatMap((inner) => collectDeclaration(inner, node, true))
          : collectDeclaration(declaration, node, true);
      for (const name of names) {
        if (isDefault) exports.push({ name: "default", kind: "default", local: name });
        else exports.push({ name, kind: "named" });
      }
      return;
    }

    const value = field(node, "value");
    if (value !== null) {
      collectDefaultValue(node, value);
      return;
    }

    // `export = x`
    if (node.children[1]?.type === "=") {
      const target = node.namedChildren[0];
      exports.push({ name: "default", kind: "default", ...(target === undefined ? {} : { local: target.text }) });
    }
  }

  function collectReexport(node: Node, specifier: string, clause: Node | null, namespaceExport: Node | null): void {
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
          exports.push({ name: "default", kind: "default", local: localName, from: specifier });
        } else {
          exports.push({ name: exportedName, kind: "named", local: localName, from: specifier });
        }
      }
    } else if (namespaceExport !== null) {
      const binding = namespaceExport.namedChildren[0];
      const local = binding === undefined ? "*" : binding.text;
      symbols.push({ name: "*", local });
      // `export * as default from "x"` is a default export like any other.
      const exportKind = local === "default" ? "default" : "named";
      exports.push({ name: local, kind: exportKind, local: "*", from: specifier });
    } else {
      symbols.push({ name: "*", local: "*" });
      exports.push({ name: "*", kind: "star", from: specifier });
    }

    imports.push({ specifier, kind, symbols, reexport: true, line: lineOf(node) });
  }

  /** `export default <value>`: anonymous functions and classes become a `default` symbol. */
  function collectDefaultValue(node: Node, value: Node): void {
    if (value.type === "class" || value.type === "function_expression" || value.type === "generator_function") {
      const written = nameOf(value);
      const name = written ?? "default";
      const isClass = value.type === "class";
      addEntry(name, isClass ? "class" : "function", signatureText(value, node), spanOf(node), true);
      if (isClass) collectMethods(value, name, true);
      exports.push({ name: "default", kind: "default", ...(written === null ? {} : { local: written }) });
      return;
    }
    if (value.type === "identifier") {
      exports.push({ name: "default", kind: "default", local: value.text });
      return;
    }
    exports.push({ name: "default", kind: "default" });
  }

  /** `module.exports = …`, `module.exports.foo = …`, `exports.foo = …` (v1 CommonJS, best effort). */
  function collectCommonJsExport(assignment: Node): void {
    const left = field(assignment, "left");
    if (left === null || left.type !== "member_expression") return;
    const object = field(left, "object");
    const property = field(left, "property");
    if (object === null || property === null) return;

    if (object.type === "identifier" && object.text === "module" && property.text === "exports") {
      const right = field(assignment, "right");
      const local = right !== null && right.type === "identifier" ? { local: right.text } : {};
      exports.push({ name: "default", kind: "default", ...local });
      return;
    }
    if (object.type === "identifier" && object.text === "exports") {
      exports.push({ name: property.text, kind: "named" });
      return;
    }
    if (object.type === "member_expression") {
      const inner = field(object, "object");
      const innerProperty = field(object, "property");
      if (inner?.type === "identifier" && inner.text === "module" && innerProperty?.text === "exports") {
        exports.push({ name: property.text, kind: "named" });
      }
    }
  }

  // ------------------------------------------- pass B: calls and call imports

  const tracked = new Set<string>();

  /**
   * Pre-order walk with an explicit stack: generated and minified sources nest deeply
   * enough to blow a recursive walk's call stack, and the map must never crash on a file.
   */
  function walk(root: Node, ctx: Ctx): void {
    const stack: Array<{ node: Node; ctx: Ctx }> = [{ node: root, ctx }];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      const node = current.node;
      if (node.type === "call_expression" || node.type === "new_expression") recordCall(node, current.ctx);
      const inner = descend(node, current.ctx);
      const children = node.namedChildren;
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child = children[i];
        if (child !== undefined) stack.push({ node: child, ctx: inner });
      }
    }
  }

  /** The context children see: only constructs that produced a tracked declaration push. */
  function descend(node: Node, ctx: Ctx): Ctx {
    switch (node.type) {
      case "class_declaration":
      case "abstract_class_declaration": {
        const name = nameOf(node);
        return name !== null && tracked.has(name) ? { caller: ctx.caller, className: name } : ctx;
      }
      case "method_definition": {
        const name = field(node, "name");
        if (name === null || ctx.className === "") return ctx;
        const symbolPath = `${ctx.className}.${name.text}`;
        return tracked.has(symbolPath) ? { caller: symbolPath, className: ctx.className } : ctx;
      }
      case "public_field_definition":
        return ctx.className !== "" && tracked.has(ctx.className)
          ? { caller: ctx.className, className: ctx.className }
          : ctx;
      case "function_declaration":
      case "generator_function_declaration": {
        const name = nameOf(node);
        return name !== null && tracked.has(name) ? { caller: name, className: "" } : ctx;
      }
      case "variable_declarator": {
        const name = field(node, "name");
        const value = field(node, "value");
        if (name === null || name.type !== "identifier" || value === null || !FUNCTION_VALUES.has(value.type)) return ctx;
        return tracked.has(name.text) ? { caller: name.text, className: "" } : ctx;
      }
      default:
        return ctx;
    }
  }

  function recordCall(node: Node, ctx: Ctx): void {
    if (node.type === "new_expression") {
      const target = field(node, "constructor");
      if (target === null) return;
      const callee = calleeText(target, "new ");
      if (callee !== null) calls.push({ caller: ctx.caller, callee, line: lineOf(node) });
      return;
    }
    const fn = field(node, "function");
    if (fn === null) return;
    if (fn.type === "import") {
      recordModuleCall(node, "dynamic");
      return;
    }
    if (fn.type === "identifier" && fn.text === "require") {
      recordModuleCall(node, "require");
      return;
    }
    const callee = calleeText(fn, "");
    if (callee !== null) calls.push({ caller: ctx.caller, callee, line: lineOf(node) });
  }

  function calleeText(target: Node, prefix: string): string | null {
    if (target.type === "identifier") return `${prefix}${target.text}`;
    if (target.type !== "member_expression") return null;
    const object = field(target, "object");
    const property = field(target, "property");
    if (object === null || property === null || property.type !== "property_identifier") return null;
    // Optional chains (`a?.b()`) read like plain members; anything deeper is dropped.
    if (object.type === "identifier") return `${prefix}${object.text}.${property.text}`;
    if (object.type === "this") return `${prefix}this.${property.text}`;
    return null;
  }

  /** `import("x")` and `require("x")` become import records, never call sites. */
  function recordModuleCall(call: Node, form: "dynamic" | "require"): void {
    const args = field(call, "arguments");
    if (args === null) return;
    const literal = args.namedChildren[0];
    if (literal === undefined || literal.type !== "string") return;
    const specifier = stringOf(literal);

    // A bare `require("x");` statement binds nothing: it is a side effect.
    if (form === "require" && call.parent?.type === "expression_statement") {
      imports.push({ specifier, kind: "side-effect", symbols: [], reexport: false, line: lineOf(call) });
      return;
    }

    imports.push({
      specifier,
      kind: form === "dynamic" ? "dynamic" : "static",
      symbols: bindingSymbols(call),
      reexport: false,
      line: lineOf(call),
    });
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

  // ------------------------------------------------------------------ run

  for (const child of tree.rootNode.namedChildren) collectTop(child);
  for (const entry of entries) tracked.add(entry.decl.name);
  walk(tree.rootNode, EMPTY_CTX);

  imports.sort((a, b) => a.line - b.line);
  return { decls: collapseOverloads(entries), imports, exports, calls };
}

/**
 * One declaration per symbol id: an implementation wins over its overload
 * signatures, and otherwise the first declaration in the file wins (accessor
 * pairs, declaration merging). `exported` is true when any of them is exported.
 */
function collapseOverloads(entries: Entry[]): Declaration[] {
  const chosen = new Map<string, Entry>();
  const order: string[] = [];
  for (const entry of entries) {
    const previous = chosen.get(entry.decl.id);
    if (previous === undefined) {
      chosen.set(entry.decl.id, entry);
      order.push(entry.decl.id);
      continue;
    }
    const winner = previous.overload && !entry.overload ? entry : previous;
    const exported = previous.decl.exported || entry.decl.exported;
    chosen.set(entry.decl.id, { decl: { ...winner.decl, exported }, overload: winner.overload });
  }
  const decls: Declaration[] = [];
  for (const id of order) {
    const entry = chosen.get(id);
    if (entry !== undefined) decls.push(entry.decl);
  }
  return decls;
}
