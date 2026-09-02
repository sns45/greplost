/**
 * Building and verifying a workspace (tech spec 4.4, workspace spec "Contract").
 *
 * `buildWorkspace` is `greplost update` for a workspace: it makes every repo's
 * own map current first — because a cross-repo edge is only as true as the two
 * maps it joins — and then writes the two artifacts the workspace itself owns.
 * `verifyWorkspace` is the merge gate: every repo's `verify`, plus a byte
 * comparison of those two artifacts against a fresh render.
 *
 * The write is byte-comparing, like sync's: an artifact whose bytes did not
 * change keeps its mtime, so a workspace build that changed nothing leaves no
 * trace in `git status` or in any watcher.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ARTIFACT_DIR, ARTIFACT_PATHS, compareStrings } from "@greplost/core/schema";
import { init, unifiedDiff, update, verify } from "@greplost/sync";
import type { VerifyResult } from "@greplost/sync";

import { WORKSPACE_ARTIFACTS, isDirectory, loadWorkspace, reasonOf, repoDirId } from "./config.ts";
import type { CrossEdge, RepoView, ResolvedCross } from "./cross.ts";
import { crossEdges, readRepo } from "./cross.ts";
import { renderCross, renderWorkspace } from "./render.ts";
import type { RepoSummary } from "./render.ts";

export interface WorkspaceBuild {
  /** Workspace name, from the workspace file. */
  name: string;
  repos: RepoSummary[];
  cross: CrossEdge[];
  /** Artifact-relative path -> content, exactly as written. */
  files: Map<string, string>;
  /** Workspace-relative paths whose bytes changed, sorted. */
  written: string[];
}

export interface BuildWorkspaceOptions {
  /** Passed to each repo's `update`; `"full"` ignores the incremental fast path. */
  mode?: "incremental" | "full";
}

/**
 * Bring every repo's map and the workspace artifacts up to date.
 *
 * A repo with no map at all is initialised rather than updated: `init` writes
 * the repo's `config.json` and `.gitignore` and runs the first full build, and
 * doing it here means adding a repo to the workspace file is the only step a
 * user has to take. Git hooks are never installed from a workspace build — the
 * user asked to build a workspace, not to change what every commit in a
 * repository they may not own now runs.
 */
export async function buildWorkspace(root: string, opts: BuildWorkspaceOptions = {}): Promise<WorkspaceBuild> {
  const absolute = path.resolve(root);
  const config = loadWorkspace(absolute);
  const mode = opts.mode ?? "incremental";

  const repos: RepoView[] = [];
  for (const dir of repoDirs(config.repos)) {
    const repoRoot = path.join(absolute, dir);
    if (!isDirectory(repoRoot)) {
      throw new Error(`greplost: workspace repo "${dir}" does not exist`);
    }
    await ensureRepoMap(repoRoot, mode);

    const view = readRepo(absolute, dir);
    if (!view.indexed) {
      throw new Error(`greplost: workspace repo "${dir}" has no map after update`);
    }
    repos.push(view);
  }
  repos.sort((a, b) => compareStrings(a.dir, b.dir));

  const cross = crossEdges(repos);
  const files = renderArtifacts(config.name, repos, cross);
  const written = writeWorkspaceArtifacts(absolute, files);

  return { name: config.name, repos: repos.map(summaryOf), cross: cross.map((entry) => entry.edge), files, written };
}

/**
 * Every repo's `verify`, then the workspace's own artifacts.
 *
 * Nothing is rebuilt: a repo's map is compared against what its sources say it
 * should be, and the workspace artifacts against what the repos' committed maps
 * say they should be. Paths are reported as the workspace sees them —
 * `repo-a/.greplost/INDEX.md` for a repo's artifact, `.greplost/WORKSPACE.md`
 * for the workspace's own — so one list names every divergence unambiguously.
 */
export async function verifyWorkspace(root: string, opts: { diff?: boolean } = {}): Promise<VerifyResult> {
  const absolute = path.resolve(root);
  const config = loadWorkspace(absolute);
  const wantDiff = opts.diff === true;

  const changed: string[] = [];
  const missing: string[] = [];
  const extra: string[] = [];
  let diff: string | undefined;

  const repos: RepoView[] = [];
  for (const dir of repoDirs(config.repos)) {
    const repoRoot = path.join(absolute, dir);
    if (!isDirectory(repoRoot)) {
      missing.push(`${dir}/${ARTIFACT_DIR}/${ARTIFACT_PATHS.manifest}`);
      continue;
    }

    const result = await verify(repoRoot, { diff: wantDiff });
    const prefix = `${dir}/${ARTIFACT_DIR}/`;
    changed.push(...result.changed.map((rel) => prefix + rel));
    missing.push(...result.missing.map((rel) => prefix + rel));
    extra.push(...result.extra.map((rel) => prefix + rel));
    if (diff === undefined && result.diff !== undefined) diff = withRepoPrefix(result.diff, dir);

    repos.push(readRepo(absolute, dir));
  }
  repos.sort((a, b) => compareStrings(a.dir, b.dir));

  const expected = renderArtifacts(config.name, repos, crossEdges(repos));
  for (const rel of [...expected.keys()].sort(compareStrings)) {
    const target = path.join(absolute, ARTIFACT_DIR, rel);
    const reported = `${ARTIFACT_DIR}/${rel}`;
    const actual = readArtifact(target);
    // `unifiedDiff` writes the `.greplost/` prefix itself, so it takes the
    // artifact-relative path, not the workspace-relative one reported above.
    if (actual === null) {
      missing.push(reported);
      if (wantDiff && diff === undefined) diff = unifiedDiff(rel, "", expected.get(rel) ?? "");
      continue;
    }
    if (actual !== expected.get(rel)) {
      changed.push(reported);
      if (wantDiff && diff === undefined) diff = unifiedDiff(rel, actual, expected.get(rel) ?? "");
    }
  }

  changed.sort(compareStrings);
  missing.sort(compareStrings);
  extra.sort(compareStrings);

  const ok = changed.length === 0 && missing.length === 0 && extra.length === 0;
  const result: VerifyResult = { ok, changed, missing, extra };
  if (diff !== undefined && !ok) result.diff = diff;
  return result;
}

/** The workspace artifacts for a set of repos, artifact-relative path -> bytes. */
export function renderArtifacts(
  name: string,
  repos: readonly RepoView[],
  cross: readonly ResolvedCross[],
): Map<string, string> {
  const summaries = repos.map(summaryOf);
  return new Map([
    [WORKSPACE_ARTIFACTS.workspace, renderWorkspace({ name, repos: summaries, cross })],
    [WORKSPACE_ARTIFACTS.cross, renderCross(cross.map((entry) => entry.edge))],
  ]);
}

function summaryOf(repo: RepoView): RepoSummary {
  return { dir: repo.dir, name: repo.name, packages: repo.packages, files: repo.files.length };
}

/** Repo entries as directory ids, sorted, skipping anything `loadWorkspace` rejected. */
function repoDirs(entries: readonly string[]): string[] {
  const dirs: string[] = [];
  for (const entry of entries) {
    const dir = repoDirId(entry);
    if (dir !== null) dirs.push(dir);
  }
  return dirs.sort(compareStrings);
}

/**
 * Make one repo's map current: a first build when it has none, an ordinary
 * update when it has. `init` already runs a full build, so an update after it
 * would only repeat the work it just did.
 */
async function ensureRepoMap(repoRoot: string, mode: "incremental" | "full"): Promise<void> {
  const manifest = path.join(repoRoot, ARTIFACT_DIR, ARTIFACT_PATHS.manifest);
  if (existsSync(manifest)) {
    await update(repoRoot, { mode, quiet: true });
    return;
  }
  await init(repoRoot, { hooks: false, quiet: true });
}

/** Write the artifacts that changed; returns the workspace-relative paths written. */
function writeWorkspaceArtifacts(root: string, files: Map<string, string>): string[] {
  const written: string[] = [];
  for (const rel of [...files.keys()].sort(compareStrings)) {
    const target = path.join(root, ARTIFACT_DIR, rel);
    const content = files.get(rel) as string;
    if (readArtifact(target) === content) continue;

    try {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    } catch (cause) {
      throw new Error(`greplost: cannot write ${ARTIFACT_DIR}/${rel}: ${reasonOf(cause)}`);
    }
    written.push(`${ARTIFACT_DIR}/${rel}`);
  }
  return written;
}

/**
 * Put the repo directory into a repo diff's file headers.
 *
 * `verify` names its artifacts `.greplost/<path>`, which is unambiguous inside
 * one repo and ambiguous inside a workspace: three repos can all report a
 * changed `.greplost/INDEX.md`. Only the two header lines are rewritten, and
 * only when they carry the markers they are documented to carry, so a diff body
 * that happens to start with `---` is never touched.
 */
function withRepoPrefix(diff: string, dir: string): string {
  const lines = diff.split("\n");
  for (let index = 0; index < Math.min(2, lines.length); index++) {
    const line = lines[index] as string;
    for (const marker of ["--- a/", "+++ b/"]) {
      if (line.startsWith(marker)) lines[index] = `${marker}${dir}/${line.slice(marker.length)}`;
    }
  }
  return lines.join("\n");
}

function readArtifact(target: string): string | null {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
}
