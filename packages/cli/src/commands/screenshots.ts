/**
 * `greplost screenshots` (tech spec 9, 11).
 *
 * The same delegation as `bench`, pinned to one suite: it regenerates
 * `docs/assets/*` from the harness and is only ever run inside the repository.
 */

import type { CommandContext } from "../args.ts";
import { delegateToBench } from "./bench.ts";

export async function run(_ctx: CommandContext): Promise<number> {
  return delegateToBench(["screenshots"]);
}
