/**
 * `greplost refresh [pkg] [--model <m>] [--dry-run]` (tech spec 6, 9).
 *
 * The semantic layer is optional, so this command is a seam rather than an
 * implementation: it asks `@greplost/semantic` for the entry point below and
 * delegates to it, and when there is none, a build that shipped without the
 * package, it says so in one line and exits 1. Nothing here has an opinion
 * about how summaries are produced; that is the semantic leaf's contract:
 *
 *   refreshCommand(root: string, opts: {
 *     package?: string; model?: string; dryRun?: boolean; json?: boolean;
 *   }): Promise<number>   // process exit code; owns its own output
 *
 * The export is `refreshCommand` rather than `refresh` because the package has
 * both, and they are not the same function: `refresh` is the library call and
 * answers with a `RefreshResult` (and throws), while `refreshCommand` is this
 * shape, an exit code, its own output, no exceptions. Looking up the wrong one
 * would "work" right up until the CLI returned an object as its exit status.
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

/**
 * The same run, decided but not printed, what `update --semantic` needs.
 *
 * `refreshCommand` owns its output, which is right for `greplost refresh` and
 * wrong for a command that has a result of its own: two writers meant two JSON
 * documents on one stdout. This shape hands the pieces back so one caller can
 * print one envelope.
 */
export interface SemanticOutcome {
  code: number;
  result?: unknown;
  summary?: string;
  warnings: string[];
  error?: string;
}

export type SemanticRefreshOutcome = (root: string, opts: SemanticRefreshOptions) => Promise<SemanticOutcome>;

/** What every command says when the optional semantic package is not present. */
export const SEMANTIC_UNAVAILABLE = "semantic layer not available in this build";

/** The named export this command delegates to. */
export const SEMANTIC_ENTRY = "refreshCommand";

/** The named export `update --semantic` delegates to. */
export const SEMANTIC_OUTCOME_ENTRY = "refreshOutcome";

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
  return loadSemanticExport<SemanticRefresh>(SEMANTIC_ENTRY);
}

/** The semantic package's `refreshOutcome`, or `undefined` when it is not in this build. */
export async function loadRefreshOutcome(): Promise<SemanticRefreshOutcome | undefined> {
  return loadSemanticExport<SemanticRefreshOutcome>(SEMANTIC_OUTCOME_ENTRY);
}

async function loadSemanticExport<T>(name: string): Promise<T | undefined> {
  try {
    const module = (await import("@greplost/semantic")) as Record<string, unknown>;
    const entry = module[name];
    return typeof entry === "function" ? (entry as T) : undefined;
  } catch {
    return undefined;
  }
}
