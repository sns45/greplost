/**
 * The workspace seam (workspace spec, "CLI integration").
 *
 * `update`, `verify`, `impact` and `query` are the commands whose answer changes
 * when the checkout is one repo of a multi-repo workspace. Rather than let the
 * workspace leaf reach into their logic, each of them offers this: an optional
 * function, registered by `@greplost/workspace`, that runs first and either
 * answers (returning an exit code) or declines (returning `undefined`, meaning
 * "this is a plain single repo, carry on").
 *
 * `init` is the exception and takes the other shape: `--workspace` is a user
 * saying which mode they want, so it calls `loadWorkspaceInit` directly rather
 * than offering a hook first refusal.
 *
 * Declining rather than being asked is deliberate: only the workspace package
 * knows what `findWorkspaceRoot` says, and the CLI must keep working, with no
 * behaviour change at all, while that package is still a stub.
 *
 * Registration is pulled rather than pushed: the CLI asks `@greplost/workspace`
 * for a `registerWorkspaceHooks(setWorkspaceHook)` export once, lazily, and a
 * package that does not have one (today's stub) simply registers nothing.
 */

import path from "node:path";

import type { CommandContext } from "../args.ts";

export type WorkspaceHookName = "update" | "verify" | "impact" | "query";

/** `@greplost/workspace`'s `initWorkspace`, used by `init --workspace`. */
export type WorkspaceInit = (root: string, opts: { hooks?: boolean; json?: boolean }) => Promise<number>;

/** Returns an exit code when it handled the command, `undefined` to fall through. */
export type WorkspaceHook = (ctx: CommandContext) => Promise<number | undefined>;

const hooks = new Map<WorkspaceHookName, WorkspaceHook>();

/** Register a workspace implementation of one command. Called by `@greplost/workspace`. */
export function setWorkspaceHook(name: WorkspaceHookName, hook: WorkspaceHook): void {
  hooks.set(name, hook);
}

/** The registered hook for `name`, if any. */
export function workspaceHook(name: WorkspaceHookName): WorkspaceHook | undefined {
  return hooks.get(name);
}

/** Forget every registration. Tests only. */
export function clearWorkspaceHooks(): void {
  hooks.clear();
}

let loading: Promise<Record<string, unknown> | undefined> | null = null;

/** Ask `@greplost/workspace` to register its hooks, at most once per process. */
export async function loadWorkspaceHooks(): Promise<void> {
  await loadWorkspaceModule();
}

/** The workspace module, imported and asked to register at most once per process. */
function loadWorkspaceModule(): Promise<Record<string, unknown> | undefined> {
  if (loading === null) loading = importWorkspace();
  return loading;
}

async function importWorkspace(): Promise<Record<string, unknown> | undefined> {
  try {
    const module = (await import("@greplost/workspace")) as Record<string, unknown>;
    const register = module["registerWorkspaceHooks"];
    if (typeof register === "function") {
      (register as (set: typeof setWorkspaceHook) => void)(setWorkspaceHook);
    }
    return module;
  } catch {
    // Not installed, or it threw on load: single-repo mode is the correct
    // fallback and a workspace failure must never break `greplost verify`.
    return undefined;
  }
}

/**
 * `@greplost/workspace`'s `initWorkspace`, or `undefined` when this build has
 * no workspace layer. Pulled the same lazy way the hooks are, because `init`
 * must keep working in a checkout where that package is still a stub.
 */
export async function loadWorkspaceInit(): Promise<WorkspaceInit | undefined> {
  const module = await loadWorkspaceModule();
  const init = module?.["initWorkspace"];
  return typeof init === "function" ? (init as WorkspaceInit) : undefined;
}

/**
 * True when `dir` is itself a workspace root.
 *
 * Asked of the workspace layer rather than by looking for the file here, so the
 * name of the workspace file lives in exactly one package. A build without the
 * workspace layer answers `false`, which is the right single-repo behaviour.
 */
export async function isWorkspaceRoot(dir: string): Promise<boolean> {
  const module = await loadWorkspaceModule();
  const find = module?.["findWorkspaceRoot"];
  if (typeof find !== "function") return false;
  try {
    return (find as (start: string) => string | null)(dir) === path.resolve(dir);
  } catch {
    return false;
  }
}

/**
 * Give the workspace layer first refusal on `name`. `undefined` means the
 * caller should run its ordinary single-repo path.
 */
export async function dispatchWorkspace(
  name: WorkspaceHookName,
  ctx: CommandContext,
): Promise<number | undefined> {
  await loadWorkspaceHooks();
  const hook = workspaceHook(name);
  return hook === undefined ? undefined : hook(ctx);
}
