/**
 * Next.js App Router signal pass (build 2, leaf 2.3; spec 2026-09-04 section 3.4).
 *
 * The route path comes from the *path*, not from the code: App Router routing is a filesystem
 * convention, so `nextRoutePath` is a pure function of the file path and gets its own
 * table-driven test. Segments under `app/` are kept, `(group)` segments are dropped,
 * `[slug]` / `[...rest]` / `[[...opt]]` are kept verbatim, and an `@slot` parallel-route segment
 * leaves the path and is recorded in `meta.slot`.
 *
 * `page` and `layout` give a `route.<path>` node with `meta.kind`; `route.ts` gives one as well
 * (`meta.kind = "handler"`) plus a `handler.<METHOD>` node per exported HTTP-method function.
 * A `page` also gets a `route-handler` reference to its default-exported component.
 *
 * The Pages Router (`pages/**`) is explicitly out of scope for build 2.
 */

import type { Node } from "web-tree-sitter";
import type { Declaration, ExportRecord, Lang, ReferenceRecord } from "../schema.ts";
import type { SignalInput, SignalOutput, SignalPass } from "./index.ts";
import { NameAllocator, field, signalNode, spanOf, stringOf, topLevelBindings, unwrapValue } from "./ts-nodes.ts";

const LANGS: ReadonlySet<Lang> = new Set<Lang>(["ts", "tsx", "js", "jsx"]);

/** Basenames the App Router gives a meaning. `applies` matches all seven (spec section 3.4). */
const SPECIAL_FILES: ReadonlySet<string> = new Set([
  "page",
  "layout",
  "route",
  "loading",
  "error",
  "template",
  "default",
]);

/** The three that name a route. The other four are UI states of a route declared elsewhere. */
const ROUTE_KIND: Readonly<Record<string, string>> = { page: "page", layout: "layout", route: "handler" };

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;

/** HTTP methods a `route.ts` may export. */
const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** `page`, `layout`, … for an App Router file; null for anything else. */
function specialFile(path: string): string | null {
  const slash = path.lastIndexOf("/");
  const base = slash < 0 ? path : path.slice(slash + 1);
  const extension = EXTENSIONS.find((ext) => base.endsWith(ext));
  if (extension === undefined) return null;
  const stem = base.slice(0, base.length - extension.length);
  return SPECIAL_FILES.has(stem) ? stem : null;
}

/** The segments of `path` that lie under the last `app/` directory, filename excluded. */
function segmentsUnderApp(path: string): string[] | null {
  const parts = path.split("/");
  const app = parts.lastIndexOf("app");
  if (app < 0 || app === parts.length - 1) return null;
  return parts.slice(app + 1, parts.length - 1);
}

/**
 * The App Router path of a file, as a route.
 *
 * Pure and total: a path that is not under an `app/` directory has no route, which is spelled
 * `""` rather than thrown, because `applies` has already decided whether this pass runs.
 */
export function nextRoutePath(path: string): string {
  const segments = segmentsUnderApp(path);
  if (segments === null) return "";
  const kept = segments.filter((segment) => !isGroup(segment) && !isSlot(segment));
  return kept.length === 0 ? "/" : `/${kept.join("/")}`;
}

/** `(marketing)`: a route group, present for organisation and absent from the URL. */
function isGroup(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

/** `@modal`: a parallel route slot, which is a slot name rather than a path segment. */
function isSlot(segment: string): boolean {
  return segment.startsWith("@");
}

/** `[id]`, `[...rest]`, `[[...opt]]`. */
function isDynamic(segment: string): boolean {
  return segment.startsWith("[") && segment.endsWith("]");
}

function applies(path: string, _source: string): boolean {
  return specialFile(path) !== null && segmentsUnderApp(path) !== null;
}

export const nextPass: SignalPass = {
  id: "next",
  langs: LANGS,
  applies,
  /**
   * The route this file is, when it is one. `app/donate-with-checkout/result/page.tsx` and
   * `app/donate-with-embedded-checkout/result/page.tsx` are byte-identical in the pinned
   * Next.js corpus and are two different routes; without this the second inherits the first
   * one's `route.` node from the content-addressed extraction cache.
   */
  pathKey(path: string): string {
    const stem = specialFile(path);
    const segments = segmentsUnderApp(path);
    if (stem === null || segments === null) return "";
    // The raw segments, not the route: `(group)` and `@slot` are dropped from the route but
    // still change `meta.slot`, so the key has to see them.
    return `${stem}:${segments.join("/")}`;
  },
  run(input: SignalInput): SignalOutput {
    const stem = specialFile(input.path);
    const segments = segmentsUnderApp(input.path);
    if (stem === null || segments === null) return { decls: [], refs: [] };
    const kind = ROUTE_KIND[stem];
    // `loading`, `error`, `template` and `default` are states of a route that `page` or
    // `layout` already declared; giving them a route node of their own would double-count it.
    if (kind === undefined) return { decls: [], refs: [] };

    const names = new NameAllocator();
    const decls: Declaration[] = [];
    const refs: ReferenceRecord[] = [];
    const route = nextRoutePath(input.path);
    const slot = segments.find(isSlot);
    const bindings = topLevelBindings(input.tree);

    const routeName = names.take(route);
    decls.push(
      signalNode({
        path: input.path,
        kind: "route",
        name: routeName,
        signature: `${stem} ${route}`,
        span: [1, Math.max(1, input.tree.rootNode.endPosition.row + 1)],
        signal: "next",
        meta: {
          framework: "next",
          kind,
          file: input.path,
          slot: slot === undefined ? undefined : slot.slice(1),
          dynamic: segments.some(isDynamic) ? "1" : undefined,
          runtime: runtimeOf(bindings),
        },
      }),
    );

    if (kind === "handler") {
      for (const binding of bindings) {
        if (!binding.exported || !METHODS.has(binding.name)) continue;
        if (!isFunctionBinding(binding.node, binding.value)) continue;
        decls.push(
          signalNode({
            path: input.path,
            kind: "handler",
            name: names.take(binding.name),
            signature: `${binding.name} ${route}`,
            span: spanOf(binding.outer),
            signal: "next",
            meta: { framework: "next", method: binding.name, route },
          }),
        );
      }
      return { decls, refs };
    }

    // A page or layout is served by whatever it default-exports; the linker decides whether
    // that identifier resolves, and to what.
    if (kind === "page") {
      const component = defaultExportName(input.base.exports);
      if (component !== null) {
        refs.push({ from: `route.${routeName}`, to: component, refKind: "route-handler", line: 1 });
      }
    }

    return { decls, refs };
  },
};

/** True when the binding holds a function rather than a value. */
function isFunctionBinding(node: Node, value: Node | null): boolean {
  if (node.type !== "variable_declarator") return node.type.includes("function");
  if (value === null) return false;
  const inner = unwrapValue(value);
  return inner.type === "arrow_function" || inner.type === "function_expression" || inner.type === "function";
}

/** `export const runtime = "edge"`, only a string literal, never an expression. */
function runtimeOf(bindings: readonly { name: string; exported: boolean; value: Node | null }[]): string | undefined {
  for (const binding of bindings) {
    if (!binding.exported || binding.name !== "runtime") continue;
    const value = binding.value;
    if (value !== null && value.type === "string") return stringOf(value);
  }
  return undefined;
}

/**
 * The local name a file's `export default` gives its value, or null when it is anonymous.
 *
 * Taken from the export records rather than from the tree: `export default function Page() {}`
 * and `const Page = () => …; export default Page;` are the same statement about the module,
 * and the language extractor has already normalised both into one record.
 */
function defaultExportName(exports: readonly ExportRecord[]): string | null {
  const defaults = exports.filter((record) => record.kind === "default");
  const only = defaults.length === 1 ? defaults[0] : undefined;
  if (only === undefined) return null;
  const local = only.local;
  return local === undefined || local === "default" ? null : local;
}
