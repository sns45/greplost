/**
 * Go extraction (tech spec 5.1 language table, go sub-project spec).
 *
 * One pass over the `source_file` children for declarations, imports and
 * exports, and one walk of the whole tree for call sites, with the caller
 * attributed to the nearest enclosing `function_declaration` /
 * `method_declaration` (a `func_literal` belongs to the declaration that
 * contains it, exactly as an arrow function does in TypeScript).
 *
 * Go says "exported" with an upper-case first rune and nothing else, so there is
 * no `export` keyword to look for: `exports` mirrors the exported top-level
 * declarations, methods excluded (a method belongs to its type, not to the
 * package).
 *
 * Nothing here resolves anything: an import specifier is the import path as
 * written and a call site is the callee text. `resolve/go.ts` turns those into
 * package-directory targets and call edges.
 *
 * The text helpers come from `ts-signature.ts`: they are pure functions of a
 * node and the source, with nothing TypeScript-specific in them.
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
import { clip, field, lineOf, spanOf } from "./ts-signature.ts";

/** Node types whose children carry the specs of a parenthesised declaration group. */
const SPEC_PARENTS: ReadonlySet<string> = new Set([
  "const_spec_list",
  "import_spec_list",
  "type_spec_list",
  "var_spec_list",
]);

/** Declarations that own the calls written inside them. */
const CALLER_NODES: ReadonlySet<string> = new Set(["function_declaration", "method_declaration"]);

/**
 * Go's export rule: the first rune of the name is an upper-case letter. `_`,
 * digits and lower-case letters (in any script) are unexported.
 */
export function isExportedName(name: string): boolean {
  const first = [...name][0];
  if (first === undefined) return false;
  return first !== first.toLowerCase() && first === first.toUpperCase();
}

/** Import path text without its quotes (interpreted or raw string literal). */
function importPath(node: Node | null): string {
  if (node === null) return "";
  const text = node.text;
  const quote = text[0];
  if (text.length >= 2 && (quote === '"' || quote === "`") && text.endsWith(quote)) return text.slice(1, -1);
  return text;
}

/** The declared name behind a receiver type: `*Store`, `Store[T]` and `*Store[T]` all give `Store`. */
function baseTypeName(node: Node | null): string | null {
  let current = node;
  while (current !== null) {
    if (current.type === "type_identifier") return current.text;
    if (current.type === "pointer_type" || current.type === "generic_type" || current.type === "parenthesized_type") {
      current = current.namedChild(0);
      continue;
    }
    return null;
  }
  return null;
}

/** The specs of a declaration, whether written singly or in a parenthesised group. */
function specsOf(node: Node, type: string, alsoType?: string): Node[] {
  const specs: Node[] = [];
  const visit = (parent: Node): void => {
    for (const child of parent.namedChildren) {
      if (child.type === type || (alsoType !== undefined && child.type === alsoType)) specs.push(child);
      else if (SPEC_PARENTS.has(child.type)) visit(child);
    }
  };
  visit(node);
  return specs;
}

/** Where a struct or interface body starts, so a type signature can stop there. */
function typeBodyStart(typeNode: Node | null): number | null {
  if (typeNode === null) return null;
  if (typeNode.type !== "struct_type" && typeNode.type !== "interface_type") return null;
  for (const child of typeNode.children) {
    if (child.type === "{" || child.type === "field_declaration_list") return child.startIndex;
  }
  return null;
}

/** `struct` / `interface` / `type`, per the go spec's declaration table. */
function typeKind(typeNode: Node | null): DeclKind {
  if (typeNode === null) return "type";
  if (typeNode.type === "struct_type") return "struct";
  if (typeNode.type === "interface_type") return "interface";
  return "type";
}

/** Header text of a node with a `body` field, cut before the body. */
function signatureBeforeBody(source: string, node: Node): string {
  const body = field(node, "body");
  const end = body === null ? node.endIndex : body.startIndex;
  return clip(source.slice(node.startIndex, Math.max(end, node.startIndex)));
}

/**
 * Where a `const`/`var` spec's signature stops. A binding initialised with a
 * function literal is cut before that function's body - `var Handler = func()` -
 * exactly as a TypeScript `const f = () =>` is: the body is code, not shape.
 */
function specEnd(spec: Node): number {
  const value = field(spec, "value");
  if (value === null || value.namedChildCount !== 1) return spec.endIndex;
  const only = value.namedChild(0);
  if (only === null || only.type !== "func_literal") return spec.endIndex;
  const body = field(only, "body");
  return body === null ? spec.endIndex : body.startIndex;
}

interface GoState {
  readonly path: string;
  readonly source: string;
  readonly decls: Declaration[];
  readonly imports: ImportRecord[];
  readonly exports: ExportRecord[];
  readonly calls: CallSite[];
  /**
   * `func` node id -> symbol path, so caller attribution is by node identity.
   * A local variable that shadows a declared name can never hijack it.
   */
  readonly callerByNode: Map<number, string>;
}

function addDeclaration(
  state: GoState,
  name: string,
  kind: DeclKind,
  signature: string,
  node: Node,
  parent?: string,
): void {
  const exported = isExportedName(parent === undefined ? name : name.slice(parent.length + 1));
  state.decls.push({
    id: symbolId(state.path, name),
    file: state.path,
    name,
    kind,
    signature,
    exported,
    span: spanOf(node),
    ...(parent === undefined ? {} : { parent }),
  });
  // A package-level exported declaration is the whole of Go's export surface.
  if (exported && parent === undefined) state.exports.push({ name, kind: "named" });
}

function collectImports(state: GoState, node: Node): void {
  for (const spec of specsOf(node, "import_spec")) {
    const path = importPath(field(spec, "path"));
    if (path === "") continue;
    const alias = field(spec, "name");
    const line = lineOf(spec);
    if (alias !== null && alias.type === "blank_identifier") {
      // `import _ "x"`: loaded for its side effects, binding no name.
      state.imports.push({ specifier: path, kind: "side-effect", symbols: [], reexport: false, line });
      continue;
    }
    const segments = path.split("/");
    const local = alias === null ? (segments[segments.length - 1] ?? path) : alias.text;
    state.imports.push({ specifier: path, kind: "static", symbols: [{ name: "*", local }], reexport: false, line });
  }
}

function collectConstOrVar(state: GoState, node: Node, kind: "const" | "var"): void {
  for (const spec of specsOf(node, kind === "const" ? "const_spec" : "var_spec")) {
    const signature = clip(`${kind} ${state.source.slice(spec.startIndex, Math.max(specEnd(spec), spec.startIndex))}`);
    for (const nameNode of spec.childrenForFieldName("name")) {
      addDeclaration(state, nameNode.text, kind, signature, spec);
    }
  }
}

function collectTypes(state: GoState, node: Node): void {
  for (const spec of specsOf(node, "type_spec", "type_alias")) {
    const nameNode = field(spec, "name");
    if (nameNode === null) continue;
    const typeNode = field(spec, "type");
    const end = typeBodyStart(typeNode) ?? spec.endIndex;
    const signature = clip(`type ${state.source.slice(spec.startIndex, Math.max(end, spec.startIndex))}`);
    addDeclaration(state, nameNode.text, typeKind(typeNode), signature, spec);
  }
}

function collectFunction(state: GoState, node: Node): void {
  const nameNode = field(node, "name");
  if (nameNode === null) return;
  addDeclaration(state, nameNode.text, "function", signatureBeforeBody(state.source, node), node);
  state.callerByNode.set(node.id, nameNode.text);
}

function collectMethod(state: GoState, node: Node): void {
  const nameNode = field(node, "name");
  if (nameNode === null) return;
  const receiver = field(node, "receiver");
  const parameter = receiver === null ? null : receiver.namedChild(0);
  const type = baseTypeName(parameter === null ? null : field(parameter, "type"));
  if (type === null) return;
  const name = `${type}.${nameNode.text}`;
  addDeclaration(state, name, "method", signatureBeforeBody(state.source, node), node, type);
  state.callerByNode.set(node.id, name);
}

/**
 * Callee text, normalised the way `CallSite.callee` fixes it:
 * `f()` -> `f`, `pkg.F()` / `recv.m()` -> `pkg.F` / `recv.m`. Anything else -
 * a deeper chain, a call on a call, a generic instantiation, a call on a
 * parenthesised or literal value - is not recorded. Composite literals
 * (`Store{...}`) are not call expressions in Go and never reach here.
 */
function calleeText(node: Node): string | null {
  const fn = field(node, "function");
  if (fn === null) return null;
  if (fn.type === "identifier") return fn.text;
  if (fn.type !== "selector_expression") return null;
  const operand = field(fn, "operand");
  const member = field(fn, "field");
  if (operand === null || member === null || operand.type !== "identifier") return null;
  return `${operand.text}.${member.text}`;
}

function collectCalls(state: GoState, root: Node): void {
  const walk = (node: Node, caller: string): void => {
    const next = CALLER_NODES.has(node.type) ? (state.callerByNode.get(node.id) ?? caller) : caller;
    if (node.type === "call_expression") {
      const callee = calleeText(node);
      if (callee !== null) state.calls.push({ caller: next, callee, line: lineOf(node) });
    }
    for (const child of node.namedChildren) walk(child, next);
  };
  walk(root, "");
}

/**
 * Everything one `.go` file says about itself. `lang` is always `"go"`; it is
 * part of the signature so this module mirrors `extractTs`.
 */
export function extractGo(
  path: string,
  _lang: Lang,
  source: string,
  tree: Tree,
): Pick<FileRecord, "decls" | "imports" | "exports" | "calls"> {
  const state: GoState = {
    path,
    source,
    decls: [],
    imports: [],
    exports: [],
    calls: [],
    callerByNode: new Map<number, string>(),
  };

  for (const node of tree.rootNode.namedChildren) {
    switch (node.type) {
      case "import_declaration":
        collectImports(state, node);
        break;
      case "const_declaration":
        collectConstOrVar(state, node, "const");
        break;
      case "var_declaration":
        collectConstOrVar(state, node, "var");
        break;
      case "type_declaration":
        collectTypes(state, node);
        break;
      case "function_declaration":
        collectFunction(state, node);
        break;
      case "method_declaration":
        collectMethod(state, node);
        break;
      default:
        break;
    }
  }

  collectCalls(state, tree.rootNode);

  return { decls: state.decls, imports: state.imports, exports: state.exports, calls: state.calls };
}
