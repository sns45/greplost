/**
 * Kotlin extraction (spec 2026-09-04 section 1.5, on top of the Java rules in 1.4).
 *
 * One recursive pass over the declaration tree. Declarations are collected from the file and
 * from every `class_body`/`enum_class_body`; a body (`function_body`, a property initialiser, a
 * getter) is walked only for its call sites, attributed to the declaration that owns it. A
 * local `fun` is therefore not a declaration, exactly as a closure is not one in Rust, but its
 * calls belong to the function it was written in.
 *
 * Three Kotlin rules decide whether the gate passes, and all three are easy to get backwards:
 *
 *  - `exported` is the **absence** of `private`/`internal`, the inverse of Java's `public` rule.
 *    A Kotlin declaration with no visibility modifier is public.
 *  - An extension is named `<Receiver>.<name>` with `parent = <Receiver>`, so `recv.ext()`
 *    resolves exactly the way a method call does (spec 1.5).
 *  - A companion object's members take `parent = <Outer>.Companion`, whatever the companion was
 *    named in source: `Store.Companion.of`, never `Store.Names.of`.
 *
 * Two normalisations happen here rather than in the resolver, because only the extractor can
 * see the syntax that justifies them (the same split `extract/rust.ts` makes):
 *
 *  - `this.m()` keeps the schema's `this.method` form; the resolver reads the enclosing type
 *    off the caller's symbol path.
 *  - `recv.m()` becomes `<Type>.m` when this file says what `recv` is - a typed parameter, a
 *    `val`/`var` with a type annotation, or one bound to a constructor call. A receiver whose
 *    type this file does not know, or whose name is bound twice, is **dropped**, never guessed.
 *    A receiver that is not a local at all (`Store.put()`, `Box.of()`) is kept as written: it
 *    names a type, an object or a companion, and the resolver looks it up.
 *
 * Kotlin has no `new`, so a constructor call is an ordinary call to the type's name and a
 * secondary constructor is not a declaration: `Item("a", 1)` resolves to the `Item` declaration
 * itself. Nothing here resolves anything; `resolve/kotlin.ts` turns names into files and edges.
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
import { clip, lineOf, spanOf } from "./ts-signature.ts";

/** Node types that open a declaration container: their children are members, not statements. */
const TYPE_BODIES: ReadonlySet<string> = new Set(["class_body", "enum_class_body"]);

/**
 * The Kotlin type of a literal receiver, so `"x".shout()` reads as `String.shout`.
 *
 * A literal writes its own type down - there is nothing to infer - and it is what both the
 * compiler and the classfile call the extension's receiver, so the map and the oracle agree.
 * A `real_literal` is deliberately absent: Kotlin's default is `Double`, but a `1.0f` suffix
 * makes it `Float`, and this layer does not guess.
 */
const LITERAL_TYPES: Readonly<Record<string, string>> = {
  string_literal: "String",
  multiline_string_literal: "String",
  integer_literal: "Int",
  long_literal: "Long",
  hex_literal: "Int",
  bin_literal: "Int",
  boolean_literal: "Boolean",
  character_literal: "Char",
};

/** Modifier keywords that make a declaration unexported (spec 1.5: the inverse of Java's rule). */
const HIDDEN: ReadonlySet<string> = new Set(["private", "internal"]);

/**
 * The vendored grammar's two name nodes: `simple_identifier` names a value, `type_identifier` a
 * type. Kept as constants because the two Kotlin grammar lineages disagree about them -
 * `@tree-sitter-grammars/tree-sitter-kotlin` spells both `identifier` - and this extractor is
 * written against the one `grammars/VERSIONS.txt` pins (see the leaf 2.6 report for why).
 */
const NAME = "simple_identifier";
const TYPE_NAME = "type_identifier";

/** Node types whose body is walked for calls and attributed to the declaration before them. */
const ACCESSORS: ReadonlySet<string> = new Set(["getter", "setter"]);

// ---------------------------------------------------------------------------
// small node helpers
// ---------------------------------------------------------------------------

/** Direct children of `node` with the given type, in source order. */
function childrenOfType(node: Node, type: string): Node[] {
  const out: Node[] = [];
  for (const child of node.children) {
    if (child !== null && child.type === type) out.push(child);
  }
  return out;
}

function firstOfType(node: Node, type: string): Node | null {
  return childrenOfType(node, type)[0] ?? null;
}

/** The `modifiers` node written on a declaration, or null. */
function modifiersOf(node: Node): Node | null {
  return firstOfType(node, "modifiers");
}

/** Every modifier keyword written on a declaration (`private`, `data`, `suspend`, `override`). */
function modifierWords(node: Node): string[] {
  const modifiers = modifiersOf(node);
  if (modifiers === null) return [];
  const words: string[] = [];
  for (const child of modifiers.namedChildren) {
    if (child === null || child.type === "annotation") continue;
    words.push(child.text.trim());
  }
  return words;
}

/** The visibility keyword written on a declaration, or null when none is. */
function visibilityOf(node: Node): string | null {
  const modifiers = modifiersOf(node);
  if (modifiers === null) return null;
  for (const child of modifiers.namedChildren) {
    if (child !== null && child.type === "visibility_modifier") return child.text.trim();
  }
  return null;
}

/** Annotation names written on a declaration, sorted and comma-joined (spec 1.4). */
function annotationNames(node: Node): string[] {
  const modifiers = modifiersOf(node);
  if (modifiers === null) return [];
  const names: string[] = [];
  for (const child of modifiers.namedChildren) {
    if (child === null || child.type !== "annotation") continue;
    for (const name of annotationsIn(child)) names.push(name);
  }
  return names;
}

/** Every `@Name`/`@Name(...)` inside one `annotation` node (`@set:[A B]` carries several). */
function annotationsIn(node: Node): string[] {
  const names: string[] = [];
  const visit = (current: Node): void => {
    if (current.type === "user_type") {
      const name = typeNameOf(current);
      if (name !== null) names.push(name);
      return;
    }
    for (const child of current.namedChildren) {
      if (child !== null) visit(child);
    }
  };
  visit(node);
  return names;
}

/**
 * The declared name behind a type expression: `Item`, `tiny.Item`, `Item?`, `List<Item>` and
 * `MutableList<Item>` all give the type written at its head (`Item`, `List`, `MutableList`).
 * A function type, a lambda and a type parameter give null: none of them names a type this
 * file can dispatch on.
 */
function typeNameOf(node: Node | null): string | null {
  let current = node;
  for (let depth = 0; current !== null && depth < 8; depth += 1) {
    if (current.type === TYPE_NAME) return current.text;
    if (current.type === "user_type") {
      // `a.b.C` is a chain of `type_identifier`s: the last one is the type.
      const identifiers = childrenOfType(current, TYPE_NAME);
      const last = identifiers[identifiers.length - 1];
      if (last !== undefined) return last.text;
      return null;
    }
    if (current.type === "nullable_type" || current.type === "parenthesized_type" || current.type === "receiver_type") {
      current = current.namedChild(0);
      continue;
    }
    return null;
  }
  return null;
}

/** Header text of a declaration: everything before its body, whitespace collapsed. */
function signatureOf(source: string, node: Node, bodyTypes: readonly string[]): string {
  let end = node.endIndex;
  for (const type of bodyTypes) {
    const body = firstOfType(node, type);
    if (body !== null) end = Math.min(end, body.startIndex);
  }
  return clip(source.slice(node.startIndex, Math.max(end, node.startIndex)));
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

interface KotlinState {
  readonly path: string;
  readonly source: string;
  readonly decls: Declaration[];
  readonly imports: ImportRecord[];
  readonly exports: ExportRecord[];
  readonly calls: CallSite[];
  /** Declaration ids already used in this file, so a duplicate name can take a `~<n>` suffix. */
  readonly usedIds: Set<string>;
  /** Export names already emitted, so an overloaded name is exported once. */
  readonly exported: Set<string>;
  /** `@file:JvmName("X")`, recorded in `meta` and ignored for resolution (spec 1.5). */
  jvmName: string | null;
  /** The file's `package` header, or "" for the default package. */
  packageName: string;
}

/**
 * `<file>#<name>`, with `~<n>` appended when this file already used that id (driver ruling
 * 2026-09-04, every language): `src/A.kt#Store.put`, then `src/A.kt#Store.put~2`.
 *
 * The suffix lives in the **id only**. `Declaration.name` stays exactly as the source wrote it,
 * because that is what a card renders and what a reader searches for; two overloads really are
 * both called `put`. `~` cannot occur in a Kotlin identifier, so a suffixed id can never
 * collide with a real one, and the numbering follows source order so a new overload never
 * renumbers an older one.
 */
function uniqueId(state: KotlinState, name: string): string {
  const base = symbolId(state.path, name);
  if (!state.usedIds.has(base)) {
    state.usedIds.add(base);
    return base;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base}~${n}`;
    if (state.usedIds.has(candidate)) continue;
    state.usedIds.add(candidate);
    return candidate;
  }
}

/** What a container tells its members: how they are named and whether they are visible. */
interface Scope {
  /** Symbol-path prefix for a member, `""` at file level. */
  readonly prefix: string;
  /** Symbol path of the enclosing declaration, `undefined` at file level. */
  readonly parent: string | undefined;
  /** True inside a type body: a `function_declaration` there is a `method`. */
  readonly inType: boolean;
  /** False when an ancestor is `private`/`internal`, so no member of it is an export. */
  readonly visible: boolean;
}

const FILE_SCOPE: Scope = { prefix: "", parent: undefined, inType: false, visible: true };

interface DeclarationInput {
  name: string;
  kind: DeclKind;
  signature: string;
  node: Node;
  scope: Scope;
  exported: boolean;
  meta: Record<string, string>;
}

/** Register one declaration and, when it and every ancestor are visible, its export record. */
function addDeclaration(state: KotlinState, input: DeclarationInput): string {
  const name = `${input.scope.prefix}${input.name}`;
  const meta = input.meta;
  state.decls.push({
    id: uniqueId(state, name),
    file: state.path,
    name,
    kind: input.kind,
    signature: input.signature,
    exported: input.exported,
    span: spanOf(input.node),
    ...(input.scope.parent === undefined ? {} : { parent: input.scope.parent }),
    ...(Object.keys(meta).length === 0 ? {} : { meta }),
  });
  // Spec 1.4: one `named` record per exported type and per exported member of an exported
  // type. An overload exports its name once - two `put`s are one exported name.
  if (input.exported && input.scope.visible && !state.exported.has(name)) {
    state.exported.add(name);
    state.exports.push({ name, kind: "named" });
  }
  return name;
}

// ---------------------------------------------------------------------------
// file header: `@file:JvmName` and imports
// ---------------------------------------------------------------------------

/**
 * The `package` header, or "" for the default package.
 *
 * Kotlin does not tie a package to a directory, so this is the only thing that says which
 * package a file is in - and `resolve/kotlin.ts` needs it to know which files are siblings.
 * `FileRecord` has no field for it (that would be a schema change), so it is recorded on the
 * file's top-level declarations, which are exactly the ones the package qualifies.
 */
function filePackage(root: Node): string {
  const header = firstOfType(root, "package_header");
  if (header === null) return "";
  const identifier = firstOfType(header, "identifier") ?? firstOfType(header, "qualified_identifier");
  return identifier === null ? "" : identifier.text.replace(/[\s`]+/gu, "");
}

/** `@file:JvmName("AppMain")` -> `AppMain`; any other file annotation is ignored. */
function fileJvmName(root: Node): string | null {
  for (const annotation of childrenOfType(root, "file_annotation")) {
    const invocation = firstOfType(annotation, "constructor_invocation");
    if (invocation === null) continue;
    if (typeNameOf(firstOfType(invocation, "user_type")) !== "JvmName") continue;
    const args = firstOfType(invocation, "value_arguments");
    const literal = args === null ? null : args.descendantsOfType("string_content")[0] ?? null;
    if (literal !== null && literal !== undefined) return literal.text;
  }
  return null;
}

/**
 * `import a.b.C`, `import a.b.C as D`, `import a.b.*`.
 *
 * The specifier is the fully qualified name as written (the package for a star import), which
 * is what `resolve/kotlin.ts` maps onto the target package's directory.
 */
function collectImports(state: KotlinState, root: Node): void {
  for (const list of childrenOfType(root, "import_list")) {
    for (const header of childrenOfType(list, "import_header")) {
      const identifier = firstOfType(header, "identifier");
      if (identifier === null) continue;
      const specifier = identifier.text.replace(/\s+/gu, "");
      if (specifier === "") continue;
      const star = firstOfType(header, "wildcard_import") !== null;
      const alias = firstOfType(header, "import_alias");
      const segments = specifier.split(".");
      const last = segments[segments.length - 1] ?? specifier;
      state.imports.push({
        specifier,
        kind: "static",
        symbols: [
          {
            name: star ? "*" : last,
            local: star ? "*" : (typeNameOf(firstOfType(alias ?? header, TYPE_NAME)) ?? last),
          },
        ],
        reexport: false,
        line: lineOf(header),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// declarations
// ---------------------------------------------------------------------------

/**
 * The `DeclKind` of a `class_declaration`, from its keyword and its class modifiers.
 *
 * `interface` is a keyword; `enum`, `data` and `annotation` are class modifiers. `enum class`
 * and `annotation class` are not in spec 1.5's three-way list, so they inherit Java's mapping
 * from spec 1.4: an enum is an `enum`, and an annotation class is an `interface` carrying
 * `meta.annotation = "1"` (leaf ruling 2026-09-04).
 */
function classKind(node: Node): { kind: DeclKind; annotation: boolean } {
  const words = new Set(modifierWords(node));
  const keywords = new Set(node.children.filter((c) => c !== null && !c.isNamed).map((c) => c.text));
  if (keywords.has("interface")) return { kind: "interface", annotation: false };
  if (words.has("annotation")) return { kind: "interface", annotation: true };
  if (words.has("enum") || keywords.has("enum")) return { kind: "enum", annotation: false };
  if (words.has("data")) return { kind: "record", annotation: false };
  return { kind: "class", annotation: false };
}

function collectContainer(state: KotlinState, container: Node, scope: Scope): void {
  /** The property a following `getter`/`setter` belongs to: the grammar writes them as siblings. */
  let lastProperty: string | null = null;
  for (const node of container.namedChildren) {
    if (node === null) continue;
    if (ACCESSORS.has(node.type)) {
      if (lastProperty !== null) collectCalls(state, node, callContext(node, lastProperty));
      continue;
    }
    lastProperty = collectMember(state, node, scope);
  }
}

/**
 * One member of a container; its symbol path when it was a property, so a following accessor
 * can be attributed to it. Anything else - a comment, a statement - is not a declaration.
 */
function collectMember(state: KotlinState, node: Node, scope: Scope): string | null {
  switch (node.type) {
    case "class_declaration":
      collectType(state, node, scope);
      return null;
    case "object_declaration":
      collectObject(state, node, scope, null);
      return null;
    case "companion_object":
      // Spec 1.5: whatever the companion is called in source, its members take `<Outer>.Companion`.
      collectObject(state, node, scope, "Companion");
      return null;
    case "function_declaration":
      collectFunction(state, node, scope);
      return null;
    case "property_declaration":
      return collectProperty(state, node, scope);
    case "type_alias": {
      const name = firstOfType(node, TYPE_NAME);
      if (name === null) return null;
      addDeclaration(state, {
        name: name.text,
        kind: "type",
        signature: signatureOf(state.source, node, []),
        node,
        scope,
        exported: isExported(node),
        meta: metaOf(state, node, scope, {}),
      });
      return null;
    }
    case "enum_entry": {
      const name = firstOfType(node, NAME);
      if (name === null) return null;
      addDeclaration(state, {
        name: name.text,
        kind: "const",
        signature: signatureOf(state.source, node, ["class_body"]),
        node,
        scope,
        exported: scope.visible,
        meta: {},
      });
      return null;
    }
    default:
      return null;
  }
}

/** True when no `private`/`internal` modifier is written (spec 1.5). */
function isExported(node: Node): boolean {
  const visibility = visibilityOf(node);
  return visibility === null || !HIDDEN.has(visibility);
}

/** `meta` for one declaration: annotations, suspend, visibility, and the file's `@file:JvmName`. */
function metaOf(
  state: KotlinState,
  node: Node,
  scope: Scope,
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  const meta: Record<string, string> = { ...extra };
  const annotations = annotationNames(node).sort();
  if (annotations.length > 0) meta["annotations"] = annotations.join(",");
  const visibility = visibilityOf(node);
  if (visibility !== null) meta["visibility"] = visibility;
  // `@file:JvmName` renames the class the file's *top-level* functions and properties compile
  // into, so those are the declarations it is recorded on. It never changes resolution.
  if (state.jvmName !== null && scope.parent === undefined) meta["jvmName"] = state.jvmName;
  // The package qualifies the file's top-level names, and nothing below them: a member is
  // reached through its type. The default package writes no key at all.
  if (state.packageName !== "" && scope.parent === undefined) meta["package"] = state.packageName;
  return meta;
}

function collectType(state: KotlinState, node: Node, scope: Scope): void {
  const nameNode = firstOfType(node, TYPE_NAME);
  if (nameNode === null) return;
  const { kind, annotation } = classKind(node);
  const exported = isExported(node);
  const name = addDeclaration(state, {
    name: nameNode.text,
    kind,
    signature: signatureOf(state.source, node, ["class_body", "enum_class_body"]),
    node,
    scope,
    exported,
    meta: metaOf(state, node, scope, annotation ? { annotation: "1" } : {}),
  });
  collectBody(state, node, scope, name, exported);
}

function collectObject(state: KotlinState, node: Node, scope: Scope, forcedName: string | null): void {
  const nameNode = firstOfType(node, TYPE_NAME);
  const written = nameNode === null ? null : nameNode.text;
  const name = forcedName ?? written;
  if (name === null) return;
  const exported = isExported(node);
  const meta: Record<string, string> = { object: "1" };
  // A named companion (`companion object Names`) still lives at `<Outer>.Companion`; the name
  // it was written under is a fact about the file, so it is kept rather than dropped.
  if (forcedName !== null && written !== null && written !== forcedName) meta["companionName"] = written;
  const full = addDeclaration(state, {
    name,
    kind: "class",
    signature: signatureOf(state.source, node, ["class_body"]),
    node,
    scope,
    exported,
    meta: metaOf(state, node, scope, meta),
  });
  collectBody(state, node, scope, full, exported);
}

/** Primary-constructor properties and the members of a type's body. */
function collectBody(state: KotlinState, node: Node, scope: Scope, owner: string, exported: boolean): void {
  const inner: Scope = {
    prefix: `${owner}.`,
    parent: owner,
    inType: true,
    visible: scope.visible && exported,
  };
  const constructor = firstOfType(node, "primary_constructor");
  if (constructor !== null) collectConstructorProperties(state, constructor, inner);
  for (const type of TYPE_BODIES) {
    const body = firstOfType(node, type);
    if (body !== null) collectContainer(state, body, inner);
  }
}

/**
 * `class Item(val id: String)` declares a property, not just a parameter: `val`/`var` on a
 * `class_parameter` is Kotlin's shorthand for a member, and the compiler emits one. A plain
 * `class Item(id: String)` parameter is not a declaration (leaf ruling 2026-09-04).
 */
function collectConstructorProperties(state: KotlinState, constructor: Node, scope: Scope): void {
  const parameters = firstOfType(constructor, "class_parameters") ?? constructor;
  for (const parameter of childrenOfType(parameters, "class_parameter")) {
    const binding = bindingKeyword(parameter);
    if (binding === null) continue;
    const nameNode = firstOfType(parameter, NAME);
    if (nameNode === null) continue;
    addDeclaration(state, {
      name: nameNode.text,
      kind: binding === "var" ? "var" : "const",
      signature: clip(parameter.text),
      node: parameter,
      scope,
      exported: isExported(parameter),
      meta: metaOf(state, parameter, scope, {}),
    });
  }
}

/** The `val`/`var` a property or a constructor parameter is written with, or null for neither. */
function bindingKeyword(node: Node): "val" | "var" | null {
  const binding = firstOfType(node, "binding_pattern_kind");
  const text = binding === null ? "" : binding.text.trim();
  return text === "val" || text === "var" ? text : null;
}

/** The receiver a `fun`/`val` declares an extension on: the type written before its name. */
function receiverOf(node: Node): string | null {
  for (const child of node.children) {
    if (child === null) continue;
    if (child.type === "receiver_type" || child.type === "user_type") return typeNameOf(child);
    if (child.type === NAME || child.type === "variable_declaration") return null;
  }
  return null;
}

function collectFunction(state: KotlinState, node: Node, scope: Scope): void {
  const nameNode = firstOfType(node, NAME);
  if (nameNode === null) return;
  const receiver = receiverOf(node);
  const words = new Set(modifierWords(node));
  const extra: Record<string, string> = {};
  if (words.has("suspend")) extra["suspend"] = "1";
  // Spec 1.5: at file level an extension *is* named `<Receiver>.<name>`, so `recv.ext()`
  // resolves the way a method does. Inside a type the member's own path wins and the receiver
  // is recorded, because `A.String.ext` would name a member of a type called `A.String`.
  const extension = receiver !== null && !scope.inType;
  if (receiver !== null && !extension) extra["receiver"] = receiver;
  const name = extension ? `${receiver}.${nameNode.text}` : nameNode.text;
  const memberScope: Scope = extension ? { ...scope, parent: receiver ?? scope.parent } : scope;
  const full = addDeclaration(state, {
    name,
    kind: scope.inType ? "method" : "function",
    signature: signatureOf(state.source, node, ["function_body"]),
    node,
    scope: memberScope,
    exported: isExported(node),
    meta: metaOf(state, node, memberScope, extra),
  });
  const body = firstOfType(node, "function_body");
  if (body !== null) collectCalls(state, body, callContext(node, full));
}

function collectProperty(state: KotlinState, node: Node, scope: Scope): string | null {
  const kind: DeclKind = bindingKeyword(node) === "var" ? "var" : "const";
  const receiver = receiverOf(node);
  const declarations = childrenOfType(node, "variable_declaration");
  let last: string | null = null;
  for (const declaration of declarations) {
    const nameNode = firstOfType(declaration, NAME);
    if (nameNode === null) continue;
    const extension = receiver !== null && !scope.inType;
    const extra: Record<string, string> = {};
    if (receiver !== null && !extension) extra["receiver"] = receiver;
    const memberScope: Scope = extension ? { ...scope, parent: receiver ?? scope.parent } : scope;
    last = addDeclaration(state, {
      name: extension ? `${receiver}.${nameNode.text}` : nameNode.text,
      kind,
      signature: signatureOf(state.source, node, []),
      node,
      scope: memberScope,
      exported: isExported(node),
      meta: metaOf(state, node, memberScope, extra),
    });
  }
  if (last === null) return null;
  // An initialiser and an accessor are code, and their calls belong to the property that runs
  // them: `val doubled: Int get() = attempts * 2` has one declaration and one body.
  for (const child of node.namedChildren) {
    if (child === null) continue;
    if (child.type === "modifiers") continue;
    if (child.type === "variable_declaration" || child.type === "user_type") continue;
    collectCalls(state, child, callContext(node, last));
  }
  return last;
}

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

/** The types this declaration's body knows its own names by: local name -> type, or null. */
type ReceiverTypes = Map<string, string | null>;

interface CallContext {
  caller: string;
  types: ReceiverTypes;
}

function callContext(owner: Node, caller: string): CallContext {
  return { caller, types: receiverTypes(owner) };
}

function bind(types: ReceiverTypes, name: string, type: string | null): void {
  if (!types.has(name)) {
    types.set(name, type);
    return;
  }
  // A name bound twice in one body is a shadow: over-dropping costs recall, under-dropping
  // emits a wrong `high` edge, which is the one thing the structure layer must never do.
  if (types.get(name) !== type) types.set(name, null);
}

/**
 * The type an initialiser pins, when the syntax alone settles it: `Item("a", 1)` is a
 * constructor call in Kotlin, which has no `new`. Capitalisation is the only thing that
 * separates `Item(…)` from a factory function, so the rule is exactly that and no inference:
 * a bare capitalised callee names the type. A lowercase callee, a chain, or anything else
 * leaves the name untyped, and an untyped receiver's calls are dropped.
 */
function typeOfInitialiser(node: Node | null): string | null {
  if (node === null || node.type !== "call_expression") return null;
  const callee = node.namedChild(0);
  if (callee === null || callee.type !== NAME) return null;
  const text = callee.text;
  const head = text.charAt(0);
  return head !== "" && head === head.toUpperCase() && head !== head.toLowerCase() ? text : null;
}

/** Every name one declaration's body binds, with the type this file can prove it has. */
function receiverTypes(owner: Node): ReceiverTypes {
  const types: ReceiverTypes = new Map();
  const visit = (node: Node): void => {
    if (node.type === "parameter" || node.type === "class_parameter") {
      const nameNode = firstOfType(node, NAME);
      const type = childrenOfType(node, "user_type")[0] ?? childrenOfType(node, "nullable_type")[0] ?? null;
      if (nameNode !== null) bind(types, nameNode.text, typeNameOf(type));
    } else if (node.type === "property_declaration") {
      const declarations = childrenOfType(node, "variable_declaration");
      const initialiser = node.namedChildren[node.namedChildren.length - 1] ?? null;
      for (const declaration of declarations) {
        const nameNode = firstOfType(declaration, NAME);
        if (nameNode === null) continue;
        const annotated = typeNameOf(declaration.namedChild(1));
        // Only a single-name binding can take its type from the initialiser: `val (a, b) = p`
        // destructures, and pinning both names to the pair's type would be a guess.
        const inferred = declarations.length === 1 ? typeOfInitialiser(initialiser) : null;
        bind(types, nameNode.text, annotated ?? inferred);
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null) visit(child);
    }
  };
  visit(owner);
  return types;
}

/**
 * Callee text, normalised the way `CallSite.callee` fixes it. Anything else - a deeper chain,
 * a call on a call result, a `super` call, a receiver this file cannot type - is not recorded
 * at all: recording it and hoping the resolver drops it is how a wrong `high` edge gets out.
 */
function calleeText(node: Node, ctx: CallContext): string | null {
  const callee = node.namedChild(0);
  if (callee === null) return null;
  if (callee.type === NAME) return callee.text;
  if (callee.type !== "navigation_expression") return null;

  const value = callee.namedChild(0);
  const suffix = firstOfType(callee, "navigation_suffix");
  if (value === null || suffix === null) return null;
  const member = firstOfType(suffix, NAME);
  if (member === null) return null;

  if (value.type === "this_expression") return `this.${member.text}`;
  // A literal receiver: `"x".shout()` is `String.shout`, the name the compiler gives it.
  const literal = LITERAL_TYPES[value.type];
  if (literal !== undefined) return `${literal}.${member.text}`;
  if (value.type !== NAME) return null;

  // A local this file can type becomes `<Type>.m`, so an extension call and a method call
  // resolve through one rule; a local it cannot type is dropped; a name that is not a local
  // at all is a type, an object or a companion, and is kept as written.
  if (ctx.types.has(value.text)) {
    const type = ctx.types.get(value.text) ?? null;
    return type === null ? null : `${type}.${member.text}`;
  }
  return `${value.text}.${member.text}`;
}

function collectCalls(state: KotlinState, root: Node, ctx: CallContext): void {
  const visit = (node: Node): void => {
    if (node.type === "call_expression") {
      const callee = calleeText(node, ctx);
      if (callee !== null) state.calls.push({ caller: ctx.caller, callee, line: lineOf(node) });
    }
    for (const child of node.namedChildren) {
      if (child !== null) visit(child);
    }
  };
  visit(root);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/** Everything one `.kt` file says about itself. `lang` is always `"kotlin"`. */
export function extractKotlin(
  path: string,
  _lang: Lang,
  source: string,
  tree: Tree,
): Pick<FileRecord, "decls" | "imports" | "exports" | "calls"> {
  const state: KotlinState = {
    path,
    source,
    decls: [],
    imports: [],
    exports: [],
    calls: [],
    usedIds: new Set<string>(),
    exported: new Set<string>(),
    jvmName: null,
    packageName: "",
  };

  state.jvmName = fileJvmName(tree.rootNode);
  state.packageName = filePackage(tree.rootNode);
  collectImports(state, tree.rootNode);
  collectContainer(state, tree.rootNode, FILE_SCOPE);

  return { decls: state.decls, imports: state.imports, exports: state.exports, calls: state.calls };
}
