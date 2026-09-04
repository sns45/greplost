/**
 * Terraform (HCL) extraction (build 2, spec 2026-09-04 section 2.2).
 *
 * Terraform is the first language whose graph is made of *references* rather than calls: a
 * `.tf` file declares blocks, and the edges between them are expressions naming other blocks.
 * So this module produces no `CallSite` at all (S3 is `n/a` for HCL, never 0) and instead fills
 * `FileRecord.refs` with the raw address text of every expression that names something.
 *
 * Three kinds of output, and the rules that decide each:
 *
 *  - **Declarations.** One node per top-level block, by its first label. `resource`/`data` need
 *    exactly two labels and every other block exactly one; a block with the wrong number is not
 *    a node, because guessing which label is the name is how a wrong id gets into the map.
 *    `locals` is the exception: it yields one `local` node per attribute, named after the
 *    attribute, so its id is `<file>#local.<name>`. `terraform` yields a single `const` named
 *    `terraform` — it is a settings block, not a thing anything can address, so it is a symbol
 *    and not a node (which is what keeps `splitNodeId` from having to read `<file>#terraform`).
 *  - **Imports.** Only a `module` block imports, and its specifier is the `source` string as
 *    written. `resolve/hcl.ts` turns that into a directory id or an `ext:module/<source>`.
 *  - **References.** Every address chain inside an attribute value (`var.x`, `local.y`,
 *    `module.m.o`, `data.t.n.attr`, `<type>.<name>.attr`) is recorded with its raw text.
 *    `each.*`, `count.*`, `self.*`, `path.*` and `terraform.*` are Terraform's own symbols and
 *    are ignored; a name bound by a `for` expression or by a `dynamic` block shadows anything
 *    it could otherwise be mistaken for and is ignored too. Nothing is resolved here:
 *    `references/hcl.ts` maps an address onto the one node it can mean, or drops it.
 *
 * Nothing in this file reads the filesystem or knows about another file (tech spec 5.1).
 */

import type { Node, Tree } from "web-tree-sitter";
import type {
  DeclKind,
  Declaration,
  ExportRecord,
  FileRecord,
  ImportRecord,
  Lang,
  ReferenceRecord,
} from "../schema.ts";
import { compareStrings, nodeId, symbolId } from "../schema.ts";
import { clip, lineOf, spanOf } from "./ts-signature.ts";

/** Top-level block types that become a node, and the `DeclKind` each one takes. */
const BLOCK_KIND: Readonly<Record<string, DeclKind>> = {
  data: "data",
  module: "module",
  output: "output",
  provider: "provider",
  resource: "resource",
  variable: "variable",
};

/** Block types whose name is `<type>.<name>`, and which therefore need exactly two labels. */
const TWO_LABEL_BLOCKS: ReadonlySet<string> = new Set(["data", "resource"]);

/** Blocks whose declarations are a module's public surface (spec 2.2, `exported`). */
const EXPORTED_KINDS: ReadonlySet<DeclKind> = new Set<DeclKind>(["output", "variable"]);

/**
 * Address heads that are Terraform's own symbols rather than a reference to a block.
 *
 * `each` and `count` are the repetition symbols the spec names explicitly; `self` is only
 * meaningful inside a provisioner; `path` and `terraform` are constants. None of them can ever
 * name a node, so recording them would only give `references/hcl.ts` something to drop.
 */
const IGNORED_HEADS: ReadonlySet<string> = new Set(["count", "each", "path", "self", "terraform"]);

/** The one meta-argument that names a provider configuration rather than an expression value. */
const PROVIDER_ARGUMENT = "provider";

/**
 * Prefix marking a reference to a *provider requirement* rather than to an address.
 *
 * `terraform.required_providers` entries become `ext:provider/<name>` (spec 2.2, "Resolution"),
 * and a bare `<name>` would be indistinguishable from the implicit-provider reference a
 * resource makes. `/` cannot occur in an HCL address, so the sentinel can never collide with
 * one; `references/hcl.ts` is the only reader.
 */
export const REQUIRED_PROVIDER_PREFIX = "provider/";

// ---------------------------------------------------------------------------
// tree helpers
// ---------------------------------------------------------------------------

function childOfType(node: Node, type: string): Node | null {
  for (const child of node.children) if (child.type === type) return child;
  return null;
}

function namedChildrenOfType(node: Node, type: string): Node[] {
  return node.namedChildren.filter((child) => child.type === type);
}

/**
 * The text of a block label or of a quoted string, or null when it is not a plain string.
 *
 * A label built from an interpolation (`"${var.x}"`) has no single text and is refused rather
 * than reduced to the literal parts around the hole.
 */
function plainString(node: Node): string | null {
  if (node.type === "identifier") return node.text;
  if (node.type !== "string_lit") return null;
  let text: string | null = null;
  for (const child of node.children) {
    if (child.type === "quoted_template_start" || child.type === "quoted_template_end") continue;
    if (child.type !== "template_literal") return null;
    if (text !== null) return null;
    text = child.text;
  }
  return text ?? "";
}

/** The block's type keyword (`resource`, `variable`, …). */
function blockType(block: Node): string | null {
  const identifier = childOfType(block, "identifier");
  return identifier === null ? null : identifier.text;
}

/**
 * A label that can be part of a node id.
 *
 * `nodeId` throws on `#`, a newline or NUL (spec 0.2, "Name characters"), and an extractor that
 * threw would fail the *whole build* over one file: HCL's grammar happily parses
 * `resource "aws_s3_bucket" "a#b"` even though Terraform would reject the name. Such a block is
 * simply not a node, which is the same answer a block with the wrong number of labels gets.
 */
function usableLabel(text: string): boolean {
  return text !== "" && !/[#\n\0]/.test(text);
}

/** Every label of a block, or null when one of them cannot be part of a node id. */
function blockLabels(block: Node): string[] | null {
  const labels: string[] = [];
  let seenType = false;
  for (const child of block.children) {
    if (child.type === "block_start") break;
    if (!seenType) {
      if (child.type === "identifier") seenType = true;
      continue;
    }
    const text = plainString(child);
    if (text === null || !usableLabel(text)) return null;
    labels.push(text);
  }
  return labels;
}

/** The block header as written: everything before the opening brace (spec 2.2, `signature`). */
function blockSignature(source: string, block: Node): string {
  const start = childOfType(block, "block_start");
  const end = start === null ? block.endIndex : start.startIndex;
  return clip(source.slice(block.startIndex, Math.max(end, block.startIndex)));
}

/** The block's `body`, or null for an empty block (`data "t" "n" {}`). */
function bodyOf(block: Node): Node | null {
  return childOfType(block, "body");
}

/** An attribute's name identifier and value expression, or null when either is missing. */
function attributeParts(attribute: Node): { name: string; value: Node } | null {
  const name = childOfType(attribute, "identifier");
  const value = childOfType(attribute, "expression");
  if (name === null || value === null) return null;
  return { name: name.text, value };
}

/** Attributes of a body, in source order. */
function attributesOf(body: Node | null): Node[] {
  return body === null ? [] : namedChildrenOfType(body, "attribute");
}

/** Nested blocks of a body, in source order. */
function blocksOf(body: Node | null): Node[] {
  return body === null ? [] : namedChildrenOfType(body, "block");
}

/** The named attribute's value expression, or null. */
function attributeValue(body: Node | null, name: string): Node | null {
  for (const attribute of attributesOf(body)) {
    const parts = attributeParts(attribute);
    if (parts !== null && parts.name === name) return parts.value;
  }
  return null;
}

/**
 * A scalar literal's text, or null when the expression is anything else.
 *
 * "A literal" is a scalar (`literal_value`): a string with no interpolation, a number, a
 * boolean or `null`. A collection, a function call and an interpolated string are all values
 * that only Terraform can evaluate, and `meta` may not carry a guess at one.
 */
function literalScalar(expression: Node | null): string | null {
  if (expression === null || expression.namedChildCount !== 1) return null;
  const value = expression.namedChild(0);
  if (value === null) return null;
  // A negated number is a unary operation over a numeric literal, not a `literal_value`. It is
  // still as much a literal as `1` is, and `default = -1` is ordinary in a Terraform module.
  if (value.type === "operation") return negatedNumber(value);
  if (value.type !== "literal_value") return null;
  const inner = value.namedChild(0);
  if (inner === null) return null;
  if (inner.type === "string_lit") return plainString(inner);
  return inner.text;
}

/** `-1` / `-1.5` written as a unary operation, or null for any other operation. */
function negatedNumber(operation: Node): string | null {
  const unary = operation.namedChild(0);
  if (unary === null || unary.type !== "unary_operation" || operation.namedChildCount !== 1) return null;
  const minus = childOfType(unary, "-");
  if (minus === null) return null;
  const operand = unary.namedChild(0);
  if (operand === null || operand.type !== "literal_value" || unary.namedChildCount !== 1) return null;
  const numeric = childOfType(operand, "numeric_lit");
  return numeric === null ? null : `-${numeric.text}`;
}

/** The named attribute as a scalar literal, or null. */
function literalAttribute(body: Node | null, name: string): string | null {
  return literalScalar(attributeValue(body, name));
}

/** Terraform's own rule: the provider local name is the resource type up to the first `_`. */
function providerOfType(type: string): string {
  const underscore = type.indexOf("_");
  return underscore === -1 ? type : type.slice(0, underscore);
}

/** `meta` with sorted keys, or undefined when nothing was recorded. */
function metaOf(entries: ReadonlyArray<readonly [string, string | null]>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of [...entries].sort((a, b) => compareStrings(a[0], b[0]))) {
    if (value !== null) out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

// ---------------------------------------------------------------------------
// address chains
// ---------------------------------------------------------------------------

/**
 * The dotted address that starts at a `variable_expr`, or null when it is a bare name.
 *
 * `aws_vpc.main.id` is a `variable_expr` followed by two `get_attr` siblings. The walk is over
 * *siblings* rather than over one parent's children because the parent is not always the same
 * node: `local.a && local.b` puts both chains directly under one `binary_operation`, with no
 * `expression` wrapper around either, and reading only `expression` nodes misses every operand
 * of every operator (measured on terraform-aws-vpc: 221 real references).
 *
 * The chain stops at the first step that is not an attribute — `data.x.y.names[0]` is the
 * address `data.x.y.names`, and `aws_vpc.main[*].id` is `aws_vpc.main` — and at the start of
 * the next chain, since a chain always begins with its own `variable_expr`.
 *
 * A single segment is not an address: `string` in `type = string` and a bare object key are
 * both one identifier and neither names a block.
 */
function addressFrom(head: Node): { text: string; head: string } | null {
  const identifier = childOfType(head, "identifier");
  if (identifier === null) return null;
  const segments = [identifier.text];
  let sibling = head.nextNamedSibling;
  while (sibling !== null && sibling.type === "get_attr") {
    const name = childOfType(sibling, "identifier");
    if (name === null) break;
    segments.push(name.text);
    sibling = sibling.nextNamedSibling;
  }
  if (segments.length < 2) return null;
  return { text: segments.join("."), head: segments[0] as string };
}

/** The address an expression *opens* with, for the `provider =` meta-argument. */
function addressOf(expression: Node): { text: string; head: string } | null {
  const first = expression.namedChild(0);
  if (first === null || first.type !== "variable_expr") return null;
  return addressFrom(first);
}

/** Nodes that open a `for` expression's scope; each holds the `for_intro` that binds names. */
const FOR_NODES: ReadonlySet<string> = new Set(["for_expr", "for_object_expr", "for_tuple_expr"]);

/**
 * Names a `for` expression or a `dynamic` block binds, which shadow everything else.
 *
 * `[for k, v in var.x : v.name]` binds `k` and `v`, and `dynamic "ingress" { content { ...
 * ingress.value ... } }` binds `ingress`. Both produce two-segment chains that look exactly
 * like a managed resource address, so a bound name is dropped at the point it is written
 * rather than left for the linker to be lucky about (the same rule Go's extractor applies to
 * a locally bound callee).
 */
function forBindings(node: Node): string[] {
  const names: string[] = [];
  const intro = childOfType(node, "for_intro") ?? node;
  for (const child of intro.children) {
    if (child.type === "identifier") names.push(child.text);
    if (child.type === "in") break;
  }
  return names;
}

// ---------------------------------------------------------------------------
// accumulator
// ---------------------------------------------------------------------------

interface HclState {
  readonly path: string;
  readonly source: string;
  readonly decls: Declaration[];
  readonly imports: ImportRecord[];
  readonly exports: ExportRecord[];
  readonly refs: ReferenceRecord[];
  /** Declaration ids already used in this file, so a duplicate name can take a `~<n>` suffix. */
  readonly usedIds: Set<string>;
}

/**
 * A node name made unique within the file: `aws`, then `aws~2`, then `aws~3`.
 *
 * `~` rather than the `#<index>` spec 0.2 sketches, because `nodeId` refuses `#` in a name
 * (driver ruling 2026-09-04) and `~` cannot occur in a Terraform identifier, so a suffixed
 * name can never be mistaken for one somebody wrote.
 */
function uniqueName(state: HclState, kind: DeclKind, name: string, isNode: boolean): string {
  const idFor = (candidate: string): string =>
    isNode ? nodeId(state.path, kind, candidate) : symbolId(state.path, candidate);
  if (!state.usedIds.has(idFor(name))) {
    state.usedIds.add(idFor(name));
    return name;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${name}~${n}`;
    const id = idFor(candidate);
    if (state.usedIds.has(id)) continue;
    state.usedIds.add(id);
    return candidate;
  }
}

function addDeclaration(
  state: HclState,
  kind: DeclKind,
  rawName: string,
  signature: string,
  node: Node,
  meta: Record<string, string> | undefined,
): Declaration {
  const isNode = kind !== "const";
  const name = uniqueName(state, kind, rawName, isNode);
  const exported = EXPORTED_KINDS.has(kind);
  const declaration: Declaration = {
    id: isNode ? nodeId(state.path, kind, name) : symbolId(state.path, name),
    file: state.path,
    name,
    kind,
    signature,
    exported,
    span: spanOf(node),
    ...(meta === undefined ? {} : { meta }),
  };
  state.decls.push(declaration);
  if (exported) state.exports.push({ name, kind: "named" });
  return declaration;
}

function addReference(state: HclState, from: string, to: string, line: number): void {
  state.refs.push({ from, to, refKind: "hcl-ref", line });
}

// ---------------------------------------------------------------------------
// expression walk
// ---------------------------------------------------------------------------

/**
 * Every address inside one expression, attributed to `owner`.
 *
 * `bound` carries the names a `for` expression or a `dynamic` block put in scope. An address is
 * found at its head — a `variable_expr` — wherever that head sits, so an operand of an operator
 * and a value inside a template, a tuple, an object or a function call are all reached the same
 * way and none of them needs its own case.
 */
function walkExpression(state: HclState, owner: string, node: Node, bound: ReadonlySet<string>): void {
  let scope = bound;
  if (FOR_NODES.has(node.type)) {
    const names = forBindings(node);
    if (names.length > 0) scope = new Set([...bound, ...names]);
  }

  if (node.type === "variable_expr") {
    const address = addressFrom(node);
    if (address !== null && !IGNORED_HEADS.has(address.head) && !scope.has(address.head)) {
      addReference(state, owner, address.text, lineOf(node));
    }
    // A `variable_expr` holds only its head identifier; the rest of the chain is its siblings,
    // which the loop below reaches from the parent and which start no address of their own.
    return;
  }

  // Object keys need no special case, and must not get one. HCL reads a bare identifier key as
  // a literal name (`{ Env = "dev" }` references nothing), which falls out of the rule that an
  // address needs at least two segments; but an interpolated key (`{ "${local.region}a" = … }`)
  // *is* evaluated and does reference what it names. Skipping every key lost exactly those.
  for (const child of node.namedChildren) walkExpression(state, owner, child, scope);
}

/**
 * Every reference inside a block body, attributed to the node the block declared.
 *
 * Nested blocks are walked too — a `dynamic`, `lifecycle` or `provisioner` block belongs to the
 * resource that contains it — with any name the nested block binds added to the scope.
 */
function walkBody(
  state: HclState,
  owner: string,
  body: Node | null,
  bound: ReadonlySet<string>,
  topLevel: boolean,
): void {
  if (body === null) return;
  for (const attribute of attributesOf(body)) {
    const parts = attributeParts(attribute);
    if (parts === null) continue;
    // The `provider` meta-argument names a provider *configuration*, and it is handled by the
    // caller so that a resource without one still records its implicit provider. It is a
    // meta-argument only at the top level of a block: an attribute called `provider` inside a
    // nested block is an ordinary argument, and skipping those lost every reference in them.
    if (topLevel && parts.name === PROVIDER_ARGUMENT) continue;
    walkExpression(state, owner, parts.value, bound);
  }
  for (const block of blocksOf(body)) {
    if (blockType(block) === "dynamic") {
      walkDynamicBlock(state, owner, block, bound);
      continue;
    }
    walkBody(state, owner, bodyOf(block), bound, false);
  }
}

/**
 * A `dynamic` block, whose iterator is bound to *part* of its own body.
 *
 * Terraform's rules, and both matter for precision and for recall:
 *
 *  - the bound name is the `iterator` argument when there is one, and the block's label
 *    otherwise. `dynamic "rule" { iterator = ing … }` binds `ing`, and leaves `rule` free;
 *  - `for_each` (and `iterator` itself) are evaluated in the **parent** scope, so the binding
 *    must not reach them. `dynamic "aws_lb" { for_each = aws_lb.main.subnets }` really does
 *    name the resource `aws_lb.main`, and binding the label over the whole block hid it.
 *
 * `content` and any further nested block see the binding, which is what stops `ing.value` from
 * being read as a managed resource address.
 */
function walkDynamicBlock(state: HclState, owner: string, block: Node, bound: ReadonlySet<string>): void {
  const body = bodyOf(block);
  const labels = blockLabels(block);
  const iterator = bareIdentifier(attributeValue(body, "iterator")) ?? (labels === null ? undefined : labels[0]);
  const inner = iterator === undefined || iterator === "" ? bound : new Set([...bound, iterator]);

  for (const attribute of attributesOf(body)) {
    const parts = attributeParts(attribute);
    if (parts === null) continue;
    // `iterator` names the binding; it is not an expression that references anything.
    if (parts.name === "iterator") continue;
    walkExpression(state, owner, parts.value, parts.name === "for_each" ? bound : inner);
  }
  for (const nested of blocksOf(body)) {
    if (blockType(nested) === "dynamic") {
      walkDynamicBlock(state, owner, nested, inner);
      continue;
    }
    walkBody(state, owner, bodyOf(nested), inner, false);
  }
}

/** A bare `name` expression (the shape `iterator = ing` takes), or null. */
function bareIdentifier(expression: Node | null): string | null {
  if (expression === null || expression.namedChildCount !== 1) return null;
  const head = expression.namedChild(0);
  if (head === null || head.type !== "variable_expr") return null;
  const identifier = childOfType(head, "identifier");
  return identifier === null ? null : identifier.text;
}

// ---------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------

const NO_BINDINGS: ReadonlySet<string> = new Set<string>();

function collectLocals(state: HclState, block: Node): void {
  for (const attribute of attributesOf(bodyOf(block))) {
    const parts = attributeParts(attribute);
    if (parts === null) continue;
    // A `locals` entry is a node of kind `local` named after the attribute, so its id is
    // `<file>#local.<name>` through `nodeId` — byte-identical to the id the `const`-with-a-
    // dotted-name form produced, but one that `splitNodeId` can actually read back.
    const declaration = addDeclaration(
      state,
      "local",
      parts.name,
      clip(state.source.slice(attribute.startIndex, attribute.endIndex)),
      attribute,
      undefined,
    );
    walkExpression(state, `local.${declaration.name}`, parts.value, NO_BINDINGS);
  }
}

function collectTerraform(state: HclState, block: Node): void {
  const body = bodyOf(block);
  const declaration = addDeclaration(
    state,
    "const",
    "terraform",
    blockSignature(state.source, block),
    block,
    metaOf([["required_version", literalAttribute(body, "required_version")]]),
  );
  // `required_providers` entries are provider *requirements*, not addresses: each becomes
  // `ext:provider/<name>` (spec 2.2), so it is marked with the sentinel prefix here.
  for (const nested of blocksOf(body)) {
    if (blockType(nested) !== "required_providers") continue;
    for (const attribute of attributesOf(bodyOf(nested))) {
      const parts = attributeParts(attribute);
      if (parts === null) continue;
      addReference(
        state,
        declaration.name,
        `${REQUIRED_PROVIDER_PREFIX}${parts.name}`,
        lineOf(attribute),
      );
    }
  }
}

function metaForBlock(type: string, labels: readonly string[], body: Node | null): Record<string, string> | undefined {
  switch (type) {
    case "resource":
    case "data": {
      const resourceType = labels[0] as string;
      return metaOf([
        ["type", resourceType],
        ["provider", providerOfType(resourceType)],
      ]);
    }
    case "variable": {
      const typeExpression = attributeValue(body, "type");
      return metaOf([
        ["type", typeExpression === null ? null : clip(typeExpression.text)],
        ["default", literalAttribute(body, "default")],
        ["sensitive", literalAttribute(body, "sensitive")],
      ]);
    }
    case "output":
      return metaOf([["sensitive", literalAttribute(body, "sensitive")]]);
    case "provider":
      return metaOf([["alias", literalAttribute(body, "alias")]]);
    case "module":
      return metaOf([
        ["source", literalAttribute(body, "source")],
        ["version", literalAttribute(body, "version")],
      ]);
    default:
      return undefined;
  }
}

function collectBlock(state: HclState, block: Node): void {
  const type = blockType(block);
  if (type === null) return;

  const labels = blockLabels(block);
  if (labels === null) return;

  if (type === "locals") {
    if (labels.length === 0) collectLocals(state, block);
    return;
  }
  if (type === "terraform") {
    if (labels.length === 0) collectTerraform(state, block);
    return;
  }

  const kind = BLOCK_KIND[type];
  if (kind === undefined) return;

  // Exactly two labels for `resource`/`data`, exactly one for everything else. A block with
  // any other count is not a node: which label is the name would be a guess.
  const wanted = TWO_LABEL_BLOCKS.has(type) ? 2 : 1;
  if (labels.length !== wanted) return;
  const name = wanted === 2 ? `${labels[0] as string}.${labels[1] as string}` : (labels[0] as string);
  const body = bodyOf(block);
  const declaration = addDeclaration(
    state,
    kind,
    name,
    blockSignature(state.source, block),
    block,
    metaForBlock(type, labels, body),
  );
  const owner = `${kind}.${declaration.name}`;

  if (type === "module") {
    const source = literalAttribute(body, "source");
    if (source !== null && source !== "") {
      const sourceNode = attributeValue(body, "source") as Node;
      state.imports.push({
        specifier: source,
        kind: "static",
        symbols: [],
        reexport: false,
        line: lineOf(sourceNode),
      });
      // The module's own `uses` edge: the same specifier, resolved to the module directory or
      // to `ext:module/<source>` (spec 2.2, "References").
      state.refs.push({ from: owner, to: source, refKind: "uses", line: lineOf(sourceNode) });
    }
  }

  walkBody(state, owner, body, NO_BINDINGS, true);
  collectProviderArgument(state, type, labels, owner, block, body);
}

/**
 * The provider a resource or data source uses: the `provider =` meta-argument when it has one,
 * and otherwise the implicit configuration named by the type's prefix.
 *
 * The implicit form is recorded as a single-segment address, which is the one shape the
 * address walk never produces, so `references/hcl.ts` can tell the two apart. It resolves only
 * when exactly one `provider` block declares that name and carries no alias (spec 2.2).
 */
function collectProviderArgument(
  state: HclState,
  type: string,
  labels: readonly string[],
  owner: string,
  block: Node,
  body: Node | null,
): void {
  const explicit = attributeValue(body, PROVIDER_ARGUMENT);
  if (explicit !== null) {
    const address = addressOf(explicit);
    if (address !== null) {
      addReference(state, owner, address.text, lineOf(explicit));
      return;
    }
    const single = explicit.namedChild(0);
    const head = single === null || single.type !== "variable_expr" ? null : childOfType(single, "identifier");
    if (head !== null) addReference(state, owner, head.text, lineOf(explicit));
    return;
  }
  if (type !== "resource" && type !== "data") return;
  addReference(state, owner, providerOfType(labels[0] as string), lineOf(block));
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Everything one `.tf` file says about itself. `lang` is always `"hcl"`; it is part of the
 * signature so this module mirrors `extractGo` and `extractTs`.
 */
export function extractHcl(
  path: string,
  _lang: Lang,
  source: string,
  tree: Tree,
): Pick<FileRecord, "decls" | "imports" | "exports" | "calls" | "refs"> {
  const state: HclState = {
    path,
    source,
    decls: [],
    imports: [],
    exports: [],
    refs: [],
    usedIds: new Set<string>(),
  };

  const body = childOfType(tree.rootNode, "body") ?? tree.rootNode;
  for (const block of namedChildrenOfType(body, "block")) collectBlock(state, block);

  return {
    decls: state.decls,
    imports: state.imports,
    exports: state.exports,
    // HCL has no call edges at all (spec 2.2): S3 is `n/a` for every Terraform target.
    calls: [],
    refs: state.refs,
  };
}
