/**
 * `greplost init` (tech spec 7.2, 9; sync spec "Init").
 *
 * One command has to leave a repository in the state every other command
 * assumes: a config to build with, a gitignore so the machine-local files
 * never reach a diff, a complete map on disk, and the git hooks that keep it
 * that way. Running it twice must be safe, because it is the command people
 * re-run when they are not sure what state they are in.
 *
 * So nothing here overwrites. A config the user has already edited is theirs;
 * a gitignore they have added lines to keeps those lines and gains only what
 * is missing; the map is written by `update`, which compares bytes before it
 * writes; the hooks append and skip on their marker. `created` therefore says
 * what this call actually brought into existence, not what happens to exist.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ARTIFACT_DIR, ARTIFACT_PATHS, DEFAULT_CONFIG, stableStringify } from "@greplost/core/schema";

import { installGitHooks } from "./githooks.ts";
import { update } from "./incremental.ts";
import type { UpdateResult } from "./incremental.ts";
import { PARSE_CACHE_PATH } from "./parse-cache.ts";

export interface InitOptions {
  /** `false` skips hook installation; anything else installs them. */
  hooks?: boolean;
  /** Suppress the update's one-line summary. */
  quiet?: boolean;
}

export interface InitResult {
  /** Repo-relative paths this call created, in the order it created them. */
  created: string[];
  /** The full build it ran. */
  update: UpdateResult;
  /** Hooks newly installed; empty outside a git repository or when hooks were declined. */
  hooks: string[];
}

/**
 * Everything the runtime writes and nothing anyone should commit: the dirty
 * queue, the lock, the last-indexed commit, and the parse cache. The rest of
 * `.greplost/` — the map itself, `config.json`, the semantic summaries — is
 * meant to be in the repository; that is the whole point of it being there.
 */
const GITIGNORE_ENTRIES: readonly string[] = [
  // A glob, not the bare name: the queue is consumed by renaming it aside, and
  // a run killed at that instant leaves `.dirty.taken` behind. It is swept up
  // by the next update, but it must never show in anyone's `git status`.
  `${ARTIFACT_PATHS.dirty}*`,
  ARTIFACT_PATHS.lock,
  ARTIFACT_PATHS.state,
  PARSE_CACHE_PATH,
  // Sibling temporaries from an atomic replace. `update` sweeps the ones a
  // killed writer left behind, but a hook firing while a build is mid-rename
  // must not make them show up in someone's status either.
  "*.tmp",
];

export async function init(root: string, opts: InitOptions = {}): Promise<InitResult> {
  const absoluteRoot = path.resolve(root);
  const artifactDir = path.join(absoluteRoot, ARTIFACT_DIR);

  try {
    mkdirSync(artifactDir, { recursive: true });
  } catch (cause) {
    throw new Error(`greplost: cannot create ${ARTIFACT_DIR}/: ${reasonOf(cause)}`);
  }

  const created: string[] = [];
  if (createConfig(artifactDir)) created.push(`${ARTIFACT_DIR}/${ARTIFACT_PATHS.config}`);
  if (ensureGitignore(artifactDir)) created.push(`${ARTIFACT_DIR}/.gitignore`);

  // Full, not incremental: there is nothing to be incremental against, and a
  // first run must not depend on a state file that may be left over from an
  // older, differently configured build.
  const result = await update(absoluteRoot, {
    mode: "full",
    ...(opts.quiet === undefined ? {} : { quiet: opts.quiet }),
  });

  // After the build, so the first commit a user makes is the one that fires a
  // hook, rather than the hook racing the build that is still running.
  const hooks = opts.hooks === false ? [] : installGitHooks(absoluteRoot).installed;

  return { created, update: result, hooks };
}

/** Write `config.json` from the defaults unless the repo already has one. */
function createConfig(artifactDir: string): boolean {
  const file = path.join(artifactDir, ARTIFACT_PATHS.config);
  if (existsSync(file)) return false;
  write(file, `${stableStringify(DEFAULT_CONFIG, 2)}\n`);
  return true;
}

/**
 * Make sure `.greplost/.gitignore` covers the runtime files, adding only what
 * is missing. Returns true when the file did not exist.
 *
 * Appending rather than rewriting matters more than it looks: a repository
 * that has chosen to ignore its whole map (a huge monorepo that regenerates it
 * in CI) will have added lines here, and a "fix" that replaced the file would
 * silently start committing thousands of artifacts.
 */
function ensureGitignore(artifactDir: string): boolean {
  const file = path.join(artifactDir, ".gitignore");

  let existing: string | undefined;
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    existing = undefined;
  }

  if (existing === undefined) {
    write(file, `${GITIGNORE_ENTRIES.join("\n")}\n`);
    return true;
  }

  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length > 0) {
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    write(file, `${existing}${separator}${missing.join("\n")}\n`);
  }
  return false;
}

function write(file: string, contents: string): void {
  try {
    writeFileSync(file, contents);
  } catch (cause) {
    throw new Error(`greplost: cannot write ${ARTIFACT_DIR}/${path.basename(file)}: ${reasonOf(cause)}`);
  }
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
