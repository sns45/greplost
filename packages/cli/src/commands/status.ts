/**
 * Why an argument did not answer: `found`, `absent`, `excluded`, `stale`
 * (leaf 2.15, PLAN "Build 2.1").
 *
 * The evaluation lost four turns to one missing distinction. `greplost query
 * go/core/base_test.go` and `greplost query go/pgmq/clientt.go` returned the
 * same empty answer and the same advice ("run `greplost update`"), although the
 * first file is on disk and deliberately excluded, the second is a typo, and
 * only a third case, a file written after the map, is what an update fixes.
 * Telling an agent to run an update when an update cannot help is worse than
 * saying nothing: it spends a turn and returns to the same empty answer.
 *
 * So every miss is classified here, from the checkout rather than from the map:
 *
 *  - `found`    the map answers, and the bytes on disk are the bytes it read;
 *  - `absent`   nothing matches and there is no such path on disk (a typo);
 *  - `excluded` the path is on disk and `config.exclude` (or `config.languages`)
 *               drops it, named, so the reader knows which line to edit;
 *  - `stale`    the path is on disk and the map does not describe it, either
 *               because it is not in the map, because it has been deleted from
 *               disk since, or because its bytes have changed.
 *
 * **A path is classified as what it is.** A file is judged by its own name and
 * bytes, a directory by the files under it, and neither by the other's rules
 * (fix round 1, C1): a directory used to be handed to the file classifier,
 * which answered "outside the languages this map indexes" while listing the
 * language its files were written in.
 *
 * Staleness is decided by content, not by `mtime`. The manifest already carries
 * the sha256 of every file it holds, so comparing hashes answers exactly the
 * question "does the map describe what is on disk", and it cannot be fooled by
 * a fresh `git clone` (which stamps every working file with the clone time) or
 * by a touch that changed no bytes.
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { loadConfig, langOf, sha256Hex } from "@greplost/core";
import type { GreplostConfig, Manifest } from "@greplost/core/schema";
import { ARTIFACT_DIR, compareStrings } from "@greplost/core/schema";
import picomatch from "picomatch";

import { looksLikePath } from "./structure.ts";

/** Every answer `query` can give about why an argument did or did not resolve. */
export type QueryStatus = "found" | "absent" | "excluded" | "stale";

export interface StatusVerdict {
  status: QueryStatus;
  /** The `exclude` pattern that drops the path, when a pattern is what drops it. */
  excludedBy?: string;
  /** One line explaining a status that is not `found`; printed verbatim in text mode. */
  message?: string;
}

/** Where the config a status refers to lives, spelled the way a reader would open it. */
const CONFIG_PATH = `${ARTIFACT_DIR}/config.json`;

const FOUND: StatusVerdict = { status: "found" };

/** Directories a walk never descends: not this repository's source, and vast. */
const NEVER_WALKED: ReadonlySet<string> = new Set([ARTIFACT_DIR, ".git", "node_modules"]);

/**
 * The verdict for `relative` (a repo-relative path, `""` when the argument was
 * not a path at all), given whether the map answered.
 *
 * `found` needs both halves: something in the map matched *and* the file on
 * disk is still there and still hashes to what the manifest recorded. A file
 * that answers and has since changed, or has since been deleted, is `stale` and
 * still answers, because half an answer plus a warning beats no answer at all.
 */
export function statusOf(
  root: string,
  manifest: Manifest,
  relative: string,
  found: boolean,
  needle: string,
): StatusVerdict {
  const inside = relative !== "" && isInsideRoot(relative);
  const entry = inside ? entryOf(root, relative) : undefined;

  if (found) {
    if (manifest.files[relative] === undefined) return FOUND;
    if (entry === undefined) {
      return {
        status: "stale",
        message: `${relative} is in the map but no longer on disk; run \`greplost update\``,
      };
    }
    return entry.kind === "file" ? fileDrift(root, manifest, relative) : FOUND;
  }

  if (entry === undefined) {
    // A name that could not be a path was a search, and "check the path" is not
    // advice a search can act on; a path that is neither in the map nor on disk
    // is a typo, and saying so is the whole of what is left to say.
    return {
      status: "absent",
      message:
        relative !== "" && looksLikePath(relative)
          ? `${relative} is not in the map and not on disk; check the path`
          : `no match for "${needle}"`,
    };
  }

  // Discovery walks the tree without following symlinks, so a link is never
  // indexed however often the map is rebuilt: "run an update" would be a loop.
  if (entry.kind === "symlink") {
    return {
      status: "absent",
      message: `${relative} is a symlink, and greplost does not follow symlinks; query the file it points at`,
    };
  }

  const config = loadConfig(root);
  return entry.kind === "directory"
    ? directoryVerdict(root, config, relative)
    : fileVerdict(config, relative);
}

/**
 * The verdict for an answer that came from declarations rather than from a
 * path: the map answered, and the answer is only as current as the files it
 * was read from (fix round 1).
 *
 * One hash per distinct declaring file, in sorted order, and the first drift
 * decides, so two runs of the same query give the same verdict. A query that
 * matched forty declarations in one file pays for one hash.
 */
export function filesStatus(root: string, manifest: Manifest, files: readonly string[]): StatusVerdict {
  for (const file of [...new Set(files)].sort(compareStrings)) {
    if (manifest.files[file] === undefined) continue;
    if (!existsSync(path.join(root, file))) {
      return {
        status: "stale",
        message: `${file} is in the map but no longer on disk; run \`greplost update\``,
      };
    }
    const drift = fileDrift(root, manifest, file);
    if (drift.status !== "found") return drift;
  }
  return FOUND;
}

/** `stale` when the bytes on disk are not the bytes the manifest recorded. */
function fileDrift(root: string, manifest: Manifest, relative: string): StatusVerdict {
  return hashDiffers(root, manifest, relative)
    ? {
        status: "stale",
        message: `${relative} has changed since the map was built; run \`greplost update\` for a current answer`,
      }
    : FOUND;
}

/** The verdict for a file on disk that the map does not hold. */
function fileVerdict(config: GreplostConfig, relative: string): StatusVerdict {
  const pattern = excludingPattern(config, relative);
  if (pattern !== undefined) return excludedByPattern(relative, pattern);

  const lang = langOf(relative);
  if (lang === undefined || !config.languages.includes(lang)) return excludedByLanguage(config, relative);

  return {
    status: "stale",
    message: `${relative} is on disk but not in the map; run \`greplost update\``,
  };
}

/**
 * The verdict for a directory on disk that the map holds no file under
 * (fix round 1, C1).
 *
 * A directory has no language and no bytes of its own, so it is judged by what
 * is under it: nothing at all is a typo that happens to have been created;
 * everything the config keeps out is `excluded`, naming the first pattern that
 * did it; anything the map could have held and does not is `stale`, which is
 * the one case an update fixes.
 */
function directoryVerdict(root: string, config: GreplostConfig, relative: string): StatusVerdict {
  const files = filesOnDisk(path.join(root, relative), relative);
  if (files.length === 0) {
    return { status: "absent", message: `${relative} is a directory holding no files; nothing to map` };
  }

  let pattern: string | undefined;
  for (const file of files) {
    const excludedBy = excludingPattern(config, file);
    if (excludedBy !== undefined) {
      pattern ??= excludedBy;
      continue;
    }
    const lang = langOf(file);
    if (lang === undefined || !config.languages.includes(lang)) continue;
    // One file the map could hold and does not is enough: an update fixes it.
    return {
      status: "stale",
      message: `${relative} is on disk but the map holds no file under it; run \`greplost update\``,
    };
  }

  if (pattern === undefined) return excludedByLanguage(config, relative);
  const many = `${files.length} file${files.length === 1 ? "" : "s"}`;
  return {
    status: "excluded",
    excludedBy: pattern,
    message:
      `${relative} holds ${many} on disk and the config keeps every one of them out, ` +
      `the first by "${pattern}"; edit "exclude" in ${CONFIG_PATH} to index them`,
  };
}

function excludedByPattern(relative: string, pattern: string): StatusVerdict {
  return {
    status: "excluded",
    excludedBy: pattern,
    message:
      `${relative} is on disk but excluded from the map by "${pattern}"; ` +
      `edit "exclude" in ${CONFIG_PATH} to index it`,
  };
}

function excludedByLanguage(config: GreplostConfig, relative: string): StatusVerdict {
  const lang = langOf(relative);
  const add = lang === undefined ? "" : `; add "${lang}" to "languages" in ${CONFIG_PATH} to index it`;
  return {
    status: "excluded",
    message:
      `${relative} is on disk but outside the languages this map indexes ` +
      `(${config.languages.join(", ")}, set in "languages" in ${CONFIG_PATH})${add}`,
  };
}

/**
 * Repo-relative paths of the files under a directory, at any depth, sorted.
 *
 * Symlinks are never followed and never counted, exactly as discovery treats
 * them, and `.git`, `node_modules` and the map itself are never descended: a
 * question about `src/` is not a question about an installed dependency tree.
 */
function filesOnDisk(absolute: string, relative: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!NEVER_WALKED.has(entry.name)) walk(path.join(dir, entry.name), rel);
        continue;
      }
      if (entry.isFile()) out.push(rel);
    }
  };
  walk(absolute, relative);
  return out.sort(compareStrings);
}

/**
 * The first `config.exclude` pattern that matches, in the order the config
 * lists them, or undefined.
 *
 * First rather than every match, because a person acts on one line: the answer
 * to "why is this not indexed" is the line to edit, and the same picomatch
 * options discovery uses (`dot: true`), so this can never disagree with what
 * the build actually did.
 */
export function excludingPattern(config: GreplostConfig, relative: string): string | undefined {
  for (const pattern of config.exclude) {
    if (picomatch(pattern, { dot: true })(relative)) return pattern;
  }
  return undefined;
}

/** What a repo-relative path is on disk, or undefined when it is not there at all. */
function entryOf(root: string, relative: string): { kind: "file" | "directory" | "symlink" } | undefined {
  try {
    // `lstat`, not `stat`: a symlink is its own answer here, and following one
    // would report the target's kind for a path the map can never hold.
    const stats = lstatSync(path.join(root, relative));
    if (stats.isSymbolicLink()) return { kind: "symlink" };
    if (stats.isDirectory()) return { kind: "directory" };
    return { kind: "file" };
  } catch {
    return undefined;
  }
}

/** True when a repo-relative path stays inside the repo, so nothing above it is ever stat'd. */
function isInsideRoot(relative: string): boolean {
  return !path.isAbsolute(relative) && !relative.split("/").includes("..");
}

/**
 * True when the bytes on disk hash to something other than what the manifest
 * recorded for this file. A file the manifest does not hold is not drift here:
 * that case is answered by `statusOf`'s "not in the map" branch.
 */
function hashDiffers(root: string, manifest: Manifest, relative: string): boolean {
  const entry = manifest.files[relative];
  if (entry === undefined) return false;
  try {
    return sha256Hex(readFileSync(path.join(root, relative))) !== entry.sha256;
  } catch {
    return false;
  }
}
