/**
 * The incremental update (tech spec 8, Appendix C; sync spec "Update").
 *
 * The ruling this module implements is the one that makes freshness provable:
 * an incremental update and a full rebuild produce byte-identical `.greplost/`
 * trees, by construction rather than by care. Both render the entire map in
 * memory from the checkout; both write only the bytes that differ. Nothing is
 * patched, so nothing can drift. What "incremental" buys is not a smaller
 * write — `writeArtifacts` already reduces that to the artifacts that actually
 * changed — but a smaller parse: files whose sha256 has not moved come back
 * out of `.greplost/cache/parse.json` instead of through tree-sitter.
 *
 * That leaves the dirty set with exactly one job: deciding whether there is
 * anything to do at all. It is not used to select what to rebuild (selective
 * regeneration is what the write layer does, and it does it from bytes rather
 * than from a guess about dependencies). It answers "is this checkout already
 * indexed?", and the answer has to be conservative in one direction only —
 * a false "dirty" costs a rebuild that writes nothing, a false "clean" leaves
 * a stale map, which is the one failure greplost promises cannot happen.
 *
 * So the dirty set unions every signal available: what the editor hooks
 * recorded, what the caller passed, what git has committed since the map was
 * built, and what is sitting uncommitted in the working tree. And the clean
 * fast path fires only when git can positively confirm the checkout has not
 * moved: without git there is no such confirmation, so every run rebuilds.
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { ParseCache } from "@greplost/core";
import type { FileRecord, Lang, Snapshot } from "@greplost/core/schema";
import { compareStrings } from "@greplost/core/schema";

import { buildArtifacts } from "./build.ts";
import { appendDirty, readAndClearDirty, toRepoRelative } from "./dirty.ts";
import { withLock } from "./lock.ts";
import { FileParseCache, parseCacheKey } from "./parse-cache.ts";
import { readState, writeState } from "./state.ts";
import { writeArtifacts } from "./write.ts";

export interface UpdateOptions {
  /** `"full"` ignores the dirty set, the clean fast path and the cache's reads. */
  mode: "incremental" | "full";
  /** Extra paths to treat as dirty, from a caller that already knows what it changed. */
  files?: string[];
  /** Suppress the one-line summary. */
  quiet?: boolean;
}

export interface UpdateResult {
  mode: "incremental" | "full";
  /** Size of the dirty set that triggered this run; always 0 for a full update. */
  dirty: number;
  /** Files parsed because the cache did not have them. */
  reparsed: number;
  /** Files answered from the parse cache. */
  cached: number;
  /** Artifacts whose bytes changed. */
  written: number;
  /** Artifacts pruned because the map no longer produces them. */
  deleted: number;
  /** Wall-clock milliseconds. */
  ms: number;
  /** Why nothing was done, when nothing was done. */
  skipped?: "locked" | "clean";
}

/**
 * Bring `.greplost/` into line with the checkout at `root`.
 *
 * Never throws for the two ordinary "nothing to do" outcomes: another process
 * holds the lock (`skipped: "locked"`) or the checkout is already indexed
 * (`skipped: "clean"`). Both are normal on a machine where a git hook, an
 * editor hook and a human can all fire within the same second.
 */
export async function update(root: string, opts: UpdateOptions): Promise<UpdateResult> {
  const absoluteRoot = path.resolve(root);
  const started = performance.now();

  const done = await withLock(absoluteRoot, () => runUpdate(absoluteRoot, opts, started));
  if (done !== undefined) return done;

  // Another live process is already doing this work, or is about to. Hooks
  // must never queue: the next trigger catches up, and the dirty file is
  // untouched because it is only ever read inside the lock.
  return report(
    { ...empty(opts.mode, started), skipped: "locked" },
    opts.quiet,
  );
}

async function runUpdate(root: string, opts: UpdateOptions, started: number): Promise<UpdateResult> {
  const incremental = opts.mode === "incremental";
  const git = gitContext(root);

  // Consumed in both modes: a full rebuild indexes everything the dirty file
  // could possibly be pointing at, so leaving the entries behind would only
  // make the next incremental run redo work that is already done (tech spec
  // 8.8, "Clear .dirty").
  const consumed = readAndClearDirty(root);

  let dirty: string[] = [];
  if (incremental) {
    const state = readState(root);
    const indexed = isCommitish(state.lastIndexedCommit) ? state.lastIndexedCommit : undefined;

    dirty = uniqueSorted([
      ...consumed,
      ...normalisePaths(root, opts.files ?? []),
      // What git has recorded since the map was built. Skipped when the map
      // was built from HEAD itself: the diff is empty by definition, and this
      // is the hot path — the plugin's `Stop` hook runs it after every turn,
      // so two fewer process spawns is most of what it costs.
      ...(indexed !== undefined && indexed !== git.head && commitExists(root, indexed)
        ? committedSince(root, indexed)
        : []),
      // ...and what has not been recorded at all.
      ...workingTreePaths(root),
    ]);

    // Clean means: nothing is dirty (which subsumes an empty `git status`, one
    // of its inputs) and HEAD is exactly the commit the map was built from.
    // `git.head === undefined` — no git, or a repo with no commits — can never
    // confirm that, so those repositories always rebuild rather than trusting
    // a state file that nothing corroborates.
    if (dirty.length === 0 && git.head !== undefined && state.lastIndexedCommit === git.head) {
      return report({ ...empty(opts.mode, started), skipped: "clean" }, opts.quiet);
    }
  }

  try {
    const store = new FileParseCache(root);
    store.load();
    // A full update ignores the cache for reads but still fills it, so the
    // next incremental run starts warm. That is also what makes `--full` the
    // repair for a cache someone has corrupted.
    const cache = new CountingCache(store, incremental);

    const { snapshot, files } = await buildArtifacts(root, { cache });
    store.save(usedKeys(snapshot));

    const written = writeArtifacts(root, files);
    // The commit read before the build, not after: a commit that landed while
    // this ran is not indexed by it, and recording it would mean the next run
    // diffs from a commit whose changes never reached the map.
    writeState(root, git.head === undefined ? {} : { lastIndexedCommit: git.head });

    return report(
      {
        mode: opts.mode,
        dirty: dirty.length,
        reparsed: cache.misses,
        cached: cache.hits,
        written: written.written.length,
        deleted: written.deleted.length,
        ms: elapsed(started),
      },
      opts.quiet,
    );
  } catch (cause) {
    // The dirty entries were consumed by a run that then failed; without this
    // they would be lost, and an edit that git cannot see (an untracked file
    // the editor touched) would stay out of the map until something else
    // dirtied it.
    if (consumed.length > 0) appendDirty(root, consumed);
    throw cause;
  }
}

/**
 * A `ParseCache` that counts, and that can be told not to answer.
 *
 * `reparsed`/`cached` are the only visible evidence that incremental mode did
 * anything at all — the artifacts it writes are identical either way — so they
 * are measured at the boundary rather than inferred. Blocking reads (rather
 * than not passing a cache at all) is what lets a full rebuild still populate
 * the cache for the next run.
 */
class CountingCache implements ParseCache {
  hits = 0;
  misses = 0;

  constructor(
    private readonly inner: FileParseCache,
    private readonly readable: boolean,
  ) {}

  get(sha256: string, lang: Lang): FileRecord | undefined {
    const hit = this.readable ? this.inner.get(sha256, lang) : undefined;
    if (hit === undefined) this.misses++;
    else this.hits++;
    return hit;
  }

  set(record: FileRecord): void {
    this.inner.set(record);
  }
}

/** The cache keys this build used: everything else in the file is history. */
function usedKeys(snapshot: Snapshot): Set<string> {
  const keys = new Set<string>();
  for (const file of snapshot.files) keys.add(parseCacheKey(file.sha256, file.lang));
  return keys;
}

function empty(mode: "incremental" | "full", started: number): UpdateResult {
  return { mode, dirty: 0, reparsed: 0, cached: 0, written: 0, deleted: 0, ms: elapsed(started) };
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

/**
 * One line, or nothing. A git hook runs this on every commit, so the default
 * output has to be something a person can ignore and a person who is watching
 * can still learn from.
 */
function report(result: UpdateResult, quiet: boolean | undefined): UpdateResult {
  if (quiet === true) return result;

  if (result.skipped === "locked") console.log("greplost: another update is already running");
  else if (result.skipped === "clean") console.log("greplost: map is up to date");
  else {
    const parts = [
      `${result.written} written`,
      `${result.deleted} deleted`,
      `${result.reparsed} parsed`,
      `${result.cached} cached`,
    ];
    console.log(`greplost: ${result.mode} update in ${result.ms}ms (${parts.join(", ")})`);
  }
  return result;
}

interface GitContext {
  /** True when `root` is the top level of a git work tree. */
  available: boolean;
  /** HEAD as of the start of the update; absent outside git or before the first commit. */
  head?: string;
}

/**
 * What git can tell us about `root`.
 *
 * Deliberately strict: git counts only when `root` *is* the top level of the
 * work tree. `git status --porcelain` reports paths relative to the top level
 * whatever directory it is run from, so anywhere else those paths would be
 * resolved against the wrong root — quietly producing a dirty set full of
 * paths that do not exist. A subdirectory therefore behaves like a
 * non-repository: correct, just never "clean".
 */
function gitContext(root: string): GitContext {
  const toplevel = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (toplevel === undefined || toplevel.trim() === "") return { available: false };
  if (!samePath(root, toplevel.trim())) return { available: false };

  const head = runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const commit = head === undefined ? "" : head.trim();
  return commit === "" ? { available: true } : { available: true, head: commit };
}

/** Everything uncommitted: staged, unstaged, untracked, and both sides of a rename. */
function workingTreePaths(root: string): string[] {
  const out = runGit(root, ["status", "--porcelain", "-z"]);
  if (out === undefined) return [];

  const paths: string[] = [];
  const entries = out.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    // "XY <path>": two status letters, a space, then at least one character.
    if (entry === undefined || entry.length < 4) continue;
    paths.push(entry.slice(3));
    // A rename or copy carries its source in the next NUL-separated field.
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") {
      const origin = entries[++i];
      if (origin !== undefined && origin !== "") paths.push(origin);
    }
  }
  return normalisePaths(root, paths);
}

/** Paths the commits between `indexed` and HEAD touched. */
function committedSince(root: string, indexed: string): string[] {
  const out = runGit(root, ["diff", "--name-only", "-z", `${indexed}..HEAD`, "--"]);
  if (out === undefined) return [];
  return normalisePaths(root, out.split("\0"));
}

/**
 * Does `indexed` still name a commit?
 *
 * It may not: a rebase, an amend, a `reset --hard`, a shallow clone or a
 * pruned branch can all leave the recorded commit unreachable. Asking git
 * first is what keeps that from turning into a failed `git diff` (and, with
 * it, a dirty set that silently loses everything the commits contained).
 */
function commitExists(root: string, indexed: string): boolean {
  return runGit(root, ["rev-parse", "--verify", "--quiet", `${indexed}^{commit}`]) !== undefined;
}

/**
 * A recorded commit has to look like an object name before it is passed to
 * git: `.state.json` is a file on disk, and a value like `--upload-pack=…`
 * reaching an argument list is the difference between a hint and an exploit.
 */
function isCommitish(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{7,64}$/.test(value);
}

function normalisePaths(root: string, paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const candidate of paths) {
    const normalised = toRepoRelative(root, candidate);
    if (normalised !== undefined) out.push(normalised);
  }
  return out;
}

function uniqueSorted(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort(compareStrings);
}

function samePath(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  // `git rev-parse --show-toplevel` always answers with symlinks resolved;
  // `root` frequently is not (every macOS temp directory, for one).
  return realpath(a) === realpath(b);
}

function realpath(target: string): string {
  try {
    return realpathSync(path.resolve(target));
  } catch {
    return path.resolve(target);
  }
}

/** stdout of a git command, or `undefined` when git is missing or the command failed. */
function runGit(root: string, args: string[]): string | undefined {
  const run = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error !== undefined || run.status !== 0) return undefined;
  return run.stdout;
}
