/**
 * Eval 2: freshness and sync, F1 and F2 (tech spec 3, 10.4; bench spec 1.5.5).
 *
 * The claim this suite has to earn is the one greplost leads with: a committed
 * map cannot go quietly stale. Two numbers say whether that is true.
 *
 *   F1  `verify` catch rate on a stale map   100 %   (gated)
 *   F2  full/incremental divergence          0 bytes (gated)
 *
 * The method is a commit replay. In a temporary working copy of a corpus repo
 * (never the corpus clone itself), walk N commits ending at the pinned SHA,
 * oldest first. Build the map at the oldest one, then for each commit after it:
 *
 *   a. `git checkout` and run `verify` *without* updating. The map on disk was
 *      built from the previous commit, so this is the drift injection: verify
 *      must fail. Every commit it catches counts toward F1.
 *   b. `update --incremental`, timed. The sample feeds P2's latency picture and
 *      the p50/p95 in the summary.
 *   c. `verify` again. It must pass; a failure here is `verify` disagreeing
 *      with the writer that just ran, which is an F2-class defect.
 *   d. Every f2-th commit, rebuild the same commit from scratch in a second
 *      working copy with `update --full` and byte-compare the two `.greplost/`
 *      trees. Zero differing bytes is F2.
 *
 * Everything goes through the `@greplost/sync` API in process, never the CLI: a
 * broken CLI must not be able to mask a sync bug, and a sync bug must not be
 * reported as a CLI bug.
 *
 * **What counts as drift.** A commit that changes nothing greplost indexes (a
 * README, a workflow file) leaves the map correct, and `verify` passing is then
 * the right answer, not a miss. Classifying those honestly is the whole
 * difficulty of F1: `verify` compares an in-memory rebuild against disk, so
 * asking `verify` whether the map was stale would be asking the thing under
 * test. The independent signal used here is the update that follows: if
 * `update` wrote or deleted an artifact, the map on disk really did differ from
 * a correct build of that checkout, and `verify` owed us a failure. If it wrote
 * nothing, there was nothing to catch. That splits the no-ops into two reported
 * buckets (the commit touched no source file at all, or it touched source that
 * the map does not distinguish), and leaves F1's denominator holding only
 * commits that genuinely staled the map. The two sides of the comparison are
 * different code (`verify.ts` reads and compares, `write.ts` writes what
 * differs), so a disagreement between them is a real finding either way: a
 * `verify` failure with nothing to write is recorded as a false positive and
 * gated under F2.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ARTIFACT_DIR,
  ARTIFACT_PATHS,
  DEFAULT_CONFIG,
  LANG_BY_EXTENSION,
  compareStrings,
  stableStringify,
  type GreplostConfig,
  type Lang,
} from "@greplost/core/schema";
import { init, listStructurePaths, update, verify } from "@greplost/sync";

import { repoDir, selectRepos, type CorpusRepoEntry } from "./corpus.ts";
import { machineProfile } from "./machine.ts";
import { writeResult } from "./results-io.ts";

const SUITE = "replay";

/**
 * Results file prefix. The hermetic fixture run writes under its own name:
 * `bench/results/<suite>-<date>-<sha7>.json` carries no other discriminator, so
 * a fixture run and a corpus run on the same day at the same commit would write
 * the *same file*, and a five-commit synthetic history would silently replace a
 * 500-commit corpus replay. `latestResult("replay")`, which is what `report.ts`
 * reads, must resolve to the corpus run. (Ruling, leaf 1.5.5.)
 */
function resultSuite(fixture: boolean): string {
  return fixture ? `${SUITE}-fixture` : SUITE;
}

/** Repo root, from `bench/src/replay.ts`. */
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

/** Section 3 targets: F1 is a rate that must be 1, F2 a mismatch count that must be 0. */
export const TARGETS = { F1: 1, F2: 0 } as const;

/** Commits replayed when `--commits` is absent: tech spec 10.4 says 500 for a corpus repo. */
const DEFAULT_CORPUS_COMMITS = 500;

/** The synthetic history is built commit by commit, so its default is small. */
const DEFAULT_FIXTURE_COMMITS = 5;

/** Equivalence checkpoint interval (tech spec 10.4: "every 50th commit"). */
const DEFAULT_F2_EVERY = 50;

/**
 * The fixture's history is far shorter than 50 commits, and a gate that never
 * ran an equivalence check would be a gate on nothing.
 */
const FIXTURE_F2_EVERY = 2;

/** Rows are printed per commit up to this many; longer runs print progress instead. */
const MAX_ROWS = 20;

/** Progress line interval for runs too long to print per-commit rows. */
const PROGRESS_EVERY = 10;

/** Divergent artifact paths listed under a failed equivalence check. */
const MAX_REPORTED_MISMATCHES = 20;

/** Fixed identity and timestamps, so a synthetic history is byte-identical run to run. */
const SYNTHETIC_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "greplost bench",
  GIT_AUTHOR_EMAIL: "bench@greplost.invalid",
  GIT_COMMITTER_NAME: "greplost bench",
  GIT_COMMITTER_EMAIL: "bench@greplost.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00+00:00",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00+00:00",
};

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/** How one replayed commit was classified. */
export type Drift =
  /** The map went stale and `verify` said so. */
  | "caught"
  /** The map went stale and `verify` passed anyway: an F1 miss. */
  | "missed"
  /** The commit touched no file greplost indexes, so the map was still correct. */
  | "noop-no-source-change"
  /** Source changed but produced the same map (a comment, a reformat). */
  | "noop-no-artifact-change";

export interface ReplayStep {
  /** 1-based index among the replayed commits (the `init` commit is not one). */
  index: number;
  sha: string;
  /** Files the commit touched that greplost indexed, before the commit or after it. */
  sourceFilesChanged: number;
  drift: Drift;
  /** Artifacts the incremental update wrote, and pruned: the staleness ground truth. */
  written: number;
  deleted: number;
  /** Wall-clock milliseconds of the incremental update (step b). */
  updateMs: number;
  /** `verify` before the update (step a). True on a stale map is the F1 miss. */
  verifiedBeforeUpdate: boolean;
  /** `verify` after the update (step c). False is an F2-class defect. */
  verifiedAfterUpdate: boolean;
  /** Equivalence checkpoint, when this commit was one (step d). */
  f2?: {
    /** Structure artifacts the two trees held between them. Zero compares nothing. */
    compared: number;
    mismatches: string[];
  };
}

export interface ReplaySummary {
  target: string;
  /** Commits walked, the `init` commit included. */
  commits: number;
  /** Stale commits `verify` caught. */
  driftCaught: number;
  /** Stale commits: F1's denominator. */
  driftTotal: number;
  /** `driftCaught / driftTotal`, or null when nothing staled the map. */
  f1CatchRate: number | null;
  noops: number;
  noopsNoSourceChange: number;
  noopsNoArtifactChange: number;
  f2Checks: number;
  f2Mismatches: number;
  /** Commits where `verify` failed *after* an update ran (step c). */
  verifyFailedAfterUpdate: string[];
  /** Commits where `verify` failed but the update had nothing to write. */
  verifyFalsePositives: string[];
  /** Anything that made a step unmeasurable (a skipped update, a failed checkout). */
  anomalies: string[];
  updateP50: number;
  updateP95: number;
  updateSamples: number[];
}

export interface ReplayOptions {
  /** Replay a synthetic history built from `fixtures/tiny-ts` (hermetic). */
  fixture?: boolean;
  /** Corpus repo name; ignored when `fixture` is set. */
  repo?: string;
  /** Commits to walk, the `init` commit included. */
  commits?: number;
  /** Equivalence checkpoint interval; `0` disables F2 entirely. */
  f2Every?: number;
  /** Print a row per commit however long the run is. */
  verbose?: boolean;
  /** Print nothing; the summary is still returned. */
  quiet?: boolean;
  /**
   * Test-only: make every Nth synthetic commit touch documentation only, so the
   * no-op classification can be exercised without a corpus.
   */
  syntheticDocsEvery?: number;
  /** Leave the temporary working copies behind (debugging). */
  keep?: boolean;
}

export interface ReplayRun {
  summary: ReplaySummary;
  steps: ReplayStep[];
}

// ---------------------------------------------------------------------------
// git plumbing (shared with perf.ts)
// ---------------------------------------------------------------------------

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run git in `cwd`. Never throws: every caller decides what a failure means. */
export function git(cwd: string, args: string[], env?: Record<string, string>): GitResult {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  if (res.error) return { status: 127, stdout: "", stderr: `could not run "git ${args.join(" ")}": ${res.error.message}` };
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Run git in `cwd`, or throw with git's own message. */
export function gitOrThrow(cwd: string, args: string[], env?: Record<string, string>): string {
  const res = git(cwd, args, env);
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
export function cloneWorkingCopy(source: string, dest: string, sha: string): void {
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
  gitOrThrow(dest, ["checkout", "--quiet", "--force", sha]);
}

/**
 * `git checkout --force`, leaving untracked files alone, which is what keeps
 * the map from one commit alive into the next, and is the whole drift
 * injection. It assumes `.greplost/` is untracked in the repo being replayed;
 * a repo that commits its own map (greplost's own, one day) would have that map
 * checked out over the one under test, and would need a different experiment.
 */
function checkout(root: string, sha: string): void {
  gitOrThrow(root, ["checkout", "--quiet", "--force", sha]);
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

/** Paths the commit range `from..to` touched, repo-relative. */
function changedPaths(root: string, from: string, to: string): string[] {
  const out = git(root, ["diff", "--name-only", "-z", `${from}..${to}`, "--"]);
  if (out.status !== 0) return [];
  return out.stdout.split("\0").filter((entry) => entry !== "");
}

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// artifact tree comparison (F2)
// ---------------------------------------------------------------------------

/**
 * Structure paths whose bytes differ between two `.greplost/` directories,
 * sorted. A path present in one tree and not the other counts as a difference.
 *
 * Only structure artifacts are compared: `config.json`, the parse cache and the
 * runtime files (`.dirty`, `.lock`, `.state.json`) are machine-local by design
 * and would make every checkpoint mismatch for reasons that are not the map.
 */
export function compareArtifactTrees(a: string, b: string): string[] {
  const left = new Set(listStructurePaths(a));
  const right = new Set(listStructurePaths(b));
  const all = [...new Set([...left, ...right])].sort(compareStrings);

  const differing: string[] = [];
  for (const rel of all) {
    if (!left.has(rel) || !right.has(rel)) {
      differing.push(rel);
      continue;
    }
    if (!readBytes(path.join(a, rel)).equals(readBytes(path.join(b, rel)))) differing.push(rel);
  }
  return differing;
}

function readBytes(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch {
    return Buffer.alloc(0);
  }
}

// ---------------------------------------------------------------------------
// synthetic history (the hermetic target)
// ---------------------------------------------------------------------------

/**
 * Build a git repository at `dest` from `fixtures/tiny-ts` with `commits`
 * commits, oldest first, and return their SHAs.
 *
 * The first commit is the fixture as it stands. Each later commit appends one
 * exported constant to one source file, cycling through the fixture's sources
 * in sorted order. That is an edit guaranteed to move the map (a new export
 * changes the manifest, the package API and the module card), so a commit that
 * fails to stale the map is a finding rather than an artefact of a timid edit.
 * With `docsEvery`, every Nth commit instead appends to `NOTES.md`, which
 * greplost does not index: that is the no-op case F1 must not count.
 *
 * Deterministic throughout (fixed identity, fixed dates, sorted file order), so
 * two runs of the suite replay exactly the same history.
 */
export function createSyntheticHistory(
  dest: string,
  commits: number,
  opts: { docsEvery?: number } = {},
): string[] {
  const fixture = path.join(REPO_ROOT, "fixtures", "tiny-ts");
  if (!existsSync(fixture)) throw new Error(`${SUITE}: fixture not found at ${fixture}`);
  mkdirSync(dest, { recursive: true });
  copySourceTree(fixture, dest);

  gitOrThrow(dest, ["init", "--quiet", "-b", "main"]);
  gitOrThrow(dest, ["config", "user.name", "greplost bench"]);
  gitOrThrow(dest, ["config", "user.email", "bench@greplost.invalid"]);
  gitOrThrow(dest, ["config", "commit.gpgsign", "false"]);

  const sources = listSourceFiles(dest);
  if (sources.length === 0) throw new Error(`${SUITE}: fixture at ${fixture} has no source files`);

  const docsEvery = opts.docsEvery ?? 0;
  for (let commit = 1; commit <= commits; commit++) {
    if (commit > 1) {
      if (docsEvery > 0 && commit % docsEvery === 0) {
        appendLine(path.join(dest, "NOTES.md"), `- note ${commit}`);
      } else {
        const file = sources[(commit - 2) % sources.length] as string;
        appendLine(path.join(dest, file), `export const marker${commit} = ${commit};`);
      }
    }
    gitOrThrow(dest, ["add", "-A"], SYNTHETIC_GIT_ENV);
    gitOrThrow(dest, ["commit", "--quiet", "--allow-empty", "-m", `commit ${commit}`], SYNTHETIC_GIT_ENV);
  }

  return gitOrThrow(dest, ["rev-list", "--reverse", "HEAD"])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function appendLine(file: string, line: string): void {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, `${existing}${existing.endsWith("\n") || existing === "" ? "" : "\n"}${line}\n`);
}

/** Repo-relative source files of the fixture, sorted, `node_modules` and dotfiles aside. */
function listSourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (langOf(rel) !== undefined) found.push(rel);
    }
  };
  walk(root, "");
  return found.sort(compareStrings);
}

/** The language greplost would read a path as, or undefined when it reads it as nothing. */
function langOf(file: string): Lang | undefined {
  const dot = file.lastIndexOf(".");
  if (dot === -1) return undefined;
  return LANG_BY_EXTENSION[file.slice(dot)];
}

// ---------------------------------------------------------------------------
// targets
// ---------------------------------------------------------------------------

interface Target {
  name: string;
  /** The git repository the working copies are cloned from. */
  origin: string;
  /** Commit to walk back from; HEAD of `origin` for the synthetic history. */
  sha: string;
  /** Languages to index, when the repo needs a config it does not carry itself. */
  config: GreplostConfig | undefined;
}

/**
 * The config a corpus repo needs before `init`.
 *
 * `DEFAULT_CONFIG.languages` is TypeScript-only (Go is opt-in per repo), so a
 * Go checkout with no committed `.greplost/config.json` would index nothing and
 * replay a map that cannot go stale. `structural.ts` makes the same one
 * override, and only when the repo has not already made the choice itself.
 */
function configFor(entry: CorpusRepoEntry): GreplostConfig | undefined {
  if (entry.lang !== "go") return undefined;
  return { ...DEFAULT_CONFIG, languages: ["go"] };
}

// ---------------------------------------------------------------------------
// the replay itself
// ---------------------------------------------------------------------------

export async function replay(options: ReplayOptions = {}): Promise<ReplayRun> {
  const fixture = options.fixture === true;
  const commits = Math.max(2, options.commits ?? (fixture ? DEFAULT_FIXTURE_COMMITS : DEFAULT_CORPUS_COMMITS));
  const f2Every = options.f2Every ?? (fixture ? FIXTURE_F2_EVERY : DEFAULT_F2_EVERY);

  const created: string[] = [];
  const scratch = (prefix: string): string => {
    const dir = mkdtempSync(path.join(tmpdir(), `greplost-${prefix}-`));
    created.push(dir);
    return dir;
  };

  let target: Target;
  if (fixture) {
    const origin = scratch("replay-origin");
    const shas = createSyntheticHistory(origin, commits, {
      ...(options.syntheticDocsEvery === undefined ? {} : { docsEvery: options.syntheticDocsEvery }),
    });
    target = {
      name: "tiny-ts",
      origin,
      sha: shas[shas.length - 1] as string,
      config: undefined,
    };
  } else {
    const entry = corpusEntry(options.repo);
    target = {
      name: entry.name,
      origin: repoDir(entry.name),
      sha: entry.sha,
      config: configFor(entry),
    };
    if (!existsSync(path.join(target.origin, ".git"))) {
      throw new Error(
        `${SUITE}: ${entry.name} is not cloned; run \`bun bench/src/cli.ts corpus setup --repo ${entry.name}\``,
      );
    }
  }

  try {
    return await replayTarget(target, { commits, f2Every, options, scratch });
  } finally {
    if (options.keep !== true) {
      for (const dir of created) rmSync(dir, { recursive: true, force: true });
    }
  }
}

function corpusEntry(repo: string | undefined): CorpusRepoEntry {
  const repos = repo === undefined ? selectRepos([]) : selectRepos(["--repo", repo]);
  const entry = repos[0];
  if (entry === undefined) throw new Error(`${SUITE}: bench/corpus.json lists no repos`);
  return entry;
}

async function replayTarget(
  target: Target,
  ctx: { commits: number; f2Every: number; options: ReplayOptions; scratch: (prefix: string) => string },
): Promise<ReplayRun> {
  const { commits, f2Every, options } = ctx;
  const quiet = options.quiet === true;

  const incRoot = ctx.scratch("replay-inc");
  cloneWorkingCopy(target.origin, incRoot, target.sha);

  const shas = listCommits(incRoot, target.sha, commits);
  const first = shas[0];
  if (first === undefined || shas.length < 2) {
    throw new Error(
      `${SUITE}: ${target.name} has ${shas.length} commit(s) available at ${target.sha.slice(0, 7)}; ` +
        "a replay needs at least 2 (deepen the corpus clone or lower --commits)",
    );
  }

  if (!quiet) {
    console.log(
      `${SUITE}: ${target.name} replaying ${shas.length} commits ending at ${target.sha.slice(0, 7)}` +
        (f2Every > 0 ? `, equivalence check every ${f2Every}` : ", equivalence checks disabled"),
    );
  }

  checkout(incRoot, first);
  writeConfig(incRoot, target.config);
  await init(incRoot, { hooks: false, quiet: true });

  const steps: ReplayStep[] = [];
  const anomalies: string[] = [];
  let fullRoot: string | undefined;
  const rows = options.verbose === true || shas.length - 1 <= MAX_ROWS;
  // The files greplost indexed at the previous commit. Which paths count as
  // "source" is a question about the repo's config, its include and exclude
  // globs and not just the extension, and the manifest is that answer already
  // computed, so the classification asks it instead of re-deriving it.
  let indexed = readIndexedFiles(incRoot);

  for (let i = 1; i < shas.length; i++) {
    const sha = shas[i] as string;
    const previous = shas[i - 1] as string;
    const touched = changedPaths(incRoot, previous, sha);

    checkout(incRoot, sha);

    // (a) drift injection: the map on disk was built from `previous`.
    // No parse cache is passed, here or below, on purpose: `verify` rebuilds
    // from source every time, so a cache that answered with the wrong record
    // would show up as a divergence rather than being believed by both sides.
    const before = await verify(incRoot);
    // (b) the update under test, timed.
    const result = await update(incRoot, { mode: "incremental", quiet: true });
    // (c) and the map must now agree with the checkout.
    const after = await verify(incRoot);

    if (result.skipped !== undefined) {
      anomalies.push(`${sha.slice(0, 7)}: update skipped (${result.skipped})`);
    }

    // Indexed before or after: a file the commit deleted is only in the first
    // set, one it added only in the second, and a test file that greplost
    // excludes is in neither however TypeScript-shaped its name is.
    const indexedNow = readIndexedFiles(incRoot);
    const sourceFilesChanged = touched.filter((file) => indexed.has(file) || indexedNow.has(file)).length;
    indexed = indexedNow;

    const stale = result.written > 0 || result.deleted > 0;
    const drift: Drift = stale
      ? before.ok
        ? "missed"
        : "caught"
      : sourceFilesChanged === 0
        ? "noop-no-source-change"
        : "noop-no-artifact-change";

    const step: ReplayStep = {
      index: i,
      sha,
      sourceFilesChanged,
      drift,
      written: result.written,
      deleted: result.deleted,
      updateMs: result.ms,
      verifiedBeforeUpdate: before.ok,
      verifiedAfterUpdate: after.ok,
    };

    const lastStep = i === shas.length - 1;
    const noCheckYet = !steps.some((s) => s.f2 !== undefined);
    if (f2Every > 0 && (i % f2Every === 0 || (lastStep && noCheckYet))) {
      if (fullRoot === undefined) {
        fullRoot = ctx.scratch("replay-full");
        cloneWorkingCopy(target.origin, fullRoot, sha);
      } else {
        checkout(fullRoot, sha);
      }
      // The config comes from the incremental copy rather than from `target`:
      // `init` writes a default one there, and F2 must compare two builds of the
      // same configuration or it is measuring the config.
      copyConfig(incRoot, fullRoot);
      await update(fullRoot, { mode: "full", quiet: true });
      const incDir = path.join(incRoot, ARTIFACT_DIR);
      const fullDir = path.join(fullRoot, ARTIFACT_DIR);
      // How many artifacts the check actually looked at. Two empty trees are
      // byte-identical and mean nothing: without this, a build that produced no
      // artifacts at all would report a clean F2 for every checkpoint (the same
      // vacuity guard `structural.ts` puts on an empty truth set).
      const compared = new Set([...listStructurePaths(incDir), ...listStructurePaths(fullDir)]).size;
      step.f2 = { compared, mismatches: compareArtifactTrees(incDir, fullDir) };
    }

    steps.push(step);
    if (!quiet) printStep(step, shas.length - 1, rows);
    // A mismatch is the finding this whole suite exists to produce; print the
    // paths where they happened rather than only a count in the summary, and
    // print them even on a long run that is otherwise showing progress lines.
    if (!quiet && step.f2 !== undefined && step.f2.compared === 0) {
      console.log(`  F2 EMPTY at ${sha.slice(0, 7)}: neither tree held a structure artifact; nothing was compared`);
    }
    if (!quiet && step.f2 !== undefined && step.f2.mismatches.length > 0) {
      console.log(`  F2 MISMATCH at ${sha.slice(0, 7)}: ${step.f2.mismatches.length} artifact(s) differ`);
      for (const rel of step.f2.mismatches.slice(0, MAX_REPORTED_MISMATCHES)) console.log(`    ${rel}`);
    }
  }

  const summary = summarize(target.name, shas.length, steps, anomalies);
  if (!quiet) printSummary(summary);
  return { summary, steps };
}

/**
 * The repo-relative files `.greplost/manifest.json` says are indexed, or an
 * empty set when there is no readable manifest (before the first build, or
 * after a build that produced nothing).
 */
function readIndexedFiles(root: string): Set<string> {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(root, ARTIFACT_DIR, ARTIFACT_PATHS.manifest), "utf8"),
    ) as { files?: Record<string, unknown> };
    return new Set(Object.keys(manifest.files ?? {}));
  } catch {
    return new Set();
  }
}

/** The N commits ending at `sha`, oldest first. Fewer when the clone is shallower than N. */
function listCommits(root: string, sha: string, commits: number): string[] {
  return gitOrThrow(root, ["rev-list", "--reverse", `--max-count=${commits}`, sha])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Write `.greplost/config.json` when the target needs one and the repo has none. */
function writeConfig(root: string, config: GreplostConfig | undefined): void {
  if (config === undefined) return;
  const file = path.join(root, ARTIFACT_DIR, ARTIFACT_PATHS.config);
  if (existsSync(file)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${stableStringify(config, 2)}\n`);
}

/**
 * Give the full rebuild the same config the incremental copy is using.
 *
 * `init` writes a default `config.json` on first run, so without this the two
 * trees could be built from two different configs and F2 would be measuring the
 * config rather than the update.
 */
function copyConfig(from: string, to: string): void {
  const source = path.join(from, ARTIFACT_DIR, ARTIFACT_PATHS.config);
  if (!existsSync(source)) return;
  const dest = path.join(to, ARTIFACT_DIR, ARTIFACT_PATHS.config);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(source));
}

function summarize(target: string, commits: number, steps: ReplayStep[], anomalies: string[]): ReplaySummary {
  const stale = steps.filter((step) => step.drift === "caught" || step.drift === "missed");
  const caught = stale.filter((step) => step.drift === "caught").length;
  const noSource = steps.filter((step) => step.drift === "noop-no-source-change").length;
  const noArtifact = steps.filter((step) => step.drift === "noop-no-artifact-change").length;
  const checks = steps.filter((step) => step.f2 !== undefined);
  const samples = steps.map((step) => step.updateMs);

  return {
    target,
    commits,
    driftCaught: caught,
    driftTotal: stale.length,
    f1CatchRate: stale.length === 0 ? null : caught / stale.length,
    noops: noSource + noArtifact,
    noopsNoSourceChange: noSource,
    noopsNoArtifactChange: noArtifact,
    f2Checks: checks.length,
    f2Mismatches: checks.filter(
      (step) => (step.f2?.mismatches.length ?? 0) > 0 || (step.f2?.compared ?? 0) === 0,
    ).length,
    verifyFailedAfterUpdate: steps.filter((s) => !s.verifiedAfterUpdate).map((s) => s.sha.slice(0, 7)),
    // `verify` said the map was stale and the update that followed found nothing
    // to write: the two halves of sync disagree about the same bytes.
    verifyFalsePositives: steps
      .filter((s) => s.drift === "noop-no-source-change" || s.drift === "noop-no-artifact-change")
      .filter((s) => !s.verifiedBeforeUpdate)
      .map((s) => s.sha.slice(0, 7)),
    anomalies,
    updateP50: percentile(samples, 50),
    updateP95: percentile(samples, 95),
    updateSamples: samples,
  };
}

/**
 * The gate ids this run missed, in id order.
 *
 * F1 is the catch rate, and a run where nothing staled the map misses it: an
 * empty denominator would otherwise let a replay that measured nothing report a
 * perfect score (the same guard `structural.ts` puts on an empty truth set).
 * F2 covers all three ways the two halves of sync can disagree: a checkpoint
 * whose bytes differ, a `verify` that fails after an update, and a `verify`
 * that fails when there was nothing to write.
 */
export function missedGates(summary: ReplaySummary): string[] {
  const missed: string[] = [];
  if (summary.f1CatchRate === null || summary.f1CatchRate < TARGETS.F1) missed.push("F1");
  if (
    summary.f2Mismatches > TARGETS.F2 ||
    summary.verifyFailedAfterUpdate.length > 0 ||
    summary.verifyFalsePositives.length > 0
  ) {
    missed.push("F2");
  }
  return missed;
}

/** One summary covering every target of a multi-repo run. */
export function aggregate(summaries: ReplaySummary[]): ReplaySummary {
  const samples = summaries.flatMap((s) => s.updateSamples);
  const driftTotal = sum(summaries, (s) => s.driftTotal);
  const driftCaught = sum(summaries, (s) => s.driftCaught);
  return {
    target: summaries.map((s) => s.target).join(","),
    commits: sum(summaries, (s) => s.commits),
    driftCaught,
    driftTotal,
    f1CatchRate: driftTotal === 0 ? null : driftCaught / driftTotal,
    noops: sum(summaries, (s) => s.noops),
    noopsNoSourceChange: sum(summaries, (s) => s.noopsNoSourceChange),
    noopsNoArtifactChange: sum(summaries, (s) => s.noopsNoArtifactChange),
    f2Checks: sum(summaries, (s) => s.f2Checks),
    f2Mismatches: sum(summaries, (s) => s.f2Mismatches),
    verifyFailedAfterUpdate: summaries.flatMap((s) => s.verifyFailedAfterUpdate),
    verifyFalsePositives: summaries.flatMap((s) => s.verifyFalsePositives),
    anomalies: summaries.flatMap((s) => s.anomalies),
    updateP50: percentile(samples, 50),
    updateP95: percentile(samples, 95),
    updateSamples: samples,
  };
}

function sum(summaries: ReplaySummary[], read: (summary: ReplaySummary) => number): number {
  return summaries.reduce((total, summary) => total + read(summary), 0);
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

function printStep(step: ReplayStep, total: number, rows: boolean): void {
  if (!rows) {
    if (step.index % PROGRESS_EVERY === 0 || step.index === total) {
      console.log(`  ${step.index}/${total} commits replayed (last update ${step.updateMs}ms)`);
    }
    return;
  }
  const f2 =
    step.f2 === undefined
      ? ""
      : step.f2.compared === 0
        ? "  F2 EMPTY"
        : step.f2.mismatches.length === 0
          ? `  F2 ok (${step.f2.compared})`
          : `  F2 MISMATCH (${step.f2.mismatches.length})`;
  console.log(
    `  ${String(step.index).padStart(String(total).length)}/${total} ${step.sha.slice(0, 7)}` +
      `  ${step.drift.padEnd(22)} update ${String(step.updateMs).padStart(5)}ms` +
      `  wrote ${String(step.written).padStart(4)}  verify ${step.verifiedAfterUpdate ? "ok " : "FAIL"}${f2}`,
  );
}

function printSummary(summary: ReplaySummary): void {
  const rate = summary.f1CatchRate === null ? "not measured" : summary.f1CatchRate.toFixed(3);
  const rows: [string, string, string, string][] = [
    ["F1", "verify catch rate on a stale map", "=1.000", `${rate} (${summary.driftCaught}/${summary.driftTotal})`],
    ["F2", "full/incremental divergence", "=0", `${summary.f2Mismatches} of ${summary.f2Checks} checks`],
    ["", "incremental update p50 / p95", "-", `${summary.updateP50}ms / ${summary.updateP95}ms`],
  ];
  const header: [string, string, string, string] = ["ID", "Metric", "Target", "Measured"];
  const widths = [0, 1, 2, 3].map((column) =>
    Math.max(header[column]?.length ?? 0, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: [string, string, string, string]): string =>
    `  ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ")}`.trimEnd();

  console.log(`${SUITE}: ${summary.target} (${summary.commits} commits)`);
  console.log(line(header));
  for (const row of rows) console.log(line(row));
  console.log(
    `  no-ops: ${summary.noops} (${summary.noopsNoSourceChange} touched no source, ` +
      `${summary.noopsNoArtifactChange} changed source without changing the map)`,
  );
  for (const sha of summary.verifyFailedAfterUpdate) console.log(`  verify failed after update at ${sha}`);
  for (const sha of summary.verifyFalsePositives) console.log(`  verify reported drift with nothing to write at ${sha}`);
  for (const note of summary.anomalies) console.log(`  anomaly: ${note}`);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

interface Options {
  fixture: boolean;
  repo: string | undefined;
  tier: string;
  commits: number | undefined;
  f2Every: number | undefined;
  gate: boolean;
  dryRun: boolean;
  verbose: boolean;
  keep: boolean;
  /** Malformed numeric flags, reported instead of silently falling back. */
  errors: string[];
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    fixture: false,
    repo: undefined,
    tier: "S",
    commits: undefined,
    f2Every: undefined,
    gate: false,
    dryRun: false,
    verbose: false,
    keep: false,
    errors: [],
  };
  const int = (flag: string, value: string | undefined, minimum: number): number | undefined => {
    const parsed = Number.parseInt(value ?? "", 10);
    if (Number.isFinite(parsed) && parsed >= minimum) return parsed;
    // Silently falling back would walk 500 commits when someone asked for 50.
    options.errors.push(`${flag} needs an integer >= ${minimum}, got "${value ?? ""}"`);
    return undefined;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Unknown flags are ignored: `bench all` forwards one argument list to every suite.
    if (arg === "--fixture") options.fixture = true;
    else if (arg === "--gate") options.gate = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--repo") options.repo = args[++i];
    else if (arg === "--tier") options.tier = args[++i] ?? "S";
    else if (arg === "--commits") options.commits = int(arg, args[++i], 2);
    else if (arg === "--f2-every") options.f2Every = int(arg, args[++i], 0);
  }
  return options;
}

/**
 * `GREPLOST_BENCH_RESULTS_DIR` is a test-only escape hatch (see `results-io.ts`). If it is
 * set for a real run, results are not landing in `bench/results/` and nobody would know.
 */
function warnOnRedirectedResults(): void {
  const override = process.env["GREPLOST_BENCH_RESULTS_DIR"];
  if (!override || process.env["NODE_ENV"] === "test") return;
  console.error(
    `${SUITE}: warning: GREPLOST_BENCH_RESULTS_DIR is set, so results go to ${override} ` +
      "instead of bench/results/; that override is meant for tests only",
  );
}

export async function run(args: string[]): Promise<number> {
  const options = parseArgs(args);
  warnOnRedirectedResults();

  if (options.errors.length > 0) {
    for (const message of options.errors) console.error(`${SUITE}: ${message}`);
    if (options.gate) console.log(`${SUITE}: GATE FAIL (args)`);
    return 2;
  }

  let targets: Array<{ name: string; sha: string | null }>;
  try {
    targets = options.fixture
      ? [{ name: "tiny-ts", sha: null }]
      : selectRepos(argsForSelection(options)).map((entry) => ({ name: entry.name, sha: entry.sha }));
  } catch (err) {
    console.error(`${SUITE}: ${(err as Error).message}`);
    if (options.gate) console.log(`${SUITE}: GATE FAIL (targets)`);
    return 2;
  }
  if (targets.length === 0) {
    console.error(`${SUITE}: no repos in tier ${options.tier} in bench/corpus.json`);
    if (options.gate) console.log(`${SUITE}: GATE FAIL (targets)`);
    return 2;
  }

  if (options.dryRun) {
    for (const target of targets) console.log(`${SUITE}: ${target.name} (not run)`);
    console.log(`${SUITE}: dry-run ok`);
    return 0;
  }

  const runs: Array<{ name: string; sha: string | null; run: ReplayRun }> = [];
  try {
    for (const target of targets) {
      runs.push({
        ...target,
        run: await replay({
          fixture: options.fixture,
          ...(options.fixture ? {} : { repo: target.name }),
          ...(options.commits === undefined ? {} : { commits: options.commits }),
          ...(options.f2Every === undefined ? {} : { f2Every: options.f2Every }),
          verbose: options.verbose,
          keep: options.keep,
        }),
      });
    }
  } catch (err) {
    console.error(`${SUITE}: ${(err as Error).message}`);
    if (options.gate) console.log(`${SUITE}: GATE FAIL (error)`);
    return 1;
  }

  const summaries = runs.map((entry) => entry.run.summary);
  const overall = summaries.length === 1 ? (summaries[0] as ReplaySummary) : aggregate(summaries);
  const missed = missedGates(overall);

  writeResult(resultSuite(options.fixture), {
    corpus: runs.map((entry) => (entry.sha === null ? { name: entry.name } : { name: entry.name, sha: entry.sha })),
    machine: machineProfile(),
    targets: TARGETS,
    summary: overall,
    repos: runs.map((entry) => ({ name: entry.name, summary: entry.run.summary, steps: entry.run.steps })),
    gate: options.gate ? { passed: missed.length === 0, missed } : null,
  });

  if (!options.gate) return 0;
  if (missed.length > 0) {
    console.log(`${SUITE}: GATE FAIL (${missed.join(",")})`);
    return 1;
  }
  console.log(`${SUITE}: GATE PASS`);
  return 0;
}

/** `selectRepos` parses the corpus flags; hand it exactly the ones it owns. */
function argsForSelection(options: Options): string[] {
  return options.repo === undefined ? ["--tier", options.tier] : ["--repo", options.repo];
}
