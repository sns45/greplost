/**
 * `greplost --version`.
 *
 * The version comes from the package manifest next to the source, imported
 * rather than read, so the bundler inlines it and the published binary reports
 * the version it was built from even though `dist/` holds no manifest.
 */

import type { CommandContext } from "../args.ts";
import { VERSION, printJson, printLine } from "../output.ts";

export async function run(ctx: CommandContext): Promise<number> {
  if (ctx.json) printJson({ name: "greplost", version: VERSION });
  else printLine(`greplost ${VERSION}`);
  return 0;
}
