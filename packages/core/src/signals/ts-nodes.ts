/**
 * Shared tree walking for the four TypeScript signal passes (build 2, leaf 2.3).
 *
 * The passes in `signals/{react,tanstack,next,pulumi-ts}.ts` all need the same four things and
 * none of them belongs in a language extractor: the file's top-level bindings paired with the
 * tree node that declares them, a bounded descendant walk that stops at nested function scopes,
 * a resolver from a local identifier back to the import that bound it, and a name allocator
 * that keeps node ids unique inside one file. `extract/ts.ts` splits the same way
 * (`ts-imports.ts`, `ts-calls.ts`, `ts-signature.ts`), so this file is that split for signals.
 *
 * Nothing here reads the filesystem, the clock or the environment: a signal pass sees only its
 * `SignalInput` (spec 2026-09-04 section 3.1).
 */

import type { Node, Tree } from "web-tree-sitter";
import type { DeclKind, Declaration, ImportRecord } from "../schema.ts";
import { nodeId } from "../schema.ts";
import { clip, field, functionValue, spanOf, stringOf, unwrapValue } from "../extract/ts-signature.ts";

export { field, spanOf, stringOf, unwrapValue };

/** A top-level binding, paired with the nodes a signal rule needs to look at. */
export interface TopLevelBinding {
  /** The bound name, exactly as the language extractor's symbol path spells it. */
  name: string;
  /** The declaring node: `function_declaration`, `class_declaration` or `variable_declarator`. */
  node: Node;
  /** The statement the declaration is written in, including any `export` wrapper. */
  outer: Node;
  /** A variable declarator's initialiser with parens, casts and `as` looked through; else null. */
  value: Node | null;
  /** True when the binding is written with `export`. */
  exported: boolean;
}

const EXPORT_STATEMENT = "export_statement";
const VALUE_DECLARATIONS: ReadonlySet<string> = new Set(["lexical_declaration", "variable_declaration"]);

/**
 * The file's top-level bindings, in source order.
 *
 * Deliberately narrow: only the three forms a signal can attach to (a function, a class, or a
 * variable holding a value). Members, namespace contents and anything inside a function body
 * are not top-level bindings and are never signal nodes — a component is a module's export, not
 * a closure's local.
 */
export function topLevelBindings(tree: Tree): TopLevelBinding[] {
  const out: TopLevelBinding[] = [];
  for (const statement of tree.rootNode.namedChildren) {
    if (statement === null) continue;
    const exported = statement.type === EXPORT_STATEMENT;
    const inner = exported ? statement.namedChildren.filter((child) => child !== null) : [statement];
    for (const child of inner) {
      if (child === null) continue;
      collectBinding(child, statement, exported, out);
    }
  }
  return out;
}

function collectBinding(node: Node, outer: Node, exported: boolean, out: TopLevelBinding[]): void {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "class_declaration":
    case "abstract_class_declaration": {
      const name = field(node, "name");
      if (name !== null) out.push({ name: name.text, node, outer, value: null, exported });
      return;
    }
    // `export default function Page() {}` and `export default class {}`: the value is the
    // declaration itself and the extractor names it by its written name, or `default`.
    case "function":
    case "class": {
      const name = field(node, "name");
      out.push({ name: name === null ? "default" : name.text, node, outer, value: null, exported });
      return;
    }
    default:
      break;
  }
  if (!VALUE_DECLARATIONS.has(node.type)) return;
  for (const declarator of node.children) {
    if (declarator === null || declarator.type !== "variable_declarator") continue;
    const name = field(declarator, "name");
    // Destructuring binds names no symbol path can address; the extractor skips them too.
    if (name === null || name.type !== "identifier") continue;
    const value = field(declarator, "value");
    out.push({
      name: name.text,
      node: declarator,
      outer,
      value: value === null ? null : unwrapValue(value),
      exported,
    });
  }
}

/** Node types that open a function scope, for a walk that must not leave the declaration. */
const FUNCTION_SCOPES: ReadonlySet<string> = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "generator_function",
  "arrow_function",
  "method_definition",
  "class_static_block",
]);

/**
 * Every descendant of `root` (excluding `root`) in source order, visiting a node before its
 * children and stopping at whatever `stop` says.
 *
 * `stop` exists because "the body of this component" is not the same as "this subtree": a
 * component that declares a nested helper must not be credited with the helper's hooks or JSX.
 * The two stop rules the passes use are `stopAtNestedFunctions` and "never stop".
 */
export function walk(root: Node, visit: (node: Node) => void, stop?: (node: Node) => boolean): void {
  const descend = (node: Node): void => {
    for (const child of node.namedChildren) {
      if (child === null) continue;
      visit(child);
      if (stop !== undefined && stop(child)) continue;
      descend(child);
    }
  };
  descend(root);
}

/** A `stop` predicate for `walk`: do not descend into a nested function scope. */
export function stopAtNestedFunctions(node: Node): boolean {
  return FUNCTION_SCOPES.has(node.type);
}

/** The function body (or concise arrow body) a binding's value carries, or null. */
export function bodyOf(binding: TopLevelBinding): Node | null {
  if (binding.node.type === "variable_declarator") {
    const fn = functionValue(binding.node);
    if (fn === null) return null;
    return field(fn, "body") ?? null;
  }
  return field(binding.node, "body") ?? null;
}

/** The identifier a call expression calls, as written: `f`, `a.f`, `a.b.f`; null when computed. */
export function calleeText(call: Node): string | null {
  const callee = field(call, "function");
  if (callee === null) return null;
  return memberPath(callee);
}

/** `a.b.c` for an identifier/member chain, null when any link is computed or a call. */
export function memberPath(node: Node): string | null {
  if (node.type === "identifier" || node.type === "property_identifier" || node.type === "shorthand_property_identifier") {
    return node.text;
  }
  if (node.type === "member_expression") {
    const object = field(node, "object");
    const property = field(node, "property");
    if (object === null || property === null || property.type !== "property_identifier") return null;
    const head = memberPath(object);
    return head === null ? null : `${head}.${property.text}`;
  }
  return null;
}

/** What an import bound one local name to. */
export interface ImportBinding {
  /** The module specifier as written. */
  specifier: string;
  /** The exported name in that module: an identifier, `default`, or `*`. */
  name: string;
}

/**
 * Local binding name -> the import that bound it.
 *
 * Built from `SignalInput.base.imports` rather than from the tree: the language extractor has
 * already normalised every import form, and a signal pass that re-read the import statements
 * would be a second, differently-wrong parser of the same syntax.
 */
export function importBindings(imports: readonly ImportRecord[]): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>();
  for (const record of imports) {
    for (const symbol of record.symbols) {
      // First binding wins: a name bound twice in one file is not a name a rule may trust.
      if (!out.has(symbol.local)) out.set(symbol.local, { specifier: record.specifier, name: symbol.name });
    }
  }
  return out;
}

/**
 * Node names that stay unique inside one file.
 *
 * A duplicate takes a `~<n>` suffix counting from 2 (`resource.b`, `resource.b~2`). The spec's
 * `#<n>` form cannot be used: `nodeId` refuses a `#` in a name, because a `#` in an artifact
 * path is a URL fragment and every inbound link to the card would silently point elsewhere
 * (leaf 2.0 report, concern 1; driver ruling 2026-09-04).
 */
export class NameAllocator {
  private readonly used = new Map<string, number>();

  take(name: string): string {
    const seen = this.used.get(name);
    if (seen === undefined) {
      this.used.set(name, 1);
      return name;
    }
    const next = seen + 1;
    this.used.set(name, next);
    return `${name}~${next}`;
  }
}

/** Everything a signal node needs beyond its kind and name. */
export interface SignalNodeInput {
  path: string;
  kind: DeclKind;
  name: string;
  signature: string;
  span: [number, number];
  /** `meta.signal` is added here, so no pass can forget it. */
  signal: string;
  meta?: Record<string, string | undefined>;
}

/**
 * One signal node. `meta.signal` is stamped here and `undefined` values are dropped, so a
 * pass can write `{ props: propsTypeName(...) }` without branching on whether it found one.
 *
 * `exported` is always false, and that is a correctness rule rather than a default: a signal
 * node is a thing *inside* a module, never a name the module exports. `FileEntry.exports` is
 * built from declarations whose `exported` is true, so a `route./` marked exported would be
 * reported as an exported name of the file and scored as a false positive against the
 * compiler, which knows nothing about routes.
 */
export function signalNode(input: SignalNodeInput): Declaration {
  const meta: Record<string, string> = { signal: input.signal };
  for (const [key, value] of Object.entries(input.meta ?? {})) {
    if (value !== undefined) meta[key] = value;
  }
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(meta).sort()) sorted[key] = meta[key] as string;
  return {
    id: nodeId(input.path, input.kind, input.name),
    file: input.path,
    name: `${input.kind}.${input.name}`,
    kind: input.kind,
    signature: clip(input.signature),
    exported: false,
    span: input.span,
    meta: sorted,
  };
}
