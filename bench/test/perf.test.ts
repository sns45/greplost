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
  SCENARIOS,
  missedTargets,
  perf,
  regressedScenarios,
  run,
  summarize,
  targetsFor,
  type RepoPerf,
} from "../src/perf.ts";

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
    const { repos } = await perf({ fixture: true, iterations: 2, warmups: 0 });
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
    const { repos } = await perf({ fixture: true, iterations: 2, warmups: 0 });
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

describe("perf run", () => {
  test("--fixture --gate passes the absolute targets and writes a result", async () => {
    const results = scratch("results");
    const previous = process.env["GREPLOST_BENCH_RESULTS_DIR"];
    process.env["GREPLOST_BENCH_RESULTS_DIR"] = results;
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
