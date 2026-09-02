/**
 * Reading text and positions off a tree-sitter node, and building the `signature`
 * field of a Declaration: the header as written, without the body.
 *
 * Every helper here is pure: it takes the source text and a node and returns a
 * string or a number. Shared by the declaration, import/export and call modules.
 */

import type { Node } from "web-tree-sitter";

/** Signatures longer than this are clipped to 199 characters plus an ellipsis. */
export const MAX_SIGNATURE = 200;

/** Initialisers that make a binding a callable declaration. */
export const FUNCTION_VALUES: ReadonlySet<string> = new Set([
  "arrow_function",
  "function_expression",
  "generator_function",
]);

/** Initialisers whose body is cut out of a signature (functions plus class expressions). */
export const BODY_VALUES: ReadonlySet<string> = new Set([...FUNCTION_VALUES, "class"]);

export function field(node: Node, name: string): Node | null {
  return node.childForFieldName(name);
}

export function nameOf(node: Node): string | null {
  const name = field(node, "name");
  return name === null ? null : name.text;
}

export function childOfType(node: Node, type: string): Node | null {
  for (const child of node.children) if (child.type === type) return child;
  return null;
}

/** 1-based start row. */
export function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

/** 1-based inclusive [start, end] rows. */
export function spanOf(node: Node): [number, number] {
  return [node.startPosition.row + 1, node.endPosition.row + 1];
}

/** Text of a string literal without its quotes. */
export function stringOf(node: Node): string {
  const text = node.text;
  const quote = text[0];
  if (text.length >= 2 && (quote === '"' || quote === "'" || quote === "`") && text.endsWith(quote)) {
    return text.slice(1, -1);
  }
  const fragment = childOfType(node, "string_fragment");
  return fragment === null ? text : fragment.text;
}

/** Specifier names may be written as string literals (`export { a as "b" }`). */
export function specifierName(node: Node): string {
  return node.type === "string" ? stringOf(node) : node.text;
}

/** Collapse whitespace runs, drop a trailing `;`, clip to MAX_SIGNATURE. */
export function clip(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim().replace(/;$/u, "").trim();
  return flat.length > MAX_SIGNATURE ? `${flat.slice(0, MAX_SIGNATURE - 1)}…` : flat;
}

/** `source.slice(start, end)` with the given ranges removed. */
export function sliceExcluding(
  source: string,
  start: number,
  end: number,
  cuts: ReadonlyArray<readonly [number, number]>,
): string {
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
 * Ranges of the leading decorators of the given nodes. A decorator says nothing
 * about the shape of a symbol and would otherwise eat the whole 200-char budget.
 */
export function decoratorCuts(...owners: ReadonlyArray<Node | null>): Array<[number, number]> {
  const cuts: Array<[number, number]> = [];
  for (const owner of owners) {
    if (owner === null) continue;
    for (const child of owner.children) {
      if (child.type === "decorator") cuts.push([child.startIndex, child.endIndex]);
      else if (child.type !== "comment") break;
    }
  }
  return cuts;
}

/**
 * Header of a declaration that has a `body` field: from the outermost node (so a
 * leading `export` / `export default` / `declare` is kept) to the byte before the
 * body. Nodes without a body (type aliases, ambient and overload signatures) use
 * their whole text.
 */
export function signatureText(source: string, node: Node, outer: Node): string {
  const body = field(node, "body");
  const end = body === null ? outer.endIndex : body.startIndex;
  const cuts = decoratorCuts(outer, node === outer ? null : node);
  return clip(sliceExcluding(source, outer.startIndex, Math.max(end, outer.startIndex), cuts));
}

/**
 * Wrappers a function initialiser can hide behind. `<T>(x) => x` is parsed as the
 * legacy `<T>expr` type assertion by the TypeScript grammar, which is why a generic
 * arrow has to be unwrapped before it is recognised as a function at all.
 */
const INITIALISER_WRAPPERS: ReadonlySet<string> = new Set([
  "type_assertion",
  "as_expression",
  "satisfies_expression",
  "parenthesized_expression",
  "non_null_expression",
]);

/** The expression inside any number of casts, parens and assertions. */
export function unwrapValue(node: Node): Node {
  let current = node;
  for (let guard = 0; guard < 8 && INITIALISER_WRAPPERS.has(current.type); guard += 1) {
    // `type_assertion` is `<T>expr`, so its expression is last; every other wrapper
    // carries its expression first.
    const children = current.namedChildren;
    const inner = current.type === "type_assertion" ? children[children.length - 1] : children[0];
    if (inner === undefined) return current;
    current = inner;
  }
  return current;
}

/** The function a binding is initialised with, looking through casts and parens. */
export function functionValue(node: Node): Node | null {
  const value = field(node, "value");
  if (value === null) return null;
  const inner = unwrapValue(value);
  return FUNCTION_VALUES.has(inner.type) ? inner : null;
}

/** Where a value-bearing node's signature stops: before a function or class body. */
export function bodyCut(node: Node): number {
  const value = field(node, "value");
  if (value !== null) {
    const inner = unwrapValue(value);
    if (BODY_VALUES.has(inner.type)) {
      const body = field(inner, "body");
      if (body !== null) return body.startIndex;
    }
  }
  return node.endIndex;
}

/**
 * Header of a binding written as `name = initialiser`, cut before the initialiser's
 * body: `export const f = (x: number) =>`, `handle = () =>`, `const C = class`.
 * `prefix` carries the keywords that live on the enclosing declaration list.
 */
export function initialiserSignature(source: string, node: Node, prefix: string): string {
  const cuts = decoratorCuts(node);
  return clip(prefix + sliceExcluding(source, node.startIndex, bodyCut(node), cuts));
}

/**
 * `export const a = 1, b = 2` gives each declarator its own `export const b = 2`
 * header: the keywords come from the declaration, the rest from the declarator.
 */
export function variableSignature(source: string, outer: Node, list: Node, declarator: Node): string {
  const first = childOfType(list, "variable_declarator");
  const prefixEnd = first === null ? list.endIndex : first.startIndex;
  const prefix = sliceExcluding(source, outer.startIndex, Math.max(prefixEnd, outer.startIndex), []);
  return initialiserSignature(source, declarator, prefix);
}
