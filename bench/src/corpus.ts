// Leaf 1.5.3 (bench corpus): pinned corpus definition and setup.
//
// Clones the pinned corpus repos (bench/corpus.json) into bench/.corpus/<name>
// at their pinned SHA, with just enough history for the replay suite (leaf
// 1.5.5) to walk 500+ commits backward. Exposes loadCorpus/corpusRoot/repoDir/
// selectRepos for the other bench suites to reuse (see "Shared conventions"
// in docs/superpowers/specs/2026-09-02-bench-design.md).

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

export type Tier = "S" | "M" | "L" | "XL";
export type CorpusLang = "ts" | "go";

const TIERS: readonly Tier[] = ["S", "M", "L", "XL"];

export interface CorpusRepoEntry {
  name: string;
  url: string;
  sha: string;
  tier: Tier;
  lang: CorpusLang;
  defaultBranch: string;
  notes: string;
}

export interface Corpus {
  pinnedAt: string;
  repos: CorpusRepoEntry[];
}

const MIN_HISTORY = 600;

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

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): GitResult {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
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
  return Number.isFinite(count) && count >= MIN_HISTORY;
}

/**
 * Clones (or reuses) `entry` into `repoDir(entry.name)` and checks out
 * `entry.sha`, fetching only what's missing:
 *   1. clone `--filter=blob:none --no-checkout` if the directory is absent
 *      (or present but not a git repo, which is repaired by re-cloning).
 *   2. `git checkout --quiet <sha>`, fetching the sha first if it isn't
 *      reachable locally yet.
 *   3. deepen to MIN_HISTORY commits behind the sha if the repo ended up
 *      shallow (only the fallback fetch in step 2 makes it shallow; a plain
 *      clone carries full history).
 * Steps that only touch local state (checkout, the local-availability and
 * shallow checks) never reach the network, so re-running against a repo
 * that is already at the right sha does no network I/O.
 */
export function setupRepo(entry: CorpusRepoEntry): void {
  const dir = repoDir(entry.name);
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });

  if (existsSync(dir) && !isGitRepo(dir)) {
    // A leftover non-git directory (partial clone that got interrupted,
    // stray files, ...) can't be reused; start clean.
    rmSync(dir, { recursive: true, force: true });
  }

  if (!existsSync(dir)) {
    const res = git(["clone", "--filter=blob:none", "--no-checkout", entry.url, dir], parent);
    if (res.status !== 0) {
      throw new Error(`clone of ${entry.name} (${entry.url}) failed: ${res.stderr.trim()}`);
    }
  }

  if (!commitAvailableLocally(dir, entry.sha)) {
    const res = git(["fetch", "--depth=600", "origin", entry.sha], dir);
    if (res.status !== 0) {
      throw new Error(`fetch of ${entry.name}@${entry.sha} failed: ${res.stderr.trim()}`);
    }
  }

  const checkout = git(["checkout", "--quiet", entry.sha], dir);
  if (checkout.status !== 0) {
    throw new Error(`checkout of ${entry.name}@${entry.sha} failed: ${checkout.stderr.trim()}`);
  }

  if (!hasEnoughHistory(dir, entry.sha)) {
    const res = git(["fetch", `--deepen=${MIN_HISTORY}`], dir);
    if (res.status !== 0) {
      throw new Error(`deepen of ${entry.name} failed: ${res.stderr.trim()}`);
    }
  }
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
