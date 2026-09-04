/**
 * Files tree-sitter could not read (tech spec Appendix C, ruling 2026-09-03).
 *
 * The extractor recovers around ERROR nodes, so a file the grammar shreds still
 * contributes whatever statements survive inside the error regions. A file whose *root*
 * is an ERROR node, or whose root has an ERROR child, is the other case: the top level
 * of the file is not a program the grammar recognises, so what comes out of it is at best
 * partial. tree-sitter-typescript 0.23.2 is the newest grammar that exists and hono's
 * generic call signatures hit open upstream issue #335, so this bucket is real and has a
 * name: `RESULTS.md` reports it beside S1 and S2 rather than letting those files cost
 * recall silently.
 *
 * This is a *report*, not a behaviour change. Nothing here touches extraction, the
 * artifacts, or what `buildSnapshot` produces; it parses the same files with the same
 * parser module and says which ones came back broken at the root.
 *
 * Upstream: https://github.com/tree-sitter/tree-sitter-typescript/issues/335
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { createParser, type ParserHandle } from "./parser.ts";
import { compareStrings } from "./schema.ts";
import type { Lang } from "./schema.ts";
import { langOf } from "./lang.ts";

/** One file the grammar could not make a program of. */
export interface UnparsableFile {
  /** The path exactly as it was handed in (repo-relative, posix, in greplost id form). */
  path: string;
  lang: Lang;
  /**
   * `error-root`: the parse root is itself an ERROR node — nothing about the file's
   * top level was recognised.
   * `error-child`: the root is a program, but one of its direct children is an ERROR
   * node — a run of top-level source the grammar could not place.
   */
  reason: "error-root" | "error-child";
}

/**
 * Which of `files` parse to a broken root, in the order the paths sort.
 *
 * `files` are repo-relative paths under `root` (an absolute path is used as given). A
 * file with no grammar, or one that cannot be read, is not reported: this answers "which
 * of these did the grammar fail on", and a missing file is not a grammar failure.
 *
 * The parser is created once for the whole list, because compiling the vendored WASM
 * grammars is the expensive part and `ParserHandle.parse` is synchronous afterwards.
 * Callers already holding a handle can pass it in.
 */
export async function findUnparsableFiles(
  root: string,
  files: readonly string[],
  opts?: { parser?: ParserHandle; grammarDir?: string },
): Promise<UnparsableFile[]> {
  const candidates = files
    .map((path) => ({ path, lang: langOf(path) }))
    .filter((entry): entry is { path: string; lang: Lang } => entry.lang !== undefined);
  if (candidates.length === 0) return [];

  const parser =
    opts?.parser ?? (await createParser(opts?.grammarDir === undefined ? undefined : { grammarDir: opts.grammarDir }));

  const found: UnparsableFile[] = [];
  for (const { path, lang } of candidates) {
    let source: string;
    try {
      source = readFileSync(isAbsolute(path) ? path : join(root, path), "utf8");
    } catch {
      continue;
    }
    const reason = brokenRoot(source, lang, parser);
    if (reason !== null) found.push({ path, lang, reason });
  }
  found.sort((a, b) => compareStrings(a.path, b.path));
  return found;
}

/**
 * Why one file's root is broken, or null when it is not.
 *
 * Only the root and its *direct* children are examined. An ERROR deeper in the tree is
 * the recoverable case the extractor already handles (Appendix C: "the extractor recovers
 * around ERROR nodes"), and counting it here would turn a bucket about files nothing could
 * be read from into a bucket about files with any syntax the grammar dislikes.
 */
export function brokenRoot(source: string, lang: Lang, parser: ParserHandle): UnparsableFile["reason"] | null {
  const tree = parser.parse(source, lang);
  try {
    const rootNode = tree.rootNode;
    if (rootNode.type === "ERROR") return "error-root";
    for (const child of rootNode.children) {
      if (child?.type === "ERROR") return "error-child";
    }
    return null;
  } finally {
    // A `Tree` holds a wasm allocation; a walk of a whole repo would otherwise keep one
    // per file alive until the collector got to them.
    tree.delete();
  }
}
