/**
 * Go reference rules (build 2, leaf 2.7; spec 2026-09-04 sections 0.3 and 3.6).
 *
 * Go expresses every dependency it has as an import or a call, so a Go file produced no
 * `ReferenceRecord` at all until the `pulumi-go` signal pass landed. The one it produces now is
 * `resource-input`: a Pulumi resource fed another resource's output. `ref.to` is the
 * language-native address that produced it (`bucket.ID`, `vpc.Arn`), and its head is the
 * binding name.
 *
 * Why there is no `med` branch here, unlike `references/ts.ts`. Spec 3.5's second rule — "`med`
 * when it is imported from exactly one other indexed file that declares it" — has no Go
 * analogue: a Pulumi Go resource is bound by a function-local `:=`, and a Go import binds a
 * *package*, never a resource. There is no name to hop through, so a head that is not a
 * resource in this file resolves to nothing and the reference is dropped. Ambiguity is dropped
 * too: a file that bound the same name twice holds `resource.b` *and* `resource.b~2`, and an
 * input naming `b` cannot say which one it meant.
 *
 * Reached through the dispatch table in `link.ts`, which owns the two rules this file must not
 * re-implement: an edge never targets `unresolved:`, and the result is sorted and deduplicated.
 */

import type { FileRecord, ReferenceEdge, ReferenceRecord } from "../schema.ts";
import { nodeId } from "../schema.ts";
import type { ReferenceContext } from "./link.ts";
import { referenceSource } from "./link.ts";

export function resolveGoReferences(
  file: FileRecord,
  ref: ReferenceRecord,
  ctx: ReferenceContext,
): ReferenceEdge | null {
  // Every other `RefKind` belongs to a language that is not Go. A record that reaches here is a
  // bug in whichever pass wrote it, and dropping it is the safe answer.
  if (ref.refKind !== "resource-input") return null;

  // `bucket.ID` names the binding `bucket`; the field is what makes the edge worth showing,
  // not what it resolves to.
  const dot = ref.to.indexOf(".");
  const head = dot < 0 ? ref.to : ref.to.slice(0, dot);
  const id = nodeId(file.path, "resource", head);
  if (!ctx.declarationById.has(id)) return null;
  // `~2` is how the pass disambiguates a duplicate name inside one file; its presence means the
  // bare name was bound twice, so nothing may resolve to either.
  if (ctx.declarationById.has(nodeId(file.path, "resource", `${head}~2`))) return null;

  return {
    from: referenceSource(file.path, ref),
    to: id,
    kind: "reference",
    refKind: ref.refKind,
    symbols: [ref.to],
    confidence: "high",
  };
}
