/**
 * `greplost hook <event>`: the Claude Code plugin transport (tech spec 7.1,
 * plugin-cli spec "hook subcommand").
 *
 * Four events, one process each, driven by `greplost-plugin/hooks/hooks.json`.
 * The payload arrives as JSON on stdin (`hook_event_name`, `cwd`, `tool_name`,
 * `tool_input`, verified against the Claude Code hooks reference for CLI
 * 2.1.258) and the answer, when there is one, is a single line of JSON on
 * stdout.
 *
 * The one rule that outranks every other consideration here: a hook must never
 * break the session it is attached to. So every event returns 0: a malformed
 * payload, an unreadable repo, a failed update and a held lock are all "nothing
 * to say", reported on stderr where Claude Code logs it, never on stdout where
 * it would be parsed as a decision. `PreToolUse` in particular is advisory
 * only: it emits `additionalContext` and no `permissionDecision` at all, so it
 * neither blocks the tool nor takes the user's permission prompt away from
 * them. `permissionDecision: "allow"` would do the latter, which is a bigger
 * decision than "read the map first" has any business making (ruling, fix
 * round 1).
 *
 * `cwd` from the payload wins over the process's own, because Claude Code may
 * run the command from anywhere; an explicit `--root` wins over both.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { ARTIFACT_DIR, ARTIFACT_PATHS, stableStringify } from "@greplost/core/schema";
import { appendDirty, update } from "@greplost/sync";

import type { CommandContext, HookEvent } from "../args.ts";
import { findRoot } from "../args.ts";
import { printError, printLine, readStdin } from "../output.ts";

/** The fields of the hook payload this transport reads. */
export interface HookPayload {
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/** Tools whose reminder `PreToolUse` exists to inject (tech spec 7.1 matcher). */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(["Glob", "Grep"]);

const SESSION_START_CONTEXT =
  "This repo has a greplost map: read .greplost/INDEX.md before exploring; " +
  "use `greplost query`/`impact --json`. Things inside a file (a Terraform resource, a " +
  "Kubernetes object, a workflow job, a build stage) have node ids of the form " +
  "`<file>#<kind>.<name>`, and both commands take one.";

const PRE_TOOL_USE_CONTEXT =
  "greplost: consult .greplost/INDEX.md or `greplost query <symbol> --json` before grepping; " +
  "a node id (`<file>#<kind>.<name>`) works there too.";

export async function run(ctx: CommandContext): Promise<number> {
  const event = ctx.operands[0] as HookEvent;
  let payloadText = "";
  try {
    payloadText = await readStdin();
  } catch (cause) {
    printError(`hook ${event}: cannot read stdin: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return runHook(event, payloadText, ctx);
}

/**
 * The whole hook, given the payload text. Separated from stdin so the transport
 * can be tested without a process, and so `run` has nothing left to get wrong.
 * Always resolves to 0.
 */
export async function runHook(event: HookEvent, payloadText: string, ctx: CommandContext): Promise<number> {
  const payload = parsePayload(payloadText, event);
  const root = hookRoot(ctx, payload);
  const mapped = hasMap(root);

  try {
    switch (event) {
      case "session-start":
        if (mapped) emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: SESSION_START_CONTEXT } });
        return 0;

      case "pre-tool-use": {
        const tool = payload.tool_name;
        if (!mapped) return 0;
        if (tool !== undefined && !SEARCH_TOOLS.has(tool)) return 0;
        emit({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: PRE_TOOL_USE_CONTEXT,
          },
        });
        return 0;
      }

      case "post-tool-use": {
        // Only in a repo that has opted in. The plugin is installed once and
        // fires in every repository the user edits; a hook that created
        // `.greplost/` wherever it happened to run would litter projects that
        // never asked for a map. An initialised repo whose map is not built
        // yet still records the edit, so nothing is lost by opting in early.
        if (!existsSync(path.join(root, ARTIFACT_DIR))) return 0;
        const paths = editedPaths(payload);
        if (paths.length > 0) appendDirty(root, paths);
        return 0;
      }

      case "stop": {
        if (!mapped) return 0;
        await update(root, { mode: "incremental", quiet: true });
        return 0;
      }
    }
  } catch (cause) {
    // Never on stdout: Claude Code parses stdout as the hook's decision.
    printError(`hook ${event}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return 0;
}

/** One line of stable JSON on stdout. */
function emit(value: unknown): void {
  printLine(stableStringify(value));
}

function parsePayload(text: string, event: HookEvent): HookPayload {
  const trimmed = text.trim();
  if (trimmed === "") return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as HookPayload;
  } catch {
    printError(`hook ${event}: stdin was not JSON`);
    return {};
  }
}

/**
 * `--root` if the caller gave one, else the repo holding the payload's `cwd`,
 * else the repo holding this process's cwd.
 */
function hookRoot(ctx: CommandContext, payload: HookPayload): string {
  if (ctx.rootGiven) return ctx.root;
  const cwd = payload.cwd;
  if (typeof cwd === "string" && cwd !== "" && existsSync(cwd)) return findRoot(cwd);
  return ctx.root;
}

/** True when the repo has a built map; every event but `post-tool-use` needs one. */
function hasMap(root: string): boolean {
  return existsSync(path.join(root, ARTIFACT_DIR, ARTIFACT_PATHS.index));
}

/**
 * Paths the tool call touched. Read from `tool_input` regardless of
 * `tool_name`: the dirty queue is conservative in one direction only, and a
 * path recorded that did not change costs a rebuild that writes no bytes,
 * while one that is missed leaves a stale map.
 */
function editedPaths(payload: HookPayload): string[] {
  const input = payload.tool_input;
  if (typeof input !== "object" || input === null) return [];
  const paths: string[] = [];
  for (const key of ["file_path", "notebook_path"]) {
    const value = input[key];
    if (typeof value === "string" && value !== "") paths.push(value);
  }
  return paths;
}
