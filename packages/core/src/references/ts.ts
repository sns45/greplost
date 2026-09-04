/**
 * TypeScript reference rules (build 2, leaf 2.3; spec 2026-09-04 sections 0.3, 3.3 to 3.5).
 *
 * TypeScript expresses almost every dependency as an import or a call, so it produced no
 * `ReferenceRecord` at all until the signal passes landed. The two it produces now are the two
 * the spec defines for framework signals:
 *
 *  - `route-handler`: a route node bound to the handler that serves it. `ref.to` is the
 *    identifier the route named (`component: Home`, `export default function Page`).
 *  - `resource-input`: a Pulumi resource fed another resource's output. `ref.to` is the
 *    language-native address that produced it (`bucket.id`), and its head is the binding name.
 *
 * Confidence follows the rule that governs call edges: `high` for a unique resolution in the
 * same file, `med` through exactly one import, **and anything ambiguous is dropped rather than
 * guessed**. A name bound twice, an import that could have come from either of two records, a
 * target file that is not indexed: all of them produce no edge, because a wrong edge in the map
 * is worse than a missing one.
 *
 * Reached through the dispatch table in `link.ts`, which owns the two rules this file must not
 * re-implement: an edge never targets `unresolved:`, and the result is sorted and deduplicated.
 */

import type { FileRecord, ReferenceEdge, ReferenceRecord } from "../schema.ts";
import { nodeId, symbolId } from "../schema.ts";
import type { ReferenceContext } from "./link.ts";
import { referenceSource } from "./link.ts";

/** Kinds a `route-handler` edge may land on, most specific first. */
const HANDLER_KINDS = ["component", "handler"] as const;

export function resolveTsReferences(
  file: FileRecord,
  ref: ReferenceRecord,
  ctx: ReferenceContext,
): ReferenceEdge | null {
  switch (ref.refKind) {
    case "route-handler":
      return link(file, ref, ctx, ref.to, HANDLER_KINDS, true);
    case "resource-input": {
      // `bucket.id` names the binding `bucket`; the property is what makes the edge worth
      // showing, not what it resolves to.
      const dot = ref.to.indexOf(".");
      const head = dot < 0 ? ref.to : ref.to.slice(0, dot);
      return link(file, ref, ctx, head, ["resource"], false);
    }
    default:
      // Every other `RefKind` belongs to a language that is not TypeScript. A record that
      // reaches here is a bug in whichever pass wrote it, and dropping it is the safe answer.
      return null;
  }
}

/**
 * Resolve `name` to a node or declaration, in this file first and then through one import.
 *
 * `allowSymbol` says whether a plain declaration counts: a route may be served by a function
 * that no pass turned into a `component` node, but a `resource-input` must land on a resource
 * node or on nothing at all.
 */
function link(
  file: FileRecord,
  ref: ReferenceRecord,
  ctx: ReferenceContext,
  name: string,
  kinds: readonly ("component" | "handler" | "resource")[],
  allowSymbol: boolean,
): ReferenceEdge | null {
  const local = resolveIn(file.path, name, kinds, allowSymbol, ctx);
  if (local === AMBIGUOUS) return null;
  if (local !== null) return edge(file, ref, local);

  const imported = resolveThroughImport(file, name, kinds, allowSymbol, ctx);
  if (imported === null) return null;
  return edge(file, ref, imported, "med");
}

/** Sentinel for "this name resolves more than one way here", which is never an edge. */
const AMBIGUOUS = Symbol("ambiguous");

/**
 * The node or declaration `name` denotes inside `path`.
 *
 * A file that holds both `resource.b` and `resource.b~2` bound the same name twice, and an
 * input naming `b` cannot say which one it meant.
 */
function resolveIn(
  path: string,
  name: string,
  kinds: readonly ("component" | "handler" | "resource")[],
  allowSymbol: boolean,
  ctx: ReferenceContext,
): string | null | typeof AMBIGUOUS {
  for (const kind of kinds) {
    const id = nodeId(path, kind, name);
    if (!ctx.declarationById.has(id)) continue;
    // `~2` is how a pass disambiguates a duplicate name inside one file; its presence means
    // the bare name was bound twice, so nothing may resolve to either.
    if (ctx.declarationById.has(nodeId(path, kind, `${name}~2`))) return AMBIGUOUS;
    return id;
  }
  if (!allowSymbol) return null;
  const symbol = symbolId(path, name);
  return ctx.declarationById.has(symbol) ? symbol : null;
}

/**
 * The node `name` denotes in the one file that imported it, or null.
 *
 * "Exactly one documented hop" is literal: exactly one import record may bind the name, its
 * specifier must resolve to an indexed file, and that file must declare the name.
 */
function resolveThroughImport(
  file: FileRecord,
  name: string,
  kinds: readonly ("component" | "handler" | "resource")[],
  allowSymbol: boolean,
  ctx: ReferenceContext,
): string | null {
  const matches: Array<{ specifier: string; exported: string }> = [];
  for (const record of file.imports) {
    for (const symbol of record.symbols) {
      if (symbol.local === name) matches.push({ specifier: record.specifier, exported: symbol.name });
    }
  }
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only === undefined) return null;
  // A namespace import binds a module, not a declaration; there is nothing single to point at.
  if (only.exported === "*") return null;

  const target = ctx.resolver.resolve(file.path, only.specifier, file.lang);
  if (target.type !== "file" || !ctx.files.has(target.path)) return null;

  const exported = only.exported === "default" ? defaultExportName(target.path, ctx) : only.exported;
  if (exported === null) return null;

  const resolved = resolveIn(target.path, exported, kinds, allowSymbol, ctx);
  return resolved === AMBIGUOUS ? null : resolved;
}

/** The local name behind a file's `export default`, when it has one written name. */
function defaultExportName(path: string, ctx: ReferenceContext): string | null {
  const record = ctx.recordByPath.get(path);
  if (record === undefined) return null;
  const defaults = record.exports.filter((entry) => entry.kind === "default");
  const only = defaults.length === 1 ? defaults[0] : undefined;
  if (only === undefined) return null;
  return only.local ?? (only.name === "default" ? null : only.name);
}

function edge(file: FileRecord, ref: ReferenceRecord, to: string, confidence: "high" | "med" = "high"): ReferenceEdge {
  return {
    from: referenceSource(file.path, ref),
    to,
    kind: "reference",
    refKind: ref.refKind,
    symbols: [ref.to],
    confidence,
  };
}
