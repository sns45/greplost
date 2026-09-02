/**
 * greplost:sync build tests (leaf 1.3.1).
 *
 * Three concerns: which artifact paths the structure layer owns
 * (`isStructurePath`), that `buildArtifacts` reproduces the committed goldens
 * of `packages/core` and `packages/render` exactly, and that `writeArtifacts`
 * is the minimal-churn, self-pruning writer the sync contract promises.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createParser, sha256Hex } from "@greplost/core";
import type { ParserHandle } from "@greplost/core";
import type { Manifest, SummaryCache } from "@greplost/core/schema";
import { compareStrings, stableStringify } from "@greplost/core/schema";

import { isStructurePath } from "../src/artifacts.ts";
import { buildArtifacts, readSummaries } from "../src/build.ts";
import { writeArtifacts } from "../src/write.ts";

const FIXTURE_ROOT = path.resolve(import.meta.dir, "../../../fixtures/tiny-ts");
const CORE_GOLDEN = path.resolve(import.meta.dir, "../../core/test/golden/tiny-ts");
const RENDER_GOLDEN = path.resolve(import.meta.dir, "../../render/test/golden/tiny-ts");

const temporaries: string[] = [];

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway copy of `fixtures/tiny-ts`, so a test may write into the tree. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-sync-${label}-`));
  temporaries.push(dir);
  const root = path.join(dir, "repo");
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  return root;
}

/** Every file under `dir`, as artifact-relative posix paths, sorted. */
function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort(compareStrings);
}

/**
 * The summary cache the render golden was generated with (render spec "Golden
 * test"): one fresh entry keyed by the current content of `retry.ts`, and one
 * entry for `bus.ts` under a hash nothing has, which makes its summary stale.
 */
function goldenSummaries(): SummaryCache {
  const retryHash = sha256Hex(readFileSync(path.join(FIXTURE_ROOT, "packages/core/src/retry.ts")));
  return {
    [retryHash]: {
      path: "packages/core/src/retry.ts",
      text: "Retries an async operation a fixed number of times before rethrowing the last error.",
      refreshedAt: "2026-09-01",
      model: "test",
    },
    "0000000000000000000000000000000000000000000000000000000000000000": {
      path: "packages/core/src/bus.ts",
      text: "Fan-out event bus used by the registry.",
      refreshedAt: "2026-08-15",
      model: "test",
    },
  };
}

describe("isStructurePath", () => {
  const structure = [
    "INDEX.md",
    "manifest.json",
    "graph/imports.jsonl",
    "graph/calls.jsonl",
    "graph/symbols.jsonl",
    "repo/MAP.md",
    "repo/HOTSPOTS.md",
    "packages/tiny__core/MAP.md",
    "packages/tiny__core/API.md",
    "packages/tiny__core/modules/src/bus.ts.md",
    "packages/tiny__core/modules/index.ts.md",
    "packages/tiny__core/modules/a/b/c/deep.ts.md",
    "packages/tiny-ts/API.md",
  ];

  const notStructure = [
    "config.json",
    "cache/summaries.json",
    "cache/parse.json",
    "cache/nested/other.json",
    "packages/tiny__core/FLOWS.md",
    "WORKSPACE.md",
    ".dirty",
    ".lock",
    ".state.json",
    ".gitignore",
  ];

  for (const rel of structure) {
    test(`owns ${rel}`, () => {
      expect(isStructurePath(rel)).toBe(true);
    });
  }

  for (const rel of notStructure) {
    test(`leaves ${rel} alone`, () => {
      expect(isStructurePath(rel)).toBe(false);
    });
  }

  test("rejects paths that could escape the artifact directory", () => {
    for (const rel of [
      "../INDEX.md",
      "packages/../../INDEX.md",
      "/INDEX.md",
      "./INDEX.md",
      "packages//MAP.md",
      "",
      "C:/INDEX.md",
    ]) {
      expect(isStructurePath(rel)).toBe(false);
    }
  });

  test("rejects Windows-style separators", () => {
    expect(isStructurePath("graph\\imports.jsonl")).toBe(false);
    expect(isStructurePath("packages\\tiny__core\\MAP.md")).toBe(false);
    expect(isStructurePath("repo\\MAP.md")).toBe(false);
  });

  test("is not fooled by lookalike paths", () => {
    expect(isStructurePath("INDEX.md.bak")).toBe(false);
    expect(isStructurePath("graph/imports.json")).toBe(false);
    expect(isStructurePath("graph/nested/imports.jsonl")).toBe(false);
    expect(isStructurePath("repo/MAP.md/inner.md")).toBe(false);
    expect(isStructurePath("packages/MAP.md")).toBe(false);
    expect(isStructurePath("packages/tiny__core/modules/src/bus.ts")).toBe(false);
    expect(isStructurePath("packages/a/b/MAP.md")).toBe(false);
  });
});

describe("golden union", () => {
  let parser: ParserHandle;
  /** No summary cache on disk: the shape `packages/core`'s golden was built in. */
  let bare: Map<string, string>;
  /** The seeded cache `packages/render`'s golden was built with. */
  let seeded: Map<string, string>;

  beforeAll(async () => {
    parser = await createParser();

    bare = (await buildArtifacts(FIXTURE_ROOT, { parser })).files;

    const seededRoot = copyFixture("golden");
    mkdirSync(path.join(seededRoot, ".greplost/cache"), { recursive: true });
    writeFileSync(
      path.join(seededRoot, ".greplost/cache/summaries.json"),
      `${stableStringify(goldenSummaries(), 2)}\n`,
    );
    seeded = (await buildArtifacts(seededRoot, { parser })).files;
  });

  test("the artifact paths are exactly the union of the two goldens", () => {
    const union = [...new Set([...listFiles(CORE_GOLDEN), ...listFiles(RENDER_GOLDEN)])].sort(compareStrings);
    expect(union.length).toBeGreaterThan(0);
    expect([...bare.keys()].sort(compareStrings)).toEqual(union);
    expect([...seeded.keys()].sort(compareStrings)).toEqual(union);
  });

  test("every artifact path is a structure path", () => {
    for (const rel of seeded.keys()) expect(`${rel} ${isStructurePath(rel)}`).toBe(`${rel} true`);
  });

  test("every core golden file is byte-equal", () => {
    const golden = listFiles(CORE_GOLDEN);
    expect(golden.length).toBe(4);
    for (const rel of golden) {
      const expected = readFileSync(path.join(CORE_GOLDEN, rel), "utf8");
      expect(`${rel}\n${bare.get(rel)}`).toBe(`${rel}\n${expected}`);
    }
  });

  test("every render golden file is byte-equal", () => {
    const golden = listFiles(RENDER_GOLDEN);
    expect(golden.length).toBe(23);
    for (const rel of golden) {
      const expected = readFileSync(path.join(RENDER_GOLDEN, rel), "utf8");
      expect(`${rel}\n${seeded.get(rel)}`).toBe(`${rel}\n${expected}`);
    }
  });

  /**
   * The two goldens were generated under different summary caches, so one
   * build cannot be byte-equal to both. This pins the entire difference: the
   * graph and every other document are identical, and the manifest moves only
   * in the two semantic fields, for the two files the seed names.
   */
  test("the seeded cache moves only the semantic fields and the two seeded cards", () => {
    const moved = [...seeded.keys()].filter((rel) => seeded.get(rel) !== bare.get(rel)).sort(compareStrings);
    expect(moved).toEqual([
      "manifest.json",
      "packages/tiny__core/modules/src/bus.ts.md",
      "packages/tiny__core/modules/src/retry.ts.md",
    ]);

    const before = JSON.parse(bare.get("manifest.json") as string) as Manifest;
    const after = JSON.parse(seeded.get("manifest.json") as string) as Manifest;
    const patched: Manifest = {
      ...before,
      files: Object.fromEntries(
        Object.entries(before.files).map(([file, entry]) => {
          if (file === "packages/core/src/retry.ts") {
            return [file, { ...entry, summaryHash: entry.sha256, staleSummary: false }];
          }
          if (file === "packages/core/src/bus.ts") {
            return [file, { ...entry, summaryHash: "0".repeat(64), staleSummary: true }];
          }
          return [file, entry];
        }),
      ),
    };
    expect(stableStringify(after, 2)).toBe(stableStringify(patched, 2));
  });

  test("a second build of the same tree is byte-identical", async () => {
    const again = (await buildArtifacts(FIXTURE_ROOT, { parser })).files;
    expect([...again].sort()).toEqual([...bare].sort());
  });
});

describe("summary cache", () => {
  function repoWithSummaries(label: string, contents: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), `greplost-sync-${label}-`));
    temporaries.push(dir);
    mkdirSync(path.join(dir, ".greplost/cache"), { recursive: true });
    writeFileSync(path.join(dir, ".greplost/cache/summaries.json"), contents);
    return dir;
  }

  test("is empty when the file is absent", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-sync-nosummaries-"));
    temporaries.push(dir);
    expect(readSummaries(dir)).toEqual({});
    mkdirSync(path.join(dir, ".greplost"), { recursive: true });
    expect(readSummaries(dir)).toEqual({});
  });

  test("round-trips a well-formed cache", () => {
    const entry = {
      path: "packages/core/src/bus.ts",
      text: "Fan-out event bus.",
      refreshedAt: "2026-08-15",
      model: "test",
    };
    const dir = repoWithSummaries("goodsummaries", `${stableStringify({ [`${"a".repeat(64)}`]: entry }, 2)}\n`);
    expect(readSummaries(dir)).toEqual({ ["a".repeat(64)]: entry });
  });

  test("refuses a cache it cannot understand rather than silently dropping prose", () => {
    expect(() => readSummaries(repoWithSummaries("badjson", "{ not json"))).toThrow(
      /greplost: cannot read \.greplost\/cache\/summaries\.json/,
    );
    expect(() => readSummaries(repoWithSummaries("badshape", "[]"))).toThrow(/is not a summary cache/);
    expect(() => readSummaries(repoWithSummaries("badentry", '{"abc":{"text":"x"}}'))).toThrow(
      /malformed entry for "abc"/,
    );
  });
});

describe("write", () => {
  let parser: ParserHandle;
  let artifacts: Map<string, string>;

  const CARD = "packages/tiny__core/modules/src/bus.ts.md";
  /** Files under `.greplost/` that belong to other layers and must survive every write. */
  const FOREIGN: Record<string, string> = {
    "config.json": '{ "languages": ["ts"] }\n',
    "cache/summaries.json": "{}\n",
    "cache/parse.json": "{}\n",
    "cache/nested/whatever.json": "{}\n",
    "packages/tiny__core/FLOWS.md": "# flows\n",
    "WORKSPACE.md": "# workspace\n",
    ".dirty": "packages/core/src/bus.ts\n",
    ".lock": '{"pid":1,"ts":0}\n',
    ".state.json": '{"lastIndexedCommit":"deadbeef"}\n',
    ".gitignore": ".dirty\n",
  };

  beforeAll(async () => {
    parser = await createParser();
    artifacts = (await buildArtifacts(FIXTURE_ROOT, { parser })).files;
  });

  /** A repo directory with nothing in `.greplost/` yet. */
  function emptyRepo(label: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), `greplost-sync-${label}-`));
    temporaries.push(dir);
    return dir;
  }

  function artifactDir(root: string): string {
    return path.join(root, ".greplost");
  }

  function seedForeign(root: string): void {
    for (const [rel, contents] of Object.entries(FOREIGN)) {
      const target = path.join(artifactDir(root), rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
  }

  /** Push every file's mtime an hour into the past so a rewrite is detectable. */
  function ageEverything(root: string): Map<string, number> {
    const old = new Date(Date.now() - 3_600_000);
    const stamps = new Map<string, number>();
    for (const rel of listFiles(artifactDir(root))) {
      const target = path.join(artifactDir(root), rel);
      utimesSync(target, old, old);
      stamps.set(rel, statSync(target).mtimeMs);
    }
    return stamps;
  }

  test("writes the whole map, creating directories as it goes", () => {
    const root = emptyRepo("write-fresh");
    const result = writeArtifacts(root, artifacts);

    expect(result.written).toEqual([...artifacts.keys()].sort(compareStrings));
    expect(result.deleted).toEqual([]);
    expect(result.unchanged).toBe(0);
    expect(listFiles(artifactDir(root))).toEqual([...artifacts.keys()].sort(compareStrings));
    for (const [rel, contents] of artifacts) {
      expect(readFileSync(path.join(artifactDir(root), rel), "utf8")).toBe(contents);
    }
  });

  test("writes nothing the second time and keeps every mtime", () => {
    const root = emptyRepo("write-idempotent");
    writeArtifacts(root, artifacts);
    const stamps = ageEverything(root);

    const result = writeArtifacts(root, artifacts);

    expect(result.written).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.unchanged).toBe(artifacts.size);
    for (const [rel, mtime] of stamps) {
      expect(`${rel} ${statSync(path.join(artifactDir(root), rel)).mtimeMs}`).toBe(`${rel} ${mtime}`);
    }
  });

  test("writes only the files whose bytes differ", () => {
    const root = emptyRepo("write-partial");
    writeArtifacts(root, artifacts);
    const stamps = ageEverything(root);

    const changed = new Map(artifacts);
    changed.set(CARD, `${artifacts.get(CARD) as string}\nedited\n`);
    const result = writeArtifacts(root, changed);

    expect(result.written).toEqual([CARD]);
    expect(result.unchanged).toBe(artifacts.size - 1);
    expect(readFileSync(path.join(artifactDir(root), CARD), "utf8")).toBe(changed.get(CARD) as string);
    expect(statSync(path.join(artifactDir(root), CARD)).mtimeMs).not.toBe(stamps.get(CARD));
    for (const [rel, mtime] of stamps) {
      if (rel === CARD) continue;
      expect(`${rel} ${statSync(path.join(artifactDir(root), rel)).mtimeMs}`).toBe(`${rel} ${mtime}`);
    }
  });

  test("prunes structure files the map no longer produces, and the directories they emptied", () => {
    const root = emptyRepo("write-prune");
    writeArtifacts(root, artifacts);

    const withoutCore = new Map(artifacts);
    const dropped = [...artifacts.keys()]
      .filter((rel) => rel.startsWith("packages/tiny__core/modules/"))
      .sort(compareStrings);
    expect(dropped.length).toBeGreaterThan(1);
    for (const rel of dropped) withoutCore.delete(rel);

    const result = writeArtifacts(root, withoutCore);

    expect(result.deleted).toEqual(dropped);
    expect(result.written).toEqual([]);
    expect(result.unchanged).toBe(withoutCore.size);
    expect(listFiles(artifactDir(root))).toEqual([...withoutCore.keys()].sort(compareStrings));
    expect(existsSync(path.join(artifactDir(root), "packages/tiny__core/modules"))).toBe(false);
    // Its parent still holds MAP.md and API.md, so it stays.
    expect(existsSync(path.join(artifactDir(root), "packages/tiny__core"))).toBe(true);
  });

  test("never touches config, caches, FLOWS, WORKSPACE or the runtime files", () => {
    const root = emptyRepo("write-foreign");
    seedForeign(root);
    writeArtifacts(root, artifacts);
    const stamps = ageEverything(root);

    // A prune-heavy second pass: everything the map dropped goes, nothing else.
    const result = writeArtifacts(root, new Map([["INDEX.md", artifacts.get("INDEX.md") as string]]));

    for (const [rel, contents] of Object.entries(FOREIGN)) {
      const target = path.join(artifactDir(root), rel);
      expect(`${rel} exists ${existsSync(target)}`).toBe(`${rel} exists true`);
      expect(`${rel}\n${readFileSync(target, "utf8")}`).toBe(`${rel}\n${contents}`);
      expect(`${rel} ${statSync(target).mtimeMs}`).toBe(`${rel} ${stamps.get(rel) as number}`);
      expect(result.deleted).not.toContain(rel);
    }
    expect(result.deleted).toEqual([...artifacts.keys()].filter((rel) => rel !== "INDEX.md").sort(compareStrings));
  });

  test("replaces a directory squatting on a structure path", () => {
    const root = emptyRepo("write-dirsquat");
    mkdirSync(path.join(artifactDir(root), "INDEX.md/inner"), { recursive: true });
    writeFileSync(path.join(artifactDir(root), "INDEX.md/inner/junk.txt"), "junk\n");

    const result = writeArtifacts(root, artifacts);

    expect(result.written).toContain("INDEX.md");
    expect(statSync(path.join(artifactDir(root), "INDEX.md")).isFile()).toBe(true);
    expect(readFileSync(path.join(artifactDir(root), "INDEX.md"), "utf8")).toBe(artifacts.get("INDEX.md") as string);
  });

  test("prunes a directory squatting on a structure path the map no longer produces", () => {
    const root = emptyRepo("write-dirsquat-prune");
    writeArtifacts(root, artifacts);
    rmSync(path.join(artifactDir(root), CARD));
    mkdirSync(path.join(artifactDir(root), CARD), { recursive: true });
    writeFileSync(path.join(artifactDir(root), CARD, "junk.txt"), "junk\n");

    const without = new Map(artifacts);
    without.delete(CARD);
    const result = writeArtifacts(root, without);

    expect(result.deleted).toEqual([CARD]);
    expect(existsSync(path.join(artifactDir(root), CARD))).toBe(false);
  });

  test("replaces a file squatting where an artifact directory belongs", () => {
    const root = emptyRepo("write-filesquat");
    mkdirSync(artifactDir(root), { recursive: true });
    writeFileSync(path.join(artifactDir(root), "repo"), "not a directory\n");

    const result = writeArtifacts(root, artifacts);

    expect(result.written).toContain("repo/MAP.md");
    expect(readFileSync(path.join(artifactDir(root), "repo/MAP.md"), "utf8")).toBe(
      artifacts.get("repo/MAP.md") as string,
    );
  });

  test("replaces a file squatting on the artifact directory itself", () => {
    const root = emptyRepo("write-rootsquat");
    writeFileSync(artifactDir(root), "not a directory\n");

    writeArtifacts(root, artifacts);

    expect(listFiles(artifactDir(root))).toEqual([...artifacts.keys()].sort(compareStrings));
  });

  test("replaces a symlink at a structure path instead of writing through it", () => {
    const root = emptyRepo("write-symlink");
    const outside = path.join(root, "outside.md");
    writeFileSync(outside, "untouched\n");
    mkdirSync(artifactDir(root), { recursive: true });
    symlinkSync(outside, path.join(artifactDir(root), "INDEX.md"));

    writeArtifacts(root, artifacts);

    expect(readFileSync(outside, "utf8")).toBe("untouched\n");
    expect(lstatSync(path.join(artifactDir(root), "INDEX.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(artifactDir(root), "INDEX.md"), "utf8")).toBe(artifacts.get("INDEX.md") as string);
  });

  test("refuses a map key that is not a structure path", () => {
    const root = emptyRepo("write-reject");
    for (const bad of ["../escape.md", "config.json", "cache/summaries.json", "/INDEX.md", "a\\b.md"]) {
      expect(() => writeArtifacts(root, new Map([[bad, "x"]]))).toThrow(/greplost: /);
      expect(existsSync(path.join(root, "..", "escape.md"))).toBe(false);
    }
  });

  test("writes nothing at all outside .greplost/", () => {
    const root = emptyRepo("write-contained");
    writeFileSync(path.join(root, "sentinel.txt"), "sentinel\n");
    writeArtifacts(root, artifacts);

    expect(readdirSync(root).sort(compareStrings)).toEqual([".greplost", "sentinel.txt"]);
  });

  test("an unreadable existing artifact is rewritten rather than compared", () => {
    const root = emptyRepo("write-unreadable");
    writeArtifacts(root, artifacts);
    const target = path.join(artifactDir(root), "INDEX.md");
    chmodSync(target, 0o000);
    try {
      const result = writeArtifacts(root, artifacts);
      expect(result.written).toContain("INDEX.md");
      expect(readFileSync(target, "utf8")).toBe(artifacts.get("INDEX.md") as string);
    } finally {
      chmodSync(target, 0o644);
    }
  });
});
