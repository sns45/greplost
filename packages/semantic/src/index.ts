/**
 * Public surface of `@greplost/semantic` (tech spec 6).
 *
 * The LLM-written layer: module summaries cached by content hash, `FLOWS.md`
 * per package, and the staleness the cards render. Nothing in the structure
 * layer imports this package, and nothing here writes a structure artifact —
 * a repository that never runs `greplost refresh` is still completely
 * navigable (tech spec 4.1).
 *
 * Two entry points, on purpose. `refresh` is the library call: it reports what
 * it did and throws what went wrong. `refreshCommand` is the shape the CLI's
 * seam expects: an exit code, its own output, and no exceptions.
 */

export { DEFAULT_BATCH_SIZE, refresh, refreshCommand } from "./refresh.ts";
export type { RefreshCommandOptions, RefreshOptions, RefreshResult } from "./refresh.ts";

export {
  MAX_ENTRY_POINTS,
  REACH_DEPTH,
  callLines,
  importGraph,
  isoDate,
  reachableFrom,
  renderFlows,
  selectEntryPoints,
} from "./flows.ts";
export type { Flow, FlowStep } from "./flows.ts";

export {
  ENTRY_PREFIX,
  FILE_PREFIX,
  FLOWS_TASK,
  HEAD_LINES,
  MAX_FLOWS,
  MIN_FLOWS,
  SUMMARY_TASK,
  buildFlowsPrompt,
  buildSummaryPrompt,
  parseFlowsResponse,
  parseSummaryResponse,
} from "./prompts.ts";
export type { FlowRequest, SummaryRequest } from "./prompts.ts";

export { RUNNER_COMMAND, defaultRunner } from "./runner.ts";
export type { DefaultRunnerOptions, PromptRunner } from "./runner.ts";
