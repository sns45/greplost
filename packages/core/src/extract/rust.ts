/**
 * Rust extraction (spec 2026-09-04 section 1.3).
 *
 * One recursive pass over the item tree for declarations, imports and exports, and one walk of
 * the whole tree for call sites, with the caller attributed to the nearest enclosing
 * `function_item` (a closure belongs to the item that contains it, exactly as an arrow function
 * does in TypeScript).
 *
 * Two separators make a Rust symbol path, and the difference matters to the shared linker:
 *
 *   `::`  module nesting        `tests::helper`, `tests::Store` (an inline `mod` body)
 *   `.`   type membership       `Store.put`, `tests::Store.put` (an `impl` or `trait` body)
 *
 * `graph/link.ts` splits a caller's symbol path at its **first** `.` to find the type that owns
 * a `this.method` call. Writing module nesting with `.` would make `mod inner { impl S { … } }`
 * resolve `self.b()` against a top-level `inner`, which is how a wrong `high` edge gets out;
 * with `::` the split lands on `inner::S` and the call resolves to the right method.
 *
 * Nothing here resolves anything: an import specifier is the `use` path as written (with
 * `crate`, `self` and `super` preserved) and a call site is normalised callee text.
 * `resolve/rust.ts` turns those into crate-relative files and call edges.
 *
 * Three normalisations happen here rather than in the resolver, because only the extractor can
 * see the syntax that justifies them, and all three exist so the shared linker's rules apply to
 * Rust unchanged (spec 1.3, "Call resolution"):
 *
 *  - `self.m()`      -> `this.m`,   the schema's form for a call on the enclosing type;
 *  - `Self::m()`     -> `<Type>.m`, resolved against the enclosing `impl`'s type;
 *  - `recv.m()`      -> `<Type>.m`, but **only** when this file says what `recv` is: a typed
 *                       parameter, a `let` with a type annotation, a `let` bound to a struct
 *                       literal, or a `let` bound to `Type::assoc()`. A receiver whose type is
 *                       a generic parameter, a `dyn` trait object or an `impl Trait` is
 *                       trait-dispatched and the call is **dropped**, never guessed; so is a
 *                       receiver whose name is bound more than once in the function.
 *
 * Macro invocations are not calls: `println!(…)` is a `macro_invocation`, not a
 * `call_expression`, so it never reaches `collectCalls` at all.
 */

import type { Node, Tree } from "web-tree-sitter";
import type {
  CallSite,
  DeclKind,
  Declaration,
  ExportRecord,
  FileRecord,
  ImportRecord,
  ImportedSymbol,
  Lang,
} from "../schema.ts";
import { symbolId } from "../schema.ts";
import { clip, field, lineOf, spanOf } from "./ts-signature.ts";

/** Item node types that become declarations, and the `DeclKind` each one takes. */
const ITEM_KIND: Readonly<Record<string, DeclKind>> = {
  const_item: "const",
  enum_item: "enum",
  function_item: "function",
  function_signature_item: "function",
  impl_item: "impl",
  macro_definition: "function",
  mod_item: "module",
  static_item: "var",
  struct_item: "struct",
  trait_item: "trait",
  type_item: "type",
  union_item: "struct",
};

/** Nodes that bind names; a bound name is only typed when its pattern is a bare identifier. */
const BINDERS: ReadonlySet<string> = new Set([
  "closure_parameters",
  "for_expression",
  "if_let_expression",
  "let_condition",
  "let_declaration",
  "match_arm",
  "parameter",
  "while_let_expression",
]);

/** Where a symbol path crosses into an inline `mod`. */
const MODULE_SEPARATOR = "::";

// ---------------------------------------------------------------------------
// small node helpers
// ---------------------------------------------------------------------------

/** The `visibility_modifier` written on an item, collapsed (`pub`, `pub(crate)`, `pub(in a::b)`). */
export function visibilityOf(node: Node): string | null {
  for (const child of node.children) {
    if (child !== null && child.type === "visibility_modifier") return clip(child.text);
  }
  return null;
}

/** Path segments of a `use` path node, whitespace removed. */
function segmentsOf(node: Node | null): string[] {
  if (node === null) return [];
  const text = node.text.replace(/\s+/gu, "");
  return text === "" ? [] : text.split(MODULE_SEPARATOR).filter((segment) => segment !== "");
}

/**
 * The declared name behind a type expression: `&Store`, `Store<T>` and `&mut fmt::Display` all
 * give `Store` / `Display`. A trait object, an `impl Trait`, a tuple, an array, a function
 * pointer and a primitive all give null - none of them names a type this file can dispatch on.
 */
function baseTypeName(node: Node | null): string | null {
  let current = node;
  for (let depth = 0; current !== null && depth < 8; depth++) {
    switch (current.type) {
      case "type_identifier":
        return current.text;
      case "scoped_type_identifier":
        current = field(current, "name");
        continue;
      case "generic_type":
      case "reference_type":
      case "pointer_type":
      case "parenthesized_type":
        current = field(current, "type") ?? current.namedChild(0);
        continue;
      default:
        return null;
    }
  }
  return null;
}

/** `impl Store` -> `Store`; `impl Backoff for Store` -> `Backoff for Store` (spec 1.3). */
function implName(node: Node): { name: string; type: string } | null {
  const type = baseTypeName(field(node, "type"));
  if (type === null) return null;
  const trait = baseTypeName(field(node, "trait"));
  return { name: trait === null ? type : `${trait} for ${type}`, type };
}

/** Header text of a node with a `body` field, cut before the body. */
function signatureOf(source: string, node: Node): string {
  const body = field(node, "body");
  const end = body === null ? node.endIndex : body.startIndex;
  return clip(source.slice(node.startIndex, Math.max(end, node.startIndex)));
}

/** Generic parameter names declared by an item (`<T, 'a, const N: usize>` gives `T`, `N`). */
function typeParameterNames(node: Node): string[] {
  const params = field(node, "type_parameters");
  if (params === null) return [];
  const names: string[] = [];
  for (const child of params.namedChildren) {
    if (child === null) continue;
    if (child.type === "lifetime_parameter" || child.type === "lifetime") continue;
    const name = field(child, "name") ?? child.namedChild(0);
    if (child.type === "type_identifier") names.push(child.text);
    else if (name !== null && (name.type === "type_identifier" || name.type === "identifier")) names.push(name.text);
  }
  return names;
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

interface RustState {
  readonly path: string;
  readonly source: string;
  readonly decls: Declaration[];
  readonly imports: ImportRecord[];
  readonly exports: ExportRecord[];
  readonly calls: CallSite[];
  /** `function_item` node id -> symbol path, so caller attribution is by node identity. */
  readonly callerByNode: Map<number, string>;
}

function addDeclaration(
  state: RustState,
  name: string,
  kind: DeclKind,
  signature: string,
  node: Node,
  visibility: string | null,
  parent: string | undefined,
  extraMeta?: Readonly<Record<string, string>>,
): void {
  const meta: Record<string, string> = { ...extraMeta };
  if (visibility !== null) meta["visibility"] = visibility;
  state.decls.push({
    id: symbolId(state.path, name),
    file: state.path,
    name,
    kind,
    signature,
    exported: visibility !== null,
    span: spanOf(node),
    ...(parent === undefined ? {} : { parent }),
    ...(Object.keys(meta).length === 0 ? {} : { meta }),
  });
  // A file's export surface is its own `pub` items: an item inside an inline `mod`, an `impl`
  // or a `trait` belongs to that item, not to the file.
  if (visibility !== null && parent === undefined) state.exports.push({ name, kind: "named" });
}

// ---------------------------------------------------------------------------
// use trees
// ---------------------------------------------------------------------------

/** One leaf of a use tree: the full path, the name it binds, and whether it is a glob. */
interface UseLeaf {
  /** Path segments as written, with `crate`, `self` and `super` preserved. */
  path: string[];
  /** Exported name in the target: the last segment, or `*` for a glob. */
  name: string;
  /** Local binding: the alias when one is written, else `name`. */
  local: string;
}

/** Flatten one use-tree node into its leaves. `prefix` is the path accumulated so far. */
function useLeaves(node: Node, prefix: string[], out: UseLeaf[]): void {
  switch (node.type) {
    case "scoped_use_list": {
      const next = [...prefix, ...segmentsOf(field(node, "path"))];
      const list = field(node, "list");
      if (list !== null) useLeaves(list, next, out);
      return;
    }
    case "use_list": {
      for (const child of node.namedChildren) {
        if (child !== null) useLeaves(child, prefix, out);
      }
      return;
    }
    case "use_as_clause": {
      const path = [...prefix, ...segmentsOf(field(node, "path"))];
      const alias = field(node, "alias");
      const last = path[path.length - 1];
      if (last === undefined) return;
      out.push({ path, name: last, local: alias === null ? last : alias.text });
      return;
    }
    case "use_wildcard": {
      // `use a::b::*`: the first named child is the path, when there is one at all
      // (`use *;` is not legal Rust, but `use self::*;` parses with a bare `self`).
      const path = [...prefix, ...segmentsOf(node.namedChild(0))];
      out.push({ path, name: "*", local: "*" });
      return;
    }
    case "self": {
      // `use a::{self, b}`: the module itself, bound under its own last segment.
      const last = prefix[prefix.length - 1];
      if (last === undefined) return;
      out.push({ path: [...prefix], name: last, local: last });
      return;
    }
    default: {
      const path = [...prefix, ...segmentsOf(node)];
      const last = path[path.length - 1];
      if (last === undefined) return;
      out.push({ path, name: last, local: last });
    }
  }
}

/**
 * Rewrite a use path so it reads from the **file's** module rather than from the inline module
 * it was written in: the resolver is handed a file, not a position inside one.
 *
 * `self::x` inside `mod a { }` in `lib.rs` means `a::x` from the file, so it becomes
 * `self::a::x`; `super::x` there means `x` at the file's own level, so it becomes `self::x`.
 * A path rooted at `crate`, or written at file level, is already file-relative.
 */
function rebase(path: string[], mods: readonly string[]): string[] {
  const head = path[0];
  if (head === undefined) return path;
  if (head === "self") return ["self", ...mods, ...path.slice(1)];
  if (head === "super") {
    let up = 0;
    while (path[up] === "super") up += 1;
    const rest = path.slice(up);
    // Each `super` climbs one inline module first, then leaves the file.
    const climbed = Math.min(up, mods.length);
    const remaining = up - climbed;
    const base = mods.slice(0, mods.length - climbed);
    if (remaining > 0) return [...new Array<string>(remaining).fill("super"), ...rest];
    return ["self", ...base, ...rest];
  }
  if (mods.length === 0) return path;
  // A uniform path (`use store::Store;`) names something in the module it was written in.
  if (head === "crate") return path;
  return ["self", ...mods, ...path];
}

function collectUse(state: RustState, node: Node, mods: readonly string[]): void {
  const argument = field(node, "argument");
  if (argument === null) return;
  const leaves: UseLeaf[] = [];
  useLeaves(argument, [], leaves);
  const reexport = visibilityOf(node) !== null;
  const line = lineOf(node);
  for (const leaf of leaves) {
    // A glob's leaf path already stops at the module it globs, so no specifier carries a `*`.
    const specifier = rebase(leaf.path, mods).join(MODULE_SEPARATOR);
    if (specifier === "") continue;
    const symbols: ImportedSymbol[] = [{ name: leaf.name, local: leaf.local }];
    state.imports.push({ specifier, kind: "static", symbols, reexport, line });
    if (!reexport || mods.length > 0) continue;
    if (leaf.name === "*") state.exports.push({ name: "*", kind: "star", from: specifier });
    else state.exports.push({ name: leaf.local, kind: "named", local: leaf.name, from: specifier });
  }
}

// ---------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------

/** How a container's children are named: a module prefix, or a type's member prefix. */
interface Scope {
  /** Symbol-path prefix for a child declaration, `""` at file level. */
  readonly prefix: string;
  /** Symbol path of the enclosing declaration, `undefined` at file level. */
  readonly parent: string | undefined;
  /** Inline `mod` segments between the file and here, for rebasing `use` paths. */
  readonly mods: readonly string[];
  /** True inside an `impl` or `trait` body: a function there is a `method`. */
  readonly typeBody: boolean;
}

const FILE_SCOPE: Scope = { prefix: "", parent: undefined, mods: [], typeBody: false };

function collectItems(state: RustState, container: Node, scope: Scope): void {
  for (const node of container.namedChildren) {
    if (node === null) continue;
    if (node.type === "use_declaration") {
      collectUse(state, node, scope.mods);
      continue;
    }
    if (node.type === "extern_crate_declaration") {
      const name = field(node, "name") ?? node.namedChildren.find((c) => c !== null && c.type === "identifier") ?? null;
      if (name !== null) {
        state.imports.push({ specifier: name.text, kind: "static", symbols: [], reexport: false, line: lineOf(node) });
      }
      continue;
    }
    const kind = ITEM_KIND[node.type];
    if (kind === undefined) continue;
    collectItem(state, node, kind, scope);
  }
}

function collectItem(state: RustState, node: Node, kind: DeclKind, scope: Scope): void {
  const visibility = visibilityOf(node);

  if (node.type === "impl_item") {
    const named = implName(node);
    if (named === null) return;
    const full = `${scope.prefix}${named.name}`;
    addDeclaration(state, full, "impl", signatureOf(state.source, node), node, visibility, scope.parent);
    const body = field(node, "body");
    if (body !== null) {
      const owner = `${scope.prefix}${named.type}`;
      collectItems(state, body, { prefix: `${owner}.`, parent: owner, mods: scope.mods, typeBody: true });
    }
    return;
  }

  const nameNode = field(node, "name");
  if (nameNode === null) return;
  const full = `${scope.prefix}${nameNode.text}`;

  if (node.type === "macro_definition") {
    // `macro_rules!` is a callable item with no signature to speak of; the header is the name.
    addDeclaration(state, full, "function", `macro_rules! ${nameNode.text}`, node, visibility, scope.parent, {
      macro: "1",
    });
    return;
  }

  const declKind =
    scope.typeBody && (node.type === "function_item" || node.type === "function_signature_item") ? "method" : kind;
  addDeclaration(state, full, declKind, signatureOf(state.source, node), node, visibility, scope.parent);

  if (node.type === "function_item") state.callerByNode.set(node.id, full);

  if (node.type === "mod_item") {
    const body = field(node, "body");
    if (body === null) {
      // A bodyless `mod foo;` is Rust's module tree becoming an import graph (spec 1.3).
      const specifier = ["self", ...scope.mods, nameNode.text].join(MODULE_SEPARATOR);
      state.imports.push({ specifier, kind: "static", symbols: [], reexport: false, line: lineOf(node) });
      return;
    }
    collectItems(state, body, {
      prefix: `${full}${MODULE_SEPARATOR}`,
      parent: full,
      mods: [...scope.mods, nameNode.text],
      typeBody: false,
    });
    return;
  }

  if (node.type === "trait_item") {
    const body = field(node, "body");
    if (body !== null) {
      collectItems(state, body, { prefix: `${full}.`, parent: full, mods: scope.mods, typeBody: true });
    }
  }
}

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

/** What one function body knows about the names bound inside it. */
type ReceiverTypes = Map<string, string | null>;

/** Every identifier a pattern binds. */
function patternNames(node: Node | null, out: string[]): void {
  if (node === null) return;
  if (node.type === "identifier") {
    out.push(node.text);
    return;
  }
  for (const child of node.namedChildren) {
    if (child !== null) patternNames(child, out);
  }
}

function bind(types: ReceiverTypes, name: string, type: string | null): void {
  if (!types.has(name)) {
    types.set(name, type);
    return;
  }
  // A name bound twice in one function is a shadow: over-dropping costs recall, under-dropping
  // emits a wrong `high` edge (the one thing the structure layer must never do).
  if (types.get(name) !== type) types.set(name, null);
}

/** The type a `let` value pins, when the syntax alone settles it. */
function typeOfValue(value: Node | null, selfType: string | null, generics: ReadonlySet<string>): string | null {
  if (value === null) return null;
  if (value.type === "struct_expression") {
    const name = field(value, "name");
    const type = baseTypeName(name);
    return normaliseType(type, selfType, generics);
  }
  if (value.type !== "call_expression") return null;
  const fn = field(value, "function");
  if (fn === null || fn.type !== "scoped_identifier") return null;
  const path = field(fn, "path");
  if (path === null) return null;
  if (path.type !== "identifier" && path.type !== "type_identifier") return null;
  return normaliseType(path.text, selfType, generics);
}

function normaliseType(name: string | null, selfType: string | null, generics: ReadonlySet<string>): string | null {
  if (name === null) return null;
  if (name === "Self") return selfType;
  if (generics.has(name)) return null;
  return name;
}

/**
 * The receiver types in force inside one function.
 *
 * Block scoping is deliberately flattened to the whole function, exactly as `extract/go.ts`
 * flattens Go's: a name bound in another block is far likelier to be a shadow than a
 * coincidence, and a shadow that is missed emits a wrong `high` edge.
 */
function receiverTypes(fn: Node, selfType: string | null, generics: ReadonlySet<string>): ReceiverTypes {
  const own = new Set(generics);
  for (const name of typeParameterNames(fn)) own.add(name);
  const types: ReceiverTypes = new Map();

  const visit = (node: Node): void => {
    if (BINDERS.has(node.type)) {
      const pattern = node.type === "closure_parameters" ? node : field(node, "pattern");
      const names: string[] = [];
      patternNames(pattern, names);
      // Only a parameter and a `let` say what a name *is*. A `for` pattern binds an element of
      // whatever it iterates and a `match` arm binds a piece of the scrutinee: reading their
      // value expression as the binding's type is exactly the guess this layer must not make.
      const typed = node.type === "parameter" || node.type === "let_declaration";
      if (typed && names.length === 1 && pattern !== null && pattern.type === "identifier") {
        const name = names[0] ?? "";
        const annotated = normaliseType(baseTypeName(field(node, "type")), selfType, own);
        bind(types, name, annotated ?? typeOfValue(field(node, "value"), selfType, own));
      } else {
        for (const name of names) bind(types, name, null);
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null) visit(child);
    }
  };
  visit(fn);
  return types;
}

/** The context one call site is written in. */
interface CallContext {
  caller: string;
  /** The enclosing `impl`'s type, for `Self::m()`; null inside a `trait` or at file level. */
  selfType: string | null;
  generics: ReadonlySet<string>;
  /** Receiver types of the outermost enclosing function; null at file level. */
  types: ReceiverTypes | null;
}

/**
 * Callee text, normalised the way `CallSite.callee` fixes it. Anything else - a three-segment
 * path, a call on a call, a receiver this file cannot type - is not recorded at all, because
 * recording it and hoping the resolver drops it is how a wrong `high` edge gets out.
 */
function calleeText(node: Node, ctx: CallContext): string | null {
  let fn = field(node, "function");
  if (fn !== null && fn.type === "generic_function") fn = field(fn, "function");
  if (fn === null) return null;

  if (fn.type === "identifier") return fn.text;

  if (fn.type === "scoped_identifier") {
    const path = field(fn, "path");
    const name = field(fn, "name");
    if (path === null || name === null) return null;
    // `self::f()` names an item of this very module: it is a plain name.
    if (path.type === "self") return name.text;
    if (path.type !== "identifier" && path.type !== "type_identifier") return null;
    const object = path.text === "Self" ? ctx.selfType : path.text;
    return object === null ? null : `${object}.${name.text}`;
  }

  if (fn.type === "field_expression") {
    const value = field(fn, "value");
    const member = field(fn, "field");
    if (value === null || member === null) return null;
    if (value.type === "self") return `this.${member.text}`;
    if (value.type !== "identifier") return null;
    const type = ctx.types?.get(value.text) ?? null;
    return type === null ? null : `${type}.${member.text}`;
  }

  return null;
}

function collectCalls(state: RustState, root: Node): void {
  const walk = (node: Node, ctx: CallContext): void => {
    let next = ctx;

    if (node.type === "impl_item") {
      const named = implName(node);
      const generics = new Set(next.generics);
      for (const name of typeParameterNames(node)) generics.add(name);
      next = { ...next, selfType: named === null ? null : named.type, generics };
    } else if (node.type === "trait_item") {
      // `Self` inside a trait is the implementing type, which this file does not know.
      const generics = new Set(next.generics);
      for (const name of typeParameterNames(node)) generics.add(name);
      next = { ...next, selfType: null, generics };
    } else if (node.type === "function_item") {
      const caller = state.callerByNode.get(node.id) ?? next.caller;
      // The outermost function owns the bindings of everything nested in it, so a closure
      // inside a function reuses the function's set.
      const types = next.types === null ? receiverTypes(node, next.selfType, next.generics) : next.types;
      const generics = new Set(next.generics);
      for (const name of typeParameterNames(node)) generics.add(name);
      next = { caller, selfType: next.selfType, generics, types };
    }

    if (node.type === "call_expression") {
      const callee = calleeText(node, next);
      if (callee !== null) state.calls.push({ caller: next.caller, callee, line: lineOf(node) });
    }

    for (const child of node.namedChildren) {
      if (child !== null) walk(child, next);
    }
  };
  walk(root, { caller: "", selfType: null, generics: new Set<string>(), types: null });
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/** Everything one `.rs` file says about itself. `lang` is always `"rust"`. */
export function extractRust(
  path: string,
  _lang: Lang,
  source: string,
  tree: Tree,
): Pick<FileRecord, "decls" | "imports" | "exports" | "calls"> {
  const state: RustState = {
    path,
    source,
    decls: [],
    imports: [],
    exports: [],
    calls: [],
    callerByNode: new Map<number, string>(),
  };

  collectItems(state, tree.rootNode, FILE_SCOPE);
  collectCalls(state, tree.rootNode);

  return { decls: state.decls, imports: state.imports, exports: state.exports, calls: state.calls };
}
