/**
 * Java resolution (build 2, leaf 2.5).
 *
 * A stub written by the seam (leaf 2.0); see `resolve/python.ts` for why creation succeeds and
 * resolution throws.
 */

import type { CallSite, Confidence, FileRecord } from "../schema.ts";
import type { RepoContext, ResolvedTarget } from "./resolver.ts";

/** Placeholder for the per-language call index leaf 2.5 defines. */
export type JavaCallIndex = Readonly<Record<string, never>>;

export function createJavaResolver(ctx: RepoContext): (fromFile: string, specifier: string) => ResolvedTarget {
  void ctx;
  return (fromFile: string, specifier: string): ResolvedTarget => {
    throw new Error(
      `greplost: the java resolver is not implemented yet (${fromFile} -> ${specifier}); see build-2 leaf 2.5`,
    );
  };
}

export function resolveJavaCall(
  file: FileRecord,
  _site: CallSite,
  _index: JavaCallIndex,
): { to: string; confidence: Confidence } | null {
  throw new Error(`greplost: java call resolution is not implemented yet (${file.path}); see build-2 leaf 2.5`);
}
