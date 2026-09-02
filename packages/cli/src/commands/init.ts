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
import { printError, printJson, printLine } from "../output.ts";
import { WORKSPACE_UNAVAILABLE, loadWorkspaceInit } from "./workspace.ts";

export async function run(ctx: CommandContext): Promise<number> {
  if (ctx.options.workspace === true) {
    const initWorkspace = await loadWorkspaceInit();
    if (initWorkspace === undefined) {
      printError(WORKSPACE_UNAVAILABLE);
      return 1;
    }
    return initWorkspace(ctx.root, {
      ...(ctx.options.hooks === false ? { hooks: false } : {}),
      ...(ctx.json ? { json: true } : {}),
    });
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
