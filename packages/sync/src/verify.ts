/**
 * The CI backstop (tech spec 7.3, sync spec "Verify").
 *
 * `verify` rebuilds the structure layer in memory from the checkout plus the
 * committed summary cache and compares it, byte for byte, against what is in
 * `.greplost/`. Nothing is written. A non-empty `changed`/`missing`/`extra` is
 * the merge gate that turns "the map is always in sync" from a habit into a
 * guarantee, and the optional unified diff is what makes a red build
 * actionable without a local rerun.
 *
 * The diff is deliberately of one file: a stale map usually diverges in dozens
 * of artifacts at once, and a wall of them tells a reader nothing that the
 * first one and the path lists do not.
 */

import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { ARTIFACT_DIR, compareStrings } from "@greplost/core/schema";

import { listStructurePaths } from "./artifacts.ts";
import { buildArtifacts } from "./build.ts";
import type { BuildArtifactsOptions } from "./build.ts";

export interface VerifyResult {
  ok: boolean;
  /** Structure paths on disk whose bytes differ from the rebuild, sorted. */
  changed: string[];
  /** Structure paths the rebuild produces that are not on disk, sorted. */
  missing: string[];
  /** Structure paths on disk that the rebuild does not produce, sorted. */
  extra: string[];
  /** Unified diff of the first divergent path, when `diff` was requested. */
  diff?: string;
}

export interface VerifyOptions extends BuildArtifactsOptions {
  /** Produce a unified diff of the first divergent path. */
  diff?: boolean;
}

/** Lines of context around each change in the unified diff. */
const CONTEXT_LINES = 3;

/** Hard cap on the diff, truncation marker included. */
const MAX_DIFF_LINES = 200;

const TRUNCATION_MARKER = "… truncated";

/**
 * Bound on the edit distance the line differ will follow. Far beyond what
 * `MAX_DIFF_LINES` can show, and it keeps the O(D²) trace small; past it, the
 * two files are reported as one wholesale replacement, which is both true and
 * all that survives the cap anyway.
 */
const MAX_EDIT_DISTANCE = 600;

export async function verify(root: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const absoluteRoot = path.resolve(root);
  const artifactRoot = path.join(absoluteRoot, ARTIFACT_DIR);

  const { files: expected } = await buildArtifacts(absoluteRoot, {
    ...(opts.config === undefined ? {} : { config: opts.config }),
    ...(opts.parser === undefined ? {} : { parser: opts.parser }),
    ...(opts.cache === undefined ? {} : { cache: opts.cache }),
  });
  const onDisk = new Set(listStructurePaths(artifactRoot));

  const changed: string[] = [];
  const missing: string[] = [];
  const extra: string[] = [];

  for (const rel of [...expected.keys()].sort(compareStrings)) {
    const actual = readArtifact(path.join(artifactRoot, rel));
    if (actual === null) {
      // Unreadable but present (a directory squatting on the path) is a
      // divergence, not an absence: something is there and it is not the map.
      if (onDisk.has(rel)) changed.push(rel);
      else missing.push(rel);
      continue;
    }
    if (!actual.equals(Buffer.from(expected.get(rel) as string, "utf8"))) changed.push(rel);
  }

  for (const rel of [...onDisk].sort(compareStrings)) {
    if (!expected.has(rel)) extra.push(rel);
  }

  const ok = changed.length === 0 && missing.length === 0 && extra.length === 0;
  const result: VerifyResult = { ok, changed, missing, extra };

  if (opts.diff === true && !ok) {
    const target = changed[0] ?? missing[0] ?? (extra[0] as string);
    const before = onDisk.has(target) ? (readArtifact(path.join(artifactRoot, target))?.toString("utf8") ?? "") : "";
    const after = expected.get(target) ?? "";
    result.diff = unifiedDiff(target, before, after);
  }

  return result;
}

/** The bytes of a regular file, or null when the path holds anything else. */
function readArtifact(target: string): Buffer | null {
  try {
    if (!lstatSync(target).isFile()) return null;
    return readFileSync(target);
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Unified diff
// --------------------------------------------------------------------------

type OpKind = "eq" | "del" | "ins";

interface Op {
  kind: OpKind;
  text: string;
}

interface SplitText {
  lines: string[];
  /** The text has content but does not end with a newline. */
  noFinalNewline: boolean;
}

/**
 * A unified diff of one artifact: `a` is what is committed under `.greplost/`,
 * `b` is what a rebuild produces. That direction is what a reader of a failing
 * CI job wants — `-` is what has to go, `+` is what `greplost update` will put
 * there — and it makes a missing artifact read as an addition and an extra one
 * as a removal, exactly as the sync spec describes.
 *
 * Capped at `MAX_DIFF_LINES` lines including the marker, so a wholesale
 * regeneration cannot flood a build log.
 */
export function unifiedDiff(rel: string, a: string, b: string): string {
  const lines = [`--- a/${ARTIFACT_DIR}/${rel}`, `+++ b/${ARTIFACT_DIR}/${rel}`];
  const left = splitLines(a);
  const right = splitLines(b);

  for (const hunk of hunks(newlineAware(diffLines(left.lines, right.lines), left, right))) {
    lines.push(...renderHunk(hunk, left, right));
  }

  if (lines.length > MAX_DIFF_LINES) {
    return [...lines.slice(0, MAX_DIFF_LINES - 1), TRUNCATION_MARKER].join("\n");
  }
  return lines.join("\n");
}

/**
 * Split into lines the way a diff counts them: a trailing newline terminates
 * the last line rather than starting an empty one, and its absence is recorded
 * so the `\ No newline at end of file` marker can be emitted.
 */
function splitLines(text: string): SplitText {
  if (text === "") return { lines: [], noFinalNewline: false };
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
    return { lines, noFinalNewline: false };
  }
  return { lines, noFinalNewline: true };
}

/**
 * Line-level edit script. Common prefix and suffix are stripped first (which is
 * the whole job for the usual "one card moved" case), and only the middle goes
 * through Myers.
 */
function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  let prefix = 0;
  const shortest = Math.min(a.length, b.length);
  while (prefix < shortest && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (suffix < shortest - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  const ops: Op[] = [];
  for (let i = 0; i < prefix; i++) ops.push({ kind: "eq", text: a[i] as string });

  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);
  ops.push(...(myers(middleA, middleB) ?? wholesale(middleA, middleB)));

  for (let i = a.length - suffix; i < a.length; i++) ops.push({ kind: "eq", text: a[i] as string });
  return ops;
}

/**
 * Two texts can differ in bytes and agree on every line: `"x\n"` against `"x"`.
 * Line-level diffing sees no edit there, which would hand a failing build two
 * header lines and no explanation, so the shared last line is respelled as a
 * removal plus an insertion — the same thing git prints, with the
 * `\ No newline at end of file` marker doing the actual telling.
 */
function newlineAware(ops: Op[], left: SplitText, right: SplitText): Op[] {
  if (left.noFinalNewline === right.noFinalNewline) return ops;
  const last = ops[ops.length - 1];
  if (last === undefined || last.kind !== "eq") return ops;
  return [...ops.slice(0, -1), { kind: "del", text: last.text }, { kind: "ins", text: last.text }];
}

/** Every line replaced: the honest answer when the edit distance is past the bound. */
function wholesale(a: readonly string[], b: readonly string[]): Op[] {
  return [
    ...a.map((text): Op => ({ kind: "del", text })),
    ...b.map((text): Op => ({ kind: "ins", text })),
  ];
}

/**
 * Myers' O(ND) shortest edit script, with the per-round frontier recorded so the
 * path can be walked back. Null when the edit distance exceeds
 * `MAX_EDIT_DISTANCE`.
 */
function myers(a: readonly string[], b: readonly string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];

  const limit = Math.min(MAX_EDIT_DISTANCE, n + m);
  const offset = limit + 1;
  const frontier = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d++) {
    trace.push(frontier.slice());
    for (let k = -d; k <= d; k += 2) {
      const goDown =
        k === -d || (k !== d && (frontier[offset + k - 1] as number) < (frontier[offset + k + 1] as number));
      let x = goDown ? (frontier[offset + k + 1] as number) : (frontier[offset + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      frontier[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset);
    }
  }
  return null;
}

/** Walk the recorded frontiers back from (n, m) to the origin, newest move first. */
function backtrack(trace: readonly Int32Array[], a: readonly string[], b: readonly string[], offset: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;

  for (let d = trace.length - 1; d >= 0; d--) {
    const frontier = trace[d] as Int32Array;
    const k = x - y;
    const cameFromAbove =
      k === -d || (k !== d && (frontier[offset + k - 1] as number) < (frontier[offset + k + 1] as number));
    const prevK = cameFromAbove ? k + 1 : k - 1;
    const prevX = frontier[offset + prevK] as number;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ kind: "eq", text: a[x - 1] as string });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: "ins", text: b[y - 1] as string });
      else ops.push({ kind: "del", text: a[x - 1] as string });
      x = prevX;
      y = prevY;
    }
  }

  return ops.reverse();
}

interface Hunk {
  /** Inclusive op-index range covered by the hunk. */
  from: number;
  to: number;
  /** 0-based line index of the first `a` line in the hunk. */
  aStart: number;
  aCount: number;
  bStart: number;
  bCount: number;
  ops: Op[];
}

/** Group the edit script into hunks, each padded with up to `CONTEXT_LINES` of context. */
function hunks(ops: readonly Op[]): Hunk[] {
  const aIndex: number[] = new Array<number>(ops.length);
  const bIndex: number[] = new Array<number>(ops.length);
  let ai = 0;
  let bi = 0;
  for (let i = 0; i < ops.length; i++) {
    aIndex[i] = ai;
    bIndex[i] = bi;
    const kind = (ops[i] as Op).kind;
    if (kind !== "ins") ai++;
    if (kind !== "del") bi++;
  }

  const ranges: Array<{ from: number; to: number }> = [];
  for (let i = 0; i < ops.length; i++) {
    if ((ops[i] as Op).kind === "eq") continue;
    const from = Math.max(0, i - CONTEXT_LINES);
    const to = Math.min(ops.length - 1, i + CONTEXT_LINES);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && from <= last.to + 1) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  }

  return ranges.map((range) => {
    const slice = ops.slice(range.from, range.to + 1);
    return {
      from: range.from,
      to: range.to,
      aStart: aIndex[range.from] as number,
      aCount: slice.filter((op) => op.kind !== "ins").length,
      bStart: bIndex[range.from] as number,
      bCount: slice.filter((op) => op.kind !== "del").length,
      ops: slice,
    };
  });
}

function renderHunk(hunk: Hunk, left: SplitText, right: SplitText): string[] {
  const aFrom = hunk.aCount === 0 ? hunk.aStart : hunk.aStart + 1;
  const bFrom = hunk.bCount === 0 ? hunk.bStart : hunk.bStart + 1;
  const lines = [`@@ -${aFrom},${hunk.aCount} +${bFrom},${hunk.bCount} @@`];

  let ai = hunk.aStart;
  let bi = hunk.bStart;
  for (const op of hunk.ops) {
    if (op.kind === "ins") {
      lines.push(`+${op.text}`);
      if (bi === right.lines.length - 1 && right.noFinalNewline) lines.push(NO_NEWLINE);
      bi++;
      continue;
    }
    if (op.kind === "del") {
      lines.push(`-${op.text}`);
      if (ai === left.lines.length - 1 && left.noFinalNewline) lines.push(NO_NEWLINE);
      ai++;
      continue;
    }
    lines.push(` ${op.text}`);
    const lastOfA = ai === left.lines.length - 1 && left.noFinalNewline;
    const lastOfB = bi === right.lines.length - 1 && right.noFinalNewline;
    if (lastOfA || lastOfB) lines.push(NO_NEWLINE);
    ai++;
    bi++;
  }
  return lines;
}

const NO_NEWLINE = "\\ No newline at end of file";
