/**
 * Committed benchmark results (bench spec "Shared conventions", tech spec 10.9).
 *
 * Every suite writes through here so results land at one path shape,
 * `bench/results/<suite>-<YYYY-MM-DD>-<sha7>.json`, with stable JSON: the file is
 * committed, so a rerun on the same day at the same commit must produce the same bytes.
 *
 * The date and the greplost SHA are the only environment values allowed in a results
 * file (tech spec 5.3 forbids them in structure-layer output, not here); machine and
 * corpus pinning are the caller's to supply.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compareStrings, stableStringify } from "@greplost/core/schema";

/** Repo root, from `bench/src/results-io.ts`. */
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

/** Where committed results live, relative to the repo root. */
export const RESULTS_DIR = "bench/results";

/**
 * Absolute results directory: `dir` when given (tests use a temp dir), else
 * `$GREPLOST_BENCH_RESULTS_DIR`, else `bench/results`.
 *
 * The environment override exists so a test can drive a whole suite's `run()` without
 * leaving a result file in the working tree; nothing in normal operation sets it.
 */
export function resultsDir(dir?: string): string {
  if (dir !== undefined) return path.resolve(dir);
  const override = process.env["GREPLOST_BENCH_RESULTS_DIR"];
  return override ? path.resolve(override) : path.join(REPO_ROOT, RESULTS_DIR);
}

/** Today as `YYYY-MM-DD` (UTC, so a result file does not depend on the runner's timezone). */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Short SHA of the greplost checkout, or `nogit` outside a git working tree. */
export function gitSha7(cwd: string = REPO_ROOT): string {
  try {
    const out = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{7}$/.test(out) ? out : "nogit";
  } catch {
    return "nogit";
  }
}

/**
 * Write one suite result and return the absolute path written.
 *
 * `suite`, `date` and `greplostSha` are filled in when the payload does not set them;
 * an explicit value wins, which is what lets the report suite rewrite a historical run.
 */
export function writeResult(suite: string, payload: object, dir?: string): string {
  const record = payload as Record<string, unknown>;
  const date = typeof record["date"] === "string" ? record["date"] : todayIso();
  const sha = typeof record["greplostSha"] === "string" ? record["greplostSha"] : gitSha7();
  const full = { suite, ...record, date, greplostSha: sha };

  const target = resultsDir(dir);
  mkdirSync(target, { recursive: true });
  const file = path.join(target, `${suite}-${date}-${sha}.json`);
  writeFileSync(file, `${stableStringify(full, 2)}\n`);
  return file;
}

/** The newest result for a suite by filename (dates and SHAs sort lexicographically). */
export function latestResult(
  suite: string,
  dir?: string,
): { file: string; payload: Record<string, unknown> } | undefined {
  const target = resultsDir(dir);
  if (!existsSync(target)) return undefined;
  const pattern = new RegExp(`^${escapeRegExp(suite)}-\\d{4}-\\d{2}-\\d{2}-[^/]*\\.json$`);
  const names = readdirSync(target)
    .filter((name) => pattern.test(name))
    .sort(compareStrings);
  const newest = names[names.length - 1];
  if (newest === undefined) return undefined;
  const file = path.join(target, newest);
  return { file, payload: JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
