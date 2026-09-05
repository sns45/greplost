import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CallEdge,
  Declaration,
  FileRecord,
  GreplostConfig,
  ImportEdge,
  Lang,
  Snapshot,
  SummaryCache,
} from "../src/schema.ts";
import { ARTIFACT_DIR, ARTIFACT_PATHS, DEFAULT_CONFIG, SCHEMA_VERSION, compareStrings } from "../src/schema.ts";
import type { DiscoveredFile } from "../src/discover.ts";
import * as discoverModule from "../src/discover.ts";
import type { ParserHandle } from "../src/parser.ts";
import { createParser } from "../src/parser.ts";
import { serializeSnapshot } from "../src/serialize/index.ts";
import { buildSnapshot } from "../src/build.ts";
import type { ParseCache } from "../src/build.ts";

// ---------------------------------------------------------------------------
// Discovery seam. `buildSnapshot` calls `discoverFiles` itself, so the only way
// to feed the pipeline a different file order is to wrap the module. The
// wrapper delegates to the real implementation untouched unless `reorder` is
// set, which happens only inside the "order invariance" tests; bun runs test
// files one at a time, so no other suite ever sees a reordered list.
// ---------------------------------------------------------------------------

const realDiscoverFiles = discoverModule.discoverFiles;
let reorder: ((files: DiscoveredFile[]) => DiscoveredFile[]) | null = null;

mock.module("../src/discover.ts", () => ({
  // Every parameter is forwarded, `skipped` included: the mock outlives this
  // file inside one bun process, so a wrapper that quietly dropped an argument
  // would make `discover.test.ts` fail only when the suites run together.
  discoverFiles: async (
    root: string,
    config: GreplostConfig,
    skipped?: string[],
  ): Promise<DiscoveredFile[]> => {
    const files = await realDiscoverFiles(root, config, skipped);
    return reorder === null ? files : reorder([...files]);
  },
}));

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TINY_TS = path.join(REPO_ROOT, "fixtures", "tiny-ts");
const GOLDEN_DIR = fileURLToPath(new URL("./golden/tiny-ts", import.meta.url));
const UPDATE_GOLDEN = process.env["GREPLOST_UPDATE_GOLDEN"] === "1";

const F = {
  config: "apps/worker/src/config.ts",
  main: "apps/worker/src/main.ts",
  adaptersIndex: "packages/adapters/src/index.ts",
  memory: "packages/adapters/src/memory.ts",
  sqs: "packages/adapters/src/sqs.ts",
  bus: "packages/core/src/bus.ts",
  events: "packages/core/src/events.ts",
  coreIndex: "packages/core/src/index.ts",
  queue: "packages/core/src/queue.ts",
  registry: "packages/core/src/registry.ts",
  retry: "packages/core/src/retry.ts",
  types: "packages/core/src/types.ts",
} as const;

let parser: ParserHandle;
let snapshot: Snapshot;
let artifacts: Map<string, string>;

beforeAll(async () => {
  parser = await createParser();
  snapshot = await buildSnapshot({ root: TINY_TS, parser });
  artifacts = serializeSnapshot(snapshot);
});

/** Every artifact byte the build produces, keyed by artifact-relative path. */
function bytesOf(s: Snapshot): Map<string, string> {
  return serializeSnapshot(s);
}

function sameBytes(a: Map<string, string>, b: Map<string, string>): void {
  expect([...b.keys()].sort(compareStrings)).toEqual([...a.keys()].sort(compareStrings));
  for (const [key, value] of a) expect(`${key}\n${b.get(key) ?? ""}`).toBe(`${key}\n${value}`);
}

function importEdgesFrom(from: string, to: string): ImportEdge[] {
  return snapshot.imports.filter((e) => e.from === from && e.to === to);
}

function callEdge(from: string, to: string): CallEdge | undefined {
  return snapshot.calls.find((e) => e.from === from && e.to === to);
}

/** A `Map`-backed `ParseCache`, keyed by (lang, sha256) exactly as the contract says. */
function memoryCache(): ParseCache & { size(): number; stored(): FileRecord[] } {
  const records = new Map<string, FileRecord>();
  const key = (sha256: string, lang: Lang): string => `${lang}:${sha256}`;
  return {
    get: (sha256, lang) => records.get(key(sha256, lang)),
    set: (record) => {
      records.set(key(record.sha256, record.lang), record);
    },
    size: () => records.size,
    stored: () => [...records.values()],
  };
}

function countingParser(inner: ParserHandle): { handle: ParserHandle; parses(): number } {
  let parses = 0;
  return {
    handle: {
      parse(source: string, lang: Lang) {
        parses += 1;
        return inner.parse(source, lang);
      },
      // The wrapper does not own `inner`, so disposal is the caller's to do.
      dispose() {},
    },
    parses: () => parses,
  };
}

/** Deterministic PRNG so a "shuffled" order is reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  const random = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

const temporaries: string[] = [];

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "greplost-build-"));
  temporaries.push(dir);
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return dir;
}

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
  temporaries.length = 0;
});

// ---------------------------------------------------------------------------

describe("golden", () => {
  test("the four structure artifacts are byte-equal to the committed golden files", () => {
    const expected = [
      ARTIFACT_PATHS.manifest,
      ARTIFACT_PATHS.imports,
      ARTIFACT_PATHS.calls,
      ARTIFACT_PATHS.symbols,
    ];
    expect([...artifacts.keys()].sort(compareStrings)).toEqual([...expected].sort(compareStrings));

    for (const relative of expected) {
      const produced = artifacts.get(relative) ?? "";
      const goldenPath = path.join(GOLDEN_DIR, relative);
      if (UPDATE_GOLDEN) {
        mkdirSync(path.dirname(goldenPath), { recursive: true });
        writeFileSync(goldenPath, produced);
        continue;
      }
      if (!existsSync(goldenPath)) {
        throw new Error(
          `greplost: golden file missing: ${goldenPath} (regenerate with GREPLOST_UPDATE_GOLDEN=1 bun test packages/core/test/build.test.ts)`,
        );
      }
      expect(`${relative}\n${readFileSync(goldenPath, "utf8")}`).toBe(`${relative}\n${produced}`);
    }
  });

  test("indexes the 12 fixture source files", () => {
    expect(Object.keys(snapshot.manifest.files).sort(compareStrings)).toEqual(
      Object.values(F).slice().sort(compareStrings),
    );
    expect(snapshot.files.map((f) => f.path)).toEqual(Object.values(F).slice().sort(compareStrings));
    expect(snapshot.manifest.version).toBe(SCHEMA_VERSION);
  });

  test("detects 4 packages including the root", () => {
    expect(Object.keys(snapshot.manifest.packages).sort(compareStrings)).toEqual([
      "@tiny/adapters",
      "@tiny/core",
      "tiny-ts",
      "worker",
    ]);
    expect(snapshot.manifest.packages["@tiny/core"]?.path).toBe("packages/core");
    expect(snapshot.manifest.packages["tiny-ts"]?.path).toBe(".");
    // Plain package names, never `pkg:` ids (driver ruling).
    expect(snapshot.manifest.packages["@tiny/adapters"]?.deps).toEqual(["@tiny/core"]);
    expect(snapshot.manifest.packages["@tiny/core"]?.rdeps).toEqual(["@tiny/adapters", "worker"]);
    expect(snapshot.metrics.packageEdges).toEqual([
      { from: "@tiny/adapters", to: "@tiny/core", count: 4 },
      { from: "worker", to: "@tiny/adapters", count: 1 },
      { from: "worker", to: "@tiny/core", count: 1 },
    ]);
  });

  test("reports the single bus <-> events cycle", () => {
    expect(snapshot.metrics.cycles).toEqual([[F.bus, F.events]]);
  });

  test("core index re-exports retry, DEFAULT_ATTEMPTS, Priority and the registry star", () => {
    expect(snapshot.manifest.files[F.coreIndex]?.exports).toEqual([
      "Ack",
      "DEFAULT_ATTEMPTS",
      "Msg",
      "Priority",
      "Queue",
      "Registry",
      "createRegistry",
      "retry",
    ]);
  });

  test("memory.ts carries a dynamic import of @tiny/core for Priority", () => {
    const dynamic = importEdgesFrom(F.memory, F.coreIndex).filter((e) => e.importKind === "dynamic");
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0]?.specifier).toBe("@tiny/core");
    expect(dynamic[0]?.symbols).toEqual(["Priority"]);
    expect(dynamic[0]?.kind).toBe("import");
  });

  test("sqs.ts imports the external @aws-sdk/client-sqs", () => {
    const external = snapshot.imports.filter((e) => e.from === F.sqs && e.to === "ext:@aws-sdk/client-sqs");
    expect(external).toHaveLength(1);
    expect(external[0]?.symbols).toEqual(["SQSClient", "SendMessageCommand"]);
  });

  test("call edges through a re-export are med, direct ones high", () => {
    expect(callEdge(`${F.sqs}#SqsAdapter.publish`, `${F.retry}#retry`)?.confidence).toBe("med");
    expect(callEdge(`${F.registry}#Registry.publishAll`, `${F.retry}#retry`)?.confidence).toBe("high");
  });

  test("blast radii follow the reverse import closure", () => {
    expect(snapshot.manifest.files[F.retry]?.blast).toBe(6);
    expect(snapshot.manifest.files[F.types]?.blast).toBe(9);
    expect(snapshot.manifest.files[F.bus]?.blast).toBe(7);
    expect(snapshot.manifest.files[F.main]?.blast).toBe(0);
    expect(snapshot.manifest.files[F.coreIndex]?.fanIn).toBe(3);
    expect(snapshot.manifest.files[F.coreIndex]?.fanOut).toBe(4);
  });
});

describe("idempotent", () => {
  test("two builds of the same tree produce identical bytes", async () => {
    const again = await buildSnapshot({ root: TINY_TS, parser });
    sameBytes(artifacts, bytesOf(again));
  });

  test("a build with a fresh parser produces identical bytes", async () => {
    const other = await createParser();
    const again = await buildSnapshot({ root: TINY_TS, parser: other });
    sameBytes(artifacts, bytesOf(again));
  });
});

describe("order invariance", () => {
  async function buildWith(order: (files: DiscoveredFile[]) => DiscoveredFile[]): Promise<Map<string, string>> {
    reorder = order;
    try {
      return bytesOf(await buildSnapshot({ root: TINY_TS, parser }));
    } finally {
      reorder = null;
    }
  }

  test("the wrapper really does change the discovered order", async () => {
    const files = await realDiscoverFiles(TINY_TS, DEFAULT_CONFIG);
    expect(files.map((f) => f.path)).toHaveLength(12);
    expect(shuffled(files, 20260902).map((f) => f.path)).not.toEqual(files.map((f) => f.path));
    expect([...files].reverse().map((f) => f.path)).not.toEqual(files.map((f) => f.path));
  });

  test("a reversed discovery order produces identical bytes", async () => {
    sameBytes(artifacts, await buildWith((files) => files.reverse()));
  });

  test("a seeded shuffle of the discovery order produces identical bytes", async () => {
    for (const seed of [1, 20260902, 987654321]) {
      sameBytes(artifacts, await buildWith((files) => shuffled(files, seed)));
    }
  });
});

describe("parse cache", () => {
  test("a warm cache parses nothing and produces identical bytes", async () => {
    const cache = memoryCache();
    const cold = countingParser(parser);
    const first = await buildSnapshot({ root: TINY_TS, parser: cold.handle, cache });
    expect(cold.parses()).toBe(12);
    expect(cache.size()).toBe(12);

    const warm = countingParser(parser);
    const second = await buildSnapshot({ root: TINY_TS, parser: warm.handle, cache });
    expect(warm.parses()).toBe(0);
    sameBytes(bytesOf(first), bytesOf(second));
    sameBytes(artifacts, bytesOf(second));
  });

  test("a cache hit is re-stamped onto the path that asked for it", async () => {
    const shared = 'export function twin(): number {\n  return 1;\n}\n';
    const root = tempRepo({
      "a.ts": shared,
      "b.ts": shared,
      "package.json": '{ "name": "twins" }\n',
    });
    const cache = memoryCache();
    const counting = countingParser(parser);
    const built = await buildSnapshot({ root, parser: counting.handle, cache });
    // Identical bytes at two paths: one parse, two files.
    expect(counting.parses()).toBe(1);
    expect(built.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(built.symbols.map((d) => d.id)).toEqual(["a.ts#twin", "b.ts#twin"]);
    expect(built.symbols.map((d) => d.file)).toEqual(["a.ts", "b.ts"]);
    expect(Object.keys(built.manifest.files)).toEqual(["a.ts", "b.ts"]);
    expect(built.manifest.files["a.ts"]?.exports).toEqual(["twin"]);
    expect(built.manifest.files["b.ts"]?.exports).toEqual(["twin"]);

    // And a second build off the warm cache says exactly the same thing.
    const again = await buildSnapshot({ root, parser, cache });
    sameBytes(bytesOf(built), bytesOf(again));
  });

  test("identical bytes in two languages are two records, not one", async () => {
    // A `.ts` and a `.jsx` file with the same bytes share a sha256, but not a
    // grammar: the cache is keyed by content, so the language has to be checked.
    const shared = "export const shared = 1;\n";
    const root = tempRepo({
      "a.ts": shared,
      "b.jsx": shared,
      "empty.ts": "",
      "empty.jsx": "",
    });
    const cache = memoryCache();
    const cold = countingParser(parser);
    const built = await buildSnapshot({ root, parser: cold.handle, cache });
    expect(cold.parses()).toBe(4);
    expect(cache.size()).toBe(4);
    expect(built.manifest.files["a.ts"]?.lang).toBe("ts");
    expect(built.manifest.files["b.jsx"]?.lang).toBe("jsx");
    expect(built.manifest.files["empty.ts"]?.lang).toBe("ts");
    expect(built.manifest.files["empty.jsx"]?.lang).toBe("jsx");
    expect(built.manifest.files["a.ts"]?.sha256).toBe(built.manifest.files["b.jsx"]?.sha256 ?? "");

    // The cache is keyed by (lang, sha256), so the colliding hashes each keep
    // their own record and the warm build parses nothing at all.
    const warm = countingParser(parser);
    const again = await buildSnapshot({ root, parser: warm.handle, cache });
    expect(warm.parses()).toBe(0);
    sameBytes(bytesOf(built), bytesOf(again));
  });

  test("get is asked for the discovered language, and set stores the record's own", async () => {
    const root = tempRepo({ "one.ts": "export const one = 1;\n", "two.jsx": "export const two = 2;\n" });
    const asked: Array<[string, Lang]> = [];
    const records = new Map<string, FileRecord>();
    const cache: ParseCache = {
      get: (sha256, lang) => {
        asked.push([sha256, lang]);
        return records.get(`${lang}:${sha256}`);
      },
      set: (record) => {
        records.set(`${record.lang}:${record.sha256}`, record);
      },
    };
    const built = await buildSnapshot({ root, parser, cache });
    // Path-sorted, so "one.ts" is asked for before "two.jsx".
    expect(asked.map(([, lang]) => lang)).toEqual(["ts", "jsx"]);
    expect(asked.map(([sha]) => sha)).toEqual([
      built.manifest.files["one.ts"]?.sha256 ?? "",
      built.manifest.files["two.jsx"]?.sha256 ?? "",
    ]);
    expect([...records.keys()].sort(compareStrings)).toEqual(
      [
        `jsx:${built.manifest.files["two.jsx"]?.sha256 ?? ""}`,
        `ts:${built.manifest.files["one.ts"]?.sha256 ?? ""}`,
      ].sort(compareStrings),
    );
  });

  test("records handed to the cache and to the snapshot are frozen", async () => {
    const cache = memoryCache();
    const built = await buildSnapshot({ root: TINY_TS, parser, cache });

    for (const record of [...built.files, ...cache.stored()]) {
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.decls)).toBe(true);
      expect(Object.isFrozen(record.imports)).toBe(true);
      expect(Object.isFrozen(record.exports)).toBe(true);
      expect(Object.isFrozen(record.calls)).toBe(true);
    }

    // ESM test modules are strict, so a write to a frozen record throws.
    const record = built.files[0] as FileRecord;
    expect(() => {
      (record as { loc: number }).loc = -1;
    }).toThrow();
    expect(() => record.decls.push(record.decls[0] as Declaration)).toThrow();
    expect(record.loc).toBeGreaterThan(0);

    // A twin re-stamped from a cached record is frozen too, not just the original.
    const shared = "export const twin = 1;\n";
    const twinRoot = tempRepo({ "a.ts": shared, "b.ts": shared });
    const twins = await buildSnapshot({ root: twinRoot, parser, cache: memoryCache() });
    expect(twins.files.map((f) => Object.isFrozen(f))).toEqual([true, true]);
    expect(twins.files.map((f) => Object.isFrozen(f.decls))).toEqual([true, true]);

    // And freezing changes not one byte of the output.
    sameBytes(artifacts, bytesOf(built));
  });

  test("a build without an injected parser still works", async () => {
    const root = tempRepo({ "solo.ts": "export const answer = 42;\n" });
    const built = await buildSnapshot({ root });
    expect(built.symbols.map((d) => d.id)).toEqual(["solo.ts#answer"]);
  });
});

describe("summaries", () => {
  test("a summary keyed by the current content hash is fresh", async () => {
    const sha = snapshot.manifest.files[F.retry]?.sha256 ?? "";
    expect(sha).not.toBe("");
    const summaries: SummaryCache = {
      [sha]: { path: F.retry, text: "retries", refreshedAt: "2026-08-01", model: "m" },
    };
    const built = await buildSnapshot({ root: TINY_TS, parser, summaries });
    expect(built.manifest.files[F.retry]?.summaryHash).toBe(sha);
    expect(built.manifest.files[F.retry]?.staleSummary).toBe(false);
  });

  test("a summary keyed by an older hash of the same path is stale", async () => {
    const summaries: SummaryCache = {
      old0: { path: F.retry, text: "older", refreshedAt: "2026-01-01", model: "m" },
      old1: { path: F.retry, text: "newest", refreshedAt: "2026-07-01", model: "m" },
      other: { path: F.types, text: "unrelated", refreshedAt: "2026-09-01", model: "m" },
    };
    const built = await buildSnapshot({ root: TINY_TS, parser, summaries });
    expect(built.manifest.files[F.retry]?.summaryHash).toBe("old1");
    expect(built.manifest.files[F.retry]?.staleSummary).toBe(true);
    expect(built.manifest.files[F.types]?.summaryHash).toBe("other");
    expect(built.manifest.files[F.types]?.staleSummary).toBe(true);
  });

  test("a file with no summary at all is not stale and carries no hash", async () => {
    expect(snapshot.manifest.files[F.bus]?.staleSummary).toBe(false);
    expect(snapshot.manifest.files[F.bus]).not.toHaveProperty("summaryHash");

    const summaries: SummaryCache = {
      elsewhere: { path: F.types, text: "unrelated", refreshedAt: "2026-01-01", model: "m" },
    };
    const built = await buildSnapshot({ root: TINY_TS, parser, summaries });
    expect(built.manifest.files[F.bus]?.staleSummary).toBe(false);
    expect(built.manifest.files[F.bus]).not.toHaveProperty("summaryHash");
  });

  test("a refreshedAt tie resolves to the smaller hash, not to JSON key order", async () => {
    const build = async (summaries: SummaryCache): Promise<string | undefined> =>
      (await buildSnapshot({ root: TINY_TS, parser, summaries })).manifest.files[F.retry]?.summaryHash;
    const a = { path: F.retry, text: "a", refreshedAt: "2026-05-05", model: "m" };
    const b = { path: F.retry, text: "b", refreshedAt: "2026-05-05", model: "m" };
    expect(await build({ aaa: a, zzz: b })).toBe("aaa");
    expect(await build({ zzz: b, aaa: a })).toBe("aaa");
  });

  test("summaries never change the structure bytes apart from the manifest", async () => {
    const sha = snapshot.manifest.files[F.retry]?.sha256 ?? "";
    const summaries: SummaryCache = {
      [sha]: { path: F.retry, text: "retries", refreshedAt: "2026-08-01", model: "m" },
    };
    const built = bytesOf(await buildSnapshot({ root: TINY_TS, parser, summaries }));
    for (const key of [ARTIFACT_PATHS.imports, ARTIFACT_PATHS.calls, ARTIFACT_PATHS.symbols]) {
      expect(built.get(key)).toBe(artifacts.get(key));
    }
    expect(built.get(ARTIFACT_PATHS.manifest)).not.toBe(artifacts.get(ARTIFACT_PATHS.manifest));
  });
});

describe("options", () => {
  test("an injected config replaces the discovered one", async () => {
    const config: GreplostConfig = {
      ...DEFAULT_CONFIG,
      exclude: [...DEFAULT_CONFIG.exclude, "apps/**"],
    };
    const built = await buildSnapshot({ root: TINY_TS, parser, config });
    expect(Object.keys(built.manifest.files)).toHaveLength(10);
    expect(built.config.exclude).toContain("apps/**");
    // The two worker files are gone, so `@tiny/adapters` loses its importer.
    expect(built.manifest.packages["@tiny/adapters"]?.rdeps).toEqual([]);
  });

  test("a repo with no indexable files builds an empty snapshot", async () => {
    const root = tempRepo({ "README.md": "# nothing here\n" });
    const built = await buildSnapshot({ root });
    expect(built.files).toEqual([]);
    expect(built.imports).toEqual([]);
    expect(built.calls).toEqual([]);
    expect(built.symbols).toEqual([]);
    expect(built.manifest.files).toEqual({});
    expect(built.metrics).toEqual({ cycles: [], packageEdges: [] });
    const bytes = bytesOf(built);
    expect(bytes.get(ARTIFACT_PATHS.imports)).toBe("");
    expect(bytes.get(ARTIFACT_PATHS.symbols)).toBe("");
  });

  test("without an injected config the repo's own .greplost/config.json is used", async () => {
    const root = tempRepo({
      "src/keep.ts": "export const keep = 1;\n",
      "src/drop.ts": "export const drop = 2;\n",
      [`${ARTIFACT_DIR}/${ARTIFACT_PATHS.config}`]: JSON.stringify({ exclude: ["**/drop.ts"] }),
    });
    const built = await buildSnapshot({ root });
    expect(built.config.exclude).toEqual(["**/drop.ts"]);
    expect(Object.keys(built.manifest.files)).toEqual(["src/keep.ts"]);
  });

  test("a leading UTF-8 BOM changes the hash but not the extracted structure", async () => {
    const source = "export const bom = 1;\n";
    const root = tempRepo({ "plain.ts": source, "bom.ts": `\uFEFF${source}` });
    const built = await buildSnapshot({ root });
    expect(built.symbols.map((d) => d.id)).toEqual(["bom.ts#bom", "plain.ts#bom"]);
    for (const decl of built.symbols) expect(decl.signature).toBe("export const bom = 1");
    // Different bytes, so the two files are distinct parse-cache entries.
    expect(built.manifest.files["bom.ts"]?.sha256).not.toBe(built.manifest.files["plain.ts"]?.sha256);
  });

  test("the snapshot root is absolute and the config is the loaded one", async () => {
    expect(path.isAbsolute(snapshot.root)).toBe(true);
    expect(snapshot.config).toEqual(DEFAULT_CONFIG);
  });
});

describe("parser lifetime", () => {
  /**
   * `buildSnapshot` is called once per commit by `bench:replay` and once per save by the
   * watcher, so anything it retains per build is unbounded in the processes that matter.
   * This is the bound on that: fifty builds of one fixture, measured after the process is
   * warm, must not grow RSS by more than `BOUND_BYTES`.
   *
   * Measured on this fixture, warm: 9.3, 12.0 and 12.9 MB over the fifty builds, which is
   * JS heap growth and not a leak. The bound is 40 MB, about three times the worst of
   * those, so it catches a regression that retains ~0.8 MB a build or more and cannot be
   * tripped by ordinary variance. The warm-up matters: the first few builds compile the
   * grammars and let the JIT settle, and measuring across them reads 55 MB of one-off
   * start-up as growth.
   *
   * What this does *not* measure is the wasm allocation `ParserHandle.dispose` frees: the
   * emscripten heap never shrinks, so a freed parser and a leaked one look identical from
   * outside the process. `parser.test.ts` covers the handle's contract, and the honest
   * measurement of the whole pipeline is the replay gate's own peak RSS.
   */
  const BOUND_BYTES = 40 * 1024 * 1024;
  const WARMUP_BUILDS = 10;

  test("fifty builds of one fixture do not grow RSS without bound", async () => {
    for (let i = 0; i < WARMUP_BUILDS; i++) await buildSnapshot({ root: TINY_TS });
    const before = process.memoryUsage.rss();
    for (let i = 0; i < 50; i++) await buildSnapshot({ root: TINY_TS });
    const growth = process.memoryUsage.rss() - before;
    expect(growth, `RSS grew ${(growth / 1048576).toFixed(1)} MB over 50 builds`).toBeLessThan(BOUND_BYTES);
  }, 60_000);

  test("a caller's own parser survives the build it was passed to", async () => {
    const own = await createParser();
    await buildSnapshot({ root: TINY_TS, parser: own });
    // The handle is the caller's; a build that disposed it would break every
    // caller that builds twice with one parser (this file's own `beforeAll`).
    const second = await buildSnapshot({ root: TINY_TS, parser: own });
    expect(second.files.length).toBeGreaterThan(0);
    own.dispose();
  });
});
