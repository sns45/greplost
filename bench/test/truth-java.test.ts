/**
 * Java truth generator tests (leaf 2.5, gates G7 and G8).
 *
 * Everything in `fixture truth` is read off `fixtures/tiny-java` by hand and pinned: these are
 * the numbers the Java structure layer is scored against, so they are written out in full
 * rather than recomputed from the thing under test. `oracle independence` is the integrity
 * check of tech spec 10.1 principle 2: the oracle must not be able to agree with greplost by
 * construction, so it may share no runtime code with `packages/core`, and its output has to
 * move when the fixture moves.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateTruth, javaTruthTool, NOTES } from "../src/truth/java.ts";
import { edgeKey, exportKeys } from "../src/score.ts";
import type { Truth } from "../src/truth/ts.ts";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const fixtureRoot = path.join(repoRoot, "fixtures", "tiny-java");
const toolDir = path.join(repoRoot, "bench", "truth", "javatruth");
const SRC = "src/main/java/tiny";

/** The four indexed files of the fixture. */
const FIXTURE_FILES = [`${SRC}/App.java`, `${SRC}/Marker.java`, `${SRC}/Retry.java`, `${SRC}/Store.java`];

const truth: Truth = generateTruth(fixtureRoot, FIXTURE_FILES);

const keys = (edges: { from: string; to: string }[]): string[] => edges.map(edgeKey);

const temps: string[] = [];

afterAll(() => {
  for (const root of temps) rmSync(root, { recursive: true, force: true });
});

/** A throwaway copy of the fixture, so a test may edit it. */
function copyFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "greplost-java-truth-"));
  temps.push(root);
  cpSync(fixtureRoot, root, { recursive: true });
  return root;
}

describe("java tool", () => {
  test("the javac oracle is compiled once and cached under bench/.corpus/.tools", () => {
    const classes = javaTruthTool();
    expect(existsSync(path.join(classes, "Truth.class"))).toBe(true);
    expect(path.dirname(classes)).toBe(path.join(repoRoot, "bench", ".corpus", ".tools"));
    // Content-addressed by its own source, so a second call never recompiles.
    expect(javaTruthTool()).toBe(classes);
    expect(path.basename(classes)).toMatch(/^javatruth-[0-9a-f]{16}$/);
  });

  test("the oracle is one plain source file, built with no build tool", () => {
    const source = readFileSync(path.join(toolDir, "Truth.java"), "utf8");
    expect(source).toMatch(/import com\.sun\.source\.util\.JavacTask;/u);
    expect(source).toMatch(/import com\.sun\.source\.util\.Trees;/u);
    // `-proc:none` and a classpath of the corpus's own source roots, and nothing else.
    expect(source).toMatch(/"-proc:none"/u);
    expect(source).toContain("src/main/java");
    expect(existsSync(path.join(toolDir, "pom.xml"))).toBe(false);
    expect(existsSync(path.join(toolDir, "build.gradle"))).toBe(false);
  });

  test("the toolchain pin is a floor, and the version never reaches the output", () => {
    const source = readFileSync(path.join(repoRoot, "bench", "src", "truth", "java.ts"), "utf8");
    expect(source).toMatch(/MINIMUM_JDK = 21/u);
    expect(source).toMatch(/major < MINIMUM_JDK/u);
    // The interpreter, its version and the machine's paths are facts about *this* run and may
    // never reach a truth set, which must depend on the corpus alone.
    const document = JSON.stringify(truth);
    expect(document).not.toMatch(/\d+\.\d+/u);
    expect(document).not.toContain(repoRoot);
    expect(document).not.toMatch(/openjdk|Homebrew|java\.version/iu);
  });

  test("the oracle discloses how it was built", () => {
    expect([...NOTES]).toEqual(["javac-tree-api", "source-classpath-only", "unresolved-files-dropped"]);
    expect(truth.notes).toEqual([...NOTES]);
  });
});

describe("fixture truth", () => {
  test("truth covers exactly the indexed Java files", () => {
    expect(truth.files).toEqual(FIXTURE_FILES);
  });

  test("the plain import and the static import are both edges", () => {
    expect(keys(truth.imports)).toEqual([
      `${SRC}/App.java -> ${SRC}/Retry.java`,
      `${SRC}/App.java -> ${SRC}/Store.java`,
    ]);
    expect(truth.imports.every((e) => e.kind === "import" && e.confidence === "high")).toBe(true);
  });

  test("a JDK import and a same-package reference are never edge targets", () => {
    // `Store.java` imports `java.util.*` and uses `Marker` with no import at all.
    expect(truth.imports.some((e) => e.to.startsWith("ext:") || e.to.includes("java/util"))).toBe(false);
    expect(keys(truth.imports)).not.toContain(`${SRC}/Store.java -> ${SRC}/Marker.java`);
  });

  test("exports are the public types and the public members of public types", () => {
    expect(truth.exports).toEqual({
      [`${SRC}/App.java`]: ["App", "App.App", "App.Colour", "App.Colour.GREEN", "App.Colour.RED", "App.run"],
      [`${SRC}/Marker.java`]: ["Marker", "Marker.name"],
      [`${SRC}/Retry.java`]: ["Retry", "Retry.ATTEMPTS", "Retry.attempts", "Retry.warm"],
      [`${SRC}/Store.java`]: ["Store", "Store.Entry", "Store.LIMIT", "Store.Store", "Store.name", "Store.put"],
    });
  });

  test("a package-private type, a private member and a generated member are not exports", () => {
    const names = exportKeys(truth.exports);
    // `Tag` is a package-private annotation type; `Store.record` and `Retry.Retry` are private.
    expect(names).not.toContain(`${SRC}/Marker.java#Tag`);
    expect(names).not.toContain(`${SRC}/Store.java#Store.record`);
    expect(names).not.toContain(`${SRC}/Retry.java#Retry.Retry`);
    // A record's accessors and an enum's `values`/`valueOf` are written by javac, not by a
    // human, so they are not declarations and cannot be exported names.
    expect(names).not.toContain(`${SRC}/Store.java#Store.Entry.key`);
    expect(names).not.toContain(`${SRC}/App.java#App.Colour.values`);
    expect(names).not.toContain(`${SRC}/App.java#App.Colour.valueOf`);
  });

  test("call edges follow spec 1.4's rules", () => {
    expect(keys(truth.calls)).toEqual([
      `${SRC}/App.java#App.App -> ${SRC}/Store.java#Store.Store`,
      `${SRC}/App.java#App.run -> ${SRC}/App.java#App.warm`,
      `${SRC}/App.java#App.run -> ${SRC}/Retry.java#Retry.attempts`,
      `${SRC}/App.java#App.run -> ${SRC}/Retry.java#Retry.warm`,
      `${SRC}/App.java#App.run -> ${SRC}/Store.java#Store.Store`,
      `${SRC}/App.java#App.run -> ${SRC}/Store.java#Store.put`,
      `${SRC}/App.java#App.warm -> ${SRC}/Retry.java#Retry.warm`,
      `${SRC}/Retry.java#Retry.warm -> ${SRC}/Retry.java#Retry.attempts`,
      `${SRC}/Retry.java#Retry.warm -> ${SRC}/Store.java#Store.put`,
      `${SRC}/Store.java#Store.put -> ${SRC}/Store.java#Store.record`,
    ]);
    expect(truth.calls.every((e) => e.kind === "call")).toBe(true);
  });

  test("a call into the JDK, and an enum constant's implicit new, are not truth", () => {
    // `values.add(value)` reaches `java.util.List`, which the oracle never loaded.
    expect(truth.calls.some((e) => e.to.includes("java/util"))).toBe(false);
    // `RED, GREEN` compile to a `new Colour()` nobody wrote.
    expect(truth.calls.some((e) => e.to === `${SRC}/App.java#App.Colour`)).toBe(false);
  });

  test("the fixture has no import cycle", () => {
    expect(truth.cycles).toEqual([]);
  });

  test("every collection is sorted and the run is deterministic", () => {
    expect(JSON.stringify(generateTruth(fixtureRoot, FIXTURE_FILES))).toBe(JSON.stringify(truth));
    expect([...truth.files].sort()).toEqual(truth.files);
  });

  test("a caller file list narrows the universe on both ends", () => {
    const narrowed = generateTruth(fixtureRoot, [`${SRC}/Retry.java`, `${SRC}/Store.java`]);
    expect(narrowed.files).toEqual([`${SRC}/Retry.java`, `${SRC}/Store.java`]);
    expect(keys(narrowed.imports)).toEqual([]);
    // `App`'s calls leave the universe and are dropped from both ends.
    expect(keys(narrowed.calls)).toEqual([
      `${SRC}/Retry.java#Retry.warm -> ${SRC}/Retry.java#Retry.attempts`,
      `${SRC}/Retry.java#Retry.warm -> ${SRC}/Store.java#Store.put`,
      `${SRC}/Store.java#Store.put -> ${SRC}/Store.java#Store.record`,
    ]);
    expect(Object.keys(narrowed.exports)).toEqual([`${SRC}/Retry.java`, `${SRC}/Store.java`]);
  });

  test("a file list the oracle never parsed is an error, not four perfect scores", () => {
    expect(() => generateTruth(fixtureRoot, [`${SRC}/Absent.java`])).toThrow(
      /greplost: java truth is empty for .*parsed no compilation unit/,
    );
  });

  test("a file the compiler could not type-check is dropped, and an all-broken tree throws", () => {
    const root = mkdtempSync(path.join(tmpdir(), "greplost-java-broken-"));
    temps.push(root);
    writeFileSync(path.join(root, "Broken.java"), "public class Broken { void go() { nope(); } }\n");
    expect(() => generateTruth(root, ["Broken.java"])).toThrow(
      /greplost: java truth is empty for .*type-checked none of the 1 requested files/,
    );
  });
});

describe("oracle independence", () => {
  test("the generator's module graph carries no greplost code at runtime", () => {
    const source = readFileSync(path.join(repoRoot, "bench", "src", "truth", "java.ts"), "utf8");
    // Any import of greplost's own code has to be a type-only import, which is erased.
    for (const match of source.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gmu)) {
      const isType = match[1] !== undefined;
      const specifier = match[2] ?? "";
      const greplost = specifier.startsWith("@greplost/") || specifier.endsWith("/ts.ts");
      if (greplost) expect(isType).toBe(true);
    }
    // And the oracle proper is a Java program that cannot reach greplost's code at all: it
    // links no tree-sitter and names no module of the thing it scores.
    const oracle = readFileSync(path.join(toolDir, "Truth.java"), "utf8");
    const code = oracle
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/tree.?sitter/iu);
    expect(code).not.toContain("packages/core");
    expect(code).not.toMatch(/greplost/u);
  });

  test("the oracle's output changes when the fixture changes", () => {
    const root = copyFixture();
    const before = generateTruth(root, FIXTURE_FILES);
    expect(before.exports[`${SRC}/Retry.java`]).not.toContain("Retry.jitter");

    const retry = path.join(root, SRC, "Retry.java");
    const source = readFileSync(retry, "utf8").replace(
      /\n\}\n$/u,
      "\n\n  /** Added by the test. */\n  public static int jitter() {\n    return attempts();\n  }\n}\n",
    );
    writeFileSync(retry, source);
    const after = generateTruth(root, FIXTURE_FILES);

    expect(after.exports[`${SRC}/Retry.java`]).toContain("Retry.jitter");
    expect(keys(after.calls)).toContain(`${SRC}/Retry.java#Retry.jitter -> ${SRC}/Retry.java#Retry.attempts`);
    expect(keys(after.calls).length).toBe(keys(before.calls).length + 1);
  });

  test("removing an import removes the edge", () => {
    const root = copyFixture();
    const app = path.join(root, SRC, "App.java");
    const source = readFileSync(app, "utf8").replace("import tiny.Store;\n", "");
    writeFileSync(app, source);
    const after = generateTruth(root, FIXTURE_FILES);
    // `Store` is still reachable — it is a sibling in the same package — so the file still
    // compiles and the calls stay, but the *import* edge is gone.
    expect(keys(after.imports)).toEqual([`${SRC}/App.java -> ${SRC}/Retry.java`]);
    expect(keys(after.calls)).toContain(`${SRC}/App.java#App.run -> ${SRC}/Store.java#Store.put`);
  });
});
