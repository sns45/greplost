import { describe, test, expect, beforeEach, afterAll } from "bun:test";
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
  fetchAndCheckout,
  deepenHistory,
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

describe("setup against a local fixture repo (no network)", () => {
  // 8 real commits so a small --depth override (below) can produce a
  // genuinely shallow clone and a deepen with headroom to saturate against.
  const workDir = mkdtempSync(join(tmpdir(), "greplost-corpus-fixture-"));
  const testRepoName = "test-local-fixture-repo";
  const shas: string[] = []; // shas[0] = root commit ... shas[7] = tip commit

  function gitIn(cwd: string, args: string[]): string {
    const res = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${res.stderr}`);
    }
    return res.stdout ?? "";
  }

  gitIn(workDir, ["init", "-q"]);
  gitIn(workDir, ["config", "user.email", "bench@example.com"]);
  gitIn(workDir, ["config", "user.name", "bench"]);
  for (let i = 1; i <= 8; i++) {
    writeFileSync(join(workDir, "file.txt"), `line ${i}\n`);
    gitIn(workDir, ["add", "file.txt"]);
    gitIn(workDir, ["commit", "-q", "-m", `commit ${i}`]);
    shas.push(gitIn(workDir, ["rev-parse", "HEAD"]).trim());
  }

  // Every test starts from a clean bench/.corpus/<testRepoName>: several
  // tests need a fresh (not-yet-fetched) repo to observe a real fetch fire,
  // and reusing a dir left shallow or deepened by a previous test would
  // change what each test can actually demonstrate.
  beforeEach(() => {
    rmSync(repoDir(testRepoName), { recursive: true, force: true });
  });

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

  function headOf(dir: string): string {
    return spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  }

  test("clones and checks out the pinned sha", () => {
    setupRepo(entry(shas[7]!));
    expect(headOf(repoDir(testRepoName))).toBe(shas[7]!);
  });

  test("is idempotent: re-running at the same sha stays checked out", () => {
    setupRepo(entry(shas[7]!));
    setupRepo(entry(shas[7]!));
    expect(headOf(repoDir(testRepoName))).toBe(shas[7]!);
  });

  test("re-checks out when the pinned sha changes", () => {
    setupRepo(entry(shas[7]!));
    setupRepo(entry(shas[3]!));
    expect(headOf(repoDir(testRepoName))).toBe(shas[3]!);
  });

  test("recovers when the target directory exists but is not a git repo", () => {
    const dir = repoDir(testRepoName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "not-a-repo.txt"), "junk\n");
    setupRepo(entry(shas[0]!));
    expect(headOf(dir)).toBe(shas[0]!);
  });

  test("fetchAndCheckout with a bounded depth produces a genuinely shallow clone", () => {
    fetchAndCheckout(entry(shas[7]!), 3);
    const dir = repoDir(testRepoName);
    expect(headOf(dir)).toBe(shas[7]!);
    expect(gitIn(dir, ["rev-parse", "--is-shallow-repository"]).trim()).toBe("true");
    expect(gitIn(dir, ["rev-list", "--count", shas[7]!]).trim()).toBe("3");
  });

  test("deepenHistory widens a shallow clone until it saturates at the fixture's full history", () => {
    fetchAndCheckout(entry(shas[7]!), 3);
    const dir = repoDir(testRepoName);
    expect(gitIn(dir, ["rev-parse", "--is-shallow-repository"]).trim()).toBe("true");

    deepenHistory(entry(shas[7]!));

    expect(gitIn(dir, ["rev-list", "--count", shas[7]!]).trim()).toBe("8");
    expect(gitIn(dir, ["rev-parse", "--is-shallow-repository"]).trim()).toBe("false");
  });

  test("setupRepo composes fetchAndCheckout and deepenHistory: a bounded-depth setup still ends up saturated", () => {
    setupRepo(entry(shas[7]!), { depth: 3 });
    const dir = repoDir(testRepoName);
    expect(headOf(dir)).toBe(shas[7]!);
    expect(gitIn(dir, ["rev-list", "--count", shas[7]!]).trim()).toBe("8");
    expect(gitIn(dir, ["rev-parse", "--is-shallow-repository"]).trim()).toBe("false");
  });

  test("recovers when the pinned sha changes to a commit outside the fetched depth window", () => {
    // Fetch only the last 3 commits behind the tip (shas[5..7]); shas[0]
    // (the root commit) is well outside that window and was never fetched.
    fetchAndCheckout(entry(shas[7]!), 3);
    fetchAndCheckout(entry(shas[0]!), 3);
    expect(headOf(repoDir(testRepoName))).toBe(shas[0]!);
  });
});
