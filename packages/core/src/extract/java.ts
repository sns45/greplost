/**
 * Java extraction (spec 2026-09-04 section 1.4).
 *
 * Two passes over one compilation unit. The first walks the *declared* type tree — the top
 * level of the file and, recursively, the bodies of the types it declares — and produces
 * declarations, imports and exports. The second walks the whole tree for call sites.
 *
 * Java's symbol path is one separator deep and always the same one: `.` for membership.
 * A top-level type is `Store`, a nested type is `Store.Entry`, a method is `Store.put` and a
 * method of a nested type is `Store.Entry.key`. `parent` is the enclosing type's dotted path,
 * which is what lets `graph/link.ts` split a `this.method` caller at its last `.` and find the
 * type that owns the call.
 *
 * Four rules decide `exported`, and all four are "what a compiler would let another package
 * see", never "what is written":
 *
 *  - a type or member marked `public`;
 *  - any member of an `interface` or of an `@interface`, which is implicitly public;
 *  - an `enum` constant, which is implicitly `public static final`;
 *  - and, on top of all three, the enclosing chain: a `public` member of a package-private
 *    type is not visible outside its package, so it is not exported.
 *
 * Overloads share a name, exactly as spec 1.4 requires: `Store.put(String)` and
 * `Store.put(int)` are both `Store.put`, distinguished by their span. Their *ids* cannot
 * collide, though — two lines of `graph/symbols.jsonl` with one id is a broken map — so the
 * second and later take a `~<n>` suffix counting from 2 in source order (driver ruling
 * 2026-09-04, the same suffix the HCL extractor and the signal passes use). The export set is
 * deduplicated by name, because a compiler reports one exported name, not one per overload.
 *
 * Nothing here resolves anything across files: an import specifier is the fully qualified name
 * as written, and a call site is normalised callee text. `resolve/java.ts` turns those into
 * files, source roots and call edges.
 *
 * Three normalisations happen here rather than in the resolver, because only the extractor can
 * see the syntax that justifies them (the Rust extractor does the same for the same reason):
 *
 *  - `recv.m()` becomes `<Type>.m`, where `<Type>` is the type **written** on the field,
 *    parameter or local that declares `recv`. There is no inference: `var s = new Store()`
 *    yields nothing, an array or a primitive yields nothing, and a name bound twice in one
 *    method yields nothing. A receiver that is not a bound name at all is left as written, so
 *    `Store.reset()` stays `Store.reset` and the resolver reads it as a static call;
 *  - `this.m()` stays `this.m`, the schema's form for a call on the enclosing type;
 *  - a chained call (`a.b().c()`), a call through a field access (`a.b.c()`), a `super` call
 *    and a call with an explicit generic witness (`A.<String>id()`) are not recorded at all.
 *    Recording them and hoping the resolver drops them is how a wrong `high` edge gets out.
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
import { compareStrings, symbolId } from "../schema.ts";
import { clip, field, lineOf, spanOf } from "./ts-signature.ts";

/** Type declarations, and the `DeclKind` each one takes. */
const TYPE_KIND: Readonly<Record<string, DeclKind>> = {
  annotation_type_declaration: "interface",
  class_declaration: "class",
  enum_declaration: "enum",
  interface_declaration: "interface",
  record_declaration: "record",
};

/** Bodies whose members are implicitly `public` (JLS 9.4, 9.5, 9.6). */
const IMPLICITLY_PUBLIC_BODY: ReadonlySet<string> = new Set([
  "annotation_type_declaration",
  "interface_declaration",
]);

// ---------------------------------------------------------------------------
// small node helpers
// ---------------------------------------------------------------------------

/** The `modifiers` child of a declaration, or null when it carries none. */
function modifiersOf(node: Node): Node | null {
  for (const child of node.children) {
    if (child !== null && child.type === "modifiers") return child;
  }
  return null;
}

/** Modifier keywords written on a declaration (`public`, `static`, `final`, …). */
function keywordsOf(node: Node): ReadonlySet<string> {
  const mods = modifiersOf(node);
  if (mods === null) return new Set<string>();
  const out = new Set<string>();
  for (const child of mods.children) {
    if (child === null) continue;
    if (child.type === "marker_annotation" || child.type === "annotation") continue;
    out.add(child.type);
  }
  return out;
}

/**
 * Annotation names on a declaration, sorted, deduplicated and joined with commas.
 *
 * The *simple* name: `@com.foo.Bar` is `Bar`, so a fully qualified annotation and an imported
 * one produce the same key. Spring routing is the reason `meta.annotations` exists at all
 * (spec 1.4), and `@org.springframework.web.bind.annotation.GetMapping` has to read the same
 * as `@GetMapping` for a later build to find it.
 */
function annotationsOf(node: Node): string {
  const mods = modifiersOf(node);
  if (mods === null) return "";
  const names = new Set<string>();
  for (const child of mods.children) {
    if (child === null) continue;
    if (child.type !== "marker_annotation" && child.type !== "annotation") continue;
    const name = field(child, "name");
    if (name === null) continue;
    const text = name.text.replace(/\s+/gu, "");
    names.add(text.slice(text.lastIndexOf(".") + 1));
  }
  return [...names].sort(compareStrings).join(",");
}

/** Header text of a node with a `body` field, cut before the body. */
function signatureOf(source: string, node: Node): string {
  const body = field(node, "body");
  const end = body === null ? node.endIndex : body.startIndex;
  return clip(source.slice(node.startIndex, Math.max(end, node.startIndex)));
}

/**
 * The declared type name behind a type expression, or null when nothing is named.
 *
 * `Store`, `List<String>` and `java.util.List` all give a name; an array, a primitive, `void`
 * and the reserved `var` all give null, because none of them names a type this file can
 * dispatch a call on. `var` in particular is the whole point: it is a type the compiler
 * infers, and the structure layer does not infer.
 */
function baseTypeName(node: Node | null): string | null {
  let current = node;
  for (let depth = 0; current !== null && depth < 8; depth++) {
    switch (current.type) {
      case "type_identifier": {
        const text = current.text;
        return text === "var" ? null : text;
      }
      case "scoped_type_identifier":
        current = field(current, "name") ?? current.namedChild(current.namedChildCount - 1);
        continue;
      case "generic_type":
      case "annotated_type":
        current = current.namedChild(0);
        continue;
      default:
        return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/** What one method or type body knows about the names bound inside it. */
type BoundTypes = Map<string, string | null>;

interface JavaState {
  readonly path: string;
  readonly source: string;
  readonly decls: Declaration[];
  readonly imports: ImportRecord[];
  readonly exports: ExportRecord[];
  readonly calls: CallSite[];
  /** Declaration ids already used in this file, so a duplicate takes a `~<n>` suffix. */
  readonly ids: Set<string>;
  /** Exported names already recorded, so overloads contribute one name. */
  readonly exported: Set<string>;
  /** Method node id -> symbol path, so caller attribution is by node identity. */
  readonly callerByNode: Map<number, string>;
  /** Dotted type path -> field name -> declared type (null when it is not written down). */
  readonly fields: Map<string, BoundTypes>;
}

/**
 * `<file>#<name>`, with `~<n>` appended when this file already used that id.
 *
 * `~` cannot occur in a Java identifier, so a suffixed id can never collide with a real one,
 * and the numbering follows source order so a new overload never renumbers an older one.
 */
function uniqueId(state: JavaState, name: string): string {
  const base = symbolId(state.path, name);
  if (!state.ids.has(base)) {
    state.ids.add(base);
    return base;
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}~${n}`;
    if (state.ids.has(candidate)) continue;
    state.ids.add(candidate);
    return candidate;
  }
}

function addDeclaration(
  state: JavaState,
  name: string,
  kind: DeclKind,
  signature: string,
  node: Node,
  exported: boolean,
  parent: string | undefined,
  meta: Readonly<Record<string, string>>,
): void {
  state.decls.push({
    id: uniqueId(state, name),
    file: state.path,
    name,
    kind,
    signature,
    exported,
    span: spanOf(node),
    ...(parent === undefined ? {} : { parent }),
    ...(Object.keys(meta).length === 0 ? {} : { meta }),
  });
  if (!exported || state.exported.has(name)) return;
  state.exported.add(name);
  state.exports.push({ name, kind: "named" });
}

function metaOf(node: Node, extra?: Readonly<Record<string, string>>): Record<string, string> {
  const annotations = annotationsOf(node);
  return { ...(annotations === "" ? {} : { annotations }), ...extra };
}

/**
 * Bind one name to a declared type.
 *
 * A name bound twice in one scope is a shadow, and the two bindings rarely mean the same type.
 * Over-dropping costs recall; under-dropping emits a wrong `high` edge, which is the one thing
 * the structure layer must never do — so a disagreement binds to nothing.
 */
function bind(types: BoundTypes, name: string, type: string | null): void {
  if (!types.has(name)) {
    types.set(name, type);
    return;
  }
  if (types.get(name) !== type) types.set(name, null);
}

// ---------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------

/**
 * One `import_declaration`.
 *
 * Every Java import is `ImportKind` `"static"` — the schema's word for "resolved at build
 * time", which is what a Java import is whether or not the keyword `static` is written. What
 * `import static` changes is the *symbol*: the name it binds is the member, not the type, and
 * `resolve/java.ts` reads that difference off the target file rather than off a flag, because
 * a nested-type import (`a.b.Outer.Inner`) is spelled exactly the same way.
 */
function collectImport(state: JavaState, node: Node): void {
  let onDemand = false;
  let path: Node | null = null;
  for (const child of node.children) {
    if (child === null) continue;
    if (child.type === "asterisk") onDemand = true;
    else if (child.type === "scoped_identifier" || child.type === "identifier") path = child;
  }
  if (path === null) return;
  const specifier = path.text.replace(/\s+/gu, "");
  if (specifier === "") return;
  const last = specifier.slice(specifier.lastIndexOf(".") + 1);
  const symbols: ImportedSymbol[] = onDemand ? [{ name: "*", local: "*" }] : [{ name: last, local: last }];
  state.imports.push({ specifier, kind: "static", symbols, reexport: false, line: lineOf(node) });
}

// ---------------------------------------------------------------------------
// declarations
// ---------------------------------------------------------------------------

/** How a container's children are named and whether they can be seen from another package. */
interface Scope {
  /** Dotted path of the enclosing type, `undefined` at file level. */
  readonly owner: string | undefined;
  /** True when the enclosing chain is visible outside its package. */
  readonly visible: boolean;
  /** True inside an `interface` or `@interface` body: every member is implicitly public. */
  readonly implicitlyPublic: boolean;
}

const FILE_SCOPE: Scope = { owner: undefined, visible: true, implicitlyPublic: false };

function collectType(state: JavaState, node: Node, scope: Scope): void {
  const kind = TYPE_KIND[node.type];
  if (kind === undefined) return;
  const nameNode = field(node, "name");
  if (nameNode === null) return;
  const dotted = scope.owner === undefined ? nameNode.text : `${scope.owner}.${nameNode.text}`;
  const isPublic = keywordsOf(node).has("public") || scope.implicitlyPublic;
  const exported = isPublic && scope.visible;
  const extra = node.type === "annotation_type_declaration" ? { annotation: "1" } : undefined;
  addDeclaration(state, dotted, kind, signatureOf(state.source, node), node, exported, scope.owner, metaOf(node, extra));

  const body = field(node, "body");
  if (body === null) return;
  collectMembers(state, body, {
    owner: dotted,
    visible: exported,
    implicitlyPublic: IMPLICITLY_PUBLIC_BODY.has(node.type),
  });
}

function collectMembers(state: JavaState, body: Node, scope: Scope): void {
  for (const node of body.namedChildren) {
    if (node === null) continue;
    if (TYPE_KIND[node.type] !== undefined) {
      collectType(state, node, scope);
      continue;
    }
    switch (node.type) {
      case "enum_body_declarations":
        // The members after an enum's constants are ordinary members: not implicitly public.
        collectMembers(state, node, { ...scope, implicitlyPublic: false });
        continue;
      case "enum_constant":
        collectEnumConstant(state, node, scope);
        continue;
      case "field_declaration":
      case "constant_declaration":
        collectField(state, node, scope);
        continue;
      case "annotation_type_element_declaration":
      case "compact_constructor_declaration":
      case "constructor_declaration":
      case "method_declaration":
        collectMethod(state, node, scope);
        continue;
      default:
        continue;
    }
  }
}

/** An enum constant is implicitly `public static final` (JLS 8.9.3), so it is a `const`. */
function collectEnumConstant(state: JavaState, node: Node, scope: Scope): void {
  const nameNode = field(node, "name");
  if (nameNode === null || scope.owner === undefined) return;
  addDeclaration(
    state,
    `${scope.owner}.${nameNode.text}`,
    "const",
    clip(nameNode.text),
    node,
    scope.visible,
    scope.owner,
    metaOf(node),
  );
}

/** Field text without its initializer, so a long constant does not become the signature. */
function fieldSignature(source: string, node: Node, declarator: Node): string {
  const value = field(declarator, "value");
  const end = value === null ? node.endIndex : value.startIndex;
  return clip(source.slice(node.startIndex, Math.max(end, node.startIndex)).replace(/=\s*$/u, ""));
}

function collectField(state: JavaState, node: Node, scope: Scope): void {
  const owner = scope.owner;
  if (owner === undefined) return;
  const keywords = keywordsOf(node);
  // An interface's field is implicitly `public static final`, which the grammar spells
  // `constant_declaration`; a class's is `const` only when it says `static final` itself.
  const isConstant = node.type === "constant_declaration" || (keywords.has("static") && keywords.has("final"));
  const exported = (keywords.has("public") || scope.implicitlyPublic) && scope.visible;
  const meta = metaOf(node);
  const type = baseTypeName(field(node, "type"));
  let types = state.fields.get(owner);
  if (types === undefined) {
    types = new Map<string, string | null>();
    state.fields.set(owner, types);
  }
  for (const declarator of node.namedChildren) {
    if (declarator === null || declarator.type !== "variable_declarator") continue;
    const nameNode = field(declarator, "name");
    if (nameNode === null) continue;
    bind(types, nameNode.text, type);
    addDeclaration(
      state,
      `${owner}.${nameNode.text}`,
      isConstant ? "const" : "var",
      fieldSignature(state.source, node, declarator),
      node,
      exported,
      owner,
      meta,
    );
  }
}

function collectMethod(state: JavaState, node: Node, scope: Scope): void {
  const owner = scope.owner;
  if (owner === undefined) return;
  const nameNode = field(node, "name");
  if (nameNode === null) return;
  const keywords = keywordsOf(node);
  const exported = (keywords.has("public") || scope.implicitlyPublic) && scope.visible;
  const name = `${owner}.${nameNode.text}`;
  addDeclaration(state, name, "method", signatureOf(state.source, node), node, exported, owner, metaOf(node));
  state.callerByNode.set(node.id, name);
}

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

/**
 * The names bound inside one method, with the type each one is *written* as.
 *
 * Block scoping is deliberately flattened to the whole method, exactly as the Go and Rust
 * extractors flatten theirs, and the walk descends into lambdas and anonymous class bodies so
 * a name declared there is bound too: a call inside an anonymous class is attributed to the
 * method that contains it, so its receivers have to be known here or the wrong type is read.
 */
function localTypes(fn: Node): BoundTypes {
  const types: BoundTypes = new Map();
  const visit = (node: Node): void => {
    switch (node.type) {
      case "enhanced_for_statement":
      case "formal_parameter":
      case "resource": {
        const nameNode = field(node, "name");
        if (nameNode !== null) bind(types, nameNode.text, baseTypeName(field(node, "type")));
        break;
      }
      case "local_variable_declaration": {
        const type = baseTypeName(field(node, "type"));
        for (const declarator of node.namedChildren) {
          if (declarator === null || declarator.type !== "variable_declarator") continue;
          const nameNode = field(declarator, "name");
          if (nameNode !== null) bind(types, nameNode.text, type);
        }
        break;
      }
      case "catch_formal_parameter":
      case "spread_parameter": {
        // A multi-catch names several types and a varargs parameter is an array: neither is a
        // type this file can dispatch on, and both still shadow whatever else holds the name.
        for (const name of boundNames(node)) bind(types, name, null);
        break;
      }
      case "lambda_expression": {
        // `(String y) -> …` is a `formal_parameters` and is handled above; `x -> …` and
        // `(x, y) -> …` name no type at all.
        const params = field(node, "parameters");
        if (params !== null && params.type !== "formal_parameters") {
          const candidates = params.type === "identifier" ? [params] : params.namedChildren;
          for (const child of candidates) {
            if (child !== null && child.type === "identifier") bind(types, child.text, null);
          }
        }
        break;
      }
      default:
        break;
    }
    for (const child of node.namedChildren) {
      if (child !== null) visit(child);
    }
  };
  visit(fn);
  return types;
}

/** Identifiers a parameter-like node binds, whether it spells them directly or via a declarator. */
function boundNames(node: Node): string[] {
  const direct = field(node, "name");
  if (direct !== null) return [direct.text];
  const out: string[] = [];
  for (const child of node.namedChildren) {
    if (child === null || child.type !== "variable_declarator") continue;
    const name = field(child, "name");
    if (name !== null) out.push(name.text);
  }
  return out;
}

/**
 * The context one call site is written in.
 *
 * A Java file has no top-level code: every call is inside *some* type, even when it is inside
 * no method (a field default, a `static { }` block, an instance initializer). Such a call is
 * attributed to the enclosing type rather than to the file, which is both truer and something
 * the javac oracle can agree with — a compiler sees the same enclosing class.
 */
interface CallContext {
  /** Symbol path of the enclosing method, or of the enclosing type when there is no method. */
  readonly caller: string;
  /** Locals of that method; empty when there is no enclosing method. */
  readonly locals: BoundTypes;
  /** Dotted path of the enclosing type, `""` at file level. */
  readonly owner: string;
  /** True once a declared method has been entered, so a nested type does not take the caller. */
  readonly inMethod: boolean;
}

const NO_LOCALS: BoundTypes = new Map();

/**
 * The type a receiver name is written as: `undefined` when the name is not bound here at all
 * (so it is a type name, not a variable), `null` when it is bound but its type is not written.
 */
function receiverType(state: JavaState, ctx: CallContext, name: string): string | null | undefined {
  if (ctx.locals.has(name)) return ctx.locals.get(name) ?? null;
  // A field of the enclosing type, then of each type that encloses it: an inner class sees the
  // fields of every class around it.
  for (let owner = ctx.owner; owner !== ""; owner = owner.slice(0, Math.max(owner.lastIndexOf("."), 0))) {
    const types = state.fields.get(owner);
    if (types?.has(name) === true) return types.get(name) ?? null;
  }
  return undefined;
}

/**
 * Callee text as `CallSite.callee` fixes it, or null when this file may not write it down.
 *
 * A generic witness (`A.<String>id()`) is dropped because the grammar puts the witness between
 * the object and the name, so the text is not `obj.method` at all; spec 1.4 drops it too.
 */
function calleeText(state: JavaState, node: Node, ctx: CallContext): string | null {
  if (node.type === "object_creation_expression") {
    const type = baseTypeName(field(node, "type"));
    return type === null ? null : `new ${type}`;
  }
  const name = field(node, "name");
  if (name === null) return null;
  for (const child of node.namedChildren) {
    if (child !== null && child.type === "type_arguments") return null;
  }
  const object = field(node, "object");
  if (object === null) return name.text;
  if (object.type === "this") return `this.${name.text}`;
  if (object.type !== "identifier") return null;
  const type = receiverType(state, ctx, object.text);
  if (type === undefined) return `${object.text}.${name.text}`;
  return type === null ? null : `${type}.${name.text}`;
}

function collectCalls(state: JavaState, root: Node): void {
  const walk = (node: Node, ctx: CallContext): void => {
    let next = ctx;
    const caller = state.callerByNode.get(node.id);
    if (caller !== undefined) {
      // Only a method that became a declaration takes the caller, so a method of an anonymous
      // class body is *not* one: its calls belong to the method that contains it, which is what
      // the javac oracle says too (an anonymous class has no name to attribute them to).
      const owner = caller.slice(0, Math.max(caller.lastIndexOf("."), 0));
      next = { caller, locals: localTypes(node), owner, inMethod: true };
    } else if (!ctx.inMethod && TYPE_KIND[node.type] !== undefined) {
      const nameNode = field(node, "name");
      if (nameNode !== null) {
        const dotted = ctx.owner === "" ? nameNode.text : `${ctx.owner}.${nameNode.text}`;
        next = { caller: dotted, locals: NO_LOCALS, owner: dotted, inMethod: false };
      }
    }

    if (node.type === "method_invocation" || node.type === "object_creation_expression") {
      const callee = calleeText(state, node, next);
      if (callee !== null) state.calls.push({ caller: next.caller, callee, line: lineOf(node) });
    }

    for (const child of node.namedChildren) {
      if (child !== null) walk(child, next);
    }
  };
  walk(root, { caller: "", locals: NO_LOCALS, owner: "", inMethod: false });
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/** Everything one `.java` file says about itself. `lang` is always `"java"`. */
export function extractJava(
  path: string,
  _lang: Lang,
  source: string,
  tree: Tree,
): Pick<FileRecord, "decls" | "imports" | "exports" | "calls"> {
  const state: JavaState = {
    path,
    source,
    decls: [],
    imports: [],
    exports: [],
    calls: [],
    ids: new Set<string>(),
    exported: new Set<string>(),
    callerByNode: new Map<number, string>(),
    fields: new Map<string, BoundTypes>(),
  };

  for (const node of tree.rootNode.namedChildren) {
    if (node === null) continue;
    if (node.type === "import_declaration") {
      collectImport(state, node);
      continue;
    }
    collectType(state, node, FILE_SCOPE);
  }
  // Second pass: the field index the first pass built is what types a receiver.
  collectCalls(state, tree.rootNode);

  return { decls: state.decls, imports: state.imports, exports: state.exports, calls: state.calls };
}
