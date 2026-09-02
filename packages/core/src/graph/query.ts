/**
 * Queries over a committed structure (`serialize/read.ts`'s `Structure`).
 *
 * Everything here is a pure function of arrays that were read from
 * `.greplost/`: the CLI answers `greplost symbol`, `greplost importers` and
 * `greplost callers` without parsing a line of source, which is the whole point
 * of committing the structure layer.
 */

import type { CallEdge, Declaration, ImportEdge } from "../schema.ts";
import { compareDeclarations, compareStrings } from "../schema.ts";
import { importTargetsOf } from "./directories.ts";

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
 * Callers of `symbolId`, sorted and unique. A caller is `<file>#<symbol>`, or
 * the bare `<file>` when the call sits in top-level code.
 */
export function callersOf(calls: CallEdge[], symbolId: string): string[] {
  const callers = new Set<string>();
  for (const edge of calls) {
    if (edge.kind !== "call") continue;
    if (edge.to !== symbolId) continue;
    callers.add(edge.from);
  }
  return [...callers].sort(compareStrings);
}

/** Copy before sorting: a query never reorders the caller's array. */
function sortDeclarations(found: Declaration[]): Declaration[] {
  return [...found].sort(compareDeclarations);
}
