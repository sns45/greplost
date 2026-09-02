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
import { printJson } from "../output.ts";
import { dispatchWorkspace } from "./workspace.ts";

export async function run(ctx: CommandContext): Promise<number> {
  const handled = await dispatchWorkspace("update", ctx);
  if (handled !== undefined) return handled;

  const result = await update(ctx.root, updateOptions(ctx));
  if (ctx.json) printJson(result);
  return 0;
}

function updateOptions(ctx: CommandContext): UpdateOptions {
  const quiet = ctx.json || ctx.options.quiet === true;
  return {
    mode: ctx.options.mode ?? "incremental",
    ...(ctx.options.files === undefined ? {} : { files: ctx.options.files }),
    ...(quiet ? { quiet: true } : {}),
  };
}
