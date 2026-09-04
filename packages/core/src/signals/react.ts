/**
 * React component signal pass (build 2, leaf 2.3; spec 2026-09-04 section 3.2).
 *
 * A declaration is a component when it is a top-level function, class or value binding, its
 * name starts with an upper-case letter, and either its body returns JSX or it is wrapped in
 * `React.memo` / `forwardRef`. It gains a `component.<Name>` node; the language declaration it
 * came from is untouched, and `meta.decl` names it so a card can link the two.
 *
 * `meta.hooks` is the sorted, comma-joined set of `use*` calls in the component's own body —
 * its own body, not its subtree: a component that declares a nested helper is not credited
 * with the helper's hooks. `meta.props` is the props type name when the signature names one.
 *
 * No reference edges: a component is a thing, not a link. The links that point *at* it are
 * emitted by the route passes (`route-handler`), which is where a router knows what it bound.
 */

import type { Node } from "web-tree-sitter";
import type { Declaration, Lang } from "../schema.ts";
import { compareStrings } from "../schema.ts";
import type { SignalInput, SignalOutput, SignalPass } from "./index.ts";
import {
  NameAllocator,
  bodyOf,
  calleeText,
  field,
  signalNode,
  spanOf,
  stopAtNestedFunctions,
  topLevelBindings,
  unwrapValue,
  walk,
} from "./ts-nodes.ts";
import type { TopLevelBinding } from "./ts-nodes.ts";
import { importBindings } from "./ts-nodes.ts";

const LANGS: ReadonlySet<Lang> = new Set<Lang>(["ts", "tsx", "js", "jsx"]);

/** The two wrappers the spec names. The property, not the whole path: `React.memo` and `memo`. */
const WRAPPERS: ReadonlySet<string> = new Set(["memo", "forwardRef"]);

/** JSX node types the grammar produces for an element in a return position. */
const JSX_TYPES: ReadonlySet<string> = new Set(["jsx_element", "jsx_self_closing_element", "jsx_fragment"]);

/**
 * `applies` is the spec's test, and it is deliberately cheap: a pass that returns false is
 * never handed the tree. A `.ts` file with no react import cannot hold a component whose JSX
 * the grammar would even parse.
 */
function applies(path: string, source: string): boolean {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return true;
  return source.includes('from "react"') || source.includes("from 'react'");
}

export const reactPass: SignalPass = {
  id: "react",
  langs: LANGS,
  applies,
  run(input: SignalInput): SignalOutput {
    const names = new NameAllocator();
    const imports = importBindings(input.base.imports);
    const decls: Declaration[] = [];

    for (const binding of topLevelBindings(input.tree)) {
      if (!/^[A-Z]/.test(binding.name)) continue;
      const body = componentBody(binding);
      const wrapped = isWrapped(binding, imports);
      if (!wrapped && (body === null || !returnsJsx(body))) continue;
      decls.push(
        signalNode({
          path: input.path,
          kind: "component",
          name: names.take(binding.name),
          signature: signatureOf(binding),
          span: spanOf(binding.outer),
          signal: "react",
          meta: {
            decl: binding.name,
            hooks: body === null ? "" : hooksIn(body),
            props: propsTypeName(binding),
          },
        }),
      );
    }

    return { decls, refs: [] };
  },
};

/**
 * The body whose JSX and hooks belong to this component.
 *
 * For a wrapped value that is the *wrapped function's* body, not the wrapper call's: the hooks
 * of `React.memo(function Card() { … })` are Card's.
 */
function componentBody(binding: TopLevelBinding): Node | null {
  if (binding.node.type !== "variable_declarator") {
    if (binding.node.type === "class_declaration" || binding.node.type === "abstract_class_declaration" || binding.node.type === "class") {
      return field(binding.node, "body");
    }
    return bodyOf(binding);
  }
  const direct = bodyOf(binding);
  if (direct !== null) return direct;
  const inner = wrappedFunction(binding.value);
  return inner === null ? null : (field(inner, "body") ?? null);
}

/** Look through `memo(forwardRef(fn))` for the function the wrappers are applied to. */
function wrappedFunction(value: Node | null): Node | null {
  let current = value;
  for (let guard = 0; guard < 4 && current !== null && current.type === "call_expression"; guard += 1) {
    const args = field(current, "arguments");
    if (args === null) return null;
    const first = args.namedChildren.find((child) => child !== null);
    if (first === undefined || first === null) return null;
    const inner = unwrapValue(first);
    if (inner.type === "arrow_function" || inner.type === "function_expression" || inner.type === "function") return inner;
    current = inner;
  }
  return null;
}

/** True when the binding's value is a `React.memo` / `forwardRef` call from react. */
function isWrapped(binding: TopLevelBinding, imports: ReadonlyMap<string, { specifier: string }>): boolean {
  const value = binding.value;
  if (value === null || value.type !== "call_expression") return false;
  const callee = calleeText(value);
  if (callee === null) return false;
  const parts = callee.split(".");
  const last = parts[parts.length - 1] as string;
  if (!WRAPPERS.has(last)) return false;
  const root = parts[0] as string;
  // `React.memo` is the namespace convention and needs no import record to be recognised;
  // a bare `memo` has to have come from react, or it is somebody else's function.
  if (parts.length > 1) return root === "React" || imports.get(root)?.specifier === "react";
  return imports.get(root)?.specifier === "react";
}

/**
 * True when `body` returns JSX.
 *
 * A concise arrow body that *is* JSX counts, and so does any `return` whose expression holds
 * JSX (`return cond ? <a/> : null`). Nested function scopes are not searched: a hook factory
 * that returns a render callback is not itself a component.
 */
function returnsJsx(body: Node): boolean {
  if (JSX_TYPES.has(body.type)) return true;
  if (body.type === "parenthesized_expression") {
    const inner = body.namedChildren.find((child) => child !== null);
    if (inner !== undefined && inner !== null && JSX_TYPES.has(inner.type)) return true;
  }
  // A class body: every method is a candidate, so the walk has to enter them.
  if (body.type === "class_body") {
    for (const member of body.namedChildren) {
      if (member === null || member.type !== "method_definition") continue;
      const methodBody = field(member, "body");
      if (methodBody !== null && returnsJsx(methodBody)) return true;
    }
    return false;
  }

  let found = false;
  walk(
    body,
    (node) => {
      if (found || node.type !== "return_statement") return;
      const value = node.namedChildren.find((child) => child !== null);
      if (value === undefined || value === null) return;
      if (holdsJsx(value)) found = true;
    },
    stopAtNestedFunctions,
  );
  return found;
}

/** JSX in a returned expression, without leaving it for a nested function scope. */
function holdsJsx(expression: Node): boolean {
  if (JSX_TYPES.has(expression.type)) return true;
  let found = false;
  walk(
    expression,
    (node) => {
      if (JSX_TYPES.has(node.type)) found = true;
    },
    stopAtNestedFunctions,
  );
  return found;
}

/** The sorted, comma-joined `use*` calls in `body`, deduplicated; "" when there are none. */
function hooksIn(body: Node): string {
  const hooks = new Set<string>();
  walk(
    body,
    (node) => {
      if (node.type !== "call_expression") return;
      const callee = calleeText(node);
      if (callee === null) return;
      const name = callee.slice(callee.lastIndexOf(".") + 1);
      if (name === "use" || /^use[A-Z]/.test(name)) hooks.add(name);
    },
    stopAtNestedFunctions,
  );
  return [...hooks].sort(compareStrings).join(",");
}

/** The first parameter's type name, when it is written as a plain type reference. */
function propsTypeName(binding: TopLevelBinding): string | undefined {
  const fn = functionNodeOf(binding);
  if (fn === null) return undefined;
  const parameters = field(fn, "parameters");
  if (parameters === null) return undefined;
  const first = parameters.namedChildren.find((child) => child !== null);
  if (first === undefined || first === null) return undefined;
  const annotation = field(first, "type");
  if (annotation === null) return undefined;
  const type = annotation.namedChildren.find((child) => child !== null);
  if (type === undefined || type === null) return undefined;
  if (type.type === "type_identifier") return type.text;
  // `props: Props<T>` still names `Props`; anything structural names nothing.
  if (type.type === "generic_type") {
    const name = field(type, "name");
    return name !== null && name.type === "type_identifier" ? name.text : undefined;
  }
  return undefined;
}

/** The function a binding's signature belongs to: the declaration itself, or its value. */
function functionNodeOf(binding: TopLevelBinding): Node | null {
  if (binding.node.type !== "variable_declarator") {
    return binding.node.type.includes("class") ? null : binding.node;
  }
  const value = binding.value;
  if (value === null) return null;
  if (value.type === "arrow_function" || value.type === "function_expression" || value.type === "function") return value;
  return wrappedFunction(value);
}

function signatureOf(binding: TopLevelBinding): string {
  const props = propsTypeName(binding);
  return props === undefined ? `component ${binding.name}` : `component ${binding.name}(props: ${props})`;
}
