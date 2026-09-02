/**
 * Public surface of `@greplost/workspace`, and the CLI seam.
 *
 * Two audiences. Anything embedding the workspace layer gets
 * `findWorkspaceRoot`, `loadWorkspace`, `buildWorkspace`, `verifyWorkspace` and
 * `impactAcross`. The `greplost` CLI gets `registerWorkspaceHooks`, which is the
 * only thing it looks for: it lazily imports this package once and hands over a
 * setter, and `update`, `verify` and `impact` then offer this layer first
 * refusal before running their ordinary single-repo path.
 *
 * The hooks decline unless the root the command resolved *is* a workspace root.
 * That keeps tech spec 4.4's promise in both directions: run from the workspace
 * root (or point `--root` at it) and every command answers across repos; run
 * inside one of its repos and that repo answers for itself, exactly as it does
 * outside a workspace. A workspace file three directories up must never change
 * what `greplost impact src/foo.ts` means in the repo you are standing in.
 */

import path from "node:path";

import { stableStringify } from "@greplost/core/schema";

import { findWorkspaceRoot } from "./config.ts";
import { buildWorkspace, verifyWorkspace } from "./build.ts";
import { impactAcross } from "./impact.ts";

export {
  ID_SEPARATOR,
  WORKSPACE_ARTIFACTS,
  WORKSPACE_FILE,
  findWorkspaceRoot,
  loadWorkspace,
  repoDirId,
  splitWorkspaceId,
  workspaceId,
} from "./config.ts";
export type { WorkspaceConfig } from "./config.ts";

export { crossEdges, readRepo } from "./cross.ts";
export type { CrossEdge, RepoView, ResolvedCross } from "./cross.ts";

export { renderCross, renderWorkspace } from "./render.ts";
export type { RepoSummary, WorkspaceRender } from "./render.ts";

export { buildWorkspace, renderArtifacts, verifyWorkspace } from "./build.ts";
export type { BuildWorkspaceOptions, WorkspaceBuild } from "./build.ts";

export { impactAcross, readWorkspaceRepos, workspacePairs } from "./impact.ts";
export type { ImpactedFile } from "./impact.ts";

// ---------------------------------------------------------------------------
// CLI seam
// ---------------------------------------------------------------------------

export type WorkspaceHookName = "update" | "verify" | "impact";

/**
 * What a hook is handed. A structural subset of the CLI's `CommandContext`:
 * declaring it rather than importing it keeps `@greplost/workspace` free of a
 * dependency on the package that depends on it.
 */
export interface WorkspaceCommandContext {
  /** Absolute root the command resolved, from `--root` or discovery. */
  root: string;
  json: boolean;
  operands: string[];
  options: {
    depth?: number;
    mode?: "incremental" | "full";
    diff?: boolean;
    quiet?: boolean;
  };
}

/** Returns an exit code when it handled the command, `undefined` to fall through. */
export type WorkspaceHook = (ctx: WorkspaceCommandContext) => Promise<number | undefined>;

export type SetWorkspaceHook = (name: WorkspaceHookName, hook: WorkspaceHook) => void;

/** The `--json` shape of `greplost update` in workspace mode. */
export interface WorkspaceUpdateResult {
  name: string;
  repos: Array<{ dir: string; name: string; packages: string[]; files: number }>;
  /** Number of cross-repo import edges. */
  cross: number;
  /** Workspace-relative artifact paths whose bytes changed, sorted. */
  written: string[];
}

/** The `--json` shape of `greplost impact` in workspace mode; ids are `<repo>::<file>`. */
export interface WorkspaceImpactResult {
  path: string;
  /** The full reverse closure, never truncated by `--depth`. */
  radius: number;
  files: Array<{ path: string; depth: number }>;
}

/** Called by the CLI with its hook setter. Registers the three workspace-aware commands. */
export function registerWorkspaceHooks(set: SetWorkspaceHook): void {
  set("update", updateHook);
  set("verify", verifyHook);
  set("impact", impactHook);
}

/**
 * The workspace root this command is *at*, or `null`.
 *
 * Equality rather than "is inside a workspace": see the module comment. The
 * comparison is between two `path.resolve`d strings, which is how the CLI
 * produced `ctx.root` in the first place.
 */
function workspaceRootFor(ctx: WorkspaceCommandContext): string | null {
  const root = path.resolve(ctx.root);
  const found = findWorkspaceRoot(root);
  return found === root ? found : null;
}

const updateHook: WorkspaceHook = async (ctx) => {
  const root = workspaceRootFor(ctx);
  if (root === null) return undefined;

  const build = await buildWorkspace(root, ctx.options.mode === undefined ? {} : { mode: ctx.options.mode });
  const result: WorkspaceUpdateResult = {
    name: build.name,
    repos: build.repos,
    cross: build.cross.length,
    written: build.written,
  };

  if (ctx.json) {
    printJson(result);
    return 0;
  }
  if (ctx.options.quiet !== true) {
    const files = build.repos.reduce((total, repo) => total + repo.files, 0);
    const wrote = build.written.length === 0 ? "no changes" : build.written.join(", ");
    console.log(
      `greplost: ${count(build.repos.length, "repo")}, ${count(files, "file")}, ` +
        `${count(build.cross.length, "cross-repo import")}; ${wrote}`,
    );
  }
  return 0;
};

const verifyHook: WorkspaceHook = async (ctx) => {
  const root = workspaceRootFor(ctx);
  if (root === null) return undefined;

  const result = await verifyWorkspace(root, { diff: ctx.options.diff === true });

  if (ctx.json) {
    printJson(result);
    return result.ok ? 0 : 1;
  }
  if (result.ok) {
    console.log("greplost: workspace map is in sync");
    return 0;
  }

  console.log(
    `greplost: workspace map is out of date (${result.changed.length} changed, ` +
      `${result.missing.length} missing, ${result.extra.length} extra)`,
  );
  console.log("");
  const rows = [
    ...result.changed.map((file) => ["changed", file]),
    ...result.missing.map((file) => ["missing", file]),
    ...result.extra.map((file) => ["extra", file]),
  ];
  for (const line of table(undefined, rows)) console.log(line);
  if (result.diff !== undefined) {
    console.log("");
    console.log(result.diff);
  }
  return 1;
};

const impactHook: WorkspaceHook = async (ctx) => {
  const root = workspaceRootFor(ctx);
  if (root === null) return undefined;

  const target = ctx.operands[0];
  if (target === undefined) return undefined;

  const reached = impactAcross(root, target);
  const depth = ctx.options.depth;
  const shown = depth === undefined ? reached : reached.filter((file) => file.depth <= depth);
  const result: WorkspaceImpactResult = {
    path: target,
    radius: reached.length,
    files: shown.map((file) => ({ path: file.id, depth: file.depth })),
  };

  if (ctx.json) {
    printJson(result);
    return 0;
  }

  const capped = depth !== undefined && shown.length < reached.length ? `, showing depth <= ${depth}` : "";
  console.log(`${result.path}  blast radius ${result.radius}${capped}`);
  if (result.files.length === 0) {
    console.log("");
    console.log("nothing imports it");
    return 0;
  }
  console.log("");
  for (const line of table(["DEPTH", "FILE"], result.files.map((file) => [String(file.depth), file.path]))) {
    console.log(line);
  }
  return 0;
};

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

/** `--json` output: the documented shape, key-sorted, and nothing else on stdout. */
function printJson(value: unknown): void {
  console.log(stableStringify(value, 2));
}

/** Left-aligned columns, two spaces apart. Empty input renders nothing. */
function table(headers: readonly string[] | undefined, rows: readonly string[][]): string[] {
  const all = headers === undefined ? rows : [[...headers], ...rows];
  if (all.length === 0) return [];

  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return all.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}
