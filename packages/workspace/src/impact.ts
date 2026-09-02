/**
 * Blast radius across repositories (tech spec 4.4, X10).
 *
 * The question `greplost impact` answers inside one repo — "if I change this
 * file, what can break?" — stops at the repo boundary, and that boundary is
 * exactly where the expensive surprises live. Here the graph is the union of
 * every repo's own import and re-export edges, each id prefixed with its repo,
 * plus the cross edges: one reverse breadth-first search over the lot.
 *
 * Directory targets are expanded on both halves, so a Go workspace answers this
 * as well as a TypeScript one: core's `expandDirectoryTargets` does it for the
 * edges inside a repo, and a cross edge that lands on a sibling's Go package
 * directory is expanded to that directory's files here.
 */

import { realpathSync } from "node:fs";
import path from "node:path";

import { expandDirectoryTargets, impactOf } from "@greplost/core/graph";
import { compareStrings } from "@greplost/core/schema";

import { loadWorkspace, repoDirId, splitWorkspaceId, workspaceId } from "./config.ts";
import type { RepoView } from "./cross.ts";
import { crossEdges, readRepo } from "./cross.ts";

export interface ImpactedFile {
  /** `<repoDir>::<file>`. */
  id: string;
  /** Hops from the target: 1 imports it directly. */
  depth: number;
}

/**
 * Every file in the workspace that transitively imports `target`, nearest first.
 *
 * `depth` truncates the listing and nothing else: a caller that wants the full
 * radius asks for the length of the untruncated result, so a limit can never
 * silently understate the risk.
 */
export function impactAcross(root: string, target: string, depth?: number): ImpactedFile[] {
  const repos = readWorkspaceRepos(root);
  const id = resolveWorkspaceTarget(root, target, repos);
  if (id === undefined) {
    const split = splitWorkspaceId(target);
    if (split !== null && !repos.some((candidate) => candidate.dir === split.repo)) {
      throw new Error(`greplost: "${split.repo}" is not a repo in this workspace`);
    }
    if (split === null) {
      throw new Error(`greplost: "${target}" is not a workspace id; use <repo>::<file>, e.g. ${exampleId(repos)}`);
    }
    throw new Error(`greplost: ${target} is not in the map; run \`greplost update\` or check the path`);
  }

  const reached = impactOf(workspacePairs(repos), id).map((file) => ({ id: file.path, depth: file.depth }));
  return depth === undefined ? reached : reached.filter((file) => file.depth <= depth);
}

/**
 * A command-line argument as a workspace id, or `undefined`.
 *
 * Three spellings all mean the same file, and all three arrive in practice: the
 * workspace id `repo-a::src/index.ts`, the path the workspace sees
 * (`repo-a/src/index.ts`), and the path a shell or an editor produced — the
 * absolute one, or one relative to wherever the command was run. An agent that
 * has just read a file has its path, not its id, and refusing that is refusing
 * the common case for no reason.
 *
 * Only an indexed file resolves. Nothing is guessed: an argument that names no
 * file in any repo comes back `undefined` rather than a nearest match.
 */
export function resolveWorkspaceTarget(
  root: string,
  argument: string,
  repos: readonly RepoView[],
): string | undefined {
  const split = splitWorkspaceId(argument);
  if (split !== null) {
    const repo = repos.find((candidate) => candidate.dir === split.repo);
    return repo !== undefined && repo.fileSet.has(split.local) ? argument : undefined;
  }

  for (const relative of workspaceRelatives(root, argument)) {
    for (const repo of repos) {
      const prefix = `${repo.dir}/`;
      if (!relative.startsWith(prefix)) continue;
      const local = relative.slice(prefix.length);
      if (repo.fileSet.has(local)) return workspaceId(repo.dir, local);
    }
  }
  return undefined;
}

/**
 * The workspace-relative spellings an argument could have, most likely first.
 *
 * Both ends are also tried through `realpath`, because the two sides reach us
 * by different routes: `--root` is whatever the user typed, while
 * `process.cwd()` is always fully resolved. On macOS that difference is not
 * hypothetical — every path under `/var` and `/tmp` is a symlink into
 * `/private`, so a workspace named one way and a cwd named the other would
 * never line up without this.
 */
function workspaceRelatives(root: string, argument: string): string[] {
  const posix = (value: string): string => value.split(path.sep).join("/").replace(/^\.\//, "").replace(/\/+$/, "");
  const absolute = path.resolve(root);

  const bases = unique([absolute, realPath(absolute)]);
  const targets = path.isAbsolute(argument)
    ? unique([path.resolve(argument), realPath(path.resolve(argument))])
    : unique([
        path.resolve(absolute, argument),
        path.resolve(process.cwd(), argument),
        realPath(path.resolve(process.cwd(), argument)),
      ]);

  const out = path.isAbsolute(argument) ? [] : [posix(argument)];
  for (const base of bases) {
    for (const target of targets) {
      const relative = path.relative(base, target);
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      out.push(posix(relative));
    }
  }
  return unique(out).filter((value) => value !== "");
}

/** `realpath`, or the path unchanged when it does not exist. */
function realPath(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function unique(values: readonly string[]): string[] {
  return values.filter((value, index, all) => all.indexOf(value) === index);
}

/** Every repo of the workspace at `root`, in sorted directory order. */
export function readWorkspaceRepos(root: string): RepoView[] {
  const config = loadWorkspace(root);
  const repos: RepoView[] = [];
  for (const entry of config.repos) {
    const dir = repoDirId(entry);
    if (dir === null) continue;
    repos.push(readRepo(root, dir));
  }
  return repos.sort((a, b) => compareStrings(a.dir, b.dir));
}

/**
 * Importer-to-imported pairs for the whole workspace, ids already prefixed.
 *
 * Duplicates are harmless — `impactOf` walks a reverse adjacency map — so the
 * two halves are simply concatenated rather than merged.
 */
export function workspacePairs(repos: readonly RepoView[]): Array<readonly [string, string]> {
  const byDir = new Map(repos.map((repo) => [repo.dir, repo]));
  const pairs: Array<readonly [string, string]> = [];

  for (const repo of repos) {
    for (const [from, to] of expandDirectoryTargets(repo.imports, repo.files)) {
      pairs.push([workspaceId(repo.dir, from), workspaceId(repo.dir, to)] as const);
    }
  }

  for (const cross of crossEdges(repos)) {
    const split = splitWorkspaceId(cross.edge.to);
    if (split === null) continue;
    const target = byDir.get(split.repo);
    if (target === undefined) continue;

    if (target.fileSet.has(split.local)) {
      pairs.push([cross.edge.from, cross.edge.to] as const);
      continue;
    }
    // A Go package directory: one pair per file the sibling indexes under it.
    for (const file of target.filesByDir.get(split.local) ?? []) {
      pairs.push([cross.edge.from, workspaceId(target.dir, file)] as const);
    }
  }

  return pairs;
}

/** A real id from this workspace, so the error message shows the shape it wants. */
function exampleId(repos: readonly RepoView[]): string {
  for (const repo of repos) {
    const first = repo.files[0];
    if (first !== undefined) return workspaceId(repo.dir, first);
  }
  return "repo::path/to/file.ts";
}
