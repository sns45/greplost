/**
 * `greplost hook <event>`: the Claude Code plugin transport (leaf 1.4.1).
 *
 * The payload field names (`hook_event_name`, `cwd`, `tool_name`,
 * `tool_input.file_path`) and the output field names (`hookSpecificOutput`,
 * `hookEventName`, `additionalContext`, `permissionDecision`) are the contract
 * with Claude Code itself, checked against the hooks reference for CLI 2.1.258,
 * so they are asserted literally here rather than through a helper.
 *
 * Two properties matter more than any single shape: every event exits 0, and
 * nothing but a decision document ever reaches stdout.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CommandContext } from "../src/args.ts";
import { runHook } from "../src/commands/hook.ts";
import { main } from "../src/main.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const TINY_TS = path.join(repoRoot, "fixtures", "tiny-ts");
const MAIN = path.join(repoRoot, "packages", "cli", "src", "main.ts");

const temporaries: string[] = [];

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function context(root: string, event: string, rootGiven = true): CommandContext {
  return { root, rootGiven, cwd: process.cwd(), json: false, operands: [event], options: {} };
}

async function hook(event: string, payload: unknown, ctx: CommandContext): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]): void => {
    out.push(args.map((a) => String(a)).join(" "));
  };
  console.error = (...args: unknown[]): void => {
    err.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    const code = await runHook(event as never, text, ctx);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-hook-${label}-`));
  cpSync(TINY_TS, dir, { recursive: true });
  temporaries.push(dir);
  return dir;
}

function dirtyLines(root: string): string[] {
  const file = path.join(root, ".greplost", ".dirty");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
}

/** An indexed repo, and one that has never been built. */
let mapped = "";
let bare = "";

beforeAll(async () => {
  mapped = copyFixture("mapped");
  const code = await main(["init", "--no-hooks", "--root", mapped]);
  expect(code).toBe(0);
  bare = copyFixture("bare");
});

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

describe("hook session-start", () => {
  test("injects the INDEX.md pointer when the map exists", async () => {
    const run = await hook(
      "session-start",
      { hook_event_name: "SessionStart", cwd: mapped, source: "startup" },
      context(mapped, "session-start"),
    );
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout.split("\n")).toHaveLength(1);

    const output = JSON.parse(run.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(Object.keys(output)).toEqual(["hookSpecificOutput"]);
    expect(Object.keys(output.hookSpecificOutput).sort()).toEqual(["additionalContext", "hookEventName"]);
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput.additionalContext).toBe(
      "This repo has a greplost map: read .greplost/INDEX.md before exploring; " +
        "use `greplost query`/`impact --json`. Things inside a file (a Terraform resource, a " +
        "Kubernetes object, a workflow job, a build stage) have node ids of the form " +
        "`<file>#<kind>.<name>`, and both commands take one.",
    );
  });

  test("prints nothing when the repo has no map", async () => {
    const run = await hook("session-start", { hook_event_name: "SessionStart", cwd: bare }, context(bare, "session-start"));
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });
});

describe("hook pre-tool-use", () => {
  test("adds the reminder for Grep and Glob, with no permission decision", async () => {
    for (const tool of ["Grep", "Glob"]) {
      const run = await hook(
        "pre-tool-use",
        { hook_event_name: "PreToolUse", cwd: mapped, tool_name: tool, tool_input: { pattern: "Registry" } },
        context(mapped, "pre-tool-use"),
      );
      expect(run.code).toBe(0);
      const output = JSON.parse(run.stdout) as {
        hookSpecificOutput: Record<string, unknown>;
      };
      // Context only: emitting `permissionDecision: "allow"` would take the
      // user's own permission prompt away for every Glob and Grep.
      expect(Object.keys(output.hookSpecificOutput).sort()).toEqual(["additionalContext", "hookEventName"]);
      expect(output.hookSpecificOutput["hookEventName"]).toBe("PreToolUse");
      expect(output.hookSpecificOutput["permissionDecision"]).toBeUndefined();
      expect(output.hookSpecificOutput["additionalContext"]).toBe(
        "greplost: consult .greplost/INDEX.md or `greplost query <symbol> --json` before grepping; " +
          "a node id (`<file>#<kind>.<name>`) works there too.",
      );
    }
  });

  test("never blocks: no output for another tool, or with no map", async () => {
    const other = await hook(
      "pre-tool-use",
      { hook_event_name: "PreToolUse", cwd: mapped, tool_name: "Read", tool_input: { file_path: "x" } },
      context(mapped, "pre-tool-use"),
    );
    expect(other.code).toBe(0);
    expect(other.stdout).toBe("");

    const unmapped = await hook(
      "pre-tool-use",
      { hook_event_name: "PreToolUse", cwd: bare, tool_name: "Grep" },
      context(bare, "pre-tool-use"),
    );
    expect(unmapped.code).toBe(0);
    expect(unmapped.stdout).toBe("");
  });
});

describe("hook post-tool-use", () => {
  test("appends the edited path to the dirty queue and prints nothing", async () => {
    const repo = copyFixture("dirty");
    await main(["init", "--no-hooks", "--root", repo]);

    const edited = path.join(repo, "packages", "core", "src", "retry.ts");
    const run = await hook(
      "post-tool-use",
      {
        hook_event_name: "PostToolUse",
        cwd: repo,
        tool_name: "Edit",
        tool_input: { file_path: edited, old_string: "a", new_string: "b" },
      },
      context(repo, "post-tool-use"),
    );

    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(dirtyLines(repo)).toEqual(["packages/core/src/retry.ts"]);
  });

  test("drops a path outside the repo and a payload with no path", async () => {
    const repo = copyFixture("outside");
    await main(["init", "--no-hooks", "--root", repo]);

    for (const input of [{ file_path: path.join(tmpdir(), "elsewhere.ts") }, { pattern: "x" }, undefined]) {
      const run = await hook(
        "post-tool-use",
        { hook_event_name: "PostToolUse", cwd: repo, tool_name: "Write", tool_input: input },
        context(repo, "post-tool-use"),
      );
      expect(run.code).toBe(0);
      expect(run.stdout).toBe("");
    }
    expect(dirtyLines(repo)).toEqual([]);
  });

  test("records an edit in an initialised repo whose map is not built yet", async () => {
    const repo = copyFixture("initialised");
    mkdirSync(path.join(repo, ".greplost"), { recursive: true });
    const run = await hook(
      "post-tool-use",
      {
        hook_event_name: "PostToolUse",
        cwd: repo,
        tool_name: "Write",
        tool_input: { file_path: path.join(repo, "packages/core/src/bus.ts") },
      },
      context(repo, "post-tool-use"),
    );
    expect(run.code).toBe(0);
    expect(dirtyLines(repo)).toEqual(["packages/core/src/bus.ts"]);
  });

  test("leaves a repo that never opted in untouched", async () => {
    const repo = copyFixture("optout");
    const run = await hook(
      "post-tool-use",
      {
        hook_event_name: "PostToolUse",
        cwd: repo,
        tool_name: "Write",
        tool_input: { file_path: path.join(repo, "packages/core/src/bus.ts") },
      },
      context(repo, "post-tool-use"),
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(existsSync(path.join(repo, ".greplost"))).toBe(false);
  });
});

describe("hook stop", () => {
  test("brings the map up to date, silently", async () => {
    const repo = copyFixture("stop");
    await main(["init", "--no-hooks", "--root", repo]);

    const source = path.join(repo, "packages", "core", "src", "retry.ts");
    writeFileSync(source, `${readFileSync(source, "utf8")}\nexport function addedByHookTest(): void {}\n`);

    const run = await hook(
      "stop",
      { hook_event_name: "Stop", cwd: repo, stop_hook_active: false },
      context(repo, "stop"),
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");

    expect(readFileSync(path.join(repo, ".greplost", "manifest.json"), "utf8")).toContain("addedByHookTest");
    expect(await main(["verify", "--root", repo])).toBe(0);
  });

  test("does nothing at all in a repo with no map", async () => {
    const run = await hook("stop", { hook_event_name: "Stop", cwd: bare }, context(bare, "stop"));
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(existsSync(path.join(bare, ".greplost", "manifest.json"))).toBe(false);
  });
});

describe("hook robustness", () => {
  test("malformed and empty stdin still exit 0 with a clean stdout", async () => {
    for (const payload of ["not json at all", "", "[1,2,3]"]) {
      const run = await hook("session-start", payload, context(bare, "session-start"));
      expect(run.code).toBe(0);
      expect(run.stdout).toBe("");
    }
    const broken = await hook("stop", "{", context(bare, "stop"));
    expect(broken.code).toBe(0);
    expect(broken.stderr).toContain("stdin was not JSON");
  });

  test("the payload cwd selects the repo when --root was not given", async () => {
    const run = await hook(
      "session-start",
      { hook_event_name: "SessionStart", cwd: path.join(mapped, "packages", "core", "src") },
      { ...context(repoRoot, "session-start", false) },
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("SessionStart");
  });
});

describe("hook transport", () => {
  test("reads the payload from real stdin and exits 0", () => {
    const payload = JSON.stringify({
      session_id: "test",
      transcript_path: "/dev/null",
      cwd: mapped,
      hook_event_name: "SessionStart",
      source: "startup",
    });

    const run = spawnSync("bun", [MAIN, "hook", "session-start", "--root", mapped], {
      input: payload,
      encoding: "utf8",
      cwd: repoRoot,
    });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    const output = JSON.parse(run.stdout) as { hookSpecificOutput: { hookEventName: string } };
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  test("an unknown event is a usage error, not a broken session", async () => {
    const code = await main(["hook", "SessionStart", "--root", mapped]);
    expect(code).toBe(2);
  });
});
