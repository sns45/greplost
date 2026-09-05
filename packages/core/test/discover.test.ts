import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { discoverCandidates, discoverFiles, isMappablePath } from "../src/discover.ts";
import { sha256Hex, countLoc } from "../src/hash.ts";
import { DEFAULT_CONFIG } from "../src/schema.ts";
import type { GreplostConfig } from "../src/schema.ts";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function write(dir: string, rel: string, contents: string): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

function gitCommit(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", message);
}

function config(overrides: Partial<GreplostConfig> = {}): GreplostConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function paths(entries: { path: string }[]): string[] {
  return entries.map((e) => e.path);
}

describe("gitignore", () => {
  test("honours nested .gitignore, includes untracked files, keeps a tracked-but-ignored file", async () => {
    const dir = tempDir("greplost-gitignore-");
    git(dir, "init", "-q");

    write(dir, "a.ts", "export const a = 1;\n");
    write(dir, "tracked-ignored.ts", "export const b = 2;\n");
    write(dir, ".gitignore", "");
    write(dir, "sub/.gitignore", "");
    gitCommit(dir, "initial");

    write(dir, ".gitignore", "ignored.ts\ntracked-ignored.ts\n");
    write(dir, "sub/.gitignore", "nested-ignored.ts\n");
    gitCommit(dir, "add ignores");

    write(dir, "b.ts", "export const c = 3;\n");
    write(dir, "ignored.ts", "export const d = 4;\n");
    write(dir, "sub/kept.ts", "export const e = 5;\n");
    write(dir, "sub/nested-ignored.ts", "export const f = 6;\n");

    const found = await discoverFiles(dir, config());

    expect(paths(found)).toEqual(["a.ts", "b.ts", "sub/kept.ts", "tracked-ignored.ts"]);
    for (const f of found) {
      expect(f.lang).toBe("ts");
      expect(f.absPath).toBe(join(dir, f.path));
    }
  });

  test("skips a file that is cached in git's index but missing from the working tree", async () => {
    const dir = tempDir("greplost-gitignore-deleted-");
    git(dir, "init", "-q");
    write(dir, "keep.ts", "export const a = 1;\n");
    write(dir, "gone.ts", "export const b = 2;\n");
    gitCommit(dir, "initial");
    // Remove the file from disk without telling git (no `git rm`): it stays in the
    // index (still "cached"), so `git ls-files --cached` still lists it even though
    // it no longer exists on disk.
    rmSync(join(dir, "gone.ts"));

    const found = await discoverFiles(dir, config());
    expect(paths(found)).toEqual(["keep.ts"]);
  });
});

describe("exclude", () => {
  test("falls back to fast-glob outside a git repo and applies config.include/config.exclude", async () => {
    const dir = tempDir("greplost-exclude-");
    write(dir, "src/keep.ts", "export const a = 1;\n");
    write(dir, "src/skip.ts", "export const b = 2;\n");
    write(dir, "src/nested/deep.ts", "export const c = 3;\n");
    write(dir, "other/outside.ts", "export const d = 4;\n");
    write(dir, "flat.ts", "export const e = 5;\n");

    const found = await discoverFiles(
      dir,
      config({ include: ["src/**"], exclude: ["**/skip.ts"], languages: ["ts"] }),
    );

    expect(paths(found)).toEqual(["src/keep.ts", "src/nested/deep.ts"]);
  });

  test("an include pattern without ** only matches a single path segment", async () => {
    const dir = tempDir("greplost-exclude-nostar-");
    write(dir, "src/keep.ts", "export const a = 1;\n");
    write(dir, "src/skip.ts", "export const b = 2;\n");
    write(dir, "src/nested/deep.ts", "export const c = 3;\n");

    const found = await discoverFiles(dir, config({ include: ["src/*.ts"], exclude: [], languages: ["ts"] }));

    expect(paths(found)).toEqual(["src/keep.ts", "src/skip.ts"]);
  });

  test("never returns files under .greplost/ even if config.exclude is overridden", async () => {
    const dir = tempDir("greplost-exclude-artifact-");
    write(dir, "src/keep.ts", "export const a = 1;\n");
    write(dir, ".greplost/cache/summaries.ts", "export const b = 2;\n");

    const found = await discoverFiles(dir, config({ include: ["**"], exclude: [], languages: ["ts"] }));

    expect(paths(found)).toEqual(["src/keep.ts"]);
  });

  test("hidden directories are subject to config.include/config.exclude, not dropped outright, outside a git repo", async () => {
    const dir = tempDir("greplost-exclude-dotdir-");
    write(dir, "src/keep.ts", "export const a = 1;\n");
    write(dir, ".hidden/x.ts", "export const b = 2;\n");

    // Default config.include ("**") already reaches hidden paths (picomatch
    // matches "**" against dotfiles when { dot: true }, and fast-glob now
    // walks into dot-directories too): discovered.
    const included = await discoverFiles(dir, config({ exclude: [], languages: ["ts"] }));
    expect(paths(included)).toEqual([".hidden/x.ts", "src/keep.ts"]);

    // config.exclude names it: excluded, same as any other directory.
    const excluded = await discoverFiles(dir, config({ exclude: ["**/.hidden/**"], languages: ["ts"] }));
    expect(paths(excluded)).toEqual(["src/keep.ts"]);
  });

  test("hidden directories are matched consistently between git mode and the fast-glob fallback", async () => {
    const dir = tempDir("greplost-exclude-dotdir-git-");
    git(dir, "init", "-q");
    write(dir, "src/keep.ts", "export const a = 1;\n");
    write(dir, ".hidden/x.ts", "export const b = 2;\n");
    gitCommit(dir, "initial");

    const found = await discoverFiles(dir, config({ exclude: [], languages: ["ts"] }));
    expect(paths(found)).toEqual([".hidden/x.ts", "src/keep.ts"]);
  });

  test("never returns .git/ content in a git repo", async () => {
    const dir = tempDir("greplost-exclude-dotgit-");
    git(dir, "init", "-q");
    write(dir, "src/keep.ts", "export const a = 1;\n");
    gitCommit(dir, "initial");

    const found = await discoverFiles(dir, config());
    for (const f of found) {
      expect(f.path.startsWith(".git/")).toBe(false);
      expect(f.path).not.toBe(".git");
    }
    expect(paths(found)).toEqual(["src/keep.ts"]);
  });
});

describe("languages", () => {
  test("maps extensions through LANG_BY_EXTENSION and filters by config.languages", async () => {
    const dir = tempDir("greplost-languages-");
    write(dir, "a.ts", "export const a = 1;\n");
    write(dir, "b.tsx", "export const b = 1;\n");
    write(dir, "c.js", "export const c = 1;\n");
    write(dir, "d.jsx", "export const d = 1;\n");
    write(dir, "e.go", "package main\n");
    write(dir, "f.py", "a = 1\n");

    const all = await discoverFiles(dir, config({ languages: ["ts", "tsx", "js", "jsx", "go"] }));
    expect(all.map((e) => [e.path, e.lang])).toEqual([
      ["a.ts", "ts"],
      ["b.tsx", "tsx"],
      ["c.js", "js"],
      ["d.jsx", "jsx"],
      ["e.go", "go"],
    ]);

    const tsOnly = await discoverFiles(dir, config({ languages: ["ts"] }));
    expect(paths(tsOnly)).toEqual(["a.ts"]);
  });

  test("ignores uppercase extensions such as .TS", async () => {
    const dir = tempDir("greplost-languages-case-");
    write(dir, "keep.ts", "export const a = 1;\n");
    write(dir, "Upper.TS", "export const b = 1;\n");

    const found = await discoverFiles(dir, config());
    expect(paths(found)).toEqual(["keep.ts"]);
  });

  test("excludes .d.ts files by default", async () => {
    const dir = tempDir("greplost-languages-dts-");
    write(dir, "normal.ts", "export const a = 1;\n");
    write(dir, "types.d.ts", "export declare const b: number;\n");

    const found = await discoverFiles(dir, config());
    expect(paths(found)).toEqual(["normal.ts"]);
  });

  test("results are sorted by path with compareStrings", async () => {
    const dir = tempDir("greplost-languages-sort-");
    write(dir, "z.ts", "export const z = 1;\n");
    write(dir, "a.ts", "export const a = 1;\n");
    write(dir, "m.ts", "export const m = 1;\n");

    const found = await discoverFiles(dir, config());
    expect(paths(found)).toEqual(["a.ts", "m.ts", "z.ts"]);
  });
});

describe("hash", () => {
  test("sha256Hex matches known vectors", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("sha256Hex treats a Uint8Array the same as the equivalent string", () => {
    const bytes = new TextEncoder().encode("abc");
    expect(sha256Hex(bytes)).toBe(sha256Hex("abc"));
  });

  test("countLoc: empty file is 0", () => {
    expect(countLoc("")).toBe(0);
  });

  test("countLoc: no trailing newline counts the last line", () => {
    expect(countLoc("abc")).toBe(1);
    expect(countLoc("abc\ndef")).toBe(2);
  });

  test("countLoc: trailing newline does not add an extra line", () => {
    expect(countLoc("abc\n")).toBe(1);
    expect(countLoc("abc\ndef\n")).toBe(2);
  });

  test("countLoc: CRLF line endings count once per line", () => {
    expect(countLoc("abc\r\ndef\r\n")).toBe(2);
    expect(countLoc("abc\r\ndef")).toBe(2);
  });
});

describe("tiny-ts", () => {
  test("discovers exactly the 12 .ts files in fixtures/tiny-ts", async () => {
    const root = join(import.meta.dir, "..", "..", "..", "fixtures", "tiny-ts");
    const found = await discoverFiles(root, DEFAULT_CONFIG);

    expect(paths(found)).toEqual([
      "apps/worker/src/config.ts",
      "apps/worker/src/main.ts",
      "packages/adapters/src/index.ts",
      "packages/adapters/src/memory.ts",
      "packages/adapters/src/sqs.ts",
      "packages/core/src/bus.ts",
      "packages/core/src/events.ts",
      "packages/core/src/index.ts",
      "packages/core/src/queue.ts",
      "packages/core/src/registry.ts",
      "packages/core/src/retry.ts",
      "packages/core/src/types.ts",
    ]);
    expect(found.length).toBe(12);
    for (const f of found) {
      expect(f.lang).toBe("ts");
    }
  });
});

// ---------------------------------------------------------------------------
// Leaf 2.11 fix round 1. A repo-relative path is also an *id* (tech spec 5.3):
// `<file>`, `<file>#<symbol>`, `<file>#<kind>.<name>`. A path holding a `#`
// therefore cannot be told from a symbol id, cannot be slugged into a node card
// directory, and cannot be linked to from Markdown; a path holding a newline or
// a NUL cannot survive `graph/*.jsonl` at all. Build 1 wrote an unlinkable card
// for such a file; schema 2 aborts the render on one. Skipping is the honest
// behaviour, and the count is reported once by `init`/`update`.
// ---------------------------------------------------------------------------

describe("unmappable paths", () => {
  test("a path holding '#', a newline or a NUL is not a path the map can hold", () => {
    expect(isMappablePath("src/a.ts")).toBe(true);
    expect(isMappablePath("weird dir/a b.ts")).toBe(true);
    expect(isMappablePath("we#ird.ts")).toBe(false);
    expect(isMappablePath("src/#/a.ts")).toBe(false);
    expect(isMappablePath("we\nird.ts")).toBe(false);
    expect(isMappablePath("we\u0000ird.ts")).toBe(false);
  });

  test("discovery skips them and reports them, in a git repo and outside one", async () => {
    for (const useGit of [false, true]) {
      const dir = tempDir(`greplost-unmappable-${useGit ? "git" : "glob"}-`);
      if (useGit) git(dir, "init", "-q");
      write(dir, "good.ts", "export const a = 1;\n");
      write(dir, "we#ird.ts", "export const b = 2;\n");
      write(dir, "sub/al#so.ts", "export const c = 3;\n");
      write(dir, "sub/fine.ts", "export const d = 4;\n");
      if (useGit) gitCommit(dir, "initial");

      const skipped: string[] = [];
      const found = await discoverFiles(dir, config({ languages: ["ts"] }), skipped);
      expect(paths(found), String(useGit)).toEqual(["good.ts", "sub/fine.ts"]);
      expect(skipped, String(useGit)).toEqual(["sub/al#so.ts", "we#ird.ts"]);

      // `discoverCandidates` is the same walk with the language step left off,
      // so `greplost init` cannot pick a language off an unmappable marker file.
      const candidateSkips: string[] = [];
      const candidates = await discoverCandidates(dir, config({ languages: ["ts"] }), candidateSkips);
      expect(candidates.includes("we#ird.ts"), String(useGit)).toBe(false);
      expect(candidateSkips, String(useGit)).toEqual(["sub/al#so.ts", "we#ird.ts"]);
    }
  });

  test("the out-parameter is optional and a clean repo appends nothing", async () => {
    const dir = tempDir("greplost-unmappable-clean-");
    write(dir, "good.ts", "export const a = 1;\n");
    const skipped: string[] = [];
    expect(paths(await discoverFiles(dir, config({ languages: ["ts"] }), skipped))).toEqual(["good.ts"]);
    expect(skipped).toEqual([]);
    expect(paths(await discoverFiles(dir, config({ languages: ["ts"] })))).toEqual(["good.ts"]);
  });
});
