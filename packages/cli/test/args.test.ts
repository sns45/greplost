/**
 * Argument parsing and root discovery (leaf 1.4.1, plugin-cli spec "CLI contract").
 *
 * Pure functions only: every case here is decided before a command touches the
 * filesystem, which is what lets `main` return 2 for a usage error without
 * having built anything.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { USAGE, findRoot, parseArgs, resolveRoot } from "../src/args.ts";

function ok(argv: string[]) {
  const result = parseArgs(argv);
  if (!result.ok) throw new Error(`expected a parse, got usage error: ${result.message}`);
  return result.command;
}

function fail(argv: string[]): string {
  const result = parseArgs(argv);
  if (result.ok) throw new Error(`expected a usage error, got command ${result.command.name}`);
  return result.message;
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "greplost-args-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("args", () => {
  test("no arguments is a usage error", () => {
    expect(fail([])).toContain("usage");
  });

  test("--help and help select the help command", () => {
    expect(ok(["--help"]).name).toBe("help");
    expect(ok(["-h"]).name).toBe("help");
    expect(ok(["help"]).name).toBe("help");
  });

  test("--version, -v and version select the version command", () => {
    expect(ok(["--version"]).name).toBe("version");
    expect(ok(["-v"]).name).toBe("version");
    expect(ok(["version"]).name).toBe("version");
  });

  test("USAGE lists every command", () => {
    for (const name of [
      "init",
      "update",
      "verify",
      "query",
      "impact",
      "flows",
      "refresh",
      "bench",
      "screenshots",
      "hook",
    ]) {
      expect(USAGE).toContain(`greplost ${name}`);
    }
  });

  test("init takes --no-hooks", () => {
    expect(ok(["init"]).options.hooks).toBeUndefined();
    expect(ok(["init", "--no-hooks"]).options.hooks).toBe(false);
  });

  test("update defaults to incremental and accepts the mode flags", () => {
    expect(ok(["update"]).options.mode).toBe("incremental");
    expect(ok(["update", "--full"]).options.mode).toBe("full");
    expect(ok(["update", "--incremental"]).options.mode).toBe("incremental");
  });

  test("update --files takes one or more paths and stops at the next flag", () => {
    expect(ok(["update", "--files", "a.ts", "b.ts", "--quiet"]).options.files).toEqual(["a.ts", "b.ts"]);
    expect(ok(["update", "--files", "a.ts", "--files", "b.ts"]).options.files).toEqual(["a.ts", "b.ts"]);
    expect(ok(["update", "--files=a.ts"]).options.files).toEqual(["a.ts"]);
    expect(ok(["update", "--quiet"]).options.quiet).toBe(true);
    expect(fail(["update", "--files"])).toContain("--files");
  });

  test("a flag value is never swallowed from the next flag", () => {
    expect(fail(["update", "--files", "--quiet"])).toContain("--files");
    expect(fail(["verify", "--root", "--json"])).toContain("--root");
    expect(fail(["refresh", "--model", "--dry-run"])).toContain("--model");
    // The inline form is unambiguous, so it is honoured verbatim.
    expect(ok(["verify", "--root=--json"]).root).toBe("--json");
  });

  test("verify takes --diff", () => {
    expect(ok(["verify"]).options.diff).toBeUndefined();
    expect(ok(["verify", "--diff"]).options.diff).toBe(true);
  });

  test("query takes exactly one operand", () => {
    expect(ok(["query", "Registry"]).operands).toEqual(["Registry"]);
    expect(fail(["query"])).toContain("query");
    expect(fail(["query", "a", "b"])).toContain("query");
  });

  test("impact takes a path and an integer --depth", () => {
    expect(ok(["impact", "src/a.ts", "--depth", "2"]).options.depth).toBe(2);
    expect(ok(["impact", "src/a.ts", "--depth=3"]).options.depth).toBe(3);
    expect(fail(["impact", "src/a.ts", "--depth", "two"])).toContain("--depth");
    expect(fail(["impact", "src/a.ts", "--depth", "-1"])).toContain("--depth");
    expect(fail(["impact"])).toContain("impact");
  });

  test("flows takes a package name", () => {
    expect(ok(["flows", "@tiny/core"]).operands).toEqual(["@tiny/core"]);
    expect(fail(["flows"])).toContain("flows");
  });

  test("refresh takes an optional package, --model and --dry-run", () => {
    expect(ok(["refresh"]).operands).toEqual([]);
    const cmd = ok(["refresh", "@tiny/core", "--model", "claude-sonnet-5", "--dry-run"]);
    expect(cmd.operands).toEqual(["@tiny/core"]);
    expect(cmd.options.model).toBe("claude-sonnet-5");
    expect(cmd.options.dryRun).toBe(true);
    expect(fail(["refresh", "--model"])).toContain("--model");
  });

  test("bench takes a suite and passes everything after it through untouched", () => {
    const cmd = ok(["bench", "structural", "--gate", "--tier", "S", "--json"]);
    expect(cmd.operands).toEqual(["structural"]);
    expect(cmd.options.passthrough).toEqual(["--gate", "--tier", "S", "--json"]);
    expect(cmd.json).toBe(false);
    expect(ok(["bench", "--root", "/tmp/x", "all"]).root).toBe("/tmp/x");
    expect(fail(["bench"])).toContain("bench");
  });

  test("screenshots takes no operands", () => {
    expect(ok(["screenshots"]).operands).toEqual([]);
    expect(fail(["screenshots", "extra"])).toContain("screenshots");
  });

  test("hook takes one of the four documented events", () => {
    for (const event of ["session-start", "pre-tool-use", "post-tool-use", "stop"]) {
      expect(ok(["hook", event]).operands).toEqual([event]);
    }
    expect(fail(["hook"])).toContain("hook");
    expect(fail(["hook", "SessionStart"])).toContain("SessionStart");
  });

  test("--root and --json parse on every command", () => {
    for (const argv of [
      ["init"],
      ["update"],
      ["verify"],
      ["query", "x"],
      ["impact", "x"],
      ["flows", "p"],
      ["refresh"],
      ["screenshots"],
      ["hook", "stop"],
      ["version"],
    ]) {
      const cmd = ok([...argv, "--root", "/tmp/root", "--json"]);
      expect(cmd.root).toBe("/tmp/root");
      expect(cmd.json).toBe(true);
    }
    expect(ok(["verify", "--root=/tmp/root"]).root).toBe("/tmp/root");
    expect(fail(["verify", "--root"])).toContain("--root");
    expect(fail(["verify", "--json=1"])).toContain("--json");
  });

  test("an unknown flag is a usage error naming the flag", () => {
    expect(fail(["verify", "--nope"])).toContain("--nope");
    expect(fail(["--nope"])).toContain("--nope");
    expect(fail(["query", "x", "-z"])).toContain("-z");
  });

  test("an unknown command is a usage error naming the command", () => {
    expect(fail(["frobnicate"])).toContain("frobnicate");
  });

  test("-- stops flag parsing", () => {
    expect(ok(["query", "--", "--weird"]).operands).toEqual(["--weird"]);
  });

  test("a command flag does not leak to another command", () => {
    expect(fail(["verify", "--full"])).toContain("--full");
    expect(fail(["query", "x", "--diff"])).toContain("--diff");
  });

  test("findRoot walks up to the nearest ancestor holding .greplost/", () => {
    withTempDir((dir) => {
      const nested = path.join(dir, "a", "b", "c");
      mkdirSync(nested, { recursive: true });
      mkdirSync(path.join(dir, "a", ".greplost"), { recursive: true });
      expect(findRoot(nested)).toBe(path.join(dir, "a"));
      expect(findRoot(path.join(dir, "a"))).toBe(path.join(dir, "a"));
    });
  });

  test("findRoot falls back to cwd when no ancestor is indexed", () => {
    withTempDir((dir) => {
      const nested = path.join(dir, "x", "y");
      mkdirSync(nested, { recursive: true });
      expect(findRoot(nested)).toBe(nested);
    });
  });

  test("findRoot ignores a .greplost that is not a directory", () => {
    withTempDir((dir) => {
      const nested = path.join(dir, "n");
      mkdirSync(nested, { recursive: true });
      writeFileSync(path.join(dir, ".greplost"), "not a directory");
      expect(findRoot(nested)).toBe(nested);
    });
  });

  test("resolveRoot resolves an explicit --root against cwd and rejects a non-directory", () => {
    withTempDir((dir) => {
      const nested = path.join(dir, "sub");
      mkdirSync(nested, { recursive: true });
      expect(resolveRoot(dir, "sub")).toBe(nested);
      expect(resolveRoot(dir, nested)).toBe(nested);
      expect(() => resolveRoot(dir, "missing")).toThrow(/not a directory/);
    });
  });
});
