/**
 * Kotlin truth generator tests (leaf 2.6, gates G6 to G8).
 *
 * Two describes, and the difference between them is the whole point of the Kotlin ruling
 * (spec 2026-09-04 section 1.7):
 *
 *   `kotlin fixture oracle` - on `fixtures/tiny-kotlin` there really is compiler truth. The
 *      numbers below are read off classfiles `kotlinc` wrote, and they are pinned here by hand
 *      rather than recomputed from the thing under test.
 *   `reported only` - on a corpus there is none, the module says so, and the harness prints
 *      `n/a` for S1 to S6 instead of a number nobody measured.
 *
 * The oracle needs `kotlinc`, a JDK's `javap` and `python3`. When the toolchain is absent the
 * oracle's tests skip with a printed reason instead of failing: a machine without a Kotlin
 * compiler has not disproved anything.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  generateTruth,
  hasKotlinToolchain,
  isFixtureRoot,
  kotlinToolOutput,
  kotlinTruthTool,
  NOTES,
} from "../src/truth/kotlin.ts";
import { unsupportedMetrics } from "../src/structural.ts";
import { edgeKey, exportKeys } from "../src/score.ts";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const fixtureRoot = path.join(repoRoot, "fixtures", "tiny-kotlin");
const toolDir = path.join(repoRoot, "bench", "truth", "kotlintruth");

/** The three indexed files of the fixture. */
const FIXTURE_FILES = ["src/tiny/App.kt", "src/tiny/Store.kt", "src/tiny/util/Retry.kt"];

const toolchain = hasKotlinToolchain();
if (!toolchain) {
  console.warn(
    "truth-kotlin: skipping the fixture oracle - kotlinc, javap or python3 is not on PATH " +
      '(install the compiler with "brew install kotlin"); the reported-only rules still run',
  );
}

const keys = (edges: { from: string; to: string }[]): string[] => edges.map(edgeKey);

const temps: string[] = [];
afterAll(() => {
  for (const root of temps) rmSync(root, { recursive: true, force: true });
});

/** A throwaway copy of the fixture, so a test may edit it. */
function copyFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "greplost-kotlin-truth-"));
  temps.push(root);
  cpSync(fixtureRoot, root, { recursive: true });
  return root;
}

describe.skipIf(!toolchain)("kotlin fixture oracle", () => {
  const truth = toolchain ? generateTruth(fixtureRoot, FIXTURE_FILES) : null;

  test("the oracle compiles the fixture and reads the classfiles back", () => {
    // `run.sh` is what compiles; a run that never reached `javap` could not know any of this.
    expect(existsSync(kotlinTruthTool())).toBe(true);
    expect(truth?.files).toEqual(FIXTURE_FILES);
    expect(truth?.notes).toEqual([...NOTES]);
  });

  test("a class is attributed to its .kt file by the SourceFile attribute, not by its name", () => {
    // `@file:JvmName("AppMain")` renames the class `App.kt` compiles into, and `Store.kt`
    // compiles into six classes. Only the classfile's own `SourceFile` attribute can put
    // `AppMain`, `Item`, `Sink`, `Store`, `Box`, `Box$Companion` and `StoreKt` back where they
    // were written.
    expect(truth?.exports["src/tiny/App.kt"]).toEqual(["main"]);
    expect(truth?.exports["src/tiny/Store.kt"]).toEqual([
      "Box",
      "Box.Companion",
      "Box.Companion.of",
      "Box.item",
      "Item",
      "Item.id",
      "Item.label",
      "Item.size",
      "Sink",
      "Sink.accept",
      "Store",
      "Store.accept",
      "Store.put",
    ]);
    expect(truth?.exports["src/tiny/util/Retry.kt"]).toEqual(["String.shout", "retry"]);
  });

  test("an extension is named by the receiver the compiler recorded, and a property by its name", () => {
    const names = exportKeys(truth?.exports ?? {});
    // `fun String.shout()` is a static method taking a String; `$this$shout` in the local
    // variable table is the compiler's own marker that the parameter is an extension receiver.
    expect(names).toContain("src/tiny/util/Retry.kt#String.shout");
    expect(names).toContain("src/tiny/Store.kt#Item.label");
    // `val id` is a private field plus `getId()`; the property is what Kotlin declared.
    expect(names).toContain("src/tiny/Store.kt#Item.id");
    expect(names).not.toContain("src/tiny/Store.kt#Item.getId");
    // A `private` member, an object's `INSTANCE` and a data class's `copy` are not exports.
    expect(names).not.toContain("src/tiny/Store.kt#Store.total");
    expect(names).not.toContain("src/tiny/Store.kt#Store.INSTANCE");
    expect(names).not.toContain("src/tiny/Store.kt#Item.copy");
  });

  test("an import edge is a reference that crosses a package", () => {
    expect(keys(truth?.imports ?? [])).toEqual(["src/tiny/App.kt -> src/tiny/util/Retry.kt"]);
    // Same-package use needs no import in Kotlin, and the compiler agrees: `App.kt` refers to
    // `Store` and `Item` without one, and neither is an edge.
    expect(truth?.imports.every((e) => e.kind === "import" && e.confidence === "high")).toBe(true);
    expect(truth?.cycles).toEqual([]);
  });

  test("call edges come from the invoke instructions of each method body", () => {
    expect(keys(truth?.calls ?? [])).toEqual([
      "src/tiny/App.kt#main -> src/tiny/Store.kt#Box.Companion.of",
      "src/tiny/App.kt#main -> src/tiny/Store.kt#Item",
      "src/tiny/App.kt#main -> src/tiny/Store.kt#Item.label",
      "src/tiny/App.kt#main -> src/tiny/Store.kt#Store.put",
      "src/tiny/App.kt#main -> src/tiny/util/Retry.kt#retry",
      "src/tiny/Store.kt#Box.Companion.of -> src/tiny/Store.kt#Box",
      "src/tiny/Store.kt#Store.put -> src/tiny/Store.kt#Store.accept",
    ]);
    // A constructor call is an edge to the type (Kotlin has no `new`), and a coroutine's
    // synthetic continuation class is not a caller of anything.
    expect(keys(truth?.calls ?? []).some((key) => key.includes("main$1"))).toBe(false);
  });

  test("the run is cached by content under bench/.corpus/.tools", () => {
    const before = kotlinToolOutput(fixtureRoot, FIXTURE_FILES);
    const again = kotlinToolOutput(fixtureRoot, FIXTURE_FILES);
    expect(JSON.stringify(again)).toBe(JSON.stringify(before));
    const cacheDir = path.join(repoRoot, "bench", ".corpus", ".tools");
    const cached = readFileSync(path.join(cacheDir, cacheName(cacheDir)), "utf8");
    expect(JSON.parse(cached).files).toEqual(["tiny/App.kt", "tiny/Store.kt", "tiny/util/Retry.kt"]);
  });

  test("a narrower file list narrows the universe on both ends", () => {
    const narrowed = generateTruth(fixtureRoot, ["src/tiny/Store.kt"]);
    expect(narrowed.files).toEqual(["src/tiny/Store.kt"]);
    expect(keys(narrowed.imports)).toEqual([]);
    expect(keys(narrowed.calls)).toEqual([
      "src/tiny/Store.kt#Box.Companion.of -> src/tiny/Store.kt#Box",
      "src/tiny/Store.kt#Store.put -> src/tiny/Store.kt#Store.accept",
    ]);
  });

  test("a file list the compiler never covered is an error, not four perfect scores", () => {
    expect(() => generateTruth(fixtureRoot, ["src/tiny/Absent.kt"])).toThrow(
      /greplost: kotlin truth is empty for .*covered none of the 1 requested files/,
    );
  });

  test("the oracle's output changes when the fixture changes", () => {
    const root = copyFixture();
    const before = kotlinToolOutput(root, FIXTURE_FILES);
    expect(before.exports["tiny/util/Retry.kt"]).not.toContain("jitter");

    const retry = path.join(root, "src", "tiny", "util", "Retry.kt");
    writeFileSync(retry, `${readFileSync(retry, "utf8")}\nfun jitter(): Int = 7\n`);
    const after = kotlinToolOutput(root, FIXTURE_FILES);

    expect(after.exports["tiny/util/Retry.kt"]).toContain("jitter");
    expect(after.exports["tiny/util/Retry.kt"]?.length ?? 0).toBe(
      (before.exports["tiny/util/Retry.kt"]?.length ?? 0) + 1,
    );
  });
});

describe("reported only", () => {
  test("kotlin declares no corpus oracle and is never gated on S1 to S3", () => {
    expect([...NOTES]).toContain("fixture-oracle-only");
    expect([...NOTES]).toContain("no-corpus-compiler-truth");
  });

  test("a corpus root measures nothing and says so, rather than returning zeros", () => {
    const corpus = path.join(repoRoot, "bench", ".corpus", "coroutines");
    expect(isFixtureRoot(corpus)).toBe(false);
    const truth = generateTruth(corpus, ["kotlinx-coroutines-core/common/src/Job.kt"]);
    expect(truth.files).toEqual([]);
    expect(truth.imports).toEqual([]);
    expect(truth.calls).toEqual([]);
    expect(truth.exports).toEqual({});
    expect(truth.notes).toContain("reported-only");
  });

  test("`reported-only` turns every metric into n/a, which is never a pass and never a fail", () => {
    const corpusNotes = generateTruth(path.join(repoRoot, "bench", ".corpus", "coroutines"), []).notes;
    expect(unsupportedMetrics([...NOTES, ...corpusNotes])).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
    // And the fixture's own notes gate nothing away: S1 to S4 are measured there.
    expect(unsupportedMetrics([...NOTES])).toEqual([]);
  });

  test("the oracle's module graph carries no greplost code at runtime", () => {
    const source = readFileSync(path.join(repoRoot, "bench", "src", "truth", "kotlin.ts"), "utf8");
    // Any import of greplost's own code has to be a type-only import, which is erased.
    for (const match of source.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gmu)) {
      const isType = match[1] !== undefined;
      const specifier = match[2] ?? "";
      if (specifier.startsWith("@greplost/") || specifier.endsWith("/ts.ts")) expect(isType).toBe(true);
    }
    // And the oracle proper is a shell script and a Python program that cannot reach greplost's
    // code at all: no tree-sitter, no `packages/core`, no import of the map it scores.
    for (const name of ["run.sh", "parse_javap.py"]) {
      const oracle = readFileSync(path.join(toolDir, name), "utf8");
      expect(oracle).not.toMatch(/tree.?sitter/iu);
      expect(oracle).not.toContain("packages/core");
      expect(oracle).not.toMatch(/^import\s+greplost/mu);
    }
  });

  test("the oracle never reads the host toolchain version into its output", () => {
    // A benchmark artifact may not carry a fact about the machine that made it (driver ruling
    // 2026-09-04): the version belongs in the leaf's gate evidence, not in `Truth`.
    const source = readFileSync(path.join(repoRoot, "bench", "src", "truth", "kotlin.ts"), "utf8");
    const notes = [...NOTES].join(" ");
    expect(notes).not.toMatch(/\d+\.\d+\.\d+/u);
    // Every mention of `-version` is a row of the boolean availability probe, whose output is
    // ignored; nothing assigns a version string, and none reaches `NOTES` or `Truth`.
    const versionLines = source.split("\n").filter((line) => line.includes("-version"));
    expect(versionLines.length).toBeGreaterThan(0);
    expect(versionLines.every((line) => /^\s*\["\w+", \["--?version"\]\],$/u.test(line))).toBe(true);
    expect(source).toContain('stdio: "ignore"');
  });
});

/** The one cache file the fixture run wrote, found by prefix so the hash stays an implementation detail. */
function cacheName(dir: string): string {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const entries = readdirSync(dir)
    .filter((name) => /^kotlintruth-[0-9a-f]{16}\.json$/u.test(name))
    .sort();
  expect(entries.length).toBeGreaterThan(0);
  return entries[entries.length - 1] as string;
}
