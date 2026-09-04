/**
 * Python extraction (build 2, leaf 2.1).
 *
 * A throwing stub written by the seam (leaf 2.0) so `extractFile`'s dispatch table is complete
 * on day one and leaf 2.1 replaces exactly this file, editing nothing shared. A language that
 * is configured but not implemented must fail loudly: silently returning an empty record would
 * put the file in the map with no declarations and no imports, which reads as "this file is
 * empty" rather than "greplost cannot read this yet".
 */

import type { FileRecord, Lang } from "../schema.ts";
import type { Tree } from "web-tree-sitter";

export function extractPython(
  path: string,
  _lang: Lang,
  _source: string,
  _tree: Tree,
): Pick<FileRecord, "decls" | "imports" | "exports" | "calls" | "refs"> {
  throw new Error(`greplost: the python extractor is not implemented yet (${path}); see build-2 leaf 2.1`);
}
