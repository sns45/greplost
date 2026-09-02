/**
 * Derived metrics: fan-in/fan-out, blast radius, cycles and the package graph.
 * Everything is computed over `import` + `reexport` edges whose target is a
 * repo file; external and unresolved targets carry no structure.
 */

import type {
  FileEntry,
  FileRecord,
  ImportEdge,
  Metrics,
  PackageEdge,
  PackageEntry,
  PackageInfo,
} from "../schema.ts";
import { compareStrings } from "../schema.ts";
import { packageOf } from "../resolve/index.ts";
import { blastRadius } from "./blast.ts";
import { expandDirectoryTargets } from "./directories.ts";
import { stronglyConnected } from "./tarjan.ts";

/** The parts of a `FileEntry` this leaf can compute; the rest comes from the build. */
export type FileMetrics = Omit<FileEntry, "summaryHash" | "staleSummary" | "exports">;

export interface ComputedMetrics {
  manifestFiles: Record<string, FileMetrics>;
  manifestPackages: Record<string, PackageEntry>;
  metrics: Metrics;
}


function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([value]));
  else set.add(value);
}

export function computeMetrics(
  files: FileRecord[],
  packages: PackageInfo[],
  imports: ImportEdge[],
): ComputedMetrics {
  const paths = [...new Set(files.map((f) => f.path))].sort(compareStrings);

  // File-to-file edges, duplicates kept: the package edge count is the number of
  // file-level edges behind it. Self-imports carry no structure at all.
  //
  // A Go import target is a package *directory* (tech spec Appendix C), so it is
  // expanded to the indexed files of that directory before anything is measured;
  // a file target passes through unchanged, which leaves every TypeScript number
  // byte-identical.
  const edges = expandDirectoryTargets(imports, paths);

  const fanIn = new Map<string, Set<string>>();
  const fanOut = new Map<string, Set<string>>();
  for (const [from, to] of edges) {
    addTo(fanOut, from, to);
    addTo(fanIn, to, from);
  }
  const blast = blastRadius(paths, edges);

  const packageNameOf = new Map<string, string>();
  const nameFor = (path: string): string => {
    const cached = packageNameOf.get(path);
    if (cached !== undefined) return cached;
    const name = packageOf(path, packages).name;
    packageNameOf.set(path, name);
    return name;
  };

  const manifestFiles: Record<string, FileMetrics> = {};
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const path of paths) {
    const file = byPath.get(path);
    if (file === undefined) continue;
    manifestFiles[path] = {
      sha256: file.sha256,
      pkg: nameFor(path),
      lang: file.lang,
      loc: file.loc,
      fanIn: fanIn.get(path)?.size ?? 0,
      fanOut: fanOut.get(path)?.size ?? 0,
      blast: blast.get(path) ?? 0,
    };
  }

  const entries = new Map<string, PackageEntry>();
  const ensure = (name: string, path: string): PackageEntry => {
    let entry = entries.get(name);
    if (entry === undefined) {
      entry = { path, deps: [], rdeps: [], loc: 0, files: 0 };
      entries.set(name, entry);
    }
    return entry;
  };
  for (const pkg of packages) ensure(pkg.name, pkg.path);
  for (const path of paths) {
    const file = byPath.get(path);
    if (file === undefined) continue;
    const pkg = packageOf(path, packages);
    const entry = ensure(pkg.name, pkg.path);
    entry.loc += file.loc;
    entry.files += 1;
  }

  // The pair is joined with NUL: a package name may contain a space (duplicate
  // names are disambiguated as "<name> (<path>)").
  const counts = new Map<string, number>();
  for (const [from, to] of edges) {
    const a = nameFor(from);
    const b = nameFor(to);
    if (a === b) continue;
    const key = `${a}\u0000${b}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const packageEdges: PackageEdge[] = [];
  for (const [key, count] of counts) {
    const [from = "", to = ""] = key.split("\u0000");
    packageEdges.push({ from, to, count });
  }
  packageEdges.sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to));

  const deps = new Map<string, Set<string>>();
  const rdeps = new Map<string, Set<string>>();
  for (const edge of packageEdges) {
    addTo(deps, edge.from, edge.to);
    addTo(rdeps, edge.to, edge.from);
  }
  for (const [name, entry] of entries) {
    entry.deps = [...(deps.get(name) ?? [])].sort(compareStrings);
    entry.rdeps = [...(rdeps.get(name) ?? [])].sort(compareStrings);
  }

  const manifestPackages: Record<string, PackageEntry> = {};
  for (const name of [...entries.keys()].sort(compareStrings)) {
    const entry = entries.get(name);
    if (entry !== undefined) manifestPackages[name] = entry;
  }

  return {
    manifestFiles,
    manifestPackages,
    metrics: { cycles: stronglyConnected(paths, edges), packageEdges },
  };
}
