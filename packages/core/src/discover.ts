/**
 * File discovery (tech spec 5.1, sub-project spec "discover").
 *
 * Inside a git work tree, candidates come from `git ls-files` (honours
 * .gitignore, includes untracked files, keeps tracked-but-ignored files, and
 * is filtered by any file that no longer exists on disk). Outside a git work
 * tree, candidates come from a fast-glob walk of `config.include`. Either
 * way, `config.include`/`config.exclude` are re-applied uniformly with
 * picomatch, paths are mapped to a language by `langOf`, and only
 * `config.languages` survive. Files under `.greplost/` are never returned.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import fg from "fast-glob";
import picomatch from "picomatch";

import { ARTIFACT_DIR, compareStrings } from "./schema.ts";
import type { GreplostConfig, Lang } from "./schema.ts";
import { langOf } from "./lang.ts";

export interface DiscoveredFile {
  /** Repo-relative, posix, no leading "./". */
  path: string;
  absPath: string;
  lang: Lang;
}

const GIT_LS_FILES_MAX_BUFFER = 64 * 1024 * 1024;

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

function isGitRepo(root: string): boolean {
  let toplevel: string;
  try {
    toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return false;
  }
  if (!toplevel) return false;
  // Resolve real paths (not just `path.resolve`) before comparing: on macOS
  // `os.tmpdir()` (and other paths) can live under a symlink (e.g.
  // `/var/...` -> `/private/var/...`), while `git rev-parse --show-toplevel`
  // always returns the canonical, symlink-resolved path.
  let resolvedRoot: string;
  let resolvedTop: string;
  try {
    resolvedRoot = realpathSync(resolve(root));
    resolvedTop = realpathSync(resolve(toplevel));
  } catch {
    resolvedRoot = resolve(root);
    resolvedTop = resolve(toplevel);
  }
  return resolvedRoot === resolvedTop || resolvedRoot.startsWith(resolvedTop + sep);
}

function gitCandidates(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: GIT_LS_FILES_MAX_BUFFER,
  });
  const result: string[] = [];
  for (const raw of out.split("\0")) {
    if (raw.length === 0) continue;
    const relPath = toPosix(raw);
    // A file can be cached in the index yet missing from the working tree
    // (deleted without `git rm`); such entries are skipped.
    if (!existsSync(join(root, relPath))) continue;
    result.push(relPath);
  }
  return result;
}

async function globCandidates(root: string, config: GreplostConfig): Promise<string[]> {
  // `dot: true` here (not the fast-glob default `false`): candidate generation
  // must not silently drop hidden files/directories before the picomatch pass
  // below gets a chance to apply `config.include`/`config.exclude`. picomatch
  // is the sole include/exclude authority in both modes (git mode's
  // `git ls-files` has no such restriction either), so dotfile handling stays
  // symmetric regardless of whether `root` happens to be a git work tree.
  // `.git/` and `.greplost/` are still excluded: by DEFAULT_CONFIG's exclude
  // globs and, for `.greplost/`, the unconditional drop below.
  const entries = await fg(config.include, {
    cwd: root,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  return entries.map(toPosix);
}

/**
 * Every repo-relative path `config.include`/`config.exclude` admit, sorted and
 * deduplicated — before anything is asked about its language.
 *
 * This is `discoverFiles` with its last step left off, and it exists because
 * the files that decide *which* languages to index are not themselves indexable
 * ones: `greplost init` reads a repository's `go.mod` to know that `"go"`
 * belongs in the config it is about to write, and `go.mod` has no extension
 * this map would ever match.
 */
export async function discoverCandidates(root: string, config: GreplostConfig): Promise<string[]> {
  const candidates = isGitRepo(root) ? gitCandidates(root) : await globCandidates(root, config);

  const includeMatch = picomatch(config.include, { dot: true });
  const excludeMatch = picomatch(config.exclude, { dot: true });

  const kept = new Set<string>();
  for (const relPath of candidates) {
    if (relPath === ARTIFACT_DIR || relPath.startsWith(`${ARTIFACT_DIR}/`)) continue;
    if (!includeMatch(relPath)) continue;
    if (excludeMatch(relPath)) continue;
    kept.add(relPath);
  }

  return [...kept].sort(compareStrings);
}

export async function discoverFiles(root: string, config: GreplostConfig): Promise<DiscoveredFile[]> {
  const results: DiscoveredFile[] = [];

  for (const relPath of await discoverCandidates(root, config)) {
    const lang = langOf(relPath);
    if (!lang) continue;
    if (!config.languages.includes(lang)) continue;

    results.push({ path: relPath, absPath: join(root, relPath), lang });
  }

  results.sort((a, b) => compareStrings(a.path, b.path));
  return results;
}
