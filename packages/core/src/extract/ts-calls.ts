/**
 * Call sites (tech spec 5.1). Every `call_expression` and `new_expression` in the
 * file is either named by one of the shapes below or dropped: a callee is never
 * guessed, because a wrong edge costs more than a missing one.
 */

import type { Node } from "web-tree-sitter";
import type { TsContext } from "./ts.ts";
import { field, lineOf } from "./ts-signature.ts";
import { recordModuleCall } from "./ts-imports.ts";

/**
 * `a!.b()` and `foo!()` are the same call as `a.b()` and `foo()`; the assertion is
 * erased at compile time. `(x as any).y()` is not: the cast can change the target,
 * so it stays dropped.
 */
function unwrapAssertion(node: Node): Node {
  let current = node;
  while (current.type === "non_null_expression") {
    const inner = current.namedChildren[0];
    if (inner === undefined) return current;
    current = inner;
  }
  return current;
}

export function recordCall(ctx: TsContext, node: Node, caller: string): void {
  if (node.type === "new_expression") {
    const target = field(node, "constructor");
    if (target === null) return;
    const callee = calleeText(target, "new ");
    if (callee !== null) ctx.calls.push({ caller, callee, line: lineOf(node) });
    return;
  }

  const fn = field(node, "function");
  if (fn === null) return;
  if (fn.type === "import") {
    recordModuleCall(ctx, node, "dynamic");
    return;
  }
  if (fn.type === "identifier" && fn.text === "require") {
    recordModuleCall(ctx, node, "require");
    return;
  }
  const callee = calleeText(fn, "");
  if (callee !== null) ctx.calls.push({ caller, callee, line: lineOf(node) });
}

/**
 * `foo` -> `foo`, `obj.m` -> `obj.m`, `this.m` -> `this.m`, with `new ` prefixed for
 * constructors. Deeper chains, computed members, calls on call results and calls on
 * parenthesised, cast or awaited expressions have no stable name and return null.
 */
export function calleeText(target: Node, prefix: string): string | null {
  const fn = unwrapAssertion(target);
  if (fn.type === "identifier") return `${prefix}${fn.text}`;
  if (fn.type !== "member_expression") return null;
  const property = field(fn, "property");
  if (property === null || property.type !== "property_identifier") return null;
  const objectNode = field(fn, "object");
  if (objectNode === null) return null;
  // Optional chains (`a?.b()`) read like plain members.
  const object = unwrapAssertion(objectNode);
  if (object.type === "identifier") return `${prefix}${object.text}.${property.text}`;
  if (object.type === "this") return `${prefix}this.${property.text}`;
  return null;
}
