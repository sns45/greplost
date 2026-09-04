/**
 * Dockerfile reference rules (build 2, leaf 2.10).
 *
 * A throwing stub written by the seam (leaf 2.0); see `references/hcl.ts` for why an unlinkable
 * reference is loud rather than dropped.
 */

import type { FileRecord, ReferenceEdge, ReferenceRecord } from "../schema.ts";
import type { ReferenceContext } from "./link.ts";

export function resolveDockerfileReferences(
  file: FileRecord,
  ref: ReferenceRecord,
  _ctx: ReferenceContext,
): ReferenceEdge | null {
  throw new Error(
    `greplost: dockerfile reference resolution is not implemented yet ` +
      `(${file.path}: ${ref.refKind} -> ${ref.to}); see build-2 leaf 2.10`,
  );
}
