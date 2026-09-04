/**
 * Python extraction (build 2, leaf 2.1; spec 2026-09-04 section 1.2).
 *
 * One walk of the module for declarations, imports, exports and `__all__`, and one walk of
 * the whole tree for call sites. Nothing here resolves anything: an import specifier is the
 * dotted path as written (relative dots preserved) and a call site is the callee text.
 * `resolve/python.ts` turns those into file targets and call edges.
 *
 * Three rules decide most of what this file does.
 *
 *  1. **`__all__` is the export surface when a module declares one.** It overrides the
 *     leading-underscore convention in *both* directions: a `_private` name listed in
 *     `__all__` is exported, and a public name left out of it is not. Only a literal
 *     sequence of string literals counts (`list`, `tuple`, or a bare `a, b` expression
 *     list, plus `+=` on any of those); anything computed leaves the module on the
 *     underscore rule, because guessing at a computed `__all__` would publish names the
 *     module does not.
 *
 *  2. **`self.method()` is written out as `this.method`.** The schema fixes `this.` as the
 *     spelling for a call on the enclosing instance (`CallSite.callee`), so normalising
 *     here lets Python share `graph/link.ts`'s resolver with TypeScript instead of needing
 *     a Python branch in it.
 *
 *  3. **A callee whose leading name is bound inside the enclosing function is withheld.**
 *     Python resolves a local `helper = ...; helper()` to the local, never to a
 *     module-level `def helper`, so recording it and hoping the linker drops it is how a
 *     wrong `high` edge gets out. Over-dropping costs S3 recall (reported); under-dropping
 *     costs S3 precision (gated). `global`/`nonlocal` names are *not* local, so a call
 *     through one is still recorded.
 *
 * Python has no `new`: a constructor call is a plain `name` call and the linker resolves it
 * to the class declaration, which is why `class` stays a callable target there.
 *
 * The text helpers come from `ts-signature.ts`: pure functions of a node and the source,
 * with nothing TypeScript-specific in them.
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
import { compareStrings, symbolId } from "../schema.ts";
import { clip, field, lineOf, spanOf } from "./ts-signature.ts";

/** A module-level assignment target in this shape is a `const`, anything else a `var`. */
const SCREAMING_SNAKE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Compound statements whose bodies are still module (or class) scope in Python.
 *
 * `if TYPE_CHECKING:`, `try: import x except ImportError:` and
 * `if sys.version_info >= (3, 12):` all define module-level names, so the declaration walk
 * descends through them. A `def` inside a `def` does *not* define a module-level name and
 * is deliberately not descended into.
 */
const BLOCK_STATEMENTS: ReadonlySet<string> = new Set([
  "for_statement",
  "if_statement",
  "match_statement",
  "try_statement",
  "while_statement",
  "with_statement",
]);

/** Nodes that open a Python function scope: their bindings shadow the module. */
const FUNCTION_SCOPES: ReadonlySet<string> = new Set(["function_definition", "lambda"]);

/** The name `TYPE_CHECKING` guards imports that only ever exist for a type checker. */
const TYPE_CHECKING = "TYPE_CHECKING";

/** `importlib.import_module("x")` is the one dynamic-import spelling Python has. */
const IMPORT_MODULE = "import_module";

/** The name that states a module's export surface. */
const ALL = "__all__";

interface PyState {
  readonly path: string;
  readonly source: string;
  readonly decls: Declaration[];
  readonly imports: ImportRecord[];
  readonly exports: ExportRecord[];
  readonly calls: CallSite[];
  /** Names listed in a literal `__all__`, or null when the module declares no usable one. */
  readonly exportedNames: ReadonlySet<string> | null;
  /** Local name -> the specifier it was imported from, for `__all__` re-export records. */
  readonly importedFrom: Map<string, string>;
  /** Symbol path of the declaration that owns the calls written inside it, by node id. */
  readonly ownerByNode: Map<number, string>;
  /** Top-level names this module declares, so an `__all__` entry can tell one from an import. */
  readonly declaredNames: Set<string>;
}

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

/**
 * Text of a Python string literal without quotes or prefix; null when it is not one.
 *
 * Implicit concatenation (`"a" "b"`) is one literal to the interpreter, so it is one here
 * too: a name written that way inside `__all__` must not turn the whole list unreadable.
 */
function literalString(node: Node | null): string | null {
  if (node === null) return null;
  if (node.type === "concatenated_string") {
    const parts: string[] = [];
    for (const child of node.namedChildren) {
      if (child.type === "comment") continue;
      const value = literalString(child);
      if (value === null) return null;
      parts.push(value);
    }
    return parts.join("");
  }
  if (node.type !== "string") return null;
  const parts: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === "string_content") parts.push(child.text);
    else if (child.type === "interpolation") return null; // an f-string is not a literal
  }
  return parts.join("");
}

/** The string literals of a `list`, `tuple` or bare expression list; null when it is not one. */
function literalStringSequence(node: Node | null): string[] | null {
  if (node === null) return null;
  if (node.type !== "list" && node.type !== "tuple" && node.type !== "expression_list") return null;
  const out: string[] = [];
  for (const child of node.namedChildren) {
    // tree-sitter keeps comments as named children, and a real `__all__` is nearly always
    // written one name per line with comments between them.
    if (child.type === "comment") continue;
    const value = literalString(child);
    if (value === null) return null;
    out.push(value);
  }
  return out;
}

/** A dotted path node (`a.b.c`) or a plain identifier, as written. */
function dottedText(node: Node | null): string {
  return node === null ? "" : node.text;
}

/** The declaration header, whitespace collapsed, without the trailing `:` or the body. */
function headerOf(source: string, node: Node): string {
  const body = field(node, "body");
  const end = body === null ? node.endIndex : body.startIndex;
  return clip(source.slice(node.startIndex, Math.max(end, node.startIndex))).replace(/:$/u, "").trim();
}

/**
 * The dotted name a decorator applies: `@app.route("/x")` -> `app.route`, `@final` -> `final`.
 * A decorator that is not a name or a call on one contributes its own text.
 */
function decoratorName(decorator: Node): string {
  const inner = decorator.namedChild(0);
  if (inner === null) return clip(decorator.text.replace(/^@/u, ""));
  const target = inner.type === "call" ? (field(inner, "function") ?? inner) : inner;
  return clip(target.text);
}

// ---------------------------------------------------------------------------
// declarations
// ---------------------------------------------------------------------------

/**
 * Whether a name is part of the module's export surface.
 *
 * `__all__` decides for module-level names when the module declares a literal one, in both
 * directions. It never decides for a member: `__all__` lists module attributes, so a method
 * called `put` is not "unexported" because the module's `__all__` happens not to mention it.
 */
function isExportedName(state: PyState, simpleName: string, topLevel: boolean): boolean {
  if (topLevel && state.exportedNames !== null) return state.exportedNames.has(simpleName);
  return !simpleName.startsWith("_");
}

function addDeclaration(
  state: PyState,
  name: string,
  kind: DeclKind,
  signature: string,
  node: Node,
  parent: string | null,
  decorators: readonly string[],
): void {
  const simple = parent === null ? name : name.slice(parent.length + 1);
  const meta = decorators.length === 0 ? undefined : { decorators: [...decorators].sort(compareStrings).join(",") };
  state.decls.push({
    id: symbolId(state.path, name),
    file: state.path,
    name,
    kind,
    signature,
    exported: isExportedName(state, simple, parent === null),
    span: spanOf(node),
    ...(parent === null ? {} : { parent }),
    ...(meta === undefined ? {} : { meta }),
  });
  if (parent === null) state.declaredNames.add(name);
}

/**
 * One `def`. `outer` is the node whose span and signature are used: the `decorated_definition`
 * when there is one, so a card shows the decorator that put the function on a route.
 */
function addFunction(
  state: PyState,
  node: Node,
  outer: Node,
  parent: string | null,
  decorators: readonly string[],
): void {
  const nameNode = field(node, "name");
  if (nameNode === null) return;
  const name = parent === null ? nameNode.text : `${parent}.${nameNode.text}`;
  const header = headerOf(state.source, node);
  // Only the first decorator line joins the signature: a stack of eight decorators would
  // otherwise push the `def` itself past the 200-character clip.
  const signature = decorators.length === 0 ? header : clip(`@${decorators[0] ?? ""} ${header}`);
  addDeclaration(state, name, parent === null ? "function" : "method", signature, outer, parent, decorators);
  state.ownerByNode.set(node.id, name);
}

function addClass(
  state: PyState,
  node: Node,
  outer: Node,
  parent: string | null,
  decorators: readonly string[],
): void {
  const nameNode = field(node, "name");
  if (nameNode === null) return;
  const name = parent === null ? nameNode.text : `${parent}.${nameNode.text}`;
  const header = headerOf(state.source, node);
  const signature = decorators.length === 0 ? header : clip(`@${decorators[0] ?? ""} ${header}`);
  addDeclaration(state, name, "class", signature, outer, parent, decorators);
  state.ownerByNode.set(node.id, name);
  const body = field(node, "body");
  if (body !== null) collectBlock(state, body, name);
}

/** `X = 1` / `X: int = 1` at module level. Tuple and attribute targets are not declarations. */
function addAssignment(state: PyState, statement: Node, parent: string | null): void {
  // A class body's assignments are attributes of the class, not declarations of their own.
  if (parent !== null) return;
  for (const child of statement.namedChildren) {
    if (child.type === "assignment") addAssignmentTarget(state, child);
  }
}

/** One `assignment` node, following the chain of `a = b = 1` to its right. */
function addAssignmentTarget(state: PyState, assignment: Node): void {
  const left = field(assignment, "left");
  const right = field(assignment, "right");
  if (left !== null && left.type === "identifier") {
    const name = left.text;
    // `__all__` is the *statement of* the module's surface, not a symbol of it: it is already
    // consumed into `exported` and `exports`, and `__all__ = [...]` followed by `__all__ +=
    // [...]` would otherwise emit the same symbol id twice.
    if (name !== ALL) {
      const kind: DeclKind = SCREAMING_SNAKE.test(name) ? "const" : "var";
      // The annotation is shape and belongs in the signature; the value is code and does not.
      const type = field(assignment, "type");
      const end = type === null ? left.endIndex : type.endIndex;
      addDeclaration(state, name, kind, clip(state.source.slice(assignment.startIndex, end)), assignment, null, []);
    }
  }
  // `a = b = 1` nests: the grammar makes `b = 1` the right-hand side of `a = …`, and Python
  // binds both names.
  if (right !== null && right.type === "assignment") addAssignmentTarget(state, right);
}

/** The decorators of a `decorated_definition`, in source order. */
function decoratorsOf(node: Node): string[] {
  const out: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === "decorator") out.push(decoratorName(child));
  }
  return out;
}

/**
 * Declarations of one block: the module, a class body, or a compound statement's body at
 * either of those levels.
 */
function collectBlock(state: PyState, block: Node, parent: string | null): void {
  for (const node of block.namedChildren) {
    switch (node.type) {
      case "function_definition":
        addFunction(state, node, node, parent, []);
        break;
      case "class_definition":
        addClass(state, node, node, parent, []);
        break;
      case "decorated_definition": {
        const definition = field(node, "definition");
        if (definition === null) break;
        const decorators = decoratorsOf(node);
        if (definition.type === "function_definition") addFunction(state, definition, node, parent, decorators);
        else if (definition.type === "class_definition") addClass(state, definition, node, parent, decorators);
        break;
      }
      case "expression_statement":
        addAssignment(state, node, parent);
        break;
      default:
        // `if TYPE_CHECKING:` and `try: ... except ImportError:` bodies are still this scope.
        if (isBlockStatement(node)) collectNestedBlocks(state, node, parent);
        break;
    }
  }
}

/**
 * A statement whose bodies stay in the enclosing scope.
 *
 * The `_clause` test covers everything a compound statement hangs its bodies off - `else`,
 * `elif`, `except`, `finally`, `case` - without the module having to keep a list of clause
 * names in step with the grammar.
 */
function isBlockStatement(node: Node): boolean {
  return BLOCK_STATEMENTS.has(node.type) || node.type.endsWith("_clause");
}

/** Every `block` under a compound statement or one of its clauses, at the same scope. */
function collectNestedBlocks(state: PyState, node: Node, parent: string | null): void {
  for (const child of node.namedChildren) {
    if (child.type === "block") collectBlock(state, child, parent);
    else if (child.type.endsWith("_clause")) collectNestedBlocks(state, child, parent);
  }
}

// ---------------------------------------------------------------------------
// `__all__`
// ---------------------------------------------------------------------------

/**
 * The module's `__all__`, or null when it declares none or declares a computed one.
 *
 * A pre-pass, because `exported` is decided before the declaration walk reaches the
 * assignment: `__all__` is conventionally written at the bottom of a module.
 */
function findExportedNames(root: Node): Set<string> | null {
  /** Every module-level write to `__all__`, in source order. */
  const writes: Array<{ augmented: boolean; listed: string[] | null }> = [];
  const visit = (block: Node): void => {
    for (const node of block.namedChildren) {
      if (isBlockStatement(node)) {
        for (const child of node.namedChildren) {
          if (child.type === "block" || child.type.endsWith("_clause")) visit(child);
        }
        continue;
      }
      if (node.type !== "expression_statement") continue;
      for (const statement of node.namedChildren) {
        const augmented = statement.type === "augmented_assignment";
        if (statement.type !== "assignment" && !augmented) continue;
        if (field(statement, "left")?.text !== ALL) continue;
        writes.push({ augmented, listed: literalStringSequence(field(statement, "right")) });
      }
    }
  };
  visit(root);

  if (writes.length === 0) return null;
  // One unreadable write makes the whole surface unreadable, wherever it is written: a
  // module that computes part of its `__all__` falls back to the underscore rule rather
  // than publishing the half this extractor happens to understand.
  if (writes.some((write) => write.listed === null)) return null;
  const names = new Set<string>();
  for (const write of writes) {
    if (!write.augmented) names.clear();
    for (const name of write.listed ?? []) names.add(name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Everything one `.py` file says about itself. `lang` is always `"python"`; it is part of the
 * signature so this module mirrors `extractTs` and `extractGo`.
 */
export function extractPython(
  filePath: string,
  _lang: Lang,
  source: string,
  tree: Tree,
): Pick<FileRecord, "decls" | "imports" | "exports" | "calls"> {
  const root = tree.rootNode;
  const state: PyState = {
    path: filePath,
    source,
    decls: [],
    imports: [],
    exports: [],
    calls: [],
    exportedNames: findExportedNames(root),
    importedFrom: new Map<string, string>(),
    ownerByNode: new Map<number, string>(),
    declaredNames: new Set<string>(),
  };

  collectImports(state, root, false);
  collectBlock(state, root, null);
  collectExports(state);
  collectCalls(state, root);

  return { decls: state.decls, imports: state.imports, exports: state.exports, calls: state.calls };
}

// ---------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------

/** `from a.b import c` / `from ..a import c`: the module path with relative dots preserved. */
function fromSpecifier(node: Node): string {
  const module = field(node, "module_name");
  if (module === null) return "";
  if (module.type !== "relative_import") return module.text;
  const prefix = module.namedChild(0);
  const dots = prefix !== null && prefix.type === "import_prefix" ? prefix.text : "";
  const rest = module.namedChildren.find((child) => child.type === "dotted_name");
  return rest === undefined ? dots : `${dots}${rest.text}`;
}

/** One imported name of a `from` import: `x`, `x as y`, or `*`. */
function importedSymbol(node: Node): ImportedSymbol | null {
  if (node.type === "wildcard_import") return { name: "*", local: "*" };
  if (node.type === "aliased_import") {
    const name = dottedText(field(node, "name"));
    const alias = field(node, "alias");
    if (name === "" || alias === null) return null;
    return { name, local: alias.text };
  }
  if (node.type !== "dotted_name" && node.type !== "identifier") return null;
  const name = node.text;
  return name === "" ? null : { name, local: name };
}

function addImport(
  state: PyState,
  specifier: string,
  kind: ImportKind,
  symbols: ImportedSymbol[],
  node: Node,
): void {
  if (specifier === "") return;
  state.imports.push({ specifier, kind, symbols, reexport: false, line: lineOf(node) });
  for (const symbol of symbols) {
    if (symbol.local !== "*" && !state.importedFrom.has(symbol.local)) {
      state.importedFrom.set(symbol.local, specifier);
    }
  }
}

/**
 * Every import in the file, wherever it is written.
 *
 * `typeOnly` is inherited: an import inside an `if TYPE_CHECKING:` body exists only for a
 * type checker, so it is `type` however deeply it is nested in that body. An import inside a
 * function body is still `static` — Python has no dynamic-import *syntax* to tell it apart,
 * and the one dynamic form there is (`importlib.import_module("x")`) is handled below.
 */
function collectImports(state: PyState, node: Node, typeOnly: boolean): void {
  switch (node.type) {
    case "future_import_statement": {
      // `from __future__ import annotations` turns every annotation into a string: the
      // whole statement exists for the type checker, so it is recorded as a type import.
      const symbols: ImportedSymbol[] = [];
      for (const child of node.namedChildren) {
        const symbol = importedSymbol(child);
        if (symbol !== null) symbols.push(symbol);
      }
      addImport(state, "__future__", "type", symbols, node);
      return;
    }
    case "import_statement": {
      for (const child of node.namedChildren) {
        if (child.type === "aliased_import") {
          const specifier = dottedText(field(child, "name"));
          const alias = field(child, "alias");
          if (specifier === "" || alias === null) continue;
          addImport(state, specifier, typeOnly ? "type" : "static", [{ name: "*", local: alias.text }], node);
          continue;
        }
        if (child.type !== "dotted_name") continue;
        const specifier = child.text;
        // `import a.b` binds the name `a`, not `a.b`: the first segment is the local.
        const local = specifier.split(".")[0] ?? specifier;
        addImport(state, specifier, typeOnly ? "type" : "static", [{ name: "*", local }], node);
      }
      return;
    }
    case "import_from_statement": {
      const specifier = fromSpecifier(node);
      const symbols: ImportedSymbol[] = [];
      for (const child of node.childrenForFieldName("name")) {
        const symbol = importedSymbol(child);
        if (symbol !== null) symbols.push(symbol);
      }
      // `from x import *` hangs the wildcard outside the `name` field, so it is picked up
      // here; the guard keeps a grammar change that moves it into the field from doubling it.
      for (const child of node.namedChildren) {
        if (child.type === "wildcard_import" && !symbols.some((symbol) => symbol.name === "*")) {
          symbols.push({ name: "*", local: "*" });
        }
      }
      addImport(state, specifier, typeOnly ? "type" : "static", symbols, node);
      return;
    }
    case "call": {
      const specifier = importModuleArgument(node);
      if (specifier !== null) addImport(state, specifier, "dynamic", [], node);
      break;
    }
    default:
      break;
  }

  // Only the *consequence* of `if TYPE_CHECKING:` is type-only: its `else:` and `elif:`
  // branches are the runtime path and keep whatever guard they already inherited.
  if (!typeOnly && isTypeCheckingGuard(node)) {
    for (const child of node.namedChildren) collectImports(state, child, child.type === "block");
    return;
  }
  for (const child of node.namedChildren) collectImports(state, child, typeOnly);
}

/** `if TYPE_CHECKING:` / `if typing.TYPE_CHECKING:`, the two spellings PEP 484 sanctions. */
function isTypeCheckingGuard(node: Node): boolean {
  if (node.type !== "if_statement") return false;
  const condition = field(node, "condition");
  if (condition === null) return false;
  if (condition.type === "identifier") return condition.text === TYPE_CHECKING;
  if (condition.type === "attribute") return field(condition, "attribute")?.text === TYPE_CHECKING;
  return false;
}

/** The literal specifier of `importlib.import_module("x")` / `import_module("x")`, or null. */
function importModuleArgument(node: Node): string | null {
  const fn = field(node, "function");
  if (fn === null) return null;
  const called = fn.type === "attribute" ? (field(fn, "attribute")?.text ?? "") : fn.type === "identifier" ? fn.text : "";
  if (called !== IMPORT_MODULE) return null;
  const args = field(node, "arguments");
  const first = args === null ? null : args.namedChild(0);
  return literalString(first);
}

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------

/**
 * The module's export records: one per exported declaration, plus one per `__all__` entry
 * that names something the module imported rather than declared (a re-export, carrying the
 * originating specifier so the linker can follow it to the declaration).
 */
function collectExports(state: PyState): void {
  const seen = new Set<string>();
  for (const decl of state.decls) {
    if (decl.parent !== undefined || !decl.exported || seen.has(decl.name)) continue;
    seen.add(decl.name);
    state.exports.push({ name: decl.name, kind: "named" });
  }
  if (state.exportedNames !== null) {
    for (const name of state.exportedNames) {
      if (seen.has(name) || state.declaredNames.has(name)) continue;
      const from = state.importedFrom.get(name);
      seen.add(name);
      state.exports.push({ name, kind: "named", ...(from === undefined ? {} : { from, local: name }) });
    }
  }
  state.exports.sort((a, b) => compareStrings(a.name, b.name));
}

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

/**
 * Callee text, normalised the way `CallSite.callee` fixes it: `f()` -> `f`,
 * `pkg.f()` -> `pkg.f`, `self.m()` -> `this.m`. A deeper chain (`a.b.c()`), a call on a call,
 * a subscripted callee and a call on a literal are not recorded.
 */
function calleeText(node: Node): string | null {
  const fn = field(node, "function");
  if (fn === null) return null;
  if (fn.type === "identifier") return fn.text;
  if (fn.type !== "attribute") return null;
  const object = field(fn, "object");
  const member = field(fn, "attribute");
  if (object === null || member === null || object.type !== "identifier") return null;
  return `${object.text === "self" ? "this" : object.text}.${member.text}`;
}

/** Names bound by one parameter list entry. */
function parameterNames(parameters: Node, into: Set<string>): void {
  const visit = (node: Node): void => {
    if (node.type === "identifier") {
      into.add(node.text);
      return;
    }
    // A default value is an expression evaluated in the *enclosing* scope: it binds nothing.
    const target = field(node, "name") ?? node.namedChild(0);
    if (target !== null && node.type !== "default_parameter" && node.type !== "typed_default_parameter") {
      visit(target);
      return;
    }
    if (node.type === "default_parameter" || node.type === "typed_default_parameter") {
      const name = field(node, "name");
      if (name !== null) visit(name);
    }
  };
  for (const child of parameters.namedChildren) visit(child);
}

/** Every identifier bound by an assignment-like target pattern. */
function patternNames(node: Node, into: Set<string>): void {
  if (node.type === "identifier") {
    into.add(node.text);
    return;
  }
  if (node.type === "pattern_list" || node.type === "tuple_pattern" || node.type === "list_pattern") {
    for (const child of node.namedChildren) patternNames(child, into);
    return;
  }
  if (node.type === "list_splat_pattern") {
    const inner = node.namedChild(0);
    if (inner !== null) patternNames(inner, into);
  }
  // An attribute or subscript target (`self.x = 1`, `a[0] = 1`) binds no new name.
}

/**
 * Every name bound anywhere inside one function scope, including nested ones.
 *
 * Block scoping is deliberately flattened to the whole function, exactly as the Go extractor
 * flattens it: a name bound in another branch of the same function is far likelier to be a
 * local than a coincidence, and withholding costs recall while emitting costs precision.
 *
 * `global x` / `nonlocal x` say the opposite — the name is *not* this scope's — so they are
 * subtracted at the end.
 */
function boundNames(scope: Node): ReadonlySet<string> {
  const bound = new Set<string>();
  const escaped = new Set<string>();
  const parameters = field(scope, "parameters");
  if (parameters !== null) parameterNames(parameters, bound);
  const lambdaParameters = scope.namedChildren.find((child) => child.type === "lambda_parameters");
  if (lambdaParameters !== undefined) parameterNames(lambdaParameters, bound);

  const visit = (node: Node): void => {
    switch (node.type) {
      case "assignment":
      case "augmented_assignment": {
        const left = field(node, "left");
        if (left !== null) patternNames(left, bound);
        break;
      }
      case "named_expression": {
        const name = field(node, "name");
        if (name !== null) patternNames(name, bound);
        break;
      }
      case "for_statement":
      case "for_in_clause": {
        const left = field(node, "left");
        if (left !== null) patternNames(left, bound);
        break;
      }
      case "as_pattern": {
        const alias = node.namedChildren.find((child) => child.type === "as_pattern_target");
        const target = alias === undefined ? node.namedChild(1) : alias.namedChild(0);
        if (target !== null) patternNames(target, bound);
        break;
      }
      case "function_definition":
      case "class_definition": {
        const name = field(node, "name");
        if (name !== null) bound.add(name.text);
        break;
      }
      case "import_statement":
      case "import_from_statement": {
        // The `name` field holds only what the statement *binds*; the module path of a
        // `from` import lives under `module_name` and binds nothing.
        for (const child of node.childrenForFieldName("name")) {
          if (child.type === "aliased_import") {
            const alias = field(child, "alias");
            if (alias !== null) bound.add(alias.text);
            continue;
          }
          // `import a.b` binds `a`; `from x import c` binds `c`.
          const first = child.type === "dotted_name" ? child.namedChild(0) : child;
          if (first !== null && first.type === "identifier") bound.add(first.text);
        }
        break;
      }
      case "global_statement":
      case "nonlocal_statement": {
        for (const child of node.namedChildren) {
          if (child.type === "identifier") escaped.add(child.text);
        }
        break;
      }
      default:
        break;
    }
    for (const child of node.namedChildren) visit(child);
  };
  for (const child of scope.namedChildren) visit(child);

  for (const name of escaped) bound.delete(name);
  return bound;
}

/** A callee whose leading name is a local binding resolves to that local, never to a module. */
function shadowed(callee: string, scope: ReadonlySet<string> | null): boolean {
  if (scope === null) return false;
  const dot = callee.indexOf(".");
  const head = dot === -1 ? callee : callee.slice(0, dot);
  // `this` is the normalised spelling of `self`, which is exactly the call rule 4 wants.
  return head !== "this" && scope.has(head);
}

function collectCalls(state: PyState, root: Node): void {
  const walk = (node: Node, owner: string, scope: ReadonlySet<string> | null): void => {
    const next = state.ownerByNode.get(node.id) ?? owner;
    // The outermost function scope owns the bindings of everything nested in it, so a
    // closure or comprehension inside a method reuses the method's set.
    const inner = scope === null && FUNCTION_SCOPES.has(node.type) ? boundNames(node) : scope;
    if (node.type === "call") {
      const callee = calleeText(node);
      if (callee !== null && !shadowed(callee, inner)) {
        state.calls.push({ caller: next, callee, line: lineOf(node) });
      }
    }
    for (const child of node.namedChildren) walk(child, next, inner);
  };
  walk(root, "", null);
}
