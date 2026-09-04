/**
 * Terraform (HCL) resolution (build 2, leaf 2.2).
 *
 * A stub written by the seam (leaf 2.0); see `resolve/python.ts` for why creation succeeds and
 * resolution throws. HCL has no calls, so `resolveHclCall` exists only to keep the shape of the
 * language pipeline uniform (spec section 0.4) and is never reached: leaf 2.2's extractor
 * produces no `CallSite`.
 */

import type { CallSite, Confidence, FileRecord } from "../schema.ts";
import type { RepoContext, ResolvedTarget } from "./resolver.ts";

/** Placeholder for the per-language call index leaf 2.2 defines. */
export type HclCallIndex = Readonly<Record<string, never>>;

export function createHclResolver(ctx: RepoContext): (fromFile: string, specifier: string) => ResolvedTarget {
  void ctx;
  return (fromFile: string, specifier: string): ResolvedTarget => {
    throw new Error(
      `greplost: the hcl resolver is not implemented yet (${fromFile} -> ${specifier}); see build-2 leaf 2.2`,
    );
  };
}

export function resolveHclCall(
  file: FileRecord,
  _site: CallSite,
  _index: HclCallIndex,
): { to: string; confidence: Confidence } | null {
  throw new Error(`greplost: hcl call resolution is not implemented yet (${file.path}); see build-2 leaf 2.2`);
}
