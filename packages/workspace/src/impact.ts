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

import { expandDirectoryTargets, impactOf } from "@greplost/core/graph";

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
  const split = splitWorkspaceId(target);
  if (split === null) {
    throw new Error(`greplost: "${target}" is not a workspace id; use <repo>::<file>, e.g. ${exampleId(repos)}`);
  }

  const repo = repos.find((candidate) => candidate.dir === split.repo);
  if (repo === undefined) {
    throw new Error(`greplost: "${split.repo}" is not a repo in this workspace`);
  }
  if (!repo.fileSet.has(split.local)) {
    throw new Error(`greplost: ${target} is not in the map; run \`greplost update\` or check the path`);
  }

  const reached = impactOf(workspacePairs(repos), target).map((file) => ({ id: file.path, depth: file.depth }));
  return depth === undefined ? reached : reached.filter((file) => file.depth <= depth);
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
  return repos.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
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
