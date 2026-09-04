/**
 * Terraform reference rules (build 2, leaf 2.2).
 *
 * A throwing stub written by the seam (leaf 2.0) so `linkReferences`'s dispatch table is
 * complete on day one. It can only be reached once leaf 2.2's extractor starts producing
 * `ReferenceRecord`s, and a record nothing can link is a bug: dropping it silently would remove
 * an edge the map claims to carry.
 */

import type { FileRecord, ReferenceEdge, ReferenceRecord } from "../schema.ts";
import type { ReferenceContext } from "./link.ts";

export function resolveHclReferences(
  file: FileRecord,
  ref: ReferenceRecord,
  _ctx: ReferenceContext,
): ReferenceEdge | null {
  throw new Error(
    `greplost: hcl reference resolution is not implemented yet (${file.path}: ${ref.refKind} -> ${ref.to}); ` +
      "see build-2 leaf 2.2",
  );
}
