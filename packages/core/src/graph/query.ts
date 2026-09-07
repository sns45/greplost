/**
 * Queries over a committed structure (`serialize/read.ts`'s `Structure`).
 *
 * Everything here is a pure function of arrays that were read from
 * `.greplost/`: the CLI answers `greplost symbol`, `greplost importers` and
 * `greplost callers` without parsing a line of source, which is the whole point
 * of committing the structure layer.
 */

import type { CallEdge, Confidence, Declaration, ImportEdge, ReferenceEdge } from "../schema.ts";
import { compareDeclarations, compareEdges, compareStrings, isNodeDeclaration } from "../schema.ts";
import type { Structure } from "../serialize/read.ts";
import { expandDirectoryTargets, importTargetsOf } from "./directories.ts";

/**
 * Declarations matching `needle`, in three tiers, the first non-empty one wins:
 *
 *  1. an exact node id (`packages/core/src/retry.ts#retry`);
 *  2. an exact symbol path (`retry`, `Registry.publishAll`);
 *  3. a name-suffix match on a symbol-path boundary: a `name` ending in
 *     `.<needle>`, so `publish` finds `SqsAdapter.publish` but never
 *     `republish`. It anchors on `name`, never on `id`, so a repo-relative path
 *     ending in the needle can never masquerade as a symbol match.
 *
 * Tiers, rather than a union, keep a precise needle precise: asking for `foo`
 * when a top-level `foo` exists does not also drag in every `Thing.foo`.
 * Each tier is sorted with `compareDeclarations`.
 */
export function findSymbols(symbols: Declaration[], needle: string): Declaration[] {
  if (needle === "") return [];

  const byId = symbols.filter((decl) => decl.id === needle);
  if (byId.length > 0) return sortDeclarations(byId);

  const byName = symbols.filter((decl) => decl.name === needle);
  if (byName.length > 0) return sortDeclarations(byName);

  const suffix = symbols.filter((decl) => decl.name.endsWith(`.${needle}`));
  return sortDeclarations(suffix);
}

/**
 * Repo files that import `file`, over `import` and `reexport` edges. Sorted,
 * unique: a file that imports another twice (a value import and a type import,
 * say) is listed once.
 *
 * An edge that targets the *directory* `file` lives in counts too: a Go import
 * names a package, so importing `internal/store` imports every `.go` file in it
 * (tech spec Appendix C). `importTargetsOf` is the shared expansion rule; a
 * target id is either an indexed file path or a directory path, never both, so
 * this can never fold two different modules together.
 */
export function importersOf(imports: ImportEdge[], file: string): string[] {
  const targets = new Set(importTargetsOf(file));
  const importers = new Set<string>();
  for (const edge of imports) {
    if (edge.kind !== "import" && edge.kind !== "reexport") continue;
    if (!targets.has(edge.to)) continue;
    if (edge.from === file) continue;
    importers.add(edge.from);
  }
  return [...importers].sort(compareStrings);
}

/**
 * One caller of a symbol (build 2.1): where the call comes from, where in that file it
 * sits, and how sure the edge is. A reader who has to open the caller anyway saves the
 * search, and `confidence` says whether the edge was pinned outright or through a barrel.
 */
export interface Caller {
  /** `<file>#<symbol>`, or the bare `<file>` when the call sits in top-level code. */
  from: string;
  /** 1-based line of the call site. Absent only on a map written before edges carried it. */
  line?: number;
  confidence: Confidence;
}

/**
 * Callers of `symbolId`, sorted by caller id and unique.
 *
 * A caller that reaches the symbol from more than one edge (which a well-formed map never
 * writes, since an edge is one (from, to) pair) is folded into one entry that keeps the
 * first line and the best confidence, so the answer never depends on edge order.
 */
export function callersOf(calls: readonly CallEdge[], symbolId: string): Caller[] {
  const callers = new Map<string, Caller>();
  for (const edge of calls) {
    if (edge.kind !== "call") continue;
    if (edge.to !== symbolId) continue;
    const seen = callers.get(edge.from);
    if (seen === undefined) {
      callers.set(edge.from, {
        from: edge.from,
        ...(edge.line === undefined ? {} : { line: edge.line }),
        confidence: edge.confidence,
      });
      continue;
    }
    if (edge.confidence === "high") seen.confidence = "high";
    if (edge.line !== undefined && (seen.line === undefined || edge.line < seen.line)) seen.line = edge.line;
  }
  return [...callers.values()].sort((a, b) => compareStrings(a.from, b.from));
}

/**
 * The same callers as bare ids, for a caller that wants only the set (build 2.1). Sorted
 * and unique, which is what `callersOf` returned before it carried the site.
 */
export function callerIds(calls: readonly CallEdge[], symbolId: string): string[] {
  return callersOf(calls, symbolId).map((caller) => caller.from);
}

/**
 * The non-file nodes `file` declares (schema 2): the declarations whose `kind`
 * is in `NODE_KINDS`, in span order.
 *
 * A node is a `Declaration` and never a manifest entry (spec 4.2), so this is
 * the only way to ask a committed structure "what does this file contain?" for
 * a Terraform resource, a workflow job, a Dockerfile stage or a route. The
 * caller's array is never reordered.
 */
export function nodesOf(symbols: readonly Declaration[], file: string): Declaration[] {
  return sortDeclarations(symbols.filter((decl) => decl.file === file && isNodeDeclaration(decl)));
}

/** Reference edges leaving `id` (a node id or a file id), sorted with `compareEdges`. */
export function referencesOf(refs: readonly ReferenceEdge[], id: string): ReferenceEdge[] {
  return [...refs.filter((edge) => edge.from === id)].sort(compareEdges);
}

/** Reference edges arriving at `id`, sorted with `compareEdges`. */
export function referencedBy(refs: readonly ReferenceEdge[], id: string): ReferenceEdge[] {
  return [...refs.filter((edge) => edge.to === id)].sort(compareEdges);
}

/**
 * Every dependency pair of a committed structure: import and re-export edges
 * (directory targets expanded, exactly as `impact` on a file already sees them)
 * plus every reference edge, verbatim.
 *
 * Both edge kinds point the same way, dependant first, dependency second, so
 * `impactOf(impactPairs(structure), id)` is one blast radius over a graph that
 * mixes file ids, node ids and `ext:` ids. Reference targets are left
 * unexpanded: a reference names one thing, and the one directory target a
 * reference can carry (a Terraform `module` source) is already reached through
 * the import edge beside it.
 *
 * Sorted, so a caller cannot make the answer depend on edge arrival order.
 */
export function impactPairs(structure: Structure): Array<readonly [string, string]> {
  const pairs = expandDirectoryTargets(structure.imports, Object.keys(structure.manifest.files));
  for (const edge of structure.references) pairs.push([edge.from, edge.to] as const);
  pairs.sort((a, b) => compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]));
  return pairs;
}

/** Copy before sorting: a query never reorders the caller's array. */
function sortDeclarations(found: Declaration[]): Declaration[] {
  return [...found].sort(compareDeclarations);
}
