/**
 * greplost:semantic tests (leaf 1.6, tech spec 4.1/6, semantic spec).
 *
 * Every test runs against a temp copy of `fixtures/tiny-ts` with a real
 * initialised map and an injected `PromptRunner`. Nothing here ever reaches the
 * `claude` binary: the runner is the seam the whole package is built around, so
 * exercising it with canned JSON exercises the real code path.
 *
 * The four describes are the gates: `zero calls` (a second refresh on an
 * unchanged repo is free), `stale` (one edit produces exactly one stale entry,
 * one banner and one call), `FLOWS` (the semantic document names the entry
 * point and carries its diagrams) and `safety` (dry runs and bad model output
 * change nothing, and a refresh never moves a structure-layer byte it does not
 * own).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSnapshot } from "@greplost/core";
import type { Manifest, PackageInfo, SummaryCache } from "@greplost/core/schema";
import { ARTIFACT_DIR, ARTIFACT_PATHS, compareStrings } from "@greplost/core/schema";
import { init, isStructurePath, update, withLock } from "@greplost/sync";

import { renderFlows, selectEntryPoints } from "../src/flows.ts";
import { ENTRY_PREFIX, FILE_PREFIX, FLOWS_TASK } from "../src/prompts.ts";
import { refresh, refreshCommand } from "../src/refresh.ts";
import type { Flow, PromptRunner, RefreshResult } from "../src/index.ts";

const FIXTURE = path.resolve(import.meta.dir, "../../../fixtures/tiny-ts");

/** Source files the fixture holds, and so the size of a first refresh. */
const FIXTURE_SOURCES = 12;

/** Source files in `@tiny/core`. */
const CORE_SOURCES = 7;

const RETRY_SOURCE = "packages/core/src/retry.ts";
const RETRY_CARD = "packages/tiny__core/modules/src/retry.ts.md";
const WORKER_ENTRY = "apps/worker/src/main.ts";
const WORKER_FLOWS = "packages/worker/FLOWS.md";

const TODAY = "2026-09-02";
const LATER = "2026-09-09";
const MODEL = "canned-model";

/**
 * Files that may appear or vanish under `.greplost/` at any instant: the
 * advisory lock and the dirty queue are both consumed by renaming them aside.
 * Never comparable, so never compared.
 */
const TRANSIENT = new Set([".lock", ".dirty"]);

/**
 * Machine-local files any `update` legitimately rewrites: the last-indexed
 * commit and the parse cache. Compared by default — a dry run must not touch
 * even these — and ignored only where a rebuild is the thing under test.
 */
const REBUILT = new Set([".state.json", "cache/parse.json"]);

const temporaries: string[] = [];

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/**
 * A temp copy of the fixture with a built map and no summaries yet. `seed` runs
 * against the copy before the first build, for tests that need a source file
 * the committed fixture does not carry.
 */
async function initialised(label: string, seed?: (dir: string) => void): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-semantic-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  temporaries.push(dir);
  if (seed !== undefined) seed(dir);
  await init(dir, { hooks: false, quiet: true });
  return dir;
}

/** The canned paragraph a runner answers with for one file. */
function canned(file: string): string {
  return `Canned intent for ${file}; it exists so nothing else has to care how this works.`;
}

const CANNED_FLOWS: Flow[] = [
  {
    title: "Worker startup",
    steps: [
      { file: WORKER_ENTRY, symbol: "main", note: "loads config and builds the registry" },
      { file: "apps/worker/src/config.ts", symbol: "loadConfig", note: "reads the queue settings" },
    ],
    mermaid: "sequenceDiagram\n  participant M as main\n  participant C as loadConfig\n  M->>C: loadConfig()",
  },
  {
    title: "Adapter registration",
    steps: [{ file: WORKER_ENTRY, symbol: "main", note: "registers the sqs and memory adapters" }],
    mermaid: "sequenceDiagram\n  participant M as main\n  participant R as Registry\n  M->>R: register(sqs)",
  },
  {
    title: "Publishing a message",
    steps: [{ file: WORKER_ENTRY, note: "publishes to every registered queue" }],
    mermaid: "sequenceDiagram\n  participant M as main\n  participant R as Registry\n  M->>R: publishAll(hello)",
  },
];

interface Recorder {
  calls: Array<{ prompt: string; model: string }>;
  /** Every file path a summary prompt asked about, in prompt order. */
  asked(): string[];
  runner: PromptRunner;
}

/** A runner that answers every prompt from the prompt itself, and remembers being asked. */
function recorder(options: { flows?: Flow[]; text?: (file: string) => string } = {}): Recorder {
  const calls: Array<{ prompt: string; model: string }> = [];
  const text = options.text ?? canned;
  return {
    calls,
    asked: () => calls.flatMap((call) => promptFiles(call.prompt)),
    runner: (prompt, opts) => {
      calls.push({ prompt, model: opts.model });
      if (prompt.includes(FLOWS_TASK)) return Promise.resolve(JSON.stringify(options.flows ?? CANNED_FLOWS));
      const answer: Record<string, string> = {};
      for (const file of promptFiles(prompt)) answer[file] = text(file);
      return Promise.resolve(JSON.stringify(answer));
    },
  };
}

/** The file paths a summary prompt lists, read back out of the prompt. */
function promptFiles(prompt: string): string[] {
  const files: string[] = [];
  for (const line of prompt.split("\n")) {
    if (line.startsWith(FILE_PREFIX)) files.push(line.slice(FILE_PREFIX.length).trim());
  }
  return files;
}

/** A runner that fails the test if anything reaches it. */
const forbiddenRunner: PromptRunner = () => {
  throw new Error("the runner must not be called");
};

function artifact(root: string, rel: string): string {
  return readFileSync(path.join(root, ARTIFACT_DIR, rel), "utf8");
}

function manifestOf(root: string): Manifest {
  return JSON.parse(artifact(root, ARTIFACT_PATHS.manifest)) as Manifest;
}

function cacheOf(root: string): SummaryCache {
  return JSON.parse(artifact(root, ARTIFACT_PATHS.summaries)) as SummaryCache;
}

/** Every comparable file under `.greplost/`, path -> bytes. */
function tree(root: string, opts: { ignoreRebuilt?: boolean } = {}): Map<string, string> {
  const dir = path.join(root, ARTIFACT_DIR);
  const out = new Map<string, string>();
  const walk = (current: string, prefix: string): void => {
    const entries = readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => compareStrings(a.name, b.name));
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (TRANSIENT.has(rel)) continue;
      if (opts.ignoreRebuilt === true && REBUILT.has(rel)) continue;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else out.set(rel, readFileSync(path.join(current, entry.name), "utf8"));
    }
  };
  walk(dir, "");
  return out;
}

/** Paths whose bytes differ between two trees, in either direction. */
function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((rel) => before.get(rel) !== after.get(rel)).sort(compareStrings);
}

async function packageOf(root: string, name: string): Promise<PackageInfo> {
  const snapshot = await buildSnapshot({ root });
  const pkg = snapshot.packages.find((candidate) => candidate.name === name);
  if (pkg === undefined) throw new Error(`no package ${name}`);
  return pkg;
}

/** Both streams of one `refreshCommand` call, plus the exit code it answered with. */
interface Captured {
  code: Promise<number>;
  out(): string;
  err(): string;
}

/**
 * Run a command function with `console.log`/`console.error` captured. The
 * streams are restored when the returned promise settles, so a caller reads
 * `out()` and `err()` after awaiting `code`.
 */
function capture(fn: () => Promise<number>): Captured {
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
  const code = fn().finally(() => {
    console.log = log;
    console.error = error;
  });
  return { code, out: () => out.join("\n"), err: () => err.join("\n") };
}

function git(root: string, ...args: string[]): void {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr}`);
}

/** A manifest with the two semantic fields removed, so the rest can be compared. */
function scrubSemantic(manifest: Manifest): unknown {
  const files: Record<string, unknown> = {};
  for (const file of Object.keys(manifest.files).sort(compareStrings)) {
    const entry = manifest.files[file];
    if (entry === undefined) continue;
    const { summaryHash: _hash, staleSummary: _stale, ...rest } = entry;
    files[file] = rest;
  }
  return { version: manifest.version, packages: manifest.packages, files };
}

describe("zero calls", () => {
  test(
    "the first refresh summarises every file and a second one on the same tree is free",
    async () => {
      const root = await initialised("zero");

      const first = recorder();
      const one = await refresh(root, { runner: first.runner, model: MODEL, today: TODAY });
      expect(one.refreshed).toBe(FIXTURE_SOURCES);
      expect(one.skipped).toBe(0);
      expect(one.calls).toBeGreaterThan(0);
      expect(one.update).toBe("rebuilt");
      expect(first.asked()).toContain(RETRY_SOURCE);

      const cache = cacheOf(root);
      expect(Object.keys(cache).length).toBe(FIXTURE_SOURCES);
      const entry = Object.values(cache).find((value) => value.path === RETRY_SOURCE);
      expect(entry).toEqual({ path: RETRY_SOURCE, text: canned(RETRY_SOURCE), refreshedAt: TODAY, model: MODEL });

      // The cache reached the cards, which is the only thing the update after
      // the write is there to do.
      expect(artifact(root, RETRY_CARD)).toContain(canned(RETRY_SOURCE));
      expect(artifact(root, RETRY_CARD)).not.toContain("summary may lag code");

      // Every file is now fresh, so nothing is stale and nothing is asked.
      expect(Object.values(manifestOf(root).files).filter((file) => file.staleSummary).length).toBe(0);

      const second = recorder();
      const two = await refresh(root, { runner: second.runner, model: MODEL, today: LATER });
      expect(two.calls).toBe(0);
      expect(two.refreshed).toBe(0);
      expect(two.skipped).toBe(FIXTURE_SOURCES);
      expect(second.calls.length).toBe(0);
      expect(two.flows).toEqual([]);
      expect(two.update).toBe("unnecessary");
    },
    120_000,
  );

  test(
    "the cache is stable JSON keyed by content hash, with a trailing newline",
    async () => {
      const root = await initialised("stable");
      await refresh(root, { runner: recorder().runner, model: MODEL, today: TODAY });

      const raw = artifact(root, ARTIFACT_PATHS.summaries);
      expect(raw.endsWith("}\n")).toBe(true);
      const keys = Object.keys(JSON.parse(raw) as SummaryCache);
      expect(keys).toEqual([...keys].sort(compareStrings));
      for (const key of keys) expect(key).toMatch(/^[0-9a-f]{64}$/);

      const manifest = manifestOf(root);
      const hash = manifest.files[RETRY_SOURCE]?.sha256 as string;
      expect(cacheOf(root)[hash]?.path).toBe(RETRY_SOURCE);
    },
    120_000,
  );
});

describe("stale", () => {
  test(
    "one edit makes one stale entry, one banner and one call",
    async () => {
      const root = await initialised("stale");
      await refresh(root, { runner: recorder().runner, model: MODEL, today: TODAY });

      const source = path.join(root, RETRY_SOURCE);
      writeFileSync(source, `${readFileSync(source, "utf8")}\n// a later thought\n`);
      await update(root, { mode: "full", quiet: true });

      const stale = Object.entries(manifestOf(root).files).filter(([, file]) => file.staleSummary);
      expect(stale.map(([file]) => file)).toEqual([RETRY_SOURCE]);
      expect(artifact(root, RETRY_CARD)).toContain(`> summary may lag code, last refreshed ${TODAY}`);
      expect(artifact(root, RETRY_CARD)).toContain(canned(RETRY_SOURCE));

      const again = recorder({ text: (file) => `Refreshed intent for ${file}.` });
      const result = await refresh(root, { runner: again.runner, model: MODEL, today: LATER });
      expect(result.calls).toBe(1);
      expect(result.refreshed).toBe(1);
      expect(result.skipped).toBe(FIXTURE_SOURCES - 1);
      expect(again.asked()).toEqual([RETRY_SOURCE]);

      const card = artifact(root, RETRY_CARD);
      expect(card).toContain(`Refreshed intent for ${RETRY_SOURCE}.`);
      expect(card).not.toContain("summary may lag code");

      // The superseded entry is pruned: it is neither current nor the newest
      // summary this path has.
      const kept = Object.values(cacheOf(root)).filter((value) => value.path === RETRY_SOURCE);
      expect(kept.length).toBe(1);
      expect(kept[0]?.refreshedAt).toBe(LATER);
    },
    120_000,
  );

  test(
    "a superseded entry survives while its path is still stale, so the banner has prose to show",
    async () => {
      const root = await initialised("banner");
      await refresh(root, { runner: recorder().runner, model: MODEL, today: TODAY });

      // A second package is edited and refreshed; the untouched stale path
      // keeps its old entry because nothing fresher was written for it.
      const source = path.join(root, RETRY_SOURCE);
      writeFileSync(source, `${readFileSync(source, "utf8")}\n// drifting\n`);
      await update(root, { mode: "full", quiet: true });

      await refresh(root, { pkg: "worker", runner: recorder().runner, model: MODEL, today: LATER });

      const kept = Object.values(cacheOf(root)).filter((value) => value.path === RETRY_SOURCE);
      expect(kept.length).toBe(1);
      expect(artifact(root, RETRY_CARD)).toContain(`> summary may lag code, last refreshed ${TODAY}`);
    },
    120_000,
  );

  test(
    "a file that leaves the map takes its summaries with it",
    async () => {
      const root = await initialised("deleted");
      await refresh(root, { runner: recorder().runner, model: MODEL, today: TODAY });
      expect(Object.values(cacheOf(root)).some((entry) => entry.path === "packages/core/src/bus.ts")).toBe(true);

      // Deleted, and something else edited so the run has work to do at all.
      rmSync(path.join(root, "packages/core/src/bus.ts"));
      const source = path.join(root, RETRY_SOURCE);
      writeFileSync(source, `${readFileSync(source, "utf8")}\n// moving on\n`);
      await update(root, { mode: "full", quiet: true });

      await refresh(root, { runner: recorder().runner, model: MODEL, today: LATER });
      const cache = cacheOf(root);
      expect(Object.values(cache).some((entry) => entry.path === "packages/core/src/bus.ts")).toBe(false);
      expect(Object.keys(cache).length).toBe(FIXTURE_SOURCES - 1);
    },
    120_000,
  );

  test(
    "repeated edit and refresh cycles inside one day leave one entry per path",
    async () => {
      // `refreshedAt` is day-granular, so every refresh in a day ties on it.
      // Before the fix the tie broke on the smallest hash and a card that went
      // stale six edits later rendered the *first* summary of the day.
      const root = await initialised("same-day");
      const source = path.join(root, RETRY_SOURCE);
      await refresh(root, { runner: recorder().runner, model: MODEL, today: TODAY });

      for (let cycle = 0; cycle < 4; cycle++) {
        writeFileSync(source, `${readFileSync(source, "utf8")}\n// cycle ${cycle}\n`);
        await update(root, { mode: "full", quiet: true });
        const rec = recorder({ text: () => `Cycle ${cycle} intent.` });
        await refresh(root, { runner: rec.runner, model: MODEL, today: TODAY });
      }

      const kept = Object.values(cacheOf(root)).filter((entry) => entry.path === RETRY_SOURCE);
      expect(kept.length).toBe(1);
      expect(kept[0]?.text).toBe("Cycle 3 intent.");
      expect(Object.keys(cacheOf(root)).length).toBe(FIXTURE_SOURCES);

      const card = artifact(root, RETRY_CARD);
      expect(card).toContain("Cycle 3 intent.");
      expect(card).not.toContain("summary may lag code");

      // And the card that a *later* edit makes stale shows the last summary,
      // not the first one of the day.
      writeFileSync(source, `${readFileSync(source, "utf8")}\n// and later still\n`);
      await update(root, { mode: "full", quiet: true });
      const stale = artifact(root, RETRY_CARD);
      expect(stale).toContain(`> summary may lag code, last refreshed ${TODAY}`);
      expect(stale).toContain("Cycle 3 intent.");
    },
    120_000,
  );

  test(
    "a batch that fails once is retried with the same prompt, and the run still commits every batch",
    async () => {
      const root = await initialised("retry");
      const prompts: string[] = [];
      let summaryCalls = 0;
      let failedOnce = false;

      const flaky: PromptRunner = (prompt) => {
        if (prompt.includes(FLOWS_TASK)) return Promise.resolve(JSON.stringify(CANNED_FLOWS));
        summaryCalls++;
        prompts.push(prompt);
        if (summaryCalls === 2 && !failedOnce) {
          failedOnce = true;
          return Promise.resolve("I could not read those files, sorry.");
        }
        const answer: Record<string, string> = {};
        for (const file of promptFiles(prompt)) answer[file] = canned(file);
        return Promise.resolve(JSON.stringify(answer));
      };

      const result = await refresh(root, { runner: flaky, model: MODEL, today: TODAY, batchSize: 5 });

      expect(result.refreshed).toBe(FIXTURE_SOURCES);
      expect(result.unanswered).toEqual([]);
      // Three batches, one retry, one flows document.
      expect(summaryCalls).toBe(4);
      expect(result.calls).toBe(5);
      // The retry is the same request, not a different one.
      expect(prompts[2]).toBe(prompts[1] as string);
      expect(Object.keys(cacheOf(root)).length).toBe(FIXTURE_SOURCES);
    },
    120_000,
  );

  test(
    "a runner that fails outright, rather than answering badly, is retried too",
    async () => {
      const root = await initialised("retry-runner");
      let first = true;
      const flaky: PromptRunner = (prompt) => {
        if (prompt.includes(FLOWS_TASK)) return Promise.resolve(JSON.stringify(CANNED_FLOWS));
        if (first) {
          first = false;
          return Promise.reject(new Error("greplost: `claude` exited 1: rate limited"));
        }
        const answer: Record<string, string> = {};
        for (const file of promptFiles(prompt)) answer[file] = canned(file);
        return Promise.resolve(JSON.stringify(answer));
      };

      const result = await refresh(root, { runner: flaky, model: MODEL, today: TODAY });
      expect(result.refreshed).toBe(FIXTURE_SOURCES);
      // The rejected attempt, the one that worked, and the flows document.
      expect(result.calls).toBe(3);
    },
    120_000,
  );

  test(
    "a batch that fails twice fails the run, and writes nothing",
    async () => {
      const root = await initialised("retry-exhausted");
      const before = tree(root);
      const broken: PromptRunner = () => Promise.resolve("still not JSON");
      await expect(refresh(root, { runner: broken, model: MODEL, today: TODAY })).rejects.toThrow(/JSON/);
      expect(changed(before, tree(root))).toEqual([]);
    },
    120_000,
  );

  test(
    "pkg restricts the refresh to one package",
    async () => {
      const root = await initialised("pkg");
      const rec = recorder();
      const result = await refresh(root, { pkg: "@tiny/core", runner: rec.runner, model: MODEL, today: TODAY });

      expect(result.refreshed).toBe(CORE_SOURCES);
      expect(result.skipped).toBe(0);
      expect(result.flows).toEqual([]);
      expect(rec.asked().length).toBe(CORE_SOURCES);
      for (const file of rec.asked()) expect(file.startsWith("packages/core/")).toBe(true);

      const paths = Object.values(cacheOf(root)).map((entry) => entry.path);
      expect(paths.length).toBe(CORE_SOURCES);
      expect(paths.every((file) => file.startsWith("packages/core/"))).toBe(true);
      expect(existsSync(path.join(root, ARTIFACT_DIR, WORKER_FLOWS))).toBe(false);
    },
    120_000,
  );

  test(
    "batchSize splits the stale set into one prompt per batch",
    async () => {
      const root = await initialised("batches");
      const rec = recorder();
      const result = await refresh(root, { runner: rec.runner, model: MODEL, today: TODAY, batchSize: 5 });

      expect(result.refreshed).toBe(FIXTURE_SOURCES);
      const summaryCalls = rec.calls.filter((call) => !call.prompt.includes(FLOWS_TASK));
      expect(summaryCalls.length).toBe(3);
      expect(promptFiles(summaryCalls[0]?.prompt as string).length).toBe(5);
      expect(promptFiles(summaryCalls[2]?.prompt as string).length).toBe(2);
      expect(rec.asked().length).toBe(FIXTURE_SOURCES);
    },
    120_000,
  );

  test(
    "an unknown package is refused before anything is asked",
    async () => {
      const root = await initialised("unknown-pkg");
      await expect(refresh(root, { pkg: "@tiny/nope", runner: forbiddenRunner })).rejects.toThrow(/@tiny\/nope/);
    },
    120_000,
  );
});

describe("FLOWS", () => {
  test(
    "selectEntryPoints finds the worker main and nothing in a library package",
    async () => {
      const root = await initialised("entrypoints");
      const snapshot = await buildSnapshot({ root });

      const worker = snapshot.packages.find((pkg) => pkg.name === "worker");
      const core = snapshot.packages.find((pkg) => pkg.name === "@tiny/core");
      expect(worker).toBeDefined();
      expect(core).toBeDefined();

      expect(selectEntryPoints(snapshot, worker as PackageInfo)).toEqual([WORKER_ENTRY]);
      expect(selectEntryPoints(snapshot, core as PackageInfo)).toEqual([]);
    },
    120_000,
  );

  test(
    "FLOWS.md names the worker entry point and carries two to five sequence diagrams",
    async () => {
      const root = await initialised("flows");
      const rec = recorder();
      const result = await refresh(root, { runner: rec.runner, model: MODEL, today: TODAY });

      expect(result.flows).toEqual([WORKER_FLOWS]);
      const text = artifact(root, WORKER_FLOWS);
      expect(text).toContain(WORKER_ENTRY);
      expect(text).toContain(`> Semantic layer, refreshed ${TODAY}; may lag code.`);
      expect(text).toContain("## Worker startup");
      expect(text).toContain("1. ");

      const diagrams = text.match(/```mermaid\nsequenceDiagram\n/g) ?? [];
      expect(diagrams.length).toBeGreaterThanOrEqual(2);
      expect(diagrams.length).toBeLessThanOrEqual(5);

      // The flows prompt carried the entry point and what it reaches.
      const flowPrompt = rec.calls.find((call) => call.prompt.includes(FLOWS_TASK));
      expect(flowPrompt?.prompt).toContain(`${ENTRY_PREFIX}${WORKER_ENTRY}`);
      expect(flowPrompt?.prompt).toContain("packages/core/src/registry.ts");

      // FLOWS.md is semantic-layer property: the structure layer neither
      // produces it nor prunes it.
      expect(isStructurePath(WORKER_FLOWS)).toBe(false);
      await update(root, { mode: "full", quiet: true });
      expect(existsSync(path.join(root, ARTIFACT_DIR, WORKER_FLOWS))).toBe(true);
    },
    120_000,
  );

  test(
    "renderFlows is a pure function of the flows it is given",
    async () => {
      const root = await initialised("render-flows");
      const pkg = await packageOf(root, "worker");
      const text = renderFlows(pkg, CANNED_FLOWS, TODAY);

      expect(text.startsWith("# Flows: worker\n")).toBe(true);
      expect(text.endsWith("\n")).toBe(true);
      expect(text).toContain(`> Semantic layer, refreshed ${TODAY}; may lag code.`);
      expect(text).toContain("1. `apps/worker/src/main.ts` (`main`): loads config and builds the registry");
      expect(text).toContain("1. `apps/worker/src/main.ts`: publishes to every registered queue");
      expect(renderFlows(pkg, CANNED_FLOWS, TODAY)).toBe(text);
    },
    120_000,
  );

  test(
    "a flows failure is recorded, not thrown: the summaries that were paid for still land",
    async () => {
      const root = await initialised("flows-failed");
      const rec = recorder({ flows: [CANNED_FLOWS[0] as Flow] });
      const result = await refresh(root, { runner: rec.runner, model: MODEL, today: TODAY });

      expect(result.flows).toEqual([]);
      expect(result.flowsFailed.map((failure) => failure.pkg)).toEqual(["worker"]);
      expect(result.flowsFailed[0]?.reason).toMatch(/2 to 5/);
      expect(existsSync(path.join(root, ARTIFACT_DIR, WORKER_FLOWS))).toBe(false);

      // Everything the summary batches bought is on disk and on the cards.
      expect(result.refreshed).toBe(FIXTURE_SOURCES);
      expect(Object.keys(cacheOf(root)).length).toBe(FIXTURE_SOURCES);
      expect(artifact(root, RETRY_CARD)).toContain(canned(RETRY_SOURCE));
    },
    120_000,
  );

  test(
    "an entry point has to export a function, not merely a name",
    async () => {
      const root = await initialised("entry-kinds", (dir) => {
        // Neither basename matches the front-door pattern, so the export is the
        // only thing that could make either of these an entry point.
        writeFileSync(path.join(dir, "apps/worker/src/limits.ts"), "export const fetch = 5;\n");
        writeFileSync(
          path.join(dir, "apps/worker/src/task.ts"),
          "export const handler = async (): Promise<void> => {};\n",
        );
      });
      const snapshot = await buildSnapshot({ root });
      const worker = snapshot.packages.find((pkg) => pkg.name === "worker") as PackageInfo;

      const points = selectEntryPoints(snapshot, worker);
      expect(points).toContain(WORKER_ENTRY);
      expect(points).toContain("apps/worker/src/task.ts");
      expect(points).not.toContain("apps/worker/src/limits.ts");
    },
    120_000,
  );
});

describe("safety", () => {
  test(
    "a dry run makes no calls and writes nothing",
    async () => {
      const root = await initialised("dry");
      const before = tree(root);

      const result = await refresh(root, { runner: forbiddenRunner, dryRun: true, model: MODEL, today: TODAY });
      expect(result.calls).toBe(0);
      expect(result.refreshed).toBe(FIXTURE_SOURCES);
      expect(result.flows).toEqual([]);

      expect(changed(before, tree(root))).toEqual([]);
      expect(existsSync(path.join(root, ARTIFACT_DIR, ARTIFACT_PATHS.summaries))).toBe(false);
    },
    120_000,
  );

  test(
    "invalid runner JSON is a clear error and leaves the cache untouched",
    async () => {
      const root = await initialised("bad-json");
      await refresh(root, { runner: recorder().runner, model: MODEL, today: TODAY });
      const cache = artifact(root, ARTIFACT_PATHS.summaries);

      const source = path.join(root, RETRY_SOURCE);
      writeFileSync(source, `${readFileSync(source, "utf8")}\n// and another\n`);
      await update(root, { mode: "full", quiet: true });
      const afterEdit = tree(root);

      const babbling: PromptRunner = () => Promise.resolve("Sure! Here is a summary of the module.");
      await expect(refresh(root, { runner: babbling, model: MODEL, today: LATER })).rejects.toThrow(/JSON/);

      expect(artifact(root, ARTIFACT_PATHS.summaries)).toBe(cache);
      expect(changed(afterEdit, tree(root))).toEqual([]);
    },
    120_000,
  );

  test(
    "a refresh moves no structure-layer byte but the cards it summarised and the manifest's two semantic fields",
    async () => {
      const root = await initialised("layer-rule");
      await refresh(root, { runner: recorder().runner, model: MODEL, today: TODAY });

      const source = path.join(root, RETRY_SOURCE);
      writeFileSync(source, `${readFileSync(source, "utf8")}\n// one more line\n`);
      await update(root, { mode: "full", quiet: true });

      // The parse cache and the state file are what an update legitimately
      // rewrites; everything else in the tree is under test.
      const before = tree(root, { ignoreRebuilt: true });
      const beforeManifest = manifestOf(root);

      const rec = recorder({ text: (file) => `Second intent for ${file}.` });
      await refresh(root, { runner: rec.runner, model: MODEL, today: LATER });

      const moved = changed(before, tree(root, { ignoreRebuilt: true }));
      expect(moved.filter((rel) => isStructurePath(rel))).toEqual(
        [ARTIFACT_PATHS.manifest, RETRY_CARD].sort(compareStrings),
      );
      // Everything else a refresh touches is semantic-layer property.
      expect(moved.filter((rel) => !isStructurePath(rel))).toEqual([ARTIFACT_PATHS.summaries]);

      // And the manifest moved only in the two fields the semantic layer owns.
      const afterManifest = manifestOf(root);
      expect(scrubSemantic(afterManifest)).toEqual(scrubSemantic(beforeManifest));
      expect(beforeManifest.files[RETRY_SOURCE]?.staleSummary).toBe(true);
      expect(afterManifest.files[RETRY_SOURCE]?.staleSummary).toBe(false);
    },
    120_000,
  );

  test(
    "a repository that switched the semantic layer off is left alone",
    async () => {
      const root = await initialised("disabled");
      const configFile = path.join(root, ARTIFACT_DIR, ARTIFACT_PATHS.config);
      const config = JSON.parse(readFileSync(configFile, "utf8")) as { semantic: { enabled: boolean } };
      config.semantic.enabled = false;
      writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);

      const before = tree(root);
      await expect(refresh(root, { runner: forbiddenRunner, today: TODAY })).rejects.toThrow(
        /semantic layer is disabled/,
      );
      expect(changed(before, tree(root))).toEqual([]);
    },
    120_000,
  );

  test(
    "a date that is not an ISO date never reaches the cache or a banner",
    async () => {
      const root = await initialised("bad-date");
      const before = tree(root);
      await expect(refresh(root, { runner: forbiddenRunner, today: "yesterday" })).rejects.toThrow(
        /today must be an ISO date/,
      );
      await expect(refresh(root, { runner: forbiddenRunner, batchSize: 0 })).rejects.toThrow(/batchSize/);
      expect(changed(before, tree(root))).toEqual([]);
    },
    120_000,
  );

  test(
    "the rebuild after a refresh is forced, so a clean git tree still picks up new prose",
    async () => {
      const root = await initialised("forced-rebuild");
      git(root, "init", "-q");
      git(root, "config", "user.email", "test@example.invalid");
      git(root, "config", "user.name", "greplost test");
      git(root, "add", "-A");
      git(root, "commit", "-qm", "fixture and map");

      // Two updates: the first records the commit, the second proves the clean
      // fast path is armed and would otherwise swallow the refresh's rebuild.
      await update(root, { mode: "incremental", quiet: true });
      expect((await update(root, { mode: "incremental", quiet: true })).skipped).toBe("clean");

      const result = await refresh(root, { runner: recorder().runner, model: MODEL, today: TODAY });
      expect(result.update).toBe("rebuilt");
      expect(artifact(root, RETRY_CARD)).toContain(canned(RETRY_SOURCE));

      // And the tree is clean again, so the next update legitimately skips.
      expect((await update(root, { mode: "incremental", quiet: true })).written).toBe(0);
    },
    120_000,
  );

  test(
    "a batch answer that names only some of its files is reported, never swallowed",
    async () => {
      const root = await initialised("partial");
      const partial: PromptRunner = (prompt) => {
        if (prompt.includes(FLOWS_TASK)) return Promise.resolve(JSON.stringify(CANNED_FLOWS));
        const only = promptFiles(prompt)[0] as string;
        return Promise.resolve(JSON.stringify({ [only]: canned(only) }));
      };

      const result = await refresh(root, { runner: partial, model: MODEL, today: TODAY });
      expect(result.refreshed).toBe(1);
      expect(result.unanswered.length).toBe(FIXTURE_SOURCES - 1);
      expect(result.unanswered).toEqual([...result.unanswered].sort(compareStrings));
      expect(result.unanswered).toContain(RETRY_SOURCE);
      // The one file it did answer for is committed; the rest stay stale and
      // cost nothing to ask about again.
      expect(Object.keys(cacheOf(root)).length).toBe(1);

      const run = capture(() => refreshCommand(root, { runner: partial, today: LATER }));
      expect(await run.code).toBe(0);
      expect(run.err()).toContain("greplost: the model did not answer for");
    },
    120_000,
  );

  test(
    "a summary that lands while the model is thinking is neither pruned nor overwritten",
    async () => {
      const root = await initialised("concurrent");
      const extra = "packages/core/src/extra.ts";

      // The runner stands in for another process finishing a refresh while this
      // one waits on the model: it indexes a new file and commits a summary for
      // it. This run's snapshot predates all of that.
      const racing: PromptRunner = async (prompt) => {
        writeFileSync(path.join(root, extra), "export function extra(): number {\n  return 1;\n}\n");
        await update(root, { mode: "full", quiet: true });
        const hash = manifestOf(root).files[extra]?.sha256 as string;
        const cache = { ...cacheOf(root) };
        cache[hash] = { path: extra, text: "Concurrent prose.", refreshedAt: TODAY, model: "other-model" };
        writeFileSync(
          path.join(root, ARTIFACT_DIR, ARTIFACT_PATHS.summaries),
          `${JSON.stringify(cache, null, 2)}\n`,
        );

        const answer: Record<string, string> = {};
        for (const file of promptFiles(prompt)) answer[file] = canned(file);
        return JSON.stringify(answer);
      };

      // The stand-in reads the cache, so it has to exist before it runs.
      writeFileSync(path.join(root, ARTIFACT_DIR, ARTIFACT_PATHS.summaries), "{}\n");

      const result = await refresh(root, { pkg: "@tiny/core", runner: racing, model: MODEL, today: TODAY });
      expect(result.refreshed).toBe(CORE_SOURCES);

      // Pruning ran against the manifest as it is now, not as this run first
      // read it, so the newcomer is still there and still says what it said.
      const survived = Object.values(cacheOf(root)).find((entry) => entry.path === extra);
      expect(survived?.text).toBe("Concurrent prose.");
      expect(survived?.model).toBe("other-model");
      expect(artifact(root, "packages/tiny__core/modules/src/extra.ts.md")).toContain("Concurrent prose.");
    },
    120_000,
  );

  test(
    "a lock held throughout still commits the summaries that were paid for, and says so",
    async () => {
      const root = await initialised("locked-merge");
      let release = (): void => {};
      const holding = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Acquired synchronously inside `withLock`, so it is held before the
      // refresh reaches its merge.
      const lock = withLock(root, () => holding);
      const run = capture(() => refreshCommand(root, { runner: recorder().runner, today: TODAY, json: true }));
      try {
        expect(await run.code).toBe(0);
      } finally {
        release();
        await lock;
      }

      const result = JSON.parse(run.out()) as RefreshResult;
      expect(result.refreshed).toBe(FIXTURE_SOURCES);
      expect(Object.keys(cacheOf(root)).length).toBe(FIXTURE_SOURCES);
      // The rebuild could not run either, and says so rather than pretending.
      expect(result.update).toBe("locked");
      // `--json` stdout stays one parseable document; the warning is on stderr.
      expect(run.out().trimStart().startsWith("{")).toBe(true);
      expect(run.err()).toContain("another update held the lock");
    },
    120_000,
  );

  test(
    "a flows failure is a warning on stderr, never a non-zero exit, in either output mode",
    async () => {
      const root = await initialised("warnings");
      const run = capture(() => refreshCommand(root, { runner: recorder({ flows: [] }).runner, today: TODAY }));
      expect(await run.code).toBe(0);
      expect(run.err()).toContain("greplost: could not write FLOWS.md for worker");

      const second = await initialised("warnings-json");
      const json = capture(() =>
        refreshCommand(second, { runner: recorder({ flows: [] }).runner, today: TODAY, json: true }),
      );
      expect(await json.code).toBe(0);
      expect(json.out().trimStart().startsWith("{")).toBe(true);
      expect(json.err()).toContain("could not write FLOWS.md for worker");
    },
    120_000,
  );

  test(
    "refreshCommand is the CLI's contract: an exit code, its own output, and no throw",
    async () => {
      const root = await initialised("command");

      const ok = capture(() => refreshCommand(root, { dryRun: true, runner: forbiddenRunner, today: TODAY }));
      expect(await ok.code).toBe(0);
      expect(ok.out()).toContain("would be refreshed");
      expect(ok.err()).toBe("");

      const bad = capture(() =>
        refreshCommand(root, { package: "@tiny/nope", runner: forbiddenRunner, today: TODAY }),
      );
      expect(await bad.code).toBe(1);
      expect(bad.out()).toBe("");
      expect(bad.err()).toContain("greplost: no package @tiny/nope");
      expect(existsSync(path.join(root, ARTIFACT_DIR, ARTIFACT_PATHS.summaries))).toBe(false);
    },
    120_000,
  );
});
