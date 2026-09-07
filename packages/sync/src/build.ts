/**
 * The whole structure layer, in memory (tech spec 4.2, 7.3; sync spec "Build").
 *
 * `buildArtifacts` is the one place that knows how a checkout becomes a
 * `.greplost/` tree: `buildSnapshot` for the facts, then the union of
 * `serializeSnapshot` (the machine artifacts) and `renderArtifacts` (the
 * markdown). Nothing here touches the filesystem except to read the committed
 * summary cache, which is what makes `writeArtifacts` and `verify` two views
 * of the same bytes: one writes them, the other compares them.
 *
 * The semantic cache is read here rather than passed in so that a build and a
 * verification of the same checkout always agree about prose: `greplost
 * verify` in CI must reproduce exactly what `greplost update` wrote, and the
 * only summaries either of them may use are the committed ones.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { buildSnapshot, discoverFiles, serializeSnapshot } from "@greplost/core";
import type { ParseCache, ParserHandle } from "@greplost/core";
import type { GreplostConfig, Snapshot, SummaryCache, SummaryEntry } from "@greplost/core/schema";
import { ARTIFACT_DIR, ARTIFACT_PATHS, compareStrings } from "@greplost/core/schema";
import { renderArtifacts } from "@greplost/render";
import type { MapProvenance } from "@greplost/render";

import { isStructurePath } from "./artifacts.ts";

export interface BuildArtifactsOptions {
  /** Config to build with. Defaults to `.greplost/config.json` merged over the defaults. */
  config?: GreplostConfig;
  /** Parser handle, so a caller that builds twice pays for the WASM grammars once. */
  parser?: ParserHandle;
  /** Extraction cache. Absent means every file is parsed. */
  cache?: ParseCache;
}

export interface BuildResult {
  snapshot: Snapshot;
  /** Every structure artifact, keyed by path relative to `.greplost/`, in sorted key order. */
  files: Map<string, string>;
  /**
   * Repo-relative paths discovery skipped because the path cannot be a map id
   * (it holds a `#`, a newline or a NUL). Sorted; empty for every normal repo.
   * `update` reports the count once; `verify` ignores it, because a skipped
   * file is not drift.
   */
  skipped: string[];
  /**
   * One line per node card the render had to skip because another artifact
   * already claims its path on a case-insensitive filesystem (ruling
   * 2026-09-05). Empty for every normal repo. Not drift either: the skip is a
   * property of the snapshot, so `verify` renders the same artifact set.
   */
  warnings: string[];
}

/**
 * The committed semantic cache (`.greplost/cache/summaries.json`).
 *
 * `{}` when the file is absent, a repo with no semantic layer is the normal
 * case, not an error. A file that exists but cannot be understood is an error:
 * silently treating it as empty would quietly rewrite every card that carries
 * prose, and the manifest's staleness fields with them.
 */
export function readSummaries(root: string): SummaryCache {
  const file = path.join(root, ARTIFACT_DIR, ARTIFACT_PATHS.summaries);
  if (!existsSync(file)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new Error(`greplost: cannot read ${ARTIFACT_DIR}/${ARTIFACT_PATHS.summaries}: ${reasonOf(cause)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`greplost: ${ARTIFACT_DIR}/${ARTIFACT_PATHS.summaries} is not a summary cache`);
  }

  const summaries: SummaryCache = {};
  for (const hash of Object.keys(parsed).sort(compareStrings)) {
    const entry = parsed[hash];
    if (!isSummaryEntry(entry)) {
      throw new Error(
        `greplost: ${ARTIFACT_DIR}/${ARTIFACT_PATHS.summaries} has a malformed entry for "${hash}"`,
      );
    }
    summaries[hash] = entry;
  }
  return summaries;
}

/**
 * Build every structure artifact for `root`, in memory.
 *
 * The two producers are disjoint by construction (`serializeSnapshot` owns
 * `manifest.json` and `graph/*.jsonl`, `renderArtifacts` owns the markdown), and
 * both are asserted here: a collision or a path outside the structure set would
 * mean `writeArtifacts` could clobber or prune something it does not own, so it
 * fails loudly at the source rather than on disk.
 */
export async function buildArtifacts(root: string, opts: BuildArtifactsOptions = {}): Promise<BuildResult> {
  const absoluteRoot = path.resolve(root);
  const summaries = readSummaries(absoluteRoot);

  const skipped: string[] = [];
  const snapshot = await buildSnapshot({
    root: absoluteRoot,
    summaries,
    skipped,
    ...(opts.config === undefined ? {} : { config: opts.config }),
    ...(opts.parser === undefined ? {} : { parser: opts.parser }),
    ...(opts.cache === undefined ? {} : { cache: opts.cache }),
  });

  const merged = new Map<string, string>();
  const add = (source: string, produced: Map<string, string>): void => {
    for (const [rel, contents] of produced) {
      if (merged.has(rel)) {
        throw new Error(`greplost: internal error: ${source} produced a duplicate artifact path ${rel}`);
      }
      if (!isStructurePath(rel)) {
        throw new Error(`greplost: internal error: ${source} produced a non-structure artifact path ${rel}`);
      }
      merged.set(rel, contents);
    }
  };
  const warnings: string[] = [];
  add("serializeSnapshot", serializeSnapshot(snapshot));
  add(
    "renderArtifacts",
    renderArtifacts({ snapshot, summaries, warnings, provenance: await provenanceOf(absoluteRoot, snapshot) }),
  );

  // Sorted, so the map's iteration order does not depend on which producer ran
  // first; `verify` reports "the first divergent path" and means this order.
  const files = new Map<string, string>();
  for (const rel of [...merged.keys()].sort(compareStrings)) {
    files.set(rel, merged.get(rel) as string);
  }

  return { snapshot, files, skipped, warnings };
}

/**
 * The one fact `INDEX.md`'s provenance line needs and the render layer cannot
 * see, because it has no filesystem (leaf 2.15).
 *
 * A second discovery pass with the exclude patterns dropped, minus the files
 * the map actually holds: exactly "how many files in a language this map
 * indexes did the config exclude", which is what tells a reader whether the
 * absence of every `_test.go` is a setting or a bug. It reuses `discoverFiles`,
 * so the language rule and the include rule can never diverge from the ones the
 * build itself applied.
 *
 * A function of the source tree and nothing else, so `update` and `verify` on
 * the same content produce the same line, byte for byte, wherever they run.
 */
async function provenanceOf(root: string, snapshot: Snapshot): Promise<MapProvenance> {
  const everything = await discoverFiles(root, { ...snapshot.config, exclude: countingExcludes(snapshot.config) });
  const indexed = Object.keys(snapshot.manifest.files).length;
  return { excluded: Math.max(0, everything.length - indexed) };
}

/**
 * The excludes the counting pass keeps: every one the config lists except the
 * test-shaped ones, whose absence is the thing being counted (fix round 1, I3).
 *
 * Dropping *all* of them made the figure depend on the environment rather than
 * on the source. Inside a git checkout, discovery asks git, which never lists
 * gitignored build output; outside one it walks the disk, which does. `dist/`,
 * `build/` and `*.d.ts` therefore have to stay excluded on both sides, or the
 * same tree renders two different `INDEX.md` files and `verify` calls the
 * difference drift.
 *
 * What is left is precisely "how many files did the test patterns keep out",
 * which is the sentence `INDEX.md` prints. A pattern the repository added
 * itself is not a test pattern and stays applied, so its files are never
 * counted as tests.
 */
function countingExcludes(config: GreplostConfig): string[] {
  const kept = config.exclude.filter((pattern) => !TEST_PATTERNS.has(pattern));
  // Never walked, whatever the config says: an installed dependency tree and
  // git's own object store are not this repository's source, and outside a
  // checkout the counting pass would otherwise walk `node_modules`.
  for (const pattern of ["**/node_modules/**", "**/.git/**"]) {
    if (!kept.includes(pattern)) kept.push(pattern);
  }
  return kept;
}

/**
 * The default patterns that exist to keep tests out of the map (tech spec
 * Appendix B's `DEFAULT_CONFIG`). Matched by their exact text, so a repository
 * that rewrote one owns the result and its files stay excluded from the count.
 */
const TEST_PATTERNS: ReadonlySet<string> = new Set([
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/testdata/**",
  "**/*_test.go",
  "**/test_*.py",
  "**/*_test.py",
  "**/conftest.py",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSummaryEntry(value: unknown): value is SummaryEntry {
  return (
    isPlainObject(value) &&
    typeof value["path"] === "string" &&
    typeof value["text"] === "string" &&
    typeof value["refreshedAt"] === "string" &&
    typeof value["model"] === "string"
  );
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
