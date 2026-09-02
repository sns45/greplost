/**
 * Materialising a built map onto disk (sync spec "Write", tech spec 4.2).
 *
 * Three properties matter more than speed here.
 *
 * Minimal churn: a file is written only when its bytes actually differ, so an
 * update that changes one card leaves the other few thousand artifacts with
 * their original mtimes. Editors, watchers and `git status` all stay quiet, and
 * "greplost ran" stops being visible in the working tree.
 *
 * Containment: every byte written and every path deleted is inside
 * `<root>/.greplost/`, and "inside" is decided by `realpath`, not by string
 * arithmetic. `.greplost/` is committed and git stores symlinks, so a
 * repository can carry a link that points anywhere; `update` then runs
 * unattended from a `post-checkout` hook. So the directory walk never follows a
 * symlink — it unlinks one and puts a real directory in its place — and the
 * containment check is re-made against the resolved path immediately before
 * each write and each delete.
 *
 * Bounded ownership: the writer touches structure paths (`isStructurePath`) and
 * nothing else. Files the map no longer produces — the card of a deleted source
 * file, the docs of a removed package — are pruned, and the directories that
 * emptied are removed; `config.json`, the caches, `FLOWS.md`, `WORKSPACE.md`
 * and the runtime files are invisible to it. Where something greplost does not
 * own blocks its way, it refuses rather than deletes.
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";

import { ARTIFACT_DIR, compareStrings } from "@greplost/core/schema";

import { isStructurePath, listStructurePaths } from "./artifacts.ts";

export interface WriteResult {
  /** Structure paths whose bytes changed (or that did not exist), sorted. */
  written: string[];
  /** Structure paths removed because the map no longer produces them, sorted. */
  deleted: string[];
  /** Structure paths already byte-identical on disk, left with their mtimes. */
  unchanged: number;
}

/**
 * The one filesystem write this module performs, behind an indirection so a
 * test can make it fail with a chosen errno (there is no portable way to
 * provoke `ENOSPC` on a real path). Test-only: `index.ts` does not re-export
 * it, so it is not part of the package's public surface.
 */
export const writeSeam = {
  writeFile(target: string, bytes: Buffer): void {
    writeFileSync(target, bytes);
  },
};

/**
 * Write failures worth clearing the path and retrying once: something is at the
 * path, or on the way to it, that greplost owns and can replace. Everything
 * else — a full disk, a read-only filesystem, a quota — says nothing about the
 * path, and destroying a good committed artifact before failing anyway would be
 * the worst possible response.
 */
const REPAIRABLE_WRITE_ERRORS: ReadonlySet<string> = new Set(["EACCES", "EPERM", "EISDIR", "ENOTDIR"]);

/**
 * Write `files` (artifact-relative path -> contents) under `<root>/.greplost/`,
 * pruning structure paths the map does not contain.
 *
 * Throws before touching the disk if any key is not a structure path: a bad key
 * is a defect in the producer, and acting on it is how a writer escapes the
 * artifact directory.
 */
export function writeArtifacts(root: string, files: Map<string, string>): WriteResult {
  for (const rel of files.keys()) {
    if (!isStructurePath(rel)) {
      throw new Error(`greplost: refusing to write ${rel}: not a structure-layer artifact path`);
    }
  }

  const artifactRoot = openArtifactRoot(root);

  const written: string[] = [];
  let unchanged = 0;

  for (const rel of [...files.keys()].sort(compareStrings)) {
    const contents = files.get(rel) as string;
    const target = path.join(artifactRoot, rel);
    ensureDirectory(artifactRoot, rel);
    assertInside(artifactRoot, path.dirname(target));
    if (writeIfDifferent(rel, target, contents)) written.push(rel);
    else unchanged++;
  }

  const deleted = prune(artifactRoot, files);

  return { written, deleted, unchanged };
}

/**
 * Make `<root>/.greplost` exist as a directory and return its resolved path,
 * which is the containment boundary for everything below.
 *
 * The artifact root itself may legitimately be a symlink to a real directory —
 * `.greplost` parked on another volume is a reasonable thing for a user to do,
 * and every artifact then lives under the link's target, which is where the
 * boundary belongs. A *dangling* link is a link and nothing else, so it is
 * replaced; a regular file there is content greplost never wrote, so it is not.
 */
function openArtifactRoot(root: string): string {
  const artifactRoot = path.resolve(root, ARTIFACT_DIR);
  const link = lstatSafe(artifactRoot);

  if (link !== undefined) {
    const resolved = statSafe(artifactRoot);
    if (resolved === undefined || !resolved.isDirectory()) {
      if (!link.isSymbolicLink()) {
        throw new Error(`greplost: refusing to delete ${ARTIFACT_DIR}: not a greplost artifact`);
      }
      discard(artifactRoot);
    }
  }

  mkdirSync(artifactRoot, { recursive: true });
  return realpathSync(artifactRoot);
}

/**
 * Make every directory on the way to `rel` exist, walking one segment at a time
 * and never through a symlink.
 *
 * `mkdirSync(dir, { recursive: true })` cannot be used as a fast path here, not
 * even a hopeful one: it resolves each component, so a committed
 * `.greplost/packages -> /somewhere/else` would silently succeed and every
 * write below it would land outside the artifact directory. A link found on the
 * way is unlinked (which loses only the link) and replaced by a real directory;
 * a regular file there is someone else's content and stops the write instead.
 */
function ensureDirectory(artifactRoot: string, rel: string): void {
  const segments = rel.split("/");
  segments.pop();

  let current = artifactRoot;
  let prefix = "";
  for (const segment of segments) {
    current = path.join(current, segment);
    prefix = prefix === "" ? segment : `${prefix}/${segment}`;

    const entry = lstatSafe(current);
    if (entry !== undefined && !entry.isDirectory()) {
      if (!entry.isSymbolicLink()) {
        throw new Error(`greplost: refusing to delete ${ARTIFACT_DIR}/${prefix}: not a greplost artifact`);
      }
      discard(current);
    }
    // Ancestors are verified real directories by this point, so `recursive`
    // here is idempotence, not path resolution.
    mkdirSync(current, { recursive: true });
  }
}

/**
 * Prove `dir` is still inside the artifact root after the filesystem has had
 * its say. `path.resolve` is lexical and a symlink is not, so this is the only
 * check that actually holds; it runs immediately before every write and every
 * delete.
 */
function assertInside(artifactRoot: string, dir: string): void {
  let resolved: string;
  try {
    resolved = realpathSync(dir);
  } catch {
    throw new Error(`greplost: refusing to write outside ${ARTIFACT_DIR}: ${dir}`);
  }
  if (resolved !== artifactRoot && !resolved.startsWith(artifactRoot + path.sep)) {
    throw new Error(`greplost: refusing to write outside ${ARTIFACT_DIR}: ${dir}`);
  }
}

/**
 * Write `contents` to `target` unless the file already holds exactly those
 * bytes. Returns true when the file was written.
 *
 * `target` is a structure path, so whatever occupies it is greplost's to
 * replace: a stale file, an unreadable one, a symlink (writing through which
 * would put generated bytes outside `.greplost/`). A *directory* there is
 * replaced only once its contents are known to be artifacts too — see
 * `assertOwnedTree`. The byte comparison is only ever an optimisation.
 */
function writeIfDifferent(rel: string, target: string, contents: string): boolean {
  const expected = Buffer.from(contents, "utf8");
  const existing = lstatSafe(target);

  if (existing !== undefined) {
    if (existing.isFile()) {
      try {
        if (readFileSync(target).equals(expected)) return false;
      } catch {
        // Unreadable: it cannot be compared, so it is replaced.
        discard(target);
      }
    } else if (existing.isDirectory()) {
      assertOwnedTree(rel, target);
      discard(target);
    } else {
      // A symlink, or something stranger: no content of ours to lose.
      discard(target);
    }
  }

  try {
    writeSeam.writeFile(target, expected);
  } catch (cause) {
    if (!REPAIRABLE_WRITE_ERRORS.has(errorCode(cause))) {
      throw new Error(`greplost: cannot write ${ARTIFACT_DIR}/${rel}: ${reasonOf(cause)}`);
    }
    // Something greplost owns is in the way (a read-only artifact, a directory
    // that appeared under us). Clear it and try once more.
    discard(target);
    try {
      writeSeam.writeFile(target, expected);
    } catch (second) {
      throw new Error(`greplost: cannot write ${ARTIFACT_DIR}/${rel}: ${reasonOf(second)}`);
    }
  }
  return true;
}

/**
 * A directory sitting where an artifact belongs is removed only when everything
 * under it is an artifact too. `.greplost/INDEX.md/` holding a user's notes is
 * damage greplost reports; the same path holding nothing, or holding only files
 * that are themselves structure paths, is damage it repairs.
 */
function assertOwnedTree(rel: string, target: string): void {
  const foreign = firstForeignFile(target, rel);
  if (foreign !== undefined) {
    throw new Error(`greplost: refusing to delete ${ARTIFACT_DIR}/${rel}: contains files greplost does not own`);
  }
}

/** The first file under `dir` whose artifact-relative path is not a structure path. */
function firstForeignFile(dir: string, prefix: string): string | undefined {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A directory greplost cannot look inside is one it must not delete.
    return prefix;
  }
  for (const entry of entries) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = firstForeignFile(path.join(dir, entry.name), rel);
      if (nested !== undefined) return nested;
      continue;
    }
    if (!isStructurePath(rel)) return rel;
  }
  return undefined;
}

/**
 * Remove whatever is at `target`. `rmSync` does not follow symlinks, so a link
 * here loses the link and never its target. Failure is left to the operation
 * this was clearing the way for, which can name the artifact the user cares
 * about.
 */
function discard(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // Reported by the operation this was clearing the way for.
  }
}

/**
 * Delete every structure path present under the artifact root and absent from
 * `files`, then remove the directories that emptied as a result.
 *
 * Only directories on the path of something actually deleted are considered, so
 * an empty `cache/` a user left behind is not "tidied away": the writer's remit
 * is the structure layer, not the artifact directory as a whole.
 */
function prune(artifactRoot: string, files: Map<string, string>): string[] {
  const deleted: string[] = [];
  const emptied = new Set<string>();

  for (const rel of listStructurePaths(artifactRoot)) {
    if (files.has(rel)) continue;
    const target = path.join(artifactRoot, rel);
    assertInside(artifactRoot, path.dirname(target));

    // A directory squatting on a structure path is as stale as a file, but only
    // once everything it holds is an artifact too.
    if (lstatSafe(target)?.isDirectory() === true) assertOwnedTree(rel, target);

    try {
      rmSync(target, { recursive: true, force: true });
    } catch (cause) {
      // Swallowing this would leave `verify` reporting the path as extra
      // forever with nothing to explain why.
      throw new Error(`greplost: cannot delete ${ARTIFACT_DIR}/${rel}: ${reasonOf(cause)}`);
    }
    deleted.push(rel);
    const slash = rel.lastIndexOf("/");
    if (slash !== -1) emptied.add(rel.slice(0, slash));
  }

  // Deepest first, so `packages/x/modules/src` is gone before `packages/x/modules`
  // is tested for emptiness.
  const candidates = [...expandAncestors(emptied)].sort((a, b) => b.length - a.length || compareStrings(a, b));
  for (const rel of candidates) {
    const dir = path.join(artifactRoot, rel);
    try {
      // lstat, not stat: a symlink to a directory is a link, and removing it
      // because whatever it points at happens to be empty would be wrong.
      if (!lstatSync(dir).isDirectory()) continue;
      if (readdirSync(dir).length > 0) continue;
      rmdirSync(dir);
    } catch {
      // Already gone, or not ours to remove.
    }
  }

  return deleted.sort(compareStrings);
}

/** Every directory on the path of a pruned artifact, itself included. */
function expandAncestors(dirs: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const dir of dirs) {
    const segments = dir.split("/");
    for (let i = segments.length; i > 0; i--) out.add(segments.slice(0, i).join("/"));
  }
  return out;
}

function lstatSafe(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch {
    return undefined;
  }
}

function statSafe(target: string): Stats | undefined {
  try {
    return statSync(target);
  } catch {
    return undefined;
  }
}

function errorCode(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
