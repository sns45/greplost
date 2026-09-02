/**
 * The dirty file (tech spec 7.1, 8.1; sync spec "Dirty file").
 *
 * `.greplost/.dirty` is the channel from the Claude Code plugin's `PostToolUse`
 * hook to the next update: one repo-relative path per line, appended after
 * every Edit/Write/MultiEdit. It exists because that hook runs on the critical
 * path of a tool call, so it must be O(1) — an append and nothing else. No
 * read, no dedupe, no sort, no lock. All of that is the reader's job, which is
 * why `readAndClearDirty` returns a unique sorted set from a file that is
 * allowed to be full of duplicates.
 *
 * It also catches what git cannot see between commits, so the two dirty
 * sources are complementary rather than redundant: git knows about everything
 * a commit or a checkout moved, the dirty file knows about an edit made ten
 * seconds ago that is still only in the working tree of an untracked file.
 *
 * Nothing in here trusts its input. A hook can hand over an absolute path, a
 * Windows path, a path with a stray carriage return, a path in another
 * repository entirely, or a path inside `.greplost/` itself. Every one of
 * those is either normalised to a repo-relative posix path or dropped, because
 * the output of this module ends up deciding whether a repo is "clean" and
 * whose contents are reported to the user as a count.
 */

import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { ARTIFACT_DIR, ARTIFACT_PATHS, compareStrings } from "@greplost/core/schema";

/**
 * Record `paths` as dirty. Cheap by contract: one append, no read.
 *
 * Paths that cannot be expressed as a repo-relative path inside `root` are
 * dropped rather than recorded, so a caller may pass whatever it has.
 */
export function appendDirty(root: string, paths: string[]): void {
  const absoluteRoot = path.resolve(root);

  const lines: string[] = [];
  for (const candidate of paths) {
    const normalised = toRepoRelative(absoluteRoot, candidate);
    if (normalised !== undefined) lines.push(normalised);
  }
  if (lines.length === 0) return;

  const file = dirtyPath(absoluteRoot);
  try {
    // A repo that has never been indexed still has edits worth remembering:
    // the first `greplost update` should not start from a blank slate just
    // because `.greplost/` did not exist when the editor hook fired.
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${lines.join("\n")}\n`);
  } catch (cause) {
    throw new Error(
      `greplost: cannot append to ${ARTIFACT_DIR}/${ARTIFACT_PATHS.dirty}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

/**
 * Take everything the dirty file holds and clear it: unique, sorted,
 * repo-relative. `[]` when there is nothing (the common case).
 *
 * The queue is renamed aside before it is read, not read and then deleted. An
 * appender does not take the lock — that is the point of it being O(1) — so
 * between a read and an unlink there is a window in which an edit is recorded
 * and then thrown away without ever being indexed. After a rename, an appender
 * that has not yet opened the path creates a fresh file, and one that already
 * has an open descriptor writes into the file this call is about to consume.
 * Either way the edit survives.
 *
 * The hand-off file has a fixed name because only one consumer can exist at a
 * time (`update` reads the queue inside the lock), and it is swept up on the
 * way in: a run killed between the rename and the read leaves its entries
 * there, and they are still edits nothing has indexed.
 */
export function readAndClearDirty(root: string): string[] {
  const absoluteRoot = path.resolve(root);
  const file = dirtyPath(absoluteRoot);
  const taken = `${file}${TAKEN_SUFFIX}`;

  // Before the rename, which is about to clobber it.
  const abandoned = readIfPresent(taken);

  let queued = "";
  try {
    renameSync(file, taken);
    queued = readIfPresent(taken);
  } catch {
    // Nothing queued: the overwhelmingly common case, and one syscall.
  }
  try {
    rmSync(taken, { force: true });
  } catch {
    // Left behind at worst; the next call sweeps it up again.
  }

  const unique = new Set<string>();
  // Split on "\n" and strip a trailing "\r" rather than splitting on a
  // line-ending regex: a hook running under Git Bash or PowerShell on Windows
  // writes CRLF, and a path with a literal carriage return in the middle is
  // not something to silently repair.
  for (const line of `${abandoned}\n${queued}`.split("\n")) {
    const normalised = toRepoRelative(absoluteRoot, line.endsWith("\r") ? line.slice(0, -1) : line);
    if (normalised !== undefined) unique.add(normalised);
  }

  return [...unique].sort(compareStrings);
}

/**
 * Normalise one caller-supplied path to a repo-relative posix path inside
 * `root`, or `undefined` when it is not one.
 *
 * Dropped: blank lines, paths that resolve outside the repo (an absolute path
 * from another checkout, a `../` escape), and anything under `.greplost/`.
 * The artifact directory is excluded from discovery by definition, so a
 * generated artifact can never be a source file — and treating one as dirty
 * would mean every update that writes the map makes the map look stale.
 */
export function toRepoRelative(root: string, candidate: string): string | undefined {
  if (candidate.trim() === "") return undefined;

  const posix = candidate.split("\\").join("/");
  let relative: string;

  if (path.isAbsolute(candidate) || path.posix.isAbsolute(posix)) {
    relative = path.relative(root, path.resolve(candidate));
    if (escapes(relative)) {
      // macOS puts temp directories (and more) behind symlinks, so a caller
      // holding a fully resolved path can look outside a root that is not.
      relative = path.relative(realpath(root), realpath(path.resolve(candidate)));
      if (escapes(relative)) return undefined;
    }
    relative = relative.split("\\").join("/");
  } else {
    relative = path.posix.normalize(posix);
    if (relative === "." || relative === ".." || relative.startsWith("../")) return undefined;
  }

  // `path.posix.normalize` leaves a trailing slash on a directory-shaped path
  // ("src/" stays "src/"); git's porcelain output uses exactly that form for
  // an untracked directory.
  while (relative.endsWith("/")) relative = relative.slice(0, -1);
  if (relative === "" || relative === ".") return undefined;
  if (relative === ARTIFACT_DIR || relative.startsWith(`${ARTIFACT_DIR}/`)) return undefined;

  return relative;
}

/**
 * Is this `path.relative` result outside the root?
 *
 * `startsWith("..")` alone would reject a file honestly named `..config.ts`,
 * so the traversal has to be a whole segment.
 */
function escapes(relative: string): boolean {
  return (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    relative.startsWith("../") ||
    path.isAbsolute(relative)
  );
}

function readIfPresent(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Best-effort symlink resolution; the raw path when the target does not exist. */
function realpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/** Suffix of the hand-off file `readAndClearDirty` renames the queue to. */
const TAKEN_SUFFIX = ".taken";

function dirtyPath(root: string): string {
  return path.join(root, ARTIFACT_DIR, ARTIFACT_PATHS.dirty);
}
