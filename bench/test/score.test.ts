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
import { findUnparsableFiles } from "@greplost/core";
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
import {
  locate,
  missedMetrics,
  resultSuite as structuralResultSuite,
  scoreAgainstTruth,
  scoredFiles,
  unparsableBucket,
  type RepoScores,
} from "../src/structural.ts";
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
    expect(Object.keys(payload)).toEqual(["alpha", "date", "greplostSha", "recordedAt", "suite", "zebra"]);
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

  test("latestResult orders by recordedAt, not by the sha in the file name", () => {
    // The defect this pins: `<suite>-<date>-<sha7>.json` was ordered
    // lexicographically, so a newer run at a commit whose short sha sorts low
    // lost to an older run at a commit whose sha sorts high (headtohead 173a463
    // lost to b908e0f, and the Versions table then named the wrong commit).
    // Here the sha order (aaaaaaa < mmmmmmm < zzzzzzz) is the exact reverse of
    // the recording order, so a name sort and a time sort cannot both be right.
    const dir = temp();
    writeFileSync(
      path.join(dir, "structural-2026-09-02-zzzzzzz.json"),
      '{"marker":"oldest","recordedAt":"2026-09-02T01:00:00.000Z"}\n',
    );
    writeFileSync(
      path.join(dir, "structural-2026-09-02-mmmmmmm.json"),
      '{"marker":"middle","recordedAt":"2026-09-02T02:00:00.000Z"}\n',
    );
    writeFileSync(
      path.join(dir, "structural-2026-09-02-aaaaaaa.json"),
      '{"marker":"newest","recordedAt":"2026-09-02T03:00:00.000Z"}\n',
    );
    const latest = latestResult("structural", dir);
    expect(latest?.payload["marker"]).toBe("newest");
    expect(latest?.file).toBe(path.join(dir, "structural-2026-09-02-aaaaaaa.json"));
  });

  test("a payload with no recordedAt never displaces one that has it", () => {
    // Every result committed before the stamp existed sorts before every stamped
    // one, whatever its name: an unstamped file cannot be shown to be the newer
    // of the two, and guessing that from its sha is the defect above.
    const dir = temp();
    writeFileSync(path.join(dir, "structural-2026-09-02-zzzzzzz.json"), '{"marker":"unstamped"}\n');
    writeFileSync(
      path.join(dir, "structural-2026-09-02-aaaaaaa.json"),
      '{"marker":"stamped","recordedAt":"2026-01-01T00:00:00.000Z"}\n',
    );
    expect(latestResult("structural", dir)?.payload["marker"]).toBe("stamped");
  });

  test("writeResult stamps recordedAt in ISO 8601 UTC and keeps an explicit one", () => {
    const dir = temp();
    const stamped = JSON.parse(
      readFileSync(writeResult("structural", { a: 1 }, dir), "utf8"),
    ) as Record<string, unknown>;
    expect(stamped["recordedAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const kept = JSON.parse(
      readFileSync(writeResult("perf", { recordedAt: "2020-01-01T00:00:00.000Z" }, dir), "utf8"),
    ) as Record<string, unknown>;
    expect(kept["recordedAt"]).toBe("2020-01-01T00:00:00.000Z");
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
    files: overrides.files ?? ["a.ts", "b.ts"],
    imports: overrides.imports ?? [{ from: "a.ts", to: "b.ts", kind: "import", symbols: [], confidence: "high" }],
    exports: overrides.exports ?? { "a.ts": ["run"], "b.ts": ["helper"] },
    calls: overrides.calls ?? [{ from: "a.ts#run", to: "b.ts#helper", kind: "call", symbols: [], confidence: "high" }],
    cycles: overrides.cycles ?? [],
    notes: overrides.notes ?? [],
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

  test("S6 scores only the files the oracle names in nodeFiles, on both sides", () => {
    const node = (file: string, name: string) => ({
      id: `${file}#resource.${name}`, file, name, kind: "resource" as const, signature: `resource ${name}`, exported: false, span: [1, 2] as [number, number],
    });
    const snapshot = snapshotOf({ symbols: [node("a.ts", "x"), node("b.ts", "y")] });
    const scoped = scoreAgainstTruth("tiny", snapshot, truthOf(), "ts", { references: [], nodes: ["a.ts#resource.x"], nodeFiles: ["a.ts"] });
    // `S6` is `Score | null` - `null` is the `n/a` an oracle that measures nothing reports - so
    // the assertion says both things: it was measured, and it measured this.
    expect(scoped.S6).not.toBeNull();
    expect([scoped.S6?.tp, scoped.S6?.fp, scoped.S6?.fn]).toEqual([1, 0, 0]);
    const whole = scoreAgainstTruth("tiny", snapshot, truthOf(), "ts", { references: [], nodes: ["a.ts#resource.x"] });
    expect(whole.S6).not.toBeNull();
    expect([whole.S6?.tp, whole.S6?.fp, whole.S6?.fn]).toEqual([1, 1, 0]);
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

  test("an empty compiler truth is a gate miss, not four perfect scores", () => {
    // The dangerous shape: greplost produced nothing *and* the compiler produced nothing,
    // so every set comparison is vacuously perfect.
    const blank = { sha256: "0", pkg: ".", lang: "ts" as const, loc: 10, fanIn: 0, fanOut: 0, blast: 0, staleSummary: false };
    const scores = scoreAgainstTruth(
      "tiny",
      snapshotOf({
        imports: [],
        calls: [],
        metrics: { cycles: [], packageEdges: [] },
        manifest: {
          version: "1",
          packages: {},
          files: { "a.ts": { ...blank, exports: [] }, "b.ts": { ...blank, exports: [] } },
        },
      }),
      truthOf({ imports: [], exports: { "a.ts": [], "b.ts": [] }, calls: [] }),
      "ts",
    );
    // Every metric is vacuously perfect, which is exactly why this must still fail.
    expect(scores.S1.f1).toBe(1);
    expect(scores.S3.f1).toBe(1);
    expect(scores.S4).toBe(1);
    expect(scores.truthEmpty).toBe(true);
    expect(missedMetrics(scores)).toEqual(["truth-empty"]);
  });

  test("a repo greplost indexed no file in is a no-files miss, not four perfect scores", () => {
    // Ruling 2026-09-02 (leaf 1.8 fix round 2): an empty snapshot scores 1.000
    // across the board against an empty truth, so it is a miss of its own rather
    // than a pass. `truth-empty` stays reserved for the oracle's side of it.
    const scores = scoreAgainstTruth(
      "tiny",
      snapshotOf({ files: [], imports: [], calls: [], metrics: { cycles: [], packageEdges: [] } }),
      truthOf({ files: [], imports: [], exports: {}, calls: [] }),
      "ts",
    );
    expect(scores.files).toBe(0);
    expect(scores.truthEmpty).toBe(false);
    expect(scores.noFiles).toBe(true);
    expect(missedMetrics(scores)).toEqual(["no-files"]);
  });

  test("files the truth generator could not cover leave the scored universe on both sides", () => {
    // b.ts is in the snapshot but the compiler never loaded it, so its exports must not be
    // scored as false positives.
    const scores = scoreAgainstTruth(
      "tiny",
      snapshotOf(),
      truthOf({
        files: ["a.ts"],
        imports: [],
        exports: { "a.ts": ["run"] },
        calls: [],
      }),
      "ts",
    );
    expect(scores.files).toBe(1);
    expect(scores.S2.fp).toBe(0);
    expect(scores.S2.fn).toBe(0);
    // The a.ts -> b.ts import and the a.ts#run -> b.ts#helper call both leave the universe.
    expect(scores.S1.fp).toBe(0);
    expect(scores.S3.fp).toBe(0);
    expect(missedMetrics(scores)).toEqual([]);
  });

  test("a truth generator with no `files` field falls back to the snapshot's own list", () => {
    const legacy = truthOf();
    delete (legacy as Partial<Truth>).files;
    const scores = scoreAgainstTruth("tiny", snapshotOf(), legacy, "ts");
    expect(scores.files).toBe(2);
    expect(missedMetrics(scores)).toEqual([]);
  });

  test("locate falls back to line 1 when the snapshot has nothing more precise", () => {
    const snapshot = snapshotOf();
    expect(locate(snapshot, "a.ts -> zzz.ts", "import")).toBe("a.ts:1");
    expect(locate(snapshot, "a.ts -> b.ts#helper", "call")).toBe("a.ts:1");
    expect(locate(snapshot, "b.ts#helper", "export")).toBe("b.ts:2");
  });

  test("unparsableBucket carries the count and the repo each file came from", () => {
    const withFiles = (name: string, unparsable: { path: string; reason: string }[]): RepoScores => ({
      ...scoreAgainstTruth(name, snapshotOf(), truthOf(), "ts"),
      unparsable,
    });
    const bucket = unparsableBucket([
      withFiles("zeta", [{ path: "z.ts", reason: "error-root" }]),
      withFiles("alpha", [
        { path: "b.ts", reason: "error-child" },
        { path: "a.ts", reason: "error-root" },
      ]),
    ]);
    expect(bucket.count).toBe(3);
    expect(bucket.files.map((entry) => `${entry.repo}:${entry.path}`)).toEqual([
      "alpha:a.ts",
      "alpha:b.ts",
      "zeta:z.ts",
    ]);
    expect(unparsableBucket([]).count).toBe(0);
  });
});

/**
 * The unparsable bucket (Appendix C ruling 2026-09-03).
 *
 * tree-sitter-typescript 0.23.2 is the newest grammar that exists and hono's generic
 * call signatures hit open upstream issue #335. The extractor recovers around ERROR
 * nodes, so those files still score — but whatever the grammar could not read costs S1
 * and S2 recall with nothing in the report saying so. `findUnparsableFiles` is the reader
 * that names them.
 */
describe("findUnparsableFiles", () => {
  let dir = "";
  const write = (name: string, source: string): string => {
    if (dir === "") dir = mkdtempSync(path.join(tmpdir(), "greplost-unparsable-"));
    writeFileSync(path.join(dir, name), source);
    return name;
  };
  afterAll(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  test("reports a file whose top level is a broken generic signature, and nothing else", async () => {
    // A generic call signature at file scope: valid inside an `interface` body (this is
    // the shape hono's `HandlerInterface` is built from), a syntax error outside one.
    // tree-sitter puts it under an ERROR node that is a direct child of the root, which
    // is exactly the "root-level ERROR" the ruling names.
    const broken = write("broken.ts", "<T,>(value: T): T;\nexport const after = 1;\n");
    const clean = write("clean.ts", "export function ok<T>(value: T): T {\n  return value;\n}\n");
    // An ERROR deep in the tree is the recoverable case and is deliberately not counted:
    // the extractor reads what survives around it.
    const nested = write("nested.ts", "export interface Deep {\n  m<T extends >(x: T): T;\n}\n");
    const missing = "not-on-disk.ts";
    const notCode = write("notes.md", "# not source\n");

    const found = await findUnparsableFiles(dir, [broken, clean, nested, missing, notCode]);
    expect(found.map((entry) => entry.path)).toEqual([broken]);
    expect(found[0]?.reason).toBe("error-child");
    expect(found[0]?.lang).toBe("ts");
  });

  test("a file of pure syntax rubbish is reported, and a clean list comes back empty", async () => {
    const rubbish = write("rubbish.ts", "}}}} <<<< ==== )))\n");
    const clean = write("clean2.ts", "export const x = 1;\n");
    const found = await findUnparsableFiles(dir, [rubbish, clean]);
    expect(found.map((entry) => `${entry.path}:${entry.reason}`)).toEqual([`${rubbish}:error-child`]);
    expect(await findUnparsableFiles(dir, [clean])).toEqual([]);
    expect(await findUnparsableFiles(dir, [])).toEqual([]);
  });
});

/**
 * A fixture run must never land on the corpus suite's file name (review round 3,
 * important 1). `perf`, `replay` and `agent` already split; `structural` and
 * `headtohead` wrote fixture runs under the corpus name, so a twelve-file smoke run at
 * the same commit on the same day silently replaced the published corpus numbers.
 * `headtohead`'s half of this is in `report.test.ts`, where that suite is already loaded.
 */
describe("structural fixture runs write to their own suite name", () => {
  test("the suite name splits on --fixture", () => {
    expect(structuralResultSuite(false)).toBe("structural");
    expect(structuralResultSuite(true)).toBe("structural-fixture");
  });

  test("the file name a fixture run writes cannot become the corpus latest", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-fixture-suite-"));
    try {
      writeResult(structuralResultSuite(false), { marker: "corpus" }, dir);
      writeResult(structuralResultSuite(true), { marker: "fixture" }, dir);
      const names = readdirSync(dir).sort();
      expect(names.some((name) => name.startsWith("structural-fixture-"))).toBe(true);
      // The corpus payload is still the newest `structural-*` result, even though the
      // fixture ran after it.
      expect(latestResult("structural", dir)?.payload["marker"]).toBe("corpus");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
