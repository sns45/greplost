/**
 * `greplost refresh [pkg] [--model <m>] [--dry-run]` (tech spec 6, 9).
 *
 * The semantic layer is optional and, in this build, not yet present. The
 * command therefore exists as a seam rather than a stub: it asks
 * `@greplost/semantic` for a `refresh` export and delegates to it, and when
 * there is none it says so in one line and exits 1. Nothing here has an opinion
 * about how summaries are produced; that is the semantic leaf's contract:
 *
 *   refresh(root: string, opts: {
 *     package?: string; model?: string; dryRun?: boolean; json?: boolean;
 *   }): Promise<number>   // process exit code; owns its own output
 */

import type { CommandContext } from "../args.ts";
import { printError } from "../output.ts";

/** What `@greplost/semantic` must export for `greplost refresh` to work. */
export interface SemanticRefreshOptions {
  package?: string;
  model?: string;
  dryRun?: boolean;
  json?: boolean;
}

export type SemanticRefresh = (root: string, opts: SemanticRefreshOptions) => Promise<number>;

/** What every command says when the optional semantic package is not present. */
export const SEMANTIC_UNAVAILABLE = "semantic layer not available in this build";

export async function run(ctx: CommandContext): Promise<number> {
  const refresh = await loadRefresh();
  if (refresh === undefined) {
    printError(SEMANTIC_UNAVAILABLE);
    return 1;
  }

  const target = ctx.operands[0];
  return refresh(ctx.root, {
    ...(target === undefined ? {} : { package: target }),
    ...(ctx.options.model === undefined ? {} : { model: ctx.options.model }),
    ...(ctx.options.dryRun === true ? { dryRun: true } : {}),
    ...(ctx.json ? { json: true } : {}),
  });
}

/** The semantic package's `refresh`, or `undefined` when it is not in this build. */
export async function loadRefresh(): Promise<SemanticRefresh | undefined> {
  try {
    const module = (await import("@greplost/semantic")) as Record<string, unknown>;
    const refresh = module["refresh"];
    return typeof refresh === "function" ? (refresh as SemanticRefresh) : undefined;
  } catch {
    return undefined;
  }
}
