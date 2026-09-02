/**
 * Competitor artifact adapters: shared contract and helpers (bench leaf 1.5.2).
 *
 * Every competitor is scored by the same code against the same compiler truth
 * (tech spec 10.0), so each tool's own artifact has to be translated into
 * greplost's edge schema (5.4) first. This file holds the two interfaces the
 * bench design spec fixes, plus the three things all three adapters need and
 * must agree on: path re-anchoring, edge collection, and artifact reading.
 *
 * Nothing here is tool-specific. Every tool-specific mapping decision lives in
 * `graphify.ts`, `ua.ts` and `crg.ts`, commented line by line, so the
 * maintainers of each tool can review exactly what we claim their graph says.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { Confidence, Edge } from "@greplost/core/schema";
import { compareEdges, compareStrings, symbolId } from "@greplost/core/schema";

/** One competitor's graph, translated into greplost ids and edges. */
export interface CompetitorArtifact {
  tool: "graphify" | "ua" | "crg";
  /**
   * The pinned competitor version this adapter targets, i.e. the `version`
   * field of the matching `bench/competitors.json` entry.
   *
   * Not read out of the artifact on purpose: two of the three formats carry no
   * version of their own (graphify's `graph.json` and crg's JSON export both
   * omit one), so a per-artifact version would be absent for most tools and
   * would make the results table lie about what was measured.
   */
  version: string;
  /** kind "import" edges between two repo files, sorted with compareEdges. */
  imports: Edge[];
  /** kind "call" edges, sorted with compareEdges. */
  calls: Edge[];
  /**
   * Every greplost id the adapter could map, sorted and unique. Always a
   * superset of the endpoints of `imports` and `calls`.
   *
   * Nothing here is filtered against greplost's own `include` / `exclude`
   * config: an adapter translates, it does not judge. A competitor that indexes
   * `*.test.ts` will have ids for them, and the head-to-head scorer (leaf
   * 1.5.7) has to restrict truth and every prediction to the same file set
   * before comparing, or the competitor is charged false positives for files
   * greplost simply chose not to look at.
   */
  nodes: string[];
  /**
   * What was read: `files` are the artifact files the adapter actually opened,
   * relative to the directory it was pointed at (posix, sorted); `bytes` is
   * their total size on disk.
   */
  raw: { files: string[]; bytes: number };
}

export interface Adapter {
  tool: CompetitorArtifact["tool"];
  /** True when `dir` holds this tool's artifact, at its documented path. */
  detect(dir: string): boolean;
  /**
   * Translate the artifact in `dir`.
   *
   * `repoRoot` is the root the artifact's paths are anchored at, which is the
   * checkout the tool was run in — not necessarily the checkout being scored.
   * Absolute paths in the artifact are made relative to it; anything that
   * cannot be placed under it is dropped rather than guessed at.
   *
   * Throws an Error with a `greplost:` message when the artifact is missing or
   * unparseable.
   */
  load(dir: string, repoRoot: string): CompetitorArtifact;
}

// ---------------------------------------------------------------------------
// Path re-anchoring
// ---------------------------------------------------------------------------

/** Windows separators to posix. Competitor artifacts are written on any OS. */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Posix absolute (`/x`) or Windows absolute (`C:/x`, `//server/share`). */
function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:/.test(p);
}

/**
 * Turn a path from a competitor artifact into a greplost file id: a
 * repo-relative posix path with no leading `/` and no `..`.
 *
 * Returns null when the path cannot be placed inside `repoRoot` — an absolute
 * path from another checkout, a path that escapes the root, an empty string.
 * Dropping beats guessing: a wrong file id silently invents a false positive
 * for the tool being scored, which is worse for it than a missing edge.
 */
export function toRepoRelative(raw: string | null | undefined, repoRoot: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let rel = toPosix(raw).trim();
  if (rel.length === 0) return null;

  // Prefix matching is case-sensitive on purpose. A case-insensitive match
  // would be right on a Windows or default-macOS checkout and wrong on Linux,
  // and greplost ids are case-sensitive either way, so an artifact whose root
  // casing differs from the checkout's is a mismatch worth surfacing as dropped
  // edges rather than papering over.
  const root = toPosix(repoRoot).replace(/\/+$/, "");
  if (root.length > 0) {
    if (rel === root) return null; // the root itself is a directory, not a file
    if (rel.startsWith(`${root}/`)) rel = rel.slice(root.length + 1);
  }
  if (isAbsolutePath(rel)) return null; // absolute and not under the root

  const out: string[] = [];
  for (const segment of rel.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null; // escapes the repo root
      out.pop();
      continue;
    }
    out.push(segment);
  }
  if (out.length === 0) return null;
  const joined = out.join("/");
  // `#` is the file/symbol separator in a greplost id; a path containing one
  // could not be told apart from a symbol id.
  return joined.includes("#") ? null : joined;
}

/**
 * Build a greplost symbol id, or null when the pieces cannot make a valid one.
 * `symbolPath` is the tool's own symbol path (`Class.member` where the tool
 * models members at all).
 */
export function toSymbolId(file: string | null, symbolPath: string): string | null {
  if (file === null) return null;
  const name = symbolPath.trim();
  if (name.length === 0 || name.includes("#")) return null;
  return symbolId(file, name);
}

// ---------------------------------------------------------------------------
// Edge collection
// ---------------------------------------------------------------------------

interface PendingEdge {
  from: string;
  to: string;
  kind: Edge["kind"];
  confidence: Confidence;
  symbols: Set<string>;
}

/**
 * Collects edges keyed on (from, to, kind), which is exactly the key the bench
 * scores imports and calls on (bench design spec, "Shared conventions").
 *
 * De-duplication is not cosmetic. Every one of these tools emits the same
 * dependency more than once — graphify writes a file-level `imports_from` edge
 * and a symbol-level `imports` edge for one `import { x } from "y"` statement,
 * ua emits one `imports` edge per resolved specifier so two imports of the same
 * module double up, crg stores one row per import statement. Counting those
 * twice would inflate the tool's edge count without changing its precision.
 */
export class EdgeSet {
  private readonly entries = new Map<string, PendingEdge>();

  add(
    from: string,
    to: string,
    kind: Edge["kind"],
    confidence: Confidence,
    symbols: readonly string[] = [],
  ): void {
    // A file importing itself is not a dependency in any of the three models;
    // it only ever shows up as a resolver artefact. Calls may be self-recursive,
    // so only imports are filtered.
    if (kind !== "call" && from === to) return;

    const key = `${from}\u0000${to}\u0000${kind}`;
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { from, to, kind, confidence, symbols: new Set() };
      this.entries.set(key, entry);
    } else if (confidence === "high") {
      // Merging a high-confidence duplicate onto a med one: the tool did assert
      // the edge outright at least once, so the stronger claim stands.
      entry.confidence = "high";
    }
    for (const s of symbols) if (s.length > 0) entry.symbols.add(s);
  }

  /** Sorted with compareEdges, per the determinism contract in schema.ts. */
  finish(): Edge[] {
    const out: Edge[] = [];
    for (const e of this.entries.values()) {
      const symbols = [...e.symbols].sort(compareStrings);
      out.push(
        symbols.length > 0
          ? { from: e.from, to: e.to, kind: e.kind, confidence: e.confidence, symbols }
          : { from: e.from, to: e.to, kind: e.kind, confidence: e.confidence },
      );
    }
    return out.sort(compareEdges);
  }
}

/** Sorted, unique node id list for a CompetitorArtifact. */
export function sortedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort(compareStrings);
}

// ---------------------------------------------------------------------------
// Artifact reading
// ---------------------------------------------------------------------------

export interface ReadArtifact {
  /** Parsed JSON. */
  data: unknown;
  /** Path read, relative to `dir`, posix. */
  file: string;
  bytes: number;
}

/**
 * Read the first of `candidates` (relative to `dir`) that exists.
 * `candidates` is ordered: current documented path first, legacy paths after.
 */
export function readFirstJson(dir: string, candidates: readonly string[], tool: string): ReadArtifact {
  for (const candidate of candidates) {
    const full = path.join(dir, ...candidate.split("/"));
    if (!existsSync(full)) continue;
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch (err) {
      throw new Error(`greplost: cannot read ${tool} artifact ${candidate}: ${(err as Error).message}`);
    }
    try {
      return { data: JSON.parse(text) as unknown, file: candidate, bytes: statSync(full).size };
    } catch (err) {
      throw new Error(`greplost: ${tool} artifact ${candidate} is not valid JSON: ${(err as Error).message}`);
    }
  }
  throw new Error(
    `greplost: no ${tool} artifact in ${dir} (looked for ${candidates.join(", ")}); ` +
      `run the tool's documented command from bench/competitors.json first`,
  );
}

/** True when `dir` holds any of `candidates`. */
export function hasAny(dir: string, candidates: readonly string[]): boolean {
  return candidates.some((c) => existsSync(path.join(dir, ...c.split("/"))));
}

// ---------------------------------------------------------------------------
// Small JSON access helpers. Competitor artifacts are third-party data: every
// field is optional until proven otherwise, and a malformed one is skipped, not
// thrown on — one bad row must not cost the tool its whole graph.
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
