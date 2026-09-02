/**
 * Which paths under `.greplost/` the structure layer owns (tech spec 4.2, 7.3).
 *
 * This is the boundary that makes `greplost update` safe to run on a directory
 * that also holds files greplost does not generate. Everything matched here is
 * regenerated from source on every build, so `writeArtifacts` may overwrite it
 * and may delete it when it is no longer produced. Everything else —
 * `config.json` (hand-written), `cache/**` (the semantic and parse caches),
 * `packages/<pkg>/FLOWS.md` (semantic layer), `WORKSPACE.md` (workspace mode),
 * and the runtime files `.dirty`, `.lock`, `.state.json`, `.gitignore` — is
 * owned by someone else and is never written or pruned by this package.
 *
 * Paths are always artifact-relative posix strings: no leading slash, no
 * `.`/`..` segments, no backslashes. Anything else is not a structure path,
 * which is what keeps `writeArtifacts` inside `.greplost/`.
 */

import { readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { compareStrings } from "@greplost/core/schema";

/**
 * The structure-layer artifact set, as globs relative to `.greplost/`.
 *
 * `*` matches within one path segment; `**` matches zero or more whole
 * segments. This list is the definition, not a comment: `isStructurePath`
 * matches against it directly.
 */
export const STRUCTURE_GLOBS: readonly string[] = [
  "INDEX.md",
  "manifest.json",
  "graph/*.jsonl",
  "repo/*.md",
  "packages/*/MAP.md",
  "packages/*/API.md",
  "packages/*/modules/**/*.md",
];

/** Pre-split once: `isStructurePath` runs per file on every write and verify. */
const STRUCTURE_PATTERNS: ReadonlyArray<readonly string[]> = STRUCTURE_GLOBS.map((glob) => glob.split("/"));

/**
 * True when `rel` (a path relative to `.greplost/`) is a structure-layer
 * artifact: one that `buildArtifacts` produces, `writeArtifacts` owns, and
 * `verify` compares.
 */
export function isStructurePath(rel: string): boolean {
  const segments = splitSafe(rel);
  if (segments === null) return false;
  for (const pattern of STRUCTURE_PATTERNS) {
    if (matchSegments(pattern, 0, segments, 0)) return true;
  }
  return false;
}

/**
 * Split an artifact-relative path into segments, or `null` when the string is
 * not one. Rejecting rather than normalising is deliberate: a path that needs
 * normalising did not come from a build, and the only caller that would act on
 * it writes to disk.
 *
 * Rejected: the empty string, absolute paths (posix or Windows drive), NUL,
 * backslashes (a Windows separator never appears in an artifact path), and any
 * empty, `.` or `..` segment.
 */
function splitSafe(rel: string): string[] | null {
  if (rel === "") return null;
  if (rel.includes("\\") || rel.includes("\0")) return null;
  if (rel.startsWith("/")) return null;
  if (rel.length >= 2 && rel[1] === ":" && isDriveLetter(rel[0] as string)) return null;
  const segments = rel.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
  }
  return segments;
}

function isDriveLetter(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");
}

/** Glob segments against path segments, with `**` spanning zero or more segments. */
function matchSegments(
  pattern: readonly string[],
  patternIndex: number,
  segments: readonly string[],
  segmentIndex: number,
): boolean {
  let pi = patternIndex;
  let si = segmentIndex;
  while (pi < pattern.length) {
    const part = pattern[pi] as string;
    if (part === "**") {
      for (let skip = si; skip <= segments.length; skip++) {
        if (matchSegments(pattern, pi + 1, segments, skip)) return true;
      }
      return false;
    }
    if (si >= segments.length) return false;
    if (!matchSegment(part, segments[si] as string)) return false;
    pi++;
    si++;
  }
  return si === segments.length;
}

/** One segment against one pattern segment; `*` matches any run of characters. */
function matchSegment(pattern: string, segment: string): boolean {
  if (!pattern.includes("*")) return pattern === segment;
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = 0;
  while (s < segment.length) {
    if (p < pattern.length && pattern[p] === "*") {
      starP = p;
      starS = s;
      p++;
    } else if (p < pattern.length && pattern[p] === segment[s]) {
      p++;
      s++;
    } else if (starP !== -1) {
      // Backtrack: let the last `*` swallow one more character.
      p = starP + 1;
      starS++;
      s = starS;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/**
 * Every structure path present under `artifactDir`, sorted.
 *
 * The one walk shared by the writer (which prunes what the map no longer
 * produces) and the verifier (which reports it as extra), so the two can never
 * disagree about what is on disk.
 *
 * An entry is reported as soon as its own path is a structure path, whatever it
 * is: a directory squatting on `INDEX.md` is a structure path that is not a
 * readable artifact, which is exactly what both callers need to hear.
 * Directories that are not themselves structure paths are descended into;
 * symlinks never are, so a link out of `.greplost/` cannot widen the walk.
 * A directory that cannot be read contributes nothing rather than throwing:
 * neither caller can act on what it cannot see.
 */
export function listStructurePaths(artifactDir: string): string[] {
  const found: string[] = [];

  const walk = (dir: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (isStructurePath(rel)) {
        found.push(rel);
        continue;
      }
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
    }
  };
  walk(artifactDir, "");

  return found.sort(compareStrings);
}
