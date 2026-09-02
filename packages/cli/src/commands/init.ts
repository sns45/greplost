/**
 * `greplost init [--no-hooks]` (tech spec 7.2, 9).
 *
 * Config, gitignore, a full build, git hooks. `@greplost/sync` makes all four
 * idempotent, so this is the command to re-run when you are not sure what state
 * a checkout is in.
 *
 * `--json` prints the *update* result, not init's own bookkeeping: the
 * documented shape for `init` and `update` is the same object, so a caller can
 * treat "make the map current" as one operation whichever command produced it.
 */

import { init } from "@greplost/sync";

import type { CommandContext } from "../args.ts";
import { printJson, printLine } from "../output.ts";
import { isWorkspaceRoot, loadWorkspaceInit } from "./workspace.ts";

export async function run(ctx: CommandContext): Promise<number> {
  const workspace = await isWorkspaceRoot(ctx.root);

  // `--workspace` is the one place the workspace layer runs because the user
  // asked for it rather than because of where they are standing, so both halves
  // of the mismatch are refused: the flag without a workspace file, and a
  // workspace file without the flag. The second matters most — a plain `init`
  // here would write a repo map into the directory that owns the workspace's
  // own `.greplost/graph/`, and the two cannot share it.
  if (ctx.options.workspace === true) {
    if (!workspace) {
      throw new Error("--workspace needs a greplost.workspace.json in the root; there is none here");
    }
    const initWorkspace = await loadWorkspaceInit();
    if (initWorkspace === undefined) {
      throw new Error("workspace mode is not available in this build");
    }
    return initWorkspace(ctx.root, {
      ...(ctx.options.hooks === false ? { hooks: false } : {}),
      ...(ctx.json ? { json: true } : {}),
    });
  }
  if (workspace) {
    throw new Error("this is a greplost workspace root; run `greplost init --workspace`");
  }

  const result = await init(ctx.root, {
    ...(ctx.options.hooks === false ? { hooks: false } : {}),
    ...(ctx.json ? { quiet: true } : {}),
  });

  if (ctx.json) {
    printJson(result.update);
    return 0;
  }

  if (result.created.length > 0) printLine(`greplost: created ${result.created.join(", ")}`);
  if (result.hooks.length > 0) printLine(`greplost: installed git hooks ${result.hooks.join(", ")}`);
  return 0;
}
