/**
 * Rust truth generator tests (leaf 2.4, gates G8 and G9).
 *
 * Everything in `fixture truth` is read off `fixtures/tiny-rust` by hand and pinned: these are
 * the numbers the Rust structure layer is scored against, so they are written out in full
 * rather than recomputed from the thing under test. `oracle independence` is the integrity
 * check of tech spec 10.1 principle 2: the oracle must not be able to agree with greplost by
 * construction, so it may share no runtime code with `packages/core`, and its output has to
 * move when the fixture moves.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateTruth, NOTES, rustTruthTool } from "../src/truth/rust.ts";
import { edgeKey, exportKeys } from "../src/score.ts";
import type { Truth } from "../src/truth/ts.ts";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const fixtureRoot = path.join(repoRoot, "fixtures", "tiny-rust");
const toolDir = path.join(repoRoot, "bench", "truth", "rusttruth");

/** The four indexed files of the fixture. */
const FIXTURE_FILES = ["src/lib.rs", "src/main.rs", "src/retry.rs", "src/store.rs"];

const truth: Truth = generateTruth(fixtureRoot, FIXTURE_FILES);

const keys = (edges: { from: string; to: string }[]): string[] => edges.map(edgeKey);

const temps: string[] = [];

afterAll(() => {
  for (const root of temps) rmSync(root, { recursive: true, force: true });
});

/** A throwaway copy of the fixture, so a test may edit it. */
function copyFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "greplost-rust-truth-"));
  temps.push(root);
  cpSync(fixtureRoot, root, { recursive: true });
  return root;
}

describe("rust tool", () => {
  test("the syn helper is built once and cached under bench/.corpus/.tools", () => {
    const binary = rustTruthTool();
    expect(existsSync(binary)).toBe(true);
    expect(path.dirname(binary)).toBe(path.join(repoRoot, "bench", ".corpus", ".tools"));
    // Content-addressed by its own sources, so a second call never rebuilds.
    expect(rustTruthTool()).toBe(binary);
    expect(path.basename(binary)).toMatch(/^rusttruth-[0-9a-f]{16}$/);
  });

  test("the helper crate pins every dependency in a committed Cargo.lock", () => {
    const manifest = readFileSync(path.join(toolDir, "Cargo.toml"), "utf8");
    expect(manifest).toMatch(/^edition = "2021"$/m);
    // Exact `=` requirements, so the lockfile and the manifest can never disagree.
    expect(manifest).toMatch(/^syn = \{ version = "=2\.0\.\d+"/m);
    expect(manifest).toMatch(/^cargo_metadata = "=0\.\d+\.\d+"$/m);
    expect(manifest).toMatch(/^proc-macro2 = "=1\.0\.\d+"$/m);
    const lock = readFileSync(path.join(toolDir, "Cargo.lock"), "utf8");
    for (const crate of ["syn", "proc-macro2", "cargo_metadata", "serde_json"]) {
      expect(lock).toContain(`name = "${crate}"`);
    }
    // Every locked package carries a version and a source; nothing floats.
    const packages = lock.match(/^\[\[package\]\]$/gmu)?.length ?? 0;
    expect(packages).toBeGreaterThan(10);
    expect(lock.match(/^name = /gmu)?.length).toBe(packages);
  });

  test("the oracle discloses how it was built", () => {
    expect([...NOTES]).toEqual(["syn-item-tree", "cargo-metadata-roots", "no-trait-dispatch"]);
    expect(truth.notes).toEqual([...NOTES]);
  });
});

describe("fixture truth", () => {
  test("truth covers exactly the indexed Rust files", () => {
    expect(truth.files).toEqual(FIXTURE_FILES);
  });

  test("the module tree and the use trees are both import edges", () => {
    expect(keys(truth.imports)).toEqual([
      "src/lib.rs -> src/retry.rs",
      "src/lib.rs -> src/store.rs",
      "src/main.rs -> src/retry.rs",
      "src/main.rs -> src/store.rs",
      "src/retry.rs -> src/store.rs",
      "src/store.rs -> src/retry.rs",
    ]);
    expect(truth.imports.every((e) => e.kind === "import" && e.confidence === "high")).toBe(true);
  });

  test("a std or external crate is never an edge target", () => {
    expect(truth.imports.some((e) => e.to.startsWith("ext:") || e.to.includes("std"))).toBe(false);
  });

  test("exports are the pub items of each file, with the glob re-export followed", () => {
    expect(truth.exports).toEqual({
      "src/lib.rs": ["Backoff", "Store", "poll", "poll_dyn", "run", "store", "warm"],
      "src/main.rs": [],
      "src/retry.rs": ["Backoff", "poll", "poll_dyn", "run", "warm"],
      "src/store.rs": ["Store"],
    });
  });

  test("a private item, a method and a trait method are not exports of the file", () => {
    const names = exportKeys(truth.exports);
    expect(names).not.toContain("src/retry.rs#ATTEMPTS");
    expect(names).not.toContain("src/store.rs#Store.put");
    expect(names).not.toContain("src/retry.rs#Backoff.next");
  });

  test("call edges follow spec 1.3's rules", () => {
    expect(keys(truth.calls)).toEqual([
      "src/main.rs#main -> src/retry.rs#run",
      "src/main.rs#main -> src/store.rs#Store.new",
      "src/main.rs#main -> src/store.rs#Store.put",
      "src/retry.rs#warm -> src/store.rs#Store.put",
      "src/store.rs#Store.put -> src/store.rs#Store.record",
    ]);
    expect(truth.calls.every((e) => e.kind === "call")).toBe(true);
  });

  test("a trait-dispatched call is absent from truth, exactly as it is from the map", () => {
    // `poll` and `poll_dyn` call `next()` on a generic and on a `dyn` receiver.
    expect(truth.calls.some((e) => e.to.endsWith("#Backoff.next"))).toBe(false);
    expect(truth.calls.some((e) => e.from.endsWith("#poll") || e.from.endsWith("#poll_dyn"))).toBe(false);
  });

  test("Rust does have import cycles, and this one is found", () => {
    expect(truth.cycles).toEqual([["src/retry.rs", "src/store.rs"]]);
  });

  test("every collection is sorted and the run is deterministic", () => {
    expect(JSON.stringify(generateTruth(fixtureRoot, FIXTURE_FILES))).toBe(JSON.stringify(truth));
    expect([...truth.files].sort()).toEqual(truth.files);
  });

  test("a caller file list narrows the universe on both ends", () => {
    const narrowed = generateTruth(fixtureRoot, ["src/store.rs", "src/retry.rs"]);
    expect(narrowed.files).toEqual(["src/retry.rs", "src/store.rs"]);
    expect(keys(narrowed.imports)).toEqual(["src/retry.rs -> src/store.rs", "src/store.rs -> src/retry.rs"]);
    // `main`'s calls leave the universe and are dropped from both ends.
    expect(keys(narrowed.calls)).toEqual([
      "src/retry.rs#warm -> src/store.rs#Store.put",
      "src/store.rs#Store.put -> src/store.rs#Store.record",
    ]);
    expect(Object.keys(narrowed.exports)).toEqual(["src/retry.rs", "src/store.rs"]);
  });

  test("a file list the oracle never parsed is an error, not four perfect scores", () => {
    expect(() => generateTruth(fixtureRoot, ["src/absent.rs"])).toThrow(
      /greplost: rust truth is empty for .*parsed none of the 1 requested files/,
    );
  });

  test("a tree with no cargo package is an error too", () => {
    const root = mkdtempSync(path.join(tmpdir(), "greplost-rust-empty-"));
    temps.push(root);
    writeFileSync(path.join(root, "lone.rs"), "pub fn a() {}\n");
    expect(() => generateTruth(root, ["lone.rs"])).toThrow(
      /greplost: rust truth is empty for .*cargo metadata reported no package/,
    );
  });
});

describe("oracle independence", () => {
  test("the generator's module graph carries no greplost code at runtime", () => {
    const source = readFileSync(path.join(repoRoot, "bench", "src", "truth", "rust.ts"), "utf8");
    // Any import of greplost's own code has to be a type-only import, which is erased.
    for (const match of source.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gmu)) {
      const isType = match[1] !== undefined;
      const specifier = match[2] ?? "";
      const greplost = specifier.startsWith("@greplost/") || specifier.endsWith("/ts.ts");
      if (greplost) expect(isType).toBe(true);
    }
    // And the oracle proper is a Rust program that cannot reach greplost's code at all: it
    // declares no path dependency, and it links no tree-sitter.
    const manifest = readFileSync(path.join(toolDir, "Cargo.toml"), "utf8");
    expect(manifest).not.toMatch(/^\s*path\s*=\s*"\.\./mu);
    expect(manifest).not.toMatch(/tree.?sitter/iu);
    const oracle = readFileSync(path.join(toolDir, "src", "main.rs"), "utf8");
    const code = oracle
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/tree.?sitter/iu);
    expect(code).not.toContain("packages/core");
    // The one mention of greplost left in the program is the artifact directory it skips.
    expect(code.match(/greplost/gu)?.length ?? 0).toBe(1);
  });

  test("the oracle's output changes when the fixture changes", () => {
    const root = copyFixture();
    const before = generateTruth(root, FIXTURE_FILES);
    expect(before.exports["src/retry.rs"]).not.toContain("jitter");

    const retry = path.join(root, "src", "retry.rs");
    writeFileSync(retry, `${readFileSync(retry, "utf8")}\npub fn jitter() -> u64 { run(); 0 }\n`);
    const after = generateTruth(root, FIXTURE_FILES);

    expect(after.exports["src/retry.rs"]).toContain("jitter");
    // The glob re-export in lib.rs carries the new name across too.
    expect(after.exports["src/lib.rs"]).toContain("jitter");
    expect(keys(after.calls)).toContain("src/retry.rs#jitter -> src/retry.rs#run");
    expect(keys(after.calls).length).toBe(keys(before.calls).length + 1);
  });

  test("removing an import removes the edge and the cycle with it", () => {
    const root = copyFixture();
    const store = path.join(root, "src", "store.rs");
    const source = readFileSync(store, "utf8")
      .replace("use crate::retry::Backoff;\n", "")
      .replace(/impl Backoff for Store \{[\s\S]*?\n\}\n/u, "");
    writeFileSync(store, source);
    const after = generateTruth(root, FIXTURE_FILES);
    expect(keys(after.imports)).not.toContain("src/store.rs -> src/retry.rs");
    expect(after.cycles).toEqual([]);
  });
});
