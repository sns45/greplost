/**
 * The workspace file and the id scheme (tech spec 4.4, workspace spec "Contract").
 *
 * A workspace is one `greplost.workspace.json` naming sibling repositories. It
 * is deliberately the whole configuration: each repo keeps its own `.greplost/`
 * and its own `config.json`, so a repo does not have to know it is in a
 * workspace, and a workspace does not get to change how a repo is indexed.
 *
 * Ids are the other half of the contract. Inside a repo every id is
 * repo-relative; across repos that is ambiguous, so a workspace id prefixes the
 * repo directory: `repo-b::src/main.ts`. `::` is the separator because it
 * cannot occur in a repo-relative posix path, so splitting is unambiguous and a
 * plain file id can never be mistaken for a workspace one.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { ARTIFACT_DIR, ARTIFACT_PATHS, compareStrings } from "@greplost/core/schema";

/** The file that marks a workspace root. */
export const WORKSPACE_FILE = "greplost.workspace.json";

/** Separator between a repo directory and an id inside that repo. */
export const ID_SEPARATOR = "::";

/** Workspace artifact paths, relative to the workspace's `.greplost/`. */
export const WORKSPACE_ARTIFACTS = {
  workspace: "WORKSPACE.md",
  cross: "graph/cross.jsonl",
} as const;

export interface WorkspaceConfig {
  name: string;
  /** Repo directories, relative to the workspace root, exactly as written. */
  repos: string[];
}

/**
 * The nearest ancestor of `startDir` (inclusive) holding a workspace file, or
 * `null`. Inclusive so that running from the workspace root itself works, which
 * is the case tech spec 4.4 names.
 */
export function findWorkspaceRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (isFile(path.join(dir, WORKSPACE_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Read and validate `<root>/greplost.workspace.json`.
 *
 * Validation is strict about the two things that would otherwise fail much
 * later and much less clearly: a repo entry that is not a relative directory
 * inside the workspace, and two entries naming the same directory. `name` is
 * optional and falls back to the workspace directory's own name, the same rule
 * core uses for an unnamed root package.
 */
export function loadWorkspace(root: string): WorkspaceConfig {
  const absolute = path.resolve(root);
  const file = path.join(absolute, WORKSPACE_FILE);

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    throw new Error(`greplost: cannot read ${WORKSPACE_FILE} in ${path.basename(absolute)}: ${reasonOf(cause)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`greplost: ${WORKSPACE_FILE} is not valid JSON: ${reasonOf(cause)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`greplost: ${WORKSPACE_FILE} must be a JSON object with a "repos" array`);
  }

  // A workspace root that is also an indexed repository is a configuration
  // nothing downstream can serve: `graph/cross.jsonl` sits in the same
  // `.greplost/graph/` that a repo build owns and prunes, so the repo's next
  // `update` would delete the workspace's edges, and every workspace command
  // run here would silently leave the root repo's own map to go stale.
  if (existsSync(path.join(absolute, ARTIFACT_DIR, ARTIFACT_PATHS.manifest))) {
    throw new Error(
      `greplost: "${path.basename(absolute)}" is both a workspace root and an indexed repository; ` +
        `${ARTIFACT_DIR}/graph/ cannot belong to both — move ${WORKSPACE_FILE} to a parent directory, ` +
        `or remove the ${ARTIFACT_DIR}/ map here`,
    );
  }

  const record = parsed as Record<string, unknown>;
  const rawName = typeof record["name"] === "string" ? record["name"].trim() : "";
  const name = rawName === "" ? path.basename(absolute) : rawName;

  const rawRepos = record["repos"];
  if (!Array.isArray(rawRepos)) {
    throw new Error(`greplost: ${WORKSPACE_FILE} must list its repos in a "repos" array`);
  }

  const repos: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawRepos) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`greplost: ${WORKSPACE_FILE} repos entries must be non-empty relative directories`);
    }
    const dir = repoDirId(entry);
    if (dir === null) {
      throw new Error(`greplost: ${WORKSPACE_FILE} repo "${entry}" must be a relative directory inside the workspace`);
    }
    if (seen.has(dir)) {
      throw new Error(`greplost: ${WORKSPACE_FILE} lists "${dir}" twice`);
    }
    seen.add(dir);
    repos.push(entry);
  }

  // A repo inside another repo would be indexed twice — once by its own map and
  // once by its parent's — so the same source file would carry two workspace
  // ids and every count in WORKSPACE.md would be wrong. Refuse rather than
  // report a total nobody can reconcile.
  const dirs = [...seen].sort(compareStrings);
  for (const inner of dirs) {
    for (const outer of dirs) {
      if (inner !== outer && inner.startsWith(`${outer}/`)) {
        throw new Error(`greplost: ${WORKSPACE_FILE} repo "${inner}" is inside repo "${outer}"`);
      }
    }
  }

  return { name, repos };
}

/**
 * A repo entry as an id: `./repo-a/` becomes `repo-a`. `null` when the entry is
 * absolute, escapes the workspace, or normalises to the workspace root itself —
 * all three would make `<repo>::<file>` ids meaningless.
 */
export function repoDirId(entry: string): string | null {
  const raw = entry.replace(/\\/g, "/").trim();
  if (raw === "" || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return null;

  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    if (segment.includes(ID_SEPARATOR)) return null;
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join("/");
}

/** `repo-b` + `src/main.ts` -> `repo-b::src/main.ts`. */
export function workspaceId(repoDir: string, localId: string): string {
  return `${repoDir}${ID_SEPARATOR}${localId}`;
}

/** The inverse of `workspaceId`, or `null` when `id` carries no repo prefix. */
export function splitWorkspaceId(id: string): { repo: string; local: string } | null {
  const index = id.indexOf(ID_SEPARATOR);
  if (index <= 0) return null;
  const local = id.slice(index + ID_SEPARATOR.length);
  return local === "" ? null : { repo: id.slice(0, index), local };
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** True when `dir` exists and is a directory. */
export function isDirectory(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
