/**
 * greplost:sync git hook installation tests (leaf 1.3.2, tech spec 7.2).
 *
 * The git hooks are what cover the edits Claude never sees: a rebase, a
 * `git pull`, a branch switch, a commit made from another terminal. They are
 * also the part of greplost that writes into someone else's files, so the bar
 * is: never clobber an existing hook, never install twice, never leave a
 * non-executable hook behind, and do nothing at all outside a git repository.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { HOOK_MARKER, HOOK_NAMES, installGitHooks } from "../src/githooks.ts";

const temporaries: string[] = [];

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

function bareDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-hooks-${label}-`));
  temporaries.push(dir);
  return dir;
}

function gitRepo(label: string): string {
  const dir = bareDir(label);
  const init = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  expect(init.status).toBe(0);
  return dir;
}

function isExecutable(file: string): boolean {
  return (statSync(file).mode & 0o111) !== 0;
}

describe("hooks", () => {
  test("installs all three hooks under .git/hooks, executable and marked", () => {
    const root = gitRepo("plain");

    const result = installGitHooks(root);

    expect(result.mode).toBe("plain");
    expect(result.installed).toEqual([...HOOK_NAMES]);
    for (const hook of HOOK_NAMES) {
      const file = path.join(root, ".git", "hooks", hook);
      const body = readFileSync(file, "utf8");
      expect(body.startsWith("#!/bin/sh\n")).toBe(true);
      expect(body).toContain(HOOK_MARKER);
      expect(body).toContain("greplost");
      expect(body).toContain("update --incremental --quiet");
      // Detached: the hook must not make the user wait for a rebuild.
      expect(body).toContain("&");
      expect(body.endsWith("\n")).toBe(true);
      expect(isExecutable(file)).toBe(true);
    }
  });

  test("is idempotent: a second install changes nothing", () => {
    const root = gitRepo("twice");
    installGitHooks(root);
    const before = HOOK_NAMES.map((hook) => readFileSync(path.join(root, ".git", "hooks", hook), "utf8"));

    const again = installGitHooks(root);

    expect(again.installed).toEqual([]);
    expect(again.mode).toBe("plain");
    expect(again.notes.join(" ")).toContain("already");
    const after = HOOK_NAMES.map((hook) => readFileSync(path.join(root, ".git", "hooks", hook), "utf8"));
    expect(after).toEqual(before);
    // And a third time, so "idempotent" is not just "the second run is quiet".
    installGitHooks(root);
    expect(HOOK_NAMES.map((hook) => readFileSync(path.join(root, ".git", "hooks", hook), "utf8"))).toEqual(before);
  });

  test("appends to an existing hook instead of overwriting it", () => {
    const root = gitRepo("append");
    const file = path.join(root, ".git", "hooks", "post-commit");
    const existing = "#!/bin/sh\necho 'someone else was here'\n";
    writeFileSync(file, existing);
    chmodSync(file, 0o755);

    installGitHooks(root);

    const body = readFileSync(file, "utf8");
    expect(body.startsWith(existing)).toBe(true);
    expect(body).toContain(HOOK_MARKER);
    // No second shebang half way down the file.
    expect(body.split("#!/bin/sh").length - 1).toBe(1);
    expect(isExecutable(file)).toBe(true);
  });

  test("makes an existing but non-executable hook executable", () => {
    const root = gitRepo("chmod");
    const file = path.join(root, ".git", "hooks", "post-merge");
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o644);

    installGitHooks(root);

    expect(isExecutable(file)).toBe(true);
  });

  test("prefers .husky/ when it exists and leaves .git/hooks alone", () => {
    const root = gitRepo("husky");
    mkdirSync(path.join(root, ".husky"), { recursive: true });

    const result = installGitHooks(root);

    expect(result.mode).toBe("husky");
    expect(result.installed).toEqual([...HOOK_NAMES]);
    for (const hook of HOOK_NAMES) {
      const file = path.join(root, ".husky", hook);
      const body = readFileSync(file, "utf8");
      expect(body).toContain(HOOK_MARKER);
      // A husky hook is still a script someone may run by hand.
      expect(body.startsWith("#!/bin/sh\n")).toBe(true);
      expect(isExecutable(file)).toBe(true);
      expect(existsSync(path.join(root, ".git", "hooks", hook))).toBe(false);
    }
  });

  test("appends to an existing husky hook and stays idempotent there too", () => {
    const root = gitRepo("husky-existing");
    mkdirSync(path.join(root, ".husky"), { recursive: true });
    const file = path.join(root, ".husky", "post-commit");
    writeFileSync(file, "npm test\n");

    installGitHooks(root);
    const body = readFileSync(file, "utf8");
    expect(body.startsWith("npm test\n")).toBe(true);
    expect(body).toContain(HOOK_MARKER);

    const again = installGitHooks(root);
    expect(again.installed).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(body);
  });

  test("installs plain hooks alongside lefthook and says so", () => {
    const root = gitRepo("lefthook");
    writeFileSync(path.join(root, "lefthook.yml"), "pre-commit:\n  commands:\n    lint:\n      run: echo\n");

    const result = installGitHooks(root);

    expect(result.mode).toBe("plain");
    expect(result.installed).toEqual([...HOOK_NAMES]);
    expect(result.notes.join(" ")).toContain("lefthook");
  });

  test("does nothing outside a git repository", () => {
    const root = bareDir("nogit");

    const result = installGitHooks(root);

    expect(result.mode).toBe("none");
    expect(result.installed).toEqual([]);
    expect(result.notes.join(" ")).toContain("not a git repository");
    expect(existsSync(path.join(root, ".git"))).toBe(false);
    expect(existsSync(path.join(root, ".husky"))).toBe(false);
  });

  test("the installed hook is a valid shell script", () => {
    const root = gitRepo("shellcheck");
    installGitHooks(root);

    for (const hook of HOOK_NAMES) {
      const file = path.join(root, ".git", "hooks", hook);
      const parsed = spawnSync("/bin/sh", ["-n", file], { encoding: "utf8" });
      expect(parsed.status).toBe(0);
    }
  });

  test("running the installed hook does not block, fail, or touch the repo", () => {
    const root = gitRepo("run");
    installGitHooks(root);

    // `greplost` is not on PATH here and `bunx greplost` must never be reached
    // synchronously, so the hook returns immediately either way. `-e` is how
    // husky runs a hook: the script must still succeed, or every commit in a
    // checkout without greplost reports a failed hook.
    const started = Date.now();
    const ran = spawnSync("/bin/sh", ["-e", path.join(root, ".git", "hooks", "post-commit")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
      timeout: 20_000,
    });
    expect(ran.error).toBeUndefined();
    expect(ran.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(ran.stdout).toBe("");
    expect(existsSync(path.join(root, ".greplost"))).toBe(false);
  });

  test("does nothing from a subdirectory of a repository", () => {
    const root = gitRepo("subdirectory");
    const nested = path.join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });

    const result = installGitHooks(nested);

    // `update` only trusts git at the top level, because porcelain paths are
    // relative to it; installing hooks anywhere else would wire a commit to an
    // update that cannot find the map.
    expect(result.mode).toBe("none");
    expect(result.installed).toEqual([]);
    expect(result.notes.join(" ")).toContain("not a git repository root");
    expect(existsSync(path.join(root, ".git", "hooks", "post-commit"))).toBe(false);
  });
});
