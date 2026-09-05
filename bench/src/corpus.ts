// Leaf 1.5.3 (bench corpus): pinned corpus definition and setup.
//
// Clones the pinned corpus repos (bench/corpus.json) into bench/.corpus/<name>
// at their pinned SHA, with just enough history for the replay suite (leaf
// 1.5.5) to walk 500+ commits backward. Exposes loadCorpus/corpusRoot/repoDir/
// selectRepos for the other bench suites to reuse (see "Shared conventions"
// in docs/superpowers/specs/2026-09-02-bench-design.md).

import type { Lang } from "@greplost/core/schema";
import { BACKFILL_TIMEOUT_MS, GIT_TIMEOUT_MS, git as sharedGit, type GitResult } from "./git.ts";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export type Tier = "S" | "M" | "L" | "XL";
/**
 * Every language greplost indexes (schema 2). Build 1 pinned this to `"ts" | "go"`, which
 * meant a build-2 corpus entry would have been silently scored as TypeScript.
 */
export type CorpusLang = Lang;

const TIERS: readonly Tier[] = ["S", "M", "L", "XL"];

export interface CorpusRepoEntry {
  name: string;
  url: string;
  sha: string;
  tier: Tier;
  lang: CorpusLang;
  defaultBranch: string;
  notes: string;
  /**
   * A picomatch pattern limiting which of the repo's files are indexed and scored, applied by
   * the harness when it writes the per-repo `.greplost/config.json` include list.
   *
   * A subset is a property of the pin, not a thing a human remembers: `pulumi/examples` is
   * both the TypeScript and the Go Pulumi corpus, and scoring either against the whole
   * checkout would measure the other language's files as unindexed.
   */
  subset?: string;
}

export interface Corpus {
  pinnedAt: string;
  repos: CorpusRepoEntry[];
}

// Default fetch depth (also the deepen target and the "has enough history"
// threshold): 600 commits behind the pinned sha is enough for the replay
// suite (leaf 1.5.5) to walk 500 commits backward. Overridable per call
// (test-only: real callers never need a different depth) so a small local
// fixture repo can be driven into a genuinely shallow state without needing
// 600 real commits.
const HISTORY_DEPTH = 600;

// --- location -----------------------------------------------------------

let cachedRoot: string | undefined;

/**
 * Walks up from this file's directory to find the directory that contains
 * `bench/corpus.json` (i.e. the monorepo root), so callers work regardless
 * of the process's current working directory.
 */
export function corpusRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = import.meta.dir;
  for (;;) {
    if (existsSync(join(dir, "bench", "corpus.json"))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("could not locate the directory containing bench/corpus.json by walking up from bench/src");
    }
    dir = parent;
  }
}

export function loadCorpus(): Corpus {
  const path = join(corpusRoot(), "bench", "corpus.json");
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as Corpus;
}

export function repoDir(name: string): string {
  return join(corpusRoot(), "bench", ".corpus", name);
}

// --- selection ------------------------------------------------------------

/**
 * Parses `--tier <T>`, `--repo <name>` and `--all` out of an args array
 * (flags may appear anywhere, e.g. after a "setup" or "list" subcommand, or
 * on their own when called by another suite). `--repo` wins over `--all`,
 * which wins over `--tier`; the default with no filter is tier S.
 */
export function selectRepos(args: string[]): CorpusRepoEntry[] {
  let tier: string | undefined;
  let repoName: string | undefined;
  let all = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--tier") {
      tier = args[++i];
    } else if (arg === "--repo") {
      repoName = args[++i];
    } else if (arg === "--all") {
      all = true;
    }
  }

  const corpus = loadCorpus();

  if (repoName !== undefined) {
    const found = corpus.repos.filter((r) => r.name === repoName);
    if (found.length === 0) {
      throw new Error(`unknown corpus repo: ${repoName}`);
    }
    return found;
  }
  if (all) {
    return corpus.repos.slice();
  }
  const wantedTier = tier ?? "S";
  if (!TIERS.includes(wantedTier as Tier)) {
    throw new Error(`unknown corpus tier: ${wantedTier} (expected one of ${TIERS.join(", ")})`);
  }
  return corpus.repos.filter((r) => r.tier === wantedTier);
}

// --- git plumbing ---------------------------------------------------------

/**
 * Every corpus git call goes through the shared bounded wrapper (`./git.ts`):
 * a fetch that loses its connection is killed and reported, never left to hang
 * the whole `corpus setup`. Network fetches get the long backfill budget; local
 * plumbing keeps the default.
 */
function git(args: string[], cwd: string, timeout: number = GIT_TIMEOUT_MS): GitResult {
  return sharedGit(cwd, args, { timeout });
}

function isGitRepo(dir: string): boolean {
  // A plain `<dir>/.git` existence check, not `git rev-parse --is-inside-work-tree`:
  // the latter walks up parent directories and would report `true` for a bare,
  // non-git directory nested inside this monorepo's own working tree.
  return existsSync(join(dir, ".git"));
}

function commitAvailableLocally(dir: string, sha: string): boolean {
  const res = git(["cat-file", "-e", `${sha}^{commit}`], dir);
  return res.status === 0;
}

function isShallow(dir: string): boolean {
  const res = git(["rev-parse", "--is-shallow-repository"], dir);
  return res.status === 0 && res.stdout.trim() === "true";
}

function hasEnoughHistory(dir: string, sha: string): boolean {
  if (!isShallow(dir)) return true;
  const res = git(["rev-list", "--count", sha], dir);
  if (res.status !== 0) return false;
  const count = Number.parseInt(res.stdout.trim(), 10);
  return Number.isFinite(count) && count >= HISTORY_DEPTH;
}

/**
 * Makes sure `repoDir(entry.name)` is a git repo with `origin` pointed at
 * `entry.url`: `git init -q <dir>` + `git remote add origin <url>` if the
 * directory is absent, or present but not a git repo (a leftover non-git
 * directory, an interrupted clone, stray files, ..., can't be reused, so
 * it's removed first and rebuilt clean).
 */
function ensureRepoInitialized(entry: CorpusRepoEntry): string {
  const dir = repoDir(entry.name);
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });

  if (existsSync(dir) && !isGitRepo(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }

  if (!isGitRepo(dir)) {
    const init = git(["init", "-q", dir], parent);
    if (init.status !== 0) {
      throw new Error(`git init failed for ${entry.name} at ${dir}: ${init.stderr.trim()}`);
    }
    const remote = git(["remote", "add", "origin", entry.url], dir);
    if (remote.status !== 0) {
      throw new Error(`git remote add failed for ${entry.name}: ${remote.stderr.trim()}`);
    }
  }

  return dir;
}

/**
 * Fetches `entry.sha` directly (bounded to `depth` commits behind it) and
 * checks it out. Never clones full history: GitHub (and any host with
 * `uploadpack.allowReachableSHA1InWant`) serves an arbitrary reachable
 * commit by id, so `git fetch --depth=<depth> --filter=blob:none origin
 * <sha>` bounds the fetch the same way whether this is the first fetch for
 * a fresh repo or a later fetch for a sha that has changed, an L/XL repo
 * (grafana, TypeScript) never pulls its full 100k+-commit history. Skips
 * the fetch (no network) when `entry.sha` is already present locally, so
 * re-running at the same sha is idempotent; a checkout of a different sha
 * always fetches (bounded) and re-checks out.
 */
export function fetchAndCheckout(entry: CorpusRepoEntry, depth: number = HISTORY_DEPTH): void {
  const dir = ensureRepoInitialized(entry);

  if (!commitAvailableLocally(dir, entry.sha)) {
    const res = git(["fetch", "--quiet", `--depth=${depth}`, "--filter=blob:none", "origin", entry.sha], dir, BACKFILL_TIMEOUT_MS);
    if (res.status !== 0) {
      throw new Error(`fetch of ${entry.name}@${entry.sha} failed: ${res.stderr.trim()}`);
    }
  }

  const checkout = git(["checkout", "--quiet", entry.sha], dir);
  if (checkout.status !== 0) {
    throw new Error(`checkout of ${entry.name}@${entry.sha} failed: ${checkout.stderr.trim()}`);
  }
}

/**
 * Widens a shallow clone to HISTORY_DEPTH (600) commits behind `entry.sha`
 * via `git fetch --deepen=600`, a no-op (no network) when the repo isn't
 * shallow, and harmlessly saturates at the repo's actual root commit when
 * it has fewer than 600 commits in total (e.g. anyq).
 */
export function deepenHistory(entry: CorpusRepoEntry): void {
  const dir = repoDir(entry.name);
  if (!hasEnoughHistory(dir, entry.sha)) {
    const res = git(["fetch", `--deepen=${HISTORY_DEPTH}`], dir, BACKFILL_TIMEOUT_MS);
    if (res.status !== 0) {
      throw new Error(`deepen of ${entry.name} failed: ${res.stderr.trim()}`);
    }
  }
}

/**
 * Clones (or reuses) `entry` into `repoDir(entry.name)`, checks out
 * `entry.sha`, and ensures HISTORY_DEPTH commits of history behind it; see
 * `fetchAndCheckout` and `deepenHistory`. `depth` is a test-only override of
 * the initial fetch's `--depth`; real callers should omit it.
 */
export function setupRepo(entry: CorpusRepoEntry, opts: { depth?: number } = {}): void {
  fetchAndCheckout(entry, opts.depth ?? HISTORY_DEPTH);
  deepenHistory(entry);
}

// --- CLI --------------------------------------------------------------

function printList(repos: CorpusRepoEntry[]): void {
  for (const repo of repos) {
    const cloned = isGitRepo(repoDir(repo.name));
    console.log(`${repo.name}: tier ${repo.tier} lang ${repo.lang} sha ${repo.sha} (${cloned ? "cloned" : "not cloned"})`);
  }
}

export async function run(args: string[]): Promise<number> {
  const [cmd, ...rest] = args;
  try {
    if (cmd === "setup") {
      const repos = selectRepos(rest);
      for (const entry of repos) {
        setupRepo(entry);
        console.log(`${entry.name}: ready at ${entry.sha}`);
      }
      return 0;
    }
    if (cmd === "list") {
      const hasFilter = rest.includes("--tier") || rest.includes("--repo") || rest.includes("--all");
      const repos = hasFilter ? selectRepos(rest) : loadCorpus().repos;
      printList(repos);
      return 0;
    }
    console.error(`unknown corpus command: ${cmd ?? "(none)"} (expected "setup" or "list")`);
    return 2;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}
