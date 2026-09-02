/**
 * Go truth generator tests (leaf 1.8, gate G2).
 *
 * Everything in `fixture truth` is read off `fixtures/tiny-go` by hand and
 * pinned: these are the numbers the Go structure layer is scored against, so
 * they are written out in full rather than recomputed from the thing under
 * test. `oracle independence` is the integrity check of tech spec 10.1
 * principle 2: the oracle must not be able to agree with greplost by
 * construction.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compareEdges, stableStringify } from "@greplost/core/schema";
import { generateGoTruth, goCallgraphTool, GO_TRUTH_NOTES } from "../src/truth/go.ts";
import { missedMetrics, scoreAgainstTruth } from "../src/structural.ts";
import { edgeKey, exportKeys, scoreEdges, scoreSet } from "../src/score.ts";
import type { Truth } from "../src/truth/ts.ts";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const fixtureRoot = path.join(repoRoot, "fixtures", "tiny-go");

/** The five indexed files of the fixture; `internal/store/store_test.go` is excluded. */
const FIXTURE_FILES = [
  "cmd/app/main.go",
  "internal/retry/backoff.go",
  "internal/retry/retry.go",
  "internal/store/memory.go",
  "internal/store/store.go",
];

const truth: Truth = generateGoTruth(fixtureRoot, FIXTURE_FILES);

const keys = (edges: { from: string; to: string }[]): string[] => edges.map(edgeKey);

describe("go tool", () => {
  test("the callgraph helper is built once and cached under bench/.corpus/.tools", () => {
    const binary = goCallgraphTool();
    expect(existsSync(binary)).toBe(true);
    expect(path.dirname(binary)).toBe(path.join(repoRoot, "bench", ".corpus", ".tools"));
    // Content-addressed by its own sources, so a second call never rebuilds.
    expect(goCallgraphTool()).toBe(binary);
    expect(path.basename(binary)).toMatch(/^gocallgraph-[0-9a-f]{16}$/);
  });

  test("the helper module pins golang.org/x/tools", () => {
    const goMod = readFileSync(path.join(repoRoot, "bench", "truth", "gocallgraph", "go.mod"), "utf8");
    expect(goMod).toMatch(/^require golang\.org\/x\/tools v\d+\.\d+\.\d+$/m);
    expect(existsSync(path.join(repoRoot, "bench", "truth", "gocallgraph", "go.sum"))).toBe(true);
  });
});

describe("fixture truth", () => {
  test("truth covers exactly the indexed Go files", () => {
    expect(truth.files).toEqual(FIXTURE_FILES);
  });

  test("import edges target package directories, not files", () => {
    expect(keys(truth.imports)).toEqual([
      "cmd/app/main.go -> internal/retry",
      "cmd/app/main.go -> internal/store",
      "internal/store/store.go -> internal/retry",
    ]);
    // Every target is a directory holding at least one covered file.
    const directories = new Set(truth.files.map((f) => f.slice(0, f.lastIndexOf("/")) || "."));
    for (const edge of truth.imports) expect(directories.has(edge.to)).toBe(true);
    expect(truth.imports.every((e) => e.kind === "import" && e.confidence === "high")).toBe(true);
  });

  test("the standard library is never an edge target", () => {
    // main.go imports "fmt" and backoff.go imports "time" and "sort".
    expect(truth.imports.some((e) => e.to.includes("fmt") || e.to.includes("time"))).toBe(false);
  });

  test("exports are the exported package-level identifiers of each file", () => {
    expect(truth.exports).toEqual({
      "cmd/app/main.go": [],
      "internal/retry/backoff.go": ["Backoff"],
      "internal/retry/retry.go": ["DefaultAttempts", "Do"],
      "internal/store/memory.go": ["NewMemory"],
      "internal/store/store.go": ["DefaultName", "ErrClosed", "New", "Putter", "Store"],
    });
  });

  test("methods and unexported identifiers are not package exports", () => {
    const names = exportKeys(truth.exports);
    expect(names).not.toContain("internal/store/store.go#Store.Put");
    expect(names).not.toContain("internal/store/store.go#errorString");
  });

  test("call edges are named in-repo functions, callers attributed to declarations", () => {
    expect(keys(truth.calls)).toEqual([
      "cmd/app/main.go#main -> internal/retry/retry.go#Do",
      "cmd/app/main.go#main -> internal/store/store.go#New",
      "cmd/app/main.go#main -> internal/store/store.go#Store.Put",
      "internal/store/memory.go#NewMemory -> internal/store/store.go#New",
      "internal/store/store.go#Store.Put -> internal/retry/retry.go#Do",
      "internal/store/store.go#Store.Put -> internal/store/store.go#Store.set",
    ]);
    expect(truth.calls.every((e) => e.kind === "call")).toBe(true);
  });

  test("a call written inside a func literal belongs to the enclosing declaration", () => {
    // store.go's `s.set(...)` lives in the closure passed to retry.Do.
    expect(keys(truth.calls)).toContain(
      "internal/store/store.go#Store.Put -> internal/store/store.go#Store.set",
    );
  });

  test("conversions and calls that leave the repo are not call edges", () => {
    // `errorString("...")` and `string(e)` are conversions; fmt/time are external.
    expect(truth.calls.some((e) => e.to.endsWith("#errorString"))).toBe(false);
    expect(truth.calls.some((e) => e.to.startsWith("cmd/") || e.to.includes("fmt"))).toBe(false);
  });

  test("Go has no import cycles to find", () => {
    expect(truth.cycles).toEqual([]);
  });

  test("the oracle discloses how it was built", () => {
    expect(truth.notes).toEqual([...GO_TRUTH_NOTES]);
  });

  test("every collection is sorted and stable", () => {
    expect([...truth.imports].sort(compareEdges)).toEqual(truth.imports);
    expect([...truth.calls].sort(compareEdges)).toEqual(truth.calls);
    expect(stableStringify(generateGoTruth(fixtureRoot, FIXTURE_FILES))).toBe(stableStringify(truth));
  });

  test("a caller file list narrows the universe on both ends", () => {
    const narrowed = generateGoTruth(fixtureRoot, ["internal/store/store.go", "internal/store/memory.go"]);
    expect(narrowed.files).toEqual(["internal/store/memory.go", "internal/store/store.go"]);
    // The call into internal/retry leaves the universe and is dropped.
    expect(keys(narrowed.calls)).toEqual([
      "internal/store/memory.go#NewMemory -> internal/store/store.go#New",
      "internal/store/store.go#Store.Put -> internal/store/store.go#Store.set",
    ]);
    expect(Object.keys(narrowed.exports)).toEqual(["internal/store/memory.go", "internal/store/store.go"]);
  });
});

describe("empty truth", () => {
  const temps: string[] = [];

  function module(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), "greplost-go-truth-"));
    temps.push(root);
    for (const [name, body] of Object.entries(files)) {
      const file = path.join(root, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
    }
    return root;
  }

  afterAll(() => {
    for (const root of temps) rmSync(root, { recursive: true, force: true });
  });

  test("a module with no Go package is an error, not four perfect scores", () => {
    // The whole point of the guard (tech spec 10.1, principle 2): an empty truth
    // set scores an empty prediction as 1.000 across the board.
    const root = module({ "go.mod": "module example.com/empty\n\ngo 1.25\n", "README.md": "nothing here\n" });
    expect(() => generateGoTruth(root, [])).toThrow(/greplost: go truth is empty for .*no packages/);
  });

  test("a file list the toolchain never loaded is an error too", () => {
    // The package loads, but the caller asked about a file behind a build tag.
    const root = module({
      "go.mod": "module example.com/tagged\n\ngo 1.25\n",
      "a.go": "package tagged\n\nfunc A() {}\n",
      "b.go": "//go:build never\n\npackage tagged\n\nfunc B() {}\n",
    });
    expect(generateGoTruth(root, ["a.go"]).files).toEqual(["a.go"]);
    expect(() => generateGoTruth(root, ["b.go"])).toThrow(
      /greplost: go truth is empty for .*loaded none of the 1 requested files/,
    );
  });

  test("a repo whose config excludes the language is a no-files miss", async () => {
    // The snapshot side of the same question: a `.greplost/config.json` that
    // leaves Go out indexes nothing, and empty-against-empty is 1.000 four times.
    const repo = module({
      "go.mod": "module example.com/excluded\n\ngo 1.25\n",
      "a.go": "package excluded\n\nfunc A() {}\n",
      ".greplost/config.json": JSON.stringify({ languages: ["ts"] }),
    });
    const { buildSnapshot } = await import("@greplost/core");
    const snapshot = await buildSnapshot({ root: repo });
    expect(snapshot.files.length).toBe(0);
    const nothing: Truth = { files: [], imports: [], exports: {}, calls: [], cycles: [], notes: [] };
    const scores = scoreAgainstTruth("excluded", snapshot, nothing, "go");
    expect(scores.noFiles).toBe(true);
    expect(missedMetrics(scores)).toEqual(["no-files"]);
  });

  test("the structural runner calls a truth set that covers nothing empty", () => {
    // Belt and braces: even a truth generator that returns empty rather than
    // throwing cannot produce a vacuous GATE PASS.
    const snapshot = {
      files: FIXTURE_FILES.map((p) => ({ path: p, lang: "go" as const, imports: [] })),
      imports: [],
      calls: [],
      manifest: { files: {} },
      metrics: { cycles: [] as string[][] },
      symbols: [],
    } as unknown as Parameters<typeof scoreAgainstTruth>[1];
    // Non-empty but disjoint: the truth covered real files, none of them ours.
    // The intersection is empty, so every "across the covered files" test used to
    // be vacuously true and the gate passed on nothing at all.
    const nothing: Truth = {
      files: ["elsewhere/x.go"],
      imports: [],
      exports: { "elsewhere/x.go": ["X"] },
      calls: [],
      cycles: [],
      notes: [],
    };
    expect(scoreAgainstTruth("tiny-go", snapshot, nothing, "go").truthEmpty).toBe(true);
  });
});

describe("oracle independence", () => {
  test("the Go truth generator never reads greplost's extractor or resolver", () => {
    const source = readFileSync(path.join(repoRoot, "bench", "src", "truth", "go.ts"), "utf8");
    for (const forbidden of ["extract/", "resolve/", "@greplost/core\"", "buildSnapshot"]) {
      expect(source).not.toContain(forbidden);
    }
    // The schema (ids and sorting) is the shared vocabulary, and is allowed.
    expect(source).toContain('from "@greplost/core/schema"');
  });

  test("the Go helper program only reads the Go toolchain", () => {
    const source = readFileSync(path.join(repoRoot, "bench", "truth", "gocallgraph", "main.go"), "utf8");
    expect(source).toContain("golang.org/x/tools/go/callgraph/cha");
    expect(source).toContain("golang.org/x/tools/go/packages");
    expect(source).not.toContain("greplost/.greplost");
  });
});

describe("scoring go", () => {
  /** A snapshot-shaped stub: scoring is pure, so it needs only these fields. */
  function snapshotOf(overrides: {
    imports: Array<{ from: string; to: string }>;
    calls: Array<{ from: string; to: string }>;
    exports: Record<string, string[]>;
  }) {
    return {
      files: FIXTURE_FILES.map((path) => ({ path, lang: "go" as const, imports: [] })),
      imports: overrides.imports.map((e) => ({ ...e, kind: "import" as const, confidence: "high" as const })),
      calls: overrides.calls.map((e) => ({ ...e, kind: "call" as const, confidence: "high" as const })),
      manifest: {
        files: Object.fromEntries(Object.entries(overrides.exports).map(([f, exports]) => [f, { exports }])),
      },
      metrics: { cycles: [] as string[][] },
      symbols: [] as Array<{ id: string; span: [number, number] }>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as Parameters<typeof scoreAgainstTruth>[1];
  }

  test("directory targets stay in the scored universe (S1 is not vacuous)", () => {
    const scores = scoreAgainstTruth(
      "tiny-go",
      snapshotOf({ imports: truth.imports, calls: truth.calls, exports: truth.exports }),
      truth,
      "go",
    );
    expect(scores.S1.tp).toBe(3);
    expect(scores.S1.precision).toBe(1);
    expect(scores.S1.recall).toBe(1);
    expect(scores.truthEmpty).toBe(false);
  });

  test("a wrong directory target is a false positive, not a silently dropped edge", () => {
    // `internal/store/store.go -> internal/store` is a real directory id and a
    // real file, but not a truth edge: it must be counted, not filtered away.
    const wrong = truth.imports.map((e) => ({ from: e.from, to: "internal/store" }));
    const scores = scoreAgainstTruth(
      "tiny-go",
      snapshotOf({ imports: wrong, calls: [], exports: truth.exports }),
      truth,
      "go",
    );
    expect(scores.S1.fp).toBeGreaterThan(0);
    expect(scores.S1.precision).toBeLessThan(1);
  });

  test("the scoring keys are the shared ones", () => {
    expect(scoreEdges(truth.imports, truth.imports).precision).toBe(1);
    expect(scoreSet(exportKeys(truth.exports), exportKeys(truth.exports)).recall).toBe(1);
  });
});
