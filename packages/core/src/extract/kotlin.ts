/**
 * Kotlin extraction (build 2, leaf 2.6).
 *
 * A throwing stub written by the seam (leaf 2.0); see `extract/python.ts` for why the stub
 * throws instead of returning an empty record.
 */

import type { FileRecord, Lang } from "../schema.ts";
import type { Tree } from "web-tree-sitter";

export function extractKotlin(
  path: string,
  _lang: Lang,
  _source: string,
  _tree: Tree,
): Pick<FileRecord, "decls" | "imports" | "exports" | "calls" | "refs"> {
  throw new Error(`greplost: the kotlin extractor is not implemented yet (${path}); see build-2 leaf 2.6`);
}
