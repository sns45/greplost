/**
 * Artifact bytes -> structure. The only filesystem access in this leaf: the CLI
 * reads a committed `.greplost/` without parsing a line of source.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CallEdge, Declaration, ImportEdge, Manifest } from "../schema.ts";
import { ARTIFACT_PATHS } from "../schema.ts";
import { parseJsonl } from "./json.ts";

export interface Structure {
  manifest: Manifest;
  imports: ImportEdge[];
  calls: CallEdge[];
  symbols: Declaration[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shape check only: enough to fail loudly on a file that is not our manifest. */
function isManifest(value: unknown): value is Manifest {
  return (
    isRecord(value) &&
    typeof value["version"] === "string" &&
    isRecord(value["packages"]) &&
    isRecord(value["files"])
  );
}

/**
 * Read the four structure artifacts from an artifact directory (usually
 * `<repo>/.greplost`). Null when there is no manifest: that is "never built",
 * not an error. A missing or empty graph file reads as an empty collection.
 */
export function readStructure(artifactDir: string): Structure | null {
  const manifestPath = path.join(artifactDir, ARTIFACT_PATHS.manifest);
  if (!existsSync(manifestPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`greplost: cannot read ${ARTIFACT_PATHS.manifest}: ${reason}`);
  }
  if (!isManifest(parsed)) {
    throw new Error(`greplost: ${ARTIFACT_PATHS.manifest} is not a greplost manifest`);
  }
  const manifest: Manifest = parsed;

  const read = (relative: string): string => {
    const file = path.join(artifactDir, relative);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };

  return {
    manifest,
    imports: parseJsonl<ImportEdge>(read(ARTIFACT_PATHS.imports)),
    calls: parseJsonl<CallEdge>(read(ARTIFACT_PATHS.calls)),
    symbols: parseJsonl<Declaration>(read(ARTIFACT_PATHS.symbols)),
  };
}
