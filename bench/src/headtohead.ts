/**
 * X1 to X10: greplost against Graphify, Understand-Anything and code-review-graph
 * (tech spec 3.1, 10.0; bench leaf 1.5.7).
 *
 * Every competitor number in this file comes from **running the tool**. Its own
 * pinned version, its own install commands, its own documented run commands from
 * `bench/competitors.json`, in a copy of the target repo under
 * `bench/.competitors/<tool>/<repo>/`, converted through the adapters in
 * `src/adapters/` so all four tools are scored by the same code against the same
 * compiler truth.
 *
 * Three rules keep the table honest:
 *
 *  1. **N/A is not zero.** A tool that is not installed, needs credentials, or has
 *     no such capability records `{ value: null, verdict: "na", reason }`. A zero
 *     would say it ran and scored nothing (tech spec 10.0).
 *  2. **The committed fixtures under `bench/fixtures/competitors/` are never
 *     scored.** They are hand-written slices of each tool's documented schema, and
 *     they exist so the adapters have a round-trip test. Scoring one would put a
 *     number we wrote ourselves in a competitor's column.
 *  3. **Every greplost step runs.** greplost's own column is measured on this
 *     machine even when every competitor is N/A, so the target column always has
 *     something to compare against.
 *
 * Verdict convention, which `RESULTS.md` repeats: on the `greplost` cell the
 * verdict is against the section 3.1 target; on a competitor's cell it is
 * greplost's verdict *against that tool*, `win` means greplost came out ahead by
 * the metric's margin.
 *
 *   bun bench/src/cli.ts headtohead --fixture
 *   bun bench/src/cli.ts headtohead --tier S --metrics X1,X4,X5,X6
 *   bun bench/src/cli.ts headtohead --fixture --dry-run
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { compareStrings, type Edge, type Snapshot } from "@greplost/core/schema";

import { adapters } from "./adapters/index.ts";
import type { CompetitorArtifact } from "./adapters/types.ts";
import { machineProfile } from "./machine.ts";
import { gitSha7, latestResult, todayIso, writeResult } from "./results-io.ts";
import { scoreEdges, type Score } from "./score.ts";
import { X_IDS, scopeTarget, type MetricCell, type MetricRow, type RunTarget, type Verdict, type XId } from "./results-md.ts";
import { scoredFiles } from "./structural.ts";
import { generateTsTruth, type Truth } from "./truth/ts.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const SUITE = "headtohead";

/**
 * Where one run's result lands: `headtohead` for a corpus run, `headtohead-fixture` for
 * a `--fixture` run (the same split `perf`, `replay`, `agent` and `structural` make).
 *
 * A fixture run and a corpus run on the same day at the same commit would otherwise write
 * the *same file*, and the twelve-file fixture numbers would replace the corpus ones under
 * it. `latestResult("headtohead")` and the report's head-to-head table must never resolve
 * to a fixture run.
 */
export function resultSuite(fixture: boolean): string {
  return fixture ? `${SUITE}-fixture` : SUITE;
}

/** Where the installed competitor binaries and the sandbox HOME live. Gitignored. */
const COMPETITORS_DIR = path.join(REPO_ROOT, "bench", ".competitors");
/**
 * Where a competitor's repo copy and its artifacts live.
 *
 * `GREPLOST_BENCH_WORK_DIR` redirects it, the way
 * `GREPLOST_BENCH_RESULTS_DIR` redirects the results. The screenshot suite runs
 * a fixture X4 to photograph its output, and without the redirect that run left
 * `bench/.competitors/graphify/tiny-ts` behind, which the agent suite reads as
 * "graphify has artifacts here", so taking a screenshot changed another suite's
 * conditions. A benchmark must not be a side effect of a screenshot.
 */
const WORK_DIR = process.env["GREPLOST_BENCH_WORK_DIR"] ?? COMPETITORS_DIR;
/**
 * Where `uv tool install` / `pipx install` put the competitor binaries, if used.
 * Always the real directory: a redirected work dir must still find the tools.
 */
const LOCAL_BIN = path.join(COMPETITORS_DIR, "_bin");
/**
 * The HOME every competitor process runs under.
 *
 * All three tools write outside the repository they are pointed at:
 * `code-review-graph` keeps `~/.code-review-graph/registry.json` and
 * `~/.code-review-graph/watch.toml`, `graphify install` writes a global
 * `CLAUDE.md` section and a Claude Code `PreToolUse` hook, and the
 * Understand-Anything plugin installs into `~/.claude`. A benchmark has no
 * business editing the machine's real Claude Code configuration to measure a
 * competitor, so every competitor process gets this directory as `$HOME`, with
 * the XDG variables and `CLAUDE_CONFIG_DIR` pointed inside it too. It is
 * gitignored along with the rest of `bench/.competitors/`.
 *
 * The install steps that only add executables (`uv tool install graphifyy`,
 * `pipx install code-review-graph`) are not run from here at all; they are the
 * operator's to run, and this suite records N/A when their binaries are absent.
 */
const SANDBOX_HOME = path.join(COMPETITORS_DIR, "home");
/**
 * Wrapper scripts placed ahead of everything on `PATH` for the replay.
 *
 * Two jobs, both required by the documented-sync arm of X2.
 *
 * First, resolution. Every one of these tools installs a git hook that guards
 * itself with `command -v <tool>`: greplost's hook falls back to `bunx greplost`
 * (which would hit the npm registry from a throwaway repo), and crg's
 * pre-commit hook does nothing at all when its binary is absent. A hook that
 * silently no-ops would be recorded as "the tool did not keep up", which would
 * be a measurement of this harness's PATH. The shim makes each tool resolvable
 * exactly as an install would.
 *
 * Second, evidence. The shim writes a `start` line before running the real
 * binary and an `end` line after, both with a monotonic timestamp. That is how
 * this suite knows a hook fired rather than assuming it, how it waits for a
 * backgrounded rebuild to finish rather than sleeping a guessed interval, and
 * how X3 times every tool the same way: wall-clock between `start` and `end` of
 * a child process, interpreter startup included, for greplost as much as for
 * the competitors.
 */
const SHIM_DIR = path.join(WORK_DIR, "_shim");
/** Nothing a competitor is asked to do may take longer than this. */
const TOOL_TIMEOUT_MS = 600_000;

/** greplost plus the three competitors, in `bench/competitors.json` order. */
export const TOOLS = ["greplost", "graphify", "ua", "crg"] as const;
export type Tool = (typeof TOOLS)[number];
export type CompetitorName = "graphify" | "ua" | "crg";
const COMPETITORS: readonly CompetitorName[] = ["graphify", "ua", "crg"];

// ---------------------------------------------------------------------------
// the metric plan
// ---------------------------------------------------------------------------

export interface MetricDef {
  id: XId;
  title: string;
  /** Verbatim from tech spec 3.1. */
  target: string;
  /** Direction of the headline value when greplost is compared with a competitor. */
  higherIsBetter: boolean;
  /**
   * The gap that separates a tie from a win or a loss. For X1 it is the section
   * 3.1 margin itself (+10 points on calls); elsewhere it is the smallest
   * difference worth calling a difference.
   */
  margin: number;
  /** What the headline `value` of each cell means. */
  unit: string;
}

/** X1 to X10 in table order. `results-md.ts` carries the same titles for an empty report. */
export const METRIC_PLAN: readonly MetricDef[] = [
  { id: "X1", title: "Structural precision vs compiler truth", target: ">= +10pt calls, >= +3pt imports", higherIsBetter: true, margin: 0.1, unit: "call edge precision" },
  // X2 and X3 are written in tech spec 3.1 against 500 commits. A run that walks
  // 24 or 100 must not print "500": `scaleTitles` rewrites both from the walk
  // that actually happened before the payload is written, and a run with no walk
  // keeps the spec's wording with "(not walked)" attached.
  { id: "X2", title: "Staleness after 500 replayed commits", target: "greplost F1 >= 0.99", higherIsBetter: true, margin: 0.01, unit: "F1 vs compiler truth at the last checkpoint" },
  { id: "X3", title: "Cost to stay fresh over 500 commits", target: "<= 1% of ua, <= 20% of graphify", higherIsBetter: false, margin: 0.01, unit: "USD" },
  { id: "X4", title: "Reproducibility: two builds of one commit", target: "0 bytes differ", higherIsBetter: false, margin: 1, unit: "bytes differing" },
  { id: "X5", title: "Diff signal after a one-line change", target: "<= 10 artifact lines", higherIsBetter: false, margin: 1, unit: "artifact lines changed" },
  { id: "X6", title: "Cold start to first usable map", target: "<= 5s and $0 (tier M)", higherIsBetter: false, margin: 0.25, unit: "seconds" },
  { id: "X7", title: "Agent structural tasks", target: "accuracy >= best, tool calls <= 50% of best", higherIsBetter: true, margin: 0.01, unit: "answer accuracy" },
  { id: "X8", title: "Orientation cost", target: "<= 50% of best competitor tokens", higherIsBetter: false, margin: 1, unit: "tokens to first correct answer" },
  { id: "X9", title: "Reviewer task: spot the new cross-package dependency", target: "fastest, highest hit rate", higherIsBetter: false, margin: 1, unit: "seconds to a correct answer" },
  { id: "X10", title: "Cross-repo blast radius in workspace mode", target: "works (capability, not a score)", higherIsBetter: true, margin: 1, unit: "capability" },
];

const PLAN_BY_ID = new Map(METRIC_PLAN.map((metric) => [metric.id, metric]));

// ---------------------------------------------------------------------------
// verdicts
// ---------------------------------------------------------------------------

/**
 * greplost against one competitor on one metric.
 *
 * A missing number on either side is `na`, never a win: "we could not run it" and
 * "we beat it" are different claims and only one of them is a measurement.
 */
export function verdictFor(opts: {
  ours: number | null;
  theirs: number | null;
  higherIsBetter: boolean;
  margin: number;
}): Verdict {
  const { ours, theirs, higherIsBetter, margin } = opts;
  if (ours === null || theirs === null || !Number.isFinite(ours) || !Number.isFinite(theirs)) return "na";
  const gap = higherIsBetter ? ours - theirs : theirs - ours;
  if (gap >= margin) return "win";
  if (gap <= -margin) return "loss";
  return "tie";
}

/** A cell that was not measured. Always carries a reason (tech spec 10.0). */
function na(target: string, reason: string): MetricCell {
  return { value: null, target, verdict: "na", reason };
}

function measured(
  value: number | string,
  target: string,
  verdict: Verdict,
  reason: string,
  detail?: Record<string, number>,
): MetricCell {
  return detail === undefined
    ? { value, target, verdict, reason }
    : { value, target, verdict, reason, detail };
}

/**
 * Rewrite X2's and X3's title and target for the walk that was actually run.
 *
 * Section 3.1 words both against 500 commits. Printing that over a 24-commit
 * walk states a result nobody measured, in the one column a reader trusts to be
 * the target. `commits` of 0 means no walk happened and the row says so.
 */
export function scaleTitles(metrics: Record<XId, MetricRow>, commits: number): void {
  const walked = commits > 0 ? `${commits} replayed commit${commits === 1 ? "" : "s"}` : "no replayed commits";
  const x2 = metrics["X2"];
  x2.title = `Staleness after ${walked}`;
  x2.target = commits > 0 ? `greplost F1 >= 0.99 after ${commits} commits` : "greplost F1 >= 0.99 (not walked)";
  const x3 = metrics["X3"];
  x3.title = `Cost to stay fresh over ${walked}`;
  x3.target = commits > 0
    ? `<= 1% of ua, <= 20% of graphify over ${commits} commits`
    : "<= 1% of ua, <= 20% of graphify (not walked)";
  for (const [id, row] of [["X2", x2], ["X3", x3]] as const) {
    void id;
    for (const cell of Object.values(row.tools)) cell.target = row.target;
  }
}

/**
 * Give every `loss` cell a reason, from the numbers, when its metric did not.
 *
 * Not a substitute for a written reason, the metrics that have one keep it,
 * but a backstop, because "every loss carries a one-line reason" is a rule
 * about the published table and not about the diligence of whoever wrote the
 * eleventh metric. `na` cells are left alone: their reasons are collected under
 * the table instead.
 */
export function fillMissingReasons(metrics: Record<XId, MetricRow>): void {
  for (const row of Object.values(metrics)) {
    const ours = row.tools["greplost"];
    for (const [tool, cell] of Object.entries(row.tools)) {
      if (tool === "greplost" || cell.verdict !== "loss" || cell.reason.length > 0) continue;
      cell.reason =
        ours === undefined || ours.value === null
          ? `${tool} measured ${String(cell.value)} on ${row.title.toLowerCase()}, and greplost has no comparable number`
          : `${tool} measured ${String(cell.value)} against greplost's ${String(ours.value)} on ${row.title.toLowerCase()}`;
    }
  }
}

/** The full X1 to X10 skeleton with every cell `na` for one reason. */
export function emptyMetrics(reason: string): Record<XId, MetricRow> {
  const out = {} as Record<XId, MetricRow>;
  for (const metric of METRIC_PLAN) {
    const tools: Record<string, MetricCell> = {};
    for (const tool of TOOLS) tools[tool] = na(metric.target, reason);
    out[metric.id] = { id: metric.id, title: metric.title, target: metric.target, tools };
  }
  return out;
}

// ---------------------------------------------------------------------------
// arguments and target
// ---------------------------------------------------------------------------

interface Options {
  fixture: boolean;
  repo: string | undefined;
  tier: string;
  metrics: Set<XId> | null;
  commits: number | undefined;
  /**
   * Which X2 arms to walk. The documented-sync arm alone by default: the
   * refresh-every-commit arm is a second full walk of every tool, which on a
   * tier-M repo is tens of minutes for a curve that is a companion, not the
   * finding (`--arms both` asks for it).
   */
  arms: Arm[];
  dryRun: boolean;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    fixture: false,
    repo: undefined,
    tier: "S",
    metrics: null,
    commits: undefined,
    arms: ["documented-sync"],
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Unknown flags are ignored: `bench all` forwards one argument list to every suite.
    if (arg === "--fixture") options.fixture = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--repo") options.repo = args[++i];
    else if (arg === "--tier") options.tier = args[++i] ?? "S";
    else if (arg === "--commits") {
      // A non-numeric or negative value means "no walk" rather than NaN commits.
      const parsed = Number(args[++i]);
      options.commits = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
    }
    else if (arg === "--arms") {
      const value = (args[++i] ?? "").trim().toLowerCase();
      options.arms = value === "both" ? ["documented-sync", "refresh-every-commit"] : ["documented-sync"];
    }
    else if (arg === "--metrics") {
      const list = (args[++i] ?? "").split(",").map((id) => id.trim().toUpperCase());
      options.metrics = new Set(list.filter((id): id is XId => (X_IDS as readonly string[]).includes(id)));
    }
  }
  return options;
}

interface Target {
  name: string;
  root: string;
  sha: string | null;
  tier: string | null;
  lang: string;
}

function resolveTarget(options: Options): Target | string {
  if (options.fixture) {
    return { name: "tiny-ts", root: path.join(REPO_ROOT, "fixtures", "tiny-ts"), sha: null, tier: null, lang: "ts" };
  }
  const file = path.join(REPO_ROOT, "bench", "corpus.json");
  if (!existsSync(file)) return `${SUITE}: bench/corpus.json is missing; pass --fixture`;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    repos?: { name: string; sha?: string; tier?: string; lang?: string }[];
  };
  const repos = parsed.repos ?? [];
  const wanted =
    options.repo === undefined
      ? repos.filter((repo) => (repo.tier ?? "S") === options.tier && (repo.lang ?? "ts") === "ts")
      : repos.filter((repo) => repo.name === options.repo);
  const first = wanted[0];
  if (first === undefined) {
    return options.repo === undefined
      ? `${SUITE}: no TypeScript repo in tier ${options.tier} in bench/corpus.json`
      : `${SUITE}: unknown repo "${options.repo}" in bench/corpus.json`;
  }
  const root = path.join(REPO_ROOT, "bench", ".corpus", first.name);
  if (!existsSync(root)) {
    return `${SUITE}: ${first.name} is not checked out; run \`bun bench/src/cli.ts corpus setup --tier ${options.tier}\` or pass --fixture`;
  }
  return { name: first.name, root, sha: first.sha ?? null, tier: first.tier ?? null, lang: first.lang ?? "ts" };
}

// ---------------------------------------------------------------------------
// competitors.json
// ---------------------------------------------------------------------------

interface CompetitorSpec {
  name: string;
  version: string;
  commit: string;
  install: string[];
  run: string[];
  artifactPaths: string[];
  syncMechanism: string | null;
}

export function competitorSpecs(): Map<string, CompetitorSpec> {
  const out = new Map<string, CompetitorSpec>();
  const file = path.join(REPO_ROOT, "bench", "competitors.json");
  if (!existsSync(file)) return out;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { tools?: CompetitorSpec[] };
  for (const tool of parsed.tools ?? []) out.set(tool.name, tool);
  return out;
}

/**
 * How each competitor is invoked here, and why that is or is not the tool's
 * documented path. Written out in full because it is the part of a head-to-head
 * that a competitor's maintainer would want to argue with.
 */
interface Invocation {
  /** The executable to look for on PATH (and in `bench/.competitors/_bin`). */
  binary: string;
  /** Commands run in the repo copy, in order. */
  commands: string[][];
  /** Artifact files compared for X4 and X5, relative to the repo copy. */
  artifacts: string[];
  /** The command a fresh clone needs for X6, if it differs from `commands`. */
  coldStart?: string[][];
  /** The incremental refresh a commit triggers, for X2/X3. */
  refresh?: string[][];
  /**
   * The tool's own commit-time sync mechanism, installed exactly as its README
   * describes, for X2's documented-sync arm. Defaults to `commands` for a tool
   * that has nothing extra to install.
   */
  syncInstall?: string[][];
  /**
   * The part of `refresh` whose wall-clock X3 counts.
   *
   * Split from `refresh` because crg keeps its graph in SQLite and only
   * `visualize --format json` writes the JSON the adapters read: charging its
   * refresh for an export step greplost has no equivalent of is the timing
   * asymmetry review round 1 found. The export moves to `exportAtCheckpoint`.
   */
  refreshTimed?: string[][];
  /** An export run only at scoring checkpoints, never inside a timed refresh. */
  exportAtCheckpoint?: string[][];
  /** Anything the reader must know about a deviation from the README. */
  caveat: string | null;
  /** True when the tool cannot be driven from a shell at all. */
  headless: boolean;
}

const INVOCATIONS: Record<CompetitorName, Invocation> = {
  graphify: {
    binary: "graphify",
    // `bench/competitors.json` lists `/graphify .` first: that is a Claude Code
    // slash command whose first pass runs an LLM over the repo. `graphify update
    // .` is the documented AST-only rebuild ("re-extract code files and update
    // the graph (no LLM needed)"), which is the only path that can run here
    // without model credentials, and the only fair one, since greplost's
    // structure layer is LLM-free too.
    commands: [["update", "."]],
    refresh: [["update", "."]],
    refreshTimed: [["update", "."]],
    // X2's documented-sync arm: build the graph, then let `graphify hook
    // install` write the post-commit and post-checkout hooks its README
    // documents. The hooks land in the repo copy's own `.git/hooks`, inside the
    // work directory, so nothing outside the sandbox is touched.
    syncInstall: [["update", "."], ["hook", "install"]],
    artifacts: ["graphify-out/graph.json", "graphify-out/GRAPH_REPORT.md", "graphify-out/manifest.json"],
    caveat:
      "run through `graphify update .` (the documented no-LLM rebuild) rather than the `/graphify .` " +
      "slash command, which needs a model; graph.html is excluded from the byte comparison because it is " +
      "a viewer, not the graph. `graphify hook install` is run in X2's documented-sync arm, where the hooks " +
      "it writes go into the repo copy's own .git/hooks; `graphify install`, which writes a global CLAUDE.md " +
      "section and a Claude Code PreToolUse hook, is not run",
    headless: true,
  },
  ua: {
    binary: "understand-anything",
    commands: [],
    artifacts: [".ua/knowledge-graph.json", ".ua/meta.json"],
    caveat:
      "distributed only as a Claude Code plugin, and `/understand` is a multi-agent LLM pipeline: there is no " +
      "headless CLI, so the only way to drive it is `claude --plugin-dir <clone>/understand-anything-plugin " +
      "-p \"/understand\"` against a clone pinned at v2.9.0, inside the scratch HOME. That spends model tokens " +
      "on every commit of every metric, so this harness does not run it and never installs the plugin into the " +
      "machine\u2019s real Claude Code configuration",
    headless: false,
  },
  crg: {
    binary: "code-review-graph",
    // `build` + `visualize --format json` are the documented commands that
    // produce the artifact; `update` is the documented incremental path.
    //
    // `code-review-graph install` is run only in X2's documented-sync arm,
    // under the sandbox HOME (driver ruling 2026-09-03): it detects the AI
    // coding tools it can see and writes their MCP configuration, per-repo
    // instruction files and a git pre-commit hook. Everything it writes lands
    // either in the repo copy or in `bench/.competitors/home`; the machine's
    // real `~/.claude`, `~/.claude.json`, `~/.code-review-graph` and global
    // CLAUDE.md are never in its path.
    commands: [["build"], ["visualize", "--format", "json"]],
    refresh: [["update"], ["visualize", "--format", "json"]],
    refreshTimed: [["update"]],
    exportAtCheckpoint: [["visualize", "--format", "json"]],
    syncInstall: [["install"], ["build"], ["visualize", "--format", "json"]],
    artifacts: [".code-review-graph/graph.json"],
    caveat:
      "`build` + `visualize --format json` produce the artifact; `graph.db` is excluded from the byte " +
      "comparison because a SQLite page layout is not the tool's output contract. `code-review-graph install` " +
      "runs only in X2's documented-sync arm and only with HOME, XDG_* and CLAUDE_CONFIG_DIR pointed inside " +
      "bench/.competitors/home",
    headless: true,
  },
};

/** Absolute path of a competitor binary, from PATH or `bench/.competitors/_bin`. */
export function findBinary(name: string): string | null {
  const local = path.join(LOCAL_BIN, name);
  if (existsSync(local)) return local;
  const which = spawnSync("sh", ["-c", `command -v ${JSON.stringify(name)}`], { encoding: "utf8" });
  const found = which.status === 0 ? which.stdout.trim() : "";
  return found.length > 0 && existsSync(found) ? found : null;
}

interface CompetitorState {
  name: CompetitorName;
  spec: CompetitorSpec | undefined;
  binary: string | null;
  /** The version the binary reports, when it has a `--version`. */
  reportedVersion: string | null;
  /** The repo copy this tool works in, once prepared. */
  dir: string | null;
  /** Loaded graph, once its artifact exists. */
  artifact: CompetitorArtifact | null;
  /** Why this tool is N/A, when it is. */
  reason: string | null;
}

function unavailableReason(name: CompetitorName, spec: CompetitorSpec | undefined): string {
  const invocation = INVOCATIONS[name];
  if (!invocation.headless) return invocation.caveat ?? "no headless entry point";
  // Verbatim from `bench/competitors.json`, which is where each tool's own
  // README commands were recorded. Paraphrasing it here would let this file and
  // the pinned record drift, and the pinned record is the one a maintainer of
  // the tool would check.
  const install = (spec?.install ?? []).join(" && ");
  return `not installed on this machine; its documented install is \`${install || "recorded in bench/competitors.json"}\``;
}

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

interface Ran {
  ok: boolean;
  ms: number;
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * The environment a competitor process sees: ours, with every "where do I keep
 * my settings" variable redirected into `SANDBOX_HOME`.
 */
export function sandboxEnv(): NodeJS.ProcessEnv {
  mkdirSync(SANDBOX_HOME, { recursive: true });
  return {
    ...process.env,
    HOME: SANDBOX_HOME,
    XDG_CONFIG_HOME: path.join(SANDBOX_HOME, ".config"),
    XDG_DATA_HOME: path.join(SANDBOX_HOME, ".local", "share"),
    XDG_STATE_HOME: path.join(SANDBOX_HOME, ".local", "state"),
    XDG_CACHE_HOME: path.join(SANDBOX_HOME, ".cache"),
    // Claude Code reads this before falling back to $HOME/.claude; graphify's
    // and UA's installers both write there.
    CLAUDE_CONFIG_DIR: path.join(SANDBOX_HOME, ".claude"),
  };
}

/** Env var the shims read to find the log they append to. */
const HOOK_LOG_ENV = "GREPLOST_BENCH_HOOK_LOG";

/**
 * Write a shim for `name` that logs its invocation and then runs `real`.
 *
 * `exec` is deliberately not used: the shim has to outlive the child so it can
 * record the `end` line, which is what makes "wait until the hook has finished"
 * exact rather than a sleep.
 */
export function writeShim(name: string, real: string): string {
  mkdirSync(SHIM_DIR, { recursive: true });
  const file = path.join(SHIM_DIR, name);
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      `# bench shim for ${name} (bench/src/headtohead.ts). Logs the call, runs the real binary.`,
      "# Millisecond stamps through perl: BSD date has no %N, and X3 times refreshes",
      "# that take a hundred milliseconds, so second resolution would report them as 0.",
      "_now() { perl -MTime::HiRes -e 'printf \"%.0f\", Time::HiRes::time()*1000' 2>/dev/null || echo 0; }",
      `_log="\${${HOOK_LOG_ENV}:-}"`,
      `if [ -n "$_log" ]; then printf '%s\t%s\t%s\n' "start" "${name}" "$(_now)" >> "$_log"; fi`,
      `${JSON.stringify(real)} "$@"`,
      "_status=$?",
      `if [ -n "$_log" ]; then printf '%s\t%s\t%s\t%s\n' "end" "${name}" "$(_now)" "$_status" >> "$_log"; fi`,
      "exit $_status",
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  return file;
}

/**
 * A shim for greplost's own CLI, so its hook's `command -v greplost` resolves.
 *
 * The runner spells out `process.execPath` rather than the word `bun`: a git
 * hook inherits whatever PATH the commit had, and a benchmark that resolved its
 * own runtime differently from the way it resolved the competitors' would be
 * measuring its own PATH again.
 */
export function writeGreplostShim(): string {
  mkdirSync(SHIM_DIR, { recursive: true });
  const runner = path.join(SHIM_DIR, "greplost-real");
  const main = path.join(REPO_ROOT, "packages", "cli", "src", "main.ts");
  writeFileSync(runner, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(main)} "$@"\n`);
  chmodSync(runner, 0o755);
  return writeShim("greplost", runner);
}

interface HookCall {
  phase: "start" | "end";
  tool: string;
  at: number;
}

/** Parse the shim log. Malformed lines are skipped: one bad line is not a fact. */
export function readHookLog(file: string): HookCall[] {
  if (!existsSync(file)) return [];
  const out: HookCall[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const [phase, tool, at] = line.split("\t");
    if ((phase !== "start" && phase !== "end") || tool === undefined || at === undefined) continue;
    const stamp = Number(at);
    if (!Number.isFinite(stamp)) continue;
    out.push({ phase, tool, at: stamp });
  }
  return out;
}

/**
 * Milliseconds one tool spent inside shimmed calls, and how many calls there
 * were, over `calls`. An unmatched `start` (a process still running, or one
 * killed) contributes a call but no time.
 */
export function shimTime(calls: readonly HookCall[], tool: string): { ms: number; runs: number; pending: number } {
  let ms = 0;
  let runs = 0;
  let open: number | null = null;
  for (const call of calls) {
    if (call.tool !== tool) continue;
    if (call.phase === "start") {
      runs++;
      open = call.at;
      continue;
    }
    if (open !== null) {
      ms += Math.max(0, call.at - open);
      open = null;
    }
  }
  return { ms, runs, pending: open === null ? 0 : 1 };
}

/**
 * The duration of each completed shimmed call for one tool, in order.
 *
 * `shimTime` sums; this keeps them apart, which is what "wait for the rebuild
 * this commit started and charge only that one" needs.
 */
export function shimRuns(calls: readonly HookCall[], tool: string): number[] {
  const out: number[] = [];
  let open: number | null = null;
  for (const call of calls) {
    if (call.tool !== tool) continue;
    if (call.phase === "start") {
      open = call.at;
      continue;
    }
    if (open !== null) {
      out.push(Math.max(0, call.at - open));
      open = null;
    }
  }
  return out;
}

function runTool(binary: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Ran {
  const started = Date.now();
  const result = spawnSync(binary, args, {
    cwd,
    encoding: "utf8",
    timeout: TOOL_TIMEOUT_MS,
    ...(env === undefined ? {} : { env }),
    // A competitor must not inherit our stdin, and must not be able to hang on it.
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: result.error === undefined && result.status === 0,
    ms: Date.now() - started,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error === undefined ? "" : result.error.message),
    code: result.status,
  };
}

/** `<binary> --version`, trimmed to one line; null when the tool has no such flag. */
function versionOf(binary: string): string | null {
  const ran = runTool(binary, ["--version"], REPO_ROOT, sandboxEnv());
  const line = ran.stdout.split("\n")[0]?.trim() ?? "";
  return ran.ok && line.length > 0 ? line : null;
}

/** Everything a tool writes that is not source: excluded when a repo copy is made. */
const COPY_EXCLUDE = new Set([".git", ".greplost", "graphify-out", ".ua", ".code-review-graph", "node_modules"]);

/** A clean copy of `root` at `dest`, without any tool's artifacts or history. */
function copyRepo(root: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(root)) {
    if (COPY_EXCLUDE.has(entry)) continue;
    cpSync(path.join(root, entry), path.join(dest, entry), { recursive: true });
  }
}

/**
 * A clean copy of `root` at `dest`, made into its own git repository.
 *
 * The `git init` is not optional, and the reason is a bug this suite had:
 * `bench/.competitors/` is gitignored by the greplost checkout, so a copy placed
 * there without its own repository is *inside an ignored path*, and greplost's
 * own file discovery, which honours ignore rules, indexed 12 of the fixture's
 * files as none of them. greplost then scored a flawless zero-line diff on an
 * empty map. Every tool gets its own repository so every tool sees the same tree.
 *
 * code-review-graph needs it for a second reason: it anchors its artifact at the
 * enclosing git root, so without one it indexes the whole greplost checkout and
 * writes outside the work directory.
 */
function prepareCopy(root: string, dest: string): void {
  copyRepo(root, dest);
  initGit(dest);
}

/** A git repository at `dest` with one commit. */
function initGit(dest: string): boolean {
  const steps: string[][] = [
    ["init", "-q", "."],
    ["-c", "user.email=bench@greplost.invalid", "-c", "user.name=bench", "add", "-A"],
    ["-c", "user.email=bench@greplost.invalid", "-c", "user.name=bench", "commit", "-qm", "bench baseline"],
  ];
  for (const args of steps) {
    if (!runTool("git", args, dest).ok) return false;
  }
  return true;
}

/** Every file under `dir`, recursively. */
function countFiles(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(path.join(dir, entry.name));
    else total++;
  }
  return total;
}

function readAll(dir: string, relativePaths: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of relativePaths) {
    const full = path.join(dir, ...rel.split("/"));
    if (existsSync(full) && statSync(full).isFile()) out.set(rel, readFileSync(full, "utf8"));
  }
  return out;
}

/** Bytes and files differing between two readings of the same artifact set. */
export function byteDelta(a: Map<string, string>, b: Map<string, string>): { bytes: number; files: number } {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let bytes = 0;
  let files = 0;
  for (const key of [...keys].sort(compareStrings)) {
    const left = a.get(key) ?? "";
    const right = b.get(key) ?? "";
    if (left === right) continue;
    files++;
    bytes += byteDistance(left, right);
  }
  return { bytes, files };
}

/**
 * How many bytes differ between two versions of one artifact.
 *
 * The common prefix and the common suffix are trimmed first, and what is left in
 * the middle is the answer: the larger of the two remainders. That is an upper
 * bound on the true edit distance, exact for a single contiguous edit, which is
 * what a rebuild of the same tree produces when it produces anything, and it
 * costs one linear scan from each end.
 *
 * The naive position-wise comparison this replaced called a one-byte insertion
 * near the top of an 80KB JSON file "80,000 bytes differ", which is a number
 * that flatters greplost and slanders the tool it is measuring. A real
 * Levenshtein over megabyte artifacts would not finish; this does, and it does
 * not lie by an order of magnitude.
 */
export function byteDistance(a: string, b: string): number {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  const shortest = Math.min(left.length, right.length);

  let prefix = 0;
  while (prefix < shortest && left[prefix] === right[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix++;
  }

  return Math.max(left.length - prefix - suffix, right.length - prefix - suffix);
}

/**
 * What changed between two builds, in words: which artifact files differ, which
 * of their top-level JSON keys differ, and whether a wall-clock timestamp is
 * among the differing values.
 *
 * "79,098 bytes differ" is a number; "the `nodes` and `edges` arrays differ and
 * `stats.last_updated` is a timestamp" is a finding a maintainer can act on, and
 * the publishing rule (tech spec 10.0) is that a loss carries a reason. Nothing
 * here is tool-specific: it compares parsed JSON structurally and recognises an
 * ISO-8601 scalar, which is as far as a generic reader can honestly go.
 */
export function describeDifference(a: Map<string, string>, b: Map<string, string>): string {
  const parts: string[] = [];
  let timestamp = false;
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort(compareStrings)) {
    const left = a.get(key);
    const right = b.get(key);
    if (left === right) continue;
    if (left === undefined || right === undefined) {
      parts.push(`${key} (${left === undefined ? "added" : "removed"})`);
      continue;
    }
    const keys = differingJsonKeys(left, right);
    parts.push(keys.length === 0 ? key : `${key} (${keys.join(", ")})`);
    if (!timestamp) timestamp = hasDifferingTimestamp(left, right);
  }
  if (parts.length === 0) return "";
  const detail = parts.slice(0, 4).join("; ");
  return `${detail}${parts.length > 4 ? `, and ${parts.length - 4} more` : ""}` +
    (timestamp ? "; at least one differing value is a wall-clock timestamp" : "");
}

/** Top-level keys whose values differ, for two texts that both parse as JSON objects. */
function differingJsonKeys(a: string, b: string): string[] {
  let left: unknown;
  let right: unknown;
  try {
    left = JSON.parse(a);
    right = JSON.parse(b);
  } catch {
    return [];
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (leftRecord === null || rightRecord === null) return [];
  const out: string[] = [];
  for (const key of [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort(compareStrings)) {
    if (JSON.stringify(leftRecord[key]) !== JSON.stringify(rightRecord[key])) out.push(key);
  }
  return out;
}

/** True when the two texts hold different ISO-8601-looking values. */
function hasDifferingTimestamp(a: string, b: string): boolean {
  const pattern = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g;
  const left = a.match(pattern) ?? [];
  const right = b.match(pattern) ?? [];
  if (left.length === 0 && right.length === 0) return false;
  return left.join(",") !== right.join(",");
}

/**
 * Which artifact files a one-line source change moved, and by how many lines
 * each, the same treatment X4's `describeDifference` gives bytes.
 *
 * "40 of 902 lines" is a number. "`INDEX.md` 2 lines, `graph/imports.jsonl` 1
 * line, `packages/core/MAP.md` 6 lines" is a finding: it says whether the churn
 * is the edge that was added or a renumbering of everything downstream of it,
 * which is the whole question X5 asks. Files are listed largest first, capped so
 * the reason column stays a sentence, with the tail counted rather than dropped.
 */
export function describeLineChange(a: Map<string, string>, b: Map<string, string>, limit = 4): string {
  const moved: { file: string; lines: number }[] = [];
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort(compareStrings)) {
    const left = a.get(key);
    const right = b.get(key);
    if (left === right) continue;
    if (left === undefined || right === undefined) {
      moved.push({ file: `${key} (${left === undefined ? "added" : "removed"})`, lines: (right ?? left ?? "").split("\n").length });
      continue;
    }
    moved.push({ file: key, lines: diffLineCount(left.split("\n"), right.split("\n")) });
  }
  if (moved.length === 0) return "";
  // Largest first, and ties by name so the sentence is the same on two runs.
  moved.sort((x, y) => (y.lines - x.lines) || compareStrings(x.file, y.file));
  const shown = moved.slice(0, limit).map((entry) => `\`${entry.file}\` ${entry.lines} line${entry.lines === 1 ? "" : "s"}`);
  const rest = moved.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? `, and ${rest} more file${rest === 1 ? "" : "s"}` : ""}`;
}

/** Lines added plus lines removed between two texts, per file, summed. */
export function lineDelta(a: Map<string, string>, b: Map<string, string>): { lines: number; files: number; total: number } {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let lines = 0;
  let files = 0;
  let total = 0;
  for (const key of [...keys].sort(compareStrings)) {
    const left = (a.get(key) ?? "").split("\n");
    const right = (b.get(key) ?? "").split("\n");
    total += right.length;
    if (a.get(key) === b.get(key)) continue;
    files++;
    lines += diffLineCount(left, right);
  }
  return { lines, files, total };
}

/**
 * Added plus removed lines, from a longest-common-subsequence over line hashes.
 *
 * Capped: over `LCS_CAP` lines on either side the quadratic table is replaced by
 * a multiset difference, which is exact for "how many distinct lines moved" and
 * an approximation for reordering. The cap is stated in RESULTS.md next to X5.
 */
const LCS_CAP = 4000;
export function diffLineCount(a: readonly string[], b: readonly string[]): number {
  if (a.length > LCS_CAP || b.length > LCS_CAP) {
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    for (const line of b) counts.set(line, (counts.get(line) ?? 0) - 1);
    let total = 0;
    for (const value of counts.values()) total += Math.abs(value);
    return total;
  }
  // Classic LCS length table over lines; the diff size is |a| + |b| - 2 * lcs.
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = new Int32Array(cols);
  let current = new Int32Array(cols);
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      current[j] = a[i - 1] === b[j - 1]
        ? (previous[j - 1] ?? 0) + 1
        : Math.max(previous[j] ?? 0, current[j - 1] ?? 0);
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  const lcs = previous[cols - 1] ?? 0;
  return a.length + b.length - 2 * lcs;
}

// ---------------------------------------------------------------------------
// greplost neighbours, loaded lazily so --dry-run never touches core
// ---------------------------------------------------------------------------

type BuildSnapshot = (opts: { root: string }) => Promise<Snapshot>;
type BuildArtifacts = (root: string) => Promise<{ snapshot: Snapshot; files: Map<string, string> }>;

async function loadBuildSnapshot(): Promise<BuildSnapshot> {
  const specifier = "@greplost/core";
  const mod = (await import(specifier)) as Partial<{ buildSnapshot: BuildSnapshot }>;
  if (typeof mod.buildSnapshot !== "function") throw new Error("greplost: @greplost/core does not export buildSnapshot");
  return mod.buildSnapshot;
}

async function loadBuildArtifacts(): Promise<BuildArtifacts> {
  const specifier = "@greplost/sync";
  const mod = (await import(specifier)) as Partial<{ buildArtifacts: BuildArtifacts }>;
  if (typeof mod.buildArtifacts !== "function") throw new Error("greplost: @greplost/sync does not export buildArtifacts");
  return mod.buildArtifacts;
}

type SyncInit = (root: string, opts?: { hooks?: boolean; quiet?: boolean }) => Promise<unknown>;
type SyncUpdate = (root: string, opts: { mode: "incremental" | "full"; quiet?: boolean }) => Promise<unknown>;

/**
 * greplost's own sync mechanism, used the way its git hook uses it: `init` once,
 * then one incremental `update` per commit. The sync API is called in process
 * rather than through the installed hook because a hook resolves its binary from
 * PATH at run time, and a throwaway replay repository has no greplost on PATH:
 * the hook would degrade to a no-op and the measurement would be of the harness.
 */
async function loadSync(): Promise<{ init: SyncInit; update: SyncUpdate }> {
  const specifier = "@greplost/sync";
  const mod = (await import(specifier)) as Partial<{ init: SyncInit; update: SyncUpdate }>;
  if (typeof mod.init !== "function" || typeof mod.update !== "function") {
    throw new Error("greplost: @greplost/sync does not export init and update");
  }
  return { init: mod.init, update: mod.update };
}

/**
 * greplost's committed graph, read off disk.
 *
 * X2 asks how stale each tool's *artifact* is, so greplost is scored on the
 * bytes in `.greplost/graph/*.jsonl`, the thing a reviewer would read, and not
 * on a fresh in-memory rebuild, which by definition can never be stale.
 */
export function readGreplostArtifact(dir: string): { imports: Edge[]; calls: Edge[] } | null {
  const read = (rel: string): Edge[] | null => {
    const file = path.join(dir, ".greplost", ...rel.split("/"));
    if (!existsSync(file)) return null;
    const edges: Edge[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        edges.push(JSON.parse(line) as Edge);
      } catch {
        // One unreadable line must not cost the whole artifact its score.
      }
    }
    return edges;
  };
  const imports = read("graph/imports.jsonl");
  const calls = read("graph/calls.jsonl");
  return imports === null ? null : { imports, calls: calls ?? [] };
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export async function run(args: string[]): Promise<number> {
  const options = parseArgs(args);

  // Before `resolveTarget`, on purpose. A dry run measures nothing, so it must
  // not need the corpus to be checked out: `bench all --dry-run` on a fresh
  // clone used to exit 2 here, which made the one command whose whole job is to
  // work everywhere the one command that did not.
  if (options.dryRun) {
    printPlan(options);
    console.log(`${SUITE}: dry-run ok`);
    return 0;
  }

  const resolved = resolveTarget(options);
  if (typeof resolved === "string") {
    // A corpus checkout is only needed by the metrics that read a repository.
    // X9 is the human study and X10 is a capability probe of the workspace CLI
    // against its own fixture: neither opens a corpus repo, and demanding one
    // made `bench:headtohead --metrics X10`, a free, hermetic run, impossible
    // on a machine with no corpus (review round 3, important 5).
    if (needsCorpus(options.metrics)) {
      console.error(resolved);
      return 2;
    }
    console.log(`${SUITE}: no corpus needed for ${[...(options.metrics ?? new Set(X_IDS))].join(",")}`);
    return await guarded(options, NO_CORPUS_TARGET);
  }
  return await guarded(options, resolved);
}

async function guarded(options: Options, target: Target): Promise<number> {
  try {
    return await execute(options, target);
  } catch (err) {
    console.error(`${SUITE}: ${(err as Error).message}`);
    return 1;
  }
}

/** The metrics that read no repository at all (tech spec 10.0: X9 and X10). */
const CORPUS_FREE_METRICS: ReadonlySet<XId> = new Set<XId>(["X9", "X10"]);

/** True when any selected metric needs a corpus checkout. */
export function needsCorpus(metrics: ReadonlySet<XId> | null): boolean {
  return X_IDS.some((id) => (metrics === null || metrics.has(id)) && !CORPUS_FREE_METRICS.has(id));
}

/**
 * The stand-in target for a run that opens no repository.
 *
 * `root` is empty and nothing reads it: `execute` skips the competitor copies and the
 * oracle when no selected metric needs a corpus, and the payload records no corpus and
 * no run scale rather than naming a repo that was never touched.
 */
const NO_CORPUS_TARGET: Target = { name: "", root: "", sha: null, tier: null, lang: "ts" };

function printPlan(options: Options): void {
  const selected = (id: XId): boolean => options.metrics === null || options.metrics.has(id);
  console.log(`${SUITE}: plan (${options.fixture ? "fixture tiny-ts" : `tier ${options.tier}`})`);
  console.log(`  ${"ID".padEnd(4)}${"Target".padEnd(46)}Metric`);
  for (const metric of METRIC_PLAN) {
    const mark = selected(metric.id) ? " " : "-";
    console.log(`${mark} ${metric.id.padEnd(4)}${metric.target.padEnd(46)}${metric.title}`);
  }
  console.log(`  tools: ${TOOLS.join(", ")}`);
  for (const name of COMPETITORS) {
    const binary = findBinary(INVOCATIONS[name].binary);
    console.log(`  ${name}: ${binary === null ? "not installed here (would record n/a)" : `would run ${binary}`}`);
  }
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

async function execute(options: Options, target: Target): Promise<number> {
  const selected = (id: XId): boolean => options.metrics === null || options.metrics.has(id);
  // A run of corpus-free metrics only (X9, X10) opens no repository: no competitor
  // copy, no snapshot, no oracle, and a payload that records no corpus and no scale
  // rather than a repo nothing was measured on.
  const corpusRun = needsCorpus(options.metrics);
  const skipped = "not selected by --metrics";
  const metrics = emptyMetrics(skipped);
  const method: string[] = [];
  const specs = competitorSpecs();

  const states = new Map<CompetitorName, CompetitorState>();
  for (const name of COMPETITORS) {
    const spec = specs.get(name);
    const invocation = INVOCATIONS[name];
    const binary = invocation.headless ? findBinary(invocation.binary) : null;
    states.set(name, {
      name,
      spec,
      binary,
      reportedVersion: binary === null ? null : versionOf(binary),
      dir: null,
      artifact: null,
      reason: binary === null ? unavailableReason(name, spec) : null,
    });
    // Only a run that would have invoked the competitors says anything about how they
    // were invoked. A corpus-free run (X9, X10) never reaches for a competitor binary,
    // and its "not installed here" line would land in `RESULTS.md` beside another run's
    // "ran through `graphify update .`", two true sentences reading as a contradiction.
    if (!corpusRun) continue;
    if (invocation.caveat !== null && binary !== null) method.push(`${name}: ${invocation.caveat}.`);
    if (binary !== null) {
      method.push(
        `${name}: every command ran with HOME=${path.relative(REPO_ROOT, SANDBOX_HOME)} (XDG and ` +
          "CLAUDE_CONFIG_DIR pointed inside it), so nothing it writes outside the repo copy reaches the " +
          "machine's real configuration.",
      );
    }
    if (binary === null) method.push(`${name}: N/A, ${unavailableReason(name, spec)}.`);
  }

  // One repo copy and one tool run per competitor, reused by X1, X4, X5 and X6.
  for (const state of corpusRun ? states.values() : []) {
    if (state.binary === null) continue;
    const dir = path.join(WORK_DIR, state.name, target.name);
    prepareCopy(target.root, dir);
    const failure = runInvocation(state, dir, INVOCATIONS[state.name].commands);
    state.dir = dir;
    if (failure !== null) {
      state.reason = failure;
      method.push(`${state.name}: run failed, ${failure}.`);
      continue;
    }
    const loaded = loadArtifact(state.name, dir, specs.get(state.name)?.version ?? "unknown");
    if (typeof loaded === "string") {
      state.reason = loaded;
      method.push(`${state.name}: artifact not readable, ${loaded}.`);
    } else {
      state.artifact = loaded;
    }
  }

  // The snapshot and the compiler oracle are what X1, X2 and X5 need. X4, X6 and
  // X10 do not, and a repo whose toolchain the oracle cannot load must not cost
  // the whole table: the metrics that depend on it record why, and the rest run.
  let snapshot: Snapshot | null = null;
  let truth: Truth | null = null;
  let oracleFailure: string | null = corpusRun ? null : "no selected metric reads a repository";
  if (corpusRun) {
    try {
      const snapshotBuilder = await loadBuildSnapshot();
      snapshot = await snapshotBuilder({ root: target.root });
      truth = generateTsTruth(target.root, scoredFiles(snapshot, "ts"));
    } catch (err) {
      oracleFailure = (err as Error).message;
      method.push(`X1, X2, X5: ${snapshot === null ? "the greplost snapshot" : "the compiler oracle"} could not be built, ${oracleFailure}.`);
    }
  }
  // The file universe X1, X2 and X5 score inside: the compiler's file list when
  // the oracle loaded, and greplost's own scored files when it did not.
  const scoredFileCount =
    truth !== null && truth.files.length > 0
      ? truth.files.length
      : snapshot === null
        ? 0
        : scoredFiles(snapshot, target.lang === "go" ? "go" : "ts").length;

  const noOracle = (what: string): string =>
    `${what} needs compiler truth for ${target.name}, which could not be built here: ${oracleFailure ?? "unknown reason"}`;

  if (selected("X1")) {
    if (snapshot !== null && truth !== null) await metricX1(metrics, snapshot, truth, states, method);
    else for (const tool of TOOLS) (metrics["X1"] as MetricRow).tools[tool] = na(METRIC_PLAN[0]?.target ?? "", noOracle("X1"));
  }
  let walked = 0;
  let sync: SyncEvidence[] = [];
  if (selected("X2") || selected("X3")) {
    if (snapshot !== null) {
      const walk = await metricX2X3(metrics, target, snapshot, states, method, selected, options.commits ?? 0, options.arms);
      walked = walk.commits;
      sync = walk.sync;
    } else {
      for (const tool of TOOLS) {
        if (selected("X2")) (metrics["X2"] as MetricRow).tools[tool] = na(METRIC_PLAN[1]?.target ?? "", noOracle("X2"));
        if (selected("X3")) (metrics["X3"] as MetricRow).tools[tool] = na(METRIC_PLAN[2]?.target ?? "", noOracle("X3"));
      }
    }
  }
  if (selected("X4")) await metricX4(metrics, target, states, method);
  if (selected("X5")) {
    if (snapshot !== null) await metricX5(metrics, target, snapshot, states, method);
    else for (const tool of TOOLS) (metrics["X5"] as MetricRow).tools[tool] = na(METRIC_PLAN[4]?.target ?? "", noOracle("X5"));
  }
  if (selected("X6")) await metricX6(metrics, target, states, method);
  if (selected("X7") || selected("X8")) metricX7X8(metrics, states, method, selected);
  if (selected("X9")) metricX9(metrics, method);
  if (selected("X10")) metricX10(metrics, states, method);

  // The publishing rule (tech spec 10.0) is that every loss carries a reason.
  // Enforced here rather than trusted to eleven call sites: a metric added later
  // cannot publish a silent loss.
  fillMissingReasons(metrics);

  // X2 and X3 are worded against 500 commits in tech spec 3.1. Printing that
  // over a 24- or 100-commit walk states a target nobody tested, in the one
  // column a reader trusts to be the target (review round 1, important 6).
  scaleTitles(metrics, walked);

  // The scale the numbers were taken at, and the scoping it implies. Both the
  // payload and the renderer need it, and only the payload is committed: a
  // target that says "(tier M)" in the JSON and "(measured on anyq, tier S, not
  // tier M)" in the document is one fact with two spellings, and the one a
  // future reader diffs is the JSON (review round 2, minor).
  // A corpus-free run has no scale to record: an empty target renders as
  // "Measured <date> at <sha>." rather than as a repo and a file count nobody took.
  const runTarget: RunTarget = corpusRun
    ? {
        repo: target.name,
        fixture: options.fixture,
        ...(options.fixture || (target.tier ?? options.tier) === null ? {} : { tier: (target.tier ?? options.tier) as string }),
        files: scoredFileCount,
        commits: walked,
      }
    : {};
  for (const row of Object.values(metrics)) {
    row.target = scopeTarget(row.target, runTarget);
    for (const cellValue of Object.values(row.tools)) cellValue.target = scopeTarget(cellValue.target, runTarget);
  }

  const rows = METRIC_PLAN.map((metric) => metrics[metric.id]);
  printTable(rows);

  const payload = {
    suite: SUITE,
    date: todayIso(),
    greplostSha: gitSha7(),
    machine: machineProfile(),
    corpus: !corpusRun
      ? []
      : target.sha === null
        ? [{ name: target.name }]
        : [{ name: target.name, sha: target.sha, ...(target.tier === null ? {} : { tier: target.tier }), lang: target.lang }],
    // The scale the numbers were taken at, so `RESULTS.md` can print it beside
    // them and refuse to print a tier-scoped target against a fixture run
    // (review round 1, critical 3). `files` is the file universe the oracle and
    // every prediction were cut to, which is the honest size of what was measured.
    target: runTarget,
    tools: [...TOOLS],
    // Per-commit evidence that each tool's own mechanism fired, so "100 of 100
    // commits" is auditable from the repository without re-running the walk.
    sync,
    competitors: Object.fromEntries(
      [...states.values()].map((state) => [
        state.name,
        {
          pinnedVersion: state.spec?.version ?? "unknown",
          reportedVersion: state.reportedVersion,
          binary: state.binary === null ? null : path.relative(REPO_ROOT, state.binary),
          // Recorded because it is the answer to "did this benchmark touch my
          // machine": every competitor process ran with this as its $HOME.
          home: path.relative(REPO_ROOT, SANDBOX_HOME),
          artifactDir: state.dir === null ? null : path.relative(REPO_ROOT, state.dir),
          ran: state.artifact !== null,
          reason: state.reason,
          caveat: INVOCATIONS[state.name].caveat,
          syncMechanism: state.spec?.syncMechanism ?? null,
        },
      ]),
    ),
    metrics: Object.fromEntries(rows.map((row) => [row.id, row])),
    winLossTie: tally(rows),
    method,
  };

  const file = writeResult(resultSuite(options.fixture), payload);
  console.log(`${SUITE}: wrote ${path.relative(REPO_ROOT, file)}`);
  return 0;
}

function runInvocation(
  state: CompetitorState,
  dir: string,
  commands: readonly string[][],
  env: NodeJS.ProcessEnv = sandboxEnv(),
): string | null {
  if (state.binary === null) return unavailableReason(state.name, state.spec);
  for (const args of commands) {
    // Every competitor command runs under the scratch HOME, without exception:
    // `build`, `update` and `visualize` all touch the tool's own global state.
    // The caller may hand in an env that also puts the shim directory on PATH,
    // but it is always built from `sandboxEnv()`.
    const ran = runTool(state.binary, args, dir, env);
    if (!ran.ok) {
      const detail = (ran.stderr || ran.stdout).split("\n").filter((l) => l.trim().length > 0).slice(-1)[0] ?? "";
      return `\`${state.name} ${args.join(" ")}\` exited ${ran.code ?? "on a signal"}${detail ? `: ${detail.trim()}` : ""}`;
    }
  }
  return null;
}

function loadArtifact(name: CompetitorName, dir: string, version: string): CompetitorArtifact | string {
  const adapter = adapters.find((candidate) => candidate.tool === name);
  if (adapter === undefined) return `no adapter registered for ${name}`;
  if (!adapter.detect(dir)) return `no ${name} artifact under ${path.relative(REPO_ROOT, dir)} after its documented run commands`;
  try {
    const artifact = adapter.load(dir, dir);
    return { ...artifact, version };
  } catch (err) {
    return (err as Error).message;
  }
}

// ---------------------------------------------------------------------------
// X1: structural precision, three-way
// ---------------------------------------------------------------------------

/**
 * Both sides are cut to the same universe before scoring: the files the compiler
 * actually loaded (`Truth.files`). A competitor that indexes `*.test.ts` is not
 * charged false positives for files greplost chose not to look at, and greplost
 * is not credited for files the oracle could not speak about (bench spec 1.5.2's
 * note, tech spec 10.0).
 */
async function metricX1(
  metrics: Record<XId, MetricRow>,
  snapshot: Snapshot,
  truth: Truth,
  states: Map<CompetitorName, CompetitorState>,
  method: string[],
): Promise<void> {
  const plan = PLAN_BY_ID.get("X1") as MetricDef;
  const universe = new Set(truth.files.length > 0 ? truth.files : scoredFiles(snapshot, "ts"));
  const inUniverse = (id: string): boolean => universe.has(fileOf(id));

  const truthImports = truth.imports.filter((e) => inUniverse(e.from) && inUniverse(e.to));
  const truthCalls = truth.calls.filter((e) => inUniverse(e.from) && inUniverse(e.to));

  /**
   * Score one tool's graph.
   *
   * Both arms are computed for every tool, including greplost. The verdict is
   * decided on `calls`, which is every call edge the tool emitted at any
   * confidence, the symmetric comparison, and the one tech spec 10.0's claim is
   * about ("greplost never emits an unresolved edge; LLM-extracted graphs do"),
   * because that claim is about what a tool *publishes*, not about a subset a
   * reader could filter to.
   *
   * `callsHigh` is the same score restricted to `confidence: "high"` on both
   * sides; greplost's S3 gate, and the tier graphify calls `EXTRACTED` and crg
   * calls its `EXTRACTED` tier. It is reported next to the headline rather than
   * used for it: scoring greplost at `high` while scoring a competitor at every
   * confidence would charge the competitor for edges greplost simply declined to
   * publish, which flatters greplost on precision by construction. That is how
   * this metric was written first, and it was wrong.
   */
  const score = (imports: Edge[], calls: Edge[]): { imports: Score; calls: Score; callsHigh: Score } => {
    const scoped = (edges: Edge[]): Edge[] => edges.filter((e) => inUniverse(e.from) && inUniverse(e.to));
    return {
      imports: scoreEdges(scoped(imports), truthImports),
      calls: scoreEdges(scoped(calls), truthCalls),
      callsHigh: scoreEdges(scoped(calls).filter((e) => e.confidence === "high"), truthCalls),
    };
  };

  const ours = score(
    snapshot.imports.filter((e) => !e.to.startsWith("ext:") && !e.to.startsWith("unresolved:")),
    [...snapshot.calls],
  );
  method.push(
    `X1: both sides restricted to the ${universe.size} files the TypeScript compiler loaded, and both scored ` +
      "over every edge each tool emits at any confidence. The confidence=high arm (greplost's S3 gate, " +
      "graphify's and crg's `EXTRACTED` tier) is reported beside it in each cell's detail; scoring greplost " +
      "at high while scoring a competitor at every confidence would flatter greplost on precision by " +
      "construction.",
  );

  const row = metrics["X1"];
  const detailOf = (result: { imports: Score; calls: Score; callsHigh: Score }): Record<string, number> => ({
    importPrecision: result.imports.precision,
    importRecall: result.imports.recall,
    callPrecision: result.calls.precision,
    callRecall: result.calls.recall,
    callPrecisionHighOnly: result.callsHigh.precision,
    callRecallHighOnly: result.callsHigh.recall,
    importTp: result.imports.tp,
    importFp: result.imports.fp,
    callTp: result.calls.tp,
    callFp: result.calls.fp,
  });

  let bestCallPrecision: number | null = null;
  let bestImportPrecision: number | null = null;
  for (const state of states.values()) {
    if (state.artifact === null) {
      row.tools[state.name] = na(plan.target, state.reason ?? "not run");
      continue;
    }
    const theirs = score(state.artifact.imports, state.artifact.calls);
    row.tools[state.name] = measured(
      precisionPair(theirs),
      plan.target,
      verdictFor({ ours: ours.calls.precision, theirs: theirs.calls.precision, higherIsBetter: true, margin: plan.margin }),
      lossReason(ours.calls.precision, theirs.calls.precision, state.name, "call edge precision"),
      detailOf(theirs),
    );
    bestCallPrecision = Math.max(bestCallPrecision ?? 0, theirs.calls.precision);
    bestImportPrecision = Math.max(bestImportPrecision ?? 0, theirs.imports.precision);
  }

  const callGap = bestCallPrecision === null ? null : ours.calls.precision - bestCallPrecision;
  const importGap = bestImportPrecision === null ? null : ours.imports.precision - bestImportPrecision;
  row.tools["greplost"] =
    callGap === null || importGap === null
      ? measured(
          precisionPair(ours),
          plan.target,
          "na",
          "no competitor produced a graph here, so the gap target has nothing to measure against",
          detailOf(ours),
        )
      : measured(
          precisionPair(ours),
          plan.target,
          callGap >= 0.1 && importGap >= 0.03 ? "win" : callGap <= -0.1 || importGap <= -0.03 ? "loss" : "tie",
          callGap >= 0.1 && importGap >= 0.03
            ? ""
            : `gap over the best competitor is ${round(callGap, 3)} on calls and ${round(importGap, 3)} on imports; ` +
              "the target is +0.10 and +0.03",
          detailOf(ours),
        );
}

/**
 * `calls 1.000 P / 0.500 R, imports 1.000 P / 1.000 R` - the cell's headline.
 *
 * A single number cannot carry X1: the target is written over two edge kinds and
 * two directions, and precision alone hides a tool that emitted three edges and
 * got all three right. The verdict is still decided on call precision, which is
 * what tech spec 10.0 calls the headline.
 */
function precisionPair(result: { imports: Score; calls: Score }): string {
  return (
    `calls ${round(result.calls.precision, 3)} P / ${round(result.calls.recall, 3)} R, ` +
    `imports ${round(result.imports.precision, 3)} P / ${round(result.imports.recall, 3)} R`
  );
}

function lossReason(ours: number, theirs: number, tool: string, what: string): string {
  return ours >= theirs ? "" : `${tool} scored ${round(theirs, 3)} against greplost's ${round(ours, 3)} on ${what}`;
}

function fileOf(id: string): string {
  const hash = id.indexOf("#");
  return hash === -1 ? id : id.slice(0, hash);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// X2 and X3: staleness and the cost of staying fresh
// ---------------------------------------------------------------------------

/**
 * The arms X2 can be walked in.
 *
 * `documented-sync` is the primary one and the one tech spec 10.0 X2 actually
 * words: "install its own sync mechanism exactly as its README describes, then
 * walk 500 commits **without any manual intervention**". The harness commits and
 * nothing else; whether a tool keeps up is the measurement.
 *
 * `refresh-every-commit` is the arm this suite used to publish as the hero: the
 * harness itself invokes each tool's documented refresh command after each
 * commit. That is a comparison of incremental *accuracy* between four tools all
 * being driven by hand, and no line in it decays, so it must never be presented
 * as a staleness curve. It is kept behind `--arms both` because it costs a
 * second walk of every tool.
 *
 * A third curve is free and always drawn: each tool's commit-0 artifact scored
 * against truth at each later commit (`x2-no-refresh.png`), which is what a
 * reader gets when a sync mechanism is absent or silently does not fire.
 */
export type Arm = "documented-sync" | "refresh-every-commit";

/** The detail-key prefix each arm's per-checkpoint F1 is stored under. */
export const ARM_PREFIX: Record<Arm, string> = {
  "documented-sync": "syncF1",
  "refresh-every-commit": "refreshF1",
};

/** One sentence per arm, for the payload's method list and the chart notes. */
export const ARM_DESCRIPTION: Record<Arm, string> = {
  "documented-sync":
    "each tool's own sync mechanism was installed exactly as its README describes and then left alone: the " +
    "harness commits, and nothing else, with one qualification, for crg. crg keeps its graph in SQLite and " +
    "only `code-review-graph visualize --format json` writes the JSON the adapters read, so the harness runs " +
    "that export at each scoring checkpoint. It reads crg's state rather than advancing it (`visualize` does " +
    "not rebuild), and it is outside every timing X3 reports; without it crg would have no artifact to score " +
    "at all. No other tool needs an export, and nothing else is run for any of them",
  "refresh-every-commit":
    "the harness invoked each tool's documented refresh command after every commit, so this arm compares " +
    "incremental accuracy under manual driving and is not a staleness curve",
};

/**
 * One tool's documented commit-time sync mechanism, as installed and observed.
 *
 * Every field is evidence rather than assertion: `hook` is a file this suite
 * read back off disk after the install command ran, `fired` counts the commits
 * where the mechanism was *observed* to run, and `ms` is wall-clock of the
 * child processes it started. A tool whose commit-time path turns out to be a
 * manual command has `automatic: false`, which in this arm is no sync at all,
 * and the row says so rather than quietly scoring its stale artifact as a result.
 */
interface SyncMechanism {
  tool: string;
  /** The install commands run, worded as the tool's README words them. */
  install: string[];
  /** The hook file found after the install, repo-relative, or null when none. */
  hook: string | null;
  /** How this suite knows the mechanism fired on a commit. */
  evidence: string;
  /** False when the tool's commit-time path is a manual command. */
  automatic: boolean;
  /** Commits where the mechanism was observed to run. */
  fired: number;
  /** Commits walked while this mechanism was installed. */
  walked: number;
  /** Milliseconds its child processes spent, summed over the walk. */
  ms: number;
  /**
   * Per commit, whether the mechanism ran and for how long.
   *
   * "observed to run on 100 of 100 commits" is a claim, and a claim in a
   * benchmark has to be checkable from the repository without re-running the
   * walk (review round 2, minor). `firedPerCommit` is one character per commit
   * in walk order and `msPerCommit` the matching wall-clock, so a reader can
   * count the zeroes themselves.
   */
  perCommit: { fired: boolean; ms: number }[];
  notes: string[];
}

/** A `SyncMechanism` as it is written to the payload. */
export interface SyncEvidence {
  tool: string;
  install: string[];
  hook: string | null;
  evidence: string;
  automatic: boolean;
  fired: number;
  walked: number;
  totalMs: number;
  /** One character per commit, in walk order: `1` fired, `0` did not. */
  firedPerCommit: string;
  /** Milliseconds per commit, in the same order. */
  msPerCommit: number[];
  /** The commit indices (1-based) where the mechanism did not fire. */
  missedCommits: number[];
  notes: string[];
}

/** The JSON-friendly evidence for every mechanism the walk installed. */
export function syncEvidence(mechanisms: ReadonlyMap<string, SyncMechanism>): SyncEvidence[] {
  const out: SyncEvidence[] = [];
  for (const mechanism of mechanisms.values()) {
    out.push({
      tool: mechanism.tool,
      install: mechanism.install,
      hook: mechanism.hook,
      evidence: mechanism.evidence,
      automatic: mechanism.automatic,
      fired: mechanism.fired,
      walked: mechanism.walked,
      totalMs: mechanism.ms,
      firedPerCommit: mechanism.perCommit.map((entry) => (entry.fired ? "1" : "0")).join(""),
      msPerCommit: mechanism.perCommit.map((entry) => entry.ms),
      missedCommits: mechanism.perCommit.flatMap((entry, index) => (entry.fired ? [] : [index + 1])),
      notes: mechanism.notes,
    });
  }
  return out.sort((a, b) => compareStrings(a.tool, b.tool));
}

/** One scoring checkpoint of one arm. */
interface ArmPoint {
  index: number;
  importF1: Map<string, number>;
  callF1: Map<string, number>;
}

interface ArmRun {
  arm: Arm;
  /** tool -> repo copy. */
  dirs: Map<string, string>;
  points: ArmPoint[];
  /** tool -> refresh wall-clock over the walk, milliseconds. */
  ms: Map<string, number>;
  /** tool -> refreshes that failed. */
  failures: Map<string, number>;
}

interface StalenessRun {
  commits: number;
  every: number;
  corpus: string;
  arms: ArmRun[];
  /** Each tool's commit-0 artifact scored against truth at each checkpoint. */
  stale: { index: number; f1: Map<string, number> }[];
  mechanisms: Map<string, SyncMechanism>;
  notes: string[];
}

/** Env var the graphify hook writes its background rebuild log under (relative to HOME). */
const GRAPHIFY_REBUILD_LOG = path.join(".cache", "graphify-rebuild.log");

/** How long to wait for one backgrounded hook rebuild before giving up on it. */
const HOOK_WAIT_MS = 600_000;

/** Poll interval while waiting for a detached hook to finish. */
const HOOK_POLL_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lines in a file, or 0 when it does not exist. */
function lineCount(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8").split("\n").length;
}

/** Is a detached process whose command line contains `needle` still running? */
function processAlive(needle: string): boolean {
  const found = spawnSync("pgrep", ["-f", needle], { encoding: "utf8" });
  // `pgrep` missing (status null, an error) is not evidence of absence, but it
  // is all this platform can offer; the caller falls back to the log.
  return found.error === undefined && found.status === 0 && found.stdout.trim().length > 0;
}

/**
 * A commit walk, scoring every tool's artifact against compiler truth at
 * checkpoints (tech spec 10.0, X2 and X3).
 *
 * The measured quantity is **import edge F1**, not the F1 over every edge kind.
 * It is the one where a fresh greplost build already scores 1.0, so a drop in
 * greplost's line is drift rather than a modelling difference. That is not true
 * across tools: they do not model imports alike either, on hono graphify's
 * freshly built artifact scores about 0.13, which is why the verdict is on each
 * line's *fall* and not on where it sits (`decayVerdict`). Call F1 is recorded
 * next to it in each cell's detail, where the level rather than the shape is the
 * story.
 *
 * One deviation from the tech spec's letter, because of what this machine has
 * rather than what the tools are: the history is synthetic. Each commit appends
 * one resolvable import line to one file, chosen from the repo's own specifiers
 * (`planImportEdits`), so every commit adds exactly one architecture edge and
 * truth moves by exactly one edge. A corpus checkout with 500 real commits is
 * what the spec asks for; it is not cloned here, and the synthetic walk is
 * stated as such in `RESULTS.md`.
 */
async function replayStaleness(
  target: Target,
  snapshot: Snapshot,
  states: Map<CompetitorName, CompetitorState>,
  requested: number,
  arms: readonly Arm[],
): Promise<StalenessRun> {
  const notes: string[] = [];
  const edits = planImportEdits(snapshot, requested);
  const commits = Math.min(requested, edits.length);
  if (commits < requested) {
    notes.push(
      `only ${commits} distinct one-line import edits exist in ${target.name}, so the walk is ${commits} ` +
        `commits rather than the ${requested} asked for`,
    );
  }
  // The spec checkpoints every 25 commits; a shorter walk would then produce one
  // point and no curve, so the interval shrinks with the walk and never grows.
  const every = Math.max(1, Math.min(25, Math.floor(commits / 8) || 1));

  // Shims first: every hook resolves its binary through PATH, and every tool
  // this suite times runs as a child process behind one of these.
  const hookLog = path.join(WORK_DIR, "hook.log");
  mkdirSync(path.dirname(hookLog), { recursive: true });
  writeFileSync(hookLog, "");
  const greplostShim = writeGreplostShim();
  for (const state of states.values()) {
    if (state.binary !== null) writeShim(INVOCATIONS[state.name].binary, state.binary);
  }
  const shimPath = `${SHIM_DIR}${path.delimiter}${process.env["PATH"] ?? ""}`;
  const ourEnv: NodeJS.ProcessEnv = { ...process.env, PATH: shimPath, [HOOK_LOG_ENV]: hookLog };
  const theirEnv: NodeJS.ProcessEnv = { ...sandboxEnv(), PATH: shimPath, [HOOK_LOG_ENV]: hookLog };
  const rebuildLog = path.join(SANDBOX_HOME, GRAPHIFY_REBUILD_LOG);

  const live = [...states.values()].filter((state) => state.binary !== null);
  const mechanisms = new Map<string, SyncMechanism>();
  const armRuns: ArmRun[] = [];

  const commitIn = (dir: string, env: NodeJS.ProcessEnv, message: string): void => {
    runTool("git", ["add", "-A"], dir, env);
    runTool(
      "git",
      ["-c", "user.email=bench@greplost.invalid", "-c", "user.name=bench", "commit", "-qm", message],
      dir,
      env,
    );
  };

  // -- arm setup ------------------------------------------------------------

  for (const arm of arms) {
    const dirs = new Map<string, string>();
    const ms = new Map<string, number>();
    const failures = new Map<string, number>();
    const suffix = arm === "documented-sync" ? "sync" : "refresh";

    const ourDir = path.join(WORK_DIR, "greplost", `${target.name}-${suffix}`);
    prepareCopy(target.root, ourDir);
    // `init` in a child process, through the same shim the hook resolves: the
    // build greplost is timed on must not be an in-process function call while
    // every competitor pays interpreter startup (review round 1, critical 2).
    //
    // `--root` is not optional, and the reason is a bug this arm had: greplost's
    // own root resolution walks *up* from the working directory until it finds a
    // `.greplost/`, and these copies live under `bench/.competitors/`, inside the
    // greplost checkout, which has one. Without `--root`, `init` in the copy
    // rebuilt the checkout's own map instead (6 files written, 119 parsed) and
    // left the copy empty, so the hook never installed and the walk measured
    // nothing. Once `init` has written `.greplost/` into the copy, the hook's own
    // `greplost update` stops at the copy, which is checked below.
    const ourInit = runTool(
      greplostShim,
      arm === "documented-sync" ? ["init", "--root", ourDir] : ["init", "--no-hooks", "--root", ourDir],
      ourDir,
      ourEnv,
    );
    if (!ourInit.ok) {
      notes.push(`greplost: \`greplost init\` failed in the ${arm} arm (${ourInit.stderr.trim().split("\n").pop() ?? ""})`);
    }
    if (!existsSync(path.join(ourDir, ".greplost"))) {
      notes.push(
        `greplost: \`greplost init\` wrote no .greplost/ into its ${arm} copy, so the copy would resolve its ` +
          "root upward to the enclosing checkout; this arm's greplost numbers are not trustworthy",
      );
    }
    dirs.set("greplost", ourDir);
    ms.set("greplost", 0);
    failures.set("greplost", ourInit.ok ? 0 : 1);
    if (arm === "documented-sync") {
      mechanisms.set("greplost", {
        tool: "greplost",
        install: ["greplost init"],
        hook: hookFileWith(ourDir, ["post-commit"], HOOK_SIGNATURES["greplost"] ?? "greplost-hook"),
        evidence:
          "the hook resolves `greplost` through PATH and backgrounds `greplost update --incremental --quiet`; " +
          "a PATH shim in front of it writes a start and an end line per invocation, so a commit's rebuild is " +
          "waited for rather than slept on, and its wall-clock is the child process's own",
        automatic: true,
        fired: 0,
        walked: 0,
        ms: 0,
        perCommit: [],
        notes: [],
      });
    }

    for (const state of live) {
      const dir = path.join(WORK_DIR, state.name, `${target.name}-${suffix}`);
      prepareCopy(target.root, dir);
      const invocation = INVOCATIONS[state.name];
      const setup = arm === "documented-sync" ? (invocation.syncInstall ?? invocation.commands) : invocation.commands;
      const failure = runInvocation(state, dir, setup, theirEnv);
      failures.set(state.name, failure === null ? 0 : 1);
      if (failure !== null) {
        notes.push(`${state.name}: its ${arm} setup failed (${failure}), so its line stops at commit 0`);
        continue;
      }
      dirs.set(state.name, dir);
      ms.set(state.name, 0);
      if (arm === "documented-sync") {
        const hook = hookFileWith(dir, HOOK_CANDIDATES, HOOK_SIGNATURES[state.name] ?? state.name);
        mechanisms.set(state.name, {
          tool: state.name,
          // The tool's own binary name, not this suite's short label: a reader
          // checking the command against the README needs the command.
          install: setup.map((args) => `${invocation.binary} ${args.join(" ")}`),
          hook,
          evidence: SYNC_EVIDENCE[state.name] ?? "not determined",
          // No git hook after the documented install means the tool's
          // commit-time path is `update` typed by a human, which is not sync.
          automatic: hook !== null,
          fired: 0,
          walked: 0,
          ms: 0,
          perCommit: [],
          notes:
            hook === null
              ? [
                  `the documented install wrote no git hook into the repo copy, so ${state.name}'s commit-time ` +
                    "mechanism here is a manual `update`; in this arm that is no sync at all and its curve is " +
                    "its commit-0 artifact",
                ]
              : [],
        });
      }
    }
    armRuns.push({ arm, dirs, points: [], ms, failures });
  }

  // -- the commit-0 artifacts, for the free unrefreshed curve ----------------

  const primary = armRuns.find((run) => run.arm === "documented-sync") ?? armRuns[0];
  const atZero = new Map<string, { imports: Edge[]; calls: Edge[] }>();
  if (primary !== undefined) {
    const ourZero = readGreplostArtifact(primary.dirs.get("greplost") ?? "");
    if (ourZero !== null) atZero.set("greplost", ourCleanEdges(ourZero));
    for (const state of live) {
      const dir = primary.dirs.get(state.name);
      if (dir === undefined) continue;
      exportForScoring(state, dir, theirEnv);
      const loaded = loadArtifact(state.name, dir, state.spec?.version ?? "unknown");
      if (typeof loaded !== "string") atZero.set(state.name, { imports: loaded.imports, calls: loaded.calls });
    }
  }

  // -- commit 0: what each tool knew before anything changed -----------------

  const buildSnapshot = await loadBuildSnapshot();
  const stale: { index: number; f1: Map<string, number> }[] = [];

  /**
   * The freshly built artifact of every tool, scored against truth at commit 0.
   *
   * Without this point a reader cannot tell decay from coverage, and the
   * difference is the whole finding. graphify ends the hono walk at 0.125 while
   * greplost holds 1.0, which reads as an eight-fold staleness gap, but
   * graphify's *fresh* import F1 is about the same 0.13, so almost none of that
   * gap is staleness. The curve has to start where each tool starts (review
   * round 2, critical).
   */
  const oracleAtZero = primary?.dirs.get("greplost") ?? armRuns[0]?.dirs.get("greplost");
  if (oracleAtZero !== undefined) {
    const base = await buildSnapshot({ root: oracleAtZero });
    const baseFiles = scoredFiles(base, "ts");
    const baseTruth = generateTsTruth(oracleAtZero, baseFiles);
    const baseUniverse = new Set(baseTruth.files.length > 0 ? baseTruth.files : baseFiles);
    const inZero = (id: string): boolean => baseUniverse.has(fileOf(id));
    const zeroImports = baseTruth.imports.filter((e) => inZero(e.from) && inZero(e.to));
    const zeroCalls = baseTruth.calls.filter((e) => inZero(e.from) && inZero(e.to));
    const keepZero = (edges: Edge[]): Edge[] => edges.filter((e) => inZero(e.from) && inZero(e.to));

    const importF1 = new Map<string, number>();
    const callF1 = new Map<string, number>();
    for (const [tool, artifact] of atZero) {
      importF1.set(tool, scoreEdges(keepZero(artifact.imports), zeroImports).f1);
      callF1.set(tool, scoreEdges(keepZero(artifact.calls), zeroCalls).f1);
    }
    // Every arm starts from the same freshly built artifacts, so the same point
    // opens each curve; the unrefreshed arm's commit-0 value is that number by
    // construction.
    for (const run of armRuns) run.points.push({ index: 0, importF1, callF1 });
    stale.push({ index: 0, f1: new Map(importF1) });
  } else {
    notes.push("no greplost copy was prepared, so no commit-0 checkpoint could be scored and decay is unknown");
  }

  // -- the walk -------------------------------------------------------------

  for (let k = 1; k <= commits; k++) {
    const edit = edits[k - 1];
    if (edit === undefined) break;
    const line = `import "${edit.specifier}";`;

    for (const run of armRuns) {
      for (const [tool, dir] of run.dirs) {
        const env = tool === "greplost" ? ourEnv : theirEnv;
        appendLine(path.join(dir, edit.file), line);

        if (run.arm === "documented-sync") {
          const mechanism = mechanisms.get(tool);
          const before = observation(tool, hookLog, rebuildLog);
          commitIn(dir, env, `bench commit ${k}`);
          const after = await settle(tool, hookLog, rebuildLog, before);
          if (mechanism !== undefined) {
            mechanism.walked++;
            if (after.ran) mechanism.fired++;
            mechanism.ms += after.ms;
            mechanism.perCommit.push({ fired: after.ran, ms: after.ms });
          }
          run.ms.set(tool, (run.ms.get(tool) ?? 0) + after.ms);
          continue;
        }

        // refresh-every-commit: the harness drives the documented refresh, and
        // times it as a child process for every tool including greplost.
        commitIn(dir, env, `bench commit ${k}`);
        if (tool === "greplost") {
          const ran = runTool(greplostShim, ["update", "--incremental", "--quiet", "--root", dir], dir, env);
          run.ms.set(tool, (run.ms.get(tool) ?? 0) + ran.ms);
          if (!ran.ok) run.failures.set(tool, (run.failures.get(tool) ?? 0) + 1);
          continue;
        }
        const state = live.find((candidate) => candidate.name === tool);
        if (state === undefined) continue;
        const invocation = INVOCATIONS[state.name];
        const timed = invocation.refreshTimed ?? invocation.refresh ?? invocation.commands;
        const started = Date.now();
        const failure = runInvocation(state, dir, timed, theirEnv);
        run.ms.set(tool, (run.ms.get(tool) ?? 0) + (Date.now() - started));
        if (failure !== null) run.failures.set(tool, (run.failures.get(tool) ?? 0) + 1);
      }
    }

    if (k % every !== 0 && k !== commits) continue;

    // Truth at this commit, from the tree every copy shares: the same edit was
    // applied to each, so one oracle run serves every arm and every tool.
    const oracleRoot = primary?.dirs.get("greplost") ?? armRuns[0]?.dirs.get("greplost");
    if (oracleRoot === undefined) break;
    const current = await buildSnapshot({ root: oracleRoot });
    const files = scoredFiles(current, "ts");
    const truth = generateTsTruth(oracleRoot, files);
    const universe = new Set(truth.files.length > 0 ? truth.files : files);
    const inside = (id: string): boolean => universe.has(fileOf(id));
    const truthImports = truth.imports.filter((e) => inside(e.from) && inside(e.to));
    const truthCalls = truth.calls.filter((e) => inside(e.from) && inside(e.to));
    const keep = (edges: Edge[]): Edge[] => edges.filter((e) => inside(e.from) && inside(e.to));

    for (const run of armRuns) {
      const importF1 = new Map<string, number>();
      const callF1 = new Map<string, number>();
      for (const [tool, dir] of run.dirs) {
        if (tool === "greplost") {
          const ours = readGreplostArtifact(dir);
          if (ours === null) continue;
          const clean = ourCleanEdges(ours);
          importF1.set(tool, scoreEdges(keep(clean.imports), truthImports).f1);
          callF1.set(tool, scoreEdges(keep(clean.calls), truthCalls).f1);
          continue;
        }
        const state = live.find((candidate) => candidate.name === tool);
        if (state === undefined) continue;
        // The export is run here and never timed: crg keeps its graph in SQLite
        // and only `visualize --format json` writes the JSON the adapters read,
        // so charging its refresh for an export step greplost has no equivalent
        // of was the X3 asymmetry the review found (round 1, critical 2).
        exportForScoring(state, dir, theirEnv);
        const loaded = loadArtifact(state.name, dir, state.spec?.version ?? "unknown");
        if (typeof loaded === "string") continue;
        importF1.set(tool, scoreEdges(keep(loaded.imports), truthImports).f1);
        callF1.set(tool, scoreEdges(keep(loaded.calls), truthCalls).f1);
      }
      run.points.push({ index: k, importF1, callF1 });
    }

    const staleF1 = new Map<string, number>();
    for (const [tool, zero] of atZero) staleF1.set(tool, scoreEdges(keep(zero.imports), truthImports).f1);
    stale.push({ index: k, f1: staleF1 });
  }

  notes.push(
    `the walk is **synthetic**: ${commits} commits generated over ${target.name}'s pinned checkout, not ` +
      `${commits} of its real ones. Each commit appends exactly one resolvable import line to one file, ` +
      "chosen from the repo's own specifiers, so every commit adds exactly one architecture edge and truth " +
      "moves by exactly one edge. There are no deletions, no renames and no file additions in the walk, which " +
      "is the easy direction for an incremental updater: a real history would also delete and move code. " +
      `Scored every ${every} commit${every === 1 ? "" : "s"} against compiler truth at that commit. Tech spec ` +
      "10.0 asks for 500 real commits of a corpus checkout; that is not what was run here",
  );
  return { commits, every, corpus: target.name, arms: armRuns, stale, mechanisms, notes };
}

/**
 * greplost's edges as X2 scores them: resolved imports only (an `ext:` or
 * `unresolved:` target is not a repo edge and truth has no such node), and calls
 * at every confidence, on both sides, for the reason X1's `score` gives.
 */
function ourCleanEdges(artifact: { imports: Edge[]; calls: Edge[] }): { imports: Edge[]; calls: Edge[] } {
  return {
    imports: artifact.imports.filter((e) => !e.to.startsWith("ext:") && !e.to.startsWith("unresolved:")),
    calls: [...artifact.calls],
  };
}

/** Run a tool's checkpoint-only export, if it has one. Never timed. */
function exportForScoring(state: CompetitorState, dir: string, env: NodeJS.ProcessEnv): void {
  const commands = INVOCATIONS[state.name].exportAtCheckpoint;
  if (commands === undefined) return;
  runInvocation(state, dir, commands, env);
}

/** Hook files a documented install could plausibly write. */
const HOOK_CANDIDATES: readonly string[] = ["pre-commit", "post-commit", "post-checkout", "post-merge"];

/** The string that identifies each tool's own block inside a hook file. */
const HOOK_SIGNATURES: Record<string, string | undefined> = {
  greplost: "greplost-hook",
  graphify: "graphify-hook-start",
  crg: "code-review-graph",
};

/** How this suite observes each competitor's mechanism firing. */
const SYNC_EVIDENCE: Record<string, string> = {
  graphify:
    "`graphify hook install` writes a post-commit hook that launches a detached python rebuild without going " +
    "through the `graphify` launcher, so a PATH shim cannot see it: the rebuild is observed instead through " +
    "the hook's own log under the sandbox HOME (`.cache/graphify-rebuild.log`, one line per rebuild) and " +
    "waited for until the detached process is gone, which is what its wall-clock is measured over. That " +
    "window starts when the commit returns rather than when the hook launched the child, so graphify's " +
    "number is a slight under-count \u2014 the direction that flatters graphify, not greplost",
  crg:
    "`code-review-graph install` writes a pre-commit hook that runs `code-review-graph update` synchronously " +
    "and resolves the binary through PATH, so a PATH shim in front of it records a start and an end line per " +
    "commit; the hook runs `update` and then `detect-changes --brief`, and both are counted because both are " +
    "what a commit costs a crg user; it does not run `visualize`, so no export is inside its timing",
};

/**
 * The hook file under `dir` carrying `signature`, repo-relative, or null.
 *
 * Read back off disk after the install command, because "the README says it
 * installs a hook" and "a hook is installed" are different claims and only the
 * second one is evidence.
 */
function hookFileWith(dir: string, names: readonly string[], signature: string): string | null {
  for (const name of names) {
    const file = path.join(dir, ".git", "hooks", name);
    if (!existsSync(file)) continue;
    try {
      if (readFileSync(file, "utf8").includes(signature)) return `.git/hooks/${name}`;
    } catch {
      // Unreadable is not installed, for this purpose.
    }
  }
  return null;
}

/** What was observed of a tool's mechanism before a commit, to diff against after. */
interface Observation {
  shim: number;
  rebuildLines: number;
}

function observation(tool: string, hookLog: string, rebuildLog: string): Observation {
  return {
    shim: shimTime(readHookLog(hookLog), shimName(tool)).runs,
    rebuildLines: tool === "graphify" ? lineCount(rebuildLog) : 0,
  };
}

/** The binary name a tool's hook resolves through PATH. */
function shimName(tool: string): string {
  return tool === "greplost" ? "greplost" : (INVOCATIONS[tool as CompetitorName]?.binary ?? tool);
}

/**
 * Wait for whatever a commit set off, and report whether it ran and for how long.
 *
 * greplost and crg go through the PATH shim, so the wait is exact: a new
 * completed start/end pair in the log. graphify's hook never touches its own
 * launcher, it pins a python interpreter and detaches, so it is waited for
 * through the hook's own rebuild log plus the process table, and its wall-clock
 * is measured from the commit's return to the moment the detached rebuild is
 * gone. Both methods are recorded in the payload; neither is a sleep.
 */
async function settle(
  tool: string,
  hookLog: string,
  rebuildLog: string,
  before: Observation,
): Promise<{ ran: boolean; ms: number }> {
  const deadline = Date.now() + HOOK_WAIT_MS;
  if (tool === "graphify") {
    const started = Date.now();
    let ran = false;
    while (Date.now() < deadline) {
      const grew = lineCount(rebuildLog) > before.rebuildLines;
      if (grew) ran = true;
      if (!processAlive("_rebuild_code") && (grew || Date.now() - started > 2_000)) break;
      await sleep(HOOK_POLL_MS);
    }
    return { ran, ms: ran ? Date.now() - started : 0 };
  }

  const name = shimName(tool);
  while (Date.now() < deadline) {
    const calls = readHookLog(hookLog);
    const seen = shimTime(calls, name);
    if (seen.runs > before.shim && seen.pending === 0) {
      const each = shimRuns(calls, name);
      const latest = each.slice(before.shim);
      return { ran: latest.length > 0, ms: latest.reduce((total, value) => total + value, 0) };
    }
    await sleep(HOOK_POLL_MS);
  }
  return { ran: false, ms: 0 };
}

/**
 * greplost's staleness and freshness cost, from a real per-tool walk when
 * `--commits` asked for one, and otherwise from the replay suite's committed
 * result (Eval 2), which is where a 500-commit walk belongs.
 *
 * Returns the number of commits actually walked, so the caller can rewrite X2's
 * and X3's titles from the walk that happened rather than from the spec's 500.
 */
async function metricX2X3(
  metrics: Record<XId, MetricRow>,
  target: Target,
  snapshot: Snapshot,
  states: Map<CompetitorName, CompetitorState>,
  method: string[],
  selected: (id: XId) => boolean,
  commits: number,
  arms: readonly Arm[],
): Promise<{ commits: number; sync: SyncEvidence[] }> {
  const x2 = PLAN_BY_ID.get("X2") as MetricDef;
  const x3 = PLAN_BY_ID.get("X3") as MetricDef;

  let walk: StalenessRun | null = null;
  if (commits > 0) {
    try {
      walk = await replayStaleness(target, snapshot, states, commits, arms);
    } catch (err) {
      // A replay that blows up must not take the other nine metrics with it.
      method.push(`X2: the commit walk failed and X2/X3 fall back to the replay suite's result, ${(err as Error).message}.`);
      walk = null;
    }
  }

  if (walk !== null) {
    fromWalk(metrics, states, walk, method, selected, x2, x3);
    return { commits: walk.commits, sync: syncEvidence(walk.mechanisms) };
  }
  fromReplayResult(metrics, states, method, selected, x2, x3);
  return { commits: 0, sync: [] };
}

function fromWalk(
  metrics: Record<XId, MetricRow>,
  states: Map<CompetitorName, CompetitorState>,
  walk: StalenessRun,
  method: string[],
  selected: (id: XId) => boolean,
  x2: MetricDef,
  x3: MetricDef,
): void {
  for (const note of walk.notes) method.push(`X2: ${note}.`);
  method.push(
    "X2: the plotted number is import edge F1 against compiler truth at that commit, and the curve starts at " +
      "commit 0 with each tool's freshly built artifact. The **level** of a line is that tool's import " +
      "coverage, not its freshness: the four tools do not model imports alike, and X1 measures how far apart " +
      "they start (on this corpus graphify recalls a small fraction of the import edges the compiler sees). " +
      "The **fall** of a line between commit 0 and the last commit is the staleness this metric is about, and " +
      "it is reported as `decay` in every cell. A reader comparing two end-points is comparing coverage plus " +
      "decay; only the decay belongs to X2. Call F1 is in each cell's detail.",
  );
  for (const arm of walk.arms) {
    method.push(`X2 arm \`${arm.arm}\` (\`${ARM_PREFIX[arm.arm]}@<commit>\` in each cell's detail): ${ARM_DESCRIPTION[arm.arm]}.`);
  }
  method.push(
    "X2 arm `staleF1@<commit>`: each tool's commit-0 artifact scored against truth at that commit, the curve " +
      "a reader gets when a sync mechanism is absent or does not fire. greplost is the only one of the four " +
      "whose `verify` reports that state at all; the others refresh without ever checking.",
  );
  for (const mechanism of walk.mechanisms.values()) {
    method.push(
      `X2 sync (${mechanism.tool}): installed with \`${mechanism.install.join("` + `")}\`; ` +
        `${mechanism.hook === null ? "no git hook was written into the repo copy" : `hook at \`${mechanism.hook}\``}; ` +
        `observed to run on ${mechanism.fired} of ${mechanism.walked} commits ` +
        `(${round(mechanism.ms / 1000, 2)} s of child-process wall-clock in total). ${mechanism.evidence}.` +
        (mechanism.notes.length === 0 ? "" : ` ${mechanism.notes.join(" ")}.`),
    );
  }

  const primary = walk.arms.find((run) => run.arm === "documented-sync") ?? walk.arms[0];
  const scored = (primary?.points ?? []).filter((point) => point.index > 0);
  const last = scored[scored.length - 1];
  const first = primary?.points.find((point) => point.index === 0);
  const staleLast = walk.stale[walk.stale.length - 1];

  /** A tool's freshly built F1, its final F1, and how much it lost between them. */
  const freshness = (tool: string): { at0: number | null; atLast: number | null; decay: number | null } => {
    const at0 = first?.importF1.get(tool) ?? null;
    const atLast = last?.importF1.get(tool) ?? null;
    return { at0, atLast, decay: at0 === null || atLast === null ? null : at0 - atLast };
  };

  const seriesFor = (tool: string): Record<string, number> => {
    const detail: Record<string, number> = {};
    for (const run of walk.arms) {
      const prefix = ARM_PREFIX[run.arm];
      for (const point of run.points) {
        const value = point.importF1.get(tool);
        if (value !== undefined) detail[`${prefix}@${point.index}`] = round(value, 4);
        const calls = point.callF1.get(tool);
        if (calls !== undefined) detail[`${prefix}Calls@${point.index}`] = round(calls, 4);
      }
    }
    for (const point of walk.stale) {
      const value = point.f1.get(tool);
      if (value !== undefined) detail[`staleF1@${point.index}`] = round(value, 4);
    }
    return detail;
  };

  const ours = freshness("greplost");
  const ourFinal = ours.atLast;
  if (selected("X2")) {
    const row = metrics["X2"];
    const ourMechanism = walk.mechanisms.get("greplost");
    // greplost's own cell keeps the tech spec 3.1 target: F1 at or above 0.99
    // after the walk. That is an absolute claim about greplost's own artifact
    // and it does not depend on anyone else's coverage.
    row.tools["greplost"] = ourFinal === null
      ? na(x2.target, `the walk ran ${walk.commits} commits but greplost's artifact could not be scored at the last checkpoint`)
      : measured(
          round(ourFinal, 4),
          x2.target,
          ourFinal >= 0.99 ? "win" : "loss",
          ourFinal >= 0.99
            ? `${describeFreshness("greplost", ours)}`
            : `greplost's committed graph scored ${round(ourFinal, 3)} import F1 after ${walk.commits} commits; ` +
              `the target is 0.99. ${describeFreshness("greplost", ours)}`,
          {
            ...seriesFor("greplost"),
            commits: walk.commits,
            refreshFailures: primary?.failures.get("greplost") ?? 0,
            syncFired: ourMechanism?.fired ?? 0,
            syncWalked: ourMechanism?.walked ?? 0,
            ...(ours.at0 === null ? {} : { freshF1: round(ours.at0, 4) }),
            ...(ours.decay === null ? {} : { decay: round(ours.decay, 4) }),
            unrefreshedFinalF1: round(staleLast?.f1.get("greplost") ?? 0, 4),
          },
        );
    for (const state of states.values()) {
      const theirs = freshness(state.name);
      const mechanism = walk.mechanisms.get(state.name);
      const noSync =
        mechanism !== undefined && !mechanism.automatic
          ? `${state.name}'s documented install wrote no git hook here, so its commit-time mechanism is a ` +
            "manual `update`, which is no sync in this arm. "
          : "";
      row.tools[state.name] = theirs.atLast === null
        ? na(x2.target, state.reason ?? `${sentenceOfSync(state)}: its artifact could not be scored during the walk`)
        : measured(
            // The cell states the decay first, because that is the metric, and
            // carries both absolutes so the reader can see the level too.
            theirs.decay === null
              ? `${round(theirs.atLast, 4)} (no commit-0 point)`
              // `decay` is F1 at commit 0 minus F1 at the last commit, so `+` is
              // ground lost and `-` is ground gained; both absolutes sit beside
              // it because the level is a different fact from the fall.
              : `decay ${signed(theirs.decay)} (${round(theirs.at0 ?? 0, 3)} to ${round(theirs.atLast, 3)})`,
            x2.target,
            decayVerdict(ours.decay, theirs.decay),
            `${noSync}${describeFreshness(state.name, theirs)}${decayReason(ours, theirs, state.name)}`,
            {
              ...seriesFor(state.name),
              refreshFailures: primary?.failures.get(state.name) ?? 0,
              syncFired: mechanism?.fired ?? 0,
              syncWalked: mechanism?.walked ?? 0,
              ...(theirs.at0 === null ? {} : { freshF1: round(theirs.at0, 4) }),
              ...(theirs.decay === null ? {} : { decay: round(theirs.decay, 4) }),
              finalF1: round(theirs.atLast, 4),
              unrefreshedFinalF1: round(staleLast?.f1.get(state.name) ?? 0, 4),
            },
          );
    }
    const gap = coverageVersusDecay(ours, freshness("graphify"), freshness("crg"));
    if (gap !== null) method.push(`X2: ${gap}`);
  }

  if (selected("X3")) {
    const row = metrics["X3"];
    // Wall-clock comes from the primary arm, where every number is one child
    // process's own run time: greplost's through `greplost update` behind the
    // hook, crg's through the pre-commit hook the same way, graphify's over its
    // detached rebuild. No in-process call is timed against a subprocess, and no
    // export step sits inside anyone's refresh (review round 1, critical 2).
    const minutes = (tool: string): number | null => {
      const total = primary?.ms.get(tool);
      return total === undefined ? null : total / 60_000;
    };
    const ourMinutes = minutes("greplost");
    const perCommit = (value: number | null): number | null => (value === null ? null : (value * 60) / Math.max(walk.commits, 1));
    const ours = x3GreplostVerdict(ourMinutes, minutes("graphify"));
    row.tools["greplost"] = measured(
      ourMinutes === null ? "$0" : `$0, ${round(ourMinutes, 3)} min`,
      x3.target,
      ours.verdict,
      ours.reason,
      { usd: 0, minutes: round(ourMinutes ?? 0, 4), secondsPerCommit: round(perCommit(ourMinutes) ?? 0, 4) },
    );
    for (const state of states.values()) {
      const theirMinutes = minutes(state.name);
      const mechanism = walk.mechanisms.get(state.name);
      if (theirMinutes === null) {
        row.tools[state.name] = na(x3.target, state.reason ?? "this tool was not walked, so there is no cost to sum");
        continue;
      }
      if (mechanism !== undefined && !mechanism.automatic) {
        row.tools[state.name] = na(
          x3.target,
          `${state.name} installed no commit-time hook here, so nothing ran to be timed; its documented ` +
            "incremental path is `update` typed by a human, whose cost is a person's, not a machine's",
        );
        continue;
      }
      // USD ties at zero for every tool that was run, because all three ran
      // their no-LLM path; wall-clock is then the only thing left to separate
      // them, and it decides the verdict.
      const verdict = verdictFor({ ours: ourMinutes, theirs: theirMinutes, higherIsBetter: false, margin: 0.005 });
      row.tools[state.name] = measured(
        `$0, ${round(theirMinutes, 3)} min`,
        x3.target,
        verdict,
        verdict === "loss"
          ? `${state.name} stayed fresh in ${round(theirMinutes, 3)} min against greplost's ${round(ourMinutes ?? 0, 3)} min`
          : "",
        { usd: 0, minutes: round(theirMinutes, 4), secondsPerCommit: round(perCommit(theirMinutes) ?? 0, 4) },
      );
    }
    method.push(
      "X3: every tool's wall-clock is the run time of the child processes its own commit-time mechanism " +
        "started, interpreter startup included, measured the same way for greplost as for the competitors. " +
        "crg's `visualize --format json` export is outside that number: its hook does not run it, and it is " +
        "invoked by this suite only at scoring checkpoints, because greplost has no export step to charge " +
        "against it.",
    );
    method.push(
      "X3: every tool that ran here ran its no-LLM path, so USD is 0 for all of them and the verdict falls to " +
        "wall-clock. That is not the tech spec's comparison, which costs each tool's *documented* refresh: " +
        "graphify's `/graphify` first pass and Understand-Anything's `/understand` are LLM pipelines whose USD " +
        "this harness cannot measure without model credentials. The zero is what was measured, not a claim " +
        "that their documented path is free.",
    );
  }
}

/** One tool's freshly built F1, its F1 after the walk, and the fall between them. */
export interface Freshness {
  at0: number | null;
  atLast: number | null;
  decay: number | null;
}

/** `+0.004` / `-0.001` / `0.000`, so a sign is never read as a minus in prose. */
export function signed(value: number): string {
  const rounded = round(value, 4);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

/**
 * X2's verdict for one competitor, on decay rather than on the end-point.
 *
 * The end-point comparison was wrong, and flatteringly so: on hono graphify
 * ends at 0.125 against greplost's 1.000, which reads as an eight-fold
 * staleness gap, while graphify's *freshly built* artifact already scores about
 * 0.13. Almost the whole gap is import coverage, which is X1's subject, and
 * almost none of it is staleness, which is X2's. The verdict is now a greplost
 * win only when greplost's artifact decayed less than the competitor's over the
 * same walk (review round 2, critical).
 */
export function decayVerdict(ourDecay: number | null, theirDecay: number | null): Verdict {
  if (ourDecay === null || theirDecay === null) return "na";
  // A hundredth of an F1 point: below that the walk cannot tell them apart.
  const margin = 0.01;
  if (Math.abs(ourDecay - theirDecay) <= margin) return "tie";
  return ourDecay < theirDecay ? "win" : "loss";
}

/** `graphify started at 0.131 and ended at 0.125, a fall of 0.006.` */
export function describeFreshness(tool: string, freshness: Freshness): string {
  if (freshness.at0 === null || freshness.atLast === null || freshness.decay === null) {
    return `${tool}: no commit-0 checkpoint was scored, so its decay is unknown`;
  }
  const fall = freshness.decay;
  return (
    `${tool} started the walk at ${round(freshness.at0, 3)} import F1 and ended at ` +
    `${round(freshness.atLast, 3)}, ` +
    (Math.abs(fall) < 0.0005
      ? "a fall of 0.000"
      : fall > 0
        ? `a fall of ${round(fall, 3)}`
        : `a rise of ${round(-fall, 3)}`) +
    `. The level is coverage (X1's subject); only the fall is staleness`
  );
}

/**
 * The comparison sentence on a competitor cell, when there is one to make.
 *
 * `decay` is F1 at commit 0 minus F1 at the last commit, so a *negative* decay is a tool
 * whose F1 rose over the walk. Saying that tool "lost -0.003" was a sentence with the
 * wrong verb in it (review round 3, minor): a rise is reported as a rise.
 */
export function decayReason(ours: Freshness, theirs: Freshness, tool: string): string {
  if (ours.decay === null || theirs.decay === null) return "";
  return `. Over the same walk ${tool} ${movement(theirs.decay)} and greplost ${movement(ours.decay)}`;
}

/** `lost 0.006` / `gained 0.003` / `held level`. Never "lost" a negative number. */
function movement(decay: number): string {
  // A twentieth of a thousandth: below that the walk cannot tell a movement from none.
  if (Math.abs(decay) < 0.00005) return "held level";
  return decay < 0 ? `gained ${round(-decay, 4)}` : `lost ${round(decay, 4)}`;
}

/**
 * How much of the end-point gap is coverage and how much is decay, in one
 * sentence, for the payload's method list and the hero chart's note.
 */
export function coverageVersusDecay(
  ours: Freshness,
  ...others: readonly Freshness[]
): string | null {
  if (ours.at0 === null || ours.atLast === null) return null;
  const parts: string[] = [];
  for (const [index, other] of others.entries()) {
    const name = index === 0 ? "graphify" : "crg";
    if (other.at0 === null || other.atLast === null || other.decay === null) continue;
    const endGap = ours.atLast - other.atLast;
    const startGap = ours.at0 - other.at0;
    parts.push(
      `${name}: end-point gap ${round(endGap, 3)}, of which ${round(startGap, 3)} was already there at ` +
        `commit 0 (coverage) and ${round(other.decay - (ours.decay ?? 0), 3)} is the difference in decay`,
    );
  }
  if (parts.length === 0) return null;
  return (
    "how much of the gap is coverage and how much is staleness, " +
    `${parts.join("; ")}. X1 is where a coverage difference belongs; X2 is only the fall.`
  );
}

/**
 * greplost's own X3 verdict.
 *
 * The target is a ratio against two tools, "<= 1% of ua, <= 20% of graphify",
 * and Understand-Anything cannot be run headless here at all, so the ua arm is
 * unevaluable. Printing `win` on that row claimed a comparison nobody made
 * (review round 1, important 7). When graphify was walked, the graphify arm is
 * evaluated on its own and the reason column says that is the half being
 * tested; when it was not, the row is `na` with the reason.
 */
export function x3GreplostVerdict(
  ourMinutes: number | null,
  graphifyMinutes: number | null,
): { verdict: MetricCell["verdict"]; reason: string } {
  if (ourMinutes === null) {
    return { verdict: "na", reason: "greplost's own refresh could not be timed during the walk" };
  }
  if (graphifyMinutes === null || graphifyMinutes <= 0) {
    return {
      verdict: "na",
      reason:
        "the target is a ratio against ua and graphify; neither was walked here, so there is nothing to take " +
        "a ratio of. greplost's own cost is $0 (no model call in the structure layer)",
    };
  }
  const share = ourMinutes / graphifyMinutes;
  return {
    verdict: share <= 0.2 ? "win" : "loss",
    reason:
      `evaluated on the graphify arm of the target only: ${round(share * 100, 1)}% of graphify's wall-clock ` +
      `(target <= 20%). The ua arm cannot be evaluated, Understand-Anything has no headless entry point here, ` +
      "so no cost exists to take 1% of.",
  };
}

function fromReplayResult(
  metrics: Record<XId, MetricRow>,
  states: Map<CompetitorName, CompetitorState>,
  method: string[],
  selected: (id: XId) => boolean,
  x2: MetricDef,
  x3: MetricDef,
): void {
  const replay = safeLatest("replay");

  if (selected("X2")) {
    const row = metrics["X2"];
    if (replay === null) {
      row.tools["greplost"] = na(
        x2.target,
        "no commit walk was asked for (`--commits <n>`) and the replay suite (Eval 2) has not produced a result yet",
      );
    } else {
      const f1 = replayRate(replay, ["f1CatchRate", "f1"], ["driftCaught", "driftTotal"]);
      const commits = numberAt(replay, "commits") ?? numberAt(replay, "commitCount");
      row.tools["greplost"] = f1 === null
        ? na(x2.target, "the replay result carried no F1 field this suite recognises")
        : measured(
            round(f1, 4),
            x2.target,
            f1 >= 0.99 ? "win" : "loss",
            f1 >= 0.99 ? "" : `verify caught ${round(f1 * 100, 1)}% of injected drifts, target is 100%`,
            { commits: commits ?? 0, f1: round(f1, 4) },
          );
      method.push(
        `X2: greplost's number comes from the committed replay result (${commits ?? "an unrecorded number of"} ` +
          "commits), where F1 is `verify`'s catch rate on injected drift rather than an artifact's F1 against " +
          "truth. Pass `--commits <n>` to run the per-tool artifact walk instead.",
      );
    }
    for (const state of states.values()) {
      row.tools[state.name] = na(
        x2.target,
        `${sentenceOfSync(state)}, not walked: pass \`--commits <n>\` to replay every installed tool through ` +
          "its own documented sync mechanism",
      );
    }
  }

  if (selected("X3")) {
    const row = metrics["X3"];
    const p50 = replay === null ? null : numberAt(replay, "updateP50");
    const commits = replay === null ? null : numberAt(replay, "commits");
    const minutes = p50 === null || commits === null ? null : (p50 * commits) / 60_000;
    // Not a win: the target is "<= 1% of ua, <= 20% of graphify", and neither
    // arm was measured. $0 is what greplost cost, not evidence that it beat a
    // number nobody produced.
    const ours = x3GreplostVerdict(minutes, null);
    row.tools["greplost"] = measured(
      minutes === null ? "$0" : `$0, ${round(minutes, 2)} min`,
      x3.target,
      ours.verdict,
      ours.reason,
      minutes === null ? { usd: 0 } : { usd: 0, minutes: round(minutes, 3) },
    );
    method.push(
      "X3: greplost's USD is 0 by construction; the structure layer makes no model call, so there is no " +
        "usage envelope to sum. Its wall-clock is the replay result's incremental p50 times the commit count. " +
        "Competitor USD would come from each tool's own logs or Claude usage envelopes; none was produced here.",
    );
    for (const state of states.values()) {
      row.tools[state.name] = na(
        x3.target,
        state.name === "ua"
          ? "every refresh is an LLM pass and the tool cannot be run here, so no usage envelope exists to sum"
          : "no commit walk was run for this tool, so there is no cost to sum (`--commits <n>`)",
      );
    }
  }
}

function sentenceOfSync(state: CompetitorState): string {
  const mechanism = state.spec?.syncMechanism;
  if (mechanism === null || mechanism === undefined) return "no documented sync mechanism";
  const stop = mechanism.indexOf(". ");
  return stop === -1 ? mechanism : mechanism.slice(0, stop);
}

// ---------------------------------------------------------------------------
// X4: reproducibility
// ---------------------------------------------------------------------------

/**
 * greplost's structure artifacts, read off disk.
 *
 * `listStructurePaths` from `@greplost/sync` is the canonical list, INDEX.md,
 * manifest.json, graph/*.jsonl, repo/*.md, packages/*&#47;{MAP,API}.md and the module
 * cards, and excludes config.json, the semantic cache and the runtime files,
 * which are not the map and are not committed (ruling 2026-09-02).
 */
async function readStructureArtifacts(dir: string): Promise<Map<string, string>> {
  const specifier = "@greplost/sync";
  const mod = (await import(specifier)) as Partial<{ listStructurePaths: (root: string) => string[] }>;
  const artifactRoot = path.join(dir, ".greplost");
  if (!existsSync(artifactRoot)) return new Map();
  const out = new Map<string, string>();
  const listed = typeof mod.listStructurePaths === "function" ? mod.listStructurePaths(artifactRoot) : null;
  const relatives = listed ?? walkFiles(artifactRoot).filter((rel) => !rel.startsWith("cache/") && !rel.startsWith("."));
  for (const rel of [...relatives].sort(compareStrings)) {
    const file = path.join(artifactRoot, ...rel.split("/"));
    if (existsSync(file) && statSync(file).isFile()) out.set(rel, readFileSync(file, "utf8"));
  }
  return out;
}

/** Every file under `dir`, as posix paths relative to it. */
function walkFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/**
 * X4: build twice on the same commit and count what differs.
 *
 * greplost is built by two separate `bun` child processes, not twice inside
 * this one. That matters: the determinism contract (tech spec 5.3) is a claim
 * about two *runs*, and two builds sharing a process also share every module's
 * state, which is exactly where a non-deterministic map would hide. Each
 * competitor already pays for two processes; greplost pays for them too.
 */
async function metricX4(
  metrics: Record<XId, MetricRow>,
  target: Target,
  states: Map<CompetitorName, CompetitorState>,
  method: string[],
): Promise<void> {
  const plan = PLAN_BY_ID.get("X4") as MetricDef;
  const row = metrics["X4"];

  const scratch = path.join(WORK_DIR, "greplost", `${target.name}-repro`);
  prepareCopy(target.root, scratch);
  const cli = path.join(REPO_ROOT, "packages", "cli", "src", "main.ts");
  const first = runTool("bun", [cli, "init", "--no-hooks", "--root", scratch], REPO_ROOT);
  const before = await readStructureArtifacts(scratch);
  const second = runTool("bun", [cli, "update", "--full", "--root", scratch], REPO_ROOT);
  const after = await readStructureArtifacts(scratch);

  if (!first.ok || !second.ok || before.size === 0) {
    row.tools["greplost"] = na(
      plan.target,
      `two builds could not be produced on a fresh copy (init exited ${first.code ?? "on a signal"}, ` +
        `update exited ${second.code ?? "on a signal"}, ${before.size} artifacts read)`,
    );
  } else {
    const ourDelta = byteDelta(before, after);
    row.tools["greplost"] = measured(
      `${ourDelta.bytes} bytes`,
      plan.target,
      ourDelta.bytes === 0 ? "win" : "loss",
      ourDelta.bytes === 0
        ? ""
        : `${ourDelta.bytes} bytes differ across ${ourDelta.files} of ${before.size} artifact files ` +
          `(${describeDifference(before, after)}); the determinism contract (5.3) says zero`,
      { bytes: ourDelta.bytes, files: ourDelta.files, artifacts: before.size },
    );
  }
  const ourBytes = numberOf(row.tools["greplost"]);

  for (const state of states.values()) {
    if (state.binary === null || state.dir === null || state.artifact === null) {
      row.tools[state.name] = na(plan.target, state.reason ?? "not run");
      continue;
    }
    const artifacts = INVOCATIONS[state.name].artifacts;
    const theirBefore = readAll(state.dir, artifacts);
    const failure = runInvocation(state, state.dir, INVOCATIONS[state.name].commands);
    if (failure !== null) {
      row.tools[state.name] = na(plan.target, `second build failed: ${failure}`);
      continue;
    }
    const theirAfter = readAll(state.dir, artifacts);
    const delta = byteDelta(theirBefore, theirAfter);
    row.tools[state.name] = measured(
      `${delta.bytes} bytes`,
      plan.target,
      verdictFor({ ours: ourBytes, theirs: delta.bytes, higherIsBetter: false, margin: plan.margin }),
      ourBytes !== null && delta.bytes <= ourBytes
        ? ""
        : `${delta.bytes} bytes over ${delta.files} of ${theirBefore.size} artifact files changed between two ` +
          `builds of the same tree: ${describeDifference(theirBefore, theirAfter)}`,
      { bytes: delta.bytes, files: delta.files, artifacts: theirBefore.size },
    );
  }
  method.push(
    "X4: every tool is built twice on the same tree, each build in its own process, and the differing bytes " +
      "of its documented artifact files are counted after trimming the common prefix and suffix (an upper " +
      "bound on the edit distance, exact for a single contiguous change). greplost is compared over the " +
      "structure artifacts `listStructurePaths` enumerates; viewer and database files are excluded per " +
      "competitor, and each cell's `caveat` says which.",
  );
}

/** The leading number of a cell whose value may carry a unit (`"128 bytes"`). */
function numberOf(cell: MetricCell | undefined): number | null {
  if (cell === undefined || cell.value === null) return null;
  if (typeof cell.value === "number") return cell.value;
  const match = /^-?\d+(?:\.\d+)?/.exec(cell.value);
  return match === null ? null : Number(match[0]);
}

// ---------------------------------------------------------------------------
// X5: diff signal after a one-line change
// ---------------------------------------------------------------------------

/**
 * The edit is derived from the repo, never hard-coded: an existing import
 * specifier is copied from a sibling file in the same directory onto a file that
 * does not already import that module, so the specifier resolves identically and
 * the change adds exactly one architecture edge. The chosen edit is recorded in
 * the payload so the run can be repeated by hand.
 */
export function planImportEdit(snapshot: Snapshot): ImportEdit | null {
  return planImportEdits(snapshot, 1)[0] ?? null;
}

/** One appendable `import "<specifier>";` and the edge it adds. */
export interface ImportEdit {
  file: string;
  specifier: string;
  to: string;
}

/**
 * Up to `limit` distinct one-line import edits, in a deterministic order.
 *
 * Each is a specifier already used by a sibling file in the same directory,
 * copied onto a file that does not import it yet, so it resolves exactly as the
 * original did and the change adds exactly one architecture edge and nothing
 * else. Nothing is hard-coded per repo, and the chosen edits are recorded in the
 * results payload so a run can be repeated by hand.
 */
export function planImportEdits(snapshot: Snapshot, limit: number): ImportEdit[] {
  const importsByFile = new Map<string, Set<string>>();
  for (const edge of snapshot.imports) {
    let set = importsByFile.get(edge.from);
    if (set === undefined) {
      set = new Set();
      importsByFile.set(edge.from, set);
    }
    set.add(edge.to);
  }
  const candidates = [...snapshot.files].map((file) => file.path).sort(compareStrings);
  const out: ImportEdit[] = [];
  const taken = new Set<string>();
  for (const donor of candidates) {
    const records = snapshot.files.find((file) => file.path === donor)?.imports ?? [];
    for (const record of [...records].sort((a, b) => compareStrings(a.specifier, b.specifier))) {
      if (!record.specifier.startsWith("./")) continue;
      const edge = snapshot.imports.find((e) => e.from === donor && e.specifier === record.specifier);
      if (edge === undefined || !edge.to.includes("/")) continue;
      for (const receiver of candidates) {
        if (receiver === donor) continue;
        if (path.posix.dirname(receiver) !== path.posix.dirname(donor)) continue;
        if (edge.to === receiver) continue;
        if (importsByFile.get(receiver)?.has(edge.to) === true) continue;
        const key = `${receiver}\u0000${edge.to}`;
        if (taken.has(key)) continue;
        taken.add(key);
        out.push({ file: receiver, specifier: record.specifier, to: edge.to });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

async function metricX5(
  metrics: Record<XId, MetricRow>,
  target: Target,
  snapshot: Snapshot,
  states: Map<CompetitorName, CompetitorState>,
  method: string[],
): Promise<void> {
  const plan = PLAN_BY_ID.get("X5") as MetricDef;
  const row = metrics["X5"];
  const edit = planImportEdit(snapshot);
  if (edit === null) {
    for (const tool of TOOLS) row.tools[tool] = na(plan.target, "no one-line import could be added to this repo without changing what it means");
    return;
  }
  const line = `import "${edit.specifier}";`;
  method.push(`X5: the one-line change is \`${line}\` appended to \`${edit.file}\`, adding the edge ${edit.file} -> ${edit.to}.`);

  // greplost, in a scratch copy so the target repo is never edited.
  const scratch = path.join(WORK_DIR, "greplost", target.name);
  prepareCopy(target.root, scratch);
  const buildArtifacts = await loadBuildArtifacts();
  const before = (await buildArtifacts(scratch)).files;
  appendLine(path.join(scratch, edit.file), line);
  const after = (await buildArtifacts(scratch)).files;
  const ourDelta = lineDelta(before, after);
  const ourWhere = describeLineChange(before, after);
  row.tools["greplost"] = measured(
    `${ourDelta.lines} of ${ourDelta.total} lines`,
    plan.target,
    ourDelta.lines <= 10 ? "win" : "loss",
    ourDelta.lines <= 10
      ? ""
      : `${ourDelta.lines} artifact lines of ${ourDelta.total} changed across ${ourDelta.files} files for a ` +
        `one-line source change; the target is 10 lines. Where: ${ourWhere}`,
    {
      lines: ourDelta.lines,
      files: ourDelta.files,
      artifactLines: ourDelta.total,
      changedShare: round(ourDelta.lines / Math.max(ourDelta.total, 1), 4),
      namesBothEndpoints: mentionsBothEndpoints(before, after, edit) ? 1 : 0,
    },
  );

  for (const state of states.values()) {
    if (state.binary === null || state.dir === null || state.artifact === null) {
      row.tools[state.name] = na(plan.target, state.reason ?? "not run");
      continue;
    }
    const artifacts = INVOCATIONS[state.name].artifacts;
    const theirBefore = readAll(state.dir, artifacts);
    appendLine(path.join(state.dir, edit.file), line);
    const failure = runInvocation(state, state.dir, INVOCATIONS[state.name].refresh ?? INVOCATIONS[state.name].commands);
    if (failure !== null) {
      row.tools[state.name] = na(plan.target, `refresh after the edit failed: ${failure}`);
      continue;
    }
    const theirAfter = readAll(state.dir, artifacts);
    const delta = lineDelta(theirBefore, theirAfter);
    row.tools[state.name] = measured(
      `${delta.lines} of ${delta.total} lines`,
      plan.target,
      verdictFor({ ours: ourDelta.lines, theirs: delta.lines, higherIsBetter: false, margin: plan.margin }),
      // A reason on both sides of the comparison. The publishing rule asks for
      // one on every loss, and a loss here is the competitor changing *fewer*
      // lines than greplost, which is exactly the case the old condition left
      // empty (review round 2, minor).
      `${delta.lines} of ${delta.total} artifact lines changed against greplost's ${ourDelta.lines} of ` +
        `${ourDelta.total}${delta.lines < ourDelta.lines ? ", a quieter diff than greplost's" : ""}. ` +
        `Where: ${describeLineChange(theirBefore, theirAfter)}`,
      {
        lines: delta.lines,
        files: delta.files,
        artifactLines: delta.total,
        changedShare: round(delta.lines / Math.max(delta.total, 1), 4),
        namesBothEndpoints: mentionsBothEndpoints(theirBefore, theirAfter, edit) ? 1 : 0,
      },
    );
  }
  method.push(
    "X5: lines changed is added plus removed lines from a line-level longest-common-subsequence per " +
      `artifact file (multiset difference above ${LCS_CAP} lines).`,
  );
  method.push(
    `X5 readability (tech spec 10.0's "can a human read the architectural change from the diff alone"): ` +
      readabilityLine(row),
  );
}

/**
 * The mechanical half of "can a human read the architectural change from the
 * diff alone" (tech spec 10.0, X5): does at least one line that the rebuild
 * added name **both** ends of the new edge?
 *
 * It is a proxy and it is reported as one, in each cell's `namesBothEndpoints`.
 * A diff where the added lines name the importer and the imported module is one
 * a reviewer can read; a diff of shifted numeric ids is not, however many lines
 * it is. The judgement of readability stays with the reader; this is the part a
 * benchmark can check without one.
 */
function mentionsBothEndpoints(
  before: Map<string, string>,
  after: Map<string, string>,
  edit: ImportEdit,
): boolean {
  for (const [key, text] of after) {
    const previous = new Set((before.get(key) ?? "").split("\n"));
    for (const line of text.split("\n")) {
      if (previous.has(line)) continue;
      if (line.includes(edit.file) && line.includes(edit.to)) return true;
    }
  }
  return false;
}

/** Which tools' diffs named both ends of the new edge, and which did not. */
function readabilityLine(row: MetricRow): string {
  const yes: string[] = [];
  const no: string[] = [];
  for (const tool of TOOLS) {
    const flag = row.tools[tool]?.detail?.["namesBothEndpoints"];
    if (flag === undefined) continue;
    (flag === 1 ? yes : no).push(tool);
  }
  const parts: string[] = [];
  if (yes.length > 0) parts.push(`${yes.join(", ")} added a line naming both the importer and the imported module`);
  if (no.length > 0) parts.push(`${no.join(", ")} did not, so the new edge is not legible in the diff at any length`);
  return parts.length === 0 ? "not determined for any tool" : `${parts.join("; ")}.`;
}

function appendLine(file: string, line: string): void {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, existing.endsWith("\n") || existing.length === 0 ? `${existing}${line}\n` : `${existing}\n${line}\n`);
}

// ---------------------------------------------------------------------------
// X6: cold start
// ---------------------------------------------------------------------------

/** Median of a non-empty list; the middle value, or the mean of the middle two. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** How many times each cold start is timed. Odd, so the median is a real sample. */
const COLD_START_RUNS = 3;

/**
 * X6: from a fresh copy to the tool's own first usable output.
 *
 * Timed `COLD_START_RUNS` times on a freshly made copy each time, reported as
 * the median. One run is a coin flip on a machine with other work on it, and X6
 * is a number the README quotes; the min and max go into the cell's detail so
 * the spread is visible rather than hidden behind the median.
 */
async function metricX6(
  metrics: Record<XId, MetricRow>,
  target: Target,
  states: Map<CompetitorName, CompetitorState>,
  method: string[],
): Promise<void> {
  const plan = PLAN_BY_ID.get("X6") as MetricDef;
  const row = metrics["X6"];

  // greplost is timed through its own CLI in a child process, not in-process:
  // a competitor pays interpreter startup and grammar loading on a cold start
  // and greplost must pay them too, or the comparison is a measurement of Bun
  // already being warm rather than of the tool.
  const cli = path.join(REPO_ROOT, "packages", "cli", "src", "main.ts");
  const scratch = path.join(WORK_DIR, "greplost", `${target.name}-cold`);
  const ourSamples: number[] = [];
  let artifacts = 0;
  let ourFailure: string | null = null;
  for (let run = 0; run < COLD_START_RUNS; run++) {
    prepareCopy(target.root, scratch);
    const ran = runTool("bun", [cli, "init", "--no-hooks", "--root", scratch], REPO_ROOT);
    if (!ran.ok) {
      ourFailure = `\`greplost init --no-hooks\` exited ${ran.code ?? "on a signal"} on a fresh copy`;
      break;
    }
    ourSamples.push(ran.ms / 1000);
    artifacts = existsSync(path.join(scratch, ".greplost")) ? countFiles(path.join(scratch, ".greplost")) : 0;
  }
  const seconds = median(ourSamples);
  row.tools["greplost"] = ourFailure !== null || seconds === null
    ? na(plan.target, ourFailure ?? "no cold start completed")
    : measured(
        `${round(seconds, 3)} s ($0)`,
        plan.target,
        seconds <= 5 ? "win" : "loss",
        seconds <= 5 ? "" : `${round(seconds, 2)}s from a fresh copy to a usable map; the target is 5s`,
        {
          seconds: round(seconds, 3),
          usd: 0,
          artifacts,
          runs: ourSamples.length,
          fastest: round(Math.min(...ourSamples), 3),
          slowest: round(Math.max(...ourSamples), 3),
        },
      );

  for (const state of states.values()) {
    if (state.binary === null) {
      row.tools[state.name] = na(plan.target, state.reason ?? "not installed");
      continue;
    }
    const dir = path.join(WORK_DIR, state.name, `${target.name}-cold`);
    const invocation = INVOCATIONS[state.name];
    const commands = invocation.coldStart ?? invocation.commands;
    const samples: number[] = [];
    let failure: string | null = null;
    for (let run = 0; run < COLD_START_RUNS; run++) {
      prepareCopy(target.root, dir);
      const clock = Date.now();
      failure = runInvocation(state, dir, commands);
      if (failure !== null) break;
      samples.push((Date.now() - clock) / 1000);
    }
    const theirSeconds = median(samples);
    row.tools[state.name] = failure !== null || theirSeconds === null
      ? na(plan.target, `cold start failed: ${failure ?? "no run completed"}`)
      : measured(
          `${round(theirSeconds, 3)} s`,
          plan.target,
          verdictFor({ ours: seconds, theirs: theirSeconds, higherIsBetter: false, margin: plan.margin }),
          seconds !== null && theirSeconds < seconds - plan.margin
            ? `${round(theirSeconds, 2)}s against greplost's ${round(seconds, 2)}s from a fresh copy`
            : "",
          {
            seconds: round(theirSeconds, 3),
            runs: samples.length,
            fastest: round(Math.min(...samples), 3),
            slowest: round(Math.max(...samples), 3),
          },
        );
    rmSync(dir, { recursive: true, force: true });
  }
  method.push(
    `X6: timed from a fresh copy of the repo (no cache, no artifact) to the tool's own first usable output, ` +
      `${COLD_START_RUNS} runs each, median reported and the spread in each cell's detail, every tool in its ` +
      "own child process so interpreter startup is counted for all of them. greplost's command is `greplost " +
      "init --no-hooks` and its USD is 0; a competitor's documented first pass may cost model tokens, and " +
      "where the no-LLM path was used instead the cell's caveat says so.",
  );
}

// ---------------------------------------------------------------------------
// X7 and X8: agent tasks and orientation cost
// ---------------------------------------------------------------------------

function metricX7X8(
  metrics: Record<XId, MetricRow>,
  states: Map<CompetitorName, CompetitorState>,
  method: string[],
  selected: (id: XId) => boolean,
): void {
  const agent = safeLatest("agent");
  const x7 = PLAN_BY_ID.get("X7") as MetricDef;
  const x8 = PLAN_BY_ID.get("X8") as MetricDef;
  const missing = "the agent suite (Eval 4) has not produced a result yet; run `bench agent` (it costs money)";

  const conditionStats = agent === null ? new Map<string, Map<string, Record<string, number>>>() : agentStats(agent);
  const structural = ["definition", "importers", "callers", "blast_radius"];
  const orientation = ["orientation", "conceptual"];

  const gather = (categories: readonly string[], condition: string, field: string): number | null => {
    const values: number[] = [];
    for (const [category, byCondition] of conditionStats) {
      if (!categories.some((wanted) => category.toLowerCase().includes(wanted))) continue;
      const value = byCondition.get(condition)?.[field];
      if (typeof value === "number" && Number.isFinite(value)) values.push(value);
    }
    return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
  };

  if (selected("X7")) {
    const row = metrics["X7"];
    const ours = gather(structural, "gl", "accuracy");
    row.tools["greplost"] = ours === null
      ? na(x7.target, missing)
      : measured(round(ours, 3), x7.target, "na", "no competitor condition was run, so `>= best competitor` has nothing to compare against", {
          accuracy: round(ours, 3),
          toolCalls: gather(structural, "gl", "toolCalls") ?? 0,
        });
    for (const state of states.values()) {
      const theirs = gather(structural, state.name, "accuracy");
      row.tools[state.name] = theirs === null
        ? na(x7.target, agent === null ? missing : `the agent suite ran no \`${state.name}\` condition`)
        : measured(
            round(theirs, 3),
            x7.target,
            verdictFor({ ours, theirs, higherIsBetter: true, margin: x7.margin }),
            ours !== null && theirs > ours ? `${state.name} answered more structural tasks correctly than greplost` : "",
            { accuracy: round(theirs, 3) },
          );
    }
    if (ours !== null) {
      method.push("X7: accuracy and tool calls are the unweighted mean over the four structural categories of the agent result.");
    }
  }

  if (selected("X8")) {
    const row = metrics["X8"];
    const ours = gather(orientation, "gl", "tokens");
    row.tools["greplost"] = ours === null
      ? na(x8.target, agent === null ? missing : "the agent result carried no orientation category")
      : measured(`${Math.round(ours)} tokens`, x8.target, "na", "no competitor condition was run, so `<= 50% of best` has nothing to compare against", { tokens: Math.round(ours) });
    for (const state of states.values()) {
      const theirs = gather(orientation, state.name, "tokens");
      row.tools[state.name] = theirs === null
        ? na(x8.target, agent === null ? missing : `the agent suite ran no \`${state.name}\` orientation condition`)
        : measured(
            `${Math.round(theirs)} tokens`,
            x8.target,
            verdictFor({ ours, theirs, higherIsBetter: false, margin: x8.margin }),
            ours !== null && theirs < ours ? `${state.name} answered the orientation task in fewer tokens` : "",
            { tokens: Math.round(theirs) },
          );
    }
  }
}

/** `category -> condition -> { accuracy, tokens, toolCalls, wallClock, cost }`. */
function agentStats(payload: Record<string, unknown>): Map<string, Map<string, Record<string, number>>> {
  const out = new Map<string, Map<string, Record<string, number>>>();
  const container =
    asRecord(payload["categories"]) ?? asRecord(payload["byCategory"]) ?? asRecord(payload["results"]);
  if (container === null) return out;
  for (const category of Object.keys(container).sort()) {
    const conditions = asRecord(container[category]);
    if (conditions === null) continue;
    const inner = new Map<string, Record<string, number>>();
    for (const condition of Object.keys(conditions).sort()) {
      const stats = asRecord(conditions[condition]);
      if (stats === null) continue;
      const numbers: Record<string, number> = {};
      for (const key of Object.keys(stats).sort()) {
        const direct = stats[key];
        if (typeof direct === "number" && Number.isFinite(direct)) {
          numbers[key] = direct;
          continue;
        }
        // `{ mean, median, std }` blocks: the agent suite reports variance.
        const nested = asRecord(direct);
        const value = nested === null ? undefined : (nested["median"] ?? nested["mean"] ?? nested["p50"]);
        if (typeof value === "number" && Number.isFinite(value)) numbers[key] = value;
      }
      // `tool_calls` and `toolCalls` are the same measurement.
      if (numbers["toolCalls"] === undefined && typeof numbers["tool_calls"] === "number") {
        numbers["toolCalls"] = numbers["tool_calls"];
      }
      inner.set(condition, numbers);
    }
    if (inner.size > 0) out.set(category, inner);
  }
  return out;
}

// ---------------------------------------------------------------------------
// X9 and X10
// ---------------------------------------------------------------------------

function metricX9(metrics: Record<XId, MetricRow>, method: string[]): void {
  const plan = PLAN_BY_ID.get("X9") as MetricDef;
  const row = metrics["X9"];
  const human = safeLatest("human");
  const reason =
    human === null
      ? "the reviewer task lives in the human navigation study (tech spec 10.7), which needs participants; " +
        "no study has been run, so there is nothing to report for any tool"
      : "the human study result carried no reviewer task";
  for (const tool of TOOLS) row.tools[tool] = na(plan.target, reason);
  method.push(`X9: ${reason}.`);
}

function metricX10(metrics: Record<XId, MetricRow>, states: Map<CompetitorName, CompetitorState>, method: string[]): void {
  const plan = PLAN_BY_ID.get("X10") as MetricDef;
  const row = metrics["X10"];

  // Workspace mode is a capability probe, not a score, but it is still a probe that
  // has to run something. This used to ask `greplost workspace --help` for an exit code
  // and record `n/a: not a command`, which was true and beside the point: there is no
  // `workspace` subcommand by design (tech spec 4.4, `update`, `verify`, `query` and
  // `impact` act across repos when run from a directory holding
  // `greplost.workspace.json`). So X10 read `n/a` for a capability the CLI has (review
  // round 3, important 5). The probe now does what the tech spec's X10 says: `greplost
  // impact` on the two-repo fixture, asserting the answer crosses the repo boundary.
  const probe = probeCrossRepoImpact();
  row.tools["greplost"] =
    probe.reason === null
      ? measured("works", plan.target, "win", "", probe.detail)
      : na(plan.target, probe.reason);
  method.push(`X10 (greplost): ${probe.method}`);

  const sentences: Record<CompetitorName, string> = {
    graphify:
      "no cross-repo blast radius: `graphify merge-graphs` can union two graph.json files after the fact, " +
      "but nothing resolves an import from one repo to a definition in another, so a merged graph has two " +
      "disconnected components",
    ua:
      "no cross-repo mode: `/understand` analyses one project directory and writes one `.ua/knowledge-graph.json` " +
      "anchored at it; a second repo would need a second run and there is no edge type joining them",
    crg:
      "`crg-daemon` watches several repositories, but each keeps its own SQLite graph and the resolver never " +
      "crosses a repository boundary, so `code-review-graph` can answer 'who calls this' only within one repo",
  };
  for (const state of states.values()) {
    row.tools[state.name] = na(plan.target, sentences[state.name]);
  }
  method.push("X10: a capability row, not a score (tech spec 3.1). Each competitor's cell says what it would need to do this.");
}

/**
 * The file X10 asks for a blast radius of, and the repo whose files the answer must
 * reach for the capability to have been demonstrated.
 *
 * `fixtures/two-repo-workspace` is `repo-a` (a package exporting `greet`) plus `repo-b`
 * (which imports it). A blast radius of `repo-a`'s source that stops at `repo-a`'s
 * boundary is a single-repo answer wearing a workspace's clothes.
 */
const X10_SUBJECT = "repo-a/src/greet.ts";
const X10_OTHER_REPO = "repo-b";

/**
 * Does `greplost impact` cross a repository boundary on the two-repo fixture?
 *
 * Runs the real CLI against a throwaway copy: `init --workspace --no-hooks` from the
 * directory holding `greplost.workspace.json`, then `impact <subject> --json`. Nothing
 * here is a score, X10 is a capability row, but the `works` is now something that ran,
 * and every way it can fail returns the reason instead.
 */
function probeCrossRepoImpact(): { reason: string | null; detail: Record<string, number>; method: string } {
  const ran = `\`greplost init --workspace --no-hooks\` then \`greplost impact ${X10_SUBJECT} --json\` on a copy of \`fixtures/two-repo-workspace\``;
  const fixture = path.join(REPO_ROOT, "fixtures", "two-repo-workspace");
  if (!existsSync(fixture)) {
    return { reason: "the `two-repo-workspace` fixture does not exist in this checkout", detail: {}, method: `${ran}: the fixture is missing.` };
  }
  const cli = path.join(REPO_ROOT, "packages", "cli", "src", "main.ts");
  const dir = path.join(WORK_DIR, "greplost", "two-repo-workspace");
  // Its own git repository, for the reason `prepareCopy` documents: the work dir is
  // gitignored by the greplost checkout, and greplost's discovery honours ignore rules.
  prepareCopy(fixture, dir);

  // `--root` explicitly, never cwd: `findRoot` walks up looking for a `.greplost`, and
  // from inside `bench/.competitors/` the first one it meets is greplost's own, which
  // is how this probe came to report "there is no greplost.workspace.json here" while
  // standing in a directory that has one.
  const call = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const spawned = spawnSync("bun", [cli, ...args, "--root", dir], { cwd: dir, encoding: "utf8", timeout: 120_000 });
    return { status: spawned.status, stdout: spawned.stdout ?? "", stderr: spawned.stderr ?? "" };
  };

  const init = call(["init", "--workspace", "--no-hooks"]);
  if (init.status !== 0) {
    const why = (init.stderr || init.stdout).trim().split("\n")[0] ?? `exit ${init.status}`;
    return { reason: `\`greplost init --workspace\` failed on the fixture: ${why}`, detail: {}, method: `${ran}: init failed, ${why}.` };
  }

  const impact = call(["impact", X10_SUBJECT, "--json"]);
  if (impact.status !== 0) {
    const why = (impact.stderr || impact.stdout).trim().split("\n")[0] ?? `exit ${impact.status}`;
    return { reason: `\`greplost impact\` failed in workspace mode: ${why}`, detail: {}, method: `${ran}: impact failed, ${why}.` };
  }

  let files: { path?: unknown; depth?: unknown }[];
  try {
    const parsed = JSON.parse(impact.stdout) as { files?: unknown };
    files = Array.isArray(parsed.files) ? (parsed.files as { path?: unknown; depth?: unknown }[]) : [];
  } catch (err) {
    const why = (err as Error).message;
    return { reason: `\`greplost impact --json\` did not produce readable JSON: ${why}`, detail: {}, method: `${ran}: unreadable JSON, ${why}.` };
  }

  // Workspace ids are `<repo>::<path within repo>` (tech spec 4.4), so a cross-repo hit
  // is a file whose repo prefix is not the subject's.
  const crossRepo = files.filter((file) => typeof file.path === "string" && file.path.startsWith(`${X10_OTHER_REPO}::`));
  const depths = files.map((file) => (typeof file.depth === "number" ? file.depth : 0));
  if (crossRepo.length === 0) {
    return {
      reason:
        `\`greplost impact\` answered inside one repository only: ${files.length} affected file` +
        `${files.length === 1 ? "" : "s"}, none of them in \`${X10_OTHER_REPO}\`, so no cross-repo edge was resolved`,
      detail: { affectedFiles: files.length, crossRepoFiles: 0 },
      method: `${ran}: the answer stayed inside \`repo-a\`, so the capability was not demonstrated.`,
    };
  }
  return {
    reason: null,
    detail: {
      affectedFiles: files.length,
      crossRepoFiles: crossRepo.length,
      radius: depths.length === 0 ? 0 : Math.max(...depths),
    },
    method:
      `${ran} returned ${files.length} affected file${files.length === 1 ? "" : "s"}, ` +
      `${crossRepo.length} of them in \`${X10_OTHER_REPO}\`: the blast radius crossed the repository boundary, ` +
      "which is the capability tech spec 3.1 X10 asks for. It is not a score: no competitor has an equivalent " +
      "to compare it against.",
  };
}

// ---------------------------------------------------------------------------
// results-io access
// ---------------------------------------------------------------------------

function safeLatest(suite: string): Record<string, unknown> | null {
  try {
    const found = latestResult(suite);
    return found === undefined ? null : found.payload;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numberAt(payload: Record<string, unknown>, key: string): number | null {
  const direct = payload[key];
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  const summary = asRecord(payload["summary"]);
  const nested = summary === null ? undefined : summary[key];
  return typeof nested === "number" && Number.isFinite(nested) ? nested : null;
}

/** A rate in [0, 1] from either a direct field or a caught/total pair. */
function replayRate(payload: Record<string, unknown>, direct: string[], ratio: [string, string]): number | null {
  for (const key of direct) {
    const value = numberAt(payload, key);
    if (value !== null) return value > 1 ? value / 100 : value;
  }
  const numerator = numberAt(payload, ratio[0]);
  const denominator = numberAt(payload, ratio[1]);
  if (numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator;
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

function tally(rows: readonly MetricRow[]): Record<string, { win: number; loss: number; tie: number; na: number }> {
  const out: Record<string, { win: number; loss: number; tie: number; na: number }> = {};
  for (const tool of COMPETITORS) {
    const counts = { win: 0, loss: 0, tie: 0, na: 0 };
    for (const row of rows) counts[row.tools[tool]?.verdict ?? "na"]++;
    out[tool] = counts;
  }
  return out;
}

function printTable(rows: readonly MetricRow[]): void {
  const header = ["ID", "Measured", ...COMPETITORS.map((tool) => `vs ${tool}`)];
  const body = rows.map((row) => [
    row.id,
    cellText(row.tools["greplost"]),
    ...COMPETITORS.map((tool) => cellText(row.tools[tool])),
  ]);
  const widths = header.map((cell, index) => Math.max(cell.length, ...body.map((line) => (line[index] ?? "").length)));
  const line = (cells: string[]): string => `  ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ")}`.trimEnd();
  console.log(line(header));
  for (const row of body) console.log(line(row));
  for (const row of rows) {
    for (const tool of TOOLS) {
      const cell = row.tools[tool];
      if (cell === undefined || cell.reason.length === 0) continue;
      if (cell.verdict !== "loss" && cell.verdict !== "na") continue;
      console.log(`  ${row.id} ${tool}: ${cell.reason}`);
    }
  }
}

function cellText(cell: MetricCell | undefined): string {
  if (cell === undefined) return "n/a";
  if (cell.verdict === "na") return "n/a";
  const value = typeof cell.value === "number" ? String(round(cell.value, 3)) : (cell.value ?? "");
  return `${cell.verdict} (${value})`;
}
