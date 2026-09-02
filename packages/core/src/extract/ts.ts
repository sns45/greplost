/**
 * TypeScript / TSX / JavaScript / JSX extraction (tech spec 5.1).
 *
 * Two passes over one tree:
 *  A. the program's own children -> declarations, static imports, exports.
 *     Tracked declarations are the top level, class members, and namespace members
 *     at any depth; nothing inside a function body becomes a symbol.
 *  B. the whole tree -> call sites, dynamic `import()` and `require()` records,
 *     with the caller attributed to the nearest enclosing tracked declaration.
 *
 * Pass A registers each declaration's *node* (by `node.id`), not its name, so a
 * local binding that shadows a top-level name cannot hijack caller attribution.
 *
 * Nothing here is inferred: a construct either matches a rule or is dropped.
 * Import and export records live in `ts-imports.ts`, call sites in `ts-calls.ts`,
 * and signature text in `ts-signature.ts`.
 */

import type { Node, Tree } from "web-tree-sitter";
import type {
  CallSite,
  DeclKind,
  Declaration,
  ExportRecord,
  FileRecord,
  ImportRecord,
  Lang,
} from "../schema.ts";
import { symbolId } from "../schema.ts";
import { collectCommonJsExport, collectExportStatement, collectImportStatement } from "./ts-imports.ts";
import { recordCall } from "./ts-calls.ts";
import {
  FUNCTION_VALUES,
  field,
  initialiserSignature,
  nameOf,
  signatureText,
  spanOf,
  variableSignature,
} from "./ts-signature.ts";

/**
 * What the import/export module needs from the extraction in progress. Declaring
 * is a callback rather than an import so the two modules stay acyclic at runtime.
 */
export interface TsContext {
  /** Repo-relative path of the file being extracted. */
  readonly path: string;
  readonly source: string;
  readonly imports: ImportRecord[];
  readonly exports: ExportRecord[];
  readonly calls: CallSite[];
  /** Declare `node` (wrapped by `outer`); returns the names it declared. */
  declare(node: Node, outer: Node, exported: boolean): string[];
  /** Declare an `export default` function/class value; returns its written name, or null. */
  declareDefault(value: Node, outer: Node): string | null;
}

/** A declaration plus the bookkeeping needed to collapse overload signatures. */
interface Entry {
  decl: Declaration;
  /** True for a bodiless signature (an overload, an ambient or an abstract member). */
  overload: boolean;
}

/** Enclosing declaration context while walking for call sites. */
interface Ctx {
  /** Symbol path of the nearest enclosing tracked declaration, "" at top level. */
  caller: string;
  /** Symbol path of the enclosing tracked class, "" outside one. */
  className: string;
}

const EMPTY_CTX: Ctx = { caller: "", className: "" };

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
  /** Scope node id -> symbol path of the declaration it defines. */
  const trackedById = new Map<number, string>();

  const ctx: TsContext = {
    path,
    source,
    imports,
    exports,
    calls,
    declare: (node, outer, exported) => collectDeclaration(node, outer, exported, ""),
    declareDefault,
  };

  // ------------------------------------------------------------ declaring

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

  /** Remember that calls inside `node` belong to `symbolPath`. */
  function register(node: Node, symbolPath: string): void {
    trackedById.set(node.id, symbolPath);
  }

  /** `""` -> undefined, `"N."` -> `"N"`, `"A.B."` -> `"A.B"`. */
  function parentOf(prefix: string): string | undefined {
    return prefix === "" ? undefined : prefix.slice(0, -1);
  }

  // ------------------------------------------------------- pass A: top level

  function collectTop(node: Node): void {
    switch (node.type) {
      case "import_statement":
        collectImportStatement(ctx, node);
        return;
      case "export_statement":
        collectExportStatement(ctx, node);
        return;
      case "ambient_declaration":
        for (const inner of node.namedChildren) collectDeclaration(inner, node, false, "");
        return;
      case "expression_statement": {
        const inner = node.namedChildren.find((child) => child.type !== "comment");
        if (inner === undefined) return;
        // `namespace X {}` at the top level is wrapped in an expression statement.
        if (inner.type === "internal_module") collectDeclaration(inner, node, false, "");
        else if (inner.type === "assignment_expression") collectCommonJsExport(ctx, inner);
        return;
      }
      default:
        collectDeclaration(node, node, false, "");
    }
  }

  /**
   * Adds the declarations of `node` and returns the names it declared. `prefix` is
   * the enclosing namespace path with a trailing dot ("" at the top level); the
   * returned names are always bare, since they name the binding in its own scope.
   */
  function collectDeclaration(node: Node, outer: Node, exported: boolean, prefix: string): string[] {
    const parent = parentOf(prefix);
    switch (node.type) {
      case "function_declaration":
      case "generator_function_declaration":
      case "function_signature": {
        const name = nameOf(node);
        if (name === null) return [];
        const overload = node.type === "function_signature";
        addEntry(
          prefix + name,
          "function",
          signatureText(source, node, outer),
          spanOf(outer),
          exported,
          parent,
          overload,
        );
        if (!overload) register(node, prefix + name);
        return [name];
      }
      case "class_declaration":
      case "abstract_class_declaration": {
        const name = nameOf(node);
        if (name === null) return [];
        const symbolPath = prefix + name;
        addEntry(symbolPath, "class", signatureText(source, node, outer), spanOf(outer), exported, parent);
        register(node, symbolPath);
        collectMembers(node, symbolPath, exported);
        return [name];
      }
      case "interface_declaration":
        return simpleDeclaration(node, outer, exported, "interface", prefix);
      case "type_alias_declaration":
        return simpleDeclaration(node, outer, exported, "type", prefix);
      case "enum_declaration":
        return simpleDeclaration(node, outer, exported, "enum", prefix);
      case "internal_module": {
        const name = nameOf(node);
        if (name === null) return [];
        const symbolPath = prefix + name;
        addEntry(symbolPath, "namespace", signatureText(source, node, outer), spanOf(outer), exported, parent);
        // Members are tracked at any depth; a call in the namespace body itself is
        // top-level code and keeps the enclosing caller.
        collectNamespaceMembers(node, symbolPath, exported);
        return [name];
      }
      case "lexical_declaration":
      case "variable_declaration": {
        const kind = variableKind(node);
        const names: string[] = [];
        for (const declarator of node.children) {
          if (declarator.type !== "variable_declarator") continue;
          const name = field(declarator, "name");
          // Destructuring patterns bind names the map cannot attribute; they are skipped.
          if (name === null || name.type !== "identifier") continue;
          addEntry(
            prefix + name.text,
            kind,
            variableSignature(source, outer, node, declarator),
            spanOf(outer),
            exported,
            parent,
          );
          const value = field(declarator, "value");
          if (value !== null && FUNCTION_VALUES.has(value.type)) register(declarator, prefix + name.text);
          names.push(name.text);
        }
        return names;
      }
      default:
        return [];
    }
  }

  function simpleDeclaration(node: Node, outer: Node, exported: boolean, kind: DeclKind, prefix: string): string[] {
    const name = nameOf(node);
    if (name === null) return [];
    addEntry(prefix + name, kind, signatureText(source, node, outer), spanOf(outer), exported, parentOf(prefix));
    return [name];
  }

  function variableKind(node: Node): DeclKind {
    const keyword = node.children[0]?.text ?? "";
    if (keyword === "let") return "let";
    if (keyword === "var") return "var";
    return "const";
  }

  /** `export default class {}` / `function () {}`: an anonymous value declared as `default`. */
  function declareDefault(value: Node, outer: Node): string | null {
    const written = nameOf(value);
    const name = written ?? "default";
    const isClass = value.type === "class";
    addEntry(name, isClass ? "class" : "function", signatureText(source, value, outer), spanOf(outer), true);
    register(value, name);
    if (isClass) collectMembers(value, name, true);
    return written;
  }

  // --------------------------------------------------------- class members

  /**
   * Class members that are addressable as `Class.member`: methods, accessors,
   * overload and abstract signatures, and fields holding a function. Plain data
   * fields are not declarations; computed and literal names have no symbol path.
   */
  function collectMembers(classNode: Node, classPath: string, exported: boolean): void {
    const body = field(classNode, "body");
    if (body === null) return;
    for (const member of body.namedChildren) {
      const name = field(member, "name");
      if (name === null) continue;
      if (name.type !== "property_identifier" && name.type !== "private_property_identifier") continue;
      const symbolPath = `${classPath}.${name.text}`;
      switch (member.type) {
        case "method_definition":
          addEntry(symbolPath, "method", signatureText(source, member, member), spanOf(member), exported, classPath);
          register(member, symbolPath);
          break;
        case "method_signature":
        case "abstract_method_signature":
          addEntry(
            symbolPath,
            "method",
            signatureText(source, member, member),
            spanOf(member),
            exported,
            classPath,
            true,
          );
          break;
        case "public_field_definition": {
          const value = field(member, "value");
          if (value === null || !FUNCTION_VALUES.has(value.type)) break;
          addEntry(
            symbolPath,
            "method",
            initialiserSignature(source, member, ""),
            spanOf(member),
            exported,
            classPath,
          );
          register(member, symbolPath);
          break;
        }
        default:
          break;
      }
    }
  }

  // ------------------------------------------------------ namespace members

  /**
   * A member declared directly in a namespace body, at any depth. It is exported
   * only when it carries `export` inside the namespace *and* every enclosing
   * namespace is exported, so `exported` really means "reachable from outside".
   */
  function collectNamespaceMembers(namespaceNode: Node, namespacePath: string, namespaceExported: boolean): void {
    const body = field(namespaceNode, "body");
    if (body === null) return;
    const prefix = `${namespacePath}.`;
    for (const member of body.namedChildren) {
      switch (member.type) {
        case "export_statement": {
          const declaration = field(member, "declaration");
          if (declaration === null) break;
          const inner =
            declaration.type === "ambient_declaration" ? declaration.namedChildren : [declaration];
          for (const node of inner) collectDeclaration(node, member, namespaceExported, prefix);
          break;
        }
        case "ambient_declaration":
          for (const node of member.namedChildren) collectDeclaration(node, member, false, prefix);
          break;
        case "expression_statement": {
          const inner = member.namedChildren.find((child) => child.type !== "comment");
          if (inner?.type === "internal_module") collectDeclaration(inner, member, false, prefix);
          break;
        }
        default:
          collectDeclaration(member, member, false, prefix);
      }
    }
  }

  // ------------------------------------------- pass B: calls and call imports

  /**
   * Pre-order walk with an explicit stack: generated and minified sources nest deeply
   * enough to blow a recursive walk's call stack, and the map must never crash on a file.
   */
  function walk(root: Node): void {
    const stack: Array<{ node: Node; ctx: Ctx }> = [{ node: root, ctx: EMPTY_CTX }];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      const node = current.node;
      if (node.type === "call_expression" || node.type === "new_expression") {
        recordCall(ctx, node, current.ctx.caller);
      }
      const inner = descend(node, current.ctx);
      const children = node.namedChildren;
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child = children[i];
        if (child !== undefined) stack.push({ node: child, ctx: inner });
      }
    }
  }

  /**
   * The context children see. Only a node registered in pass A pushes a caller, so a
   * nested helper keeps its enclosing declaration instead of inventing a symbol —
   * `function f() { const helper = () => g(); }` attributes `g` to `f`, whether or
   * not a top-level `helper` also exists.
   */
  function descend(node: Node, ctx_: Ctx): Ctx {
    const symbolPath = trackedById.get(node.id);
    switch (node.type) {
      case "class_declaration":
      case "abstract_class_declaration":
      case "class":
        return { caller: ctx_.caller, className: symbolPath ?? "" };
      case "function_declaration":
      case "generator_function_declaration":
      case "method_definition":
      case "variable_declarator":
        return symbolPath === undefined ? ctx_ : { caller: symbolPath, className: "" };
      case "public_field_definition":
        // A field holding a function is its own symbol; a data field's initialiser
        // runs as part of constructing the class.
        if (symbolPath !== undefined) return { caller: symbolPath, className: "" };
        return ctx_.className === "" ? ctx_ : { caller: ctx_.className, className: ctx_.className };
      case "class_static_block":
        return ctx_.className === "" ? ctx_ : { caller: ctx_.className, className: ctx_.className };
      default:
        return ctx_;
    }
  }

  // ------------------------------------------------------------------ run

  for (const child of tree.rootNode.namedChildren) collectTop(child);
  walk(tree.rootNode);

  // Static imports are collected in document order by pass A and dynamic ones by
  // pass B, so the two streams interleave only after sorting. Line order is the
  // order a reader sees, and it is stable: same-line records keep pass order.
  imports.sort((a, b) => a.line - b.line);
  return { decls: collapseOverloads(entries), imports, exports, calls };
}

/**
 * One declaration per symbol id: an implementation wins over its overload and
 * abstract signatures, and otherwise the first declaration in the file wins
 * (accessor pairs, declaration merging). `exported` is true when any is exported.
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
