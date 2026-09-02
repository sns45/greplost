/**
 * `greplost update [--incremental|--full] [--files <p>...] [--semantic] [--quiet]`
 * (tech spec 8, 9).
 *
 * A thin wrapper by design: `@greplost/sync` owns the lock, the dirty queue,
 * the parse cache and the byte-comparing write, and prints its own one-line
 * summary. The CLI adds only the two things a process boundary needs: the
 * mode default and the guarantee that `--json` puts the result object on stdout
 * and nothing else, which is why it forces the summary off.
 *
 * `--semantic` is the one place that costs a paragraph. Two results come out of
 * one command, and `--json` output must stay a single parseable document, so
 * this command does the printing for both:
 *
 *     { "update": <UpdateResult>, "refresh": <RefreshResult> }
 *
 * That is why it asks `@greplost/semantic` for `refreshOutcome` (the run, with
 * the printing lifted out) rather than `refreshCommand` (the run, which prints
 * its own document). A refresh that failed has no result, so the envelope is
 * `{ "update": … }` alone and the reason is on stderr with the exit code.
 */

import { update } from "@greplost/sync";
import type { UpdateOptions, UpdateResult } from "@greplost/sync";

import type { CommandContext } from "../args.ts";
import { printError, printJson, printLine } from "../output.ts";
import { SEMANTIC_UNAVAILABLE, loadRefreshOutcome } from "./refresh.ts";
import { dispatchWorkspace } from "./workspace.ts";

/** The `--json` shape of `greplost update --semantic`. */
export interface SemanticUpdateEnvelope {
  update: UpdateResult;
  /** The `RefreshResult`; absent when the refresh failed. */
  refresh?: unknown;
}

export async function run(ctx: CommandContext): Promise<number> {
  const handled = await dispatchWorkspace("update", ctx);
  if (handled !== undefined) return handled;

  // Checked before any work: `--semantic` on a build without the semantic
  // package should say so and change nothing, rather than rebuild the map and
  // then fail, which reads like the update itself went wrong.
  const refresh = ctx.options.semantic === true ? await loadRefreshOutcome() : undefined;
  if (ctx.options.semantic === true && refresh === undefined) {
    printError(SEMANTIC_UNAVAILABLE);
    return 1;
  }

  const result = await update(ctx.root, updateOptions(ctx));
  if (refresh === undefined) {
    if (ctx.json) printJson(result);
    return 0;
  }

  const outcome = await refresh(ctx.root, {});
  if (ctx.json) {
    const envelope: SemanticUpdateEnvelope = {
      update: result,
      ...(outcome.result === undefined ? {} : { refresh: outcome.result }),
    };
    printJson(envelope);
  } else if (outcome.result !== undefined && outcome.summary !== undefined) {
    printLine(outcome.summary);
  }

  for (const line of outcome.warnings) printError(line);
  if (outcome.error !== undefined) printError(outcome.error);
  return outcome.code;
}

function updateOptions(ctx: CommandContext): UpdateOptions {
  const quiet = ctx.json || ctx.options.quiet === true;
  return {
    mode: ctx.options.mode ?? "incremental",
    ...(ctx.options.files === undefined ? {} : { files: ctx.options.files }),
    ...(quiet ? { quiet: true } : {}),
  };
}
