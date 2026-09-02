/**
 * The workspace seam (workspace spec, "CLI integration").
 *
 * `update`, `verify` and `impact` are the three commands whose answer changes
 * when the checkout is one repo of a multi-repo workspace. Rather than let the
 * workspace leaf reach into their logic, each of them offers this: an optional
 * function, registered by `@greplost/workspace`, that runs first and either
 * answers (returning an exit code) or declines (returning `undefined`, meaning
 * "this is a plain single repo, carry on").
 *
 * Declining rather than being asked is deliberate: only the workspace package
 * knows what `findWorkspaceRoot` says, and the CLI must keep working, with no
 * behaviour change at all, while that package is still a stub.
 *
 * Registration is pulled rather than pushed: the CLI asks `@greplost/workspace`
 * for a `registerWorkspaceHooks(setWorkspaceHook)` export once, lazily, and a
 * package that does not have one (today's stub) simply registers nothing.
 */

import type { CommandContext } from "../args.ts";

export type WorkspaceHookName = "update" | "verify" | "impact";

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

/** What every command says when the optional workspace package is not present. */
export const WORKSPACE_UNAVAILABLE = "workspace layer not available in this build";

/**
 * The second seam: `greplost init --workspace`. `@greplost/workspace` may
 * export this to own the multi-repo build; the CLI only decides that the flag
 * was given and hands over the root.
 */
export type WorkspaceInit = (root: string, opts: { hooks?: boolean; json?: boolean }) => Promise<number>;

/** The workspace package's `initWorkspace`, or `undefined` when it is not in this build. */
export async function loadWorkspaceInit(): Promise<WorkspaceInit | undefined> {
  try {
    const module = (await import("@greplost/workspace")) as Record<string, unknown>;
    const init = module["initWorkspace"];
    return typeof init === "function" ? (init as WorkspaceInit) : undefined;
  } catch {
    return undefined;
  }
}

let loading: Promise<void> | null = null;

/** Ask `@greplost/workspace` to register its hooks, at most once per process. */
export function loadWorkspaceHooks(): Promise<void> {
  if (loading === null) loading = importWorkspace();
  return loading;
}

async function importWorkspace(): Promise<void> {
  try {
    const module = (await import("@greplost/workspace")) as Record<string, unknown>;
    const register = module["registerWorkspaceHooks"];
    if (typeof register === "function") {
      (register as (set: typeof setWorkspaceHook) => void)(setWorkspaceHook);
    }
  } catch {
    // Not installed, or it threw on load: single-repo mode is the correct
    // fallback and a workspace failure must never break `greplost verify`.
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
