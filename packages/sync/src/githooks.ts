/**
 * Git hooks: the half of sync that covers edits Claude never sees
 * (tech spec 7.2, sync spec "Git hooks").
 *
 * The plugin's `Stop` hook keeps the map fresh for work done inside a Claude
 * session. Everything else — a rebase, a `git pull`, a branch switch, a commit
 * typed in another terminal, a teammate's merge — arrives through git, so
 * `post-commit`, `post-merge` and `post-checkout` are where the other half of
 * freshness lives.
 *
 * This module writes into files it does not own, which fixes its rules:
 *
 *  - Append, never overwrite. A repository's hooks belong to the repository;
 *    greplost adds a block at the end and leaves everything above it alone.
 *  - Idempotent by marker, not by content. `HOOK_MARKER` is what a second
 *    install looks for, so a user who edits the block still does not get a
 *    duplicate.
 *  - Detached and silent. The hook backgrounds the update and discards its
 *    output: a commit must not wait for a rebuild, and a repository without
 *    greplost installed must not print an error on every commit.
 *  - Nothing outside a git repository. `mode: "none"` touches no files at all.
 *
 * The installed block resolves the binary at run time rather than baking in a
 * path, because a hook outlives the install: `node_modules` gets wiped, the
 * package gets installed globally instead, the repo gets cloned onto a machine
 * that has neither. In all of those the hook has to be a no-op, not an error.
 */

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/** The line that makes a re-install a no-op. Never change it: old hooks carry it. */
export const HOOK_MARKER = "# greplost-hook";

/** Closing marker, so a human (or a future uninstaller) can see where the block ends. */
export const HOOK_END_MARKER = "# end greplost-hook";

/** The git events that can change the working tree behind greplost's back. */
export const HOOK_NAMES: readonly string[] = ["pre-commit", "post-commit", "post-merge", "post-checkout"];

/** Mode 755: git only runs a hook that is executable. */
const HOOK_MODE = 0o755;

const SHEBANG = "#!/bin/sh\n";

/**
 * The block appended to each hook (sync spec "Git hooks", verbatim).
 *
 * `command -v` rather than a hard-coded path, `bunx` as the fallback, and an
 * empty `GL` when neither exists so the hook degrades to nothing. The update
 * runs in a background subshell with both streams discarded: git waits for the
 * hook, not for the subshell, so a commit stays instant even on a large repo.
 */
const HOOK_BLOCK = [
  HOOK_MARKER,
  'if command -v greplost >/dev/null 2>&1; then GL="greplost"; elif command -v bunx >/dev/null 2>&1; then GL="bunx greplost"; else GL=""; fi',
  // The trailing `|| :` is what makes "greplost is not installed here" a
  // no-op rather than a failed hook: without it the guard's own false is the
  // script's exit status, and husky (which runs hooks under `sh -e`) reports a
  // hook failure on every commit in a checkout that has no greplost.
  '[ -n "$GL" ] && ( $GL update --incremental --quiet >/dev/null 2>&1 & ) || :',
  HOOK_END_MARKER,
  "",
].join("\n");

/**
 * The pre-commit block runs the update in the foreground and stages the map,
 * so the commit that changes a source file carries the map of that very tree:
 * a CI `greplost verify` on the commit then passes by construction. The
 * post-* hooks keep the backgrounded form (they run after git is done).
 */
const PRE_COMMIT_BLOCK = [
  HOOK_MARKER,
  'if command -v greplost >/dev/null 2>&1; then GL="greplost"; elif command -v bunx >/dev/null 2>&1; then GL="bunx greplost"; else GL=""; fi',
  '[ -n "$GL" ] && $GL update --incremental --quiet >/dev/null 2>&1 && git add -A .greplost >/dev/null 2>&1 || :',
  HOOK_END_MARKER,
  "",
].join("\n");

function blockFor(hook: string): string {
  return hook === "pre-commit" ? PRE_COMMIT_BLOCK : HOOK_BLOCK;
}

export interface HookInstallResult {
  /** Hook names newly given a greplost block, in install order. */
  installed: string[];
  /** Where the hooks went: husky's directory, git's own, or nowhere. */
  mode: "husky" | "plain" | "none";
  /** Anything the caller should tell the user: skips, lefthook, no git. */
  notes: string[];
}

/**
 * Install the greplost hooks under `root`.
 *
 * Husky wins when `.husky/` exists: husky repoints `core.hooksPath` at its own
 * directory, so a block written to `.git/hooks/` there would be installed,
 * correct, executable and never run.
 */
export function installGitHooks(root: string): HookInstallResult {
  const absoluteRoot = path.resolve(root);
  const notes: string[] = [];

  // The same test `update` applies before it trusts git: `root` must *be* the
  // top level of the work tree. A hook installed from a subdirectory would run
  // `greplost update` in a directory that has no `.greplost/` — and if it did
  // have one, it would be a second, wrong map. The two must agree about what a
  // repository root is, or `init` in a subdirectory installs hooks for a map it
  // then refuses to keep fresh.
  if (!isRepoRoot(absoluteRoot)) {
    notes.push("not a git repository root: no hooks installed");
    return { installed: [], mode: "none", notes };
  }

  const husky = isDirectory(path.join(absoluteRoot, ".husky"));
  const mode: "husky" | "plain" = husky ? "husky" : "plain";
  const directory = husky ? path.join(absoluteRoot, ".husky") : gitHooksDir(absoluteRoot);

  if (!husky && existsSync(path.join(absoluteRoot, "lefthook.yml"))) {
    notes.push(
      "lefthook.yml found: plain git hooks were installed; if lefthook takes over core.hooksPath, " +
        "add a `greplost update --incremental --quiet` command to its pre-commit (followed by `git add -A .greplost`), post-commit, post-merge and post-checkout entries",
    );
  }

  try {
    mkdirSync(directory, { recursive: true });
  } catch (cause) {
    throw new Error(`greplost: cannot create ${path.relative(absoluteRoot, directory)}: ${reasonOf(cause)}`);
  }

  const installed: string[] = [];
  for (const hook of HOOK_NAMES) {
    const file = path.join(directory, hook);
    const existing = readIfPresent(file);

    if (existing !== undefined && existing.includes(HOOK_MARKER)) {
      notes.push(`${hook} already has a greplost hook`);
      // Still worth ensuring: a hook that is not executable never runs, and
      // that is exactly the state a `chmod -R` or a fresh clone can leave.
      makeExecutable(file);
      continue;
    }

    write(file, existing, blockFor(hook));
    makeExecutable(file);
    installed.push(hook);
  }

  return { installed, mode, notes };
}

/**
 * Create or extend one hook file.
 *
 * A new plain hook needs the shebang; husky runs its files with `sh` itself,
 * and husky v9 warns about the shebang, so its files get the block alone. An
 * existing file is appended to, with a newline first if it lacks one — running
 * the previous last line and the marker together would comment out a command.
 */
function write(file: string, existing: string | undefined, block: string = HOOK_BLOCK): void {
  try {
    if (existing === undefined) {
      // Both kinds get the shebang. Husky runs its files itself and does not
      // need one, but a `.husky/post-commit` is also just a script someone may
      // run by hand, and a file that is executable without saying what should
      // execute it is a trap.
      writeFileSync(file, SHEBANG + block);
      return;
    }
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    appendFileSync(file, separator + block);
  } catch (cause) {
    throw new Error(`greplost: cannot install the ${path.basename(file)} hook: ${reasonOf(cause)}`);
  }
}

function makeExecutable(file: string): void {
  try {
    chmodSync(file, HOOK_MODE);
  } catch {
    // A hook on a filesystem without permission bits (or owned by someone
    // else) is git's problem to report, not a reason to fail the install.
  }
}

function readIfPresent(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Where git looks for hooks. `--git-path hooks` honours `core.hooksPath` and
 * worktrees, both of which make the literal `<root>/.git/hooks` wrong; the
 * literal path is the fallback for a git too old to answer.
 */
function gitHooksDir(root: string): string {
  const answer = git(root, ["rev-parse", "--git-path", "hooks"]);
  if (answer === undefined || answer.trim() === "") return path.join(root, ".git", "hooks");
  return path.resolve(root, answer.trim());
}

/** Is `root` the top level of a git work tree (not merely inside one)? */
function isRepoRoot(root: string): boolean {
  const toplevel = git(root, ["rev-parse", "--show-toplevel"]);
  if (toplevel === undefined || toplevel.trim() === "") return false;
  if (path.resolve(root) === path.resolve(toplevel.trim())) return true;
  // `--show-toplevel` always answers with symlinks resolved; `root` often is
  // not (every macOS temp directory, for one).
  return realpath(root) === realpath(toplevel.trim());
}

function realpath(target: string): string {
  try {
    return realpathSync(path.resolve(target));
  } catch {
    return path.resolve(target);
  }
}

function isDirectory(target: string): boolean {
  try {
    return lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** stdout of a git command, or `undefined` when git is absent or the command failed. */
function git(root: string, args: string[]): string | undefined {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (run.error !== undefined || run.status !== 0) return undefined;
  return run.stdout;
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
