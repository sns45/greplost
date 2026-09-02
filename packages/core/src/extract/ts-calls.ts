/**
 * Call sites (tech spec 5.1). Every `call_expression` and `new_expression` in the
 * file is either named by one of the shapes below or dropped: a callee is never
 * guessed, because a wrong edge costs more than a missing one.
 */

import type { Node } from "web-tree-sitter";
import type { TsContext } from "./ts.ts";
import { field } from "./ts-signature.ts";

/** A callee that can be named, plus the identifier it hangs off (null for `this`). */
export interface Callee {
  text: string;
  root: string | null;
}

/**
 * `a!.b()` and `foo!()` are the same call as `a.b()` and `foo()`; the assertion is
 * erased at compile time. `(x as any).y()` is not: the cast can change the target,
 * so it stays dropped.
 */
function unwrapAssertion(node: Node): Node {
  let current = node;
  for (let guard = 0; guard < 8 && current.type === "non_null_expression"; guard += 1) {
    const inner = current.namedChildren[0];
    if (inner === undefined) return current;
    current = inner;
  }
  return current;
}

export function recordCall(
  ctx: TsContext,
  node: Node,
  caller: string,
  locals: ReadonlySet<string> | null,
): void {
  let callee: Callee | null;
  if (node.type === "new_expression") {
    const target = field(node, "constructor");
    if (target === null) return;
    callee = calleeOf(target, "new ");
  } else {
    const fn = field(node, "function");
    if (fn === null) return;
    if (fn.type === "import") {
      ctx.recordModuleCall(node, "dynamic");
      return;
    }
    if (fn.type === "identifier" && fn.text === "require") {
      ctx.recordModuleCall(node, "require");
      return;
    }
    callee = calleeOf(fn, "");
  }
  if (callee === null) return;
  // A name bound inside the enclosing function is a local, and a local resolves to
  // no exported symbol: emitting it would invent an edge to a same-named top-level
  // declaration. Dropping is the conservative half of "never guess".
  if (callee.root !== null && locals !== null && locals.has(callee.root)) return;
  ctx.calls.push({ caller, callee: callee.text, line: ctx.line(node) });
}

/**
 * `foo` -> `foo`, `obj.m` -> `obj.m`, `this.m` -> `this.m`, with `new ` prefixed for
 * constructors. Deeper chains, computed members, calls on call results and calls on
 * parenthesised, cast or awaited expressions have no stable name and return null.
 */
export function calleeOf(target: Node, prefix: string): Callee | null {
  const fn = unwrapAssertion(target);
  if (fn.type === "identifier") return { text: `${prefix}${fn.text}`, root: fn.text };
  if (fn.type !== "member_expression") return null;
  const property = field(fn, "property");
  if (property === null || property.type !== "property_identifier") return null;
  const objectNode = field(fn, "object");
  if (objectNode === null) return null;
  // Optional chains (`a?.b()`) read like plain members.
  const object = unwrapAssertion(objectNode);
  if (object.type === "identifier") {
    return { text: `${prefix}${object.text}.${property.text}`, root: object.text };
  }
  if (object.type === "this") return { text: `${prefix}this.${property.text}`, root: null };
  return null;
}
