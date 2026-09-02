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

import { buildSnapshot, serializeSnapshot } from "@greplost/core";
import type { ParseCache, ParserHandle } from "@greplost/core";
import type { GreplostConfig, Snapshot, SummaryCache, SummaryEntry } from "@greplost/core/schema";
import { ARTIFACT_DIR, ARTIFACT_PATHS, compareStrings } from "@greplost/core/schema";
import { renderArtifacts } from "@greplost/render";

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
}

/**
 * The committed semantic cache (`.greplost/cache/summaries.json`).
 *
 * `{}` when the file is absent — a repo with no semantic layer is the normal
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

  const snapshot = await buildSnapshot({
    root: absoluteRoot,
    summaries,
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
  add("serializeSnapshot", serializeSnapshot(snapshot));
  add("renderArtifacts", renderArtifacts({ snapshot, summaries }));

  // Sorted, so the map's iteration order does not depend on which producer ran
  // first; `verify` reports "the first divergent path" and means this order.
  const files = new Map<string, string>();
  for (const rel of [...merged.keys()].sort(compareStrings)) {
    files.set(rel, merged.get(rel) as string);
  }

  return { snapshot, files };
}

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
