/**
 * Eval 2 (freshness): the replay suite, exercised on a synthetic 5-commit history
 * of `fixtures/tiny-ts` so the whole file is hermetic: no corpus, no network.
 *
 * The two describes named here are gates in their own right (`gates/leaf-1.5.5.md`
 * G3 and G4): `drift injection` is F1 (every commit that staled the map was caught
 * by `verify`), `equivalence` is F2 (the incremental tree and a full rebuild are
 * byte-identical at every checkpoint).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  compareArtifactTrees,
  createSyntheticHistory,
  missedGates,
  percentile,
  replay,
  run,
  type ReplaySummary,
} from "../src/replay.ts";

const temporaries: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-replay-test-${prefix}-`));
  temporaries.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** A summary with every field set, so a test can vary exactly one of them. */
function summaryOf(overrides: Partial<ReplaySummary>): ReplaySummary {
  return {
    target: "tiny-ts",
    commits: 5,
    driftCaught: 4,
    driftTotal: 4,
    f1CatchRate: 1,
    noops: 0,
    noopsNoSourceChange: 0,
    noopsNoArtifactChange: 0,
    f2Checks: 2,
    f2Mismatches: 0,
    verifyFailedAfterUpdate: [],
    verifyFalsePositives: [],
    anomalies: [],
    updateP50: 30,
    updateP95: 40,
    updateSamples: [30, 40],
    ...overrides,
  };
}

describe("drift injection", () => {
  test("every commit that stales the map is caught by verify", async () => {
    const { summary, steps } = await replay({ fixture: true, commits: 5, f2Every: 2 });

    expect(summary.commits).toBe(5);
    // Five commits, four replayed steps, each editing one source file.
    expect(steps).toHaveLength(4);
    expect(summary.driftTotal).toBe(4);
    expect(summary.driftCaught).toBe(4);
    expect(summary.f1CatchRate).toBe(1);
    for (const step of steps) {
      expect(step.drift).toBe("caught");
      expect(step.verifiedAfterUpdate).toBe(true);
      expect(step.updateMs).toBeGreaterThanOrEqual(0);
    }
    expect(summary.verifyFailedAfterUpdate).toEqual([]);
    expect(summary.anomalies).toEqual([]);
  }, 120_000);

  test("a commit that touches no source file is a no-op, not a miss", async () => {
    const { summary, steps } = await replay({
      fixture: true,
      commits: 5,
      f2Every: 0,
      syntheticDocsEvery: 2,
    });

    // Commits 2 and 4 of the five touch documentation only.
    const noops = steps.filter((step) => step.drift === "noop-no-source-change");
    expect(noops).toHaveLength(2);
    for (const step of noops) expect(step.sourceFilesChanged).toBe(0);

    expect(summary.noops).toBe(2);
    expect(summary.noopsNoSourceChange).toBe(2);
    expect(summary.driftTotal).toBe(2);
    expect(summary.driftCaught).toBe(2);
    expect(summary.f1CatchRate).toBe(1);
  }, 120_000);

  test("F1 is missed when a stale commit slips past verify", () => {
    expect(missedGates(summaryOf({}))).toEqual([]);
    expect(missedGates(summaryOf({ driftCaught: 3, f1CatchRate: 0.75 }))).toEqual(["F1"]);
    // Nothing measured is not a pass: an empty denominator would otherwise gate green.
    expect(missedGates(summaryOf({ driftTotal: 0, driftCaught: 0, f1CatchRate: null }))).toEqual(["F1"]);
  });
});

describe("equivalence", () => {
  test("a full rebuild is byte-identical to the incremental tree at every checkpoint", async () => {
    const { summary, steps } = await replay({ fixture: true, commits: 5, f2Every: 2 });

    expect(summary.f2Checks).toBeGreaterThanOrEqual(2);
    expect(summary.f2Mismatches).toBe(0);
    const checked = steps.filter((step) => step.f2 !== undefined);
    expect(checked.length).toBe(summary.f2Checks);
    for (const step of checked) {
      expect(step.f2?.mismatches).toEqual([]);
      // Not vacuous: two empty trees would also compare equal.
      expect(step.f2?.compared).toBeGreaterThan(0);
    }
  }, 120_000);

  test("a short history still gets one equivalence check", async () => {
    const { summary } = await replay({ fixture: true, commits: 3, f2Every: 50 });
    expect(summary.f2Checks).toBe(1);
    expect(summary.f2Mismatches).toBe(0);
  }, 120_000);

  test("compareArtifactTrees reports differing, missing and extra artifacts", () => {
    const a = scratch("tree-a");
    const b = scratch("tree-b");
    for (const root of [a, b]) mkdirSync(path.join(root, "repo"), { recursive: true });

    writeFileSync(path.join(a, "INDEX.md"), "# index\n");
    writeFileSync(path.join(b, "INDEX.md"), "# index\n");
    expect(compareArtifactTrees(a, b)).toEqual([]);

    writeFileSync(path.join(b, "INDEX.md"), "# index changed\n");
    writeFileSync(path.join(a, "repo", "MAP.md"), "# map\n");
    writeFileSync(path.join(b, "manifest.json"), "{}\n");
    expect(compareArtifactTrees(a, b)).toEqual(["INDEX.md", "manifest.json", "repo/MAP.md"]);
  });

  test("F2 is missed when a checkpoint mismatches or verify fails after an update", () => {
    expect(missedGates(summaryOf({ f2Mismatches: 1 }))).toEqual(["F2"]);
    expect(missedGates(summaryOf({ verifyFailedAfterUpdate: ["abc1234"] }))).toEqual(["F2"]);
    expect(missedGates(summaryOf({ verifyFalsePositives: ["abc1234"] }))).toEqual(["F2"]);
    expect(missedGates(summaryOf({ driftCaught: 0, f1CatchRate: 0, f2Mismatches: 2 }))).toEqual(["F1", "F2"]);
  });
});

describe("synthetic history", () => {
  test("creates one commit per requested step, each touching a source file", () => {
    const dir = scratch("history");
    const shas = createSyntheticHistory(dir, 4);
    expect(shas).toHaveLength(4);
    for (const sha of shas) expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // Oldest first: the first commit is the fixture as committed, the rest are edits.
    expect(existsSync(path.join(dir, "packages", "core", "src", "bus.ts"))).toBe(true);
  });

  test("is deterministic in its edits", () => {
    const one = scratch("history-1");
    const two = scratch("history-2");
    createSyntheticHistory(one, 4);
    createSyntheticHistory(two, 4);
    const read = (root: string): string =>
      readdirSync(path.join(root, "packages", "core", "src"))
        .sort()
        .map((name) => readFileSync(path.join(root, "packages", "core", "src", name), "utf8"))
        .join("\n");
    expect(read(one)).toBe(read(two));
  });
});

describe("percentile", () => {
  test("uses nearest rank over the sorted samples", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([10, 1, 5], 50)).toBe(5);
  });
});

describe("replay run", () => {
  test("--fixture --commits 5 --gate passes and writes a result", async () => {
    const results = scratch("results");
    const previous = process.env["GREPLOST_BENCH_RESULTS_DIR"];
    process.env["GREPLOST_BENCH_RESULTS_DIR"] = results;
    try {
      const code = await run(["--fixture", "--commits", "5", "--gate"]);
      expect(code).toBe(0);
    } finally {
      if (previous === undefined) delete process.env["GREPLOST_BENCH_RESULTS_DIR"];
      else process.env["GREPLOST_BENCH_RESULTS_DIR"] = previous;
    }

    const files = readdirSync(results).filter((name) => name.startsWith("replay-"));
    expect(files).toHaveLength(1);
    const payload = JSON.parse(readFileSync(path.join(results, files[0] as string), "utf8")) as Record<
      string,
      unknown
    >;
    expect(payload["suite"]).toBe("replay-fixture");
    expect(payload["machine"]).toBeDefined();
    const summary = payload["summary"] as Record<string, unknown>;
    for (const key of [
      "commits",
      "driftCaught",
      "driftTotal",
      "noops",
      "f2Checks",
      "f2Mismatches",
      "updateP50",
      "updateP95",
    ]) {
      expect(summary[key]).toBeDefined();
    }
    expect(summary["f1CatchRate"]).toBe(1);
    expect((payload["gate"] as Record<string, unknown>)["passed"]).toBe(true);
  }, 120_000);

  test("--dry-run produces the output shape without replaying", async () => {
    const code = await run(["--fixture", "--dry-run"]);
    expect(code).toBe(0);
  });

  test("an unknown repo is an argument error, not a crash", async () => {
    const code = await run(["--repo", "definitely-not-a-corpus-repo", "--gate"]);
    expect(code).toBe(2);
  });

  test("a malformed --commits is an argument error, not a silent 500-commit walk", async () => {
    expect(await run(["--fixture", "--commits", "abc", "--gate"])).toBe(2);
    expect(await run(["--fixture", "--commits", "1", "--gate"])).toBe(2);
    expect(await run(["--fixture", "--f2-every", "-3", "--gate"])).toBe(2);
  });
});
