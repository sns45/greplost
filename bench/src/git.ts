/**
 * Git plumbing and the one statistic both bench suites report (bench spec 1.5.5).
 *
 * `replay.ts` and `perf.ts` both need a private, writable checkout of a corpus
 * repo that never disturbs the corpus clone, and both report percentiles over
 * the same kind of sample. One implementation of each lives here so a fix to
 * "how a working copy is made" cannot land in one suite and not the other.
 *
 * Every git call is bounded. A corpus clone made by `corpus.ts` is a partial
 * clone whose promisor remote is GitHub, so even a `checkout` is a call that can
 * go to the network; without a timeout a replay that loses its connection hangs
 * forever inside a suite whose whole job is to produce a number.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Ceiling on one git call.
 *
 * Generous on purpose: the slow calls here are network fetches against a
 * promisor remote, and a five-minute clone of a large repo on a poor connection
 * is slow rather than broken. What this rules out is the unbounded case.
 */
export const GIT_TIMEOUT_MS = 300_000;

/** Longer, because it is one fetch of every blob in the working copy's history. */
export const BACKFILL_TIMEOUT_MS = 900_000;

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Extra environment for this call only. */
  env?: Record<string, string>;
  /** Milliseconds before the call is killed; `GIT_TIMEOUT_MS` by default. */
  timeout?: number;
}

/**
 * Run git in `cwd`. Never throws: every caller decides what a failure means.
 *
 * A timeout comes back as a failed `GitResult` whose `stderr` names the command
 * and the limit, so a caller that turns it into an exception (`gitOrThrow`) or
 * into a suite error reports something a person can act on rather than
 * "status 1".
 */
export function git(cwd: string, args: string[], opts: GitOptions = {}): GitResult {
  const timeout = opts.timeout ?? GIT_TIMEOUT_MS;
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    env: opts.env === undefined ? process.env : { ...process.env, ...opts.env },
  });
  if (res.error) {
    // `spawnSync` reports both "git is not on PATH" and "the timeout fired" as
    // `error`; only the second carries the kill signal, and only it is worth a
    // different sentence.
    const timedOut = res.signal === "SIGKILL" || (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return {
      status: 124,
      stdout: res.stdout ?? "",
      stderr: timedOut
        ? `"git ${args.join(" ")}" in ${cwd} exceeded ${timeout}ms and was killed ` +
          "(a corpus working copy fetches missing blobs from its promisor remote, so this call can be network-bound)"
        : `could not run "git ${args.join(" ")}": ${res.error.message}`,
    };
  }
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Run git in `cwd`, or throw with git's own message. */
export function gitOrThrow(cwd: string, args: string[], opts: GitOptions = {}): string {
  const res = git(cwd, args, opts);
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout;
}

/**
 * True when `dir` is a partial clone: it holds commits and trees whose blobs it
 * has never downloaded, and fetches them from its promisor remote on demand.
 * `corpus.ts` clones every corpus repo this way (`--filter=blob:none`).
 */
export function isPartialClone(dir: string): boolean {
  const promisor = git(dir, ["config", "--get", "remote.origin.promisor"]);
  if (promisor.status === 0 && promisor.stdout.trim() === "true") return true;
  const extension = git(dir, ["config", "--get", "extensions.partialclone"]);
  return extension.status === 0 && extension.stdout.trim() !== "";
}

export interface CloneOptions {
  /**
   * Download every blob the working copy's history needs, once, before anything
   * is checked out. See `backfillBlobs`.
   */
  backfill?: boolean;
}

/**
 * A private working copy of `source`, checked out at `sha`.
 *
 * Two ways to make one, and which is right depends on the source.
 *
 * `git clone --shared` is the cheap one: the objects stay where they are and
 * the clone cannot write to them. It is wrong for a partial clone, twice over.
 * It fails outright, because the local transport asks the source for objects it
 * has never downloaded and dies mid-pack; and even where it survives it drops
 * `remote.origin.promisor`, so the copy has no way to fetch the blobs of an
 * older commit and every checkout before the pinned one fails on a missing
 * object. Copying `.git` wholesale keeps the shallow boundary, the filter and
 * the promisor remote, so the working copy backfills blobs from the real remote
 * exactly as the corpus clone would.
 *
 * Both paths only ever read the source, which is the invariant that matters:
 * the corpus clone is shared with every other suite and a replay must not be
 * able to disturb it.
 */
export function cloneWorkingCopy(source: string, dest: string, sha: string, opts: CloneOptions = {}): void {
  rmSync(dest, { recursive: true, force: true });
  let cloned = false;
  if (!isPartialClone(source)) {
    cloned = git(path.dirname(dest), ["clone", "--quiet", "--shared", "--no-checkout", source, dest]).status === 0;
  }
  if (!cloned) {
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(path.join(source, ".git"), path.join(dest, ".git"), { recursive: true });
  }
  if (opts.backfill === true) backfillBlobs(dest);
  gitOrThrow(dest, ["checkout", "--quiet", "--force", sha]);
}

/**
 * Download every blob this working copy's history needs, in one fetch.
 *
 * Without it, a partial working copy fetches on demand: a commit replay checks
 * out several hundred commits and each checkout that needs an undownloaded blob
 * goes to the network. That is a benchmark whose wall clock is someone's
 * connection, that cannot run offline, and that dies halfway through if the
 * remote becomes unreachable. One `--refetch --no-filter` pays that cost once,
 * bounded by the clone's shallow boundary, and every checkout afterwards is
 * local.
 *
 * Not fatal when it fails. A repository that was never partial has nothing to
 * backfill, and a machine with no network can still replay a clone whose blobs
 * happen to be present; the suite should try the cheap thing and carry on
 * rather than refuse to measure. The outcome is returned so a caller can say
 * which of those happened.
 */
export function backfillBlobs(dir: string): { backfilled: boolean; reason?: string } {
  if (!isPartialClone(dir)) return { backfilled: false, reason: "not a partial clone" };
  const res = git(dir, ["fetch", "--quiet", "--refetch", "--no-filter", "origin"], {
    timeout: BACKFILL_TIMEOUT_MS,
  });
  if (res.status !== 0) {
    return { backfilled: false, reason: res.stderr.trim().split("\n").slice(-1)[0] ?? "fetch failed" };
  }
  // The filter config survives a `--refetch`, and leaving it set would let a
  // later call decide it is allowed to fetch again. Every object is here now.
  git(dir, ["config", "--unset", "remote.origin.partialclonefilter"]);
  git(dir, ["config", "--unset", "remote.origin.promisor"]);
  return { backfilled: true };
}

/** Directory entries never worth copying into a scratch repository. */
const COPY_SKIP: ReadonlySet<string> = new Set([".git", "node_modules", ".greplost"]);

/**
 * Copy a source tree into a scratch directory, minus anything derived.
 *
 * `node_modules` would be copied file by file for no benefit, `.git` would give
 * the scratch repo two histories, and a stray `.greplost/` would seed the
 * measurement with a map nobody built.
 */
export function copySourceTree(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    filter: (source) => !COPY_SKIP.has(path.basename(source)),
  });
}

/**
 * Nearest-rank percentile over `samples` (unsorted input is fine).
 *
 * Nearest rank rather than interpolation: every reported value is a
 * measurement that actually happened, which is what a latency gate should be
 * argued about. `0` for an empty sample set.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] as number;
}
