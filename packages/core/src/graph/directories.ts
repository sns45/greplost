/**
 * Directory import targets (leaf 1.8, tech spec Appendix C).
 *
 * A Go import names a *package*, not a file, so a Go import edge's `to` is the
 * repo-relative **directory** of that package (`"."` at the repo root). Every
 * consumer that reasons about "which file imports which" therefore has to turn
 * one directory target into the files that directory actually holds - otherwise
 * a Go repo has no fan-in, no blast radius, no package edges and no "Imported
 * by" list, even though `graph/imports.jsonl` is complete and correct.
 *
 * This module is the single place that expansion happens, so the graph layer,
 * the query layer and the render layer cannot drift apart.
 *
 * TypeScript, JavaScript and every other file-target language pass through
 * unchanged: an edge whose `to` is an indexed file is one pair, exactly as
 * before, and an `ext:` / `unresolved:` target is still no pair at all.
 */

import type { ImportEdge } from "../schema.ts";
import { compareStrings } from "../schema.ts";

/** The directory of a repo-relative path; `"."` for a file at the repo root. */
export function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "." : path.slice(0, slash);
}

/**
 * The import-target ids that resolve to `file`: the file itself, and the
 * directory id of the package it belongs to. `importersOf` matches an edge
 * against both, which is all the expansion a single-file question needs.
 */
export function importTargetsOf(file: string): [string, string] {
  return [file, directoryOf(file)];
}

/** Indexed files grouped by their directory id, each list sorted. */
export function filesByDirectory(files: readonly string[]): Map<string, string[]> {
  const byDirectory = new Map<string, string[]>();
  for (const file of files) {
    const dir = directoryOf(file);
    const bucket = byDirectory.get(dir);
    if (bucket === undefined) byDirectory.set(dir, [file]);
    else bucket.push(file);
  }
  for (const bucket of byDirectory.values()) bucket.sort(compareStrings);
  return byDirectory;
}

/**
 * File-to-file pairs behind `edges`, with directory targets expanded.
 *
 *  - `to` is an indexed file            -> one pair, unchanged;
 *  - `to` is a directory holding files  -> one pair per file in it;
 *  - anything else (`ext:`, `unresolved:`, an empty directory) -> no pair.
 *
 * Self-pairs are dropped: a Go file importing its own package is not a thing,
 * and a file that imports itself carries no structure either way. Only `import`
 * and `reexport` edges are considered, and duplicates are kept - the package
 * edge count is the number of file-level edges behind it.
 *
 * The result is sorted, so a caller cannot make the graph depend on the order
 * the edges happened to arrive in.
 */
export function expandDirectoryTargets(
  edges: readonly ImportEdge[],
  files: readonly string[],
): Array<readonly [string, string]> {
  const indexed = new Set(files);
  const byDirectory = filesByDirectory(files);
  const pairs: Array<readonly [string, string]> = [];

  for (const edge of edges) {
    if (edge.kind !== "import" && edge.kind !== "reexport") continue;
    if (!indexed.has(edge.from)) continue;
    if (indexed.has(edge.to)) {
      if (edge.from !== edge.to) pairs.push([edge.from, edge.to] as const);
      continue;
    }
    for (const target of byDirectory.get(edge.to) ?? []) {
      if (edge.from !== target) pairs.push([edge.from, target] as const);
    }
  }

  pairs.sort((a, b) => compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]));
  return pairs;
}
