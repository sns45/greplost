/**
 * Public surface of the `greplost` package.
 *
 * Two audiences: `main` for anything that wants to run the CLI in-process
 * (`bin/greplost.js`, the tests, an embedding harness), and the workspace seam
 * for `@greplost/workspace`, which registers its own `update`, `verify` and
 * `impact` implementations rather than being wired into their logic.
 *
 * The `--json` result types are exported too, so a consumer parsing the
 * documented shapes can hold the CLI to them at compile time.
 */

export { main } from "./main.ts";

export { USAGE, findRoot, parseArgs, resolveRoot } from "./args.ts";
export type { CommandContext, CommandName, CommandOptions, HookEvent, ParseResult, ParsedCommand } from "./args.ts";

export { setWorkspaceHook, workspaceHook } from "./commands/workspace.ts";
export type { WorkspaceHook, WorkspaceHookName } from "./commands/workspace.ts";

export type { QueryFile, QueryMatch, QueryResult } from "./commands/query.ts";
export type { ImpactResult } from "./commands/impact.ts";
export type { FlowsResult } from "./commands/flows.ts";
export type { HookPayload } from "./commands/hook.ts";
export type { SemanticUpdateEnvelope } from "./commands/update.ts";
export type {
  SemanticOutcome,
  SemanticRefresh,
  SemanticRefreshOptions,
  SemanticRefreshOutcome,
} from "./commands/refresh.ts";
