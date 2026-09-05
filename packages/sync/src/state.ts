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
 * is cost a rebuild that produces exactly the same bytes, so a corrupted
 * state file must never be an error. That asymmetry (cheap to lose, expensive
 * to trust) is the whole design.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { ARTIFACT_DIR, ARTIFACT_PATHS, stableStringify } from "@greplost/core/schema";

import { safeWrite } from "./write.ts";

export interface SyncState {
  /** Commit the artifacts on disk were built from, when the repo is a git repo. */
  lastIndexedCommit?: string;
  /**
   * Was the working tree clean when that build ran?
   *
   * Without this, `lastIndexedCommit` alone is a lie by omission. A map built
   * from a dirty tree describes bytes that are not in any commit, so when the
   * tree is reverted (`git checkout -- .`, a dropped stash, a discarded change
   * in an editor) HEAD is unchanged and `git status` is empty again, and a
   * fast path that trusted the commit alone would call that map current when
   * it describes code that no longer exists. Absent (an older state file, or a
   * build outside git) reads as `false`: one extra rebuild, never a stale map.
   */
  treeClean?: boolean;
  /**
   * Hash of the resolved config that build ran under.
   *
   * The config decides which files are indexed, which languages are read and
   * how the diagrams are split, so editing it changes the map without changing
   * a byte of source. Nothing else in this file would notice: HEAD does not
   * move and the tree stays clean. Absent reads as "unknown", which never
   * matches and so always rebuilds.
   */
  configHash?: string;
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

  const { lastIndexedCommit, treeClean, configHash } = parsed as {
    lastIndexedCommit?: unknown;
    treeClean?: unknown;
    configHash?: unknown;
  };
  // A non-string commit would be handed straight to `git rev-parse`; the type
  // check is the boundary between a hint file and an argument list.
  if (typeof lastIndexedCommit !== "string" || lastIndexedCommit === "") return {};
  // Anything but an explicit `true`, missing, null, a string, a state file
  // written before this field existed, is not a claim that the tree was clean.
  return {
    lastIndexedCommit,
    treeClean: treeClean === true,
    ...(typeof configHash === "string" && configHash !== "" ? { configHash } : {}),
  };
}

/**
 * Write `.greplost/.state.json`.
 *
 * Stable JSON with a trailing newline, like everything else greplost writes,
 * even though this file is gitignored: the day someone commits it by accident,
 * it should not be the thing that churns.
 *
 * Through `safeWrite`, not `writeFileSync`, for the reason `write.ts` gives:
 * this file is gitignored but its *path* is not, and a repository carrying a
 * committed `.greplost/.state.json -> somewhere` would otherwise have every
 * unattended `update` write through the link.
 */
export function writeState(root: string, state: SyncState): void {
  try {
    safeWrite(root, ARTIFACT_PATHS.state, `${stableStringify(state, 2)}\n`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.startsWith("greplost: ")) throw cause;
    throw new Error(`greplost: cannot write ${ARTIFACT_DIR}/${ARTIFACT_PATHS.state}: ${message}`);
  }
}

function statePath(root: string): string {
  return path.join(path.resolve(root), ARTIFACT_DIR, ARTIFACT_PATHS.state);
}
