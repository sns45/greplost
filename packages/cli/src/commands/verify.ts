/**
 * `greplost verify [--diff]` (tech spec 7.3, 9).
 *
 * The merge gate. `@greplost/sync` rebuilds the structure layer in memory and
 * compares bytes; this command's whole job is to turn that into an exit code CI
 * can act on and a diff a human can act on, and to write nothing at all.
 */

import { verify } from "@greplost/sync";
import type { VerifyResult } from "@greplost/sync";

import type { CommandContext } from "../args.ts";
import { printJson, printLine, table } from "../output.ts";
import { dispatchWorkspace } from "./workspace.ts";

export async function run(ctx: CommandContext): Promise<number> {
  const handled = await dispatchWorkspace("verify", ctx);
  if (handled !== undefined) return handled;

  const result = await verify(ctx.root, { diff: ctx.options.diff === true });

  if (ctx.json) {
    printJson(result);
    return result.ok ? 0 : 1;
  }

  if (result.ok) {
    printLine("greplost: map is in sync");
    return 0;
  }

  printLine(
    `greplost: map is out of date (${result.changed.length} changed, ` +
      `${result.missing.length} missing, ${result.extra.length} extra)`,
  );
  printLine();
  for (const line of table(undefined, rowsOf(result))) printLine(line);
  if (result.diff !== undefined) {
    printLine();
    printLine(result.diff);
  }
  return 1;
}

/** One row per divergent artifact, in the order a reader wants to fix them. */
function rowsOf(result: VerifyResult): string[][] {
  return [
    ...result.changed.map((path) => ["changed", path]),
    ...result.missing.map((path) => ["missing", path]),
    ...result.extra.map((path) => ["extra", path]),
  ];
}
