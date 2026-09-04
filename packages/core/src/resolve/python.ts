/**
 * Python resolution (build 2, leaf 2.1).
 *
 * A stub written by the seam (leaf 2.0) so `createResolver`'s dispatch is complete on day one
 * and leaf 2.1 replaces exactly this file. Creating the resolver is free — a TypeScript repo
 * builds one for every language and must not pay for it — so the failure lands on the first
 * specifier that actually asks, naming the file and the specifier that got there.
 */

import type { CallSite, Confidence, FileRecord } from "../schema.ts";
import type { RepoContext, ResolvedTarget } from "./resolver.ts";

/** Placeholder for the per-language call index leaf 2.1 defines. */
export type PythonCallIndex = Readonly<Record<string, never>>;

export function createPythonResolver(ctx: RepoContext): (fromFile: string, specifier: string) => ResolvedTarget {
  void ctx;
  return (fromFile: string, specifier: string): ResolvedTarget => {
    throw new Error(
      `greplost: the python resolver is not implemented yet (${fromFile} -> ${specifier}); see build-2 leaf 2.1`,
    );
  };
}

export function resolvePythonCall(
  file: FileRecord,
  _site: CallSite,
  _index: PythonCallIndex,
): { to: string; confidence: Confidence } | null {
  throw new Error(
    `greplost: python call resolution is not implemented yet (${file.path}); see build-2 leaf 2.1`,
  );
}
