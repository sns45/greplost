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

/**
 * A parser bound to the vendored grammars. `parse` is synchronous by contract.
 *
 * A handle owns one wasm `Parser`, and a wasm allocation is not garbage: the emscripten
 * heap only ever grows, so a handle that is dropped rather than disposed keeps its parse
 * stack and its subtree pool for the life of the process. One handle per build is
 * invisible in a CLI run and unbounded in a long-lived one (`bench:replay` builds a repo
 * once per commit); `dispose` is what bounds it.
 */
export interface ParserHandle {
  parse(source: string, lang: Lang): Tree;
  /**
   * Release the wasm parser this handle owns. Idempotent, and safe while other handles
   * live: the compiled grammars are process-wide and shared, so nothing here touches
   * them. `parse` after this throws rather than reaching into freed wasm memory.
   *
   * A `Tree` this handle returned is independent of it and is still the caller's to
   * `delete`; nothing is retained here that disposal would free on the caller's behalf.
   */
  dispose(): void;
}

/**
 * Grammar file per language. ts/js share the TypeScript grammar; tsx/jsx share the TSX one;
 * every YAML flavour (plain, Kubernetes, Helm, GitHub Actions) shares the YAML grammar, since
 * a flavour is a property of the document, not of the syntax.
 *
 * The type stays `Partial` on purpose: a language may be named in `Lang` before its grammar is
 * vendored, and asking for one of those must be a clear error rather than a silent skip. As of
 * schema 2 the table is complete, so the error path below is a guard, not a normal outcome.
 */
const GRAMMAR_FILE: Readonly<Partial<Record<Lang, string>>> = {
  ts: "tree-sitter-typescript.wasm",
  js: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  jsx: "tree-sitter-tsx.wasm",
  go: "tree-sitter-go.wasm",
  python: "tree-sitter-python.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  hcl: "tree-sitter-hcl.wasm",
  yaml: "tree-sitter-yaml.wasm",
  dockerfile: "tree-sitter-dockerfile.wasm",
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
  let disposed = false;

  return {
    parse(source: string, lang: Lang): Tree {
      if (disposed) throw new Error("greplost: this parser handle has been disposed");
      const file = GRAMMAR_FILE[lang];
      if (file === undefined) {
        throw new Error(`greplost: no grammar is vendored for "${lang}" (see packages/core/grammars/VERSIONS.txt)`);
      }
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
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // `current` is the language the freed parser was set to; clearing it keeps the
      // handle's own state consistent with the wasm object it no longer owns.
      current = null;
      parser.delete();
    },
  };
}

/**
 * The spare parser used by error recovery.
 *
 * Ownership: this module owns exactly one, for the life of the process, alongside
 * the process-wide runtime init and grammar cache above. It is created on first
 * use and never recreated per file, because a `Parser` is a fixed wasm allocation
 * of a few kilobytes while creating one costs more than the re-parse it serves.
 * `disposeSpareParser` releases it for a host that wants the memory back; the next
 * `reparse` simply builds a new one.
 */
let spare: Parser | null = null;
let spareLanguage: Language | null = null;

/**
 * Re-parse a fragment with a language that is already compiled, synchronously.
 *
 * Error recovery uses this to re-read a region the parser could not make sense of
 * in context: the fragment is verbatim source, so what comes back is still a real
 * parse, never a guess. A `Tree` is independent of the parser that produced it, so
 * nesting re-parses is safe.
 */
export function reparse(language: Language, source: string): Tree | null {
  if (spare === null) spare = new Parser();
  if (spareLanguage !== language) {
    spare.setLanguage(language);
    spareLanguage = language;
  }
  return spare.parse(source);
}

/** Release the spare parser. The next `reparse` transparently creates another. */
export function disposeSpareParser(): void {
  if (spare === null) return;
  spare.delete();
  spare = null;
  spareLanguage = null;
}
