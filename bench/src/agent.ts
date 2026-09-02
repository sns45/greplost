/**
 * Eval 4: the agent navigation benchmark, A1 to A4 (tech spec 3, 10.6; also the
 * runner behind X7 and X8 in 10.0). Bench spec 1.5.6.
 *
 * One headless Claude Code session per (task, condition, run). The conditions
 * differ only in what is in the working copy and which tools the session may
 * use, so a difference in the numbers is a difference in the *map*, not in the
 * prompt: every condition sees the same prompt, byte for byte, and the answer
 * instruction is part of the task (see `tasks.ts`).
 *
 * Everything scored here is a set comparison or a timer (tech spec 10.1,
 * principle 1). There is no LLM judge: the prompt demands a fenced JSON block,
 * the runner takes the last one, and the score is exact match, set F1, or an
 * LCS ratio depending on the category.
 *
 * ## What was measured against the real CLI (2.1.258, recorded in the payload)
 *
 * `claude -p ... --output-format json` returns one object with `result` (the
 * answer text), `usage.{input_tokens,output_tokens,cache_creation_input_tokens,
 * cache_read_input_tokens}`, `num_turns`, `total_cost_usd`, `duration_ms` and
 * `is_error`. It carries **no tool-call count** - `num_turns` counts assistant
 * turns, not tool uses. `--output-format stream-json` does carry them (one
 * `assistant` message per `tool_use` block) but requires `--verbose` with
 * `--print`, and its last line is the same result envelope.
 *
 * So the runner probes once with `json`; the first time an envelope arrives
 * without a count it re-runs that one prompt with `stream-json` to fill the gap
 * and then stays on `stream-json`, which yields the count and the envelope from
 * a single call. That costs one extra session per suite run, not one per task.
 */
import { accessSync, constants as fsConstants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { compareStrings } from "@greplost/core/schema";

import { writeResult } from "./results-io.ts";
import { scoreSet } from "./score.ts";
import { loadTasks, type Task, type TaskCategory } from "./tasks.ts";
import { generateTsTruth, listTypeScriptFiles } from "./truth/ts.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const SUITE = "agent";

/**
 * The pinned model (tech spec 10.1, principle 3). Overridable with `--model`;
 * whatever ran is recorded in the results payload.
 */
export const DEFAULT_MODEL = "claude-opus-5";
/** Runs per task per condition. Tech spec 10.1 principle 5 requires N >= 5. */
const DEFAULT_RUNS = 5;
/** Structural tasks per repo. Tech spec 10.6 asks for 12 to 20 including flows. */
const DEFAULT_TASKS = 16;
/** A3's non-inferiority margin: greplost may sit at most 2 points below base. */
const A3_MARGIN = 0.02;
/** Ties in the win/loss/tie table are decided with this much float slack. */
const EPSILON = 1e-9;

/** Flags the runner depends on, confirmed against `claude --help` before any run. */
const REQUIRED_FLAGS = ["--print", "--model", "--output-format", "--allowedTools", "--disallowedTools", "--verbose"];

// ---------------------------------------------------------------------------
// conditions (tech spec 10.6)
// ---------------------------------------------------------------------------

/** What a condition puts in the working copy. */
type Artifacts = { kind: "none" } | { kind: "greplost" } | { kind: "competitor"; tool: string };

interface Condition {
  /** `--allowedTools` value, comma separated. */
  allowed: string[];
  /** `--disallowedTools` value; empty means the flag is not passed at all. */
  disallowed: string[];
  artifacts: Artifacts;
  note: string;
}

export const CONDITIONS: Readonly<Record<string, Condition>> = {
  base: { allowed: ["Read", "Grep", "Glob"], disallowed: [], artifacts: { kind: "none" }, note: "stock Claude Code" },
  gl: {
    allowed: ["Read", "Grep", "Glob"],
    disallowed: [],
    artifacts: { kind: "greplost" },
    note: "greplost map present (greplost init --no-hooks)",
  },
  "gl-strict": {
    allowed: ["Read"],
    disallowed: ["Grep", "Glob"],
    artifacts: { kind: "greplost" },
    note: "greplost map present, Grep/Glob disallowed: measures map sufficiency",
  },
  graphify: {
    allowed: ["Read", "Grep", "Glob"],
    disallowed: [],
    artifacts: { kind: "competitor", tool: "graphify" },
    note: "Graphify artifacts per its README",
  },
  ua: {
    allowed: ["Read", "Grep", "Glob"],
    disallowed: [],
    artifacts: { kind: "competitor", tool: "ua" },
    note: "Understand-Anything .ua/ artifacts; it has no query CLI, the agent reads them",
  },
  crg: {
    allowed: ["Read", "Grep", "Glob"],
    disallowed: [],
    artifacts: { kind: "competitor", tool: "crg" },
    note: "code-review-graph artifacts per its README",
  },
};

const CONDITION_ORDER = ["base", "gl", "gl-strict", "graphify", "ua", "crg"] as const;

// ---------------------------------------------------------------------------
// answers and scoring
// ---------------------------------------------------------------------------

/** A parsed agent answer. `symbols` is `[]` when the answer did not give any. */
export interface Answer {
  files: string[];
  symbols: string[];
}

/** One task's score, plus the detail the results file keeps. */
export interface TaskScore {
  /** The category's own metric: exact match, set F1, or LCS ratio. Always 0..1. */
  score: number;
  /**
   * `callers` only: set F1 over the enclosing symbol names, reported and never
   * scored. It is deliberately not folded into `score`, because the answer key
   * can only name the callers tsc attributed to a declaration: a call at a
   * file's top level contributes a file with no symbol, so a perfectly correct
   * answer can look incomplete here while its file set is exactly right.
   */
  symbolsF1: number | null;
  /** False when no JSON block could be found: scored 0, but for a different reason. */
  parsed: boolean;
}

/** Repo-relative posix form of whatever the agent wrote. */
export function normalizeAnswerPath(value: string, root?: string): string {
  let out = value.trim().replace(/\\/g, "/");
  if (root !== undefined) {
    const prefix = root.replace(/\\/g, "/").replace(/\/$/, "");
    if (out === prefix) return "";
    if (out.startsWith(`${prefix}/`)) out = out.slice(prefix.length + 1);
  }
  out = out.replace(/^\.\//, "").replace(/^\/+/, "");
  return out;
}

function stringList(value: unknown, root?: string): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = normalizeAnswerPath(entry, root);
    // Order is preserved (flow is scored on order) and duplicates dropped, so a
    // repeated file cannot pad an LCS.
    if (normalized !== "" && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function toAnswer(parsed: unknown, root?: string): Answer | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record["files"])) return null;
  return { files: stringList(record["files"], root), symbols: stringList(record["symbols"], root) };
}

/**
 * The last fenced JSON block of an answer, or the last bare JSON object when the
 * model forgot the fence.
 *
 * "Last" is deliberate: a session that reasons out loud often prints a first
 * guess and then corrects it, and the final block is the answer it stands behind.
 */
export function extractAnswer(text: string, root?: string): Answer | null {
  if (typeof text !== "string") return null;
  const fences = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const body = fences[i]?.[1];
    if (body === undefined) continue;
    try {
      const answer = toAnswer(JSON.parse(body.trim()), root);
      if (answer) return answer;
    } catch {
      // Not JSON: keep walking backwards through the fences.
    }
  }
  // No usable fence. Fall back to the balanced `{...}` objects in the prose,
  // last first. Balanced, not regex-matched: `{"files": [...], "meta": {...}}`
  // has a nested object, and a lazy `\{.*?\}` would cut it in half.
  const objects = balancedObjects(text);
  for (let i = objects.length - 1; i >= 0; i--) {
    try {
      const answer = toAnswer(JSON.parse(objects[i] as string), root);
      if (answer) return answer;
    } catch {
      // Keep walking.
    }
  }
  return null;
}

/** Every top-level `{...}` run in `text`, brace-balanced and string-aware. */
function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (char === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) out.push(text.slice(start, i + 1));
    }
  }
  return out;
}

/**
 * Longest-common-subsequence ratio, `2 * LCS / (|a| + |b|)`.
 *
 * Symmetric and in 0..1, so a flow answer is punished both for missing a step
 * and for inventing one, and an answer with the right files in the wrong order
 * scores far below one with them in the right order. Two empty lists match.
 */
export function lcsRatio(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? (previous[j - 1] ?? 0) + 1 : Math.max(previous[j] ?? 0, current[j - 1] ?? 0);
    }
    previous = current;
  }
  return (2 * (previous[b.length] ?? 0)) / (a.length + b.length);
}

/** The bare symbol name of whatever the agent wrote: `a.ts#C.m` -> `C.m`. */
function symbolName(value: string): string {
  const hash = value.lastIndexOf("#");
  return (hash === -1 ? value : value.slice(hash + 1)).trim();
}

/**
 * Score one answer against one task (tech spec 10.6).
 *
 * `definition` is an exact set match, because "where is X defined" has one right
 * answer and a partial credit would reward an agent that listed every file that
 * mentions the name. The other set categories are F1. `flow` is an LCS ratio,
 * because the ordering is the answer.
 *
 * `callers` is scored on its files - the same unit as the other set categories,
 * so the per-category numbers stay comparable - and the symbols are reported
 * beside it rather than folded in.
 */
export function scoreAnswer(task: Task, answer: Answer | null): TaskScore {
  if (answer === null) return { score: 0, symbolsF1: task.category === "callers" ? 0 : null, parsed: false };
  const truth = task.truth.files;
  // Normalised again here, not only in `extractAnswer`: a score must not depend
  // on who built the `Answer`, and the normalisation is idempotent.
  const files = stringList(answer.files);
  if (task.category === "definition") {
    const got = [...files].sort(compareStrings);
    const want = [...truth].sort(compareStrings);
    const exact = got.length === want.length && got.every((file, index) => file === want[index]);
    return { score: exact ? 1 : 0, symbolsF1: null, parsed: true };
  }
  if (task.category === "flow") {
    return { score: lcsRatio(files, truth), symbolsF1: null, parsed: true };
  }
  const score = scoreSet(files, truth).f1;
  if (task.category !== "callers") return { score, symbolsF1: null, parsed: true };
  const truthSymbols = task.truth.symbols ?? [];
  const symbolsF1 = scoreSet(answer.symbols.map(symbolName), truthSymbols).f1;
  return { score, symbolsF1, parsed: true };
}

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

/** Mean, median, population std, min and max of a sample (tech spec 10.1, 5). */
export interface Stats {
  n: number;
  mean: number;
  median: number;
  std: number;
  min: number;
  max: number;
}

export function summarize(values: number[]): Stats {
  if (values.length === 0) return { n: 0, mean: 0, median: 0, std: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / n;
  const middle = Math.floor(n / 2);
  const median = n % 2 === 1 ? (sorted[middle] as number) : (((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n;
  return { n, mean, median, std: Math.sqrt(variance), min: sorted[0] as number, max: sorted[n - 1] as number };
}

// ---------------------------------------------------------------------------
// the Claude Code CLI
// ---------------------------------------------------------------------------

/** What one `claude` invocation produced, after parsing. */
interface Session {
  answerText: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  numTurns: number;
  costUsd: number;
  /** Undefined when the envelope did not carry one; the stream transcript fills it. */
  toolCalls: number | undefined;
  wallMs: number;
  error: string | null;
}

function numberAt(record: Record<string, unknown> | undefined, key: string): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The tool-call count if the envelope has one. Claude Code 2.1.258 does not. */
function toolCallsInEnvelope(envelope: Record<string, unknown>): number | undefined {
  for (const key of ["num_tool_uses", "numToolUses", "tool_use_count", "toolUseCount"]) {
    const value = envelope[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readEnvelope(envelope: Record<string, unknown>, wallMs: number, toolCalls: number | undefined): Session {
  const usage = envelope["usage"] as Record<string, unknown> | undefined;
  const input = numberAt(usage, "input_tokens");
  const output = numberAt(usage, "output_tokens");
  const cacheRead = numberAt(usage, "cache_read_input_tokens");
  const cacheWrite = numberAt(usage, "cache_creation_input_tokens");
  const result = envelope["result"];
  const failed = envelope["is_error"] === true || (envelope["subtype"] !== undefined && envelope["subtype"] !== "success");
  return {
    answerText: typeof result === "string" ? result : "",
    tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
    numTurns: numberAt(envelope, "num_turns"),
    costUsd: numberAt(envelope, "total_cost_usd"),
    toolCalls: toolCalls ?? toolCallsInEnvelope(envelope),
    wallMs,
    error: failed ? String(envelope["subtype"] ?? "error") : null,
  };
}

/** The `--output-format json` payload: one object, possibly with leading noise. */
function parseJsonOutput(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    // Fall through to the line scan: a warning on stdout must not lose the result.
  }
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed: unknown = JSON.parse(lines[i] as string);
      if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
    } catch {
      // Keep walking backwards.
    }
  }
  return null;
}

/**
 * The `--output-format stream-json` transcript: the final `result` envelope plus
 * the tool-call count, taken as one `tool_use` content block = one tool call.
 */
function parseStreamOutput(stdout: string): { envelope: Record<string, unknown> | null; toolCalls: number } {
  let envelope: Record<string, unknown> | null = null;
  let toolCalls = 0;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const event = parsed as Record<string, unknown>;
    if (event["type"] === "result") envelope = event;
    if (event["type"] !== "assistant") continue;
    const message = event["message"] as Record<string, unknown> | undefined;
    const content = message?.["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block === "object" && block !== null && (block as Record<string, unknown>)["type"] === "tool_use") {
        toolCalls++;
      }
    }
  }
  return { envelope, toolCalls };
}

/**
 * The `claude` binary, resolved from `PATH` *now* rather than left to the
 * spawner.
 *
 * Two reasons, and the second one is the important one. Bun's `spawnSync`
 * resolves a bare command name against the PATH the process started with, not
 * against the current `process.env.PATH`, so a test that prepends a directory
 * of fakes would still reach the real CLI and spend real money. Every spawn
 * below therefore takes an absolute path *and* an explicit `env`.
 */
export function resolveClaude(): string {
  const entries = (process.env["PATH"] ?? "").split(path.delimiter).filter((entry) => entry !== "");
  for (const entry of entries) {
    const candidate = path.join(entry, "claude");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable: keep looking.
    }
  }
  return "claude";
}

/** Spawn options shared by every child process: current PATH, generous buffer. */
function spawnOptions(cwd: string): { cwd: string; encoding: "utf8"; env: NodeJS.ProcessEnv; maxBuffer: number } {
  return {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
    // A stream-json transcript of a long session is large; the 1MB default truncates it.
    maxBuffer: 128 * 1024 * 1024,
  };
}

interface Invocation {
  cwd: string;
  prompt: string;
  model: string;
  condition: Condition;
  stream: boolean;
}

function claudeArgs(invocation: Invocation): string[] {
  const args = [
    "-p",
    invocation.prompt,
    "--model",
    invocation.model,
    "--output-format",
    invocation.stream ? "stream-json" : "json",
    "--allowedTools",
    invocation.condition.allowed.join(","),
  ];
  // `--print` with `stream-json` is rejected without `--verbose` (measured on 2.1.258).
  if (invocation.stream) args.push("--verbose");
  if (invocation.condition.disallowed.length > 0) {
    args.push("--disallowedTools", invocation.condition.disallowed.join(","));
  }
  return args;
}

/** One headless session. Never throws: a failed run is a recorded zero, not a crash. */
function invokeClaude(invocation: Invocation): Session {
  const started = Date.now();
  const spawned = spawnSync(resolveClaude(), claudeArgs(invocation), spawnOptions(invocation.cwd));
  const wallMs = Date.now() - started;
  const empty: Session = {
    answerText: "",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    numTurns: 0,
    costUsd: 0,
    toolCalls: invocation.stream ? 0 : undefined,
    wallMs,
    error: null,
  };
  if (spawned.error) return { ...empty, error: spawned.error.message };
  const stdout = spawned.stdout ?? "";
  if (invocation.stream) {
    const { envelope, toolCalls } = parseStreamOutput(stdout);
    if (envelope === null) return { ...empty, toolCalls, error: `no result envelope (exit ${spawned.status})` };
    return readEnvelope(envelope, wallMs, toolCalls);
  }
  const envelope = parseJsonOutput(stdout);
  if (envelope === null) return { ...empty, error: `no result envelope (exit ${spawned.status})` };
  return readEnvelope(envelope, wallMs, undefined);
}

/** `claude --version`, or null when the binary is not on PATH. */
function claudeVersion(): string | null {
  const spawned = spawnSync(resolveClaude(), ["--version"], spawnOptions(REPO_ROOT));
  if (spawned.error || spawned.status !== 0) return null;
  return (spawned.stdout ?? "").trim() || null;
}

/**
 * Confirm the flag names against the installed CLI before spending anything
 * (tech spec 10.6: "confirm flag names against the current Claude Code CLI
 * reference before first run"). Returns the flags `claude --help` did not
 * mention; empty means every flag the runner uses exists.
 */
function confirmFlags(): { missing: string[]; help: boolean } {
  const spawned = spawnSync(resolveClaude(), ["--help"], spawnOptions(REPO_ROOT));
  if (spawned.error) return { missing: [...REQUIRED_FLAGS], help: false };
  const help = `${spawned.stdout ?? ""}${spawned.stderr ?? ""}`;
  return { missing: REQUIRED_FLAGS.filter((flag) => !help.includes(flag)), help: true };
}

// ---------------------------------------------------------------------------
// working copies
// ---------------------------------------------------------------------------

/** Directories never copied into a condition's working copy. */
const SKIP_COPY = new Set([".git", "node_modules", ".greplost", "dist", "build"]);

function copyRepo(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  cpSync(from, to, {
    recursive: true,
    // `.greplost/` is excluded on purpose: the `gl` conditions build their own
    // and `base` must never inherit one from a dirty checkout.
    filter: (source) => !SKIP_COPY.has(path.basename(source)),
  });
}

/** The bun (or node) that is running this suite, for spawning the greplost CLI. */
function runtimeBinary(): string {
  return process.versions["bun"] === undefined ? "bun" : process.execPath;
}

function runGreplostInit(root: string): string | null {
  const main = path.join(REPO_ROOT, "packages", "cli", "src", "main.ts");
  const spawned = spawnSync(runtimeBinary(), [main, "init", "--no-hooks", "--root", root], spawnOptions(REPO_ROOT));
  if (spawned.error) return spawned.error.message;
  if (spawned.status !== 0) return `greplost init exited ${spawned.status}: ${(spawned.stderr ?? "").trim()}`;
  return null;
}

interface CompetitorTool {
  name: string;
  version?: string;
  artifactPaths?: string[];
}

function competitorArtifactPaths(tool: string): string[] {
  const file = path.join(REPO_ROOT, "bench", "competitors.json");
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { tools?: CompetitorTool[] };
  return (parsed.tools ?? []).find((entry) => entry.name === tool)?.artifactPaths ?? [];
}

/**
 * Install a competitor's artifacts into the working copy from
 * `bench/.competitors/<tool>/<repo>/`, which is where its README's own commands
 * were run at the pinned version. Returns the reason the condition cannot run,
 * or null when it can.
 *
 * A missing directory is never silently scored as 0: tech spec 10.0 requires an
 * absent capability to read N/A, with the reason published.
 */
function installCompetitor(tool: string, repo: string, copy: string): string | null {
  const source = path.join(REPO_ROOT, "bench", ".competitors", tool, repo);
  if (!existsSync(source)) {
    return `no artifacts at bench/.competitors/${tool}/${repo}; run ${tool}'s own install and run commands from bench/competitors.json at its pinned version first`;
  }
  const wanted = competitorArtifactPaths(tool).filter((artifact) => !artifact.startsWith("~"));
  let copied = 0;
  for (const artifact of wanted) {
    const from = path.join(source, artifact);
    if (!existsSync(from)) continue;
    const to = path.join(copy, artifact);
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
    copied++;
  }
  if (copied === 0) {
    return `bench/.competitors/${tool}/${repo} exists but holds none of ${tool}'s artifact paths from bench/competitors.json`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// arguments and targets
// ---------------------------------------------------------------------------

interface Options {
  fixture: boolean;
  repo: string | undefined;
  conditions: string[];
  runs: number;
  model: string;
  tasks: number;
  seed: number;
  dryRun: boolean;
  gate: boolean;
  keep: boolean;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    fixture: false,
    repo: undefined,
    conditions: [],
    runs: DEFAULT_RUNS,
    model: DEFAULT_MODEL,
    tasks: DEFAULT_TASKS,
    seed: 1,
    dryRun: false,
    gate: false,
    keep: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Unknown flags are ignored: `bench all` forwards one argument list to every suite.
    if (arg === "--fixture") options.fixture = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--gate") options.gate = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--repo") options.repo = args[++i];
    else if (arg === "--model") options.model = args[++i] ?? DEFAULT_MODEL;
    else if (arg === "--condition") options.conditions.push(...(args[++i] ?? "").split(",").filter((c) => c !== ""));
    else if (arg === "--runs") options.runs = Number.parseInt(args[++i] ?? "", 10) || DEFAULT_RUNS;
    else if (arg === "--tasks") options.tasks = Number.parseInt(args[++i] ?? "", 10) || DEFAULT_TASKS;
    else if (arg === "--seed") options.seed = Number.parseInt(args[++i] ?? "", 10) || 1;
  }
  if (options.conditions.length === 0) options.conditions.push("base", "gl");
  // De-duplicated and put in table order, so the results file is stable whatever
  // order the flags arrived in.
  const wanted = new Set(options.conditions);
  options.conditions = CONDITION_ORDER.filter((name) => wanted.has(name));
  for (const name of wanted) {
    if (!(name in CONDITIONS)) throw new Error(`unknown condition "${name}" (expected ${CONDITION_ORDER.join(", ")})`);
  }
  return options;
}

interface Target {
  name: string;
  root: string;
  sha: string | null;
}

interface CorpusRepo {
  name: string;
  sha?: string;
  lang?: string;
}

function resolveTarget(options: Options): Target {
  if (options.fixture) return { name: "tiny-ts", root: path.join(REPO_ROOT, "fixtures", "tiny-ts"), sha: null };
  if (options.repo === undefined) {
    throw new Error("pass --repo <name> (a TypeScript repo in bench/corpus.json) or --fixture");
  }
  const file = path.join(REPO_ROOT, "bench", "corpus.json");
  if (!existsSync(file)) throw new Error("bench/corpus.json is missing; run `bun bench/src/cli.ts corpus setup`");
  const corpus = JSON.parse(readFileSync(file, "utf8")) as { repos?: CorpusRepo[] };
  const entry = (corpus.repos ?? []).find((repo) => repo.name === options.repo);
  if (!entry) throw new Error(`unknown repo "${options.repo}" in bench/corpus.json`);
  if ((entry.lang ?? "ts") !== "ts") {
    throw new Error(`repo "${entry.name}" is ${entry.lang}; Eval 4 tasks are generated from the TypeScript truth only`);
  }
  const root = path.join(REPO_ROOT, "bench", ".corpus", entry.name);
  if (!existsSync(root)) {
    throw new Error(`${root} is missing; run \`bun bench/src/cli.ts corpus setup --repo ${entry.name}\``);
  }
  return { name: entry.name, root, sha: entry.sha ?? null };
}

function buildTasks(target: Target, options: Options): Task[] {
  const files = listTypeScriptFiles(target.root);
  // `Truth.files` is the scored universe: tasks are only ever about files the
  // compiler actually loaded, so an answer key can never name a file that is not
  // in the same universe Eval 1 scores over.
  const truth = generateTsTruth(target.root, files);
  return loadTasks(target.name, truth, options.tasks, options.seed);
}

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

/** One (task, condition, run). Every field is measured; none is derived later. */
interface RunRecord {
  taskId: string;
  category: TaskCategory;
  condition: string;
  run: number;
  score: number;
  symbolsF1: number | null;
  parsed: boolean;
  tokens: Session["tokens"];
  toolCalls: number;
  /**
   * True when this record's `toolCalls` came from a *separate* stream-json
   * session for the same prompt rather than from the session that produced its
   * tokens, cost and wall clock (see the tool-call probe in the file header).
   * At most one record per suite run carries it; it is written down because a
   * count that came from a different sample must not be read as if it did not.
   */
  toolCallsFromProbe: boolean;
  numTurns: number;
  wallMs: number;
  costUsd: number;
  error: string | null;
}

interface MetricBlock {
  accuracy: Stats;
  tokens: Stats;
  toolCalls: Stats;
  wallMs: Stats;
  costUsd: Stats;
  /** Total USD across the sample, so a reader never has to multiply mean by n. */
  costUsdTotal: number;
  /**
   * Sessions the CLI itself failed (no envelope, non-zero exit, a crash). They
   * stay in the accuracy sample - an answer that never arrived is not a correct
   * one - but they are counted separately so a run wrecked by a broken CLI
   * cannot be read as a run where the agent navigated badly.
   */
  errors: number;
  /** Sessions whose answer carried no parseable JSON block. */
  unparsed: number;
}

function block(records: RunRecord[]): MetricBlock {
  const costUsd = summarize(records.map((r) => r.costUsd));
  return {
    accuracy: summarize(records.map((r) => r.score)),
    tokens: summarize(records.map((r) => r.tokens.total)),
    toolCalls: summarize(records.map((r) => r.toolCalls)),
    wallMs: summarize(records.map((r) => r.wallMs)),
    costUsd,
    costUsdTotal: records.reduce((sum, record) => sum + record.costUsd, 0),
    errors: records.filter((record) => record.error !== null).length,
    unparsed: records.filter((record) => !record.parsed).length,
  };
}

function aggregate(records: RunRecord[], conditions: string[]): Record<string, Record<string, MetricBlock>> {
  const out: Record<string, Record<string, MetricBlock>> = {};
  for (const condition of conditions) {
    const mine = records.filter((record) => record.condition === condition);
    if (mine.length === 0) continue;
    const byCategory: Record<string, MetricBlock> = { overall: block(mine) };
    for (const category of [...new Set(mine.map((r) => r.category))].sort(compareStrings)) {
      byCategory[category] = block(mine.filter((record) => record.category === category));
    }
    out[condition] = byCategory;
  }
  return out;
}

/** Mean accuracy per task for one condition. */
function perTaskAccuracy(records: RunRecord[], condition: string): Map<string, number> {
  const sums = new Map<string, number[]>();
  for (const record of records) {
    if (record.condition !== condition) continue;
    sums.set(record.taskId, [...(sums.get(record.taskId) ?? []), record.score]);
  }
  return new Map([...sums].map(([id, scores]) => [id, summarize(scores).mean]));
}

interface WinLossTie {
  wins: number;
  losses: number;
  ties: number;
}

/** Per-task win/loss/tie against `base`, for every other condition that ran. */
function winLossTie(records: RunRecord[], conditions: string[]): Record<string, WinLossTie> {
  if (!conditions.includes("base")) return {};
  const baseline = perTaskAccuracy(records, "base");
  const out: Record<string, WinLossTie> = {};
  for (const condition of conditions) {
    if (condition === "base") continue;
    const mine = perTaskAccuracy(records, condition);
    if (mine.size === 0) continue;
    const tally: WinLossTie = { wins: 0, losses: 0, ties: 0 };
    for (const [taskId, score] of mine) {
      const reference = baseline.get(taskId);
      if (reference === undefined) continue;
      if (score > reference + EPSILON) tally.wins++;
      else if (score < reference - EPSILON) tally.losses++;
      else tally.ties++;
    }
    out[condition] = tally;
  }
  return out;
}

/** What the extra tool-call probe sessions cost, over and above the measured runs. */
interface Probe {
  sessions: number;
  costUsd: number;
  tokens: number;
  wallMs: number;
}

/** The parts of a payload a real run fills in and a dry run leaves empty. */
interface PayloadParts {
  machine: unknown;
  claudeVersion: string | null;
  cli: Record<string, unknown> | null;
  conditions: string[];
  unavailable: Record<string, string>;
  tasks: Task[];
  runs: RunRecord[];
  aggregate: Record<string, Record<string, MetricBlock>>;
  winLossTie: Record<string, WinLossTie>;
  probe: Probe;
  gate: { passed: boolean; missed: string[] } | null;
}

/**
 * The results payload. One builder for the real run and the dry run, so
 * `--dry-run` cannot advertise a shape the real thing does not write - which is
 * the only thing a dry run is for.
 */
function buildPayload(target: Target, options: Options, parts: PayloadParts): Record<string, unknown> {
  return {
    corpus: [target.sha === null ? { name: target.name } : { name: target.name, sha: target.sha }],
    machine: parts.machine,
    model: options.model,
    claudeVersion: parts.claudeVersion,
    cli: parts.cli,
    seed: options.seed,
    runsPerTask: options.runs,
    conditions: parts.conditions,
    conditionNotes: Object.fromEntries(parts.conditions.map((name) => [name, (CONDITIONS[name] as Condition).note])),
    conditionTools: Object.fromEntries(
      parts.conditions.map((name) => {
        const condition = CONDITIONS[name] as Condition;
        return [name, { allowedTools: condition.allowed, disallowedTools: condition.disallowed }];
      }),
    ),
    unavailable: parts.unavailable,
    tasks: parts.tasks,
    runs: parts.runs,
    aggregate: parts.aggregate,
    winLossTie: parts.winLossTie,
    toolCallProbe: parts.probe,
    gate: parts.gate,
  };
}

/** The optional machine profile, loaded the way the other suites load it. */
async function loadMachine(): Promise<unknown> {
  const specifier = "./machine.ts";
  try {
    const mod = (await import(specifier)) as Partial<{ machineProfile: () => unknown }>;
    return typeof mod.machineProfile === "function" ? mod.machineProfile() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

function num(value: number, digits: number = 3): string {
  return value.toFixed(digits);
}

function printAggregate(table: Record<string, Record<string, MetricBlock>>): void {
  for (const [condition, categories] of Object.entries(table)) {
    console.log(`${SUITE}: ${condition}`);
    console.log(
      "  category      n   accuracy(mean/med/std)   tokens(med)  tools(mean)  wall ms(med)  cost USD  err/unparsed",
    );
    for (const [category, metrics] of Object.entries(categories)) {
      const accuracy = `${num(metrics.accuracy.mean)}/${num(metrics.accuracy.median)}/${num(metrics.accuracy.std)}`;
      console.log(
        `  ${category.padEnd(13)}${String(metrics.accuracy.n).padEnd(4)}${accuracy.padEnd(25)}` +
          `${String(Math.round(metrics.tokens.median)).padEnd(13)}${num(metrics.toolCalls.mean, 2).padEnd(13)}` +
          `${String(Math.round(metrics.wallMs.median)).padEnd(14)}${num(metrics.costUsdTotal, 4).padEnd(10)}` +
          `${metrics.errors}/${metrics.unparsed}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export async function run(args: string[]): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(args);
  } catch (err) {
    console.error(`${SUITE}: ${(err as Error).message}`);
    return 2;
  }
  warnOnRedirectedResults();
  try {
    return await execute(options);
  } catch (err) {
    // Nothing below the argument parser may escape: `run` always returns a code.
    console.error(`${SUITE}: ${(err as Error).message}`);
    if (options.gate) console.log(`${SUITE}: GATE FAIL (error)`);
    return 1;
  }
}

/**
 * `GREPLOST_BENCH_RESULTS_DIR` is a test-only escape hatch (see `results-io.ts`).
 * A real run that silently wrote its results elsewhere would be worse than one
 * that did not run.
 */
function warnOnRedirectedResults(): void {
  const override = process.env["GREPLOST_BENCH_RESULTS_DIR"];
  if (!override || process.env["NODE_ENV"] === "test") return;
  console.error(
    `${SUITE}: warning: GREPLOST_BENCH_RESULTS_DIR is set, so results go to ${override} ` +
      "instead of bench/results/; that override is meant for tests only",
  );
}

async function execute(options: Options): Promise<number> {
  const target = resolveTarget(options);

  if (options.dryRun) return dryRun(target, options);

  const flags = confirmFlags();
  if (!flags.help) {
    console.error(`${SUITE}: no \`claude\` on PATH; Eval 4 needs the Claude Code CLI`);
    return 1;
  }
  if (flags.missing.length > 0) {
    console.error(
      `${SUITE}: \`claude --help\` does not mention ${flags.missing.join(", ")}; ` +
        "the CLI surface changed and the runner would be measuring the wrong thing",
    );
    return 1;
  }

  const tasks = buildTasks(target, options);
  if (tasks.length === 0) {
    console.error(`${SUITE}: no tasks for ${target.name}`);
    return 1;
  }

  const version = claudeVersion();
  const work = mkdtempSync(path.join(tmpdir(), "greplost-agent-"));
  const records: RunRecord[] = [];
  const unavailable: Record<string, string> = {};
  const ran: string[] = [];
  // What the tool-call probe cost on top of the measured sessions. Kept apart
  // from the run records - it is the harness's overhead, not the task's price -
  // but recorded, because an unreported dollar is an unreported dollar.
  const probe: Probe = { sessions: 0, costUsd: 0, tokens: 0, wallMs: 0 };
  // Sticky: the first envelope without a tool-call count switches the whole run
  // to stream-json, which carries the count and the envelope in one call.
  let stream = false;

  try {
    for (const name of options.conditions) {
      const condition = CONDITIONS[name] as Condition;
      const copy = path.join(work, name);
      copyRepo(target.root, copy);

      const reason = prepare(condition, target, copy);
      if (reason !== null) {
        unavailable[name] = reason;
        console.log(`${SUITE}: ${name}: N/A (${reason})`);
        rmSync(copy, { recursive: true, force: true });
        continue;
      }
      ran.push(name);

      for (const task of tasks) {
        for (let index = 0; index < options.runs; index++) {
          const invocation: Invocation = {
            cwd: copy,
            prompt: task.prompt,
            model: options.model,
            condition,
            stream,
          };
          let session = invokeClaude(invocation);
          const probed = session.toolCalls === undefined;
          if (session.toolCalls === undefined) {
            // The measured case on Claude Code 2.1.258: no count in the JSON
            // envelope. Pay for one extra session to learn the count for this
            // prompt, then stay on stream-json for everything after it.
            const transcript = invokeClaude({ ...invocation, stream: true });
            session = { ...session, toolCalls: transcript.toolCalls ?? 0 };
            probe.sessions++;
            probe.costUsd += transcript.costUsd;
            probe.tokens += transcript.tokens.total;
            probe.wallMs += transcript.wallMs;
            stream = true;
          }
          const answer = extractAnswer(session.answerText, copy);
          const scored = scoreAnswer(task, answer);
          records.push({
            taskId: task.id,
            category: task.category,
            condition: name,
            run: index + 1,
            score: scored.score,
            symbolsF1: scored.symbolsF1,
            parsed: scored.parsed,
            tokens: session.tokens,
            toolCalls: session.toolCalls ?? 0,
            toolCallsFromProbe: probed,
            numTurns: session.numTurns,
            wallMs: session.wallMs,
            costUsd: session.costUsd,
            error: session.error,
          });
        }
      }
    }
  } finally {
    if (!options.keep) rmSync(work, { recursive: true, force: true });
    else console.log(`${SUITE}: kept the working copies at ${work}`);
  }

  if (ran.length === 0) {
    // Every condition was N/A. A results file of zeroes under today's date would
    // be indistinguishable from a real regression, so nothing is written.
    console.error(`${SUITE}: no condition could run; nothing measured, no results written`);
    if (options.gate) console.log(`${SUITE}: GATE FAIL (no-conditions)`);
    return 1;
  }

  const table = aggregate(records, ran);
  printAggregate(table);

  const gate = options.gate ? a3Gate(table) : null;
  writeResult(
    SUITE,
    buildPayload(target, options, {
      machine: await loadMachine(),
      claudeVersion: version,
      cli: {
        command: "claude",
        outputFormat: stream ? "stream-json" : "json",
        streamJsonFallback: stream,
        confirmedFlags: REQUIRED_FLAGS,
        toolCallSource: stream ? "stream-json transcript tool_use blocks" : "json envelope",
      },
      conditions: ran,
      unavailable,
      tasks,
      runs: records,
      aggregate: table,
      winLossTie: winLossTie(records, ran),
      probe,
      gate,
    }),
  );

  if (!options.gate) return 0;
  if (gate === null || gate.passed) {
    console.log(`${SUITE}: GATE PASS`);
    return 0;
  }
  console.log(`${SUITE}: GATE FAIL (${gate.missed.join(",")})`);
  return 1;
}

/** Put the condition's artifacts in the copy. Returns the N/A reason, or null. */
function prepare(condition: Condition, target: Target, copy: string): string | null {
  if (condition.artifacts.kind === "none") return null;
  if (condition.artifacts.kind === "greplost") return runGreplostInit(copy);
  return installCompetitor(condition.artifacts.tool, target.name, copy);
}

/**
 * A3: greplost's overall accuracy must not sit more than two points below the
 * baseline's (tech spec 3, 10.6). Reported as `null` when the run did not
 * include both `base` and a greplost condition, because there is nothing to
 * compare and a vacuous pass would be a lie.
 */
function a3Gate(table: Record<string, Record<string, MetricBlock>>): { passed: boolean; missed: string[] } | null {
  const baseline = table["base"]?.["overall"]?.accuracy.mean;
  const measured = table["gl"]?.["overall"]?.accuracy.mean;
  if (baseline === undefined || measured === undefined) return null;
  const passed = measured >= baseline - A3_MARGIN - EPSILON;
  return { passed, missed: passed ? [] : ["A3"] };
}

/**
 * `--dry-run`: the payload shape with zero runs, and no `claude` invoked.
 *
 * It does not write a results file. A dry run's numbers are all zero, and a zero
 * committed under today's date would be indistinguishable from a real regression.
 */
function dryRun(target: Target, options: Options): number {
  let tasks: Task[] = [];
  try {
    tasks = buildTasks(target, options);
  } catch (err) {
    console.error(`${SUITE}: could not build tasks for ${target.name}: ${(err as Error).message}`);
  }
  const payload = {
    // `writeResult` stamps `suite`, `date` and `greplostSha` onto every payload;
    // they are named here so the dry run advertises the whole shape.
    suite: SUITE,
    date: null,
    greplostSha: null,
    ...buildPayload(target, options, {
      machine: null,
      claudeVersion: null,
      cli: null,
      conditions: options.conditions,
      unavailable: {},
      tasks,
      runs: [],
      aggregate: {},
      winLossTie: {},
      probe: { sessions: 0, costUsd: 0, tokens: 0, wallMs: 0 },
      gate: null,
    }),
  };
  console.log(`${SUITE}: ${target.name}, ${options.conditions.join(", ")}, ${options.runs} runs per task`);
  console.log(`${SUITE}: payload keys: ${Object.keys(payload).sort(compareStrings).join(", ")}`);
  for (const task of tasks) console.log(`  ${task.id}  ${task.category.padEnd(13)}${task.truth.files.length} files`);
  console.log(`${SUITE}: ${tasks.length} tasks, 0 runs (dry run writes no results file)`);
  console.log(`${SUITE}: dry-run ok`);
  return 0;
}
