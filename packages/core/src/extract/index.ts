/**
 * Per-file extraction: parse once, dispatch on language, stamp the file identity.
 *
 * Nothing here reads the filesystem or knows about other files: a `FileRecord` is
 * exactly what one file can say about itself (tech spec 5.1).
 */

import type { FileRecord, Lang } from "../schema.ts";
import type { ParserHandle } from "../parser.ts";
import { extractTs } from "./ts.ts";

export interface ExtractInput {
  /** Repo-relative path, forward slashes, no leading "./". */
  path: string;
  lang: Lang;
  source: string;
  /** Hex sha256 of the raw bytes, computed by the caller. */
  sha256: string;
}

export { extractTs } from "./ts.ts";

/**
 * Lines in a file: "\n" count, plus one when the last line has no newline.
 * An empty file has none.
 */
export function countLines(source: string): number {
  if (source.length === 0) return 0;
  let newlines = 0;
  for (let i = source.indexOf("\n"); i !== -1; i = source.indexOf("\n", i + 1)) newlines += 1;
  return source.endsWith("\n") ? newlines : newlines + 1;
}

export function extractFile(input: ExtractInput, parser: ParserHandle): FileRecord {
  const { path, lang, source, sha256 } = input;
  switch (lang) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx": {
      const tree = parser.parse(source, lang);
      try {
        const parts = extractTs(path, lang, source, tree);
        return { path, lang, sha256, loc: countLines(source), ...parts };
      } finally {
        // The record copies every string it needs, so the WASM tree can go now
        // instead of waiting for a finalizer: a whole-repo build holds one tree.
        tree.delete();
      }
    }
    default:
      throw new Error(`greplost: no extractor for language "${lang}" (${path})`);
  }
}
