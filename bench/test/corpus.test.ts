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

/** The seven build-1 pins. Build 2 appends fifteen more, all tier S. */
const BUILD_1 = ["TypeScript", "anyq", "bubbletea", "gin", "grafana", "hono", "vite"];

/** The fifteen build-2 pins from spec 5.1, added in one edit by leaf 2.0. */
const BUILD_2 = [
  "bitnami-charts",
  "coroutines",
  "docker-node",
  "docker-python",
  "gson",
  "k8s-examples",
  "next-app",
  "pulumi-go",
  "pulumi-ts",
  "pydantic",
  "ripgrep",
  "starter-workflows",
  "tanstack-start",
  "tf-aws-eks",
  "tf-aws-vpc",
];

/** Every `Lang`, so an entry can never carry a language greplost has no extractor for. */
const LANGS = ["ts", "tsx", "js", "jsx", "go", "python", "rust", "java", "kotlin", "hcl", "yaml", "dockerfile"];

describe("corpus.json", () => {
  const corpus = loadCorpus();

  test("has exactly 22 pinned repos: 7 from build 1 and 15 from build 2", () => {
    expect(corpus.repos.length).toBe(BUILD_1.length + BUILD_2.length);
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
      expect(LANGS).toContain(repo.lang);
      expect(typeof repo.defaultBranch).toBe("string");
      expect(repo.defaultBranch.length).toBeGreaterThan(0);
      expect(typeof repo.notes).toBe("string");
    }
  });

  test("includes the expected repo names", () => {
    const names = corpus.repos.map((r) => r.name).sort();
    expect(names).toEqual([...BUILD_1, ...BUILD_2].sort());
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

  test("every build-2 entry resolves", () => {
    const byName = new Map(corpus.repos.map((r) => [r.name, r]));
    for (const name of BUILD_2) {
      const repo = byName.get(name);
      expect(repo, `${name} is missing from corpus.json`).toBeDefined();
      const entry = repo as NonNullable<typeof repo>;
      expect(entry.sha, `${name} sha`).toMatch(SHA_RE);
      expect(LANGS, `${name} lang`).toContain(entry.lang);
      expect(entry.tier, `${name} tier`).toBe("S");
      expect(entry.url, `${name} url`).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/);
      expect(entry.defaultBranch.length, `${name} defaultBranch`).toBeGreaterThan(0);
      expect(entry.notes, `${name} notes`).toContain("build 2");
    }
  });

  test("the build-2 languages are all covered, and pulumi shares one checkout at one sha", () => {
    const byName = new Map(corpus.repos.map((r) => [r.name, r]));
    const build2Langs = new Set<string>();
    for (const name of BUILD_2) {
      const lang = byName.get(name)?.lang;
      if (lang !== undefined) build2Langs.add(lang);
    }
    for (const lang of ["python", "rust", "java", "kotlin", "hcl", "yaml", "dockerfile", "ts", "go", "tsx"]) {
      expect(build2Langs.has(lang), `no build-2 corpus entry for ${lang}`).toBe(true);
    }
    // Two entries, one upstream repo: the subsets are what keep them from measuring each other.
    expect(byName.get("pulumi-ts")?.url).toBe(byName.get("pulumi-go")?.url);
    expect(byName.get("pulumi-ts")?.sha).toBe(byName.get("pulumi-go")?.sha);
    expect(byName.get("pulumi-ts")?.subset).not.toBe(byName.get("pulumi-go")?.subset);
  });

  test("subset patterns", () => {
    const byName = new Map(corpus.repos.map((r) => [r.name, r]));
    // Every build-2 entry declares a subset, so what is scored is a property of the pin and
    // not something a human has to remember.
    for (const name of BUILD_2) {
      const subset = byName.get(name)?.subset;
      expect(typeof subset, `${name} subset`).toBe("string");
      expect((subset as string).length, `${name} subset`).toBeGreaterThan(0);
      // A picomatch pattern, posix, never absolute and never escaping the checkout.
      expect(subset as string, `${name} subset`).not.toContain("..");
      expect((subset as string).startsWith("/"), `${name} subset`).toBe(false);
      expect(subset as string, `${name} subset`).not.toContain("\\");
    }
    expect(byName.get("pydantic")?.subset).toBe("pydantic/**");
    expect(byName.get("ripgrep")?.subset).toBe("crates/**");
    expect(byName.get("gson")?.subset).toBe("**/src/main/**");
    // The pin's own note says "122 .ts under aws-ts-*/", and so does the leaf-2.3 gate. The
    // wider `aws-ts-*/**` swept in 41 more source files from the sample apps embedded in those
    // examples: 37 JavaScript (36 `.js` plus one `.mjs` Lambda handler, an Express server, a
    // CRA client, `next.config.js`) **and 4 `.tsx`** (a Next.js demo app's `layout.tsx` and
    // `page.tsx`, a React website's `App.tsx` and `main.tsx`). None of them is Pulumi
    // TypeScript. The repo and sha are unchanged (build 2, leaf 2.3).
    expect(byName.get("pulumi-ts")?.subset).toBe("aws-ts-*/**/*.ts");
    // The note has to say so too: `*.ts` is not "the TypeScript files", it is `.ts` only.
    expect(byName.get("pulumi-ts")?.notes).toContain(".tsx");
    expect(byName.get("pulumi-go")?.subset).toBe("*-go-*/**");
    expect(byName.get("next-app")?.subset).toBe("examples/*/app/**");
    // A whole-repo pin still says so explicitly rather than leaving the field out.
    expect(byName.get("tf-aws-vpc")?.subset).toBe("**");
    // Build-1 entries carry none: their pins predate the field and are scored whole.
    for (const name of BUILD_1) expect(byName.get(name)?.subset, name).toBeUndefined();
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
    expect(repos.map((r) => r.name).sort()).toEqual(["anyq", "gin", ...BUILD_2].sort());
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
    expect(repos.length).toBe(BUILD_1.length + BUILD_2.length);
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
