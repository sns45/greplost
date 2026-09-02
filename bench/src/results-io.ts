/**
 * Committed benchmark results (bench spec "Shared conventions", tech spec 10.9).
 *
 * Every suite writes through here so results land at one path shape,
 * `bench/results/<suite>-<YYYY-MM-DD>-<sha7>.json`, with stable, sorted JSON.
 *
 * The date, the greplost SHA and `recordedAt` are the only environment values allowed in
 * a results file (tech spec 5.3 forbids them in structure-layer output, not here; bench
 * payloads may carry a timestamp, the structure layer may not — ruling 2026-09-04);
 * machine and corpus pinning are the caller's to supply.
 *
 * **`recordedAt` is the ordering key.** The file name carries a date and a short sha, and
 * a short sha does not sort by time: `latestResult` used to take the lexicographically
 * greatest name, so a run at `173a463` lost to an earlier run at `b908e0f` and the report
 * named the wrong commit in its Versions table. Every payload written from here therefore
 * carries the wall-clock instant it was produced, and `latestResult` orders on that.
 * Results committed before the stamp existed have no `recordedAt`; they sort before every
 * stamped payload, because nothing in an unstamped file can show it to be the newer one.
 * A rerun at the same date and sha still overwrites the same path, so the directory does
 * not grow, but its bytes now differ by the stamp.
 *
 * `GREPLOST_BENCH_RESULTS_DIR` redirects every write away from `bench/results/`. It exists
 * **for tests only**, so a test can drive a suite's `run()` end to end without leaving a
 * file in the working tree. Nothing in normal operation sets it, and a suite that sees it
 * outside a test run says so on stderr: a benchmark whose results silently went somewhere
 * else is worse than one that did not run.
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
 * `$GREPLOST_BENCH_RESULTS_DIR` (test-only, see the header), else `bench/results`.
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

/** The instant a result was produced, ISO 8601 in UTC (`2026-09-02T16:20:09.001Z`). */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Write one suite result and return the absolute path written.
 *
 * `suite`, `date`, `greplostSha` and `recordedAt` are filled in when the payload does not
 * set them; an explicit value wins, which is what lets the report suite rewrite a
 * historical run without restamping it as today's.
 */
export function writeResult(suite: string, payload: object, dir?: string): string {
  const record = payload as Record<string, unknown>;
  const date = typeof record["date"] === "string" ? record["date"] : todayIso();
  const sha = typeof record["greplostSha"] === "string" ? record["greplostSha"] : gitSha7();
  const recordedAt = typeof record["recordedAt"] === "string" ? record["recordedAt"] : nowIso();
  const full = { suite, ...record, date, greplostSha: sha, recordedAt };

  const target = resultsDir(dir);
  mkdirSync(target, { recursive: true });
  const file = path.join(target, `${suite}-${date}-${sha}.json`);
  writeFileSync(file, `${stableStringify(full, 2)}\n`);
  return file;
}

/**
 * Every result file for a suite, oldest first.
 *
 * The order is `(recordedAt, file name)`, with unstamped payloads (written before the
 * stamp existed) ahead of every stamped one, ordered among themselves by name. A payload
 * that cannot be parsed is dropped rather than taking the caller down with it.
 */
export function orderedResults(
  suite: string,
  dir?: string,
): { file: string; name: string; payload: Record<string, unknown> }[] {
  const target = resultsDir(dir);
  if (!existsSync(target)) return [];
  const pattern = new RegExp(`^${escapeRegExp(suite)}-\\d{4}-\\d{2}-\\d{2}-[^/]*\\.json$`);
  const found = readdirSync(target)
    .filter((name) => pattern.test(name))
    .flatMap((name) => {
      const file = path.join(target, name);
      try {
        const payload = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        const stamp = payload["recordedAt"];
        return [{ file, name, payload, stamp: typeof stamp === "string" ? stamp : "" }];
      } catch {
        return [];
      }
    });
  found.sort(
    (a, b) =>
      // "" sorts before every real ISO instant, which is exactly the rule: an
      // unstamped result never displaces a stamped one.
      compareStrings(a.stamp, b.stamp) || compareStrings(a.name, b.name),
  );
  return found.map(({ file, name, payload }) => ({ file, name, payload }));
}

/** The newest result for a suite, by `recordedAt` and then by file name. */
export function latestResult(
  suite: string,
  dir?: string,
): { file: string; payload: Record<string, unknown> } | undefined {
  const ordered = orderedResults(suite, dir);
  const newest = ordered[ordered.length - 1];
  return newest === undefined ? undefined : { file: newest.file, payload: newest.payload };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
