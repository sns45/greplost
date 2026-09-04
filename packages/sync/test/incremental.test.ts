/**
 * greplost:sync incremental update tests (leaf 1.3.2, tech spec 8, sync spec
 * "Update", "Dirty file", "Init").
 *
 * The claim these tests exist to defend is the one the whole product rests on:
 * an incremental update and a full rebuild produce the same `.greplost/`, byte
 * for byte. Incremental is therefore never a different map — only a cheaper
 * route to the same one — and "the map is always in sync" survives contact
 * with the fast path.
 *
 * Everything runs on a temp copy of `fixtures/tiny-ts` with a real git
 * repository around it, because the dirty set, the clean fast path and
 * `lastIndexedCommit` are all defined in terms of git and none of them can be
 * exercised honestly without it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ARTIFACT_DIR, DEFAULT_CONFIG, SCHEMA_VERSION, stableStringify } from "@greplost/core/schema";
import type { FileRecord, GreplostConfig } from "@greplost/core/schema";

import { appendDirty, readAndClearDirty } from "../src/dirty.ts";
import { HOOK_NAMES } from "../src/githooks.ts";
import { update } from "../src/incremental.ts";
import { init } from "../src/init.ts";
import {
  FileParseCache,
  PARSE_CACHE_STAMP,
  PARSE_CACHE_VERSION,
  PARSE_CACHE_VERSION_KEY,
  parseCacheKey,
} from "../src/parse-cache.ts";
import { readState, writeState } from "../src/state.ts";
import { verify } from "../src/verify.ts";

const FIXTURE_ROOT = path.resolve(import.meta.dir, "../../../fixtures/tiny-ts");
const GO_FIXTURE_ROOT = path.resolve(import.meta.dir, "../../../fixtures/tiny-go");

/** Source files in the fixture, and so the size of a cold build. */
const FIXTURE_SOURCES = 12;

const QUEUE_SOURCE = "packages/core/src/queue.ts";
const WORKER_CONFIG_SOURCE = "apps/worker/src/config.ts";
const WORKER_CONFIG_CARD = "packages/worker/modules/src/config.ts.md";

/** Files under `.greplost/` that are per-machine or per-run by definition. */
const RUNTIME_FILES = new Set([".lock", ".dirty", ".state.json"]);

const temporaries: string[] = [];

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (run.error !== undefined || run.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${run.stderr ?? run.error?.message ?? ""}`);
  }
  return run.stdout;
}

/** A temp copy of the fixture, no git, no `.greplost/`. */
function copyFixture(label: string, source: string = FIXTURE_ROOT): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-inc-${label}-`));
  temporaries.push(dir);
  const root = path.join(dir, "repo");
  cpSync(source, root, { recursive: true });
  return root;
}

/** A temp copy of the fixture as a git repository with one commit. */
function gitFixture(label: string): string {
  const root = copyFixture(label);
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "fixture",
  ]);
  return root;
}

function head(root: string): string {
  return git(root, ["rev-parse", "HEAD"]).trim();
}

function artifact(root: string, rel: string): string {
  return path.join(root, ARTIFACT_DIR, rel);
}

/** Append an import so a source file's bytes (and so its sha256) change. */
function editSource(root: string, rel: string): void {
  const file = path.join(root, rel);
  writeFileSync(file, `${readFileSync(file, "utf8")}\nexport const TOUCHED = 1;\n`);
}

/** Every file under `.greplost/`, keyed by artifact-relative path. */
function tree(root: string, skip: ReadonlySet<string> = RUNTIME_FILES): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (skip.has(rel)) continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else found.set(rel, readFileSync(path.join(dir, entry.name), "utf8"));
    }
  };
  walk(path.join(root, ARTIFACT_DIR), "");
  return found;
}

/** The parse cache as stored, minus the version sentinel. */
function storedRecords(root: string): Record<string, unknown> {
  const stored = JSON.parse(readFileSync(artifact(root, "cache/parse.json"), "utf8")) as Record<string, unknown>;
  expect(stored[PARSE_CACHE_VERSION_KEY]).toBe(PARSE_CACHE_STAMP);
  const { [PARSE_CACHE_VERSION_KEY]: _stamp, ...records } = stored;
  return records;
}

function record(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    path: "packages/core/src/a.ts",
    lang: "ts",
    sha256: "a".repeat(64),
    loc: 2,
    decls: [
      {
        id: "packages/core/src/a.ts#a",
        file: "packages/core/src/a.ts",
        name: "a",
        kind: "function",
        signature: "export function a(): void",
        exported: true,
        span: [1, 2],
      },
    ],
    imports: [],
    exports: [{ name: "a", kind: "named" }],
    calls: [],
    ...overrides,
  };
}

describe("equivalence", () => {
  let incrementalRoot: string;
  let fullRoot: string;

  beforeAll(async () => {
    // Same checkout, same edit, two routes to the map: one that indexed the
    // repo before the edit and updated incrementally, one that only ever saw
    // the edited state and rebuilt from scratch.
    incrementalRoot = gitFixture("equiv-incremental");
    await init(incrementalRoot, { hooks: false, quiet: true });
    editSource(incrementalRoot, QUEUE_SOURCE);
    await update(incrementalRoot, { mode: "incremental", quiet: true });

    fullRoot = gitFixture("equiv-full");
    editSource(fullRoot, QUEUE_SOURCE);
    await init(fullRoot, { hooks: false, quiet: true });
    // Three full builds and three git repositories: well inside a second on a
    // quiet machine, but not inside bun's default hook timeout on a busy one.
  }, 120_000);

  test("an incremental update and a full build produce the same .greplost/ tree", () => {
    const incremental = tree(incrementalRoot);
    const full = tree(fullRoot);

    expect([...incremental.keys()].sort()).toEqual([...full.keys()].sort());
    expect(incremental.size).toBeGreaterThan(20);
    for (const [rel, contents] of incremental) {
      expect(`${rel}:\n${contents}`).toBe(`${rel}:\n${full.get(rel) as string}`);
    }
  });

  test("the parse cache each route leaves behind is the same too", () => {
    expect(readFileSync(artifact(incrementalRoot, "cache/parse.json"), "utf8")).toBe(
      readFileSync(artifact(fullRoot, "cache/parse.json"), "utf8"),
    );
  });

  test("each repo records its own HEAD", () => {
    expect(readState(incrementalRoot).lastIndexedCommit).toBe(head(incrementalRoot));
    expect(readState(fullRoot).lastIndexedCommit).toBe(head(fullRoot));
  });

  test("a full update straight after an incremental one writes nothing", async () => {
    const result = await update(incrementalRoot, { mode: "full", quiet: true });

    expect(result.mode).toBe("full");
    expect(result.skipped).toBeUndefined();
    expect(result.written).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.reparsed).toBe(FIXTURE_SOURCES);
    expect(result.cached).toBe(0);
  });

  test("the map an incremental update leaves behind verifies", async () => {
    const result = await verify(incrementalRoot, { diff: true });
    expect(result.diff).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  test("a locked repo is skipped without touching the map", async () => {
    const root = gitFixture("locked");
    await init(root, { hooks: false, quiet: true });
    const before = tree(root);
    writeFileSync(artifact(root, ".lock"), JSON.stringify({ pid: process.pid, ts: Date.now() }));
    editSource(root, QUEUE_SOURCE);
    appendDirty(root, [QUEUE_SOURCE]);

    const result = await update(root, { mode: "incremental", quiet: true });

    expect(result.skipped).toBe("locked");
    expect(result.written).toBe(0);
    expect(result.dirty).toBe(0);
    expect(tree(root)).toEqual(before);
    // The dirty file must survive a skipped run: the work is deferred to the
    // next trigger, not lost.
    expect(readFileSync(artifact(root, ".dirty"), "utf8")).toContain(QUEUE_SOURCE);

    // The holder crashed: its lock is now stale, and the deferred work happens.
    writeFileSync(
      artifact(root, ".lock"),
      JSON.stringify({ pid: process.pid, ts: Date.now() - 120_000 }),
    );
    const next = await update(root, { mode: "incremental", quiet: true });
    expect(next.skipped).toBeUndefined();
    expect(next.reparsed).toBe(1);
  });
});

describe("dirty", () => {
  test("a second run on a clean repo is skipped", async () => {
    const root = gitFixture("clean");
    await init(root, { hooks: false, quiet: true });

    const result = await update(root, { mode: "incremental", quiet: true });

    expect(result.skipped).toBe("clean");
    expect(result.mode).toBe("incremental");
    expect(result.dirty).toBe(0);
    expect(result.written).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.reparsed).toBe(0);
    expect(result.cached).toBe(0);
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  test("an untracked .greplost/ does not make the repo look dirty", async () => {
    const root = gitFixture("untracked-artifacts");
    await init(root, { hooks: false, quiet: true });

    // git genuinely reports the artifact directory as untracked...
    expect(git(root, ["status", "--porcelain"])).toContain(ARTIFACT_DIR);
    // ...and the update must still see a clean tree.
    expect((await update(root, { mode: "incremental", quiet: true })).skipped).toBe("clean");
  });

  test("consumes the dirty file and clears it", async () => {
    const root = gitFixture("consume");
    await init(root, { hooks: false, quiet: true });
    appendDirty(root, [QUEUE_SOURCE]);
    expect(existsSync(artifact(root, ".dirty"))).toBe(true);

    const result = await update(root, { mode: "incremental", quiet: true });

    expect(result.skipped).toBeUndefined();
    expect(result.dirty).toBe(1);
    // Nothing actually changed on disk, so every file came from the cache and
    // no artifact was rewritten.
    expect(result.reparsed).toBe(0);
    expect(result.cached).toBe(FIXTURE_SOURCES);
    expect(result.written).toBe(0);
    expect(existsSync(artifact(root, ".dirty"))).toBe(false);

    // A build driven by a dirty signal cannot claim its tree matched HEAD, so
    // the next run rebuilds once to confirm (writing nothing) before the fast
    // path is available again. One wasted rebuild is the price of never
    // trusting a commit that describes a tree the map was not built from.
    const confirming = await update(root, { mode: "incremental", quiet: true });
    expect(confirming.skipped).toBeUndefined();
    expect(confirming.written).toBe(0);
    expect((await update(root, { mode: "incremental", quiet: true })).skipped).toBe("clean");
  });

  test("after editing one file, one file is reparsed and the rest come from the cache", async () => {
    const root = gitFixture("edit-one");
    await init(root, { hooks: false, quiet: true });
    editSource(root, QUEUE_SOURCE);

    const result = await update(root, { mode: "incremental", quiet: true });

    expect(result.reparsed).toBe(1);
    expect(result.cached).toBe(FIXTURE_SOURCES - 1);
    expect(result.dirty).toBeGreaterThanOrEqual(1);
    expect(result.written).toBeGreaterThan(0);
    expect(result.skipped).toBeUndefined();
  });

  test("prunes the card of a source file that was deleted", async () => {
    const root = gitFixture("deleted");
    await init(root, { hooks: false, quiet: true });
    expect(existsSync(artifact(root, WORKER_CONFIG_CARD))).toBe(true);
    rmSync(path.join(root, WORKER_CONFIG_SOURCE));

    const result = await update(root, { mode: "incremental", quiet: true });

    expect(result.dirty).toBeGreaterThanOrEqual(1);
    expect(result.deleted).toBe(1);
    expect(existsSync(artifact(root, WORKER_CONFIG_CARD))).toBe(false);
    expect(result.reparsed).toBe(0);
    expect(result.cached).toBe(FIXTURE_SOURCES - 1);
    expect((await verify(root)).ok).toBe(true);
  });

  test("opts.files joins the dirty set", async () => {
    const root = gitFixture("opts-files");
    await init(root, { hooks: false, quiet: true });

    const result = await update(root, { mode: "incremental", files: [QUEUE_SOURCE], quiet: true });

    expect(result.skipped).toBeUndefined();
    expect(result.dirty).toBe(1);
  });

  test("a full update consumes the dirty file too, and never reports clean", async () => {
    const root = gitFixture("full-consumes");
    await init(root, { hooks: false, quiet: true });
    appendDirty(root, [QUEUE_SOURCE]);

    const result = await update(root, { mode: "full", quiet: true });

    expect(result.skipped).toBeUndefined();
    expect(result.mode).toBe("full");
    expect(result.dirty).toBe(0);
    expect(existsSync(artifact(root, ".dirty"))).toBe(false);
  });

  test("outside a git repository every run rebuilds", async () => {
    const root = copyFixture("nogit");

    const first = await update(root, { mode: "incremental", quiet: true });
    const second = await update(root, { mode: "incremental", quiet: true });

    expect(first.skipped).toBeUndefined();
    expect(second.skipped).toBeUndefined();
    expect(second.written).toBe(0);
    expect(second.cached).toBe(FIXTURE_SOURCES);
    expect(readState(root).lastIndexedCommit).toBeUndefined();
  });

  test("a map built from a dirty tree is not trusted once the tree is reverted", async () => {
    const root = gitFixture("reverted");
    await init(root, { hooks: false, quiet: true });
    editSource(root, QUEUE_SOURCE);

    const indexedDirty = await update(root, { mode: "incremental", quiet: true });
    expect(indexedDirty.written).toBeGreaterThan(0);
    // The map now describes bytes that are in no commit, and the state file
    // says so.
    expect(readState(root).lastIndexedCommit).toBe(head(root));
    expect(readState(root).treeClean).toBe(false);

    // The user throws the edit away. HEAD never moved, the tree is clean again
    // and the dirty queue was consumed by the run above: nothing except the
    // recorded treeClean can tell that the map is now wrong.
    git(root, ["checkout", "--", "."]);
    expect(git(root, ["status", "--porcelain", "--untracked-files=no"])).toBe("");

    const repair = await update(root, { mode: "incremental", quiet: true });

    expect(repair.skipped).toBeUndefined();
    expect(repair.written).toBeGreaterThan(0);
    expect((await verify(root)).ok).toBe(true);
    // And having indexed a tree that matches HEAD, it may say so.
    expect(readState(root).treeClean).toBe(true);
    expect((await update(root, { mode: "incremental", quiet: true })).skipped).toBe("clean");
  });

  test("indexes a new untracked directory, which git reports as one collapsed entry", async () => {
    const root = gitFixture("untracked-package");
    await init(root, { hooks: false, quiet: true });

    const source = "packages/newpkg/src/thing.ts";
    const other = "packages/newpkg/src/other.ts";
    mkdirSync(path.join(root, "packages/newpkg/src"), { recursive: true });
    writeFileSync(path.join(root, "packages/newpkg/package.json"), `{ "name": "tiny-new", "version": "0.0.0" }\n`);
    writeFileSync(path.join(root, source), "export function thing(): number {\n  return 1;\n}\n");
    writeFileSync(path.join(root, other), "export const other = 2;\n");

    // Porcelain collapses the whole subtree to `packages/newpkg/` by default —
    // a path with no extension, no discovery entry and no manifest entry, which
    // every filter would drop.
    expect(git(root, ["status", "--porcelain"])).toContain("packages/newpkg/");

    const result = await update(root, { mode: "incremental", quiet: true });

    expect(result.skipped).toBeUndefined();
    // Both new sources, individually: the collapsed directory entry would have
    // been one candidate, not two, and `package.json` is not indexable.
    expect(result.dirty).toBe(2);
    expect(result.reparsed).toBe(2);
    expect(result.cached).toBe(FIXTURE_SOURCES);
    const manifest = JSON.parse(readFileSync(artifact(root, "manifest.json"), "utf8")) as {
      files: Record<string, unknown>;
    };
    expect(Object.keys(manifest.files)).toContain(source);
    expect(Object.keys(manifest.files)).toContain(other);
    expect((await verify(root)).ok).toBe(true);
    // Uncommitted, so the map still describes something no commit contains.
    expect(readState(root).treeClean).toBe(false);

    git(root, ["add", "packages/newpkg"]);
    git(root, ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "new"]);

    // HEAD moved, so one rebuild — and now the tree does match its commit.
    expect((await update(root, { mode: "incremental", quiet: true })).skipped).toBeUndefined();
    expect(readState(root).treeClean).toBe(true);
    expect((await update(root, { mode: "incremental", quiet: true })).skipped).toBe("clean");
  });

  test("a change to the config invalidates the fast path", async () => {
    const root = gitFixture("config-change");
    await init(root, { hooks: false, quiet: true });
    expect((await update(root, { mode: "incremental", quiet: true })).skipped).toBe("clean");

    // Nothing about this is visible to git: config.json lives inside the
    // artifact directory, which is filtered out of the dirty set by definition.
    const config = JSON.parse(readFileSync(artifact(root, "config.json"), "utf8")) as GreplostConfig;
    writeFileSync(
      artifact(root, "config.json"),
      `${stableStringify({ ...config, exclude: [...config.exclude, "**/adapters/**"] }, 2)}\n`,
    );

    const result = await update(root, { mode: "incremental", quiet: true });

    expect(result.skipped).toBeUndefined();
    // The adapters sources are no longer part of the map, so their cards go.
    expect(result.deleted).toBeGreaterThan(0);
    expect(existsSync(artifact(root, "packages/tiny__adapters/modules/src/sqs.ts.md"))).toBe(false);
    expect((await verify(root)).ok).toBe(true);
    expect((await update(root, { mode: "incremental", quiet: true })).skipped).toBe("clean");
  });

  test("churn that could never be indexed does not defeat the fast path", async () => {
    const root = gitFixture("irrelevant-churn");
    await init(root, { hooks: false, quiet: true });

    // Neither of these can change a byte of the map: one has no language, the
    // other lives under a `config.exclude` glob.
    writeFileSync(path.join(root, ".env.local"), "SECRET=1\n");
    mkdirSync(path.join(root, "dist"), { recursive: true });
    writeFileSync(path.join(root, "dist/index.js"), "export const built = 1;\n");
    // Staged, so status names the file rather than collapsing to `dist/`, and
    // the exclude glob is what has to reject it.
    git(root, ["add", "dist/index.js"]);

    const status = git(root, ["status", "--porcelain"]);
    expect(status).toContain(".env.local");
    expect(status).toContain("dist/index.js");

    const result = await update(root, { mode: "incremental", quiet: true });

    expect(result.skipped).toBe("clean");
    expect(result.dirty).toBe(0);
  });

  test("sweeps temporaries left behind by a writer that was killed", async () => {
    const root = gitFixture("temporaries");
    await init(root, { hooks: false, quiet: true });
    const residue = artifact(root, ".INDEX.md.999999.0.tmp");
    const inFlight = artifact(root, `.INDEX.md.${process.pid}.0.tmp`);
    writeFileSync(residue, "half an artifact");
    writeFileSync(inFlight, "mid-rename");

    // Nothing is dirty, so this run takes the fast path — and must still sweep,
    // or a repository that stays clean keeps the residue in its status forever.
    const result = await update(root, { mode: "incremental", quiet: true });

    expect(result.skipped).toBe("clean");
    expect(existsSync(residue)).toBe(false);
    // A temporary this process owns may be between its write and its rename.
    expect(existsSync(inFlight)).toBe(true);
    // Neither is a structure path, so neither was ever the map's business.
    expect((await verify(root)).ok).toBe(true);
  });

  test("sees both sides of a git rename", async () => {
    const root = gitFixture("renamed");
    await init(root, { hooks: false, quiet: true });
    git(root, ["mv", QUEUE_SOURCE, "packages/core/src/queue-renamed.ts"]);

    const result = await update(root, { mode: "incremental", quiet: true });

    expect(result.dirty).toBe(2);
    // The bytes moved, not the content: the rename is a cache hit, the old
    // card is pruned and a new one takes its place.
    expect(result.reparsed).toBe(0);
    expect(result.cached).toBe(FIXTURE_SOURCES);
    expect(result.deleted).toBe(1);
    expect(existsSync(artifact(root, "packages/tiny__core/modules/src/queue.ts.md"))).toBe(false);
    expect(existsSync(artifact(root, "packages/tiny__core/modules/src/queue-renamed.ts.md"))).toBe(true);
    expect((await verify(root)).ok).toBe(true);
  });

  test("recovers a queue abandoned by a run that was killed", () => {
    const root = copyFixture("abandoned");
    mkdirSync(path.join(root, ARTIFACT_DIR), { recursive: true });
    // What a `kill -9` between the hand-off rename and the read leaves behind.
    writeFileSync(artifact(root, ".dirty.taken"), `${WORKER_CONFIG_SOURCE}\n`);
    appendDirty(root, [QUEUE_SOURCE]);

    expect(readAndClearDirty(root)).toEqual([WORKER_CONFIG_SOURCE, QUEUE_SOURCE].sort());
    expect(existsSync(artifact(root, ".dirty.taken"))).toBe(false);
    expect(existsSync(artifact(root, ".dirty"))).toBe(false);
    expect(readAndClearDirty(root)).toEqual([]);
  });

  test("keeps a path whose name merely starts with two dots", () => {
    const root = copyFixture("dotdot");
    mkdirSync(path.join(root, ARTIFACT_DIR), { recursive: true });

    appendDirty(root, ["..config.ts", path.join(root, "src/..hidden.ts")]);

    expect(readAndClearDirty(root)).toEqual(["..config.ts", "src/..hidden.ts"]);
  });

  test("ignores paths that are not inside the repo", () => {
    const root = copyFixture("outside");
    mkdirSync(path.join(root, ARTIFACT_DIR), { recursive: true });

    appendDirty(root, [
      "/etc/passwd",
      "../sibling/file.ts",
      "../../escape.ts",
      "",
      "   ",
      `${ARTIFACT_DIR}/INDEX.md`,
      path.join(root, QUEUE_SOURCE),
    ]);

    // Only the two legitimate forms survive, and the absolute one is
    // normalised back to a repo-relative path.
    expect(readAndClearDirty(root)).toEqual([QUEUE_SOURCE]);
  });

  test("reads a dirty file written with CRLF line endings", () => {
    const root = copyFixture("crlf");
    mkdirSync(path.join(root, ARTIFACT_DIR), { recursive: true });
    writeFileSync(
      artifact(root, ".dirty"),
      `${QUEUE_SOURCE}\r\n./${WORKER_CONFIG_SOURCE}\r\n${QUEUE_SOURCE}\r\n\r\n`,
    );

    // Unique, sorted, repo-relative, with the carriage returns gone.
    expect(readAndClearDirty(root)).toEqual([WORKER_CONFIG_SOURCE, QUEUE_SOURCE].sort());
    expect(existsSync(artifact(root, ".dirty"))).toBe(false);
    expect(readAndClearDirty(root)).toEqual([]);
  });

  test("appending is O(1) and does not read the file back", () => {
    const root = copyFixture("append");
    mkdirSync(path.join(root, ARTIFACT_DIR), { recursive: true });

    appendDirty(root, [QUEUE_SOURCE]);
    appendDirty(root, [WORKER_CONFIG_SOURCE]);
    appendDirty(root, [QUEUE_SOURCE]);

    const raw = readFileSync(artifact(root, ".dirty"), "utf8");
    expect(raw.split("\n").filter((line) => line !== "")).toHaveLength(3);
    expect(readAndClearDirty(root)).toEqual([WORKER_CONFIG_SOURCE, QUEUE_SOURCE].sort());
  });

  test("appendDirty creates .greplost/ when the repo has never been indexed", () => {
    const root = copyFixture("append-fresh");

    appendDirty(root, [QUEUE_SOURCE]);

    expect(readAndClearDirty(root)).toEqual([QUEUE_SOURCE]);
  });
});

describe("parse cache", () => {
  test("round-trips a record through disk and hands it back frozen", () => {
    const root = copyFixture("cache-roundtrip");
    const written = new FileParseCache(root);
    written.set(record());
    written.save();

    expect(existsSync(artifact(root, "cache/parse.json"))).toBe(true);

    const read = new FileParseCache(root);
    read.load();
    const hit = read.get("a".repeat(64), "ts");

    expect(hit).toEqual(record());
    expect(Object.isFrozen(hit)).toBe(true);
    expect(Object.isFrozen(hit?.decls)).toBe(true);
    expect(Object.isFrozen(hit?.imports)).toBe(true);
    expect(Object.isFrozen(hit?.exports)).toBe(true);
    expect(Object.isFrozen(hit?.calls)).toBe(true);
  });

  test("is keyed by language as well as content", () => {
    const root = copyFixture("cache-lang");
    const cache = new FileParseCache(root);
    cache.set(record({ lang: "ts" }));
    cache.save();

    const read = new FileParseCache(root);
    expect(read.get("a".repeat(64), "ts")).toBeDefined();
    expect(read.get("a".repeat(64), "tsx")).toBeUndefined();
    expect(read.get("b".repeat(64), "ts")).toBeUndefined();
  });

  test("save prunes entries the current build no longer uses", () => {
    const root = copyFixture("cache-prune");
    const cache = new FileParseCache(root);
    const kept = record({ sha256: "a".repeat(64) });
    const dropped = record({ sha256: "b".repeat(64), path: "packages/core/src/b.ts" });
    cache.set(kept);
    cache.set(dropped);
    cache.save();
    expect(Object.keys(storedRecords(root))).toHaveLength(2);

    const second = new FileParseCache(root);
    second.load();
    second.save(new Set([parseCacheKey(kept.sha256, kept.lang)]));

    const third = new FileParseCache(root);
    expect(third.get(kept.sha256, "ts")).toBeDefined();
    expect(third.get(dropped.sha256, "ts")).toBeUndefined();
  });

  test("an update leaves one entry per source file", async () => {
    const root = gitFixture("cache-update");
    await init(root, { hooks: false, quiet: true });

    const stored = storedRecords(root);
    expect(Object.keys(stored)).toHaveLength(FIXTURE_SOURCES);
    // Stable JSON: keys sorted, so the cache does not churn in a diff.
    expect(Object.keys(stored)).toEqual([...Object.keys(stored)].sort());
  });

  test("an update after the cache is wiped reparses everything", async () => {
    const root = gitFixture("cache-wiped");
    await init(root, { hooks: false, quiet: true });
    rmSync(artifact(root, "cache/parse.json"));
    appendDirty(root, [QUEUE_SOURCE]);

    const result = await update(root, { mode: "incremental", quiet: true });

    expect(result.reparsed).toBe(FIXTURE_SOURCES);
    expect(result.cached).toBe(0);
    expect(result.written).toBe(0);
    expect(existsSync(artifact(root, "cache/parse.json"))).toBe(true);
  });

  test("treats a corrupt cache as an empty one", async () => {
    const root = gitFixture("cache-corrupt");
    await init(root, { hooks: false, quiet: true });
    writeFileSync(artifact(root, "cache/parse.json"), "{ this is not json");
    appendDirty(root, [QUEUE_SOURCE]);

    const result = await update(root, { mode: "incremental", quiet: true });

    expect(result.reparsed).toBe(FIXTURE_SOURCES);
    expect(result.cached).toBe(0);
    // And the corruption is gone, not carried forward.
    expect(Object.keys(storedRecords(root))).toHaveLength(FIXTURE_SOURCES);
  });

  test("ignores an entry whose key does not match the record it holds", () => {
    const root = copyFixture("cache-tampered");
    mkdirSync(artifact(root, "cache"), { recursive: true });
    writeFileSync(
      artifact(root, "cache/parse.json"),
      stableStringify({
        [PARSE_CACHE_VERSION_KEY]: PARSE_CACHE_STAMP,
        [parseCacheKey("c".repeat(64), "ts")]: record({ sha256: "a".repeat(64) }),
        [parseCacheKey("a".repeat(64), "tsx")]: record({ sha256: "a".repeat(64), lang: "ts" }),
        [parseCacheKey("a".repeat(64), "ts")]: record({ sha256: "a".repeat(64) }),
        "not-a-key": record(),
        "ts:short": 7,
      }),
    );

    const cache = new FileParseCache(root);
    expect(cache.get("c".repeat(64), "ts")).toBeUndefined();
    expect(cache.get("a".repeat(64), "tsx")).toBeUndefined();
    expect(cache.get("a".repeat(64), "ts")).toBeDefined();
  });

  test("discards a cache written by a different extractor generation", () => {
    const root = copyFixture("cache-version");
    mkdirSync(artifact(root, "cache"), { recursive: true });
    const entries = { [parseCacheKey("a".repeat(64), "ts")]: record() };

    writeFileSync(
      artifact(root, "cache/parse.json"),
      stableStringify({ [PARSE_CACHE_VERSION_KEY]: "0/0", ...entries }),
    );
    expect(new FileParseCache(root).get("a".repeat(64), "ts")).toBeUndefined();

    // And one written before the stamp existed at all.
    writeFileSync(artifact(root, "cache/parse.json"), stableStringify(entries));
    expect(new FileParseCache(root).get("a".repeat(64), "ts")).toBeUndefined();

    // Saving replaces it with a stamped cache rather than merging into it.
    const cache = new FileParseCache(root);
    cache.set(record({ sha256: "b".repeat(64) }));
    cache.save();
    expect(Object.keys(storedRecords(root))).toEqual([parseCacheKey("b".repeat(64), "ts")]);
  });

  test("a cache written under the previous extractor generation is ignored", () => {
    // Build 2 leaf 2.3 turned the TypeScript signal passes on, so unchanged bytes now yield
    // `component.*` / `route.*` / `resource.*` nodes and `refs` that generation 1 never wrote.
    // A generation-1 cache is therefore wrong rather than merely old, and must be discarded.
    expect(PARSE_CACHE_VERSION).not.toBe("1");
    const previous = `${SCHEMA_VERSION}/1`;
    expect(PARSE_CACHE_STAMP).not.toBe(previous);

    const root = copyFixture("cache-previous-generation");
    mkdirSync(artifact(root, "cache"), { recursive: true });
    writeFileSync(
      artifact(root, "cache/parse.json"),
      stableStringify({
        [PARSE_CACHE_VERSION_KEY]: previous,
        [parseCacheKey("a".repeat(64), "ts")]: record(),
      }),
    );

    expect(new FileParseCache(root).get("a".repeat(64), "ts")).toBeUndefined();
    expect(new FileParseCache(root).size).toBe(0);
  });

  test("an update against a stale stamp reparses everything", async () => {
    const root = gitFixture("cache-stamped");
    await init(root, { hooks: false, quiet: true });
    const stored = JSON.parse(readFileSync(artifact(root, "cache/parse.json"), "utf8")) as Record<string, unknown>;
    stored[PARSE_CACHE_VERSION_KEY] = "0/0";
    writeFileSync(artifact(root, "cache/parse.json"), stableStringify(stored));
    appendDirty(root, [QUEUE_SOURCE]);

    const result = await update(root, { mode: "incremental", quiet: true });

    expect(result.reparsed).toBe(FIXTURE_SOURCES);
    expect(result.cached).toBe(0);
    expect(result.written).toBe(0);
    // storedRecords asserts the stamp is the current one again.
    expect(Object.keys(storedRecords(root))).toHaveLength(FIXTURE_SOURCES);
  });

  test("never hands the same object to two builds unfrozen", async () => {
    const root = gitFixture("cache-immutable");
    await init(root, { hooks: false, quiet: true });

    const cache = new FileParseCache(root);
    cache.load();
    const stored = storedRecords(root) as Record<string, FileRecord>;
    const key = Object.keys(stored)[0] as string;
    const entry = stored[key] as FileRecord;
    const hit = cache.get(entry.sha256, entry.lang);

    expect(hit).toBeDefined();
    expect(Object.isFrozen(hit)).toBe(true);
    expect(() => {
      (hit as { loc: number }).loc = -1;
    }).toThrow();
  });
});

describe("init", () => {
  test("writes the config, the gitignore and a full map, and records HEAD", async () => {
    const root = gitFixture("init");

    const result = await init(root, { hooks: false, quiet: true });

    expect(result.created).toEqual([`${ARTIFACT_DIR}/config.json`, `${ARTIFACT_DIR}/.gitignore`]);
    expect(result.hooks).toEqual([]);

    expect(readFileSync(artifact(root, "config.json"), "utf8")).toBe(`${stableStringify(DEFAULT_CONFIG, 2)}\n`);
    expect(readFileSync(artifact(root, ".gitignore"), "utf8")).toBe(
      [".dirty*", ".lock", ".state.json", "cache/parse.json", "*.tmp", ""].join("\n"),
    );

    expect(result.update.mode).toBe("full");
    expect(result.update.skipped).toBeUndefined();
    expect(result.update.written).toBeGreaterThan(20);
    expect(result.update.reparsed).toBe(FIXTURE_SOURCES);

    expect(existsSync(artifact(root, "INDEX.md"))).toBe(true);
    expect(existsSync(artifact(root, "manifest.json"))).toBe(true);
    expect(readState(root).lastIndexedCommit).toBe(head(root));
    expect((await verify(root)).ok).toBe(true);
  });

  test("a second init creates nothing and rewrites nothing", async () => {
    const root = gitFixture("init-twice");
    await init(root, { hooks: false, quiet: true });

    const again = await init(root, { hooks: false, quiet: true });

    expect(again.created).toEqual([]);
    expect(again.update.written).toBe(0);
    expect(again.update.deleted).toBe(0);
  });

  test("leaves a config the user already wrote alone", async () => {
    const root = gitFixture("init-config");
    mkdirSync(path.join(root, ARTIFACT_DIR), { recursive: true });
    const custom = `${stableStringify({ ...DEFAULT_CONFIG, diagram: { maxNodes: 9, splitBy: "directory" } }, 2)}\n`;
    writeFileSync(artifact(root, "config.json"), custom);

    const result = await init(root, { hooks: false, quiet: true });

    expect(result.created).toEqual([`${ARTIFACT_DIR}/.gitignore`]);
    expect(readFileSync(artifact(root, "config.json"), "utf8")).toBe(custom);
  });

  test("completes an incomplete gitignore without duplicating what is there", async () => {
    const root = gitFixture("init-gitignore");
    mkdirSync(path.join(root, ARTIFACT_DIR), { recursive: true });
    writeFileSync(artifact(root, ".gitignore"), "# mine\n.lock\n");

    await init(root, { hooks: false, quiet: true });

    const lines = readFileSync(artifact(root, ".gitignore"), "utf8").split("\n");
    expect(lines[0]).toBe("# mine");
    expect(lines.filter((line) => line === ".lock")).toHaveLength(1);
    for (const entry of [".dirty*", ".lock", ".state.json", "cache/parse.json", "*.tmp"]) {
      expect(lines).toContain(entry);
    }
  });

  test("installs the git hooks unless told not to", async () => {
    const root = gitFixture("init-hooks");

    const result = await init(root, { quiet: true });

    expect(result.hooks).toEqual([...HOOK_NAMES]);
    for (const hook of HOOK_NAMES) {
      expect(existsSync(path.join(root, ".git", "hooks", hook))).toBe(true);
    }
  });

  test("works outside a git repository, hooks and all", async () => {
    const root = copyFixture("init-nogit");

    const result = await init(root, { quiet: true });

    expect(result.hooks).toEqual([]);
    expect(result.update.written).toBeGreaterThan(20);
    expect(existsSync(artifact(root, "INDEX.md"))).toBe(true);
    expect(readState(root).lastIndexedCommit).toBeUndefined();
  });

  /**
   * Go is a language greplost indexes and the README says so, but the default
   * language set is the TypeScript one, so `init` in a Go repository used to
   * write a config that matched nothing and then report a successful build of
   * an empty map. The rule is the simplest one that cannot be wrong: a `go.mod`
   * anywhere in the discovered file set adds `"go"` to the defaults, and the TS
   * languages stay, because a Go repository with a `tsconfig.json` in it is
   * ordinary and losing that half would be the same bug with the arguments
   * swapped.
   */
  test("adds go to the languages when the repo has a go.mod", async () => {
    const root = copyFixture("init-go", GO_FIXTURE_ROOT);

    const result = await init(root, { hooks: false, quiet: true });

    const config = JSON.parse(readFileSync(artifact(root, "config.json"), "utf8")) as GreplostConfig;
    expect(config.languages).toEqual([...DEFAULT_CONFIG.languages, "go"]);
    expect(result.update.reparsed).toBeGreaterThan(0);

    const manifest = JSON.parse(readFileSync(artifact(root, "manifest.json"), "utf8")) as {
      files: Record<string, { lang: string }>;
    };
    const langs = new Set(Object.values(manifest.files).map((file) => file.lang));
    expect([...langs]).toEqual(["go"]);
  });

  test("leaves the languages alone in a repo with no go.mod", async () => {
    const root = copyFixture("init-nogo");

    await init(root, { hooks: false, quiet: true });

    const config = JSON.parse(readFileSync(artifact(root, "config.json"), "utf8")) as GreplostConfig;
    expect(config.languages).toEqual([...DEFAULT_CONFIG.languages]);
  });

  /**
   * A build that indexes nothing exits 0 and writes a real (empty) map, which
   * is correct and completely opaque: the config is almost always the reason,
   * and nothing else was ever going to say so.
   */
  test("says so on stderr when a build indexes no files at all", async () => {
    const root = copyFixture("init-empty");
    rmSync(path.join(root, "packages"), { recursive: true, force: true });
    rmSync(path.join(root, "apps"), { recursive: true, force: true });

    const said: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]): void => {
      said.push(args.map((arg) => String(arg)).join(" "));
    };
    let result;
    try {
      result = await init(root, { hooks: false, quiet: true });
    } finally {
      console.error = error;
    }

    expect(result.update.reparsed).toBe(0);
    expect(said).toEqual([
      "greplost: no files indexed (check languages/include/exclude in .greplost/config.json)",
    ]);
  });
});

/**
 * The runtime files are inside `.greplost/` too (tech spec 7.2 containment).
 *
 * `.greplost/` is committed and git stores symlinks, so a repository can carry
 * `cache -> /tmp/anywhere` or `.state.json -> ~/.ssh/authorized_keys`, and the
 * `post-checkout` hook then runs `greplost update` over it unattended. The
 * artifact writer has always refused that; the parse cache and the state file
 * used to be written with a plain `mkdirSync` plus a write, which follows the
 * link. They now go through the same containment as everything else: a link on
 * the way is replaced by a real directory, a link at the path is replaced by a
 * real file, and nothing lands outside the repository.
 */
describe("containment of the runtime files", () => {
  /** A directory outside the repo, standing in for wherever a committed link points. */
  function outside(label: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), `greplost-outside-${label}-`));
    temporaries.push(dir);
    return dir;
  }

  test("a symlinked cache directory is replaced, not followed", () => {
    const root = copyFixture("cache-symlink");
    const target = outside("cache");
    mkdirSync(path.join(root, ARTIFACT_DIR), { recursive: true });
    symlinkSync(target, artifact(root, "cache"), "dir");

    const cache = new FileParseCache(root);
    cache.set(record());
    cache.save();

    expect(lstatSync(artifact(root, "cache")).isSymbolicLink()).toBe(false);
    expect(lstatSync(artifact(root, "cache")).isDirectory()).toBe(true);
    expect(existsSync(artifact(root, "cache/parse.json"))).toBe(true);
    expect(readdirSync(target)).toEqual([]);

    const read = new FileParseCache(root);
    read.load();
    expect(read.get("a".repeat(64), "ts")).toEqual(record());
  });

  test("a symlinked .state.json is replaced, not followed", () => {
    const root = copyFixture("state-symlink");
    const target = path.join(outside("state"), "victim.json");
    writeFileSync(target, "do not touch\n");
    mkdirSync(path.join(root, ARTIFACT_DIR), { recursive: true });
    symlinkSync(target, artifact(root, ".state.json"));

    writeState(root, { lastIndexedCommit: "a".repeat(40), treeClean: true });

    expect(lstatSync(artifact(root, ".state.json")).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("do not touch\n");
    expect(readState(root).lastIndexedCommit).toBe("a".repeat(40));
  });

  test("a symlinked cache directory survives a real update", async () => {
    const root = gitFixture("cache-symlink-update");
    const target = outside("update");
    mkdirSync(path.join(root, ARTIFACT_DIR), { recursive: true });
    symlinkSync(target, artifact(root, "cache"), "dir");

    await init(root, { hooks: false, quiet: true });

    expect(lstatSync(artifact(root, "cache")).isSymbolicLink()).toBe(false);
    expect(readdirSync(target)).toEqual([]);
    expect(Object.keys(storedRecords(root))).toHaveLength(FIXTURE_SOURCES);
  });
});

describe("dirty set containment", () => {
  test("a symlinked .dirty is replaced in place and never followed", async () => {
    const { mkdtempSync, mkdirSync, symlinkSync, lstatSync, readFileSync, writeFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = (await import("node:path")).default;
    const { appendDirty } = await import("../src/dirty.ts");
    const base = mkdtempSync(path.join(tmpdir(), "greplost-dirty-link-"));
    const root = path.join(base, "repo");
    const outside = path.join(base, "outside");
    mkdirSync(path.join(root, ".greplost"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    const victim = path.join(outside, "victim.txt");
    writeFileSync(victim, "ORIGINAL\n");
    symlinkSync(victim, path.join(root, ".greplost", ".dirty"));
    writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    appendDirty(root, [path.join(root, "a.ts")]);
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL\n");
    expect(lstatSync(path.join(root, ".greplost", ".dirty")).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(root, ".greplost", ".dirty"), "utf8")).toContain("a.ts");
    expect(existsSync(victim)).toBe(true);
  });
});
