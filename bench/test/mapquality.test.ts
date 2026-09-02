/**
 * Map quality tests (leaf 1.5.4, gates G1 to G6): the Mermaid parse gate
 * (`checkMermaid`/`checkSubset` in `../src/mermaid-check.ts`) and the M1/M2 runner
 * (`../src/mapquality.ts`) against the golden render of `fixtures/tiny-ts` committed at
 * `packages/render/test/golden/tiny-ts` (leaf 1.2.2, wave 2).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkMermaid, checkSubset } from "../src/mermaid-check.ts";
import { run, countNodes, countTokens, walkMarkdown, M1_TOKEN_BUDGET, DEFAULT_MAX_NODES } from "../src/mapquality.ts";
import { latestResult } from "../src/results-io.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const GOLDEN_DIR = path.join(REPO_ROOT, "packages", "render", "test", "golden", "tiny-ts");

/**
 * A real fence, copied verbatim from the golden render (`packages/tiny__core/MAP.md`,
 * `### packages/core` component diagram): 7 nodes, 11 edges, one self-referential-looking
 * pair (`bus.ts <-> events.ts`, not a self edge). This is the literal text `renderGraph`
 * (`packages/render/src/mermaid.ts`) produced for that fixture.
 */
const GOLDEN_CORE_FENCE = `graph LR
  packages_core_src_bus_ts["bus.ts"]
  packages_core_src_events_ts["events.ts"]
  packages_core_src_index_ts["index.ts"]
  packages_core_src_queue_ts["queue.ts"]
  packages_core_src_registry_ts["registry.ts"]
  packages_core_src_retry_ts["retry.ts"]
  packages_core_src_types_ts["types.ts"]
  packages_core_src_bus_ts --> packages_core_src_events_ts
  packages_core_src_bus_ts --> packages_core_src_types_ts
  packages_core_src_events_ts --> packages_core_src_bus_ts
  packages_core_src_index_ts --> packages_core_src_queue_ts
  packages_core_src_index_ts --> packages_core_src_registry_ts
  packages_core_src_index_ts --> packages_core_src_retry_ts
  packages_core_src_index_ts --> packages_core_src_types_ts
  packages_core_src_queue_ts --> packages_core_src_types_ts
  packages_core_src_registry_ts --> packages_core_src_bus_ts
  packages_core_src_registry_ts --> packages_core_src_queue_ts
  packages_core_src_registry_ts --> packages_core_src_retry_ts
`;
/** Hand count of the `id["..."]` lines above. */
const GOLDEN_CORE_FENCE_NODE_COUNT = 7;

const SIMPLE_VALID = `graph LR
  a["A"]
  b["B"]
  a --> b
`;

const COUNT_LABELLED_EDGE = `graph LR
  a["A"]
  b["B"]
  a -->|3| b
`;

/**
 * Every entity `escapeLabel` (`packages/render/src/mermaid.ts`) can produce, inside one
 * node label: `"` -> `#quot;`, `[ ] ( ) { }` -> `#91; #93; #40; #41; #123; #125;`, and the
 * entity-introducer characters themselves, `#` and `;` -> `#35; #59;`, plus `< >` ->
 * `#60; #62;`.
 */
const ENTITY_ESCAPED_LABEL = `graph LR
  a["#quot;hi#quot; #91;x#93; #40;y#41; #123;z#125; #35;tag#59; #60;t#62;"]
  b["plain"]
  a --> b
`;

const TD_DIAGRAM = `graph TD
  a["A"]
  b["B"]
  a --> b
`;

// ---------------------------------------------------------------------------
// checkMermaid: accepts every shape greplost emits
// ---------------------------------------------------------------------------

describe("checkMermaid", () => {
  test("accepts a real fence copied from the golden render", async () => {
    const result = await checkMermaid(GOLDEN_CORE_FENCE);
    expect(result.ok).toBe(true);
    expect(["mermaid", "subset"]).toContain(result.checker);
  });

  test("accepts a plain graph LR with a simple edge", async () => {
    const result = await checkMermaid(SIMPLE_VALID);
    expect(result.ok).toBe(true);
  });

  test("accepts graph TD", async () => {
    const result = await checkMermaid(TD_DIAGRAM);
    expect(result.ok).toBe(true);
  });

  test("accepts a count-labelled edge (a -->|3| b)", async () => {
    const result = await checkMermaid(COUNT_LABELLED_EDGE);
    expect(result.ok).toBe(true);
  });

  test("accepts entity-escaped labels (#quot; #91; #93; #40; #41; #123; #125; #35; #59; #60; #62;)", async () => {
    const result = await checkMermaid(ENTITY_ESCAPED_LABEL);
    expect(result.ok).toBe(true);
  });

  test("every result reports a checker of mermaid or subset", async () => {
    const result = await checkMermaid(SIMPLE_VALID);
    expect(result.checker === "mermaid" || result.checker === "subset").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rejects: malformed diagrams and unknown diagram types
// ---------------------------------------------------------------------------

describe("rejects", () => {
  test("a dangling edge (graph LR / a -->) is rejected with a non-empty error", async () => {
    const result = await checkMermaid("graph LR\n  a -->");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error!.length).toBeGreaterThan(0);
  });

  test("an unknown diagram type is rejected with a non-empty error", async () => {
    const result = await checkMermaid("notARealDiagramType LR\n  a --> b\n");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("an empty fence is rejected", async () => {
    const result = await checkMermaid("");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("a node line missing its closing bracket is rejected", async () => {
    const result = await checkMermaid('graph LR\n  a["A\n  b["B"]\n  a --> b\n');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// subset validator (direct): the fallback path, exercised independently of which
// checker `checkMermaid` actually picked in this process.
// ---------------------------------------------------------------------------

describe("subset validator (direct)", () => {
  test("accepts the golden fence", () => {
    expect(checkSubset(GOLDEN_CORE_FENCE)).toEqual({ ok: true, checker: "subset" });
  });

  test("accepts a simple graph LR", () => {
    expect(checkSubset(SIMPLE_VALID).ok).toBe(true);
  });

  test("accepts graph TD", () => {
    expect(checkSubset(TD_DIAGRAM).ok).toBe(true);
  });

  test("accepts a count-labelled edge", () => {
    expect(checkSubset(COUNT_LABELLED_EDGE).ok).toBe(true);
  });

  test("accepts entity-escaped labels", () => {
    expect(checkSubset(ENTITY_ESCAPED_LABEL).ok).toBe(true);
  });

  test("rejects a dangling edge", () => {
    const result = checkSubset("graph LR\n  a -->");
    expect(result.ok).toBe(false);
    expect(result.checker).toBe("subset");
    expect(result.error).toBeTruthy();
  });

  test("rejects an unknown diagram type", () => {
    const result = checkSubset("notARealDiagramType LR\n  a --> b\n");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("rejects an empty fence", () => {
    expect(checkSubset("").ok).toBe(false);
  });

  test("rejects a stray line that is neither a node nor an edge", () => {
    const result = checkSubset('graph LR\n  a["A"]\n  this is not a valid line\n');
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapquality runner on the golden render of tiny-ts
// ---------------------------------------------------------------------------

describe("mapquality run (golden tiny-ts)", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempResultsDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-mapquality-results-"));
    cleanupDirs.push(dir);
    return dir;
  }

  async function runCaptured(args: string[], resultsDir: string): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
    const previous = process.env["GREPLOST_BENCH_RESULTS_DIR"];
    process.env["GREPLOST_BENCH_RESULTS_DIR"] = resultsDir;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const realLog = console.log;
    const realError = console.error;
    console.log = (...parts: unknown[]): void => {
      stdout.push(parts.map(String).join(" "));
    };
    console.error = (...parts: unknown[]): void => {
      stderr.push(parts.map(String).join(" "));
    };
    try {
      const code = await run(args);
      return { code, stdout, stderr };
    } finally {
      console.log = realLog;
      console.error = realError;
      if (previous === undefined) delete process.env["GREPLOST_BENCH_RESULTS_DIR"];
      else process.env["GREPLOST_BENCH_RESULTS_DIR"] = previous;
    }
  }

  test("M1 and M2 pass on the golden render, GATE PASS is the last stdout line", async () => {
    const results = tempResultsDir();
    const { code, stdout } = await runCaptured(["--dir", GOLDEN_DIR, "--gate"], results);
    expect(stdout[stdout.length - 1]).toBe("mapquality: GATE PASS");
    expect(code).toBe(0);
  });

  test("default (non-json) output prints the checker line for the gate to match on", async () => {
    const results = tempResultsDir();
    const { stdout } = await runCaptured(["--dir", GOLDEN_DIR], results);
    expect(stdout.some((line) => /checker: (mermaid|subset)/.test(line))).toBe(true);
  });

  test("node counting matches a hand count of packages/tiny__core/MAP.md's fence (7 nodes)", () => {
    const text = readFileSync(path.join(GOLDEN_DIR, "packages", "tiny__core", "MAP.md"), "utf8");
    const body = /```mermaid\r?\n([\s\S]*?)```/.exec(text)?.[1] ?? "";
    expect(countNodes(body)).toBe(GOLDEN_CORE_FENCE_NODE_COUNT);
    // The literal copy used by the checkMermaid/checkSubset tests above must still match
    // the file it was copied from, so a future render change cannot silently desync them.
    expect(body.trimEnd()).toBe(GOLDEN_CORE_FENCE.trimEnd());
  });

  test("walkMarkdown finds every golden .md file, including nested module cards", () => {
    const files = walkMarkdown(GOLDEN_DIR);
    expect(files).toContain("INDEX.md");
    expect(files).toContain("repo/MAP.md");
    expect(files).toContain("repo/HOTSPOTS.md");
    expect(files).toContain("packages/tiny__core/MAP.md");
    expect(files).toContain("packages/tiny__core/API.md");
    expect(files).toContain("packages/tiny__core/modules/src/registry.ts.md");
    expect(files).toEqual([...files].sort());
  });

  test("countTokens on INDEX.md is well under the M1 budget", () => {
    const text = readFileSync(path.join(GOLDEN_DIR, "INDEX.md"), "utf8");
    const tokens = countTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThanOrEqual(M1_TOKEN_BUDGET);
  });

  test("results payload has the shared shape: suite, date, greplostSha, machine, corpus, tokens, diagrams, checker, gate", async () => {
    const results = tempResultsDir();
    await runCaptured(["--dir", GOLDEN_DIR, "--gate"], results);

    const latest = latestResult("mapquality", results);
    expect(latest).toBeDefined();
    const payload = latest!.payload;

    expect(payload["suite"]).toBe("mapquality");
    expect(typeof payload["date"]).toBe("string");
    expect(typeof payload["greplostSha"]).toBe("string");
    expect(typeof payload["machine"]).toBe("object");
    expect(Array.isArray(payload["corpus"])).toBe(true);

    const tokens = payload["tokens"] as Record<string, unknown>;
    expect(typeof tokens["indexMd"]).toBe("number");
    expect(tokens["budget"]).toBe(M1_TOKEN_BUDGET);
    expect(tokens["encoding"]).toBe("cl100k_base");

    const diagrams = payload["diagrams"] as Record<string, unknown>;
    expect(diagrams["fences"]).toBe(4); // repo/MAP.md, tiny__core, tiny__adapters, worker
    expect(diagrams["maxNodeCount"]).toBe(GOLDEN_CORE_FENCE_NODE_COUNT);
    expect(diagrams["maxNodes"]).toBe(DEFAULT_MAX_NODES);
    expect(Array.isArray(diagrams["byFence"])).toBe(true);
    expect((diagrams["byFence"] as unknown[]).length).toBe(4);

    expect(["mermaid", "subset"]).toContain(payload["checker"] as string);

    const gate = payload["gate"] as Record<string, unknown>;
    expect(gate["passed"]).toBe(true);
    expect(gate["missed"]).toEqual([]);
  });

  test("--json prints a stableStringify payload instead of the table", async () => {
    const results = tempResultsDir();
    const { stdout } = await runCaptured(["--dir", GOLDEN_DIR, "--json"], results);
    expect(stdout.length).toBe(1);
    const parsed = JSON.parse(stdout[0]!) as Record<string, unknown>;
    expect(parsed["suite"]).toBe("mapquality");
    expect(stdout.some((line) => line.includes("fences:"))).toBe(false);
  });

  test("--gate fails with M2 when config.json sets a node cap the golden render exceeds", async () => {
    const artifactDir = mkdtempSync(path.join(tmpdir(), "greplost-mapquality-artifact-"));
    cleanupDirs.push(artifactDir);
    copyGolden(GOLDEN_DIR, artifactDir);
    writeFileSync(path.join(artifactDir, "config.json"), JSON.stringify({ diagram: { maxNodes: 2 } }));

    const results = tempResultsDir();
    const { code, stdout } = await runCaptured(["--dir", artifactDir, "--gate"], results);
    expect(code).toBe(1);
    expect(stdout[stdout.length - 1]).toBe("mapquality: GATE FAIL (M2)");
  });

  test("--gate fails with parse when a fence is malformed", async () => {
    const artifactDir = mkdtempSync(path.join(tmpdir(), "greplost-mapquality-artifact-"));
    cleanupDirs.push(artifactDir);
    writeFileSync(path.join(artifactDir, "INDEX.md"), "# tiny\n\nshort\n");
    mkdirSync(path.join(artifactDir, "repo"), { recursive: true });
    writeFileSync(
      path.join(artifactDir, "repo", "MAP.md"),
      "# tiny: package map\n\n```mermaid\ngraph LR\n  a[\"A\"]\n  a -->\n```\n\n",
    );

    const results = tempResultsDir();
    const { code, stdout } = await runCaptured(["--dir", artifactDir, "--gate"], results);
    expect(code).toBe(1);
    expect(stdout[stdout.length - 1]).toBe("mapquality: GATE FAIL (parse)");
  });

  test("--gate fails with M1 when INDEX.md is missing", async () => {
    const artifactDir = mkdtempSync(path.join(tmpdir(), "greplost-mapquality-artifact-"));
    cleanupDirs.push(artifactDir);
    // No INDEX.md at all: M1 has nothing to measure and must count as a miss, not a
    // vacuous pass (mirrors the truth-empty guard other suites use for the same reason).
    mkdirSync(path.join(artifactDir, "repo"), { recursive: true });
    writeFileSync(path.join(artifactDir, "repo", "MAP.md"), "# tiny: package map\n");

    const results = tempResultsDir();
    const { code, stdout } = await runCaptured(["--dir", artifactDir, "--gate"], results);
    expect(code).toBe(1);
    expect(stdout[stdout.length - 1]).toBe("mapquality: GATE FAIL (M1)");
  });

  test("a missing --dir fails cleanly with a non-zero exit code, never throws", async () => {
    const results = tempResultsDir();
    const { code } = await runCaptured(["--dir", path.join(REPO_ROOT, "does-not-exist-xyz")], results);
    expect(code).toBeGreaterThan(0);
  });
});

/** Recursively copies every file under `src` into `dest` (no symlink handling needed: the golden fixture is plain files). */
function copyGolden(src: string, dest: string): void {
  for (const rel of walkMarkdown(src)) {
    const from = path.join(src, rel);
    const to = path.join(dest, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(from));
  }
}
