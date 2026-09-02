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
 * Bounded ownership: `writeArtifacts` touches structure paths
 * (`isStructurePath`) and nothing else. Files the map no longer produces — the
 * card of a deleted source file, the docs of a removed package — are pruned,
 * and the directories that emptied are removed; `config.json`, the caches,
 * `FLOWS.md`, `WORKSPACE.md` and the runtime files are invisible to it. Where
 * something greplost does not own blocks its way, it refuses rather than
 * deletes.
 *
 * The containment is exported, because the artifacts are not the only bytes
 * that land under `.greplost/`: the parse cache, the state file and the
 * semantic summary cache are written by other modules, at paths a committed
 * symlink can hijack just as easily. `containedPath` and `safeWrite` are that
 * same walk and that same replace-by-rename, available to them, so there is one
 * answer to the threat rather than one per writer.
 *
 * What it is not: transactional. Artifacts are written one at a time in path
 * order and pruning happens after, so a refusal or a filesystem error part way
 * through leaves the earlier artifacts written, the later ones untouched and
 * nothing pruned. That is a deliberate trade — a staging directory plus an
 * atomic swap would rewrite every inode on every run and destroy the minimal-
 * churn property, which is the whole point of the byte comparison. The
 * incomplete state is not silent: `verify` reports the artifacts that never got
 * written as `missing` and any stale ones as `changed`, and the next successful
 * `update` finishes the job, because a partial write is just a map that is
 * further behind than usual.
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
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

  // Directory prefixes already walked and verified during this call. A repo
  // with a few thousand cards has a few dozen directories; without this every
  // card re-lstats every segment of its own path.
  const ensured = new Set<string>();

  for (const rel of [...files.keys()].sort(compareStrings)) {
    const contents = files.get(rel) as string;
    const target = path.join(artifactRoot, rel);
    ensureDirectory(artifactRoot, rel, ensured);
    if (writeIfDifferent(artifactRoot, rel, target, contents)) written.push(rel);
    else unchanged++;
  }

  const deleted = prune(artifactRoot, files);

  return { written, deleted, unchanged };
}

/**
 * The containment this module enforces for artifacts, for the files under
 * `.greplost/` that are *not* artifacts: the parse cache, the state file and
 * the semantic summary cache.
 *
 * Those three are written by other modules (`parse-cache.ts`, `state.ts`,
 * `@greplost/semantic`), and each used to reach the disk through a plain
 * `mkdirSync(dir, { recursive: true })` and a write — which resolves every
 * component, so a committed `.greplost/cache -> /anywhere` was followed rather
 * than replaced, and an unattended `post-checkout` `update` wrote outside the
 * repository. `.greplost/` is committed and git stores symlinks, so that link
 * arrives on every checkout; this is the same threat `writeArtifacts` was built
 * against, and there is no reason for two answers to it.
 *
 * `rel` is artifact-relative and need not be a structure path — these files are
 * precisely the ones that are not. What it may not be is absolute, empty, or
 * anything that walks upwards.
 */
export function containedPath(root: string, rel: string): string {
  return openContained(root, rel).target;
}

/**
 * Write `contents` at `<root>/.greplost/<rel>`, inside the artifact directory
 * whatever the filesystem has been told to say.
 *
 * Same replace-by-rename as an artifact: a sibling temporary and a `rename`, so
 * a reader never sees half a file, a hard-linked inode is not rewritten under
 * its other name, and a failed write leaves what was there untouched. A symlink
 * *at* `rel` is replaced by the rename (which swaps the directory entry and
 * never follows it), and a symlink on the way to it was already replaced by a
 * real directory.
 */
export function safeWrite(root: string, rel: string, contents: string): void {
  const { artifactRoot, target } = openContained(root, rel);
  replaceFile(artifactRoot, rel, target, Buffer.from(contents, "utf8"));
}

function openContained(root: string, rel: string): { artifactRoot: string; target: string } {
  const normalized = artifactRelative(rel);
  const artifactRoot = openArtifactRoot(root);
  ensureDirectory(artifactRoot, normalized, new Set());
  const target = path.join(artifactRoot, normalized);
  assertInside(artifactRoot, path.dirname(target));
  return { artifactRoot, target };
}

/**
 * `rel` as a clean artifact-relative path, or a refusal. Lexical, because it is
 * a check on the *caller* — a path with a `..` in it is a defect in the code
 * that produced it, and the filesystem checks that follow are what defend
 * against the repository.
 */
function artifactRelative(rel: string): string {
  const normalized = rel.split("\\").join("/").replace(/^\.\//, "");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    path.isAbsolute(rel) ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`greplost: refusing to write outside ${ARTIFACT_DIR}: ${rel}`);
  }
  return normalized;
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
 *
 * `ensured` carries the prefixes already walked in this call, so a package with
 * four hundred cards pays for its directory chain once rather than four hundred
 * times.
 */
function ensureDirectory(artifactRoot: string, rel: string, ensured: Set<string>): void {
  const segments = rel.split("/");
  segments.pop();
  if (segments.length === 0) return;

  let current = artifactRoot;
  let prefix = "";
  for (const segment of segments) {
    current = path.join(current, segment);
    prefix = prefix === "" ? segment : `${prefix}/${segment}`;
    if (ensured.has(prefix)) continue;

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
    ensured.add(prefix);
  }
}

/**
 * Prove `dir` is still inside the artifact root after the filesystem has had
 * its say. `path.resolve` is lexical and a symlink is not, so this is the only
 * containment check that actually holds.
 *
 * When it runs: immediately before each `writeSeam.writeFile` (both the first
 * attempt and the retry), immediately before each `discard` of something
 * occupying an artifact path, and immediately before each `rmSync` in `prune` —
 * never once per loop iteration with work in between. The window between the
 * check and the syscall is as small as this code can make it.
 *
 * What it does not do is close that window. Node exposes no `openat`/`unlinkat`
 * with `O_NOFOLLOW` relative to a directory handle, so there is no way to write
 * or unlink through a path that has been *proved* rather than re-resolved. A
 * process that already has write access to `.greplost/` can therefore still win
 * the race by swapping a directory for a symlink between the `realpathSync` and
 * the write. That is a smaller threat than the one this closes — a symlink
 * committed to the repository, which lands on every checkout and is walked by
 * an unattended hook — and it needs an attacker who can already write where the
 * artifacts live.
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
 *
 * Nothing is ever written *into* an existing file. A regular file at an artifact
 * path can be a hard link — one inode carrying a second name outside
 * `.greplost/`, which `lstat` cannot tell from an ordinary file — and an
 * in-place write would silently rewrite the file at that other name. So a
 * differing artifact is replaced through a sibling temporary file and a
 * `rename`, which swaps the directory entry: greplost's name points at the new
 * inode, the other name keeps the original bytes.
 *
 * `rename` rather than unlink-then-write, because the two hazards pull in
 * opposite directions. Unlinking first would break the hard link, but it also
 * destroys a good committed artifact when the write that follows fails for a
 * reason the path cannot explain (`ENOSPC`, `EROFS`) — the failure mode this
 * module was already fixed for once. A rename fails or succeeds as a unit: the
 * old artifact survives a failed write untouched, and a reader never sees a
 * half-written one. The unchanged fast path returns before any of this, so a
 * no-op run still touches nothing at all.
 */
function writeIfDifferent(artifactRoot: string, rel: string, target: string, contents: string): boolean {
  const expected = Buffer.from(contents, "utf8");
  const existing = lstatSafe(target);

  if (existing !== undefined) {
    if (existing.isFile()) {
      try {
        if (readFileSync(target).equals(expected)) return false;
      } catch {
        // Unreadable: it cannot be compared, so it is replaced.
      }
    } else if (existing.isDirectory()) {
      // `rename` cannot replace a directory, and this is the ownership gate.
      assertOwnedTree(rel, target);
      guardedDiscard(artifactRoot, target);
    }
    // A symlink, or something stranger, is replaced by the rename below, which
    // swaps the link itself and never follows it.
  }

  replaceFile(artifactRoot, rel, target, expected);
  return true;
}

/** Serial number for temporary files, so one run cannot collide with itself. */
let tempCounter = 0;

/**
 * Put `expected` at `target` by writing a sibling temporary file and renaming
 * it over the top.
 *
 * The temporary lives in the target's own directory so the rename stays within
 * one filesystem, and its name is not a structure path, so a crash between the
 * write and the rename leaves something `verify` and `prune` both ignore rather
 * than something either would act on.
 */
function replaceFile(artifactRoot: string, rel: string, target: string, expected: Buffer): void {
  const dir = path.dirname(target);
  assertInside(artifactRoot, dir);
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${tempCounter++}.tmp`);

  try {
    writeSeam.writeFile(temp, expected);
  } catch (cause) {
    discard(temp);
    throw new Error(`greplost: cannot write ${ARTIFACT_DIR}/${rel}: ${reasonOf(cause)}`);
  }

  try {
    assertInside(artifactRoot, dir);
    renameSync(temp, target);
  } catch (cause) {
    if (!REPAIRABLE_WRITE_ERRORS.has(errorCode(cause))) {
      discard(temp);
      throw new Error(`greplost: cannot write ${ARTIFACT_DIR}/${rel}: ${reasonOf(cause)}`);
    }
    // Something greplost owns is in the way (a directory that appeared under
    // us, a sticky-bit refusal). Clear it and try once more.
    guardedDiscard(artifactRoot, target);
    try {
      assertInside(artifactRoot, dir);
      renameSync(temp, target);
    } catch (second) {
      discard(temp);
      throw new Error(`greplost: cannot write ${ARTIFACT_DIR}/${rel}: ${reasonOf(second)}`);
    }
  }
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

/** `discard`, with the containment check made immediately before the removal. */
function guardedDiscard(artifactRoot: string, target: string): void {
  assertInside(artifactRoot, path.dirname(target));
  discard(target);
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

    // A directory squatting on a structure path is as stale as a file, but only
    // once everything it holds is an artifact too. That walk happens before the
    // containment check so the check is the last thing before the removal.
    if (lstatSafe(target)?.isDirectory() === true) assertOwnedTree(rel, target);

    assertInside(artifactRoot, path.dirname(target));
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
