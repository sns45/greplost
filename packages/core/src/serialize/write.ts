/**
 * Snapshot -> artifact bytes. Pure: the caller (the sync package) decides where
 * the bytes go, so nothing here touches the filesystem.
 */

import type { Snapshot } from "../schema.ts";
import { ARTIFACT_PATHS, compareDeclarations, compareEdges } from "../schema.ts";
import { toJson, toJsonl } from "./json.ts";

/**
 * The structure-layer artifacts, keyed by path relative to `.greplost/`, in
 * sorted key order. Collections are sorted here as well as at build time, so
 * the bytes do not depend on the order the snapshot was assembled in.
 */
export function serializeSnapshot(snapshot: Snapshot): Map<string, string> {
  const files = new Map<string, string>();
  files.set(ARTIFACT_PATHS.calls, toJsonl([...snapshot.calls].sort(compareEdges)));
  files.set(ARTIFACT_PATHS.imports, toJsonl([...snapshot.imports].sort(compareEdges)));
  files.set(ARTIFACT_PATHS.symbols, toJsonl([...snapshot.symbols].sort(compareDeclarations)));
  files.set(ARTIFACT_PATHS.manifest, toJson(snapshot.manifest));
  return files;
}
