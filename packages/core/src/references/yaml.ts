/**
 * YAML reference flavour dispatch (build 2; owned by the seam, leaf 2.0).
 *
 * The mirror of `extract/yaml.ts` on the linking side: a `.yaml` file's references are Actions
 * references or Kubernetes/Helm references, and this is the only place that decides which.
 *
 * The parse tree is long gone by the time references are linked, so the flavour is recovered
 * from the path alone: a file under `.github/workflows/` is a workflow, everything else is a
 * manifest or a chart. That is enough, because the two flavours have disjoint `refKind`s
 * (`needs`/`uses` against `selector`/`config-ref`/`helm-values`/`from-image`) and a mismatch
 * would therefore surface as an unresolvable reference rather than a wrong edge.
 *
 * Helm has no reference module of its own: spec section 2.3 puts `helm-values` in
 * `references/yaml-k8s.ts` alongside the selector and config rules, because a Helm chart's
 * references are Kubernetes references with one extra source.
 */

import type { FileRecord, RefKind, ReferenceEdge, ReferenceRecord } from "../schema.ts";
import { isWorkflowPath } from "../extract/yaml.ts";
import type { ReferenceContext } from "./link.ts";
import { resolveYamlActionsReferences } from "./yaml-actions.ts";
import { resolveYamlK8sReferences } from "./yaml-k8s.ts";

/**
 * The three mechanisms only a workflow produces (leaf 2.9).
 *
 * The path is no longer enough on its own: a composite action's `action.yml` and a workflow
 * template outside `.github/workflows/` are both Actions files at other paths (see the
 * classification ruling in `extract/yaml.ts`). The `refKind` is enough, and it was already the
 * reason a mismatch here was safe, the two flavours' kinds are disjoint, so the dispatch is
 * made on the thing that actually distinguishes them, with the path kept as the fallback for a
 * kind no extractor emits.
 */
const ACTIONS_REF_KINDS: ReadonlySet<RefKind> = new Set<RefKind>(["needs", "uses", "config"]);

export function resolveYamlReferences(
  file: FileRecord,
  ref: ReferenceRecord,
  ctx: ReferenceContext,
): ReferenceEdge | null {
  return ACTIONS_REF_KINDS.has(ref.refKind) || isWorkflowPath(file.path)
    ? resolveYamlActionsReferences(file, ref, ctx)
    : resolveYamlK8sReferences(file, ref, ctx);
}
