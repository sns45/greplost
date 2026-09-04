/**
 * TanStack Start route and loader signal pass (build 2, leaf 2.3; spec 2026-09-04 section 3.3).
 *
 * `createFileRoute("<path>")({ … })` gives a `route.<path>` node; `createRootRoute({ … })` and
 * its context-typed spelling `createRootRouteWithContext<C>()({ … })` give `route./`;
 * `createServerFileRoute("<path>")({ GET, POST })` gives a route with `meta.server = "1"` and
 * one `handler.<METHOD>` per method key. Inside the options object, `loader` and `beforeLoad`
 * give `handler.loader` / `handler.beforeLoad` nodes, and `component` gives a `route-handler`
 * reference to whatever identifier it names.
 *
 * **A computed path emits nothing at all** — not the route, not its handlers. A route greplost
 * cannot name is a route it must not pretend to have found, and half a route (the loaders with
 * no route to hang them on) would be worse than none.
 *
 * Confidence for the `route-handler` edge is the linker's call (`references/ts.ts`): this pass
 * records the identifier as written, because "resolves in the same file" is a question about
 * the build, not about this file.
 */

import type { Node } from "web-tree-sitter";
import type { Declaration, Lang, ReferenceRecord } from "../schema.ts";
import type { SignalInput, SignalOutput, SignalPass } from "./index.ts";
import {
  NameAllocator,
  calleeText,
  field,
  signalNode,
  spanOf,
  stringOf,
  unwrapValue,
  walk,
} from "./ts-nodes.ts";

const LANGS: ReadonlySet<Lang> = new Set<Lang>(["ts", "tsx", "js", "jsx"]);

/** Option keys that name a handler of their own. */
const HANDLER_KEYS: ReadonlySet<string> = new Set(["loader", "beforeLoad"]);
/** Option keys that bind a component, and so produce a `route-handler` reference. */
const COMPONENT_KEYS: ReadonlySet<string> = new Set(["component"]);
/** Method keys a server file route may carry. */
const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** The four creators, and what each one means. */
type Creator = "file" | "root" | "server";

const CREATORS: Readonly<Record<string, Creator>> = {
  createFileRoute: "file",
  createRootRoute: "root",
  createRootRouteWithContext: "root",
  createServerFileRoute: "server",
};

/** Cheap text test: the tree is only worth walking when a creator is named in the source. */
function applies(_path: string, source: string): boolean {
  return source.includes("createFileRoute") || source.includes("createRootRoute") || source.includes("createServerFileRoute");
}

export const tanstackPass: SignalPass = {
  id: "tanstack",
  langs: LANGS,
  applies,
  run(input: SignalInput): SignalOutput {
    const names = new NameAllocator();
    const decls: Declaration[] = [];
    const refs: ReferenceRecord[] = [];

    walk(input.tree.rootNode, (node) => {
      if (node.type !== "call_expression") return;
      const route = routeCall(node);
      if (route === null) return;
      emit(input, route, names, decls, refs);
    });

    return { decls, refs };
  },
};

/** One recognised route creation: the creator, its path, and the options object it was given. */
interface RouteCall {
  creator: Creator;
  path: string;
  /** The outermost call, for the node's span. */
  call: Node;
  options: Node | null;
}

/**
 * A route creation, or null.
 *
 * Three shapes, all of them a call whose *callee* is the interesting part:
 *   `createFileRoute("/x")({ … })`      -> callee is a call, path in its arguments
 *   `createRootRoute({ … })`            -> callee is the identifier, options in this call
 *   `createRootRouteWithContext<C>()({ … })` -> callee is a call with no arguments
 */
function routeCall(call: Node): RouteCall | null {
  const callee = field(call, "function");
  if (callee === null) return null;

  if (callee.type === "call_expression") {
    const name = creatorName(callee);
    if (name === null) return null;
    const creator = CREATORS[name];
    if (creator === undefined) return null;
    const path = creator === "root" ? "/" : literalPath(callee);
    if (path === null) return null;
    return { creator, path, call, options: firstObject(call) };
  }

  const name = creatorName(call);
  if (name === null) return null;
  const creator = CREATORS[name];
  // The curried spelling is handled above; reaching a bare `createFileRoute("/x")` here means
  // its result was never called, so there is no route to describe.
  if (creator !== "root") return null;
  // `createRootRouteWithContext<C>()` is the callee of the call that carries the options; it is
  // the same route, and counting it again would give the file two `route./` nodes.
  if (isCallee(call)) return null;
  return { creator, path: "/", call, options: firstObject(call) };
}

/** True when `call` is the callee of the call around it, rather than a value in its own right. */
function isCallee(call: Node): boolean {
  const parent = call.parent;
  if (parent === null || parent.type !== "call_expression") return false;
  return field(parent, "function")?.id === call.id;
}

/** The creator identifier a call names, ignoring type arguments. */
function creatorName(call: Node): string | null {
  const callee = calleeText(call);
  return callee !== null && callee.indexOf(".") < 0 ? callee : null;
}

/** The first argument of `call` when it is a string literal; null when it is computed. */
function literalPath(call: Node): string | null {
  const args = field(call, "arguments");
  if (args === null) return null;
  const first = args.namedChildren.find((child) => child !== null);
  if (first === undefined || first === null || first.type !== "string") return null;
  return stringOf(first);
}

/** The first argument of `call` when it is an object literal. */
function firstObject(call: Node): Node | null {
  const args = field(call, "arguments");
  if (args === null) return null;
  const first = args.namedChildren.find((child) => child !== null);
  if (first === undefined || first === null) return null;
  const inner = unwrapValue(first);
  return inner.type === "object" ? inner : null;
}

function emit(
  input: SignalInput,
  route: RouteCall,
  names: NameAllocator,
  decls: Declaration[],
  refs: ReferenceRecord[],
): void {
  const span = spanOf(route.call);
  const routeName = names.take(route.path);
  decls.push(
    signalNode({
      path: input.path,
      kind: "route",
      name: routeName,
      signature: `${route.creator === "server" ? "createServerFileRoute" : route.creator === "root" ? "createRootRoute" : "createFileRoute"}("${route.path}")`,
      span,
      signal: "tanstack",
      meta: {
        framework: "tanstack-start",
        file: input.path,
        server: route.creator === "server" ? "1" : undefined,
      },
    }),
  );

  const options = route.options;
  if (options === null) return;

  for (const pair of options.namedChildren) {
    if (pair === null || pair.type !== "pair") continue;
    const key = field(pair, "key");
    const value = field(pair, "value");
    if (key === null || value === null) continue;
    const name = key.type === "string" ? stringOf(key) : key.text;

    if (HANDLER_KEYS.has(name) || (route.creator === "server" && METHODS.has(name))) {
      decls.push(
        signalNode({
          path: input.path,
          kind: "handler",
          name: names.take(name),
          signature: `${name} of ${route.path}`,
          span: spanOf(pair),
          signal: "tanstack",
          meta: { framework: "tanstack-start", route: route.path },
        }),
      );
      continue;
    }

    if (!COMPONENT_KEYS.has(name)) continue;
    // Only a bare identifier is a link. An inline arrow is the component, and a component that
    // is written where it is used needs no edge to say so.
    const target = unwrapValue(value);
    if (target.type !== "identifier") continue;
    refs.push({
      from: `route.${routeName}`,
      to: target.text,
      refKind: "route-handler",
      line: spanOf(pair)[0],
    });
  }
}
