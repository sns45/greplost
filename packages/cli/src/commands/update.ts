/**
 * `greplost update [--incremental|--full] [--files <p>...] [--quiet]`
 * (tech spec 8, 9).
 *
 * A thin wrapper by design: `@greplost/sync` owns the lock, the dirty queue,
 * the parse cache and the byte-comparing write, and prints its own one-line
 * summary. The CLI adds only the two things a process boundary needs: the
 * mode default and the guarantee that `--json` puts the result object on stdout
 * and nothing else, which is why it forces the summary off.
 */

import { update } from "@greplost/sync";
import type { UpdateOptions } from "@greplost/sync";

import type { CommandContext } from "../args.ts";
import { printError, printJson } from "../output.ts";
import { SEMANTIC_UNAVAILABLE, loadRefresh } from "./refresh.ts";
import { dispatchWorkspace } from "./workspace.ts";

export async function run(ctx: CommandContext): Promise<number> {
  const handled = await dispatchWorkspace("update", ctx);
  if (handled !== undefined) return handled;

  // Checked before any work: `--semantic` on a build without the semantic
  // package should say so and change nothing, rather than rebuild the map and
  // then fail, which reads like the update itself went wrong.
  const refresh = ctx.options.semantic === true ? await loadRefresh() : undefined;
  if (ctx.options.semantic === true && refresh === undefined) {
    printError(SEMANTIC_UNAVAILABLE);
    return 1;
  }

  const result = await update(ctx.root, updateOptions(ctx));
  if (ctx.json) printJson(result);
  if (refresh === undefined) return 0;

  return refresh(ctx.root, { ...(ctx.json ? { json: true } : {}) });
}

function updateOptions(ctx: CommandContext): UpdateOptions {
  const quiet = ctx.json || ctx.options.quiet === true;
  return {
    mode: ctx.options.mode ?? "incremental",
    ...(ctx.options.files === undefined ? {} : { files: ctx.options.files }),
    ...(quiet ? { quiet: true } : {}),
  };
}
