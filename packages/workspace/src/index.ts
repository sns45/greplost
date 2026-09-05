/**
 * Public surface of `@greplost/workspace`, and the CLI seam.
 *
 * Two audiences. Anything embedding the workspace layer gets
 * `findWorkspaceRoot`, `loadWorkspace`, `buildWorkspace`, `verifyWorkspace`,
 * `impactAcross` and `queryAcross`. The `greplost` CLI gets three exports it
 * looks for by name after one lazy import: `registerWorkspaceHooks`, which
 * hands `update`, `verify`, `impact` and `query` first refusal before their
 * ordinary single-repo path; `initWorkspace`, which `init --workspace` calls
 * directly; and `findWorkspaceRoot`, which `init` uses to refuse a plain run at
 * a workspace root.
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
// The CLI prints through exactly these, so a workspace answer and a single-repo
// answer to the same question look the same. They live in `@greplost/render`
// because the CLI cannot be imported from here: it depends on this package.
import { fields, summarise, table } from "@greplost/render";

import { findWorkspaceRoot } from "./config.ts";
import { buildWorkspace, verifyWorkspace } from "./build.ts";
import { impactAcross, readWorkspaceRepos, resolveWorkspaceTarget } from "./impact.ts";
import { queryAcross } from "./query.ts";

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

export { impactAcross, readWorkspaceRepos, resolveWorkspaceTarget, workspacePairs } from "./impact.ts";
export type { ImpactedFile } from "./impact.ts";

export { queryAcross } from "./query.ts";
export type { WorkspaceQueryFile, WorkspaceQueryMatch, WorkspaceQueryResult } from "./query.ts";

// ---------------------------------------------------------------------------
// CLI seam
// ---------------------------------------------------------------------------

export type WorkspaceHookName = "update" | "verify" | "impact" | "query";

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
    /**
     * `update --semantic`. Not a flag the CLI parses today (the semantic layer
     * is leaf 1.6's), but the workspace answer to it is decided: refuse, rather
     * than accept it and refresh nothing.
     */
    semantic?: boolean;
    /** `init --workspace`; read by `initWorkspace`, not by a hook. */
    workspace?: boolean;
    /** `init --no-hooks` sets this to `false`. */
    hooks?: boolean;
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

/** Called by the CLI with its hook setter. Registers the workspace-aware commands. */
export function registerWorkspaceHooks(set: SetWorkspaceHook): void {
  set("update", updateHook);
  set("verify", verifyHook);
  set("impact", impactHook);
  set("query", queryHook);
}

/**
 * `greplost init --workspace` (tech spec 9).
 *
 * Called directly by the CLI's `init`, not through a hook: `init` is the one
 * command where the workspace layer must run *because the user asked for it*,
 * not because of where they are standing. Every member repo gets its own map,
 * its `config.json` and its `.gitignore`, and its git hooks unless `--no-hooks`
 * said otherwise, which is exactly what `greplost init` does per repo, done
 * once for all of them.
 */
export async function initWorkspace(
  root: string,
  opts: { hooks?: boolean; json?: boolean } = {},
): Promise<number> {
  const build = await buildWorkspace(root, { mode: "full", hooks: opts.hooks !== false });
  const result: WorkspaceUpdateResult = {
    name: build.name,
    repos: build.repos,
    cross: build.cross.length,
    written: build.written,
  };

  if (opts.json === true) {
    printJson(result);
    return 0;
  }
  console.log(
    `greplost: initialised workspace "${build.name}" ` +
      `(${count(build.repos.length, "repo")}, ${count(build.cross.length, "cross-repo import")})`,
  );
  for (const repo of build.repos) {
    console.log(`  ${repo.dir}  ${repo.name}  ${count(repo.files, "file")}`);
  }
  return 0;
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

  // The semantic layer is per repo: it holds a summary cache under each repo's
  // `.greplost/cache/`, and there is no workspace-level thing to refresh.
  // Accepting the flag here and refreshing nothing is the failure mode worth
  // ruling out, so it is refused rather than ignored.
  // Exit 2, not a thrown error: the command line was wrong and nothing ran,
  // which is exactly what the CLI's usage code means.
  if (ctx.options.semantic === true) {
    console.error("greplost: --semantic is not supported at a workspace root; run greplost refresh inside each repo");
    return 2;
  }

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

  const argument = ctx.operands[0];
  if (argument === undefined) return undefined;

  // Report the canonical id, not the argument as typed: an agent may well have
  // passed the absolute path it just read, and echoing that back would put a
  // machine-specific path in a `--json` answer. The single-repo command
  // normalises its `path` field the same way.
  const target = resolveWorkspaceTarget(root, argument, readWorkspaceRepos(root)) ?? argument;
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

const queryHook: WorkspaceHook = async (ctx) => {
  const root = workspaceRootFor(ctx);
  if (root === null) return undefined;

  const needle = ctx.operands[0];
  if (needle === undefined) return undefined;

  const result = await queryAcross(root, needle);
  const empty = result.file === undefined && result.matches.length === 0;

  if (ctx.json) {
    printJson(result);
    return empty ? 1 : 0;
  }
  if (empty) {
    console.error(`greplost: no match for "${needle}" in this workspace`);
    return 1;
  }

  if (result.file !== undefined) {
    const file = result.file;
    console.log(file.path);
    for (const line of fields([
      ["package", file.package],
      ["card", file.card],
      ["loc", String(file.loc)],
      ["fan-in", String(file.fanIn)],
      ["fan-out", String(file.fanOut)],
      ["blast", String(file.blast)],
      ["exports", summarise(file.exports, 8)],
      ["imports", summarise(file.imports)],
      ["importers", summarise(file.importers)],
    ])) {
      console.log(line);
    }
  }

  if (result.matches.length > 0) {
    if (result.file !== undefined) console.log("");
    for (const line of table(
      ["NAME", "KIND", "LOCATION", "PACKAGE"],
      result.matches.map((match) => [
        match.name,
        match.kind,
        `${match.file}:${match.span[0]}-${match.span[1]}`,
        match.package,
      ]),
    )) {
      console.log(line);
    }
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

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}
