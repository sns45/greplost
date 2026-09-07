/**
 * Reading the committed map, shared by `query` and `impact`.
 *
 * Neither command parses a line of source: they answer from
 * `.greplost/manifest.json` and `.greplost/graph/*.jsonl` through
 * `readStructure`, which is the whole reason the structure layer is committed.
 * A repo with no map is "not found" (exit 1), not a crash.
 *
 * Path arguments arrive in whatever shape a shell or an agent produced them
 * (absolute, `./`-prefixed, backslashed), and the map only ever speaks in
 * repo-relative posix ids, so normalisation happens once, here.
 */

import path from "node:path";

import { langOf, readStructure } from "@greplost/core";
import type { Structure } from "@greplost/core";
import { expandDirectoryTargets, filesUnder, resolvedImportTargets } from "@greplost/core/graph";
import type { Declaration, Manifest, PackageInfo } from "@greplost/core/schema";
import { ARTIFACT_DIR, compareStrings, isNodeDeclaration, splitNodeId } from "@greplost/core/schema";
import { cardPath, nodeCardPath } from "@greplost/render";

/** The committed structure at `root`, or a "not indexed" error. */
export function loadStructure(root: string): Structure {
  const structure = readStructure(path.join(root, ARTIFACT_DIR));
  if (structure === null) {
    throw new Error(`no map in ${path.join(root, ARTIFACT_DIR)}; run \`greplost init\``);
  }
  return structure;
}

/**
 * A command-line path as the map spells it: repo-relative, forward slashes, no
 * `./` prefix. Absolute paths are made relative to `root`; a path outside the
 * repo comes back unchanged-ish and simply will not be in the manifest.
 */
export function toRepoRelative(root: string, argument: string): string {
  const raw = path.isAbsolute(argument) ? path.relative(root, path.resolve(argument)) : argument;
  let normalised = raw.split(path.sep).join("/").replace(/\\/g, "/");
  while (normalised.startsWith("./")) normalised = normalised.slice(2);
  return normalised.replace(/\/+$/, "");
}

/**
 * True when an argument reads like a file path rather than a symbol name.
 *
 * `langOf` is the same rule discovery indexes by, so a bare `Dockerfile` reads as a path
 * for the same reason `retry.ts` does: it is a name the map can actually hold.
 */
export function looksLikePath(candidate: string): boolean {
  // Schema 2: a `#` separates an id's file from what it names, so a candidate
  // carrying one is a symbol id or a node id and never a path. Without this,
  // `main.tf#resource.aws_vpc.main` reads as a path (it holds a `/` as soon as
  // the file is nested) and `resolveFile` gets first refusal on a node id.
  if (candidate.includes("#")) return false;
  if (candidate.includes("/")) return true;
  return langOf(candidate) !== undefined;
}

/**
 * The non-file node an argument names, or undefined.
 *
 * Exact ids only: a node id is machine-produced (it comes off a card, a
 * `query` answer or `graph/symbols.jsonl`), so there is nothing to guess at,
 * and a fuzzy match here would shadow `findSymbols`, which is the tier below.
 */
export function resolveNode(structure: Structure, candidate: string): Declaration | undefined {
  if (candidate === "" || !candidate.includes("#")) return undefined;
  return structure.symbols.find((decl) => decl.id === candidate && isNodeDeclaration(decl));
}

/**
 * The indexed file an argument names, or `undefined`.
 *
 * An exact repo-relative hit wins. Failing that, a path that unambiguously
 * *ends* one indexed path resolves to it, so `retry.ts` and `src/retry.ts`
 * both find `packages/core/src/retry.ts` when only one file could be meant.
 * Two candidates is an ambiguity, not a guess, and resolves to nothing.
 */
export function resolveFile(manifest: Manifest, candidate: string): string | undefined {
  if (candidate === "") return undefined;
  if (manifest.files[candidate] !== undefined) return candidate;
  if (!looksLikePath(candidate)) return undefined;

  const suffix = `/${candidate}`;
  const matches = Object.keys(manifest.files).filter((file) => file.endsWith(suffix));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The directory an argument names, or `undefined` when the map holds no file
 * under it (leaf 2.15).
 *
 * Exact only, and never a file: `resolveFile` has already had its turn by the
 * time this is asked, and a suffix rule here would make `src` mean whichever of
 * five `src` directories happened to sort first. `"."` and `""` name the repo
 * root, which is what a directory id of `"."` means everywhere else.
 */
export function resolveDirectory(manifest: Manifest, candidate: string): string | undefined {
  if (candidate === "" || candidate.includes("#")) return undefined;
  if (manifest.files[candidate] !== undefined) return undefined;
  const directory = candidate === "" ? "." : candidate;
  return filesUnder(Object.keys(manifest.files), directory).length > 0 ? directory : undefined;
}

/**
 * The `PackageInfo` the card-path rule needs for `file`.
 *
 * `source` is not part of that rule and `cardPath` never reads it; the manifest
 * does not record how a package was discovered, so it is filled with the
 * ordinary case rather than invented per package.
 */
function packageInfoOf(manifest: Manifest, name: string): PackageInfo | undefined {
  const entry = manifest.packages[name];
  if (entry === undefined) return undefined;
  return { name, path: entry.path, source: "package.json" };
}

/**
 * A card path as a reader opens it: repo-relative, `.greplost/` and all
 * (leaf 2.15).
 *
 * `cardPath` and `nodeCardPath` produce artifact-relative paths, because that
 * is what a link *inside* the map has to be. A `query` answer is read from
 * outside the map, where the same string is not a path to anything: the
 * evaluation reported having to prefix every `card` by hand before it could
 * open one. The map directory is a constant, so the CLI adds it once, here.
 */
function repoRelativeCard(artifactRelative: string): string {
  return artifactRelative === "" ? "" : `${ARTIFACT_DIR}/${artifactRelative}`;
}

/** Repo-relative module card path for `file`, or `""` when it has none. */
export function cardOf(manifest: Manifest, file: string): string {
  const entry = manifest.files[file];
  if (entry === undefined) return "";
  const pkg = packageInfoOf(manifest, entry.pkg);
  return pkg === undefined ? "" : repoRelativeCard(cardPath(pkg, file));
}

/**
 * Repo-relative node card path for a node id, or `""` when the id names no node
 * or its file is not indexed. Slugged, so it never contains a `#`.
 */
export function nodeCardOf(manifest: Manifest, id: string): string {
  const parts = splitNodeId(id);
  if (parts === null) return "";
  const entry = manifest.files[parts.file];
  if (entry === undefined) return "";
  const pkg = packageInfoOf(manifest, entry.pkg);
  return pkg === undefined ? "" : repoRelativeCard(nodeCardPath(pkg, id));
}

/**
 * File-to-file import pairs for the whole map, directory targets expanded.
 *
 * A Go import names a package, so its edge targets a directory id; core's
 * `expandDirectoryTargets` is the one place that rule lives, and routing
 * through it is what makes `impact` work on a Go map (tech spec Appendix C).
 */
export function importPairs(structure: Structure): Array<readonly [string, string]> {
  return expandDirectoryTargets(structure.imports, Object.keys(structure.manifest.files));
}

/**
 * What `file` imports, sorted and unique: the *counting* view, so this list
 * always has exactly `fanIn`/`fanOut`'s idea of a length.
 *
 * "What does this file import?" is a question about import statements, so a Go
 * file importing a four-file package imports one thing, named as the package
 * directory id it targets, not four (core's `resolvedImportTargets`, ruling
 * 2026-09-02). The reachability view, which does expand to all four, is
 * `importPairs` and belongs to `impact`. For TypeScript the two are identical.
 */
export function importsOfFile(structure: Structure, file: string): string[] {
  const targets = new Set<string>();
  for (const [from, to] of resolvedImportTargets(structure.imports, Object.keys(structure.manifest.files))) {
    if (from === file) targets.add(to);
  }
  return [...targets].sort(compareStrings);
}
