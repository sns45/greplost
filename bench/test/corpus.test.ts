import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, hostname, userInfo, homedir } from "node:os";
import { join } from "node:path";

import {
  loadCorpus,
  corpusRoot,
  repoDir,
  selectRepos,
  setupRepo,
  type CorpusRepoEntry,
} from "../src/corpus.ts";
import { machineProfile } from "../src/machine.ts";

const SHA_RE = /^[0-9a-f]{40}$/;

describe("corpus.json", () => {
  const corpus = loadCorpus();

  test("has exactly 7 pinned repos", () => {
    expect(corpus.repos.length).toBe(7);
  });

  test("has a pinnedAt date", () => {
    expect(corpus.pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("every repo has a 40-hex sha", () => {
    for (const repo of corpus.repos) {
      expect(repo.sha).toMatch(SHA_RE);
    }
  });

  test("every repo has name, url, tier, lang, defaultBranch, notes", () => {
    for (const repo of corpus.repos) {
      expect(typeof repo.name).toBe("string");
      expect(repo.name.length).toBeGreaterThan(0);
      expect(repo.url).toMatch(/^https:\/\/github\.com\//);
      expect(["S", "M", "L", "XL"]).toContain(repo.tier);
      expect(["ts", "go"]).toContain(repo.lang);
      expect(typeof repo.defaultBranch).toBe("string");
      expect(repo.defaultBranch.length).toBeGreaterThan(0);
      expect(typeof repo.notes).toBe("string");
    }
  });

  test("includes the expected repo names", () => {
    const names = corpus.repos.map((r) => r.name).sort();
    expect(names).toEqual(
      ["TypeScript", "anyq", "bubbletea", "gin", "grafana", "hono", "vite"].sort(),
    );
  });

  test("tiers match the spec", () => {
    const byName = Object.fromEntries(corpus.repos.map((r) => [r.name, r]));
    expect(byName["anyq"]?.tier).toBe("S");
    expect(byName["gin"]?.tier).toBe("S");
    expect(byName["hono"]?.tier).toBe("M");
    expect(byName["bubbletea"]?.tier).toBe("M");
    expect(byName["vite"]?.tier).toBe("L");
    expect(byName["grafana"]?.tier).toBe("L");
    expect(byName["TypeScript"]?.tier).toBe("XL");
  });

  test("grafana notes the pkg/ subset and TypeScript notes perf only", () => {
    const byName = Object.fromEntries(corpus.repos.map((r) => [r.name, r]));
    expect(byName["grafana"]?.notes).toContain("pkg/");
    expect(byName["TypeScript"]?.notes.toLowerCase()).toContain("perf");
  });
});

describe("corpusRoot and repoDir", () => {
  test("corpusRoot resolves the directory containing bench/corpus.json", () => {
    const root = corpusRoot();
    expect(existsSync(join(root, "bench", "corpus.json"))).toBe(true);
  });

  test("repoDir places repos under bench/.corpus/<name>", () => {
    const dir = repoDir("anyq");
    expect(dir).toBe(join(corpusRoot(), "bench", ".corpus", "anyq"));
  });
});

describe("selectRepos", () => {
  test("defaults to tier S when no filter is given", () => {
    const repos = selectRepos([]);
    expect(repos.map((r) => r.name).sort()).toEqual(["anyq", "gin"]);
  });

  test("filters by --tier", () => {
    const repos = selectRepos(["--tier", "M"]);
    expect(repos.map((r) => r.name).sort()).toEqual(["bubbletea", "hono"]);
  });

  test("filters by --repo", () => {
    const repos = selectRepos(["--repo", "vite"]);
    expect(repos.map((r) => r.name)).toEqual(["vite"]);
  });

  test("--repo takes precedence over --tier", () => {
    const repos = selectRepos(["--tier", "S", "--repo", "grafana"]);
    expect(repos.map((r) => r.name)).toEqual(["grafana"]);
  });

  test("--all selects every repo", () => {
    const repos = selectRepos(["--all"]);
    expect(repos.length).toBe(7);
  });

  test("throws on an unknown --repo", () => {
    expect(() => selectRepos(["--repo", "not-a-real-repo"])).toThrow();
  });

  test("throws on an unknown --tier", () => {
    expect(() => selectRepos(["--tier", "XXL"])).toThrow();
  });
});

describe("machine", () => {
  const profile = machineProfile();

  test("has all required fields", () => {
    expect(typeof profile.cpu).toBe("string");
    expect(profile.cpu.length).toBeGreaterThan(0);
    expect(typeof profile.cores).toBe("number");
    expect(profile.cores).toBeGreaterThan(0);
    expect(typeof profile.memoryGB).toBe("number");
    expect(profile.memoryGB).toBeGreaterThan(0);
    expect(typeof profile.os).toBe("string");
    expect(typeof profile.arch).toBe("string");
    expect(typeof profile.bun).toBe("string");
    expect(typeof profile.node).toBe("string");
    expect(typeof profile.go).toBe("string");
    expect(typeof profile.greplostVersion).toBe("string");
    expect(typeof profile.greplostSha).toBe("string");
  });

  test("does not leak hostname, username or home directory", () => {
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toContain(hostname());
    expect(serialized).not.toContain(userInfo().username);
    expect(serialized).not.toContain(homedir());
  });
});

describe("setupRepo against a local fixture repo (no network)", () => {
  const workDir = mkdtempSync(join(tmpdir(), "greplost-corpus-fixture-"));
  const testRepoName = "test-local-fixture-repo";
  const shas: string[] = [];

  function git(args: string[]): { status: number; stdout: string } {
    const res = spawnSync("git", args, { cwd: workDir, encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    }
    return { status: res.status ?? 0, stdout: res.stdout ?? "" };
  }

  git(["init", "-q"]);
  git(["config", "user.email", "bench@example.com"]);
  git(["config", "user.name", "bench"]);
  for (let i = 1; i <= 3; i++) {
    writeFileSync(join(workDir, "file.txt"), `line ${i}\n`);
    git(["add", "file.txt"]);
    git(["commit", "-q", "-m", `commit ${i}`]);
    shas.push(git(["rev-parse", "HEAD"]).stdout.trim());
  }

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(repoDir(testRepoName), { recursive: true, force: true });
  });

  function entry(sha: string): CorpusRepoEntry {
    return {
      name: testRepoName,
      url: workDir,
      sha,
      tier: "S",
      lang: "ts",
      defaultBranch: "master",
      notes: "test fixture",
    };
  }

  test("clones and checks out the pinned sha", () => {
    setupRepo(entry(shas[1]!));
    const dir = repoDir(testRepoName);
    const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    expect(head).toBe(shas[1]!);
  });

  test("is idempotent: re-running at the same sha stays checked out", () => {
    setupRepo(entry(shas[1]!));
    const dir = repoDir(testRepoName);
    const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    expect(head).toBe(shas[1]!);
  });

  test("re-checks out when the pinned sha changes", () => {
    setupRepo(entry(shas[2]!));
    const dir = repoDir(testRepoName);
    const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    expect(head).toBe(shas[2]!);
  });

  test("recovers when the target directory exists but is not a git repo", () => {
    const dir = repoDir(testRepoName);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "not-a-repo.txt"), "junk\n");
    setupRepo(entry(shas[0]!));
    const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    expect(head).toBe(shas[0]!);
  });
});
