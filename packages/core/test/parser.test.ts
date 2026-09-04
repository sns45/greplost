import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LANGUAGE_VERSION, Language, MIN_COMPATIBLE_VERSION } from "web-tree-sitter";
import { createParser, grammarDir } from "../src/parser.ts";
import { LANG_BY_BASENAME, LANG_BY_EXTENSION } from "../src/schema.ts";
import type { Lang } from "../src/schema.ts";

/** Every language the detection tables can produce, sorted, with no duplicates. */
const ALL_LANGS: readonly Lang[] = [
  ...new Set<Lang>([...Object.values(LANG_BY_EXTENSION), ...Object.values(LANG_BY_BASENAME)]),
].sort();

/**
 * One line per language that the grammar must accept whole. Deliberately trivial: this
 * asserts that the vendored wasm loads and speaks the language, not that it is any good.
 */
const SAMPLES: ReadonlyArray<readonly [Lang, string]> = [
  ["ts", "export const a: number = 1;\n"],
  ["tsx", "export const A = () => <div />;\n"],
  ["js", "export const a = 1;\n"],
  ["jsx", "export const A = () => <div />;\n"],
  ["go", "package main\n\nfunc f() int { return 1 }\n"],
  ["python", "def f():\n    return 1\n"],
  ["rust", "fn f() -> i32 { 1 }\n"],
  ["java", "class A { int f() { return 1; } }\n"],
  ["kotlin", "fun f(): Int = 1\n"],
  ["hcl", 'resource "aws_s3_bucket" "b" {}\n'],
  ["yaml", "a: 1\n"],
  ["dockerfile", "FROM node:20 AS build\n"],
];

/** `<name>.wasm: <package>@<version> (ABI <n>)` lines from the vendoring record. */
function versionsText(): string {
  return readFileSync(join(grammarDir(), "VERSIONS.txt"), "utf8");
}

describe("grammars", () => {
  test("every vendored grammar parses a one-liner without a root error", async () => {
    const parser = await createParser();
    for (const [lang, source] of SAMPLES) {
      const tree = parser.parse(source, lang);
      expect(tree.rootNode.hasError, `${lang} root error`).toBe(false);
      tree.delete();
    }
  });

  test("every language the detection tables produce has a grammar", async () => {
    const parser = await createParser();
    // Sanity: the sample table itself covers the whole language set, so a new `Lang`
    // cannot slip in with neither a grammar nor a sample.
    expect(SAMPLES.map(([lang]) => lang).sort()).toEqual([...ALL_LANGS]);
    for (const lang of ALL_LANGS) {
      const tree = parser.parse("\n", lang);
      tree.delete();
    }
  });

  test("every vendored wasm loads under an ABI web-tree-sitter accepts", async () => {
    // `Parser.init` has to have run before a Language can be compiled.
    await createParser();
    const dir = grammarDir();
    const grammars = readdirSync(dir)
      .filter((name) => name.endsWith(".wasm") && name !== "web-tree-sitter.wasm")
      .sort();
    expect(grammars.length).toBeGreaterThanOrEqual(9);

    for (const name of grammars) {
      const language = await Language.load(join(dir, name));
      expect(language.abiVersion, `${name} ABI`).toBeGreaterThanOrEqual(MIN_COMPATIBLE_VERSION);
      expect(language.abiVersion, `${name} ABI`).toBeLessThanOrEqual(LANGUAGE_VERSION);
    }
  });

  test("VERSIONS.txt records every vendored wasm with the ABI the file reports", async () => {
    await createParser();
    const dir = grammarDir();
    const text = versionsText();
    const grammars = readdirSync(dir)
      .filter((name) => name.endsWith(".wasm") && name !== "web-tree-sitter.wasm")
      .sort();

    for (const name of grammars) {
      const line = text.split("\n").find((candidate) => candidate.includes(name));
      expect(line, `${name} is not recorded in VERSIONS.txt`).toBeDefined();
      const language = await Language.load(join(dir, name));
      expect(line, `${name} ABI in VERSIONS.txt`).toContain(`ABI ${language.abiVersion}`);
    }
  });

  test("the build-2 grammars are all present and pinned", () => {
    const dir = grammarDir();
    const present = new Set(readdirSync(dir));
    const text = versionsText();
    for (const name of ["python", "rust", "java", "kotlin", "yaml", "hcl", "dockerfile"]) {
      expect(present.has(`tree-sitter-${name}.wasm`), `tree-sitter-${name}.wasm is not vendored`).toBe(true);
      expect(text).toContain(`tree-sitter-${name}.wasm`);
    }
  });
});
