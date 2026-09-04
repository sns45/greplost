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

import type { FileRecord, ReferenceEdge, ReferenceRecord } from "../schema.ts";
import { isWorkflowPath } from "../extract/yaml.ts";
import type { ReferenceContext } from "./link.ts";
import { resolveYamlActionsReferences } from "./yaml-actions.ts";
import { resolveYamlK8sReferences } from "./yaml-k8s.ts";

export function resolveYamlReferences(
  file: FileRecord,
  ref: ReferenceRecord,
  ctx: ReferenceContext,
): ReferenceEdge | null {
  return isWorkflowPath(file.path)
    ? resolveYamlActionsReferences(file, ref, ctx)
    : resolveYamlK8sReferences(file, ref, ctx);
}
