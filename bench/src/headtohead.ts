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
 * greplost's verdict *against that tool* — `win` means greplost came out ahead by
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
import { X_IDS, type MetricCell, type MetricRow, type Verdict, type XId } from "./results-md.ts";
import { scoredFiles } from "./structural.ts";
import { generateTsTruth, type Truth } from "./truth/ts.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const SUITE = "headtohead";
/** Where a competitor's repo copy and its artifacts live. Gitignored. */
const WORK_DIR = path.join(REPO_ROOT, "bench", ".competitors");
/** Where `uv tool install` / `pipx install` put the competitor binaries, if used. */
const LOCAL_BIN = path.join(WORK_DIR, "_bin");
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
const SANDBOX_HOME = path.join(WORK_DIR, "home");
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
  dryRun: boolean;
}

function parseArgs(args: string[]): Options {
  const options: Options = { fixture: false, repo: undefined, tier: "S", metrics: null, commits: undefined, dryRun: false };
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
    // without model credentials — and the only fair one, since greplost's
    // structure layer is LLM-free too.
    commands: [["update", "."]],
    refresh: [["update", "."]],
    artifacts: ["graphify-out/graph.json", "graphify-out/GRAPH_REPORT.md", "graphify-out/manifest.json"],
    caveat:
      "run through `graphify update .` (the documented no-LLM rebuild) rather than the `/graphify .` " +
      "slash command, which needs a model; graph.html is excluded from the byte comparison because it is " +
      "a viewer, not the graph",
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
    // `code-review-graph install` is deliberately NOT run: it detects the AI
    // coding tools on the machine and writes their MCP configuration and hooks,
    // which is a global side effect a benchmark has no business causing. `build`
    // and `visualize` are the documented commands that produce the artifact, and
    // `update` is the documented manual incremental path.
    commands: [["build"], ["visualize", "--format", "json"]],
    refresh: [["update"], ["visualize", "--format", "json"]],
    artifacts: [".code-review-graph/graph.json"],
    caveat:
      "`code-review-graph install` is not run: it writes MCP config and hooks into every AI coding tool it " +
      "detects on the machine. `build` + `visualize --format json` produce the same artifact. `graph.db` is " +
      "excluded from the byte comparison because a SQLite page layout is not the tool's output contract",
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

/** A shim for greplost's own CLI, so its hook's `command -v greplost` resolves. */
export function writeGreplostShim(): string {
  mkdirSync(SHIM_DIR, { recursive: true });
  const runner = path.join(SHIM_DIR, "greplost-real");
  writeFileSync(
    runner,
    `#!/bin/sh\nexec bun ${JSON.stringify(path.join(REPO_ROOT, "packages", "cli", "src", "main.ts"))} "$@"\n`,
  );
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
 * own file discovery — which honours ignore rules — indexed 12 of the fixture's
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
 * bound on the true edit distance, exact for a single contiguous edit — which is
 * what a rebuild of the same tree produces when it produces anything — and it
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
 * PATH at run time, and a throwaway replay repository has no greplost on PATH —
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
 * bytes in `.greplost/graph/*.jsonl` — the thing a reviewer would read — and not
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

  const target = resolveTarget(options);
  if (typeof target === "string") {
    console.error(target);
    return 2;
  }

  try {
    return await execute(options, target);
  } catch (err) {
    console.error(`${SUITE}: ${(err as Error).message}`);
    return 1;
  }
}

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
    if (invocation.caveat !== null && binary !== null) method.push(`${name}: ${invocation.caveat}.`);
    if (binary !== null) {
      method.push(
        `${name}: every command ran with HOME=${path.relative(REPO_ROOT, SANDBOX_HOME)} (XDG and ` +
          "CLAUDE_CONFIG_DIR pointed inside it), so nothing it writes outside the repo copy reaches the " +
          "machine's real configuration.",
      );
    }
    if (binary === null) method.push(`${name}: N/A — ${unavailableReason(name, spec)}.`);
  }

  // One repo copy and one tool run per competitor, reused by X1, X4, X5 and X6.
  for (const state of states.values()) {
    if (state.binary === null) continue;
    const dir = path.join(WORK_DIR, state.name, target.name);
    prepareCopy(target.root, dir);
    const failure = runInvocation(state, dir, INVOCATIONS[state.name].commands);
    state.dir = dir;
    if (failure !== null) {
      state.reason = failure;
      method.push(`${state.name}: run failed — ${failure}.`);
      continue;
    }
    const loaded = loadArtifact(state.name, dir, specs.get(state.name)?.version ?? "unknown");
    if (typeof loaded === "string") {
      state.reason = loaded;
      method.push(`${state.name}: artifact not readable — ${loaded}.`);
    } else {
      state.artifact = loaded;
    }
  }

  // The snapshot and the compiler oracle are what X1, X2 and X5 need. X4, X6 and
  // X10 do not, and a repo whose toolchain the oracle cannot load must not cost
  // the whole table: the metrics that depend on it record why, and the rest run.
  let snapshot: Snapshot | null = null;
  let truth: Truth | null = null;
  let oracleFailure: string | null = null;
  try {
    const snapshotBuilder = await loadBuildSnapshot();
    snapshot = await snapshotBuilder({ root: target.root });
    truth = generateTsTruth(target.root, scoredFiles(snapshot, "ts"));
  } catch (err) {
    oracleFailure = (err as Error).message;
    method.push(`X1, X2, X5: ${snapshot === null ? "the greplost snapshot" : "the compiler oracle"} could not be built — ${oracleFailure}.`);
  }
  const noOracle = (what: string): string =>
    `${what} needs compiler truth for ${target.name}, which could not be built here: ${oracleFailure ?? "unknown reason"}`;

  if (selected("X1")) {
    if (snapshot !== null && truth !== null) await metricX1(metrics, snapshot, truth, states, method);
    else for (const tool of TOOLS) (metrics["X1"] as MetricRow).tools[tool] = na(METRIC_PLAN[0]?.target ?? "", noOracle("X1"));
  }
  if (selected("X2") || selected("X3")) {
    if (snapshot !== null) {
      await metricX2X3(metrics, target, snapshot, states, method, selected, options.commits ?? 0);
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

  const rows = METRIC_PLAN.map((metric) => metrics[metric.id]);
  printTable(rows);

  const payload = {
    suite: SUITE,
    date: todayIso(),
    greplostSha: gitSha7(),
    machine: machineProfile(),
    corpus: target.sha === null
      ? [{ name: target.name }]
      : [{ name: target.name, sha: target.sha, ...(target.tier === null ? {} : { tier: target.tier }), lang: target.lang }],
    target: { repo: target.name, fixture: options.fixture, tier: options.tier },
    tools: [...TOOLS],
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

  const file = writeResult(SUITE, payload);
  console.log(`${SUITE}: wrote ${path.relative(REPO_ROOT, file)}`);
  return 0;
}

function runInvocation(state: CompetitorState, dir: string, commands: readonly string[][]): string | null {
  if (state.binary === null) return unavailableReason(state.name, state.spec);
  for (const args of commands) {
    // Every competitor command runs under the scratch HOME, without exception:
    // `build`, `update` and `visualize` all touch the tool's own global state.
    const ran = runTool(state.binary, args, dir, sandboxEnv());
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
   * confidence — the symmetric comparison, and the one tech spec 10.0's claim is
   * about ("greplost never emits an unresolved edge; LLM-extracted graphs do"),
   * because that claim is about what a tool *publishes*, not about a subset a
   * reader could filter to.
   *
   * `callsHigh` is the same score restricted to `confidence: "high"` on both
   * sides — greplost's S3 gate, and the tier graphify calls `EXTRACTED` and crg
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
 * A commit walk, one refresh per tool per commit, scoring every tool's artifact
 * against compiler truth at checkpoints (tech spec 10.0, X2 and X3).
 *
 * The measured quantity is **import edge F1**, not the F1 over every edge kind.
 * Imports are the one relationship all four tools model the same way, and the
 * one where a fresh greplost build already scores 1.0, so a drop in the line is
 * drift rather than a modelling difference. Call F1 is recorded next to it in
 * each cell's detail, where the level rather than the shape is the story.
 *
 * Two deviations from the tech spec's letter, both because of what this machine
 * has rather than what the tools are:
 *
 *  - The history is synthetic. Each commit appends one resolvable import line to
 *    one file, chosen from the repo's own specifiers (`planImportEdits`), so
 *    every commit adds exactly one architecture edge and truth moves by exactly
 *    one edge. A corpus checkout with 500 real commits is what the spec asks
 *    for; it is not cloned here, and a synthetic walk is stated as such.
 *  - Each tool's documented refresh is invoked by the harness once per commit,
 *    rather than left to the tool's own git hook. Hooks resolve their binary
 *    from PATH inside a throwaway repository, where none of these tools is on
 *    PATH; leaving it to the hooks would measure the harness's PATH and report
 *    it as the tools' staleness. Whether each tool's mechanism is automatic is
 *    recorded separately, from `bench/competitors.json`.
 */
interface StalenessPoint {
  index: number;
  /** tool -> import F1 of the artifact its documented refresh keeps up to date. */
  importF1: Map<string, number>;
  /** tool -> call F1 of that same refreshed artifact. */
  callF1: Map<string, number>;
  /**
   * tool -> import F1 of the artifact **as it stood at commit 0**, scored against
   * truth at this commit.
   *
   * This is the arm the tech spec's phrase "walk 500 commits without any manual
   * intervention" describes: what a reader sees when the tool's sync mechanism
   * is not installed, or is installed and does not fire. It costs nothing to
   * measure — the commit-0 edges are already in hand and the oracle is already
   * built — and without it the refreshed arm would be presented as a decay curve
   * when it is not one.
   */
  staleF1: Map<string, number>;
}

interface StalenessRun {
  commits: number;
  every: number;
  points: StalenessPoint[];
  /** tool -> total refresh wall-clock, milliseconds. */
  ms: Map<string, number>;
  /** tool -> refreshes that failed. */
  failures: Map<string, number>;
  notes: string[];
}

async function replayStaleness(
  target: Target,
  snapshot: Snapshot,
  states: Map<CompetitorName, CompetitorState>,
  requested: number,
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

  const dirs = new Map<string, string>();
  const ms = new Map<string, number>();
  const failures = new Map<string, number>();

  const greplostDir = path.join(WORK_DIR, "greplost", `${target.name}-replay`);
  prepareCopy(target.root, greplostDir);
  dirs.set("greplost", greplostDir);
  const { init, update } = await loadSync();
  const initStarted = Date.now();
  await init(greplostDir, { hooks: false, quiet: true });
  ms.set("greplost", Date.now() - initStarted);
  failures.set("greplost", 0);

  const live: CompetitorState[] = [];
  for (const state of states.values()) {
    if (state.binary === null) continue;
    const dir = path.join(WORK_DIR, state.name, `${target.name}-replay`);
    prepareCopy(target.root, dir);
    const started = Date.now();
    const failure = runInvocation(state, dir, INVOCATIONS[state.name].commands);
    ms.set(state.name, Date.now() - started);
    failures.set(state.name, failure === null ? 0 : 1);
    if (failure !== null) {
      notes.push(`${state.name}: its first build failed during the replay (${failure}), so its line stops here`);
      continue;
    }
    dirs.set(state.name, dir);
    live.push(state);
  }

  const points: StalenessPoint[] = [];
  const buildSnapshot = await loadBuildSnapshot();

  // The commit-0 artifact of every tool, kept for the unrefreshed arm.
  const atZero = new Map<string, { imports: Edge[]; calls: Edge[] }>();
  const ourZero = readGreplostArtifact(greplostDir);
  if (ourZero !== null) {
    atZero.set("greplost", {
      imports: ourZero.imports.filter((e) => !e.to.startsWith("ext:") && !e.to.startsWith("unresolved:")),
      // Every confidence, on both sides: see the note on X1's `score`.
      calls: [...ourZero.calls],
    });
  }
  for (const state of live) {
    const dir = dirs.get(state.name);
    if (dir === undefined) continue;
    const loaded = loadArtifact(state.name, dir, state.spec?.version ?? "unknown");
    if (typeof loaded !== "string") atZero.set(state.name, { imports: loaded.imports, calls: loaded.calls });
  }

  for (let k = 1; k <= commits; k++) {
    const edit = edits[k - 1];
    if (edit === undefined) break;
    const line = `import "${edit.specifier}";`;
    for (const dir of dirs.values()) {
      appendLine(path.join(dir, edit.file), line);
      runTool("git", ["add", "-A"], dir);
      runTool("git", ["-c", "user.email=bench@greplost.invalid", "-c", "user.name=bench", "commit", "-qm", `bench commit ${k}`], dir);
    }

    const greplostStarted = Date.now();
    try {
      await update(greplostDir, { mode: "incremental", quiet: true });
    } catch {
      failures.set("greplost", (failures.get("greplost") ?? 0) + 1);
    }
    ms.set("greplost", (ms.get("greplost") ?? 0) + (Date.now() - greplostStarted));

    for (const state of live) {
      const dir = dirs.get(state.name);
      if (dir === undefined) continue;
      const started = Date.now();
      const failure = runInvocation(state, dir, INVOCATIONS[state.name].refresh ?? INVOCATIONS[state.name].commands);
      ms.set(state.name, (ms.get(state.name) ?? 0) + (Date.now() - started));
      if (failure !== null) failures.set(state.name, (failures.get(state.name) ?? 0) + 1);
    }

    if (k % every !== 0 && k !== commits) continue;

    // Truth at this commit, from the tree every tool is looking at. The copies
    // are byte-identical (the same edit was applied to each), so one oracle run
    // serves all of them.
    const current = await buildSnapshot({ root: greplostDir });
    const files = scoredFiles(current, "ts");
    const truth = generateTsTruth(greplostDir, files);
    const universe = new Set(truth.files.length > 0 ? truth.files : files);
    const inside = (id: string): boolean => universe.has(fileOf(id));
    const truthImports = truth.imports.filter((e) => inside(e.from) && inside(e.to));
    const truthCalls = truth.calls.filter((e) => inside(e.from) && inside(e.to));

    const importF1 = new Map<string, number>();
    const callF1 = new Map<string, number>();
    const staleF1 = new Map<string, number>();
    const record = (tool: string, imports: Edge[], calls: Edge[]): void => {
      importF1.set(tool, scoreEdges(imports.filter((e) => inside(e.from) && inside(e.to)), truthImports).f1);
      callF1.set(tool, scoreEdges(calls.filter((e) => inside(e.from) && inside(e.to)), truthCalls).f1);
      const zero = atZero.get(tool);
      if (zero !== undefined) {
        staleF1.set(tool, scoreEdges(zero.imports.filter((e) => inside(e.from) && inside(e.to)), truthImports).f1);
      }
    };

    const ourArtifact = readGreplostArtifact(greplostDir);
    if (ourArtifact !== null) {
      record(
        "greplost",
        ourArtifact.imports.filter((e) => !e.to.startsWith("ext:") && !e.to.startsWith("unresolved:")),
        // Every confidence, on both sides: see the note on X1's `score`.
        [...ourArtifact.calls],
      );
    }
    for (const state of live) {
      const dir = dirs.get(state.name);
      if (dir === undefined) continue;
      const loaded = loadArtifact(state.name, dir, state.spec?.version ?? "unknown");
      if (typeof loaded === "string") continue;
      record(state.name, loaded.imports, loaded.calls);
    }
    points.push({ index: k, importF1, callF1, staleF1 });
  }

  notes.push(
    `the walk is ${commits} synthetic commits over ${target.name}, each adding one resolvable import line, ` +
      `scored every ${every} commit${every === 1 ? "" : "s"} against compiler truth at that commit`,
  );
  return { commits, every, points, ms, failures, notes };
}

/**
 * greplost's staleness and freshness cost, from a real per-tool walk when
 * `--commits` asked for one, and otherwise from the replay suite's committed
 * result (Eval 2), which is where a 500-commit walk belongs.
 */
async function metricX2X3(
  metrics: Record<XId, MetricRow>,
  target: Target,
  snapshot: Snapshot,
  states: Map<CompetitorName, CompetitorState>,
  method: string[],
  selected: (id: XId) => boolean,
  commits: number,
): Promise<void> {
  const x2 = PLAN_BY_ID.get("X2") as MetricDef;
  const x3 = PLAN_BY_ID.get("X3") as MetricDef;

  let walk: StalenessRun | null = null;
  if (commits > 0) {
    try {
      walk = await replayStaleness(target, snapshot, states, commits);
    } catch (err) {
      // A replay that blows up must not take the other nine metrics with it.
      method.push(`X2: the commit walk failed and X2/X3 fall back to the replay suite's result — ${(err as Error).message}.`);
      walk = null;
    }
  }

  if (walk !== null) {
    fromWalk(metrics, states, walk, method, selected, x2, x3);
    return;
  }
  fromReplayResult(metrics, states, method, selected, x2, x3);
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
    "X2: the plotted number is import edge F1 against compiler truth at that commit. Imports are the one " +
      "relationship all four tools model the same way and the one a fresh greplost build already scores 1.0 " +
      "on, so a fall in the line is drift and not a modelling difference; call F1 is in each cell's detail.",
  );
  method.push(
    "X2: two arms, both in every cell's detail. `f1@<commit>` is the artifact each tool's own documented " +
      "refresh keeps up to date, invoked after every commit — that arm is a comparison of incremental " +
      "accuracy, and it does not decay for anyone, so it must not be read as a staleness curve. " +
      "`staleF1@<commit>` is the same tool's commit-0 artifact scored against truth at that commit: the " +
      "curve a reader gets when the sync mechanism is absent or does not fire, which is the decay tech spec " +
      "10.0 X2 asks about. greplost is the only one of the four whose `verify` reports that second state at " +
      "all; the others refresh without ever checking.",
  );

  const last = walk.points[walk.points.length - 1];
  const seriesFor = (tool: string): Record<string, number> => {
    const detail: Record<string, number> = {};
    for (const point of walk.points) {
      const value = point.importF1.get(tool);
      if (value !== undefined) detail[`f1@${point.index}`] = round(value, 4);
      const calls = point.callF1.get(tool);
      if (calls !== undefined) detail[`callF1@${point.index}`] = round(calls, 4);
      const stale = point.staleF1.get(tool);
      if (stale !== undefined) detail[`staleF1@${point.index}`] = round(stale, 4);
    }
    return detail;
  };

  const ourFinal = last?.importF1.get("greplost") ?? null;
  if (selected("X2")) {
    const row = metrics["X2"];
    row.tools["greplost"] = ourFinal === null
      ? na(x2.target, `the walk ran ${walk.commits} commits but greplost's artifact could not be scored at the last checkpoint`)
      : measured(
          round(ourFinal, 4),
          x2.target,
          ourFinal >= 0.99 ? "win" : "loss",
          ourFinal >= 0.99
            ? ""
            : `greplost's committed graph scored ${round(ourFinal, 3)} import F1 after ${walk.commits} commits; the target is 0.99`,
          {
            ...seriesFor("greplost"),
            commits: walk.commits,
            refreshFailures: walk.failures.get("greplost") ?? 0,
            unrefreshedFinalF1: round(last?.staleF1.get("greplost") ?? 0, 4),
          },
        );
    for (const state of states.values()) {
      const theirs = last?.importF1.get(state.name) ?? null;
      row.tools[state.name] = theirs === null
        ? na(x2.target, state.reason ?? `${sentenceOfSync(state)} — its artifact could not be scored during the walk`)
        : measured(
            round(theirs, 4),
            x2.target,
            verdictFor({ ours: ourFinal, theirs, higherIsBetter: true, margin: x2.margin }),
            ourFinal !== null && theirs > ourFinal
              ? `${state.name} held ${round(theirs, 3)} import F1 against greplost's ${round(ourFinal, 3)} after ${walk.commits} commits`
              : "",
            {
              ...seriesFor(state.name),
              refreshFailures: walk.failures.get(state.name) ?? 0,
              unrefreshedFinalF1: round(last?.staleF1.get(state.name) ?? 0, 4),
            },
          );
    }
  }

  if (selected("X3")) {
    const row = metrics["X3"];
    const minutes = (tool: string): number | null => {
      const total = walk.ms.get(tool);
      return total === undefined ? null : total / 60_000;
    };
    const ourMinutes = minutes("greplost");
    const perCommit = (value: number | null): number | null => (value === null ? null : (value * 60) / Math.max(walk.commits, 1));
    row.tools["greplost"] = measured(
      ourMinutes === null ? "$0" : `$0, ${round(ourMinutes, 3)} min`,
      x3.target,
      "win",
      "",
      { usd: 0, minutes: round(ourMinutes ?? 0, 4), secondsPerCommit: round(perCommit(ourMinutes) ?? 0, 4) },
    );
    for (const state of states.values()) {
      const theirMinutes = minutes(state.name);
      if (theirMinutes === null) {
        row.tools[state.name] = na(x3.target, state.reason ?? "this tool was not walked, so there is no cost to sum");
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
      "X3: every tool that ran here ran its no-LLM path, so USD is 0 for all of them and the verdict falls to " +
        "wall-clock. That is not the tech spec's comparison, which costs each tool's *documented* refresh: " +
        "graphify's `/graphify` first pass and Understand-Anything's `/understand` are LLM pipelines whose USD " +
        "this harness cannot measure without model credentials. The zero is what was measured, not a claim " +
        "that their documented path is free.",
    );
  }
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
        `${sentenceOfSync(state)} — not walked: pass \`--commits <n>\` to replay every installed tool through ` +
          "its own documented refresh",
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
    row.tools["greplost"] = measured(
      minutes === null ? "$0" : `$0, ${round(minutes, 2)} min`,
      x3.target,
      "na",
      "the target is a ratio against ua and graphify; neither was walked here, so there is nothing to take a " +
        "ratio of. greplost's own cost is $0 (no model call in the structure layer)",
      minutes === null ? { usd: 0 } : { usd: 0, minutes: round(minutes, 3) },
    );
    method.push(
      "X3: greplost's USD is 0 by construction — the structure layer makes no model call, so there is no " +
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
 * `listStructurePaths` from `@greplost/sync` is the canonical list — INDEX.md,
 * manifest.json, graph/*.jsonl, repo/*.md, packages/*&#47;{MAP,API}.md and the module
 * cards — and excludes config.json, the semantic cache and the runtime files,
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
  row.tools["greplost"] = measured(
    `${ourDelta.lines} of ${ourDelta.total} lines`,
    plan.target,
    ourDelta.lines <= 10 ? "win" : "loss",
    ourDelta.lines <= 10
      ? ""
      : `${ourDelta.lines} artifact lines of ${ourDelta.total} changed across ${ourDelta.files} files for a ` +
        "one-line source change; the target is 10 lines",
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
      delta.lines <= ourDelta.lines
        ? ""
        : `${delta.lines} lines of ${delta.total} in the committed artifact changed for a one-line source change`,
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

  // Workspace mode is a capability probe, not a score: either the command exists
  // and answers across repos, or it does not exist yet.
  const fixture = path.join(REPO_ROOT, "fixtures", "two-repo-workspace");
  const workspaceCli = spawnSync("bun", [path.join(REPO_ROOT, "packages", "cli", "src", "main.ts"), "workspace", "--help"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  const hasCommand = workspaceCli.status === 0;
  const hasFixture = existsSync(fixture);
  row.tools["greplost"] = hasCommand && hasFixture
    ? measured("works", plan.target, "win", "")
    : na(
        plan.target,
        `workspace mode (tech spec 4.4) is not available in this checkout yet: ` +
          `${hasCommand ? "" : "`greplost workspace` is not a command"}${hasCommand || hasFixture ? "" : "; "}` +
          `${hasFixture ? "" : "the `two-repo-workspace` fixture does not exist"}`,
      );

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
