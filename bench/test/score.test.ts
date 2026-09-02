/**
 * Scoring and results-io tests (leaf 1.5.1, gates G2, G4 and G6).
 *
 * Scores are hand-built here rather than taken from a build: the point of the suite is
 * that the arithmetic and the empty-set conventions are pinned, so a later change to a
 * gate threshold cannot quietly change what "precision 1.0" means.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  type CallEdge,
  type Edge,
  type FileRecord,
  type ImportEdge,
  type Snapshot,
} from "@greplost/core/schema";
import { edgeKey, exportKeys, jaccardCycles, scoreEdges, scoreSet } from "../src/score.ts";
import { gitSha7, latestResult, todayIso, writeResult } from "../src/results-io.ts";
import { locate, missedMetrics, scoreAgainstTruth, scoredFiles } from "../src/structural.ts";
import type { Truth } from "../src/truth/ts.ts";

const edge = (from: string, to: string, kind: Edge["kind"] = "import"): Edge => ({
  from,
  to,
  kind,
  confidence: "high",
});

describe("scoring", () => {
  test("scores a perfect match", () => {
    const score = scoreSet(["a", "b", "c"], ["a", "b", "c"]);
    expect(score).toEqual({
      precision: 1,
      recall: 1,
      f1: 1,
      tp: 3,
      fp: 0,
      fn: 0,
      falsePositives: [],
      falseNegatives: [],
    });
  });

  test("scores a partial match and reports the misses sorted", () => {
    const score = scoreSet(["b", "a", "x", "y"], ["a", "b", "c"]);
    expect(score.tp).toBe(2);
    expect(score.fp).toBe(2);
    expect(score.fn).toBe(1);
    expect(score.precision).toBeCloseTo(0.5, 10);
    expect(score.recall).toBeCloseTo(2 / 3, 10);
    expect(score.f1).toBeCloseTo(2 * (0.5 * (2 / 3)) / (0.5 + 2 / 3), 10);
    expect(score.falsePositives).toEqual(["x", "y"]);
    expect(score.falseNegatives).toEqual(["c"]);
  });

  test("treats both sides as sets: duplicates never change a score", () => {
    expect(scoreSet(["a", "a", "b"], ["b", "b", "a"])).toEqual(scoreSet(["a", "b"], ["a", "b"]));
  });

  test("predicting nothing against a non-empty truth is precise but has no recall", () => {
    const score = scoreSet([], ["a", "b"]);
    expect(score).toEqual({
      precision: 1,
      recall: 0,
      f1: 0,
      tp: 0,
      fp: 0,
      fn: 2,
      falsePositives: [],
      falseNegatives: ["a", "b"],
    });
  });

  test("predicting against an empty truth has no precision but full recall", () => {
    const score = scoreSet(["a"], []);
    expect(score.precision).toBe(0);
    expect(score.recall).toBe(1);
    expect(score.f1).toBe(0);
    expect(score.falsePositives).toEqual(["a"]);
  });

  test("two empty sets agree perfectly", () => {
    expect(scoreSet([], [])).toEqual({
      precision: 1,
      recall: 1,
      f1: 1,
      tp: 0,
      fp: 0,
      fn: 0,
      falsePositives: [],
      falseNegatives: [],
    });
  });

  test("edgeKey is (from, to) only", () => {
    expect(edgeKey(edge("a.ts", "b.ts"))).toBe("a.ts -> b.ts");
    expect(edgeKey(edge("a.ts", "b.ts", "reexport"))).toBe(edgeKey(edge("a.ts", "b.ts", "import")));
  });

  test("scoreEdges compares on (from, to), ignoring kind, symbols and confidence", () => {
    const pred: Edge[] = [
      { from: "a.ts", to: "b.ts", kind: "reexport", symbols: ["x"], confidence: "med" },
      { from: "a.ts", to: "c.ts", kind: "import", confidence: "high" },
    ];
    const truth: Edge[] = [
      { from: "a.ts", to: "b.ts", kind: "import", symbols: ["y"], confidence: "high" },
      { from: "a.ts", to: "d.ts", kind: "import", confidence: "high" },
    ];
    const score = scoreEdges(pred, truth);
    expect(score.tp).toBe(1);
    expect(score.falsePositives).toEqual(["a.ts -> c.ts"]);
    expect(score.falseNegatives).toEqual(["a.ts -> d.ts"]);
    expect(score.precision).toBe(0.5);
    expect(score.recall).toBe(0.5);
  });

  test("scoreEdges on two empty edge lists is a perfect score", () => {
    expect(scoreEdges([], []).f1).toBe(1);
  });

  test("exportKeys flattens a file -> names record into sorted `file#name` keys", () => {
    expect(exportKeys({ "b.ts": ["two", "one"], "a.ts": ["only"], "c.ts": [] })).toEqual([
      "a.ts#only",
      "b.ts#one",
      "b.ts#two",
    ]);
  });

  test("jaccardCycles is 1 for the same cycles in any order", () => {
    expect(jaccardCycles([["b", "a"]], [["a", "b"]])).toBe(1);
    expect(
      jaccardCycles(
        [
          ["c", "d"],
          ["a", "b"],
        ],
        [
          ["a", "b"],
          ["d", "c"],
        ],
      ),
    ).toBe(1);
  });

  test("jaccardCycles is the intersection over the union", () => {
    expect(
      jaccardCycles(
        [
          ["a", "b"],
          ["x", "y"],
        ],
        [
          ["a", "b"],
          ["p", "q"],
        ],
      ),
    ).toBeCloseTo(1 / 3, 10);
  });

  test("jaccardCycles treats two empty cycle sets as an exact match", () => {
    expect(jaccardCycles([], [])).toBe(1);
  });

  test("jaccardCycles is 0 when one side is empty and the other is not", () => {
    expect(jaccardCycles([], [["a", "b"]])).toBe(0);
    expect(jaccardCycles([["a", "b"]], [])).toBe(0);
  });

  test("jaccardCycles distinguishes cycles that share members", () => {
    expect(jaccardCycles([["a", "b", "c"]], [["a", "b"]])).toBe(0);
  });
});

describe("results-io", () => {
  const dirs: string[] = [];
  const temp = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-results-"));
    dirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  test("gitSha7 is seven hex characters or the `nogit` sentinel", () => {
    expect(gitSha7()).toMatch(/^(?:[0-9a-f]{7}|nogit)$/);
  });

  test("todayIso is a YYYY-MM-DD date", () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("writes results/<suite>-<date>-<sha7>.json", () => {
    const dir = temp();
    const file = writeResult("structural", { corpus: ["tiny-ts"], data: { S1: 1 } }, dir);
    expect(path.basename(file)).toBe(`structural-${todayIso()}-${gitSha7()}.json`);
    expect(readdirSync(dir)).toEqual([path.basename(file)]);
  });

  test("fills suite, date and greplostSha, and writes stable sorted JSON", () => {
    const dir = temp();
    const file = writeResult("structural", { zebra: 1, alpha: 2 }, dir);
    const text = readFileSync(file, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const payload = JSON.parse(text) as Record<string, unknown>;
    expect(payload["suite"]).toBe("structural");
    expect(payload["date"]).toBe(todayIso());
    expect(payload["greplostSha"]).toBe(gitSha7());
    expect(Object.keys(payload)).toEqual(["alpha", "date", "greplostSha", "suite", "zebra"]);
  });

  test("does not overwrite an explicit suite, date or sha in the payload", () => {
    const dir = temp();
    const file = writeResult("structural", { date: "2020-01-01", greplostSha: "abcdef0" }, dir);
    expect(path.basename(file)).toBe("structural-2020-01-01-abcdef0.json");
    const payload = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(payload["date"]).toBe("2020-01-01");
    expect(payload["greplostSha"]).toBe("abcdef0");
  });

  test("latestResult returns the newest run by filename", () => {
    const dir = temp();
    writeFileSync(path.join(dir, "structural-2026-01-02-aaaaaaa.json"), '{"marker":"older"}\n');
    writeFileSync(path.join(dir, "structural-2026-09-02-bbbbbbb.json"), '{"marker":"newest"}\n');
    writeFileSync(path.join(dir, "structural-2026-03-04-ccccccc.json"), '{"marker":"middle"}\n');
    const latest = latestResult("structural", dir);
    expect(latest?.file).toBe(path.join(dir, "structural-2026-09-02-bbbbbbb.json"));
    expect(latest?.payload["marker"]).toBe("newest");
  });

  test("latestResult ignores other suites and unrelated files", () => {
    const dir = temp();
    writeFileSync(path.join(dir, "structural-2026-01-02-aaaaaaa.json"), '{"marker":"mine"}\n');
    writeFileSync(path.join(dir, "structural-md-2026-09-02-bbbbbbb.json"), '{"marker":"other suite"}\n');
    writeFileSync(path.join(dir, "perf-2026-09-02-bbbbbbb.json"), '{"marker":"perf"}\n');
    writeFileSync(path.join(dir, "notes.txt"), "ignore me\n");
    expect(latestResult("structural", dir)?.payload["marker"]).toBe("mine");
  });

  test("latestResult is undefined when the suite has never run", () => {
    expect(latestResult("structural", temp())).toBeUndefined();
    expect(latestResult("structural", path.join(temp(), "missing"))).toBeUndefined();
  });

  test("round-trips a written result", () => {
    const dir = temp();
    writeResult("structural", { corpus: ["tiny-ts"], scores: { S1: { precision: 1, recall: 1 } } }, dir);
    const latest = latestResult("structural", dir);
    expect(latest?.payload["scores"]).toEqual({ S1: { precision: 1, recall: 1 } });
  });
});

/**
 * The S1 to S4 comparison itself, on a hand-built snapshot. `buildSnapshot` (leaf 1.1.5)
 * does not exist yet, so the runner's expensive half cannot be exercised here; its pure
 * half — which side of each comparison an edge lands on, and what the gate concludes — can.
 */
describe("structural gate", () => {
  const file = (path: string, extra: Partial<FileRecord> = {}): FileRecord => ({
    path,
    lang: "ts",
    sha256: "0".repeat(64),
    loc: 10,
    decls: [],
    imports: [],
    exports: [],
    calls: [],
    ...extra,
  });

  const snapshotOf = (overrides: Partial<Snapshot> = {}): Snapshot => {
    const files = overrides.files ?? [
      file("a.ts", { imports: [{ specifier: "./b.js", kind: "static", symbols: [], reexport: false, line: 3 }] }),
      file("b.ts"),
    ];
    const exports = overrides.manifest?.files ?? {
      "a.ts": { sha256: "0", pkg: ".", lang: "ts" as const, loc: 10, exports: ["run"], fanIn: 0, fanOut: 1, blast: 0, staleSummary: false },
      "b.ts": { sha256: "0", pkg: ".", lang: "ts" as const, loc: 10, exports: ["helper"], fanIn: 1, fanOut: 0, blast: 1, staleSummary: false },
    };
    return {
      root: "/repo",
      config: DEFAULT_CONFIG,
      packages: [{ name: "root", path: ".", source: "root" }],
      files,
      manifest: { version: "1", packages: {}, files: exports },
      imports: overrides.imports ?? [
        { from: "a.ts", to: "b.ts", kind: "import", confidence: "high", specifier: "./b.js", importKind: "static" },
      ],
      calls: overrides.calls ?? [{ from: "a.ts#run", to: "b.ts#helper", kind: "call", confidence: "high" }],
      symbols: overrides.symbols ?? [
        { id: "a.ts#run", file: "a.ts", name: "run", kind: "function", signature: "function run()", exported: true, span: [7, 9] },
        { id: "b.ts#helper", file: "b.ts", name: "helper", kind: "function", signature: "function helper()", exported: true, span: [2, 4] },
      ],
      metrics: overrides.metrics ?? { cycles: [], packageEdges: [] },
    };
  };

  const truthOf = (overrides: Partial<Truth> = {}): Truth => ({
    imports: overrides.imports ?? [{ from: "a.ts", to: "b.ts", kind: "import", symbols: [], confidence: "high" }],
    exports: overrides.exports ?? { "a.ts": ["run"], "b.ts": ["helper"] },
    calls: overrides.calls ?? [{ from: "a.ts#run", to: "b.ts#helper", kind: "call", symbols: [], confidence: "high" }],
    cycles: overrides.cycles ?? [],
  });

  test("scoredFiles keeps the languages the truth generator speaks", () => {
    const mixed = snapshotOf({ files: [file("a.ts"), file("b.go", { lang: "go" }), file("c.tsx", { lang: "tsx" })] });
    expect(scoredFiles(mixed, "ts")).toEqual(["a.ts", "c.tsx"]);
    expect(scoredFiles(mixed, "go")).toEqual(["b.go"]);
  });

  test("a snapshot that matches truth passes every gate", () => {
    const scores = scoreAgainstTruth("tiny", snapshotOf(), truthOf(), "ts");
    expect(scores.files).toBe(2);
    expect(scores.S1.precision).toBe(1);
    expect(scores.S2.f1).toBe(1);
    expect(scores.S3.precision).toBe(1);
    expect(scores.S4).toBe(1);
    expect(missedMetrics(scores)).toEqual([]);
  });

  test("external and unresolved import targets never count as false positives", () => {
    const scores = scoreAgainstTruth(
      "tiny",
      snapshotOf({
        imports: [
          { from: "a.ts", to: "b.ts", kind: "import", confidence: "high", specifier: "./b.js", importKind: "static" },
          { from: "a.ts", to: "ext:lodash", kind: "import", confidence: "high", specifier: "lodash", importKind: "static" },
          { from: "a.ts", to: "unresolved:./nope", kind: "import", confidence: "high", specifier: "./nope", importKind: "static" },
        ],
      }),
      truthOf(),
      "ts",
    );
    expect(scores.S1.fp).toBe(0);
    expect(missedMetrics(scores)).toEqual([]);
  });

  test("edges touching a file outside the scored set are dropped on both sides", () => {
    const scores = scoreAgainstTruth(
      "tiny",
      snapshotOf({
        imports: [
          { from: "a.ts", to: "b.ts", kind: "import", confidence: "high", specifier: "./b.js", importKind: "static" },
          { from: "a.ts", to: "data.json", kind: "import", confidence: "high", specifier: "./data.json", importKind: "static" },
        ],
      }),
      truthOf({ imports: [{ from: "a.ts", to: "b.ts", kind: "import", symbols: [], confidence: "high" }] }),
      "ts",
    );
    expect(scores.S1.fp).toBe(0);
    expect(scores.S1.fn).toBe(0);
  });

  test("a wrong import edge fails S1 and is located at the import line", () => {
    const scores = scoreAgainstTruth(
      "tiny",
      snapshotOf({
        imports: [
          { from: "a.ts", to: "b.ts", kind: "import", confidence: "high", specifier: "./b.js", importKind: "static" },
        ],
      }),
      truthOf({ imports: [] }),
      "ts",
    );
    expect(missedMetrics(scores)).toEqual(["S1"]);
    expect(scores.falsePositives["S1"]).toEqual(["a.ts:3 (a.ts -> b.ts)"]);
  });

  test("only high-confidence call edges are scored for S3, and the rest are still reported", () => {
    const scores = scoreAgainstTruth(
      "tiny",
      snapshotOf({
        calls: [
          { from: "a.ts#run", to: "b.ts#helper", kind: "call", confidence: "high" },
          { from: "a.ts#run", to: "b.ts#ghost", kind: "call", confidence: "med" },
        ],
      }),
      truthOf(),
      "ts",
    );
    expect(scores.S3.precision).toBe(1);
    expect(scores.S3.fp).toBe(0);
    expect(scores.callsAll.precision).toBe(0.5);
    expect(missedMetrics(scores)).toEqual([]);
  });

  test("a wrong high-confidence call fails S3 and is located at the caller's declaration", () => {
    const scores = scoreAgainstTruth(
      "tiny",
      snapshotOf({
        calls: [
          { from: "a.ts#run", to: "b.ts#helper", kind: "call", confidence: "high" },
          { from: "a.ts#run", to: "b.ts#ghost", kind: "call", confidence: "high" },
        ],
      }),
      truthOf(),
      "ts",
    );
    expect(missedMetrics(scores)).toEqual(["S3"]);
    expect(scores.falsePositives["S3"]).toEqual(["a.ts:7 (a.ts#run -> b.ts#ghost)"]);
  });

  test("a missing export fails S2 on recall", () => {
    const snapshot = snapshotOf();
    snapshot.manifest.files["b.ts"] = {
      sha256: "0",
      pkg: ".",
      lang: "ts",
      loc: 10,
      exports: [],
      fanIn: 1,
      fanOut: 0,
      blast: 1,
      staleSummary: false,
    };
    const scores = scoreAgainstTruth("tiny", snapshot, truthOf(), "ts");
    expect(missedMetrics(scores)).toEqual(["S2"]);
    expect(scores.S2.falseNegatives).toEqual(["b.ts#helper"]);
    expect(scores.S2.precision).toBe(1);
  });

  test("a cycle greplost invented but the compiler does not see fails S4", () => {
    const scores = scoreAgainstTruth(
      "tiny",
      snapshotOf({ metrics: { cycles: [["a.ts", "b.ts"]], packageEdges: [] } }),
      truthOf(),
      "ts",
    );
    expect(scores.S4).toBe(0);
    expect(missedMetrics(scores)).toEqual(["S4"]);
    expect(scores.falsePositives["S4"]).toEqual(["a.ts:1 (cycle a.ts -> b.ts)"]);
  });

  test("a cycle the compiler sees but greplost misses also fails S4", () => {
    const scores = scoreAgainstTruth("tiny", snapshotOf(), truthOf({ cycles: [["a.ts", "b.ts"]] }), "ts");
    expect(scores.S4).toBe(0);
    expect(missedMetrics(scores)).toEqual(["S4"]);
    expect(scores.falsePositives["S4"]).toEqual([]);
  });

  test("several missed metrics are reported together, in id order", () => {
    const scores = scoreAgainstTruth(
      "tiny",
      snapshotOf({
        imports: [
          { from: "a.ts", to: "b.ts", kind: "import", confidence: "high", specifier: "./b.js", importKind: "static" },
        ] satisfies ImportEdge[],
        calls: [{ from: "a.ts#run", to: "b.ts#ghost", kind: "call", confidence: "high" }] satisfies CallEdge[],
      }),
      truthOf({ imports: [] }),
      "ts",
    );
    expect(missedMetrics(scores)).toEqual(["S1", "S3"]);
  });

  test("locate falls back to line 1 when the snapshot has nothing more precise", () => {
    const snapshot = snapshotOf();
    expect(locate(snapshot, "a.ts -> zzz.ts", "import")).toBe("a.ts:1");
    expect(locate(snapshot, "a.ts -> b.ts#helper", "call")).toBe("a.ts:1");
    expect(locate(snapshot, "b.ts#helper", "export")).toBe("b.ts:2");
  });
});
