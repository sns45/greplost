/**
 * `greplost` in workspace mode: the CLI seam, end to end (workspace spec
 * "CLI integration", tech spec 4.4 and 9).
 *
 * Every case here runs the real `main([...])` in process against a temp copy of
 * the fixture, because the thing under test is the seam itself: the CLI's lazy
 * `import("@greplost/workspace")`, the hook that answers or declines, and the
 * exit code and bytes a caller actually sees.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// By relative path, not by package specifier: the CLI depends on this package,
// so a `greplost` devDependency here would put a cycle in the manifests to buy
// nothing a test needs (driver ruling 2026-09-03).
import type { CommandContext, CommandOptions } from "../../cli/src/args.ts";
import { main } from "../../cli/src/main.ts";

import { WORKSPACE_ARTIFACTS, buildWorkspace, registerWorkspaceHooks } from "../src/index.ts";
import type { WorkspaceCommandContext, WorkspaceQueryResult } from "../src/index.ts";

/**
 * The seam's contract, checked by the compiler rather than by a comment.
 *
 * `WorkspaceCommandContext` is declared structurally in `src/index.ts` so the
 * workspace package does not depend on the CLI. That is only safe while the
 * CLI's real `CommandContext` is assignable to it: these two lines fail to
 * compile the day a field is renamed or a type narrows on either side, which is
 * the day the hooks would otherwise start reading `undefined` at runtime.
 */
const _contextIsAssignable = (ctx: CommandContext): WorkspaceCommandContext => ctx;
const _optionsAreAssignable = (options: CommandOptions): WorkspaceCommandContext["options"] => options;
void _contextIsAssignable;
void _optionsAreAssignable;

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURE = path.join(repoRoot, "fixtures", "two-repo-workspace");

const temporaries: string[] = [];

/** A temp copy of the two-repo fixture, removed when the file finishes. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-wscli-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  temporaries.push(dir);
  return dir;
}

function emptyDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-wscli-${label}-`));
  temporaries.push(dir);
  return dir;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI in process, capturing both streams. */
async function cli(...argv: string[]): Promise<Run> {
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
    const code = await main(argv);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** Built once: every read-only assertion answers from the same workspace. */
let ws = "";

beforeAll(async () => {
  ws = copyFixture("built");
  await buildWorkspace(ws);
});

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

describe("cli", () => {
  test("impact from the workspace root answers across repos", async () => {
    const run = await cli("impact", "repo-a::src/index.ts", "--root", ws, "--json");
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      path: "repo-a::src/index.ts",
      radius: 2,
      files: [
        { path: "repo-b::src/main.ts", depth: 1 },
        { path: "repo-b::src/app.ts", depth: 2 },
      ],
    });
  });

  test("impact --depth truncates the listing, never the radius", async () => {
    const run = await cli("impact", "repo-a::src/index.ts", "--depth", "1", "--root", ws, "--json");
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout) as { radius: number; files: unknown[] };
    expect(result.radius).toBe(2);
    expect(result.files).toEqual([{ path: "repo-b::src/main.ts", depth: 1 }]);
  });

  test("impact prints a table without --json", async () => {
    const run = await cli("impact", "repo-a::src/index.ts", "--root", ws);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("repo-a::src/index.ts  blast radius 2");
    expect(run.stdout).toContain("repo-b::src/main.ts");
  });

  test("verify reports the whole workspace", async () => {
    const run = await cli("verify", "--root", ws, "--json");
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ ok: true, changed: [], missing: [], extra: [] });
  });

  test("update builds every repo and the workspace artifacts", async () => {
    const fresh = copyFixture("cliupdate");
    const run = await cli("update", "--root", fresh, "--json");
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout) as { name: string; cross: number; written: string[] };
    expect(result.name).toBe("two-repo");
    expect(result.cross).toBe(1);
    expect(result.written).toEqual([
      `.greplost/${WORKSPACE_ARTIFACTS.workspace}`,
      `.greplost/${WORKSPACE_ARTIFACTS.cross}`,
    ]);
    expect((await cli("verify", "--root", fresh, "--json")).code).toBe(0);
  });

  test("update --full rebuilds every repo", async () => {
    const full = copyFixture("clifull");
    expect((await cli("update", "--full", "--root", full)).code).toBe(0);
    const run = await cli("update", "--full", "--root", full, "--json");
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout) as { written: string[] };
    expect(result.written).toEqual([]);
  });

  test("update without --json prints one summary line", async () => {
    const summary = copyFixture("clisummary");
    const run = await cli("update", "--root", summary);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("greplost: 2 repos, 4 files, 1 cross-repo import;");
  });

  test("verify --diff shows the first divergent artifact after drift", async () => {
    const drift = copyFixture("clidiff");
    await buildWorkspace(drift);
    writeFileSync(path.join(drift, ".greplost", WORKSPACE_ARTIFACTS.cross), "");

    const run = await cli("verify", "--diff", "--root", drift);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(`changed  .greplost/${WORKSPACE_ARTIFACTS.cross}`);
    expect(run.stdout).toContain(`--- a/.greplost/${WORKSPACE_ARTIFACTS.cross}`);
  });

  test("a workspace root that is also an indexed repo fails loudly", async () => {
    const both = copyFixture("cliboth");
    await buildWorkspace(both);
    mkdirSync(path.join(both, ".greplost"), { recursive: true });
    writeFileSync(path.join(both, ".greplost", "manifest.json"), "{}\n");

    const run = await cli("verify", "--root", both);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("both a workspace root and an indexed repository");
  });

  test("query answers from every repo, ids prefixed", async () => {
    const run = await cli("query", "hello", "--root", ws, "--json");
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);

    const result = JSON.parse(run.stdout) as WorkspaceQueryResult;
    expect(result.query).toBe("hello");
    expect(result.matches.map((match) => match.id)).toEqual(["repo-a::src/index.ts#hello"]);
    const only = result.matches[0];
    expect(only?.file).toBe("repo-a::src/index.ts");
    expect(only?.package).toBe("@fx/a");
    expect(only?.card).toBe("repo-a::packages/fx__a/modules/src/index.ts.md");
    expect(only?.kind).toBe("function");
    expect(only?.exported).toBe(true);
  });

  test("query finds a symbol declared in the other repo", async () => {
    const run = await cli("query", "start", "--root", ws, "--json");
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout) as WorkspaceQueryResult;
    expect(result.matches.map((match) => match.id)).toEqual(["repo-b::src/app.ts#start"]);
  });

  test("query on a workspace file id lists its cross-repo importers", async () => {
    const run = await cli("query", "repo-a::src/index.ts", "--root", ws, "--json");
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout) as WorkspaceQueryResult;
    expect(result.file?.path).toBe("repo-a::src/index.ts");
    expect(result.file?.importers).toEqual(["repo-b::src/main.ts"]);
    expect(result.file?.imports).toEqual(["repo-a::src/greet.ts"]);
    // `Greeting` is re-exported by this file, not declared in it.
    expect(result.matches.map((match) => match.name)).toEqual(["hello"]);
  });

  test("query prints a table without --json, and exits 1 on no match", async () => {
    const found = await cli("query", "hello", "--root", ws);
    expect(found.code).toBe(0);
    expect(found.stdout).toContain("repo-a::src/index.ts:6-9");

    const missing = await cli("query", "nosuchsymbol", "--root", ws, "--json");
    expect(missing.code).toBe(1);
    expect((JSON.parse(missing.stdout) as WorkspaceQueryResult).matches).toEqual([]);
  });

  test("impact accepts a workspace-relative, absolute or cwd-relative path", async () => {
    const expected = {
      path: "repo-a::src/index.ts",
      radius: 2,
      files: [
        { path: "repo-b::src/main.ts", depth: 1 },
        { path: "repo-b::src/app.ts", depth: 2 },
      ],
    };

    for (const argument of ["repo-a/src/index.ts", path.join(ws, "repo-a", "src", "index.ts")]) {
      const run = await cli("impact", argument, "--root", ws, "--json");
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual(expected);
    }

    // Relative to the process cwd rather than to the workspace root.
    const cwd = process.cwd();
    process.chdir(path.join(ws, "repo-a"));
    try {
      const run = await cli("impact", "src/index.ts", "--root", ws, "--json");
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual(expected);
    } finally {
      process.chdir(cwd);
    }
  });

  test("init --workspace builds every repo, and plain init refuses", async () => {
    const fresh = copyFixture("cliinit");
    const run = await cli("init", "--workspace", "--root", fresh, "--json");
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as { name: string; cross: number }).name).toBe("two-repo");
    expect(existsSync(path.join(fresh, "repo-a", ".greplost", "manifest.json"))).toBe(true);
    expect((await cli("verify", "--root", fresh, "--json")).code).toBe(0);

    // Both refusals are usage errors (exit 2): the command line and the
    // checkout disagreed, and nothing ran.
    const plain = await cli("init", "--root", copyFixture("cliinitplain"));
    expect(plain.code).toBe(2);
    expect(plain.stderr).toContain("greplost init --workspace");

    const notAWorkspace = await cli("init", "--workspace", "--root", emptyDir("cliinitnone"));
    expect(notAWorkspace.code).toBe(2);
    expect(notAWorkspace.stderr).toContain("--workspace needs a greplost.workspace.json");
  });

  test("init --workspace --no-hooks prints a human summary", async () => {
    const fresh = copyFixture("cliinithuman");
    const run = await cli("init", "--workspace", "--no-hooks", "--root", fresh);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('greplost: initialised workspace "two-repo" (2 repos, 1 cross-repo import)');
    expect(run.stdout).toContain("repo-a  @fx/a  2 files");
  });

  test("update --semantic is refused at a workspace root", async () => {
    const registered = new Map<string, (ctx: WorkspaceCommandContext) => Promise<number | undefined>>();
    registerWorkspaceHooks((name, hook) => registered.set(name, hook));
    const update = registered.get("update");
    expect(update).toBeDefined();

    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]): void => {
      errors.push(args.map((a) => String(a)).join(" "));
    };
    let code: number | undefined;
    try {
      code = await (update as (ctx: WorkspaceCommandContext) => Promise<number | undefined>)({
        root: ws,
        json: false,
        operands: [],
        options: { semantic: true },
      });
    } finally {
      console.error = error;
    }
    expect(code).toBe(2);
    expect(errors.join("\n")).toBe(
      "greplost: --semantic is not supported at a workspace root; run greplost refresh inside each repo",
    );
  });

  test("a single repo inside the workspace still answers for itself", async () => {
    const run = await cli("impact", "src/index.ts", "--root", path.join(ws, "repo-a"), "--json");
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ path: "src/index.ts", radius: 0, files: [] });
  });
});
