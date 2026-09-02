/**
 * What the last update knew (tech spec 8.8, sync spec "state.ts").
 *
 * One fact, `.greplost/.state.json`, gitignored: the commit the map on disk was
 * built from. It is what lets an update ask git "what changed since then?"
 * instead of hashing the whole checkout, and it is why a `git pull` that moves
 * a hundred files still costs one `git diff`.
 *
 * State is a hint, never a source of truth. Every field is optional, an
 * unreadable file reads as `{}`, and the worst a wrong or missing value can do
 * is cost a rebuild that produces exactly the same bytes — so a corrupted
 * state file must never be an error. That asymmetry (cheap to lose, expensive
 * to trust) is the whole design.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ARTIFACT_DIR, ARTIFACT_PATHS, stableStringify } from "@greplost/core/schema";

export interface SyncState {
  /** Commit the artifacts on disk were built from, when the repo is a git repo. */
  lastIndexedCommit?: string;
}

/** Read `.greplost/.state.json`. `{}` when it is absent, empty or unreadable. */
export function readState(root: string): SyncState {
  let raw: string;
  try {
    raw = readFileSync(statePath(root), "utf8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

  const { lastIndexedCommit } = parsed as { lastIndexedCommit?: unknown };
  // A non-string commit would be handed straight to `git rev-parse`; the type
  // check is the boundary between a hint file and an argument list.
  if (typeof lastIndexedCommit !== "string" || lastIndexedCommit === "") return {};
  return { lastIndexedCommit };
}

/**
 * Write `.greplost/.state.json`.
 *
 * Stable JSON with a trailing newline, like everything else greplost writes,
 * even though this file is gitignored: the day someone commits it by accident,
 * it should not be the thing that churns.
 */
export function writeState(root: string, state: SyncState): void {
  const file = statePath(root);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${stableStringify(state, 2)}\n`);
  } catch (cause) {
    throw new Error(
      `greplost: cannot write ${ARTIFACT_DIR}/${ARTIFACT_PATHS.state}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

function statePath(root: string): string {
  return path.join(path.resolve(root), ARTIFACT_DIR, ARTIFACT_PATHS.state);
}
