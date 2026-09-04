/**
 * Reference layer: `FileRecord.refs` -> `graph/references.jsonl` (schema 2).
 *
 * One entry point (`linkReferences`) and one module per language behind it, reached through the
 * dispatch table in `link.ts`.
 */

export { compareReferenceEdges, linkReferences, referenceSource } from "./link.ts";
export type { ReferenceContext, ReferenceRule } from "./link.ts";

export { resolveDockerfileReferences } from "./dockerfile.ts";
export { resolveGoReferences } from "./go.ts";
export { resolveHclReferences } from "./hcl.ts";
export { resolveTsReferences } from "./ts.ts";
export { resolveYamlReferences } from "./yaml.ts";
export { resolveYamlActionsReferences } from "./yaml-actions.ts";
export { resolveYamlK8sReferences } from "./yaml-k8s.ts";
