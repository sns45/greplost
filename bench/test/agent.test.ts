/**
 * Leaf 1.5.6: Eval 4, the agent navigation benchmark (tech spec 10.6, A1 to A4).
 *
 * Three things are tested and nothing else is: task generation from compiler
 * truth, the deterministic scorers, and the runner's envelope handling driven by
 * a fake `claude` binary. The real `claude` is never invoked from a test.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateTsTruth, listTypeScriptFiles, type Truth } from "../src/truth/ts.ts";
import {
  ANSWER_FILES,
  ANSWER_FILES_AND_SYMBOLS,
  generateStructuralTasks,
  loadFlowTasks,
  loadOrientationTasks,
  loadTasks,
  type Task,
  type TaskCategory,
} from "../src/tasks.ts";
import {
  extractAnswer,
  lcsRatio,
  normalizeAnswerPath,
  resolveClaude,
  run,
  runTask,
  scoreAnswer,
  summarize,
} from "../src/agent.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const FIXTURE = path.join(REPO_ROOT, "fixtures", "tiny-ts");

/** Compiler truth for `fixtures/tiny-ts`, built once for every describe below. */
let fixtureTruth: Truth;

beforeAll(() => {
  fixtureTruth = generateTsTruth(FIXTURE, listTypeScriptFiles(FIXTURE));
});

/** The one task of `category` whose prompt mentions `needle`. */
function about(tasks: Task[], category: string, needle: string): Task {
  const found = tasks.filter((task) => task.category === category && task.prompt.includes(needle));
  if (found.length !== 1) {
    throw new Error(`expected 1 ${category} task about ${needle}, got ${found.length}`);
  }
  return found[0] as Task;
}

describe("tasks", () => {
  test("splits n across the four structural categories with stable ids", () => {
    const tasks = generateStructuralTasks("tiny-ts", fixtureTruth, 8);
    expect(tasks).toHaveLength(8);
    expect(tasks.map((task) => task.id)).toEqual([
      "tiny-ts-def-01",
      "tiny-ts-def-02",
      "tiny-ts-imp-01",
      "tiny-ts-imp-02",
      "tiny-ts-call-01",
      "tiny-ts-call-02",
      "tiny-ts-blast-01",
      "tiny-ts-blast-02",
    ]);
    expect(tasks.map((task) => task.category)).toEqual([
      "definition",
      "definition",
      "importers",
      "importers",
      "callers",
      "callers",
      "blast_radius",
      "blast_radius",
    ]);
  });

  test("is deterministic for a seed and moves with the seed", () => {
    const a = generateStructuralTasks("tiny-ts", fixtureTruth, 8);
    const b = generateStructuralTasks("tiny-ts", fixtureTruth, 8);
    expect(b).toEqual(a);

    const other = generateStructuralTasks("tiny-ts", fixtureTruth, 8, 7);
    expect(other.map((task) => task.id)).toEqual(a.map((task) => task.id));
    // Same ids, different subjects: the ids are positions, the seed picks the subjects.
    expect(other.map((task) => task.prompt)).not.toEqual(a.map((task) => task.prompt));
  });

  test("every prompt ends with the exact answer instruction", () => {
    const tasks = generateStructuralTasks("tiny-ts", fixtureTruth, 200);
    expect(tasks.length).toBeGreaterThan(8);
    for (const task of tasks) {
      const expected = task.category === "callers" ? ANSWER_FILES_AND_SYMBOLS : ANSWER_FILES;
      expect(task.prompt.endsWith(expected)).toBe(true);
    }
    expect(ANSWER_FILES).toBe('Answer with a JSON block {"files": [...]}');
    expect(ANSWER_FILES_AND_SYMBOLS).toBe('Answer with a JSON block {"files": [...], "symbols": [...]}');
  });

  test("definition truth is the declaring file", () => {
    const tasks = generateStructuralTasks("tiny-ts", fixtureTruth, 200);
    expect(about(tasks, "definition", "`retry`").truth.files).toEqual(["packages/core/src/retry.ts"]);
    expect(about(tasks, "definition", "`Registry`").truth.files).toEqual(["packages/core/src/registry.ts"]);
    expect(about(tasks, "definition", "`formatEvent`").truth.files).toEqual(["packages/core/src/events.ts"]);
  });

  test("importers truth is the direct importers from the truth graph", () => {
    const tasks = generateStructuralTasks("tiny-ts", fixtureTruth, 200);
    expect(about(tasks, "importers", "packages/core/src/types.ts").truth.files).toEqual([
      "packages/core/src/bus.ts",
      "packages/core/src/index.ts",
      "packages/core/src/queue.ts",
    ]);
    expect(about(tasks, "importers", "packages/core/src/retry.ts").truth.files).toEqual([
      "packages/core/src/index.ts",
      "packages/core/src/registry.ts",
    ]);
  });

  test("callers truth is the calling files and their enclosing symbols", () => {
    const tasks = generateStructuralTasks("tiny-ts", fixtureTruth, 200);
    const task = about(tasks, "callers", "`retry`");
    expect(task.truth.files).toEqual(["packages/adapters/src/sqs.ts", "packages/core/src/registry.ts"]);
    expect(task.truth.symbols).toEqual(["Registry.publishAll", "SqsAdapter.publish"]);
    expect(task.prompt).toContain("packages/core/src/retry.ts");
  });

  test("blast_radius truth is the cycle-safe reverse import closure", () => {
    const tasks = generateStructuralTasks("tiny-ts", fixtureTruth, 200);
    expect(about(tasks, "blast_radius", "packages/core/src/retry.ts").truth.files).toEqual([
      "apps/worker/src/main.ts",
      "packages/adapters/src/index.ts",
      "packages/adapters/src/memory.ts",
      "packages/adapters/src/sqs.ts",
      "packages/core/src/index.ts",
      "packages/core/src/registry.ts",
    ]);
    // bus <-> events is a cycle in the fixture: the closure must terminate and
    // must not contain the subject itself.
    const bus = about(tasks, "blast_radius", "packages/core/src/bus.ts");
    expect(bus.truth.files).toEqual([
      "apps/worker/src/main.ts",
      "packages/adapters/src/index.ts",
      "packages/adapters/src/memory.ts",
      "packages/adapters/src/sqs.ts",
      "packages/core/src/events.ts",
      "packages/core/src/index.ts",
      "packages/core/src/registry.ts",
    ]);
  });

  test("every truth file is inside the truth universe and never the subject", () => {
    const universe = new Set(fixtureTruth.files);
    for (const task of generateStructuralTasks("tiny-ts", fixtureTruth, 200)) {
      expect(task.truth.files.length).toBeGreaterThan(0);
      for (const file of task.truth.files) expect(universe.has(file)).toBe(true);
      expect(task.truth_source).toContain("tsc");
      // A callers prompt asks for symbols, so a callers task must have some: the
      // fixture's top-level call into `main` is not a task.
      if (task.category === "callers") expect((task.truth.symbols ?? []).length).toBeGreaterThan(0);
      else expect(task.truth.symbols).toBeUndefined();
    }
    // `main` is only ever called from its own file's top level, so it is a
    // definition subject but never a callers subject.
    const tasks = generateStructuralTasks("tiny-ts", fixtureTruth, 200);
    expect(tasks.some((task) => task.category === "definition" && task.prompt.includes("`main`"))).toBe(true);
    expect(tasks.some((task) => task.category === "callers" && task.prompt.includes("`main`"))).toBe(false);
  });

  test("asks for at most the number of candidates the truth can supply", () => {
    const empty: Truth = { files: [], imports: [], exports: {}, calls: [], cycles: [], notes: [] };
    expect(generateStructuralTasks("void", empty, 12)).toEqual([]);
  });

  test("loads the curated flow tasks for hono and anyq", () => {
    for (const repo of ["hono", "anyq"]) {
      const tasks = loadFlowTasks(repo);
      expect(tasks.length).toBeGreaterThanOrEqual(3);
      for (const task of tasks) {
        expect(task.category).toBe("flow");
        expect(task.id.startsWith(`${repo}-flow-`)).toBe(true);
        expect(task.truth.files.length).toBeGreaterThanOrEqual(2);
        expect(task.truth_source).toContain("hand-curated");
        expect(task.prompt.endsWith(ANSWER_FILES)).toBe(true);
      }
      expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
    }
    expect(loadFlowTasks("no-such-repo")).toEqual([]);
  });

  test("loads the curated orientation task for hono and anyq", () => {
    for (const repo of ["hono", "anyq"]) {
      const tasks = loadOrientationTasks(repo);
      expect(tasks.length).toBeGreaterThanOrEqual(1);
      for (const task of tasks) {
        expect(task.category).toBe("orientation");
        expect(task.id.startsWith(`${repo}-orientation-`)).toBe(true);
        // X8's prompt is fixed wording; the answer shape must still be in it.
        expect(task.prompt).toContain('{"files": [...]}');
        expect(task.truth.files.length).toBeGreaterThanOrEqual(5);
        expect(task.truth_source).toContain("hand-curated");
        // The key has to come from a stated rule, not from taste.
        expect(task.truth_source).toContain("Curation rule");
      }
    }
    expect(loadOrientationTasks("no-such-repo")).toEqual([]);
  });

  test("a curated file with a duplicate id or a foreign id is rejected", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-curated-"));
    const write = (name: string, body: unknown): void =>
      writeFileSync(path.join(dir, name), JSON.stringify(body));
    const ok = {
      id: "demo-flow-01",
      category: "flow",
      prompt: `Trace it. ${ANSWER_FILES}`,
      truth: { files: ["a.ts", "b.ts"] },
      truth_source: "hand-curated by a test",
    };

    write("demo-flow.json", [ok, ok]);
    expect(() => loadFlowTasks("demo", dir)).toThrow(/duplicate/i);

    write("demo-flow.json", [{ ...ok, id: "other-flow-01" }]);
    expect(() => loadFlowTasks("demo", dir)).toThrow(/demo-flow-/);

    write("demo-flow.json", [ok]);
    expect(loadFlowTasks("demo", dir)).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("loadTasks filters by category when asked", () => {
    const all = loadTasks("tiny-ts", fixtureTruth, 8);
    expect(new Set(all.map((t) => t.category)).size).toBe(4);
    const only = loadTasks("tiny-ts", fixtureTruth, 8, 1, ["definition", "importers"]);
    expect(only.length).toBeGreaterThan(0);
    for (const task of only) expect(["definition", "importers"]).toContain(task.category);
  });

  test("n is the number of tasks asked for, after the category filter, not before", () => {
    // Splitting 8 over four categories and then dropping three of them used to
    // leave 2 tasks for a caller who asked for 8.
    const one = loadTasks("tiny-ts", fixtureTruth, 8, 1, ["definition"]);
    expect(one).toHaveLength(8);
    for (const task of one) expect(task.category).toBe("definition");
    expect(new Set(one.map((t) => t.id)).size).toBe(8);

    const two = loadTasks("tiny-ts", fixtureTruth, 8, 1, ["definition", "importers"]);
    expect(two).toHaveLength(8);
    expect(two.filter((t) => t.category === "definition")).toHaveLength(4);
    expect(two.filter((t) => t.category === "importers")).toHaveLength(4);

    // A category with fewer candidates than its share still shrinks rather than
    // inventing tasks: the fixture has 10 definition subjects, not 40.
    expect(loadTasks("tiny-ts", fixtureTruth, 40, 1, ["definition"]).length).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

function handBuilt(category: TaskCategory, files: string[], symbols?: string[]): Task {
  return {
    id: `t-${category}`,
    category,
    prompt: "irrelevant",
    truth: symbols === undefined ? { files } : { files, symbols },
    truth_source: "hand-built",
  };
}

describe("scoring", () => {
  test("takes the last fenced JSON block out of an answer", () => {
    const text = [
      "I first guessed wrong:",
      "```json",
      '{"files": ["a.ts"]}',
      "```",
      "then checked the map and the real answer is:",
      "```json",
      '{"files": ["src/b.ts", "src/c.ts"], "symbols": ["B.run"]}',
      "```",
    ].join("\n");
    expect(extractAnswer(text)).toEqual({ files: ["src/b.ts", "src/c.ts"], symbols: ["B.run"] });
  });

  test("reads a bare object with a nested one inside it", () => {
    // A lazy `\{.*?\}` would stop at the first closing brace and lose the files.
    expect(extractAnswer('{"meta": {"why": "traced it"}, "files": ["a.ts", "b.ts"]}')).toEqual({
      files: ["a.ts", "b.ts"],
      symbols: [],
    });
    // A brace inside a string must not open a level.
    expect(extractAnswer('{"note": "a } brace", "files": ["a.ts"]}')).toEqual({ files: ["a.ts"], symbols: [] });
  });

  test("accepts an unlabelled fence and a bare object, and rejects prose", () => {
    expect(extractAnswer('```\n{"files": ["a.ts"]}\n```')).toEqual({ files: ["a.ts"], symbols: [] });
    expect(extractAnswer('The answer is {"files": ["a.ts", "b.ts"]} and that is all.')).toEqual({
      files: ["a.ts", "b.ts"],
      symbols: [],
    });
    expect(extractAnswer("I could not find it.")).toBeNull();
    expect(extractAnswer("```json\nnot json at all\n```")).toBeNull();
  });

  test("strips the working copy's real path out of an absolute answer", () => {
    // The child reports its resolved cwd (/private/var on macOS), so the runner
    // strips the resolved root, not the string it handed the child.
    const root = realpathSync(tmpdir());
    expect(normalizeAnswerPath(`${root}/copy/src/a.ts`, `${root}/copy`)).toBe("src/a.ts");
    expect(normalizeAnswerPath(`${root}/copy/`, `${root}/copy`)).toBe("");
  });

  test("normalises the paths an agent is likely to write", () => {
    const answer = extractAnswer('```json\n{"files": ["./src/a.ts", "/src/b.ts", "src\\\\c.ts", "src/a.ts"]}\n```');
    expect(answer?.files).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  test("a trailing slash is stripped but case is not touched", () => {
    expect(normalizeAnswerPath("src/router/")).toBe("src/router");
    expect(normalizeAnswerPath("./src/router//")).toBe("src/router");
    // Case is meaningful: hono ships src/jsx/base.ts and greplost ids are
    // case-sensitive, so two files can differ only in case and must not merge.
    expect(normalizeAnswerPath("src/Router.ts")).toBe("src/Router.ts");
    expect(normalizeAnswerPath("SRC/A.TS")).toBe("SRC/A.TS");
  });

  test("orientation is set F1 over files, like the other set categories", () => {
    const orientation = handBuilt("orientation", ["a.ts", "b.ts", "c.ts", "d.ts"]);
    expect(scoreAnswer(orientation, { files: ["a.ts", "b.ts", "c.ts", "d.ts"], symbols: [] }).score).toBe(1);
    expect(scoreAnswer(orientation, { files: ["a.ts", "b.ts", "x.ts", "y.ts"], symbols: [] }).score).toBeCloseTo(0.5, 9);
    expect(scoreAnswer(orientation, { files: [], symbols: [] }).score).toBe(0);
  });

  test("definition is an exact match, not an F1", () => {
    const definition = handBuilt("definition", ["src/retry.ts"]);
    expect(scoreAnswer(definition, { files: ["src/retry.ts"], symbols: [] }).score).toBe(1);
    expect(scoreAnswer(definition, { files: ["./src/retry.ts"], symbols: [] }).score).toBe(1);
    // A right answer with a spurious extra file is not a right answer.
    expect(scoreAnswer(definition, { files: ["src/retry.ts", "src/index.ts"], symbols: [] }).score).toBe(0);
    expect(scoreAnswer(definition, { files: ["src/index.ts"], symbols: [] }).score).toBe(0);
  });

  test("importers, callers and blast_radius are set F1 over files", () => {
    const importers = handBuilt("importers", ["a.ts", "b.ts", "c.ts", "d.ts"]);
    expect(scoreAnswer(importers, { files: ["a.ts", "b.ts", "c.ts", "d.ts"], symbols: [] }).score).toBe(1);
    // 2 of 4 right, 2 wrong: precision 0.5, recall 0.5, F1 0.5.
    expect(scoreAnswer(importers, { files: ["a.ts", "b.ts", "x.ts", "y.ts"], symbols: [] }).score).toBeCloseTo(0.5, 9);
    expect(scoreAnswer(importers, { files: [], symbols: [] }).score).toBe(0);

    const blast = handBuilt("blast_radius", ["a.ts", "b.ts"]);
    // precision 2/3, recall 1 -> F1 0.8
    expect(scoreAnswer(blast, { files: ["a.ts", "b.ts", "z.ts"], symbols: [] }).score).toBeCloseTo(0.8, 9);
  });

  test("callers scores files and reports a separate symbols F1", () => {
    const callers = handBuilt("callers", ["a.ts", "b.ts"], ["A.run", "B.run"]);
    const perfect = scoreAnswer(callers, { files: ["a.ts", "b.ts"], symbols: ["A.run", "B.run"] });
    expect(perfect.score).toBe(1);
    expect(perfect.symbolsF1).toBe(1);

    // Files right, symbols half right: the category score stays the file score.
    const half = scoreAnswer(callers, { files: ["a.ts", "b.ts"], symbols: ["A.run", "C.run"] });
    expect(half.score).toBe(1);
    expect(half.symbolsF1).toBeCloseTo(0.5, 9);

    // A `file#Symbol` id counts as the symbol: the prompt asks for a name and the
    // greplost id form carries one, so an agent quoting an id is not punished.
    const ids = scoreAnswer(callers, { files: ["a.ts", "b.ts"], symbols: ["a.ts#A.run", "b.ts#B.run"] });
    expect(ids.symbolsF1).toBe(1);
  });

  test("flow is an order-sensitive LCS ratio", () => {
    const flow = handBuilt("flow", ["a.ts", "b.ts", "c.ts", "d.ts"]);
    expect(scoreAnswer(flow, { files: ["a.ts", "b.ts", "c.ts", "d.ts"], symbols: [] }).score).toBe(1);
    // Same set, reversed: LCS is 1 of 4 -> 2*1/(4+4) = 0.25.
    expect(scoreAnswer(flow, { files: ["d.ts", "c.ts", "b.ts", "a.ts"], symbols: [] }).score).toBeCloseTo(0.25, 9);
    // A correct prefix: LCS 2 -> 2*2/(2+4) = 0.666...
    expect(scoreAnswer(flow, { files: ["a.ts", "b.ts"], symbols: [] }).score).toBeCloseTo(2 / 3, 9);
    expect(scoreAnswer(flow, { files: [], symbols: [] }).score).toBe(0);
    expect(lcsRatio(["a", "b", "c"], ["a", "x", "b", "y", "c"])).toBeCloseTo(0.75, 9);
  });

  test("an unparseable answer scores zero in every category", () => {
    for (const category of ["definition", "importers", "callers", "blast_radius", "flow"] as const) {
      const scored = scoreAnswer(handBuilt(category, ["a.ts"], ["A"]), null);
      expect(scored.score).toBe(0);
      expect(scored.parsed).toBe(false);
    }
  });

  test("summarises a sample with mean, median, std, min and max", () => {
    const stats = summarize([1, 2, 3, 4]);
    expect(stats.mean).toBeCloseTo(2.5, 9);
    expect(stats.median).toBeCloseTo(2.5, 9);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(4);
    expect(stats.std).toBeCloseTo(Math.sqrt(1.25), 9);
    expect(stats.n).toBe(4);
    expect(summarize([]).n).toBe(0);
    expect(summarize([5]).median).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// the runner, driven by a fake `claude` on PATH
// ---------------------------------------------------------------------------

/**
 * A stand-in for the Claude Code CLI.
 *
 * It logs every invocation (cwd, argv, and whether the condition's artifacts are
 * present), answers from a prompt -> answer table the test builds, and emits the
 * envelope shape measured from `claude` 2.1.258 - including the fact that the
 * `--output-format json` envelope carries *no* tool-call count, which is what
 * makes the runner fall back to `stream-json`.
 */
const FAKE_CLAUDE = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log("2.0.0-fake (Claude Code)");
  process.exit(0);
}
if (argv.includes("--help")) {
  // The flags the runner confirms before it spends anything.
  console.log("-p, --print\\n--model <model>\\n--output-format <format>\\n--allowedTools <tools...>\\n--disallowedTools <tools...>\\n--verbose\\n--plugin-dir <path>\\n--max-budget-usd <amount>");
  process.exit(0);
}

const cwd = process.cwd();
const log = process.env.FAKE_CLAUDE_LOG;
const mode = process.env.FAKE_CLAUDE_MODE ?? "normal";
if (log) {
  appendFileSync(
    log,
    JSON.stringify({
      cwd,
      argv,
      mode,
      // The PATH the runner handed the child, so a test can prove the shim is first.
      pathEnv: process.env.PATH ?? "",
      greplost: existsSync(path.join(cwd, ".greplost", "INDEX.md")),
      // Proof the shim on PATH really runs the greplost CLI, from inside the child.
      shimVersion: (() => {
        try {
          return spawnSync("greplost", ["--version"], { encoding: "utf8", env: process.env }).stdout?.trim() ?? "";
        } catch {
          return "";
        }
      })(),
    }) + "\\n",
  );
}

if (mode === "sleep") {
  // Outlive any sane --timeout so the runner has to kill this process.
  Bun.sleepSync(30000);
  process.exit(0);
}
if (mode === "bad-envelope") {
  // A result line with neither an answer nor usage: shape the runner must reject.
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "fake" }) + "\\n");
  process.exit(0);
}
if (mode === "exit3") {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "", usage: {} }) + "\\n");
  process.exit(3);
}

const promptIndex = argv.indexOf("-p");
const prompt = promptIndex === -1 ? "" : (argv[promptIndex + 1] ?? "");
const answers = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_ANSWERS ?? "", "utf8"));
const answer = answers[prompt];
const text = answer
  ? "I read the map.\\n\\n\\u0060\\u0060\\u0060json\\n" + JSON.stringify(answer) + "\\n\\u0060\\u0060\\u0060\\n"
  : "I could not work that out.";

const envelope = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 1234,
  duration_api_ms: 1000,
  num_turns: 3,
  result: text,
  session_id: "fake-session",
  total_cost_usd: 0.0125,
  usage: {
    input_tokens: 18,
    cache_creation_input_tokens: 1200,
    cache_read_input_tokens: 4000,
    output_tokens: 302,
  },
  permission_denials: [],
};

const format = argv[argv.indexOf("--output-format") + 1];
if (format === "stream-json") {
  const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  say({ type: "system", subtype: "init", model: "fake" });
  say({ type: "assistant", message: { content: [{ type: "thinking", thinking: "" }] } });
  say({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } });
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } });
  say({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Glob", input: {} }] } });
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2" }] } });
  say({ type: "assistant", message: { content: [{ type: "text", text }] } });
  say(envelope);
} else {
  process.stdout.write(JSON.stringify(envelope) + "\\n");
}
`;

interface FakeInvocation {
  cwd: string;
  argv: string[];
  mode: string;
  pathEnv: string;
  greplost: boolean;
  shimVersion: string;
}

/** Run the suite with the fake in `mode`, restoring the mode afterwards. */
async function runInMode(mode: string, args: string[]): Promise<number> {
  process.env["FAKE_CLAUDE_MODE"] = mode;
  try {
    return await run(args);
  } finally {
    delete process.env["FAKE_CLAUDE_MODE"];
  }
}

/** The one results file the runner wrote, with its name. */
function writtenResultFile(): string {
  const files = readdirSync(harness.resultsDir).filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(1);
  return files[0] as string;
}

interface Harness {
  dir: string;
  resultsDir: string;
  logFile: string;
}

let harness: Harness;
let savedPath: string | undefined;
let savedResultsDir: string | undefined;

/** Every logged invocation that actually carried a prompt. */
function invocations(): FakeInvocation[] {
  if (!existsSync(harness.logFile)) return [];
  return readFileSync(harness.logFile, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as FakeInvocation)
    .filter((entry) => entry.argv.includes("-p"));
}

/** The single result file the runner wrote, parsed. */
function writtenResult(): Record<string, unknown> {
  const files = readdirSync(harness.resultsDir).filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(path.join(harness.resultsDir, files[0] as string), "utf8")) as Record<string, unknown>;
}

/** Answers keyed by prompt, so the fake can reply correctly to whatever it is asked. */
function writeAnswerKey(tasks: Task[]): void {
  const answers: Record<string, { files: string[]; symbols?: string[] }> = {};
  for (const t of tasks) {
    answers[t.prompt] =
      t.truth.symbols === undefined ? { files: t.truth.files } : { files: t.truth.files, symbols: t.truth.symbols };
  }
  writeFileSync(path.join(harness.dir, "answers.json"), JSON.stringify(answers));
}

/** Reset the log and results between runner invocations. */
function resetHarness(): void {
  rmSync(harness.logFile, { force: true });
  rmSync(harness.resultsDir, { recursive: true, force: true });
  mkdirSync(harness.resultsDir, { recursive: true });
}

beforeAll(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "greplost-agent-test-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const fake = path.join(bin, "claude");
  writeFileSync(fake, FAKE_CLAUDE);
  chmodSync(fake, 0o755);

  harness = { dir, resultsDir: path.join(dir, "results"), logFile: path.join(dir, "calls.jsonl") };
  mkdirSync(harness.resultsDir, { recursive: true });

  savedPath = process.env["PATH"];
  savedResultsDir = process.env["GREPLOST_BENCH_RESULTS_DIR"];
  process.env["PATH"] = `${bin}${path.delimiter}${savedPath ?? ""}`;
  process.env["GREPLOST_BENCH_RESULTS_DIR"] = harness.resultsDir;
  process.env["FAKE_CLAUDE_LOG"] = harness.logFile;
  process.env["FAKE_CLAUDE_ANSWERS"] = path.join(dir, "answers.json");

  // Hard stop before any test body runs: a throwing beforeAll fails the file
  // rather than letting the runner reach the real `claude` and spend money.
  if (resolveClaude() !== fake) {
    throw new Error(`greplost: the fake claude is not first on PATH (resolved ${resolveClaude()})`);
  }
});

afterAll(() => {
  if (savedPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = savedPath;
  if (savedResultsDir === undefined) delete process.env["GREPLOST_BENCH_RESULTS_DIR"];
  else process.env["GREPLOST_BENCH_RESULTS_DIR"] = savedResultsDir;
  delete process.env["FAKE_CLAUDE_LOG"];
  delete process.env["FAKE_CLAUDE_ANSWERS"];
  rmSync(harness.dir, { recursive: true, force: true });
});

describe("fake claude", () => {
  test("resolves the fake and never the real CLI", () => {
    // The guard that matters most in this file: if PATH resolution ever regressed,
    // every test below would spend real money against the real Claude Code.
    expect(resolveClaude()).toBe(path.join(harness.dir, "bin", "claude"));
  });

  test("runs the fixture end to end in the gl condition and scores the canned answer 1.0", async () => {
    resetHarness();
    const tasks = generateStructuralTasks("tiny-ts", fixtureTruth, 4);
    expect(tasks).toHaveLength(4);
    writeAnswerKey(tasks);

    const code = await run(["--fixture", "--condition", "gl", "--runs", "1", "--tasks", "4"]);
    expect(code).toBe(0);

    const payload = writtenResult();
    expect(payload["suite"]).toBe("agent-fixture");
    expect(payload["claudeVersion"]).toBe("2.0.0-fake (Claude Code)");
    expect(payload["runsPerTask"]).toBe(1);
    expect(payload["conditions"]).toEqual(["gl"]);
    expect((payload["tasks"] as Task[]).map((t) => t.id)).toEqual(tasks.map((t) => t.id));

    const runs = payload["runs"] as Record<string, unknown>[];
    expect(runs).toHaveLength(4);
    for (const record of runs) {
      expect(record["condition"]).toBe("gl");
      expect(record["score"]).toBe(1);
      expect(record["parsed"]).toBe(true);
      expect(record["toolCalls"]).toBe(2);
      expect(record["numTurns"]).toBe(3);
      expect(record["costUsd"]).toBe(0.0125);
      expect(record["tokens"]).toEqual({ input: 18, output: 302, cacheRead: 4000, cacheWrite: 1200, total: 5520 });
      expect(record["wallMs"]).toBeGreaterThanOrEqual(0);
    }

    const aggregate = payload["aggregate"] as Record<string, Record<string, Record<string, { mean: number }>>>;
    expect(aggregate["gl"]?.["overall"]?.["accuracy"]?.mean).toBe(1);
    expect(aggregate["gl"]?.["overall"]?.["toolCalls"]?.mean).toBe(2);
  });

  test("prepares a real .greplost/ copy and passes the condition's flags", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 2));
    expect(await run(["--fixture", "--condition", "gl", "--runs", "1", "--tasks", "2"])).toBe(0);

    const calls = invocations();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      // `greplost init --no-hooks` really ran in the copy the agent was pointed at.
      expect(call.greplost).toBe(true);
      expect(call.cwd).not.toBe(FIXTURE);
      expect(call.argv).toContain("--model");
      expect(call.argv).toContain("--allowedTools");
      expect(call.argv[call.argv.indexOf("--allowedTools") + 1]).toBe("Read,Grep,Glob");
      expect(call.argv).not.toContain("--disallowedTools");
      // The prompt is passed verbatim: the fake answered by looking it up.
      expect(call.argv[call.argv.indexOf("-p") + 1]).toContain("Answer with a JSON block");
    }
  });

  test("gl passes --plugin-dir and puts a working greplost shim first on the child's PATH", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 1));
    expect(await run(["--fixture", "--condition", "gl", "--runs", "1", "--tasks", "1"])).toBe(0);

    const calls = invocations();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) {
      // Tech spec 10.6: the `gl` condition is the map *and* the plugin hooks.
      const pluginDir = call.argv[call.argv.indexOf("--plugin-dir") + 1] ?? "";
      expect(pluginDir).toBe(path.join(REPO_ROOT, "greplost-plugin"));
      // The plugin's hooks shell out to `greplost`, which only exists on PATH
      // inside a throwaway copy because the runner puts a shim there first.
      const first = call.pathEnv.split(path.delimiter)[0] ?? "";
      expect(first).toMatch(/greplost-agent-[^/]*\/shim$/);
      // Run from inside the child, so this proves the shim on that PATH really
      // executes this checkout's CLI. (The shim itself is gone by now: the
      // runner deletes its whole working directory when the run ends.)
      expect(call.shimVersion).toMatch(/^greplost \d+\.\d+\.\d+/);
    }
  });

  test("base gets no plugin dir and no greplost shim", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 1));
    expect(await run(["--fixture", "--condition", "base", "--runs", "1", "--tasks", "1"])).toBe(0);
    for (const call of invocations()) {
      expect(call.argv).not.toContain("--plugin-dir");
      expect(call.greplost).toBe(false);
      expect(call.shimVersion).toBe("");
    }
  });

  test("falls back to stream-json once, then stays there, because the envelope has no tool-call count", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 4));
    expect(await run(["--fixture", "--condition", "gl", "--runs", "1", "--tasks", "4"])).toBe(0);

    const calls = invocations();
    const format = (call: FakeInvocation): string => call.argv[call.argv.indexOf("--output-format") + 1] ?? "";
    // 4 tasks, 1 run each: one json probe, one stream-json re-run of that same
    // prompt for its tool-call count, then stream-json only.
    expect(calls).toHaveLength(5);
    expect(format(calls[0] as FakeInvocation)).toBe("json");
    expect(format(calls[1] as FakeInvocation)).toBe("stream-json");
    // Exactly one record is allowed to carry a count from a different session.
    const probed = (writtenResult()["runs"] as Record<string, unknown>[]).filter((r) => r["toolCallsFromProbe"]);
    expect(probed).toHaveLength(1);
    expect((calls[1] as FakeInvocation).argv).toContain("--verbose");
    expect((calls[1] as FakeInvocation).argv[(calls[1] as FakeInvocation).argv.indexOf("-p") + 1]).toBe(
      (calls[0] as FakeInvocation).argv[(calls[0] as FakeInvocation).argv.indexOf("-p") + 1],
    );
    for (const call of calls.slice(2)) expect(format(call)).toBe("stream-json");

    // The probe's own cost is recorded rather than absorbed.
    const probe = writtenResult()["toolCallProbe"] as Record<string, number>;
    expect(probe["sessions"]).toBe(1);
    expect(probe["costUsd"]).toBe(0.0125);
    expect(probe["tokens"]).toBe(5520);
  });

  test("gl-strict disallows Grep and Glob", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 2));
    const code = await run(["--fixture", "--condition", "gl-strict", "--runs", "1", "--tasks", "2"]);
    expect(code).toBe(0);

    for (const call of invocations()) {
      expect(call.greplost).toBe(true);
      expect(call.argv[call.argv.indexOf("--allowedTools") + 1]).toBe("Read");
      expect(call.argv[call.argv.indexOf("--disallowedTools") + 1]).toBe("Grep,Glob");
    }
    const runs = writtenResult()["runs"] as Record<string, unknown>[];
    expect(runs.length).toBeGreaterThan(0);
    for (const record of runs) expect(record["score"]).toBe(1);
  });

  test("records a competitor with no installed artifacts as N/A instead of zero", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 2));
    const code = await run(["--fixture", "--condition", "gl,graphify", "--runs", "1", "--tasks", "2"]);
    expect(code).toBe(0);

    const payload = writtenResult();
    const unavailable = payload["unavailable"] as Record<string, string>;
    expect(Object.keys(unavailable)).toEqual(["graphify"]);
    expect(unavailable["graphify"]).toContain("bench/.competitors/graphify");
    // Nothing was scored for it: N/A, not 0 (tech spec 10.0).
    expect((payload["aggregate"] as Record<string, unknown>)["graphify"]).toBeUndefined();
    for (const record of payload["runs"] as Record<string, unknown>[]) expect(record["condition"]).toBe("gl");
    for (const call of invocations()) expect(call.argv).not.toContain("graphify");
  });

  test("an answer with no JSON block scores zero and is counted as unparsed", async () => {
    resetHarness();
    writeFileSync(path.join(harness.dir, "answers.json"), "{}");
    const code = await run(["--fixture", "--condition", "gl", "--runs", "1", "--tasks", "2"]);
    expect(code).toBe(0);

    const payload = writtenResult();
    for (const record of payload["runs"] as Record<string, unknown>[]) {
      expect(record["score"]).toBe(0);
      expect(record["parsed"]).toBe(false);
      expect(record["error"]).toBeNull();
    }
    const overall = (payload["aggregate"] as Record<string, Record<string, Record<string, number>>>)["gl"]?.["overall"];
    expect(overall?.["unparsed"]).toBe(2);
    // The CLI worked: an unreadable answer is not a broken session.
    expect(overall?.["errors"]).toBe(0);
  });

  test("a run where every condition is N/A writes nothing and fails", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 2));
    const code = await run(["--fixture", "--condition", "graphify,ua", "--runs", "1", "--tasks", "2"]);
    expect(code).toBe(1);
    expect(readdirSync(harness.resultsDir)).toEqual([]);
    expect(invocations()).toEqual([]);
  });

  test("--gate reports A3 non-inferiority against base", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 2));
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    let code: number;
    try {
      code = await run(["--fixture", "--condition", "base,gl", "--runs", "1", "--tasks", "2", "--gate"]);
    } finally {
      console.log = log;
    }
    expect(code).toBe(0);
    expect(lines[lines.length - 1]).toBe("agent: GATE PASS");
    expect(writtenResult()["gate"]).toEqual({ passed: true, missed: [] });
  });

  test("wins, losses and ties are counted per task against base", async () => {
    resetHarness();
    // The fake answers from the prompt alone, so both conditions get the same
    // answer and every task must come out a tie.
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 4));

    const code = await run(["--fixture", "--condition", "base", "--condition", "gl", "--runs", "1", "--tasks", "4"]);
    expect(code).toBe(0);

    const payload = writtenResult();
    expect(payload["conditions"]).toEqual(["base", "gl"]);
    const table = payload["winLossTie"] as Record<string, { wins: number; losses: number; ties: number }>;
    // Both conditions get the same canned answer, so every task is a tie.
    expect(table["gl"]).toEqual({ wins: 0, losses: 0, ties: 4 });
    expect(table["base"]).toBeUndefined();
  });
});

describe("fake claude timeouts and budget", () => {
  test("a session that outlives --timeout is killed and recorded as a timeout error", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 1));
    const started = Date.now();
    const code = await runInMode("sleep", [
      "--fixture",
      "--condition",
      "gl",
      "--runs",
      "1",
      "--tasks",
      "1",
      "--timeout",
      "400",
    ]);
    // The whole point: the suite comes back instead of hanging on a wedged CLI.
    expect(Date.now() - started).toBeLessThan(30000);
    expect(code).toBe(0);

    const payload = writtenResult();
    const runs = payload["runs"] as Record<string, unknown>[];
    expect(runs.length).toBeGreaterThan(0);
    for (const record of runs) {
      expect(record["error"]).toBe("timeout after 400ms");
      expect(record["score"]).toBe(0);
      expect(record["parsed"]).toBe(false);
    }
    const overall = (payload["aggregate"] as Record<string, Record<string, Record<string, number>>>)["gl"]?.["overall"];
    // A killed session is an error, never a silently empty answer.
    expect(overall?.["errors"]).toBe(runs.length);
  }, 60000);

  test("a failed session never buys a probe session and never flips the run to stream-json", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 1));
    expect(
      await runInMode("sleep", ["--fixture", "--condition", "gl", "--runs", "1", "--tasks", "1", "--timeout", "400"]),
    ).toBe(0);

    // One doomed session, not two: a session that never produced an envelope has
    // no missing tool-call count to go and buy.
    expect(invocations()).toHaveLength(1);
    const payload = writtenResult();
    expect((payload["toolCallProbe"] as Record<string, number>)["sessions"]).toBe(0);
    const cli = payload["cli"] as Record<string, unknown>;
    expect(cli["streamJsonFallback"]).toBe(false);
    expect(cli["outputFormat"]).toBe("json");
    for (const record of payload["runs"] as Record<string, unknown>[]) {
      expect(record["toolCallsFromProbe"]).toBe(false);
    }
  }, 60000);

  test("an envelope with no answer and no usage is an unrecognised envelope, not an unreadable answer", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 1));
    expect(
      await runInMode("bad-envelope", ["--fixture", "--condition", "gl", "--runs", "1", "--tasks", "1"]),
    ).toBe(0);
    const payload = writtenResult();
    for (const record of payload["runs"] as Record<string, unknown>[]) {
      expect(record["error"]).toBe("unrecognised envelope");
      expect(record["score"]).toBe(0);
    }
    const overall = (payload["aggregate"] as Record<string, Record<string, Record<string, number>>>)["gl"]?.["overall"];
    expect(overall?.["errors"]).toBe(1);
  });

  test("a non-zero exit is folded into the record's error", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 1));
    expect(await runInMode("exit3", ["--fixture", "--condition", "gl", "--runs", "1", "--tasks", "1"])).toBe(0);
    for (const record of writtenResult()["runs"] as Record<string, unknown>[]) {
      expect(String(record["error"])).toContain("exit 3");
    }
  });

  test("--max-usd caps the run: the flag is passed and the loop aborts with partial results", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 8));
    // Each fake session bills 0.0125, so a 0.03 cap stops after a couple of them.
    const code = await run([
      "--fixture",
      "--condition",
      "gl",
      "--runs",
      "1",
      "--tasks",
      "8",
      "--max-usd",
      "0.03",
    ]);
    expect(code).toBe(0);

    const payload = writtenResult();
    const runs = payload["runs"] as Record<string, unknown>[];
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.length).toBeLessThan(8);
    const budget = payload["budget"] as Record<string, unknown>;
    expect(budget["maxUsd"]).toBe(0.03);
    expect(budget["stopped"]).toBe(true);
    expect(budget["spentUsd"] as number).toBeGreaterThanOrEqual(0.03);
    // The first session sees the whole remaining cap (below the 1 USD seed
    // ceiling), and every session's flag stays inside what is left of the cap.
    const calls = invocations();
    expect(calls[0]?.argv[(calls[0]?.argv.indexOf("--max-budget-usd") ?? -1) + 1]).toBe("0.03");
    for (const call of calls) {
      const passed = Number(call.argv[call.argv.indexOf("--max-budget-usd") + 1]);
      expect(passed).toBeGreaterThan(0);
      expect(passed).toBeLessThanOrEqual(0.03);
    }
    // The cap, not the per-session ceiling, was the binding constraint every
    // time; the recorded source is the one in force when the run ended, by which
    // point sessions had billed and the ceiling was following the observed median.
    expect(budget["sessionCeilingSource"]).toBe("observed");
    expect(budget["truncatedSessions"] as number).toBeGreaterThanOrEqual(1);
    // Attributable: every record says which ceiling its own session was given.
    for (const record of runs) expect(record["sessionBudgetUsd"] as number).toBeLessThanOrEqual(0.03);
  });

  test("--max-session-usd sets the per-session ceiling and is recorded", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 2));
    expect(
      await run(["--fixture", "--condition", "gl", "--runs", "1", "--tasks", "2", "--max-session-usd", "0.5"]),
    ).toBe(0);

    const payload = writtenResult();
    const budget = payload["budget"] as Record<string, unknown>;
    expect(budget["maxUsd"]).toBeNull();
    expect(budget["sessionCeilingUsd"]).toBe(0.5);
    expect(budget["sessionCeilingSource"]).toBe("flag");
    // No run cap, so nothing could truncate a session below its ceiling.
    expect(budget["truncatedSessions"]).toBe(0);
    for (const call of invocations()) {
      expect(call.argv[call.argv.indexOf("--max-budget-usd") + 1]).toBe("0.5");
    }
    for (const record of payload["runs"] as Record<string, unknown>[]) {
      expect(record["sessionBudgetUsd"]).toBe(0.5);
    }
  });

  test("the per-session ceiling follows the observed median once sessions have billed", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 4));
    // A cap far above what the fake bills, so the ceiling is the only constraint.
    expect(
      await run(["--fixture", "--condition", "gl", "--runs", "1", "--tasks", "4", "--max-usd", "100"]),
    ).toBe(0);

    const budget = writtenResult()["budget"] as Record<string, unknown>;
    expect(budget["stopped"]).toBe(false);
    expect(budget["sessionCeilingSource"]).toBe("observed");
    // Every fake session bills 0.0125, so the median is 0.0125 and 4x is 0.05.
    expect(budget["sessionCeilingUsd"]).toBeCloseTo(0.05, 9);
    expect(budget["truncatedSessions"]).toBe(0);
    const calls = invocations();
    // The very first session had nothing to observe yet: the 1 USD seed.
    expect(calls[0]?.argv[(calls[0]?.argv.indexOf("--max-budget-usd") ?? -1) + 1]).toBe("1");
    expect(calls[calls.length - 1]?.argv[(calls[calls.length - 1]?.argv.indexOf("--max-budget-usd") ?? -1) + 1]).toBe(
      "0.05",
    );
  });

  test("a fixture run has no budget cap and passes no budget flag", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 1));
    expect(await run(["--fixture", "--condition", "gl", "--runs", "1", "--tasks", "1"])).toBe(0);
    expect((writtenResult()["budget"] as Record<string, unknown>)["maxUsd"]).toBeNull();
    for (const call of invocations()) expect(call.argv).not.toContain("--max-budget-usd");
  });

  test("--tasks 0 and --runs 0 are rejected rather than silently defaulted", async () => {
    resetHarness();
    expect(await run(["--fixture", "--tasks", "0"])).toBe(2);
    expect(await run(["--fixture", "--runs", "0"])).toBe(2);
    expect(await run(["--fixture", "--tasks", "-3"])).toBe(2);
    expect(readdirSync(harness.resultsDir)).toEqual([]);
    expect(invocations()).toEqual([]);
  });
});

describe("fake claude results, metrics and seams", () => {
  test("a fixture run writes agent-fixture-… so it never shadows a corpus run", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 1));
    expect(await run(["--fixture", "--condition", "gl", "--runs", "1", "--tasks", "1"])).toBe(0);
    expect(writtenResultFile()).toMatch(/^agent-fixture-\d{4}-\d{2}-\d{2}-[^/]*\.json$/);
    expect(writtenResult()["suite"]).toBe("agent-fixture");
  });

  test("--categories keeps only the categories asked for", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 8));
    expect(
      await run(["--fixture", "--condition", "gl", "--runs", "1", "--tasks", "8", "--categories", "definition"]),
    ).toBe(0);
    const tasks = writtenResult()["tasks"] as Task[];
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) expect(task.category).toBe("definition");
    expect(await run(["--fixture", "--categories", "nonsense"])).toBe(2);
  });

  test("the payload carries A1 to A4 keyed by their tech spec ids", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 8));
    expect(
      await run(["--fixture", "--condition", "base,gl", "--runs", "1", "--tasks", "8"]),
    ).toBe(0);

    const metrics = writtenResult()["metrics"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(metrics).sort()).toEqual(["A1", "A2", "A3", "A3blast", "A4"]);
    // Same canned answer in both conditions: ratios are 1, accuracy delta is 0.
    expect(metrics["A1"]?.["ratio"]).toBe(1);
    expect(metrics["A2"]?.["ratio"]).toBe(1);
    expect(metrics["A3"]?.["delta"]).toBe(0);
    expect(metrics["A3"]?.["met"]).toBe(true);
    expect(metrics["A3blast"]?.["delta"]).toBe(0);
    // A1's target is 0.50, so a ratio of 1 misses it: the field must say so.
    expect(metrics["A1"]?.["target"]).toBe(0.5);
    expect(metrics["A1"]?.["met"]).toBe(false);
    expect(metrics["A4"]?.["id"]).toBe("A4");
  });

  test("A3blast is null when the blast-radius category never ran", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 4));
    expect(
      await run([
        "--fixture",
        "--condition",
        "base,gl",
        "--runs",
        "1",
        "--tasks",
        "4",
        "--categories",
        "definition",
      ]),
    ).toBe(0);

    const payload = writtenResult();
    for (const task of payload["tasks"] as Task[]) expect(task.category).toBe("definition");
    const metrics = payload["metrics"] as Record<string, unknown>;
    // A category that never ran has no number, and 0 is a number.
    expect(metrics["A3blast"]).toBeNull();
    expect((metrics["A3"] as Record<string, unknown>)["delta"]).toBe(0);
    expect((metrics["A1"] as Record<string, unknown>)["ratio"]).toBe(1);
  });

  test("metrics are null when the run cannot compare gl against base", async () => {
    resetHarness();
    writeAnswerKey(generateStructuralTasks("tiny-ts", fixtureTruth, 1));
    expect(await run(["--fixture", "--condition", "gl", "--runs", "1", "--tasks", "1"])).toBe(0);
    expect(writtenResult()["metrics"]).toBeNull();
  });

  test("runTask is a programmatic entry that scores one task in a prepared copy", async () => {
    resetHarness();
    const task = generateStructuralTasks("tiny-ts", fixtureTruth, 1)[0] as Task;
    writeAnswerKey([task]);

    const copy = path.join(harness.dir, "copy");
    rmSync(copy, { recursive: true, force: true });
    mkdirSync(copy, { recursive: true });
    cpSync(FIXTURE, copy, { recursive: true });

    const record = runTask(task, "base", { cwd: copy, model: "fake-model", stream: true });
    expect(record.taskId).toBe(task.id);
    expect(record.condition).toBe("base");
    expect(record.score).toBe(1);
    expect(record.toolCalls).toBe(2);
    expect(record.error).toBeNull();
    // It really went through the fake, in the copy it was handed.
    const calls = invocations();
    expect(calls).toHaveLength(1);
    // macOS resolves /var to /private/var, and the child reports its resolved cwd.
    expect((calls[0] as FakeInvocation).cwd).toBe(realpathSync(copy));
    expect((calls[0] as FakeInvocation).argv[1]).toBe(task.prompt);
  });
});

describe("dry-run", () => {
  test("prints the suite line, describes the payload shape, and writes nothing", async () => {
    resetHarness();
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    let code: number;
    try {
      code = await run(["--fixture", "--dry-run"]);
    } finally {
      console.log = log;
    }
    expect(code).toBe(0);
    expect(lines[lines.length - 1]).toBe("agent: dry-run ok");
    expect(lines.join("\n")).toContain("runs");
    expect(readdirSync(harness.resultsDir)).toEqual([]);
    // Nothing was executed: a dry run must not need a `claude` on PATH at all.
    expect(invocations()).toEqual([]);
  });
});
