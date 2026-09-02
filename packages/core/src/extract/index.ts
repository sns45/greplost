/**
 * Per-file extraction: parse once, dispatch on language, stamp the file identity.
 *
 * Nothing here reads the filesystem or knows about other files: a `FileRecord` is
 * exactly what one file can say about itself (tech spec 5.1).
 */

import type { FileRecord, Lang } from "../schema.ts";
import type { ParserHandle } from "../parser.ts";
import { countLoc } from "../hash.ts";
import { extractGo } from "./go.ts";
import { extractTs } from "./ts.ts";

export interface ExtractInput {
  /** Repo-relative path, forward slashes, no leading "./". */
  path: string;
  lang: Lang;
  source: string;
  /** Hex sha256 of the raw bytes, computed by the caller. */
  sha256: string;
}

export { extractGo } from "./go.ts";
export { extractTs } from "./ts.ts";

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
        return { path, lang, sha256, loc: countLoc(source), ...parts };
      } finally {
        // The record copies every string it needs, so the WASM tree can go now
        // instead of waiting for a finalizer: a whole-repo build holds one tree.
        tree.delete();
      }
    }
    case "go": {
      const tree = parser.parse(source, lang);
      try {
        const parts = extractGo(path, lang, source, tree);
        return { path, lang, sha256, loc: countLoc(source), ...parts };
      } finally {
        tree.delete();
      }
    }
    default:
      throw new Error(`greplost: no extractor for language "${lang}" (${path})`);
  }
}
