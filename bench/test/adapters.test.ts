/**
 * Competitor artifact adapters (bench leaf 1.5.2).
 *
 * Gate CHECK lines filter on describe names, so the two gated blocks are named
 * exactly `round-trip` and `valid ids`. Every other block is ungated but counts
 * toward G1 (`bun test bench/test/adapters.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Edge } from "@greplost/core/schema";
import { compareEdges, isFileId, stableStringify, symbolId } from "@greplost/core/schema";

import { adapters, fixtures, run } from "../src/adapters/index.ts";
import type { Adapter, CompetitorArtifact } from "../src/adapters/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const competitorsJson = JSON.parse(
  readFileSync(path.join(repoRoot, "bench", "competitors.json"), "utf8"),
) as {
  pinnedAt: string;
  tools: {
    name: string;
    repo: string;
    version: string;
    commit: string;
    install: string[];
    run: string[];
    artifactPaths: string[];
    syncMechanism: string | null;
    schemaNotes: string;
    sources: string[];
  }[];
};

// ---------------------------------------------------------------------------
// Independent greplost-id validator. Written here on purpose: the adapters must
// not be able to certify themselves with the same helper they emit ids through.
// Rules restated from schema.ts's determinism contract:
//   file id   -> repo-relative posix path, no leading "/", no "..", no "#"
//   symbol id -> `<file id>#<symbol path>`
// ---------------------------------------------------------------------------
function isRelativePosixPath(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith("/")) return false; // absolute posix
  if (/^[A-Za-z]:/.test(p)) return false; // absolute windows (drive letter)
  if (p.includes("\\")) return false; // windows separator
  if (p.includes("#")) return false; // would collide with the symbol separator
  for (const segment of p.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

function isValidFileId(id: string): boolean {
  return isFileId(id) && isRelativePosixPath(id);
}

function isValidSymbolId(id: string): boolean {
  const cut = id.indexOf("#");
  if (cut <= 0) return false;
  const file = id.slice(0, cut);
  const symbol = id.slice(cut + 1);
  if (!isRelativePosixPath(file)) return false;
  if (symbol.length === 0 || symbol.includes("#")) return false;
  return symbolId(file, symbol) === id;
}

function edgeKey(e: Edge): string {
  return `${e.from}\u0000${e.to}\u0000${e.kind}`;
}

function loadAll(): { adapter: Adapter; artifact: CompetitorArtifact }[] {
  return fixtures.map((f) => {
    const adapter = adapters.find((a) => a.tool === f.tool);
    if (!adapter) throw new Error(`greplost: no adapter for ${f.tool}`);
    return { adapter, artifact: adapter.load(f.dir, f.repoRoot) };
  });
}

// ---------------------------------------------------------------------------
// G2
// ---------------------------------------------------------------------------
describe("round-trip", () => {
  for (const fixture of fixtures) {
    const adapter = adapters.find((a) => a.tool === fixture.tool)!;

    test(`${fixture.tool} loads the same edges twice`, () => {
      const first = adapter.load(fixture.dir, fixture.repoRoot);
      const second = adapter.load(fixture.dir, fixture.repoRoot);
      expect(stableStringify(second.imports)).toBe(stableStringify(first.imports));
      expect(stableStringify(second.calls)).toBe(stableStringify(first.calls));
      expect(stableStringify(second.nodes)).toBe(stableStringify(first.nodes));
      expect(second.raw).toEqual(first.raw);
      expect(second.version).toBe(first.version);
    });

    test(`${fixture.tool} survives a stableStringify round-trip`, () => {
      const artifact = adapter.load(fixture.dir, fixture.repoRoot);
      const serialized = stableStringify(artifact, 2);
      const revived = JSON.parse(serialized) as CompetitorArtifact;
      const reloaded = adapter.load(fixture.dir, fixture.repoRoot);
      expect(revived.imports).toEqual(reloaded.imports);
      expect(revived.calls).toEqual(reloaded.calls);
      expect(stableStringify(revived)).toBe(stableStringify(reloaded));
    });

    test(`${fixture.tool} emits sorted, de-duplicated, non-empty edges`, () => {
      const { imports, calls } = adapter.load(fixture.dir, fixture.repoRoot);
      expect(imports.length).toBeGreaterThan(0);
      expect(calls.length).toBeGreaterThan(0);
      for (const list of [imports, calls]) {
        const sorted = [...list].sort(compareEdges);
        expect(list).toEqual(sorted);
        const keys = list.map(edgeKey);
        expect(new Set(keys).size).toBe(keys.length);
      }
      for (const e of imports) expect(e.kind).toBe("import");
      for (const e of calls) expect(e.kind).toBe("call");
    });
  }
});

// ---------------------------------------------------------------------------
// G3
// ---------------------------------------------------------------------------
describe("valid ids", () => {
  test("the validator itself rejects the shapes it must reject", () => {
    expect(isValidFileId("packages/core/src/bus.ts")).toBe(true);
    expect(isValidFileId("/abs/packages/core/src/bus.ts")).toBe(false);
    expect(isValidFileId("C:/repo/src/bus.ts")).toBe(false);
    expect(isValidFileId("packages\\core\\src\\bus.ts")).toBe(false);
    expect(isValidFileId("../outside.ts")).toBe(false);
    expect(isValidFileId("./bus.ts")).toBe(false);
    expect(isValidFileId("")).toBe(false);
    expect(isValidFileId("ext:lodash")).toBe(false);
    expect(isValidFileId("unresolved:./nope")).toBe(false);
    expect(isValidFileId("pkg:core")).toBe(false);
    expect(isValidFileId("src/a.ts#A")).toBe(false);
    expect(isValidSymbolId("packages/core/src/bus.ts#Bus.emit")).toBe(true);
    expect(isValidSymbolId("packages/core/src/bus.ts#Bus")).toBe(true);
    expect(isValidSymbolId("packages/core/src/bus.ts")).toBe(false);
    expect(isValidSymbolId("#Bus")).toBe(false);
    expect(isValidSymbolId("packages/core/src/bus.ts#")).toBe(false);
    expect(isValidSymbolId("/abs/bus.ts#Bus")).toBe(false);
  });

  for (const fixture of fixtures) {
    const adapter = adapters.find((a) => a.tool === fixture.tool)!;

    test(`${fixture.tool} emits only greplost ids`, () => {
      const artifact = adapter.load(fixture.dir, fixture.repoRoot);

      // Import edges connect two repo files.
      for (const e of artifact.imports) {
        expect(isValidFileId(e.from)).toBe(true);
        expect(isValidFileId(e.to)).toBe(true);
      }
      // Call edges: `from` may be a bare file id (top-level code), `to` is a symbol.
      for (const e of artifact.calls) {
        expect(isValidFileId(e.from) || isValidSymbolId(e.from)).toBe(true);
        expect(isValidSymbolId(e.to)).toBe(true);
      }
      // Every node the adapter claims to have mapped.
      for (const id of artifact.nodes) {
        expect(isValidFileId(id) || isValidSymbolId(id)).toBe(true);
      }
      // Node list is sorted and unique, and covers every edge endpoint.
      expect(artifact.nodes).toEqual([...artifact.nodes].sort());
      expect(new Set(artifact.nodes).size).toBe(artifact.nodes.length);
      const nodeSet = new Set(artifact.nodes);
      for (const e of [...artifact.imports, ...artifact.calls]) {
        expect(nodeSet.has(e.from)).toBe(true);
        expect(nodeSet.has(e.to)).toBe(true);
      }
    });

    test(`${fixture.tool} ids point at files that exist in the fixture repo`, () => {
      const artifact = adapter.load(fixture.dir, fixture.repoRoot);
      const tinyTs = path.join(repoRoot, "fixtures", "tiny-ts");
      for (const id of artifact.nodes) {
        const file = id.includes("#") ? id.slice(0, id.indexOf("#")) : id;
        expect(Bun.file(path.join(tinyTs, file)).size).toBeGreaterThan(0);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Per-tool mapping: the exact edges each adapter is expected to produce.
// ---------------------------------------------------------------------------
describe("mapping", () => {
  const MAIN = "apps/worker/src/main.ts";
  const CONFIG = "apps/worker/src/config.ts";
  const REGISTRY = "packages/core/src/registry.ts";
  const RETRY = "packages/core/src/retry.ts";
  const BUS = "packages/core/src/bus.ts";
  const EVENTS = "packages/core/src/events.ts";
  const QUEUE = "packages/core/src/queue.ts";

  const expectedImports = [
    [MAIN, CONFIG],
    [BUS, EVENTS],
    [EVENTS, BUS],
    [REGISTRY, BUS],
    [REGISTRY, QUEUE],
    [REGISTRY, RETRY],
  ];

  function pairs(edges: Edge[]): string[] {
    return edges.map((e) => `${e.from} -> ${e.to}`);
  }

  test("every tool resolves the same six repo-internal imports", () => {
    for (const { adapter, artifact } of loadAll()) {
      expect({ tool: adapter.tool, imports: pairs(artifact.imports) }).toEqual({
        tool: adapter.tool,
        imports: expectedImports.map(([a, b]) => `${a} -> ${b}`),
      });
    }
  });

  test("graphify maps class methods through its containment edges", () => {
    const adapter = adapters.find((a) => a.tool === "graphify")!;
    const fixture = fixtures.find((f) => f.tool === "graphify")!;
    const artifact = adapter.load(fixture.dir, fixture.repoRoot);
    expect(pairs(artifact.calls)).toEqual([
      `${MAIN}#main -> ${CONFIG}#loadConfig`,
      `${MAIN}#main -> ${REGISTRY}#createRegistry`,
      `${BUS}#Bus.emit -> ${EVENTS}#formatEvent`,
      `${REGISTRY}#Registry.publishAll -> ${RETRY}#retry`,
      `${REGISTRY}#Registry.register -> ${BUS}#Bus.emit`,
    ]);
    // graphify tags every edge EXTRACTED or INFERRED; only the INFERRED one is med.
    const inferred = artifact.calls.filter((e) => e.confidence === "med");
    expect(pairs(inferred)).toEqual([`${BUS}#Bus.emit -> ${EVENTS}#formatEvent`]);
    // Symbol-level `imports` edges merge into the file-level import they duplicate.
    const registryRetry = artifact.imports.find((e) => e.from === REGISTRY && e.to === RETRY);
    expect(registryRetry?.symbols).toEqual(["retry"]);
  });

  test("ua only reaches class granularity, never methods", () => {
    const adapter = adapters.find((a) => a.tool === "ua")!;
    const fixture = fixtures.find((f) => f.tool === "ua")!;
    const artifact = adapter.load(fixture.dir, fixture.repoRoot);
    expect(pairs(artifact.calls)).toEqual([
      `${MAIN}#main -> ${CONFIG}#loadConfig`,
      `${MAIN}#main -> ${REGISTRY}#createRegistry`,
      `${REGISTRY}#Registry -> ${BUS}#Bus`,
      `${REGISTRY}#Registry -> ${RETRY}#retry`,
    ]);
    for (const e of artifact.calls) expect(e.confidence).toBe("high");
  });

  test("crg maps `file::Class.method` qualified names onto greplost symbol ids", () => {
    const adapter = adapters.find((a) => a.tool === "crg")!;
    const fixture = fixtures.find((f) => f.tool === "crg")!;
    const artifact = adapter.load(fixture.dir, fixture.repoRoot);
    expect(pairs(artifact.calls)).toEqual([
      `${MAIN}#main -> ${CONFIG}#loadConfig`,
      `${MAIN}#main -> ${REGISTRY}#createRegistry`,
      `${BUS}#Bus.emit -> ${EVENTS}#formatEvent`,
      `${REGISTRY}#Registry.publishAll -> ${RETRY}#retry`,
      `${REGISTRY}#Registry.register -> ${BUS}#Bus.emit`,
    ]);
    // The one edge crg tags confidence_tier=INFERRED becomes med.
    const med = artifact.calls.filter((e) => e.confidence === "med");
    expect(pairs(med)).toEqual([`${BUS}#Bus.emit -> ${EVENTS}#formatEvent`]);
  });
});

// ---------------------------------------------------------------------------
// Detection, provenance and pinning.
// ---------------------------------------------------------------------------
describe("detect and pins", () => {
  test("each adapter detects its own fixture and nothing else", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "greplost-adapters-"));
    for (const adapter of adapters) {
      const own = fixtures.find((f) => f.tool === adapter.tool)!;
      expect(adapter.detect(own.dir)).toBe(true);
      expect(adapter.detect(empty)).toBe(false);
      for (const other of fixtures) {
        if (other.tool === adapter.tool) continue;
        expect(adapter.detect(other.dir)).toBe(false);
      }
    }
  });

  test("adapter tools match competitors.json, in the same order", () => {
    expect(adapters.map((a) => a.tool)).toEqual(["graphify", "ua", "crg"]);
    expect(competitorsJson.tools.map((t) => t.name)).toEqual(["graphify", "ua", "crg"]);
    expect(competitorsJson.pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("every pinned tool records a version, a 40-hex commit, commands and paths", () => {
    for (const tool of competitorsJson.tools) {
      expect(tool.repo).toMatch(/^https:\/\/github\.com\//);
      expect(tool.version.length).toBeGreaterThan(0);
      expect(tool.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(tool.install.length).toBeGreaterThan(0);
      expect(tool.run.length).toBeGreaterThan(0);
      expect(tool.artifactPaths.length).toBeGreaterThan(0);
      expect(Object.hasOwn(tool, "syncMechanism")).toBe(true);
      expect(tool.schemaNotes.length).toBeGreaterThan(0);
      expect(tool.sources.length).toBeGreaterThan(0);
    }
  });

  test("the version an adapter reports is the version competitors.json pins", () => {
    for (const { adapter, artifact } of loadAll()) {
      const pinned = competitorsJson.tools.find((t) => t.name === adapter.tool)!;
      expect(artifact.version).toBe(pinned.version);
    }
  });

  test("each fixture carries a SOURCE.md provenance note", () => {
    for (const fixture of fixtures) {
      const note = readFileSync(path.join(fixture.dir, "SOURCE.md"), "utf8");
      expect(note.length).toBeGreaterThan(200);
      expect(note).toContain("https://github.com/");
      expect(note.toLowerCase()).toContain("inferred");
    }
  });

  test("raw records the artifact files the adapter actually read", () => {
    for (const { adapter, artifact } of loadAll()) {
      expect(artifact.tool).toBe(adapter.tool);
      expect(artifact.raw.files.length).toBeGreaterThan(0);
      expect(artifact.raw.files).toEqual([...artifact.raw.files].sort());
      for (const f of artifact.raw.files) expect(isRelativePosixPath(f)).toBe(true);
      expect(artifact.raw.bytes).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Defect hunt: absolute paths, windows separators, node/edge junk.
// ---------------------------------------------------------------------------
describe("robustness", () => {
  function scratch(tool: string): string {
    return mkdtempSync(path.join(tmpdir(), `greplost-${tool}-`));
  }
  function writeArtifact(dir: string, rel: string, value: unknown): void {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, JSON.stringify(value, null, 2));
  }

  const graphify = adapters.find((a) => a.tool === "graphify")!;
  const ua = adapters.find((a) => a.tool === "ua")!;
  const crg = adapters.find((a) => a.tool === "crg")!;

  test("graphify: absolute and windows source_file paths are re-anchored", () => {
    const dir = scratch("gf");
    writeArtifact(dir, "graphify-out/graph.json", {
      directed: true,
      multigraph: false,
      graph: {},
      nodes: [
        { id: "a_ts", label: "a.ts", file_type: "code", source_file: "C:\\work\\repo\\src\\a.ts" },
        { id: "b_ts", label: "b.ts", file_type: "code", source_file: "C:/work/repo/src/b.ts" },
        { id: "c_ts", label: "c.ts", file_type: "code", source_file: "./src/c.ts" },
      ],
      links: [
        { source: "a_ts", target: "b_ts", relation: "imports_from", confidence: "EXTRACTED" },
        { source: "c_ts", target: "b_ts", relation: "imports_from", confidence: "EXTRACTED" },
      ],
    });
    const artifact = graphify.load(dir, "C:\\work\\repo\\");
    expect(artifact.imports.map((e) => `${e.from} -> ${e.to}`)).toEqual([
      "src/a.ts -> src/b.ts",
      "src/c.ts -> src/b.ts",
    ]);
  });

  test("graphify: nodes without a file, unknown targets and junk relations are dropped", () => {
    const dir = scratch("gf");
    writeArtifact(dir, "graphify-out/graph.json", {
      directed: true,
      nodes: [
        { id: "src_a_ts", label: "a.ts", file_type: "code", source_file: "src/a.ts" },
        { id: "src_b_ts", label: "b.ts", file_type: "code", source_file: "src/b.ts" },
        // sourceless cross-file stub: real graphify output, no greplost identity
        { id: "queue", label: "Queue", file_type: "code", source_file: "", origin_file: "src/a.ts" },
        // escapes the repo root
        { id: "out", label: "out.ts", file_type: "code", source_file: "../outside/out.ts" },
        // not code
        { id: "note", label: "NOTE: be careful", file_type: "rationale", source_file: "src/a.ts" },
      ],
      links: [
        { source: "src_a_ts", target: "src_b_ts", relation: "imports_from", confidence: "EXTRACTED" },
        { source: "src_a_ts", target: "queue", relation: "references", confidence: "INFERRED" },
        { source: "src_a_ts", target: "ref_lodash", relation: "imports_from", confidence: "EXTRACTED" },
        { source: "src_a_ts", target: "out", relation: "imports_from", confidence: "EXTRACTED" },
        { source: "note", target: "src_a_ts", relation: "rationale_for", confidence: "EXTRACTED" },
      ],
    });
    const artifact = graphify.load(dir, "/work/repo");
    expect(artifact.imports.map((e) => `${e.from} -> ${e.to}`)).toEqual(["src/a.ts -> src/b.ts"]);
    expect(artifact.calls).toEqual([]);
    expect(artifact.nodes).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("graphify: reads `edges` when the raw writer used it instead of `links`", () => {
    const dir = scratch("gf");
    writeArtifact(dir, "graphify-out/graph.json", {
      nodes: [
        { id: "src_a_ts", label: "a.ts", file_type: "code", source_file: "src/a.ts" },
        { id: "src_b_ts", label: "b.ts", file_type: "code", source_file: "src/b.ts" },
      ],
      edges: [{ source: "src_a_ts", target: "src_b_ts", relation: "imports_from", confidence: "EXTRACTED" }],
    });
    expect(graphify.load(dir, "/repo").imports).toHaveLength(1);
  });

  test("graphify: duplicate edges collapse and merge their symbols", () => {
    const dir = scratch("gf");
    writeArtifact(dir, "graphify-out/graph.json", {
      nodes: [
        { id: "src_a_ts", label: "a.ts", file_type: "code", source_file: "src/a.ts" },
        { id: "src_b_ts", label: "b.ts", file_type: "code", source_file: "src/b.ts" },
        { id: "src_b_one", label: "one()", file_type: "code", source_file: "src/b.ts" },
        { id: "src_b_two", label: "two()", file_type: "code", source_file: "src/b.ts" },
      ],
      links: [
        { source: "src_b_ts", target: "src_b_one", relation: "contains", confidence: "EXTRACTED" },
        { source: "src_b_ts", target: "src_b_two", relation: "contains", confidence: "EXTRACTED" },
        { source: "src_a_ts", target: "src_b_ts", relation: "imports_from", confidence: "EXTRACTED" },
        { source: "src_a_ts", target: "src_b_ts", relation: "imports_from", confidence: "EXTRACTED" },
        { source: "src_a_ts", target: "src_b_two", relation: "imports", confidence: "EXTRACTED" },
        { source: "src_a_ts", target: "src_b_one", relation: "re_exports", confidence: "EXTRACTED" },
      ],
    });
    const artifact = graphify.load(dir, "/repo");
    expect(artifact.imports).toHaveLength(1);
    expect(artifact.imports[0]?.symbols).toEqual(["one", "two"]);
  });

  test("graphify: nested classes build a dotted symbol path", () => {
    // engine.py: "Top-level types (parent None) still source from the file,
    // keeping the containment tree connected: file -> Outer -> Inner."
    const dir = scratch("gf");
    writeArtifact(dir, "graphify-out/graph.json", {
      nodes: [
        { id: "src_a_ts", label: "a.ts", file_type: "code", source_file: "src/a.ts" },
        { id: "src_a_outer", label: "Outer", file_type: "code", source_file: "src/a.ts" },
        { id: "src_a_inner", label: "Inner", file_type: "code", source_file: "src/a.ts" },
        { id: "src_a_inner_run", label: ".run()", file_type: "code", source_file: "src/a.ts" },
        { id: "src_b_ts", label: "b.ts", file_type: "code", source_file: "src/b.ts" },
        { id: "src_b_go", label: "go()", file_type: "code", source_file: "src/b.ts" },
      ],
      links: [
        { source: "src_a_ts", target: "src_a_outer", relation: "contains", confidence: "EXTRACTED" },
        { source: "src_a_outer", target: "src_a_inner", relation: "contains", confidence: "EXTRACTED" },
        { source: "src_a_inner", target: "src_a_inner_run", relation: "method", confidence: "EXTRACTED" },
        { source: "src_b_ts", target: "src_b_go", relation: "contains", confidence: "EXTRACTED" },
        { source: "src_a_inner_run", target: "src_b_go", relation: "calls", confidence: "EXTRACTED" },
      ],
    });
    const artifact = graphify.load(dir, "/repo");
    expect(artifact.calls.map((e) => `${e.from} -> ${e.to}`)).toEqual([
      "src/a.ts#Outer.Inner.run -> src/b.ts#go",
    ]);
  });

  test("graphify: a containment cycle does not hang the adapter", () => {
    const dir = scratch("gf");
    writeArtifact(dir, "graphify-out/graph.json", {
      nodes: [
        { id: "src_a_ts", label: "a.ts", file_type: "code", source_file: "src/a.ts" },
        { id: "x", label: "X", file_type: "code", source_file: "src/a.ts" },
        { id: "y", label: "Y", file_type: "code", source_file: "src/a.ts" },
      ],
      links: [
        { source: "x", target: "y", relation: "contains", confidence: "EXTRACTED" },
        { source: "y", target: "x", relation: "contains", confidence: "EXTRACTED" },
      ],
    });
    // Neither symbol reaches a file node, so neither gets an id; only the file does.
    expect(graphify.load(dir, "/repo").nodes).toEqual(["src/a.ts"]);
  });

  test("graphify: a self-import is dropped", () => {
    const dir = scratch("gf");
    writeArtifact(dir, "graphify-out/graph.json", {
      nodes: [{ id: "src_a_ts", label: "a.ts", file_type: "code", source_file: "src/a.ts" }],
      links: [{ source: "src_a_ts", target: "src_a_ts", relation: "imports_from", confidence: "EXTRACTED" }],
    });
    expect(graphify.load(dir, "/repo").imports).toEqual([]);
  });

  test("ua: backward and bidirectional edges are re-oriented", () => {
    const dir = scratch("ua");
    writeArtifact(dir, ".ua/knowledge-graph.json", {
      version: "2.9.0",
      project: { name: "x", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" },
      nodes: [
        { id: "file:src/a.ts", type: "file", name: "a.ts", filePath: "src/a.ts", summary: "", tags: [], complexity: "simple" },
        { id: "file:src/b.ts", type: "file", name: "b.ts", filePath: "src/b.ts", summary: "", tags: [], complexity: "simple" },
        { id: "file:src/c.ts", type: "file", name: "c.ts", filePath: "src/c.ts", summary: "", tags: [], complexity: "simple" },
      ],
      edges: [
        { source: "file:src/a.ts", target: "file:src/b.ts", type: "imports", direction: "backward", weight: 0.7 },
        { source: "file:src/a.ts", target: "file:src/c.ts", type: "imports", direction: "bidirectional", weight: 0.7 },
      ],
      layers: [],
      tour: [],
    });
    expect(ua.load(dir, "/repo").imports.map((e) => `${e.from} -> ${e.to}`)).toEqual([
      "src/a.ts -> src/c.ts",
      "src/b.ts -> src/a.ts",
      "src/c.ts -> src/a.ts",
    ]);
  });

  test("ua: unmappable node types, unknown endpoints and windows paths", () => {
    const dir = scratch("ua");
    writeArtifact(dir, ".ua/knowledge-graph.json", {
      version: "2.9.0",
      project: { name: "x", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" },
      nodes: [
        { id: "file:src\\a.ts", type: "file", name: "a.ts", filePath: "src\\a.ts", summary: "", tags: [], complexity: "simple" },
        { id: "file:src/b.ts", type: "file", name: "b.ts", filePath: "src/b.ts", summary: "", tags: [], complexity: "simple" },
        { id: "config:tsconfig.json", type: "config", name: "tsconfig.json", filePath: "tsconfig.json", summary: "", tags: [], complexity: "simple" },
        { id: "concept:auth", type: "concept", name: "auth", summary: "", tags: [], complexity: "simple" },
      ],
      edges: [
        { source: "file:src\\a.ts", target: "file:src/b.ts", type: "imports", direction: "forward", weight: 0.7 },
        { source: "config:tsconfig.json", target: "file:src/b.ts", type: "configures", direction: "forward", weight: 0.6 },
        { source: "concept:auth", target: "file:src/b.ts", type: "related", direction: "forward", weight: 0.5 },
        { source: "file:src/b.ts", target: "file:src/ghost.ts", type: "imports", direction: "forward", weight: 0.7 },
        { source: "file:src/b.ts", target: "file:src/a.ts", type: "depends_on", direction: "forward", weight: 0.6 },
      ],
      layers: [],
      tour: [],
    });
    const artifact = ua.load(dir, "/repo");
    expect(artifact.imports.map((e) => `${e.from} -> ${e.to}`)).toEqual(["src/a.ts -> src/b.ts"]);
    expect(artifact.nodes).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("ua: reads the legacy .understand-anything directory too", () => {
    const dir = scratch("ua");
    writeArtifact(dir, ".understand-anything/knowledge-graph.json", {
      version: "2.9.0",
      project: { name: "x", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" },
      nodes: [
        { id: "file:src/a.ts", type: "file", name: "a.ts", filePath: "src/a.ts", summary: "", tags: [], complexity: "simple" },
        { id: "file:src/b.ts", type: "file", name: "b.ts", filePath: "src/b.ts", summary: "", tags: [], complexity: "simple" },
      ],
      edges: [{ source: "file:src/a.ts", target: "file:src/b.ts", type: "imports", direction: "forward", weight: 0.7 }],
      layers: [],
      tour: [],
    });
    expect(ua.detect(dir)).toBe(true);
    expect(ua.load(dir, "/repo").imports).toHaveLength(1);
  });

  test("crg: absolute and windows qualified names are re-anchored", () => {
    const dir = scratch("crg");
    writeArtifact(dir, ".code-review-graph/graph.json", {
      nodes: [
        { id: 1, kind: "File", name: "/work/repo/src/a.ts", qualified_name: "/work/repo/src/a.ts", file_path: "/work/repo/src/a.ts", line_start: 1, line_end: 9, language: "typescript", parent_name: null, is_test: false },
        { id: 2, kind: "File", name: "\\work\\repo\\src\\b.ts", qualified_name: "\\work\\repo\\src\\b.ts", file_path: "\\work\\repo\\src\\b.ts", line_start: 1, line_end: 9, language: "typescript", parent_name: null, is_test: false },
        { id: 3, kind: "Function", name: "go", qualified_name: "/work/repo/src/a.ts::Runner.go", file_path: "/work/repo/src/a.ts", line_start: 2, line_end: 4, language: "typescript", parent_name: "Runner", is_test: false },
        { id: 4, kind: "Function", name: "helper", qualified_name: "\\work\\repo\\src\\b.ts::helper", file_path: "\\work\\repo\\src\\b.ts", line_start: 2, line_end: 4, language: "typescript", parent_name: null, is_test: false },
      ],
      edges: [
        { id: 1, kind: "IMPORTS_FROM", source: "/work/repo/src/a.ts", target: "\\work\\repo\\src\\b.ts", file_path: "/work/repo/src/a.ts", line: 1, confidence: 1.0, confidence_tier: "EXTRACTED" },
        { id: 2, kind: "CALLS", source: "/work/repo/src/a.ts::Runner.go", target: "\\work\\repo\\src\\b.ts::helper", file_path: "/work/repo/src/a.ts", line: 3, confidence: 1.0, confidence_tier: "EXTRACTED" },
      ],
      stats: {},
      flows: [],
      communities: [],
    });
    const artifact = crg.load(dir, "/work/repo");
    expect(artifact.imports.map((e) => `${e.from} -> ${e.to}`)).toEqual(["src/a.ts -> src/b.ts"]);
    expect(artifact.calls.map((e) => `${e.from} -> ${e.to}`)).toEqual([
      "src/a.ts#Runner.go -> src/b.ts#helper",
    ]);
  });

  test("crg: unknown endpoints, CONTAINS and non-code kinds are dropped", () => {
    const dir = scratch("crg");
    writeArtifact(dir, ".code-review-graph/graph.json", {
      nodes: [
        { id: 1, kind: "File", name: "src/a.ts", qualified_name: "src/a.ts", file_path: "src/a.ts", line_start: 1, line_end: 9, language: "typescript", parent_name: null, is_test: false },
        { id: 2, kind: "File", name: "src/b.ts", qualified_name: "src/b.ts", file_path: "src/b.ts", line_start: 1, line_end: 9, language: "typescript", parent_name: null, is_test: false },
        { id: 3, kind: "Function", name: "go", qualified_name: "src/a.ts::go", file_path: "src/a.ts", line_start: 2, line_end: 4, language: "typescript", parent_name: null, is_test: false },
        { id: 4, kind: "ConfigProperty", name: "server.port", qualified_name: "application.yml::server.port", file_path: "application.yml", line_start: 1, line_end: 1, language: "yaml", parent_name: null, is_test: false },
      ],
      edges: [
        { id: 1, kind: "IMPORTS_FROM", source: "src/a.ts", target: "src/b.ts", file_path: "src/a.ts", line: 1, confidence: 1.0, confidence_tier: "EXTRACTED" },
        { id: 2, kind: "IMPORTS_FROM", source: "src/a.ts", target: "lodash", file_path: "src/a.ts", line: 2, confidence: 1.0, confidence_tier: "EXTRACTED" },
        { id: 3, kind: "CONTAINS", source: "src/a.ts", target: "src/a.ts::go", file_path: "src/a.ts", line: 2, confidence: 1.0, confidence_tier: "EXTRACTED" },
        { id: 4, kind: "CALLS", source: "src/a.ts::go", target: "src/b.ts::missing", file_path: "src/a.ts", line: 3, confidence: 1.0, confidence_tier: "EXTRACTED" },
        { id: 5, kind: "DEPENDS_ON_CONFIG", source: "src/a.ts::go", target: "application.yml::server.port", file_path: "src/a.ts", line: 3, confidence: 1.0, confidence_tier: "EXTRACTED" },
      ],
      stats: {},
      flows: [],
      communities: [],
    });
    const artifact = crg.load(dir, "");
    expect(artifact.imports.map((e) => `${e.from} -> ${e.to}`)).toEqual(["src/a.ts -> src/b.ts"]);
    expect(artifact.calls).toEqual([]);
    expect(artifact.nodes).toEqual(["src/a.ts", "src/a.ts#go", "src/b.ts"]);
  });

  test("crg: a missing confidence_tier falls back to the numeric confidence", () => {
    const dir = scratch("crg");
    writeArtifact(dir, ".code-review-graph/graph.json", {
      nodes: [
        { id: 1, kind: "File", name: "src/a.ts", qualified_name: "src/a.ts", file_path: "src/a.ts", line_start: 1, line_end: 9, language: "typescript", parent_name: null, is_test: false },
        { id: 2, kind: "Function", name: "go", qualified_name: "src/a.ts::go", file_path: "src/a.ts", line_start: 2, line_end: 4, language: "typescript", parent_name: null, is_test: false },
        { id: 3, kind: "Function", name: "stop", qualified_name: "src/a.ts::stop", file_path: "src/a.ts", line_start: 6, line_end: 8, language: "typescript", parent_name: null, is_test: false },
      ],
      edges: [
        { id: 1, kind: "CALLS", source: "src/a.ts::go", target: "src/a.ts::stop", file_path: "src/a.ts", line: 3, confidence: 0.4 },
      ],
      stats: {},
      flows: [],
      communities: [],
    });
    expect(crg.load(dir, "").calls[0]?.confidence).toBe("med");
  });

  test("a missing artifact throws a greplost-prefixed error", () => {
    const dir = scratch("missing");
    for (const adapter of adapters) {
      expect(adapter.detect(dir)).toBe(false);
      expect(() => adapter.load(dir, "/repo")).toThrow(/greplost:/);
    }
  });

  const artifactPath: Record<string, string> = {
    graphify: "graphify-out/graph.json",
    ua: ".ua/knowledge-graph.json",
    crg: ".code-review-graph/graph.json",
  };

  test("unparseable and non-object artifacts throw a greplost-prefixed error", () => {
    for (const adapter of adapters) {
      const rel = artifactPath[adapter.tool]!;

      const broken = scratch(adapter.tool);
      const brokenFile = path.join(broken, rel);
      mkdirSync(path.dirname(brokenFile), { recursive: true });
      writeFileSync(brokenFile, "{ not json");
      expect(adapter.detect(broken)).toBe(true);
      expect(() => adapter.load(broken, "/repo")).toThrow(/greplost: .*not valid JSON/);

      const wrongShape = scratch(adapter.tool);
      writeArtifact(wrongShape, rel, ["nodes", "edges"]);
      expect(() => adapter.load(wrongShape, "/repo")).toThrow(/greplost: .*not a JSON object/);
    }
  });

  test("an artifact with no nodes or edges yields an empty, still-valid result", () => {
    for (const adapter of adapters) {
      const dir = scratch(adapter.tool);
      writeArtifact(dir, artifactPath[adapter.tool]!, {});
      const artifact = adapter.load(dir, "/repo");
      expect(artifact.imports).toEqual([]);
      expect(artifact.calls).toEqual([]);
      expect(artifact.nodes).toEqual([]);
      expect(artifact.raw.files).toEqual([artifactPath[adapter.tool]!]);
      expect(artifact.raw.bytes).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// G6: the suite entry point the driver-owned dispatcher calls.
// ---------------------------------------------------------------------------
describe("suite run", () => {
  test("roundtrip prints one count line per tool and exits 0", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    let code: number;
    try {
      code = await run(["roundtrip"]);
    } finally {
      console.log = original;
    }
    expect(code).toBe(0);
    expect(lines).toEqual([
      "graphify: 6 imports, 5 calls",
      "ua: 6 imports, 4 calls",
      "crg: 6 imports, 5 calls",
    ]);
  });

  test("an unknown sub-command is rejected without throwing", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      expect(await run(["nope"])).toBe(2);
    } finally {
      console.error = original;
    }
  });
});
