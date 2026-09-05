/**
 * The incremental update (tech spec 8, Appendix C; sync spec "Update").
 *
 * The ruling this module implements is the one that makes freshness provable:
 * an incremental update and a full rebuild produce byte-identical `.greplost/`
 * trees, by construction rather than by care. Both render the entire map in
 * memory from the checkout; both write only the bytes that differ. Nothing is
 * patched, so nothing can drift. What "incremental" buys is not a smaller
 * write, `writeArtifacts` already reduces that to the artifacts that actually
 * changed, but a smaller parse: files whose sha256 has not moved come back
 * out of `.greplost/cache/parse.json` instead of through tree-sitter.
 *
 * That leaves the dirty set with exactly one job: deciding whether there is
 * anything to do at all. It is not used to select what to rebuild (selective
 * regeneration is what the write layer does, and it does it from bytes rather
 * than from a guess about dependencies). It answers "is this checkout already
 * indexed?", and the answer has to be conservative in one direction only,
 * a false "dirty" costs a rebuild that writes nothing, a false "clean" leaves
 * a stale map, which is the one failure greplost promises cannot happen.
 *
 * So the dirty set unions every signal available: what the editor hooks
 * recorded, what the caller passed, what git has committed since the map was
 * built, and what is sitting uncommitted in the working tree. It is then
 * narrowed to the paths a build could actually index, because a repository that
 * compiles into its own tree would otherwise never look clean.
 *
 * The clean fast path fires only when git can positively confirm the checkout
 * has not moved, without git there is no such confirmation, so every run
 * rebuilds, and only when the *previous* build indexed a tree that matched its
 * commit. That last condition is what makes a reverted edit visible: HEAD does
 * not move when a change is thrown away, so a map built from the dirty tree
 * would otherwise stay in place, describing code that no longer exists.
 */

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { discoverFiles, langOf, loadConfig, sha256Hex } from "@greplost/core";
import type { ParseCache } from "@greplost/core";
import type { FileRecord, GreplostConfig, Lang, Snapshot } from "@greplost/core/schema";
import {
  ARTIFACT_DIR,
  ARTIFACT_PATHS,
  compareStrings,
  stableStringify,
} from "@greplost/core/schema";

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

  // Everything from here on can throw, an unreadable config, a discovery that
  // fails, a build that fails, and the queue has already been emptied, so all
  // of it runs under the restore below.
  try {
    const state = readState(root);
    const indexed = isCommitish(state.lastIndexedCommit) ? state.lastIndexedCommit : undefined;
    const config = loadConfig(root);
    // The config decides which files are indexed and how they are rendered, so
    // a map built under one config says nothing about what the next one would
    // produce: an edit to `exclude` has to invalidate the fast path exactly the
    // way an edit to a source file does.
    const configHash = sha256Hex(stableStringify(config));

    // What something told us changed, and what git can see has changed. Both
    // are needed in full mode too, not to decide anything, but to record
    // whether the tree this build indexed was the tree HEAD describes.
    const signalled = uniqueSorted([...consumed, ...normalisePaths(root, opts.files ?? [])]);
    const working = git === undefined ? [] : workingTreePaths(root);
    const committed =
      // Skipped when the map was built from HEAD itself: the diff is empty by
      // definition, and this is the hot path, the plugin's `Stop` hook runs it
      // after every turn, so two fewer process spawns is most of what it costs.
      incremental && indexed !== undefined && indexed !== git?.head && commitExists(root, indexed)
        ? committedSince(root, indexed)
        : [];

    // Everything above is raw: `git status` reports a rebuilt `dist/`, a new
    // `.env.local` and a swap file just as readily as a source edit, and none
    // of those can change a byte of the map. Keeping them would mean the fast
    // path never fires on a repository that builds into its own tree.
    const changed = uniqueSorted([...signalled, ...working, ...committed]);
    const relevant = await keepIndexable(root, changed, config, git !== undefined);
    const dirty = incremental ? changed.filter((candidate) => relevant.has(candidate)) : [];

    // The tree this build is about to index: clean when nothing outside HEAD
    // reached it. Recorded so the next run knows whether HEAD alone describes
    // the map, a build of a dirty tree is not repeatable from the commit it
    // names, and a revert would otherwise leave the map describing code that is
    // gone.
    const treeClean =
      git?.head !== undefined &&
      signalled.filter((candidate) => relevant.has(candidate)).length === 0 &&
      working.filter((candidate) => relevant.has(candidate)).length === 0;

    // Residue from a writer that was killed between a sibling write and its
    // rename. Before the fast path rather than after it: a repository that is
    // otherwise clean would keep the residue until something unrelated changed,
    // and an untracked file inside `.greplost/` is precisely what nobody wants
    // to find in `git status` weeks later.
    sweepTemporaries(path.join(root, ARTIFACT_DIR));

    // Clean means four things, all of which have to hold: nothing is dirty now,
    // HEAD is exactly the commit the map was built from, that build saw the
    // same tree HEAD describes, and it ran under the config in force today.
    // Drop any one and there is a sequence that leaves a stale map in place
    // forever. `git.head === undefined`, no git, or a repo with no commits,
    // can never confirm the second, so those repositories always rebuild rather
    // than trusting a state file nothing corroborates.
    if (
      incremental &&
      dirty.length === 0 &&
      git?.head !== undefined &&
      state.lastIndexedCommit === git.head &&
      state.treeClean === true &&
      state.configHash === configHash
    ) {
      return report({ ...empty(opts.mode, started), skipped: "clean" }, opts.quiet);
    }

    // The signal config is part of the cache's stamp: extraction's output for the same bytes
    // depends on which passes ran, and the `(lang, sha256)` key carries neither (leaf 2.3).
    const store = new FileParseCache(root, config.signals);
    store.load();
    // A full update ignores the cache for reads but still fills it, so the
    // next incremental run starts warm. That is also what makes `--full` the
    // repair for a cache someone has corrupted.
    const cache = new CountingCache(store, incremental);

    const { snapshot, files, skipped, warnings } = await buildArtifacts(root, { cache });
    store.save(usedKeys(snapshot));

    // An empty map is a legitimate answer, a repository really can have no
    // indexable files, and it is also what a config that matches nothing
    // produces, which is far more common and completely silent otherwise: the
    // build succeeds, the exit code is 0 and INDEX.md describes nothing. On
    // stderr, and regardless of `--quiet`, because `--json` owns stdout and
    // this is not the summary line quiet exists to suppress.
    if (snapshot.files.length === 0) {
      console.error(
        `greplost: no files indexed (check languages/include/exclude in ${ARTIFACT_DIR}/${ARTIFACT_PATHS.config})`,
      );
    }

    // A repo-relative path is also an id (tech spec 5.3), so a path holding a
    // `#`, a newline or a NUL cannot be told from a symbol id, cannot be slugged
    // into a node card directory, and cannot be linked to. Discovery skips such
    // files; saying nothing would leave a source file silently absent from the
    // map. One line with the count, never a list: on the pathological repo that
    // has thousands, a list is the whole output.
    if (skipped.length > 0) {
      console.error(
        `greplost: skipped ${skipped.length} file${skipped.length === 1 ? "" : "s"} ` +
          'whose path contains "#", a newline or NUL and so cannot be a map id',
      );
    }

    // A node whose card path another artifact already claims. One line each and
    // not a count: there is normally none, a repository that has one has one or
    // two, and each names two ids the user has to look at to fix it.
    for (const warning of warnings) console.error(warning);

    const written = writeArtifacts(root, files);
    // The commit read before the build, not after: a commit that landed while
    // this ran is not indexed by it, and recording it would mean the next run
    // diffs from a commit whose changes never reached the map.
    writeState(root, git?.head === undefined ? {} : { lastIndexedCommit: git.head, treeClean, configHash });

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
    // dirtied it. Never at the cost of the real error, though: whatever made
    // the build fail is what the user needs to read.
    if (consumed.length > 0) {
      try {
        appendDirty(root, consumed);
      } catch {
        // An unwritable artifact directory is almost certainly what `cause`
        // already says.
      }
    }
    throw cause;
  }
}

/**
 * A `ParseCache` that counts, and that can be told not to answer.
 *
 * `reparsed`/`cached` are the only visible evidence that incremental mode did
 * anything at all, the artifacts it writes are identical either way, so they
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
  /** HEAD as of the start of the update; absent before the first commit. */
  head?: string;
}

/**
 * What git can tell us about `root`, or `undefined` when it can tell us
 * nothing usable.
 *
 * Deliberately strict: git counts only when `root` *is* the top level of the
 * work tree. `git status --porcelain` reports paths relative to the top level
 * whatever directory it is run from, so anywhere else those paths would be
 * resolved against the wrong root, quietly producing a dirty set full of
 * paths that do not exist. A subdirectory therefore behaves like a
 * non-repository: correct, just never "clean".
 */
function gitContext(root: string): GitContext | undefined {
  const toplevel = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (toplevel === undefined || toplevel.trim() === "") return undefined;
  if (!samePath(root, toplevel.trim())) return undefined;

  const head = runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const commit = head === undefined ? "" : head.trim();
  return commit === "" ? {} : { head: commit };
}

/**
 * Narrow a set of changed paths to the ones that could change the map.
 *
 * Two tests, cheapest first. A path whose extension no language claims, a
 * `.env.local`, a lockfile, a screenshot, can never be indexed, and that
 * settles most of what a working tree churns through without touching the
 * disk. What is left has to be checked against the same discovery the build
 * runs, because `config.exclude` is where a repository says that `dist/`,
 * `vendor/` and `*.test.ts` are not part of its map, and only picomatch can
 * answer that faithfully.
 *
 * Paths that discovery does not return but the last build indexed are kept:
 * that is a deleted file, and its card has to be pruned. The manifest is only
 * read when such a path exists, so the ordinary case (edits to files that still
 * exist) never parses it.
 *
 * A candidate that is a directory on disk is kept whatever its name, because a
 * directory is not a file that failed the tests: it is an unknown number of
 * them. Sources of directory-shaped candidates are meant to be rare now that
 * the working tree is read with `--untracked-files=all`, but a caller can pass
 * one in `files`, and the cost of treating one as "nothing changed" is a whole
 * subtree missing from the map.
 *
 * `precise` is false outside git, where the answer cannot affect anything: the
 * fast path needs a commit to compare against, so a non-git checkout rebuilds
 * either way and the filter would only be refining a number in a report.
 */
async function keepIndexable(
  root: string,
  candidates: string[],
  config: GreplostConfig,
  precise: boolean,
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();

  const kept = new Set<string>();
  const named: string[] = [];
  for (const candidate of candidates) {
    if (isDirectory(path.join(root, candidate))) kept.add(candidate);
    else if (isIndexableName(candidate, config)) named.push(candidate);
  }
  if (named.length === 0 || !precise) {
    for (const candidate of named) kept.add(candidate);
    return kept;
  }

  const discovered = new Set((await discoverFiles(root, config)).map((file) => file.path));
  const gone: string[] = [];
  for (const candidate of named) {
    if (discovered.has(candidate)) kept.add(candidate);
    else gone.push(candidate);
  }

  if (gone.length > 0) {
    const indexed = indexedFiles(root);
    for (const candidate of gone) if (indexed.has(candidate)) kept.add(candidate);
  }
  return kept;
}

function isDirectory(target: string): boolean {
  try {
    return lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Could a file with this name be indexed at all, given the configured languages? */
function isIndexableName(rel: string, config: GreplostConfig): boolean {
  const lang = langOf(rel);
  return lang !== undefined && config.languages.includes(lang);
}

/**
 * The files the map on disk describes, from `manifest.json` alone.
 *
 * Not `readStructure`: that also parses the three graph files, and the only
 * question here is which paths were indexed. An unreadable or absent manifest
 * means "nothing was", which is the safe answer, a deleted file that is not in
 * the map has no card to prune.
 */
function indexedFiles(root: string): Set<string> {
  const file = path.join(root, ARTIFACT_DIR, ARTIFACT_PATHS.manifest);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { files?: unknown };
    if (typeof parsed.files !== "object" || parsed.files === null) return new Set();
    return new Set(Object.keys(parsed.files as Record<string, unknown>));
  } catch {
    return new Set();
  }
}

/** Sibling temporaries written by an atomic replace: `.<name>.<pid>.<n>.tmp`. */
const TEMPORARY = /^\..+\.(\d+)\.\d+\.tmp$/;

/**
 * Delete temporaries left under the artifact directory by a writer that died
 * between its write and its rename.
 *
 * They are not structure paths, so `writeArtifacts` will not prune them and
 * `verify` will not report them, which is what makes them safe to leave behind
 * mid-write, and also what would make them accumulate in a repository's status
 * output forever. A temporary belonging to this process is in flight, not
 * residue, and is left alone.
 */
function sweepTemporaries(artifactDir: string): void {
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const match = TEMPORARY.exec(entry.name);
      if (match === null || Number(match[1]) === process.pid) continue;
      try {
        rmSync(full, { force: true });
      } catch {
        // Someone else's to remove; it is inert either way.
      }
    }
  };
  walk(artifactDir);
}

/**
 * Everything uncommitted: staged, unstaged, untracked, and both sides of a
 * rename.
 *
 * `--untracked-files=all` is load-bearing, not tidiness. Porcelain output
 * collapses an untracked directory to a single `newpkg/` entry, and a
 * directory has no extension, no discovery entry and no manifest entry, so a
 * whole new package would be filtered out of the dirty set and the tree would
 * be declared clean while none of it was indexed. Listing every untracked file
 * individually is what makes "a new directory appeared" indistinguishable from
 * "new files appeared", which is what it actually is.
 *
 * The pathspec keeps that affordable: with `-uall`, a `.greplost/` that has not
 * been committed yet would otherwise be listed artifact by artifact on every
 * single run. `toRepoRelative` drops those paths anyway, so the exclusion is
 * only about not asking git to enumerate them, and a git too old for pathspec
 * magic falls back to the plain form rather than reporting a clean tree.
 */
function workingTreePaths(root: string): string[] {
  const out =
    runGit(root, [
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=all",
      "--",
      ".",
      `:(exclude)${ARTIFACT_DIR}`,
    ]) ?? runGit(root, ["status", "--porcelain", "-z", "--untracked-files=all"]);
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
