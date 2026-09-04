/**
 * Dockerfile reference rules (build 2, spec 2026-09-04 sections 0.3 and 2.5).
 *
 * `extractDockerfile` records the raw text of everything an instruction names; this module
 * decides which node that text means, and at what confidence, or drops it. The rule is the one
 * that governs call edges (tech spec 5.1): `high` when the text resolves to exactly one node,
 * **anything ambiguous dropped, never guessed**.
 *
 * Three kinds, and the scope of each:
 *
 *  - `from-image` — a stage's base. It names an **earlier stage of the same file** when one
 *    carries that alias (docker's own rule: a stage can only build on a stage already defined),
 *    and otherwise the image it pulls, `ext:image/<ref>`.
 *  - `copy-from` — `COPY --from=<stage>`, which names either a stage of the same file (by
 *    alias, or by 0-based index, both of which docker accepts) or an image nothing in the repo
 *    builds, `ext:image/<ref>`.
 *  - `config` — a `COPY`/`ADD` source, resolved through `resolve/dockerfile.ts` to the one
 *    indexed repo file it names. Nothing else in build 2 links a container recipe back to the
 *    code it ships.
 *
 * A reference whose text is built from a build variable (`FROM $BASE`) resolves to nothing at
 * all: `ext:image/$BASE` would be an external node naming no image, exactly the reason the
 * Kubernetes leaf refuses a templated `image:` value. Stage names are matched case-insensitively
 * because docker lowercases them, and the file's own text is kept as the edge's `symbols` so a
 * card can show why the edge exists.
 *
 * Nothing here ever returns an `unresolved:` target (spec 0.3): a reference the map cannot
 * place is not an edge at all.
 */

import type { Declaration, FileRecord, ReferenceEdge, ReferenceRecord } from "../schema.ts";
import { externalId, symbolId } from "../schema.ts";
import type { ReferenceContext } from "./link.ts";
import { referenceSource } from "./link.ts";

/** The `ext:` namespace a container image lands in (spec section 0.2). */
export const IMAGE_NAMESPACE = "image/";

/** A `--from=<n>` that names a stage by its position rather than by an alias. */
const STAGE_INDEX = /^\d+$/u;

function edge(
  file: FileRecord,
  ref: ReferenceRecord,
  to: string,
  confidence: ReferenceEdge["confidence"],
): ReferenceEdge {
  return {
    from: referenceSource(file.path, ref),
    to,
    kind: "reference",
    refKind: ref.refKind,
    // The text the file wrote, so a card can show *why* the edge exists.
    symbols: [ref.to],
    confidence,
  };
}

/** Every `stage` declaration of this file, in source order. */
function stagesOf(file: FileRecord): Declaration[] {
  return file.decls.filter((decl) => decl.kind === "stage");
}

/** The declaration a reference starts from, or null for a file-level reference. */
function ownerOf(file: FileRecord, ref: ReferenceRecord): Declaration | null {
  if (ref.from === "") return null;
  const id = symbolId(file.path, ref.from);
  return file.decls.find((decl) => decl.id === id) ?? null;
}

/** The 0-based position `meta.index` records, or null when the declaration is not a stage. */
function indexOf(stage: Declaration): number | null {
  const raw = stage.meta?.["index"];
  if (raw === undefined) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? null : value;
}

/**
 * Every stage `name` could mean, in source order.
 *
 * `before` bounds the search the way docker does: a base image may only name a stage already
 * defined. `COPY --from` gets `Infinity` — it too must name an earlier stage to build, but a
 * file that gets that wrong does not build at all, and the ambiguity rule below is what keeps
 * a wrong file from producing a wrong edge.
 *
 * More than one match is the case that matters: a text naming two stages names a *stage*, so
 * the reference is dropped as ambiguous rather than falling through to `ext:image/<name>`,
 * which would publish an image reference nobody wrote.
 */
function stagesNamed(file: FileRecord, name: string, before: number): Declaration[] {
  const wanted = name.toLowerCase();
  return stagesOf(file).filter((stage) => {
    const index = indexOf(stage);
    return stage.name.toLowerCase() === wanted && index !== null && index < before;
  });
}

/** The stage at a 0-based position, or null when the file has none there. */
function stageAt(file: FileRecord, position: number, owner: Declaration | null): Declaration | null {
  const found = stagesOf(file).filter((stage) => indexOf(stage) === position && stage.id !== owner?.id);
  return found.length === 1 ? (found[0] as Declaration) : null;
}

/**
 * An image reference, or null when the text is not one.
 *
 * A reference holding a build variable names whatever the builder computes, which is not an
 * image and must not become an `ext:` node (spec 2.3 applies the same rule to a templated
 * Kubernetes `image:`).
 */
function imageTarget(reference: string): string | null {
  if (reference === "" || reference.includes("$")) return null;
  return externalId(`${IMAGE_NAMESPACE}${reference}`);
}

/** A stage's base: an earlier sibling stage, else the image it pulls. */
function resolveFromImage(
  file: FileRecord,
  ref: ReferenceRecord,
  _ctx: ReferenceContext,
): ReferenceEdge | null {
  const owner = ownerOf(file, ref);
  const position = owner === null ? 0 : (indexOf(owner) ?? 0);
  const siblings = stagesNamed(file, ref.to, position);
  if (siblings.length === 1) return edge(file, ref, (siblings[0] as Declaration).id, "high");
  if (siblings.length > 1) return null;
  const image = imageTarget(ref.to);
  return image === null ? null : edge(file, ref, image, "high");
}

/** `COPY --from=<stage>`: a sibling stage by alias or by index, else an external image. */
function resolveCopyFrom(
  file: FileRecord,
  ref: ReferenceRecord,
  _ctx: ReferenceContext,
): ReferenceEdge | null {
  const owner = ownerOf(file, ref);
  if (STAGE_INDEX.test(ref.to)) {
    // A bare number is a stage position and never an image name, so a position the file does
    // not have resolves to nothing rather than to `ext:image/7`.
    const stage = stageAt(file, Number.parseInt(ref.to, 10), owner);
    return stage === null ? null : edge(file, ref, stage.id, "high");
  }
  const siblings = stagesNamed(file, ref.to, Number.POSITIVE_INFINITY).filter((stage) => stage.id !== owner?.id);
  if (siblings.length === 1) return edge(file, ref, (siblings[0] as Declaration).id, "high");
  if (siblings.length > 1) return null;
  const image = imageTarget(ref.to);
  return image === null ? null : edge(file, ref, image, "high");
}

/** A `COPY`/`ADD` source: the one indexed repo file it names, or nothing. */
function resolveConfig(file: FileRecord, ref: ReferenceRecord, ctx: ReferenceContext): ReferenceEdge | null {
  const target = ctx.resolver.resolve(file.path, ref.to, "dockerfile");
  return target.type === "file" ? edge(file, ref, target.path, "high") : null;
}

/**
 * One Dockerfile reference, resolved to the node it names, or null when it names no single one.
 */
export function resolveDockerfileReferences(
  file: FileRecord,
  ref: ReferenceRecord,
  ctx: ReferenceContext,
): ReferenceEdge | null {
  switch (ref.refKind) {
    case "from-image":
      return resolveFromImage(file, ref, ctx);
    case "copy-from":
      return resolveCopyFrom(file, ref, ctx);
    case "config":
      return resolveConfig(file, ref, ctx);
    default:
      return null;
  }
}
