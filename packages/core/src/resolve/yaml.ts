/**
 * YAML resolution (build 2; owned by the seam, leaf 2.0).
 *
 * A YAML file has no import specifiers: a Kubernetes manifest, a Helm chart and a workflow all
 * express their dependencies as *references* (`references/yaml.ts`), never as imports. So this
 * resolver's honest answer is `unresolved` for anything it is ever handed, and a stray
 * specifier is a bug in an extractor rather than something to guess about.
 *
 * `resolveYamlCall` is here for the uniform pipeline shape only (spec section 0.4): YAML has no
 * calls, so no extractor produces a `CallSite` for it.
 */

import type { CallSite, Confidence, FileRecord } from "../schema.ts";
import type { RepoContext, ResolvedTarget } from "./resolver.ts";

const UNRESOLVED: ResolvedTarget = { type: "unresolved" };

export function createYamlResolver(ctx: RepoContext): (fromFile: string, specifier: string) => ResolvedTarget {
  void ctx;
  return (_fromFile: string, _specifier: string): ResolvedTarget => UNRESOLVED;
}

export function resolveYamlCall(
  _file: FileRecord,
  _site: CallSite,
  _index: unknown,
): { to: string; confidence: Confidence } | null {
  return null;
}
