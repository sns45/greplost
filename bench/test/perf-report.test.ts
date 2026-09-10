/**
 * Bench 3 (performance): what a perf run and `bench/RESULTS.md` say about it.
 *
 * The mechanism itself is measured in `perf.test.ts`; this file is about what a
 * reader is told. Three things have to be visible or the runner speed factor is
 * a number that quietly moves a budget: the printed table has to carry the raw
 * budget, the factor, the reference and the scaled budget together; the summary
 * table `readme:sync` copies into README.md has to state the rule beside the P1
 * and P2 rows; and the Bench 3 section has to show every repo, which since one
 * perf run measures one repo means merging every payload the index pins.
 */
import { describe, expect, test } from "bun:test";

import {
  MAX_RUNNER_FACTOR,
  RUNNER_ITERATIONS,
  RUNNER_REFERENCE_MS,
  reportLines,
  runnerFactor,
  type RepoPerf,
  type RunnerSpeed,
} from "../src/perf.ts";
import { bench3Section } from "../src/report-evals.ts";
import { singleTool } from "../src/report-sections.ts";
import { emptySection } from "../src/results-md.ts";

/** A one-scenario repo result, so a test can vary exactly one number. */
function repoWith(name: string, scenario: string, p50: number, p95 = p50, tier = "S"): RepoPerf {
  return {
    name,
    tier,
    files: 12,
    scenarios: [
      {
        scenario,
        iterations: 2,
        ms: { p50, p95, min: p50, max: p95, mean: (p50 + p95) / 2, samples: [p50, p95] },
        processMs: { p50: p50 + 100, p95: p95 + 100, min: p50, max: p95, mean: p50, samples: [] },
        peakRssBytes: 100 * 1024 * 1024,
        detail: {},
      },
    ],
  };
}

describe("perf report and RESULTS.md", () => {
  const speedOf = (measuredMs: number): RunnerSpeed => ({
    measuredMs,
    referenceMs: 100,
    iterations: RUNNER_ITERATIONS,
    factor: runnerFactor(measuredMs, 100),
  });

  test("the report prints the raw budget, the factor, the reference, the scaled budget and the measurement", () => {
    const lines = reportLines([repoWith("anyq", "full", 1400)], speedOf(200));
    const text = lines.join("\n");
    // The factor line: what was measured, over how many builds, against what.
    expect(text).toContain("runner factor 2.00");
    expect(text).toContain("median 200ms");
    expect(text).toContain(`over ${RUNNER_ITERATIONS} builds`);
    expect(text).toContain("reference 100ms");
    expect(text).toContain(`fail above ${MAX_RUNNER_FACTOR.toFixed(2)}`);
    // The budget cells: the scaled bound a repo is held to, and the raw one it came from.
    expect(text).toContain("<=2000ms (raw 1000ms x 2.00)");
    expect(text).toContain("<=1000ms (raw 500ms x 2.00)");
    // P3 is reported rather than gated, so nothing scales it.
    expect(text).toContain("<=500MB at 10k files");
    // The measurement itself is still there beside the budget.
    expect(text).toContain("1400ms");

    // A dry run has measured no machine, and must not print a factor it invented.
    const dry = reportLines([repoWith("anyq", "full", 0)], null).join("\n");
    expect(dry).toContain("runner factor not measured");
    expect(dry).toContain("<=1000ms");
    expect(dry).not.toContain("raw 1000ms x");
  });

  test("the reference constant is a positive number of milliseconds", () => {
    expect(RUNNER_REFERENCE_MS).toBeGreaterThan(0);
    expect(RUNNER_ITERATIONS).toBeGreaterThan(0);
    expect(MAX_RUNNER_FACTOR).toBe(8);
  });

  test("RESULTS.md states the scaling rule beside the P1 and P2 rows README carries", () => {
    const perfPayload = {
      data: {
        repos: [{ name: "anyq", files: 148, tier: "S", scenarios: [{ scenario: "full", ms: { p50: 203, p95: 216 } }] }],
      },
      file: "perf-2026-09-10-abcdef1.json",
    };
    // The single-tool section, because that is the table `readme:sync` copies
    // into README.md: a rule that only the Bench 3 section states never reaches
    // the document most readers see.
    const sections = {
      eval1: emptySection(),
      eval2: emptySection(),
      bench3: bench3Section([perfPayload], "docs/assets"),
      eval4: emptySection(),
      eval5: emptySection(),
      mapquality: emptySection(),
    };
    const notes = singleTool(sections, null, null, perfPayload, null, null).notes.join("\n");
    expect(notes).toContain("max(1, measured / reference)");
    expect(notes).toContain("bench/src/perf.ts");
    expect(notes).toContain(String(MAX_RUNNER_FACTOR));
    // And not twice in one document.
    expect(sections.bench3.notes.join("\n")).not.toContain("max(1, measured / reference)");
  });

  test("the perf section merges the payloads the index pins, newest first", () => {
    const payloadFor = (file: string, repo: string, p50: number): { data: Record<string, unknown>; file: string } => ({
      data: {
        date: file.slice(5, 15),
        greplostSha: file.slice(16, 23),
        repos: [{ name: repo, files: 148, tier: "S", scenarios: [{ scenario: "full", ms: { p50, p95: p50 } }] }],
      },
      file,
    });
    // Oldest first in, as the index pins them.
    const section = bench3Section(
      [payloadFor("perf-2026-09-10-aaaaaaa.json", "anyq", 203), payloadFor("perf-2026-09-10-bbbbbbb.json", "gin", 135)],
      "docs/assets",
    );
    const everyScenario = section.groups.find((group) => group.name === "every scenario");
    // Both repos are in the table, sorted by name whatever order they arrived in.
    expect(everyScenario?.rows.map((row) => row.metric)).toEqual(["anyq full", "gin full"]);
    // The headline rows come from the first repo by name, as they did when one
    // payload carried both.
    expect(section.groups[0]?.rows[0]?.detail).toContain("anyq full");
    // The newest payload names the provenance, and the note says what was merged.
    expect(section.provenance).toContain("bbbbbbb");
    const merged = section.notes.join("\n");
    expect(merged).toContain("merge 2 perf payloads, newest first");
    expect(merged).toContain("`perf-2026-09-10-bbbbbbb.json` (gin)");
    expect(merged).toContain("`perf-2026-09-10-aaaaaaa.json` (anyq)");

    // A repo measured twice keeps the newest numbers and appears once.
    const twice = bench3Section(
      [payloadFor("perf-2026-09-09-aaaaaaa.json", "anyq", 900), payloadFor("perf-2026-09-10-bbbbbbb.json", "anyq", 203)],
      "docs/assets",
    );
    const rows = twice.groups.find((group) => group.name === "every scenario")?.rows ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.measured).toContain("203");

    // No payload at all is the empty section, not a crash.
    expect(bench3Section([], "docs/assets").ran).toBe(false);
  });
});
