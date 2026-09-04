/**
 * Snapshot -> artifact bytes. Pure: the caller (the sync package) decides where
 * the bytes go, so nothing here touches the filesystem.
 */

import type { Snapshot } from "../schema.ts";
import { ARTIFACT_PATHS, compareDeclarations, compareEdges } from "../schema.ts";
import { compareReferenceEdges } from "../references/link.ts";
import { toJson, toJsonl } from "./json.ts";

/**
 * The structure-layer artifacts, keyed by path relative to `.greplost/`, in
 * sorted key order. Collections are sorted here as well as at build time, so
 * the bytes do not depend on the order the snapshot was assembled in.
 *
 * `graph/references.jsonl` is the one artifact that is *omitted* rather than
 * written empty (schema 2, spec 2026-09-04 section 0.3): a repo with no
 * references must have exactly the artifact set it had under schema 1, so
 * adding the reference layer cannot show up as a diff in any existing map.
 */
export function serializeSnapshot(snapshot: Snapshot): Map<string, string> {
  const files = new Map<string, string>();
  files.set(ARTIFACT_PATHS.calls, toJsonl([...snapshot.calls].sort(compareEdges)));
  files.set(ARTIFACT_PATHS.imports, toJsonl([...snapshot.imports].sort(compareEdges)));
  files.set(ARTIFACT_PATHS.symbols, toJsonl([...snapshot.symbols].sort(compareDeclarations)));
  files.set(ARTIFACT_PATHS.manifest, toJson(snapshot.manifest));
  const references = snapshot.references ?? [];
  if (references.length > 0) {
    files.set(ARTIFACT_PATHS.references, toJsonl([...references].sort(compareReferenceEdges)));
  }
  return files;
}
