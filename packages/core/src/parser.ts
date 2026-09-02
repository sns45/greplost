/**
 * Tree-sitter parser handle backed by the vendored WASM grammars.
 *
 * The grammars live in `packages/core/grammars/` (see VERSIONS.txt) so an install
 * never needs a C++ toolchain. `GREPLOST_GRAMMAR_DIR` overrides the location.
 */

import { Language, Parser } from "web-tree-sitter";
import type { Tree } from "web-tree-sitter";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Lang } from "./schema.ts";

/** A parser bound to the vendored grammars. `parse` is synchronous by contract. */
export interface ParserHandle {
  parse(source: string, lang: Lang): Tree;
}

/** Grammar file per language. ts/js share the TypeScript grammar; tsx/jsx share the TSX one. */
const GRAMMAR_FILE: Readonly<Record<Lang, string>> = {
  ts: "tree-sitter-typescript.wasm",
  js: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  jsx: "tree-sitter-tsx.wasm",
  go: "tree-sitter-go.wasm",
};

/** The runtime WASM the emscripten module loads through `locateFile`. */
const RUNTIME_FILE = "web-tree-sitter.wasm";

/** Directory holding the vendored grammars: `GREPLOST_GRAMMAR_DIR` or `<packages/core>/grammars`. */
export function grammarDir(): string {
  const override = process.env["GREPLOST_GRAMMAR_DIR"];
  if (override !== undefined && override !== "") return override;
  return fileURLToPath(new URL("../grammars", import.meta.url));
}

/**
 * `Parser.init` configures one process-wide emscripten module, so it runs at most
 * once. The runtime WASM is byte-identical across grammar directories, which is why
 * a later handle with a different `grammarDir` can safely reuse the first init.
 */
let runtimeInit: Promise<void> | null = null;

function initRuntime(dir: string): Promise<void> {
  if (runtimeInit === null) {
    runtimeInit = Parser.init({ locateFile: () => join(dir, RUNTIME_FILE) }).catch((cause: unknown) => {
      runtimeInit = null;
      throw new Error(`greplost: cannot initialise the tree-sitter runtime from ${dir}: ${message(cause)}`);
    });
  }
  return runtimeInit;
}

/** Compiled grammars, keyed by absolute wasm path so two grammar dirs never collide. */
const languages = new Map<string, Promise<Language>>();

function loadLanguage(file: string): Promise<Language> {
  const cached = languages.get(file);
  if (cached !== undefined) return cached;
  const loading = Language.load(file).catch((cause: unknown) => {
    languages.delete(file);
    throw new Error(`greplost: cannot load tree-sitter grammar ${file}: ${message(cause)}`);
  });
  languages.set(file, loading);
  return loading;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Create a parser handle. Every vendored grammar is compiled here, once, because
 * `ParserHandle.parse` is synchronous and WASM compilation is not: a grammar that
 * was not loaded up front could never be loaded from inside `parse`. Compiled
 * grammars are cached for the process, so extra handles are cheap.
 */
export async function createParser(opts?: { grammarDir?: string }): Promise<ParserHandle> {
  const dir = opts?.grammarDir ?? grammarDir();
  await initRuntime(dir);

  const files = [...new Set(Object.values(GRAMMAR_FILE))].sort();
  const loaded = await Promise.all(
    files.map(async (file) => [file, await loadLanguage(join(dir, file))] as const),
  );
  const byFile = new Map<string, Language>(loaded);

  const parser = new Parser();
  let current: string | null = null;

  return {
    parse(source: string, lang: Lang): Tree {
      const file = GRAMMAR_FILE[lang];
      const language = byFile.get(file);
      if (language === undefined) throw new Error(`greplost: no grammar loaded for language "${lang}"`);
      if (current !== file) {
        parser.setLanguage(language);
        current = file;
      }
      const tree = parser.parse(source);
      if (tree === null) throw new Error(`greplost: tree-sitter failed to parse ${lang} source`);
      return tree;
    },
  };
}

/**
 * Re-parse a fragment with a language that is already compiled, synchronously.
 *
 * Error recovery uses this to re-read a region the parser could not make sense of
 * in context: the fragment is verbatim source, so what comes back is still a real
 * parse, never a guess. One spare parser is created on first use and reused; a
 * `Tree` is independent of the parser that produced it, so nesting is safe.
 */
let spare: Parser | null = null;

export function reparse(language: Language, source: string): Tree | null {
  if (spare === null) spare = new Parser();
  spare.setLanguage(language);
  return spare.parse(source);
}
