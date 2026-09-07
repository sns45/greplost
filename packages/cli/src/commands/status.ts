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
 *               because it is not in the map or because its bytes have changed.
 *
 * Staleness is decided by content, not by `mtime`. The manifest already carries
 * the sha256 of every file it holds, so comparing hashes answers exactly the
 * question "does the map describe what is on disk", and it cannot be fooled by
 * a fresh `git clone` (which stamps every working file with the clone time) or
 * by a touch that changed no bytes.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { loadConfig, langOf, sha256Hex } from "@greplost/core";
import type { GreplostConfig, Manifest } from "@greplost/core/schema";
import { ARTIFACT_DIR } from "@greplost/core/schema";
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

/**
 * The verdict for `relative` (a repo-relative path, `""` when the argument was
 * not a path at all), given whether the map answered.
 *
 * `found` needs both halves: something in the map matched *and* the file on
 * disk still hashes to what the manifest recorded. A file that answers and has
 * since changed is `stale` and still answers, because half an answer plus a
 * warning beats no answer at all.
 */
export function statusOf(
  root: string,
  manifest: Manifest,
  relative: string,
  found: boolean,
  needle: string,
): StatusVerdict {
  const onDisk = relative !== "" && isInsideRoot(relative) && existsSync(path.join(root, relative));

  if (found) {
    const drifted = onDisk && isFile(root, relative) && hashDiffers(root, manifest, relative);
    if (!drifted) return { status: "found" };
    return {
      status: "stale",
      message: `${relative} has changed since the map was built; run \`greplost update\` for a current answer`,
    };
  }

  if (!onDisk) {
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

  const config = loadConfig(root);
  const pattern = excludingPattern(config, relative);
  if (pattern !== undefined) {
    return {
      status: "excluded",
      excludedBy: pattern,
      message:
        `${relative} is on disk but excluded from the map by "${pattern}"; ` +
        `edit "exclude" in ${CONFIG_PATH} to index it`,
    };
  }

  const lang = langOf(relative);
  if (lang === undefined || !config.languages.includes(lang)) {
    const add = lang === undefined ? "" : `; add "${lang}" to "languages" in ${CONFIG_PATH} to index it`;
    return {
      status: "excluded",
      message:
        `${relative} is on disk but outside the languages this map indexes ` +
        `(${config.languages.join(", ")}, set in "languages" in ${CONFIG_PATH})${add}`,
    };
  }

  return {
    status: "stale",
    message: `${relative} is on disk but not in the map; run \`greplost update\``,
  };
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

/** True when a repo-relative path stays inside the repo, so nothing above it is ever stat'd. */
function isInsideRoot(relative: string): boolean {
  return !path.isAbsolute(relative) && !relative.split("/").includes("..");
}

function isFile(root: string, relative: string): boolean {
  try {
    return statSync(path.join(root, relative)).isFile();
  } catch {
    return false;
  }
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
