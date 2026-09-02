/**
 * Bench 3: performance, P1 to P3 (tech spec 3, 10.5; bench spec 1.5.5).
 *
 *   P1  full build            <= 1 s at ~1k files, <= 10 s at ~10k   (gated)
 *   P2  incremental p95       <= 500 ms at ~1k files, <= 1 s at ~10k (gated)
 *   P3  peak RSS at 10k files <= 500 MB                              (reported)
 *
 * Plus the regression rule from 10.5: a p50 more than 15 % worse than the last
 * committed result *on the same CPU* fails the gate, whatever the absolute
 * numbers say.
 *
 * **Everything is measured in a child `bun` process** (`perf-child.ts`, which
 * explains why). The parent prepares the checkout, times the process around the
 * child, and reads the child's marked JSON line.
 *
 * **Every timed iteration has to do the work it claims to.** That is the thing
 * this suite is easiest to get wrong: a full rebuild against a `.greplost/`
 * that already holds the right bytes writes nothing, and a rename repeated
 * against a map that still describes the renamed tree changes nothing. So the
 * `full` scenario deletes the structure artifacts before each iteration, and
 * the rename re-baselines the map after each one, and the fixture test asserts
 * that both actually wrote something.
 *
 * Scenarios, in order (tech spec 10.5's list, plus one diagnostic):
 *
 *   full               `update --full` over a deleted `.greplost/` artifact set.
 *   incremental-1      append a comment to one seeded-random source file.
 *   incremental-10     the same for ten files.
 *   package-rename     rename a package directory (every id under it moves).
 *   parse-cache-save   `FileParseCache.save()` alone, see below.
 *
 * The last one is a diagnostic, never gated. `save()` serializes the whole
 * cache through `stableStringify`, which deep-clones every `FileRecord` in it
 * to sort keys before `JSON.stringify` sees them. That clone is inside every
 * incremental update's `ms`, and P2's budget is 500 ms, so what share of it
 * this one call takes is a number the sync package should be able to see.
 *
 * **Which statistic gates what.** P2 says "p95" in tech spec 3 and is gated on
 * p95. P1 says only "full build", so it is gated on p50, the build time a
 * person waits for, with p95 reported next to it; the regression rule is on
 * p50 for both, as 10.5 specifies. `package-rename` is reported but not gated:
 * it re-keys every id in the map and is a structural stress test, not the
 * latency an editor hook pays. (Ruling, leaf 1.5.5.)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { ARTIFACT_DIR, ARTIFACT_PATHS, compareStrings, type GreplostConfig, type Manifest } from "@greplost/core/schema";
import { init, listStructurePaths } from "@greplost/sync";

import { repoDir, selectRepos } from "./corpus.ts";
import { cloneWorkingCopy, copySourceTree, gitOrThrow, percentile } from "./git.ts";
import { machineProfile, type MachineProfile } from "./machine.ts";
import { MARKER, type ChildOp, type ChildReport } from "./perf-child.ts";
// The Go config override and the config writer are `replay.ts`'s; both suites
// have to build a corpus repo the same way or their numbers are not about the
// same map.
import { configFor, writeConfig } from "./replay.ts";
import { latestResult, writeResult } from "./results-io.ts";

const SUITE = "perf";

/**
 * Results file prefix. The hermetic fixture run writes under its own name, for
 * two reasons: `bench/results/<suite>-<date>-<sha7>.json` carries no other
 * discriminator, so a fixture run and a corpus run on the same day at the same
 * commit would write the *same file* and the twelve-file smoke numbers would
 * silently replace the corpus ones; and `latestResult("perf")`, the regression
 * baseline and what `report.ts` reads, must never resolve to a run of
 * `fixtures/tiny-ts`. (Ruling, leaf 1.5.5.)
 */
function resultSuite(fixture: boolean): string {
  return fixture ? `${SUITE}-fixture` : SUITE;
}

/** Repo root, from `bench/src/perf.ts`. */
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

/** The child entry point spawned once per timed iteration. */
const CHILD = path.join(import.meta.dir, "perf-child.ts");

/** Scenarios, in report order. */
export const SCENARIOS = [
  "full",
  "incremental-1",
  "incremental-10",
  "package-rename",
  "parse-cache-save",
] as const;

export type ScenarioName = (typeof SCENARIOS)[number];

/** Timed iterations per scenario, and warm-ups discarded before them (tech spec 10.5). */
const DEFAULT_ITERATIONS = 10;
const DEFAULT_WARMUPS = 2;

/** Files touched by the two incremental scenarios. */
const EDIT_SIZES: Readonly<Record<string, number>> = { "incremental-1": 1, "incremental-10": 10 };

/** Fixed seed, so the same repo always edits the same files. */
const FILE_SEED = 0x9e3779b9;

/** A child that has not answered in this long is hung, not slow. */
const CHILD_TIMEOUT_MS = 600_000;

/** Regression tolerance on p50 against the last result from the same CPU (tech spec 10.5). */
const REGRESSION_TOLERANCE = 0.15;

/** Floating-point slack, so a run exactly at the tolerance is not a regression. */
const EPSILON = 1e-9;

/** P3 is reported, not gated; this is the line RESULTS.md draws. */
export const PEAK_RSS_TARGET_BYTES = 500 * 1024 * 1024;

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface Stats {
  p50: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
  samples: number[];
}

export interface ScenarioResult {
  scenario: string;
  iterations: number;
  /** The operation's own milliseconds, as the child measured them. */
  ms: Stats;
  /** Wall clock of the child process, its startup included. */
  processMs: Stats;
  /** Highest `maxRSS` across the measured iterations, in bytes. */
  peakRssBytes: number;
  /**
   * What the operation reported about itself on the **last measured iteration**
   * only: files written and deleted, files reparsed and answered from the cache,
   * the dirty set size, and the raw RSS readings. Every iteration is set up
   * identically, so one is representative; it is kept because it is the evidence
   * that the iteration did the work its name claims (a `full` with `written: 0`
   * measured a build whose write half was skipped).
   */
  detail: Record<string, number>;
  /** What the scenario edited or renamed, so a number can be traced to a change. */
  subject?: string[];
  /** Why the scenario did not run, when it did not. */
  skipped?: string;
}

export interface RepoPerf {
  name: string;
  /** Corpus tier: `"S"` and `"M"` are gated on the absolute targets, the rest are not. */
  tier: string;
  files: number;
  scenarios: ScenarioResult[];
}

export interface PerfOptions {
  /** Measure `fixtures/tiny-ts` in a temporary git repo (hermetic). */
  fixture?: boolean;
  /** Corpus repo name; ignored when `fixture` is set. */
  repo?: string;
  /** Corpus tier when no repo is named. */
  tier?: string;
  iterations?: number;
  warmups?: number;
  quiet?: boolean;
  /** Leave the temporary working copies behind (debugging). */
  keep?: boolean;
}

export interface PerfRun {
  repos: RepoPerf[];
  machine: MachineProfile;
}

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

/** p50, p95, min, max and mean over `samples`, with the samples kept for the record. */
export function summarize(samples: readonly number[]): Stats {
  if (samples.length === 0) return { p50: 0, p95: 0, min: 0, max: 0, mean: 0, samples: [] };
  const values = [...samples];
  const total = values.reduce((a, b) => a + b, 0);
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    min: Math.min(...values),
    max: Math.max(...values),
    mean: total / values.length,
    samples: values,
  };
}

/**
 * The absolute budgets for a repo of `files` files (tech spec 3).
 *
 * Two points are given, ~1k and ~10k files; anything at or below the 1k point's
 * scale is held to the 1k budget and anything above it to the 10k budget. The
 * boundary sits at 2000 rather than 1000 so a "~1k files" repo that happens to
 * hold 1,300 files is not judged by the 10k budget.
 */
export function targetsFor(files: number): { p1Ms: number; p2Ms: number } {
  return files > 2000 ? { p1Ms: 10_000, p2Ms: 1000 } : { p1Ms: 1000, p2Ms: 500 };
}

/** Tiers whose absolute P1/P2 targets are gated (bench spec 1.5.5, tech spec 10.5). */
export const GATED_TIERS: ReadonlySet<string> = new Set(["S", "M"]);

/**
 * The absolute gate ids missed, in id order.
 *
 * Only tiers S and M are held to P1 and P2. The spec gates them there and
 * nowhere else, and the reason shows up in the numbers: the targets are written
 * for ~1k and ~10k files, so an L or XL repo measured on whatever hardware
 * happens to run the suite would fail a bound nobody agreed to. The regression
 * rule still applies to every tier, which is what actually catches a slowdown
 * on the large repos.
 */
export function missedTargets(repos: readonly RepoPerf[]): string[] {
  const missed = new Set<string>();
  for (const repo of repos) {
    if (!GATED_TIERS.has(repo.tier)) continue;
    const { p1Ms, p2Ms } = targetsFor(repo.files);
    for (const scenario of repo.scenarios) {
      if (scenario.iterations === 0) continue;
      if (scenario.scenario === "full" && scenario.ms.p50 > p1Ms) missed.add("P1");
      if (scenario.scenario in EDIT_SIZES && scenario.ms.p95 > p2Ms) missed.add("P2");
    }
  }
  return [...missed].sort(compareStrings);
}

/**
 * Scenarios whose p50 is more than `tolerance` worse than the last committed
 * result, as `<repo>/<scenario>`.
 *
 * Silent when there is nothing comparable: no prior result, a prior result from
 * a different CPU, or a prior run that never measured this scenario. A
 * benchmark that invents a baseline is worse than one that admits it has none,
 * so an absent comparison is an empty list, never a pass or a fail.
 */
export function regressedScenarios(
  current: readonly RepoPerf[],
  prior: unknown,
  machine: { cpu: string },
  tolerance: number = REGRESSION_TOLERANCE,
): string[] {
  const priorRepos = readPriorRepos(prior, machine.cpu);
  if (priorRepos === null) return [];

  const regressed: string[] = [];
  for (const repo of current) {
    const before = priorRepos.get(repo.name);
    if (before === undefined) continue;
    for (const scenario of repo.scenarios) {
      if (scenario.iterations === 0) continue;
      const baseline = before.get(scenario.scenario);
      if (baseline === undefined || baseline <= 0) continue;
      // Ratio rather than `baseline * (1 + tolerance)`: 100 * 1.15 is
      // 114.99999999999999 in binary floating point, which would fail a run that
      // came in at exactly the tolerance. EPSILON keeps the boundary inclusive.
      if ((scenario.ms.p50 - baseline) / baseline > tolerance + EPSILON) {
        regressed.push(`${repo.name}/${scenario.scenario}`);
      }
    }
  }
  return regressed.sort(compareStrings);
}

/** `repo -> scenario -> p50` from a prior payload, or null when it cannot be compared. */
function readPriorRepos(prior: unknown, cpu: string): Map<string, Map<string, number>> | null {
  if (!isRecord(prior)) return null;
  const machine = prior["machine"];
  if (!isRecord(machine) || machine["cpu"] !== cpu) return null;
  const repos = prior["repos"];
  if (!Array.isArray(repos)) return null;

  const out = new Map<string, Map<string, number>>();
  for (const repo of repos) {
    if (!isRecord(repo) || typeof repo["name"] !== "string") continue;
    const scenarios = repo["scenarios"];
    if (!Array.isArray(scenarios)) continue;
    const byName = new Map<string, number>();
    for (const scenario of scenarios) {
      if (!isRecord(scenario) || typeof scenario["scenario"] !== "string") continue;
      const ms = scenario["ms"];
      if (!isRecord(ms) || typeof ms["p50"] !== "number") continue;
      byName.set(scenario["scenario"], ms["p50"]);
    }
    out.set(repo["name"], byName);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// the child process
// ---------------------------------------------------------------------------

/** Spawn one child, and return its report plus the wall clock the parent saw. */
function measure(op: ChildOp, root: string): { report: ChildReport; processMs: number } {
  const started = performance.now();
  const res = spawnSync(process.execPath, [CHILD, op, root], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
  });
  const processMs = performance.now() - started;

  if (res.error) throw new Error(`${SUITE}: could not run the ${op} child: ${res.error.message}`);
  const line = (res.stdout ?? "").split("\n").find((entry) => entry.startsWith(MARKER));
  if (line === undefined) {
    throw new Error(
      `${SUITE}: the ${op} child produced no measurement (exit ${res.status ?? "?"}): ` +
        `${(res.stderr ?? "").trim().split("\n").slice(-5).join(" | ")}`,
    );
  }
  return { report: JSON.parse(line.slice(MARKER.length)) as ChildReport, processMs };
}

// ---------------------------------------------------------------------------
// targets and working copies
// ---------------------------------------------------------------------------

interface Target {
  name: string;
  /** The git repository the working copy is cloned from; "" for the fixture. */
  origin: string;
  sha: string | null;
  config: GreplostConfig | undefined;
  /** Corpus tier, which decides whether the absolute targets are gated. */
  tier: string;
}

/**
 * A private, writable checkout of `target`.
 *
 * Perf mutates the tree it measures (that is what an incremental update is), so
 * it never runs in `fixtures/tiny-ts` or in a corpus clone. The fixture is
 * copied into a fresh git repository (git present, because the dirty set is
 * computed from it and a checkout without git would be a different
 * measurement); a corpus repo is cloned the same way `replay.ts` clones it.
 */
function prepareWorkingCopy(target: Target, dest: string): void {
  if (target.origin === "") {
    const fixture = path.join(REPO_ROOT, "fixtures", "tiny-ts");
    if (!existsSync(fixture)) throw new Error(`${SUITE}: fixture not found at ${fixture}`);
    mkdirSync(dest, { recursive: true });
    copySourceTree(fixture, dest);
    gitOrThrow(dest, ["init", "--quiet", "-b", "main"]);
    gitOrThrow(dest, ["config", "user.name", "greplost bench"]);
    gitOrThrow(dest, ["config", "user.email", "bench@greplost.invalid"]);
    gitOrThrow(dest, ["config", "commit.gpgsign", "false"]);
    gitOrThrow(dest, ["add", "-A"]);
    gitOrThrow(dest, ["commit", "--quiet", "-m", "fixture"]);
    return;
  }
  if (!existsSync(path.join(target.origin, ".git"))) {
    throw new Error(
      `${SUITE}: ${target.name} is not cloned; run \`bun bench/src/cli.ts corpus setup --repo ${target.name}\``,
    );
  }
  cloneWorkingCopy(target.origin, dest, target.sha as string);
}

function readManifest(root: string): Manifest {
  const file = path.join(root, ARTIFACT_DIR, ARTIFACT_PATHS.manifest);
  return JSON.parse(readFileSync(file, "utf8")) as Manifest;
}

// ---------------------------------------------------------------------------
// deterministic file selection
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, and identical everywhere, which is all a seed needs to be. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` files from `files` (sorted), chosen by a fixed seed: same repo, same files. */
function pickFiles(files: readonly string[], count: number): string[] {
  const pool = [...files].sort(compareStrings);
  const random = seeded(FILE_SEED);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = pool[i] as string;
    pool[i] = pool[j] as string;
    pool[j] = a;
  }
  return pool.slice(0, Math.min(count, pool.length)).sort(compareStrings);
}

/**
 * The directory to rename, or undefined when the repo has none.
 *
 * The largest package by file count, ties broken by name: renaming the biggest
 * one moves the most ids, which is the point of the scenario. Packages rooted
 * at the repo itself are skipped: renaming the checkout is not a package
 * rename, it is a different repository.
 *
 * Not every repo is a monorepo. A single-module Go repo like `gin` has exactly
 * one package, rooted at the repo, and the manifest offers nothing to rename;
 * the scenario would silently not run on half the corpus. The fallback is the
 * top-level source directory holding the most indexed files, which for such a
 * repo is the same kind of change (every id under it moves and every import of
 * it stops resolving) even though the manifest does not call it a package.
 */
function renameCandidate(manifest: Manifest, root: string): string | undefined {
  const packages = Object.values(manifest.packages)
    .filter((entry) => entry.path !== "" && entry.path !== "." && entry.files > 0)
    .filter((entry) => existsSync(path.join(root, entry.path)))
    .sort((a, b) => b.files - a.files || compareStrings(a.path, b.path));
  if (packages[0] !== undefined) return packages[0].path;

  const byDirectory = new Map<string, number>();
  for (const file of Object.keys(manifest.files)) {
    const slash = file.indexOf("/");
    if (slash <= 0) continue;
    const directory = file.slice(0, slash);
    byDirectory.set(directory, (byDirectory.get(directory) ?? 0) + 1);
  }
  const directories = [...byDirectory.entries()]
    .filter(([directory]) => existsSync(path.join(root, directory)))
    .sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]));
  return directories[0]?.[0];
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

interface ScenarioContext {
  root: string;
  manifest: Manifest;
  iterations: number;
  warmups: number;
}

/**
 * Run one scenario: `warmups` discarded iterations, then `iterations` measured
 * ones. Each iteration mutates the checkout, measures one child process, and
 * puts the checkout back; the map is left describing the previous iteration's
 * bytes, which is exactly the one-edit-behind state an incremental update is
 * for.
 */
function runScenario(name: ScenarioName, ctx: ScenarioContext): ScenarioResult {
  const files = Object.keys(ctx.manifest.files).sort(compareStrings);
  const editSize = EDIT_SIZES[name];

  let mutate: ((iteration: number) => void) | undefined;
  let restore: (() => void) | undefined;
  let op: ChildOp = "incremental";
  let subject: string[] = [];
  // Whether the map has to be rebuilt after each iteration's restore before the
  // next mutation is a real change again. See the rename branch below.
  let rebaseline = false;

  if (name === "full") {
    op = "full";
    // Delete the structure artifacts first, or the timed build has nothing to
    // write: `writeArtifacts` compares bytes and skips what already matches, so
    // a full rebuild over a correct `.greplost/` measures the build and skips
    // the write, and P1 comes out too fast for the wrong reason. `config.json`
    // and the caches are left alone: they are not structure artifacts, and the
    // build must run against the same configuration every time.
    mutate = () => {
      const artifacts = path.join(ctx.root, ARTIFACT_DIR);
      for (const rel of listStructurePaths(artifacts)) rmSync(path.join(artifacts, rel), { force: true });
    };
  } else if (name === "parse-cache-save") {
    op = "cache-save";
  } else if (editSize !== undefined) {
    const chosen = pickFiles(files, editSize);
    if (chosen.length < editSize) {
      return skipped(name, `repo has ${files.length} indexed files, fewer than the ${editSize} this scenario edits`);
    }
    subject = chosen;
    const originals = new Map(chosen.map((file) => [file, readFileSync(path.join(ctx.root, file), "utf8")]));
    mutate = (iteration) => {
      for (const file of chosen) {
        writeFileSync(path.join(ctx.root, file), `${originals.get(file) ?? ""}\n// greplost perf ${iteration}\n`);
      }
    };
    restore = () => {
      for (const file of chosen) writeFileSync(path.join(ctx.root, file), originals.get(file) ?? "");
    };
  } else {
    const pkg = renameCandidate(ctx.manifest, ctx.root);
    if (pkg === undefined) return skipped(name, "repo has no package or source directory to rename");
    subject = [pkg];
    const from = path.join(ctx.root, pkg);
    const to = `${from}__greplost_perf`;
    mutate = () => renameSync(from, to);
    restore = () => {
      if (existsSync(to)) renameSync(to, from);
    };
    // The edit scenarios carry a new marker each iteration, so the tree always
    // differs from the map by exactly the files they touched. A rename does not:
    // once iteration 0 has been measured the map describes the renamed tree, and
    // renaming again reproduces the state the map is already in, so every later
    // iteration finds nothing changed and times an update that writes nothing.
    // Rebuilding after each restore puts the map back on the original layout, so
    // every iteration renames something the map has not seen.
    rebaseline = true;
  }

  const ms: number[] = [];
  const processMs: number[] = [];
  let peakRssBytes = 0;
  let detail: Record<string, number> = {};

  const total = ctx.warmups + ctx.iterations;
  for (let iteration = 0; iteration < total; iteration++) {
    mutate?.(iteration);
    let measured: { report: ChildReport; processMs: number };
    try {
      measured = measure(op, ctx.root);
    } finally {
      restore?.();
      // Untimed, and after the restore: the next iteration needs a map that
      // describes the tree as it stands, not as the last measurement left it.
      if (rebaseline) measure("full", ctx.root);
    }
    if (iteration < ctx.warmups) continue;
    ms.push(measured.report.ms);
    processMs.push(measured.processMs);
    peakRssBytes = Math.max(peakRssBytes, measured.report.peakRssBytes);
    detail = measured.report.detail;
  }

  // The tree is back to its committed bytes but the map still describes the last
  // mutation; put the two back in step before the next scenario measures anything,
  // or its first iteration would be timing two edits instead of one. The rename
  // has already done this after every iteration.
  //
  // `full` rather than `incremental` because it has no fast path to be wrong
  // about. This is also where leaf 1.5.5 found the false-clean bug: an
  // incremental update used to report `skipped: "clean"` here, over a map that
  // `verify` called stale, because reverting an uncommitted edit leaves no git
  // evidence and `.state.json` recorded only the commit. That is fixed on main
  // (`state.treeClean` joins the clean fast path); the full rebuild stays because
  // it does not depend on the fix being present.
  if (restore !== undefined && !rebaseline) measure("full", ctx.root);

  return {
    scenario: name,
    iterations: ms.length,
    ms: summarize(ms),
    processMs: summarize(processMs),
    peakRssBytes,
    detail,
    ...(subject.length === 0 ? {} : { subject }),
  };
}

function skipped(name: ScenarioName, reason: string): ScenarioResult {
  return {
    scenario: name,
    iterations: 0,
    ms: summarize([]),
    processMs: summarize([]),
    peakRssBytes: 0,
    detail: {},
    skipped: reason,
  };
}

// ---------------------------------------------------------------------------
// the suite
// ---------------------------------------------------------------------------

export async function perf(options: PerfOptions = {}): Promise<PerfRun> {
  const iterations = Math.max(1, options.iterations ?? DEFAULT_ITERATIONS);
  const warmups = Math.max(0, options.warmups ?? DEFAULT_WARMUPS);
  const quiet = options.quiet === true;
  const targets = resolveTargets(options);

  const created: string[] = [];
  const repos: RepoPerf[] = [];
  try {
    for (const target of targets) {
      const root = mkdtempSync(path.join(tmpdir(), "greplost-perf-"));
      created.push(root);
      prepareWorkingCopy(target, root);
      writeConfig(root, target.config);
      await init(root, { hooks: false, quiet: true });

      const manifest = readManifest(root);
      const files = Object.keys(manifest.files).length;
      if (!quiet) console.log(`${SUITE}: ${target.name} (${files} files, ${iterations} iterations)`);

      const scenarios = SCENARIOS.map((name) => {
        const result = runScenario(name, { root, manifest, iterations, warmups });
        if (!quiet) printScenario(result);
        return result;
      });
      repos.push({ name: target.name, tier: target.tier, files, scenarios });
    }
  } finally {
    if (options.keep !== true) {
      for (const dir of created) rmSync(dir, { recursive: true, force: true });
    }
  }

  return { repos, machine: machineProfile() };
}

function resolveTargets(options: PerfOptions): Target[] {
  // The fixture is tier S: it stands in for a small repo, and gate G6 requires
  // the absolute targets to hold on it.
  if (options.fixture === true) return [{ name: "tiny-ts", origin: "", sha: null, config: undefined, tier: "S" }];
  const args = options.repo === undefined ? ["--tier", options.tier ?? "S"] : ["--repo", options.repo];
  return selectRepos(args).map((entry) => ({
    name: entry.name,
    origin: repoDir(entry.name),
    sha: entry.sha,
    config: configFor(entry),
    tier: entry.tier,
  }));
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

function printScenario(result: ScenarioResult): void {
  if (result.skipped !== undefined) {
    console.log(`  ${result.scenario.padEnd(18)} skipped: ${result.skipped}`);
    return;
  }
  console.log(
    `  ${result.scenario.padEnd(18)} p50 ${fmt(result.ms.p50)}  p95 ${fmt(result.ms.p95)}` +
      `  peak RSS ${mb(result.peakRssBytes)}  process p50 ${fmt(result.processMs.p50)}`,
  );
}

function printTable(repos: readonly RepoPerf[]): void {
  for (const repo of repos) {
    const { p1Ms, p2Ms } = targetsFor(repo.files);
    const full = repo.scenarios.find((s) => s.scenario === "full");
    const single = repo.scenarios.find((s) => s.scenario === "incremental-1");
    const ten = repo.scenarios.find((s) => s.scenario === "incremental-10");
    const peak = Math.max(0, ...repo.scenarios.map((s) => s.peakRssBytes));
    const rows: [string, string, string, string][] = [
      ["P1", "full build (p50)", `<=${fmt(p1Ms)}`, full === undefined ? "not run" : fmt(full.ms.p50)],
      [
        "P2",
        "incremental update (p95)",
        `<=${fmt(p2Ms)}`,
        [single, ten]
          .map((s) => (s === undefined || s.iterations === 0 ? "not run" : fmt(s.ms.p95)))
          .join(" / "),
      ],
      ["P3", "peak RSS", `<=${mb(PEAK_RSS_TARGET_BYTES)} at 10k files`, mb(peak)],
    ];
    const header: [string, string, string, string] = ["ID", "Metric", "Target", "Measured"];
    const widths = [0, 1, 2, 3].map((column) =>
      Math.max(header[column]?.length ?? 0, ...rows.map((row) => row[column]?.length ?? 0)),
    );
    const line = (cells: [string, string, string, string]): string =>
      `  ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ")}`.trimEnd();
    console.log(`${SUITE}: ${repo.name} (${repo.files} files)`);
    console.log(line(header));
    for (const row of rows) console.log(line(row));
  }
}

function fmt(ms: number): string {
  return `${Math.round(ms)}ms`;
}

function mb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}MB`;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

interface Options {
  fixture: boolean;
  repo: string | undefined;
  tier: string;
  iterations: number | undefined;
  warmups: number | undefined;
  gate: boolean;
  dryRun: boolean;
  keep: boolean;
  /** Malformed numeric flags, reported instead of silently falling back. */
  errors: string[];
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    fixture: false,
    repo: undefined,
    tier: "S",
    iterations: undefined,
    warmups: undefined,
    gate: false,
    dryRun: false,
    keep: false,
    errors: [],
  };
  const int = (flag: string, value: string | undefined, minimum: number): number | undefined => {
    const parsed = Number.parseInt(value ?? "", 10);
    if (Number.isFinite(parsed) && parsed >= minimum) return parsed;
    // Silently falling back would run ten iterations when someone asked for one
    // and waited for the answer.
    options.errors.push(`${flag} needs an integer >= ${minimum}, got "${value ?? ""}"`);
    return undefined;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Unknown flags are ignored: `bench all` forwards one argument list to every suite.
    if (arg === "--fixture") options.fixture = true;
    else if (arg === "--gate") options.gate = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--repo") options.repo = args[++i];
    else if (arg === "--tier") options.tier = args[++i] ?? "S";
    else if (arg === "--iterations") options.iterations = int(arg, args[++i], 1);
    else if (arg === "--warmups") options.warmups = int(arg, args[++i], 0);
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

  let targets: Target[];
  try {
    targets = resolveTargets({
      fixture: options.fixture,
      ...(options.repo === undefined ? {} : { repo: options.repo }),
      tier: options.tier,
    });
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
    printTable(targets.map((target) => ({ name: target.name, tier: target.tier, files: 0, scenarios: [] })));
    console.log(`${SUITE}: dry-run ok`);
    return 0;
  }

  // Read the baseline before writing this run's result, or the comparison would
  // find the file it is about to write. The fixture has no baseline by design:
  // twelve files put the measurement inside process-startup noise, where a 15 %
  // rule reports the machine's mood rather than greplost's (gate G6 says the
  // fixture is gated on the absolute targets only).
  const prior = options.fixture ? undefined : latestResult(SUITE);

  let measured: PerfRun;
  try {
    measured = await perf({
      fixture: options.fixture,
      ...(options.repo === undefined ? {} : { repo: options.repo }),
      tier: options.tier,
      ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
      ...(options.warmups === undefined ? {} : { warmups: options.warmups }),
      keep: options.keep,
    });
  } catch (err) {
    console.error(`${SUITE}: ${(err as Error).message}`);
    if (options.gate) console.log(`${SUITE}: GATE FAIL (error)`);
    return 1;
  }

  printTable(measured.repos);

  const missed = missedTargets(measured.repos);
  const regressed = regressedScenarios(measured.repos, prior?.payload, measured.machine);
  if (regressed.length > 0) {
    console.log(
      `${SUITE}: p50 regressed by more than ${Math.round(REGRESSION_TOLERANCE * 100)}% vs ${
        prior?.file ?? "the previous result"
      }: ${regressed.join(", ")}`,
    );
    missed.push("regression");
  }

  writeResult(resultSuite(options.fixture), {
    corpus: targets.map((target) => (target.sha === null ? { name: target.name } : { name: target.name, sha: target.sha })),
    machine: measured.machine,
    iterations: options.iterations ?? DEFAULT_ITERATIONS,
    warmups: options.warmups ?? DEFAULT_WARMUPS,
    targets: Object.fromEntries(measured.repos.map((repo) => [repo.name, targetsFor(repo.files)])),
    peakRssTargetBytes: PEAK_RSS_TARGET_BYTES,
    repos: measured.repos,
    // Which run this was compared against, by name *and* by the date and sha
    // inside it: a same-day rerun at the same commit writes to the same path, so
    // the filename alone does not say which measurement the comparison used.
    baseline:
      prior === undefined
        ? null
        : {
            file: path.basename(prior.file),
            date: prior.payload["date"] ?? null,
            greplostSha: prior.payload["greplostSha"] ?? null,
            regressed,
          },
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

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
