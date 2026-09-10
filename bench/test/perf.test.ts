/**
 * Bench 3 (performance): the perf suite on `fixtures/tiny-ts`, hermetic.
 *
 * `perf report` is a gate in its own right (`gates/leaf-1.5.5.md` G7): every
 * scenario reports p50, p95 and a peak RSS, and the regression rule (p50 worse
 * than the last result on the same CPU by more than 15 %) is exercised against
 * hand-built prior payloads rather than against whatever happens to be in
 * `bench/results/`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { peakRssBytes } from "../src/perf-child.ts";
import {
  MAX_RUNNER_FACTOR,
  RUNNER_ITERATIONS,
  RUNNER_REFERENCE_MS,
  SCENARIOS,
  gateMisses,
  missedTargets,
  perf,
  regressedScenarios,
  reportLines,
  run,
  runnerFactor,
  scaleTargets,
  summarize,
  targetsFor,
  type RepoPerf,
  type RunnerSpeed,
} from "../src/perf.ts";
import { bench3Section } from "../src/report-evals.ts";

const temporaries: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-perf-test-${prefix}-`));
  temporaries.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

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

describe("perf report", () => {
  test("summarize reports p50, p95, min, max and mean", () => {
    const stats = summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(stats.p50).toBe(50);
    expect(stats.p95).toBe(100);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(100);
    expect(stats.mean).toBe(55);
    expect(stats.samples).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);

    const empty = summarize([]);
    expect(empty.p50).toBe(0);
    expect(empty.p95).toBe(0);
    expect(empty.samples).toEqual([]);
  });

  test("absolute targets follow the file count (P1, P2)", () => {
    expect(targetsFor(12)).toEqual({ p1Ms: 1000, p2Ms: 500 });
    expect(targetsFor(1000)).toEqual({ p1Ms: 1000, p2Ms: 500 });
    expect(targetsFor(10_000)).toEqual({ p1Ms: 10_000, p2Ms: 1000 });
  });

  test("missedTargets names P1 and P2 independently", () => {
    expect(missedTargets([repoWith("tiny-ts", "full", 200)])).toEqual([]);
    expect(missedTargets([repoWith("tiny-ts", "full", 5000)])).toEqual(["P1"]);
    // P2 is gated on p95, P1 on p50 (see the ruling in perf.ts).
    expect(missedTargets([repoWith("tiny-ts", "incremental-1", 100, 900)])).toEqual(["P2"]);
    expect(missedTargets([repoWith("tiny-ts", "incremental-1", 100, 200)])).toEqual([]);
  });

  test("the absolute targets are gated for tiers S and M only", () => {
    // The same miss, tier by tier: gated in S and M, ignored in L and XL, where
    // the bench spec does not apply the absolute bounds.
    expect(missedTargets([repoWith("anyq", "full", 5000, 5000, "S")])).toEqual(["P1"]);
    expect(missedTargets([repoWith("hono", "full", 5000, 5000, "M")])).toEqual(["P1"]);
    expect(missedTargets([repoWith("vite", "full", 5000, 5000, "L")])).toEqual([]);
    expect(missedTargets([repoWith("TypeScript", "full", 5000, 5000, "XL")])).toEqual([]);
    expect(missedTargets([repoWith("vite", "incremental-1", 100, 9000, "L")])).toEqual([]);
    // A gated repo in the same run still reports its own miss.
    expect(
      missedTargets([repoWith("vite", "full", 5000, 5000, "L"), repoWith("anyq", "incremental-1", 100, 900, "S")]),
    ).toEqual(["P2"]);
  });

  test("the regression rule still applies outside the gated tiers", () => {
    const machine = { cpu: "Apple M3 Pro" };
    const prior = {
      machine: { cpu: "Apple M3 Pro" },
      repos: [{ name: "vite", tier: "L", files: 1136, scenarios: [{ scenario: "full", ms: { p50: 800 } }] }],
    };
    expect(regressedScenarios([repoWith("vite", "full", 1000, 1000, "L")], prior, machine)).toEqual(["vite/full"]);
  });

  test("peak RSS units are inferred from the platform and the resident set together", () => {
    const mb = 1024 * 1024;
    // macOS: getrusage reports bytes, and the raw value is close to the resident set.
    expect(peakRssBytes(120 * mb, 118 * mb, "darwin")).toBe(120 * mb);
    // Linux: kilobytes, a thousand times smaller than the resident set in bytes.
    expect(peakRssBytes(120 * 1024, 118 * mb, "linux")).toBe(120 * mb);
    // A darwin reading that looks like kilobytes is still scaled: both signals must agree.
    expect(peakRssBytes(120 * 1024, 118 * mb, "darwin")).toBe(120 * mb);
    // A non-darwin platform is never treated as bytes, whatever the ratio says.
    expect(peakRssBytes(120 * 1024, 100 * 1024, "linux")).toBe(120 * mb);
  });

  test("regression comparison flags a p50 more than 15 % worse on the same CPU", () => {
    const machine = { cpu: "Apple M3 Pro" };
    const prior = {
      machine: { cpu: "Apple M3 Pro" },
      repos: [{ name: "tiny-ts", files: 12, scenarios: [{ scenario: "full", ms: { p50: 100 } }] }],
    };

    expect(regressedScenarios([repoWith("tiny-ts", "full", 110)], prior, machine)).toEqual([]);
    expect(regressedScenarios([repoWith("tiny-ts", "full", 115)], prior, machine)).toEqual([]);
    expect(regressedScenarios([repoWith("tiny-ts", "full", 130)], prior, machine)).toEqual(["tiny-ts/full"]);
    // Faster is never a regression.
    expect(regressedScenarios([repoWith("tiny-ts", "full", 50)], prior, machine)).toEqual([]);
  });

  test("regression comparison is skipped without a comparable prior result", () => {
    const machine = { cpu: "Apple M3 Pro" };
    const prior = {
      machine: { cpu: "Some Other CPU" },
      repos: [{ name: "tiny-ts", files: 12, scenarios: [{ scenario: "full", ms: { p50: 100 } }] }],
    };
    expect(regressedScenarios([repoWith("tiny-ts", "full", 900)], undefined, machine)).toEqual([]);
    expect(regressedScenarios([repoWith("tiny-ts", "full", 900)], prior, machine)).toEqual([]);
    // A prior run that never measured this scenario cannot be regressed against.
    const other = { machine: { cpu: "Apple M3 Pro" }, repos: [{ name: "hono", scenarios: [] }] };
    expect(regressedScenarios([repoWith("tiny-ts", "full", 900)], other, machine)).toEqual([]);
  });

  test("the fixture run reports p50, p95 and peak RSS per scenario", async () => {
    const { repos, runner } = await perf({ fixture: true, iterations: 2, warmups: 0, runnerIterations: 2 });
    // The runner factor is measured, not assumed: two real builds of the fixture
    // through the same child the scenarios use, against the recorded reference.
    expect(runner.iterations).toBe(2);
    expect(runner.measuredMs).toBeGreaterThan(0);
    expect(runner.referenceMs).toBe(RUNNER_REFERENCE_MS);
    expect(runner.factor).toBeGreaterThanOrEqual(1);
    expect(runner.factor).toBe(runnerFactor(runner.measuredMs, RUNNER_REFERENCE_MS));
    expect(repos).toHaveLength(1);
    const repo = repos[0] as RepoPerf;
    expect(repo.name).toBe("tiny-ts");
    expect(repo.tier).toBe("S");
    expect(repo.files).toBeGreaterThan(0);
    expect(repo.scenarios.map((s) => s.scenario)).toEqual([...SCENARIOS]);
    for (const scenario of repo.scenarios) {
      expect(scenario.iterations).toBe(2);
      expect(scenario.ms.samples).toHaveLength(2);
      expect(scenario.ms.p50).toBeGreaterThan(0);
      expect(scenario.ms.p95).toBeGreaterThanOrEqual(scenario.ms.p50);
      expect(scenario.processMs.p50).toBeGreaterThan(0);
      expect(scenario.peakRssBytes).toBeGreaterThan(0);
    }
    // Every mutating scenario names what it changed, so a number is traceable.
    const edits = repo.scenarios.find((s) => s.scenario === "incremental-10");
    expect(edits?.subject).toHaveLength(10);
    expect(repo.scenarios.find((s) => s.scenario === "package-rename")?.subject).toHaveLength(1);
    expect(repo.scenarios.find((s) => s.scenario === "full")?.subject).toBeUndefined();
  }, 300_000);

  test("every timed iteration does the work its scenario claims", async () => {
    const { repos } = await perf({ fixture: true, iterations: 2, warmups: 0, runnerIterations: 1 });
    const scenarios = new Map((repos[0] as RepoPerf).scenarios.map((s) => [s.scenario, s]));
    const detailOf = (name: string): Record<string, number> => scenarios.get(name)?.detail ?? {};

    // P1: a full rebuild over a `.greplost/` that already holds the right bytes
    // writes nothing, and would time the build without the write half.
    expect(detailOf("full")["written"]).toBeGreaterThan(0);
    expect(detailOf("full")["reparsed"]).toBeGreaterThan(0);

    // The rename is the one scenario that reproduces its own end state, so
    // without a re-baseline every iteration after the first changes nothing.
    // `reparsed` stays 0 by design: the parse cache is content-addressed, so a
    // renamed file is a cache hit. What has to move is the artifacts.
    expect(detailOf("package-rename")["written"]).toBeGreaterThan(0);
    expect(detailOf("package-rename")["dirty"]).toBeGreaterThan(0);

    // The edit scenarios carry a fresh marker each iteration, so they reparse
    // exactly what they touched.
    expect(detailOf("incremental-1")["reparsed"]).toBe(1);
    expect(detailOf("incremental-1")["written"]).toBeGreaterThan(0);
    expect(detailOf("incremental-10")["reparsed"]).toBe(10);
    expect(detailOf("incremental-10")["written"]).toBeGreaterThan(0);
  }, 300_000);
});

describe("runner speed factor", () => {
  const speedOf = (measuredMs: number): RunnerSpeed => ({
    measuredMs,
    referenceMs: 100,
    iterations: RUNNER_ITERATIONS,
    factor: runnerFactor(measuredMs, 100),
  });

  test("the factor is 1 when the runner is at or faster than the reference", () => {
    expect(runnerFactor(100, 100)).toBe(1);
    expect(runnerFactor(50, 100)).toBe(1);
    expect(runnerFactor(1, 100)).toBe(1);
    // A reference or a measurement that is not a positive number says nothing
    // about the machine, so it must not scale a budget either way.
    expect(runnerFactor(0, 100)).toBe(1);
    expect(runnerFactor(100, 0)).toBe(1);
    expect(runnerFactor(Number.NaN, 100)).toBe(1);
  });

  test("the factor is the ratio when the runner is slower", () => {
    expect(runnerFactor(150, 100)).toBe(1.5);
    expect(runnerFactor(400, 100)).toBe(4);
    expect(runnerFactor(1000, 100)).toBe(10);
    // Three decimals, so the number in the report is the number in the payload.
    expect(runnerFactor(1234, 1000)).toBe(1.234);
  });

  test("the budgets scale by the factor and nothing else", () => {
    expect(scaleTargets({ p1Ms: 1000, p2Ms: 500 }, 1)).toEqual({ p1Ms: 1000, p2Ms: 500 });
    expect(scaleTargets({ p1Ms: 1000, p2Ms: 500 }, 2.5)).toEqual({ p1Ms: 2500, p2Ms: 1250 });
    expect(scaleTargets({ p1Ms: 10_000, p2Ms: 1000 }, 1.5)).toEqual({ p1Ms: 15_000, p2Ms: 1500 });
  });

  test("a scaled budget is what the absolute targets are gated against", () => {
    // 1400 ms of full build misses a 1000 ms budget and clears a 2000 ms one.
    expect(missedTargets([repoWith("anyq", "full", 1400)])).toEqual(["P1"]);
    expect(missedTargets([repoWith("anyq", "full", 1400)], 1)).toEqual(["P1"]);
    expect(missedTargets([repoWith("anyq", "full", 1400)], 2)).toEqual([]);
    // The same for P2, which is gated on p95.
    expect(missedTargets([repoWith("anyq", "incremental-1", 100, 700)], 1)).toEqual(["P2"]);
    expect(missedTargets([repoWith("anyq", "incremental-1", 100, 700)], 2)).toEqual([]);
    // Exactly at the scaled budget passes.
    expect(missedTargets([repoWith("anyq", "full", 1500)], 1.5)).toEqual([]);
  });

  test("a factor above the cap fails on its own, whatever the scaled budgets say", () => {
    const fast = speedOf(100);
    const slow = speedOf(100 * MAX_RUNNER_FACTOR + 1);
    expect(slow.factor).toBeGreaterThan(MAX_RUNNER_FACTOR);

    // A machine that slow says nothing about greplost, so the target and the
    // regression comparisons are dropped rather than reported beside it.
    expect(gateMisses([repoWith("anyq", "full", 9_000_000)], slow, ["anyq/full"])).toEqual(["runner"]);
    expect(gateMisses([repoWith("anyq", "full", 100)], slow, [])).toEqual(["runner"]);
    // At the cap exactly, the run still counts.
    expect(gateMisses([repoWith("anyq", "full", 100)], speedOf(100 * MAX_RUNNER_FACTOR), [])).toEqual([]);
    // Inside the cap the misses are the target ids, plus the regression rule.
    expect(gateMisses([repoWith("anyq", "full", 1400)], fast, [])).toEqual(["P1"]);
    expect(gateMisses([repoWith("anyq", "full", 100)], fast, ["anyq/full"])).toEqual(["regression"]);
    expect(gateMisses([repoWith("anyq", "full", 1400)], fast, ["anyq/full"])).toEqual(["P1", "regression"]);
  });

  test("the regression rule compares machine equivalent p50s, not wall clock", () => {
    const machine = { cpu: "Apple M3 Pro" };
    // A baseline measured on a machine three times slower than the reference: its
    // 300 ms is 100 ms of the reference machine's time.
    const slowPrior = {
      machine: { cpu: "Apple M3 Pro" },
      runner: { factor: 3 },
      repos: [{ name: "anyq", files: 148, scenarios: [{ scenario: "full", ms: { p50: 300 } }] }],
    };
    const tolerance = 0.15;
    // 110 ms on a quiet machine is 10 % worse than the baseline's 100, not 63 % better.
    expect(regressedScenarios([repoWith("anyq", "full", 110)], slowPrior, machine, tolerance, 1)).toEqual([]);
    expect(regressedScenarios([repoWith("anyq", "full", 130)], slowPrior, machine, tolerance, 1)).toEqual(["anyq/full"]);
    // The same run measured on the same slow machine: 330 ms is 110 ms equivalent.
    expect(regressedScenarios([repoWith("anyq", "full", 330)], slowPrior, machine, tolerance, 3)).toEqual([]);
    expect(regressedScenarios([repoWith("anyq", "full", 390)], slowPrior, machine, tolerance, 3)).toEqual(["anyq/full"]);

    // A payload written before the factor existed is taken at 1, which is what it
    // was measured as.
    const oldPrior = {
      machine: { cpu: "Apple M3 Pro" },
      repos: [{ name: "anyq", files: 148, scenarios: [{ scenario: "full", ms: { p50: 100 } }] }],
    };
    expect(regressedScenarios([repoWith("anyq", "full", 130)], oldPrior, machine, tolerance, 1)).toEqual(["anyq/full"]);
    // Three times slower on the day, and the same code: not a regression.
    expect(regressedScenarios([repoWith("anyq", "full", 330)], oldPrior, machine, tolerance, 3)).toEqual([]);
  });

  test("the report prints the raw budget, the factor, the reference, the scaled budget and the measurement", () => {
    const lines = reportLines([repoWith("anyq", "full", 1400)], speedOf(200));
    const text = lines.join("\n");
    // The factor line: what was measured, over how many builds, against what.
    expect(text).toContain("runner factor 2.00");
    expect(text).toContain("median 200ms");
    expect(text).toContain(`over ${RUNNER_ITERATIONS} builds`);
    expect(text).toContain("reference 100ms");
    expect(text).toContain("fail above 4.00");
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
    expect(MAX_RUNNER_FACTOR).toBe(4);
  });

  test("RESULTS.md states the scaling rule in its perf section", () => {
    const section = bench3Section(
      [
        {
          data: {
            repos: [
              { name: "anyq", files: 148, tier: "S", scenarios: [{ scenario: "full", ms: { p50: 203, p95: 216 } }] },
            ],
          },
          file: "perf-2026-09-10-abcdef1.json",
        },
      ],
      "docs/assets",
    );
    const notes = section.notes.join("\n");
    expect(notes).toContain("max(1, measured / reference)");
    expect(notes).toContain("bench/src/perf.ts");
    expect(notes).toContain("4");
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

describe("perf run", () => {
  test("--fixture --gate passes the absolute targets and writes a result", async () => {
    const results = scratch("results");
    const previous = process.env["GREPLOST_BENCH_RESULTS_DIR"];
    process.env["GREPLOST_BENCH_RESULTS_DIR"] = results;
    // The factor is measured for real here, and that is what makes this test
    // survive a loaded machine: the whole bench suite runs its files in
    // parallel, so the twelve-file fixture can take longer than the 500 ms P2
    // budget, and the run is held to a budget scaled by exactly how much slower
    // the machine was when it measured itself.
    try {
      const code = await run(["--fixture", "--gate", "--iterations", "2", "--warmups", "0"]);
      expect(code).toBe(0);
    } finally {
      if (previous === undefined) delete process.env["GREPLOST_BENCH_RESULTS_DIR"];
      else process.env["GREPLOST_BENCH_RESULTS_DIR"] = previous;
    }

    const files = readdirSync(results).filter((name) => name.startsWith("perf-"));
    expect(files).toHaveLength(1);
    const payload = JSON.parse(readFileSync(path.join(results, files[0] as string), "utf8")) as Record<
      string,
      unknown
    >;
    expect(payload["suite"]).toBe("perf-fixture");
    expect(payload["machine"]).toBeDefined();
    const repos = payload["repos"] as Array<Record<string, unknown>>;
    expect(repos).toHaveLength(1);
    expect(repos[0]?.["tier"]).toBe("S");
    const scenarios = repos[0]?.["scenarios"] as Array<Record<string, unknown>>;
    expect(scenarios.map((s) => s["scenario"])).toEqual([...SCENARIOS]);
    for (const scenario of scenarios) {
      expect((scenario["ms"] as Record<string, unknown>)["p50"]).toBeDefined();
      expect((scenario["ms"] as Record<string, unknown>)["p95"]).toBeDefined();
      expect(scenario["peakRssBytes"]).toBeDefined();
    }
    expect((payload["gate"] as Record<string, unknown>)["passed"]).toBe(true);

    // The runner factor, the reference and the measurement behind it travel with
    // the run, beside both the raw and the scaled budgets.
    const runner = payload["runner"] as Record<string, unknown>;
    const factor = runner["factor"] as number;
    expect(runner["referenceMs"]).toBe(RUNNER_REFERENCE_MS);
    expect(runner["measuredMs"]).toBeGreaterThan(0);
    expect(runner["iterations"]).toBe(RUNNER_ITERATIONS);
    expect(factor).toBe(runnerFactor(runner["measuredMs"] as number, RUNNER_REFERENCE_MS));
    expect(payload["maxRunnerFactor"]).toBe(MAX_RUNNER_FACTOR);
    expect(payload["targets"]).toEqual({ "tiny-ts": { p1Ms: 1000, p2Ms: 500 } });
    expect(payload["scaledTargets"]).toEqual({ "tiny-ts": scaleTargets({ p1Ms: 1000, p2Ms: 500 }, factor) });
  }, 300_000);

  test("a runner past the cap is GATE FAIL (runner), and the payload says so", async () => {
    const results = scratch("cap-results");
    const previous = process.env["GREPLOST_BENCH_RESULTS_DIR"];
    process.env["GREPLOST_BENCH_RESULTS_DIR"] = results;
    // The one place the supplied median earns its keep: a machine five times
    // slower than the reference is not something a test can arrange, and the cap
    // is the whole point of measuring the runner at all.
    process.env["GREPLOST_PERF_RUNNER_MS"] = String(RUNNER_REFERENCE_MS * 5);
    let code: number;
    try {
      code = await run(["--fixture", "--gate", "--iterations", "1", "--warmups", "0"]);
    } finally {
      if (previous === undefined) delete process.env["GREPLOST_BENCH_RESULTS_DIR"];
      else process.env["GREPLOST_BENCH_RESULTS_DIR"] = previous;
      delete process.env["GREPLOST_PERF_RUNNER_MS"];
    }
    expect(code).toBe(1);

    const files = readdirSync(results).filter((name) => name.startsWith("perf-"));
    const payload = JSON.parse(readFileSync(path.join(results, files[0] as string), "utf8")) as Record<string, unknown>;
    expect((payload["runner"] as Record<string, unknown>)["factor"]).toBe(5);
    // `runner` alone: the scaled budgets and the p50 comparison are both noise on
    // a machine that slow, so nothing else is claimed about the run.
    expect(payload["gate"]).toEqual({ passed: false, missed: ["runner"] });
  }, 300_000);

  test("--dry-run produces the output shape without measuring", async () => {
    const code = await run(["--fixture", "--dry-run"]);
    expect(code).toBe(0);
  });

  test("an unknown repo is an argument error, not a crash", async () => {
    const code = await run(["--repo", "definitely-not-a-corpus-repo", "--gate"]);
    expect(code).toBe(2);
  });

  test("a malformed --iterations is an argument error, not a silent ten-iteration run", async () => {
    expect(await run(["--fixture", "--iterations", "abc", "--gate"])).toBe(2);
    expect(await run(["--fixture", "--iterations", "0", "--gate"])).toBe(2);
    expect(await run(["--fixture", "--warmups", "-1", "--gate"])).toBe(2);
  });
});
