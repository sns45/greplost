/**
 * greplost:render document tests (leaf 1.2.2).
 *
 * The golden render of `fixtures/tiny-ts` is the anchor: every artifact is
 * compared byte for byte against `test/golden/tiny-ts/**`, and the surrounding
 * describes assert the properties the golden alone cannot (token budget under
 * 500 packages, node cap under 300 files, card field formats, staleness,
 * leak-freedom, determinism).
 *
 * `GREPLOST_UPDATE_GOLDEN=1 bun test packages/render/test/docs.test.ts`
 * rewrites the golden tree.
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildSnapshot, sha256Hex } from "@greplost/core";
import type {
  CallEdge,
  Declaration,
  ExportRecord,
  FileEntry,
  FileRecord,
  GreplostConfig,
  ImportEdge,
  Manifest,
  PackageEntry,
  PackageInfo,
  Snapshot,
  SummaryCache,
} from "@greplost/core/schema";
import { DEFAULT_CONFIG, SCHEMA_VERSION, compareStrings, packageSlug } from "@greplost/core/schema";

import {
  INDEX_TOKEN_BUDGET,
  estimateTokens,
  renderApi,
  renderArtifacts,
  renderCard,
  renderHotspots,
  renderIndex,
  renderPackageMap,
  renderRepoMap,
} from "../src/index.ts";
import type { RenderInput } from "../src/index.ts";

const FIXTURE_ROOT = path.resolve(import.meta.dir, "../../../fixtures/tiny-ts");
const GOLDEN_DIR = path.resolve(import.meta.dir, "golden/tiny-ts");
const UPDATE = process.env.GREPLOST_UPDATE_GOLDEN === "1";

/** Seeded exactly as the render spec's "Golden test" section describes. */
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

let input: RenderInput;
let artifacts: Map<string, string>;

beforeAll(async () => {
  const summaries = goldenSummaries();
  const snapshot = await buildSnapshot({ root: FIXTURE_ROOT, summaries });
  input = { snapshot, summaries };
  artifacts = renderArtifacts(input);
});

// --------------------------------------------------------------------------
// Synthetic snapshots: hand-built Snapshot objects, never a real repo on disk.
// --------------------------------------------------------------------------

interface SynthFile {
  path: string;
  pkg: string;
  loc?: number;
  exports?: string[];
  fanIn?: number;
  fanOut?: number;
  blast?: number;
  decls?: Declaration[];
  staleSummary?: boolean;
  summaryHash?: string;
  /** Export records as the extractor would emit them; defaults to plain named exports. */
  exportRecords?: ExportRecord[];
}

interface SynthOptions {
  packages: Array<{ name: string; path: string; source?: PackageInfo["source"] }>;
  files?: SynthFile[];
  imports?: ImportEdge[];
  calls?: CallEdge[];
  config?: Partial<GreplostConfig>;
  packageEdges?: Array<{ from: string; to: string; count: number }>;
  cycles?: string[][];
}

function synthSnapshot(opts: SynthOptions): Snapshot {
  const config: GreplostConfig = {
    ...DEFAULT_CONFIG,
    ...opts.config,
    diagram: { ...DEFAULT_CONFIG.diagram, ...(opts.config?.diagram ?? {}) },
  };
  const packages: PackageInfo[] = opts.packages.map((p) => ({
    name: p.name,
    path: p.path,
    source: p.source ?? (p.path === "." ? "root" : "package.json"),
  }));
  const synthFiles = [...(opts.files ?? [])].sort((a, b) => compareStrings(a.path, b.path));

  const files: FileRecord[] = synthFiles.map((f) => ({
    path: f.path,
    lang: "ts",
    sha256: sha256Hex(f.path),
    loc: f.loc ?? 10,
    decls: f.decls ?? [],
    imports: [],
    exports: f.exportRecords ?? (f.exports ?? []).map((name) => ({ name, kind: "named" as const })),
    calls: [],
  }));

  // Every edge gets the matching per-file ImportRecord a real extraction would
  // have produced, so cards see the same imports the graph does.
  const recordByPath = new Map(files.map((f) => [f.path, f]));
  for (const edge of opts.imports ?? []) {
    const record = recordByPath.get(edge.from);
    if (record === undefined) continue;
    record.imports.push({
      specifier: edge.specifier,
      kind: edge.importKind,
      symbols: (edge.symbols ?? []).map((name) => ({ name, local: name })),
      reexport: edge.kind === "reexport",
      line: record.imports.length + 1,
    });
  }

  const manifestFiles: Record<string, FileEntry> = {};
  for (const f of synthFiles) {
    manifestFiles[f.path] = {
      sha256: sha256Hex(f.path),
      pkg: f.pkg,
      lang: "ts",
      loc: f.loc ?? 10,
      exports: [...(f.exports ?? [])].sort(compareStrings),
      fanIn: f.fanIn ?? 0,
      fanOut: f.fanOut ?? 0,
      blast: f.blast ?? 0,
      staleSummary: f.staleSummary ?? false,
      ...(f.summaryHash === undefined ? {} : { summaryHash: f.summaryHash }),
    };
  }

  const manifestPackages: Record<string, PackageEntry> = {};
  for (const p of packages) {
    const own = synthFiles.filter((f) => f.pkg === p.name);
    manifestPackages[p.name] = {
      path: p.path,
      deps: [],
      rdeps: [],
      loc: own.reduce((sum, f) => sum + (f.loc ?? 10), 0),
      files: own.length,
    };
  }
  for (const edge of opts.packageEdges ?? []) {
    const from = manifestPackages[edge.from];
    const to = manifestPackages[edge.to];
    if (from && !from.deps.includes(edge.to)) from.deps.push(edge.to);
    if (to && !to.rdeps.includes(edge.from)) to.rdeps.push(edge.from);
  }
  for (const entry of Object.values(manifestPackages)) {
    entry.deps.sort(compareStrings);
    entry.rdeps.sort(compareStrings);
  }

  const manifest: Manifest = { version: SCHEMA_VERSION, packages: manifestPackages, files: manifestFiles };
  const symbols: Declaration[] = files.flatMap((f) => f.decls);

  return {
    root: "/synthetic",
    config,
    packages,
    files,
    manifest,
    imports: opts.imports ?? [],
    calls: opts.calls ?? [],
    symbols,
    metrics: { cycles: opts.cycles ?? [], packageEdges: opts.packageEdges ?? [] },
  };
}

function synthInput(opts: SynthOptions): RenderInput {
  return { snapshot: synthSnapshot(opts), summaries: {} };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** A monorepo of `count` packages under `packages/`, two source files each. */
function manyPackages(count: number): RenderInput {
  const packages: SynthOptions["packages"] = [{ name: "synth-root", path: "." }];
  const files: SynthFile[] = [];
  const imports: ImportEdge[] = [];
  const packageEdges: Array<{ from: string; to: string; count: number }> = [];
  const hubName = "@acme/pkg-" + pad(0, 3);
  const hub = "packages/pkg-" + pad(0, 3) + "/src/index.ts";
  for (let i = 0; i < count; i++) {
    const name = "@acme/pkg-" + pad(i, 3);
    const dir = "packages/pkg-" + pad(i, 3);
    packages.push({ name, path: dir });
    files.push({ path: dir + "/src/index.ts", pkg: name, loc: 40 + (i % 30), exports: ["main"], blast: 1 });
    files.push({ path: dir + "/src/util.ts", pkg: name, loc: 20 + (i % 17), exports: ["helper"], blast: 1 });
    if (i > 0) {
      imports.push({
        from: dir + "/src/index.ts",
        to: hub,
        kind: "import",
        symbols: ["main"],
        confidence: "high",
        specifier: hubName,
        importKind: "static",
      });
      packageEdges.push({ from: name, to: hubName, count: 1 });
    }
  }
  const hubFile = files.find((f) => f.path === hub);
  if (hubFile) {
    hubFile.fanIn = count - 1;
    hubFile.blast = count - 1;
  }
  return synthInput({ packages, files, imports, packageEdges });
}

/** One package holding `count` files spread over `dirs` directories. */
function manyFiles(count: number, dirs: number, maxNodes: number): RenderInput {
  const pkg = "@acme/wide";
  const dir = "packages/wide";
  const files: SynthFile[] = [];
  const imports: ImportEdge[] = [];
  for (let i = 0; i < count; i++) {
    const sub = "d" + pad(i % dirs, 2);
    files.push({ path: dir + "/src/" + sub + "/f" + pad(i, 3) + ".ts", pkg, loc: 12, exports: ["x" + i] });
  }
  for (let i = 1; i < count; i++) {
    const a = files[i]?.path ?? "";
    const b = files[i - 1]?.path ?? "";
    imports.push({
      from: a,
      to: b,
      kind: "import",
      symbols: ["x"],
      confidence: "high",
      specifier: "./neighbour",
      importKind: "static",
    });
  }
  return synthInput({
    packages: [{ name: "synth-root", path: "." }, { name: pkg, path: dir }],
    files,
    imports,
    config: { diagram: { maxNodes, splitBy: "directory" } },
  });
}

/** The same wide package, but rooted at "." so its diagram titles come from its name. */
function manyFilesInRootPackage(count: number, dirs: number, maxNodes: number): RenderInput {
  const files: SynthFile[] = [];
  for (let i = 0; i < count; i++) {
    files.push({ path: "src/d" + pad(i % dirs, 2) + "/f" + pad(i, 3) + ".ts", pkg: "solo", loc: 12 });
  }
  return synthInput({
    packages: [{ name: "solo", path: "." }],
    files,
    config: { diagram: { maxNodes, splitBy: "directory" } },
  });
}

// --------------------------------------------------------------------------
// Shared helpers
// --------------------------------------------------------------------------

/** Node lines inside every ```mermaid fence of `text`, one array per fence. */
function mermaidNodeCounts(text: string): number[] {
  const counts: number[] = [];
  let inFence = false;
  let count = 0;
  for (const line of text.split("\n")) {
    if (line === "```mermaid") {
      inFence = true;
      count = 0;
      continue;
    }
    if (inFence && line === "```") {
      inFence = false;
      counts.push(count);
      continue;
    }
    if (inFence && /^ {2}[A-Za-z_][A-Za-z0-9_]*\[/.test(line)) count += 1;
  }
  return counts;
}

function tableRows(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) return [];
  const rows: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("## ") && rows.length > 0) break;
    if (!line.startsWith("|")) continue;
    if (/^\|(?:-+\|)+$/.test(line.replace(/\s/g, ""))) continue;
    if (line.startsWith("| Package |") || line.startsWith("| File |")) continue;
    rows.push(line);
  }
  return rows;
}

function fieldLine(card: string, label: string): string {
  const line = card.split("\n").find((l) => l.startsWith("**" + label + ":**"));
  return line ?? "";
}

/** `text` with fenced code blocks and inline code spans removed. */
function withoutCode(text: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line.replace(/`[^`]*`/g, ""));
  }
  return kept.join("\n");
}

function listGoldenFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort(compareStrings)) {
    const full = path.join(dir, name);
    const rel = prefix === "" ? name : prefix + "/" + name;
    if (statSync(full).isDirectory()) out.push(...listGoldenFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

// --------------------------------------------------------------------------

describe("golden", () => {
  test("renders the tiny-ts fixture byte for byte", () => {
    if (UPDATE) {
      rmSync(GOLDEN_DIR, { recursive: true, force: true });
      for (const [rel, text] of artifacts) {
        const full = path.join(GOLDEN_DIR, rel);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, text);
      }
    }
    const expected = listGoldenFiles(GOLDEN_DIR);
    expect(expected.length).toBeGreaterThan(0);
    expect([...artifacts.keys()].sort(compareStrings)).toEqual(expected);
    for (const rel of expected) {
      expect(artifacts.get(rel)).toBe(readFileSync(path.join(GOLDEN_DIR, rel), "utf8"));
    }
  });

  test("covers every package and every file", () => {
    for (const pkg of input.snapshot.packages) {
      const dir = "packages/" + packageSlug(pkg.name);
      expect(artifacts.has(dir + "/MAP.md")).toBe(true);
      expect(artifacts.has(dir + "/API.md")).toBe(true);
    }
    expect([...artifacts.keys()].filter((k) => k.includes("/modules/")).length).toBe(input.snapshot.files.length);
    expect(artifacts.has("INDEX.md")).toBe(true);
    expect(artifacts.has("repo/MAP.md")).toBe(true);
    expect(artifacts.has("repo/HOTSPOTS.md")).toBe(true);
  });

  test("every artifact carries the generated-by header under a level-1 title", () => {
    for (const [rel, text] of artifacts) {
      const lines = text.split("\n");
      expect(lines[0]?.startsWith("# ")).toBe(true);
      expect(lines[1]).toBe("");
      expect(lines[2]).toBe("> Generated by greplost. Do not edit by hand; run `greplost update`.");
      expect(text.endsWith("\n")).toBe(true);
      expect(text.endsWith("\n\n")).toBe(false);
      expect(rel.endsWith(".md")).toBe(true);
    }
  });

  test("every markdown link inside an artifact resolves to another artifact", () => {
    for (const [rel, text] of artifacts) {
      for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1] ?? "";
        if (target.startsWith("http")) continue;
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target));
        expect({ rel, target, resolved, known: artifacts.has(resolved) }).toEqual({
          rel,
          target,
          resolved,
          known: true,
        });
      }
    }
  });
});

describe("INDEX budget", () => {
  for (const count of [5, 60, 500]) {
    test("stays within the token budget with " + count + " packages", () => {
      const synthetic = manyPackages(count);
      const text = renderIndex(synthetic);
      expect(estimateTokens(text)).toBeLessThanOrEqual(INDEX_TOKEN_BUDGET);
      expect(estimateTokens(text)).toBeLessThanOrEqual(3000);
      const rows = tableRows(text, "## Packages (" + (count + 1) + ")");
      expect(rows.length).toBeGreaterThan(0);
      const total = count + 1;
      if (rows.length < total) {
        expect(text).toContain("… and " + (total - rows.length) + " more packages, see repo/MAP.md");
        expect(rows.length).toBeGreaterThanOrEqual(1);
      } else {
        expect(text).not.toContain("more packages, see repo/MAP.md");
      }
    });
  }

  test("keeps every package when the repo is small", () => {
    const text = renderIndex(manyPackages(5));
    expect(tableRows(text, "## Packages (6)").length).toBe(6);
    expect(text).toContain("## Hotspots");
    expect(text).toContain("Most imported:");
  });

  test("degrades the table before the tree and the tree before the hotspot lists", () => {
    const text = renderIndex(manyPackages(500));
    // The tree is cut (a depth-2 tree of 500 packages cannot fit), the table is
    // cut, but the hotspot lists are the last thing to go and must survive.
    expect(text).toContain("… and ");
    expect(text).toContain("- Most imported: ");
    expect(text).toContain("- Largest blast radius: ");
    expect(text).toContain("- Import cycles: ");
    expect(text).toContain("## Navigation");
    expect(text).toContain("[repo/MAP.md](repo/MAP.md)");
  });

  test("re-maximises the table against the smaller tree instead of pinning it at 10", () => {
    const text = renderIndex(manyPackages(500));
    const rows = tableRows(text, "## Packages (501)");
    expect(rows.length).toBeGreaterThanOrEqual(40);
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(2400);
    expect(tokens).toBeLessThanOrEqual(3000);
  });

  test("the fixture INDEX is well under budget", () => {
    expect(estimateTokens(artifacts.get("INDEX.md") ?? "")).toBeLessThanOrEqual(INDEX_TOKEN_BUDGET);
  });
});

describe("node cap", () => {
  test("no fence in the fixture render exceeds the configured cap", () => {
    const cap = input.snapshot.config.diagram.maxNodes;
    let fences = 0;
    for (const text of artifacts.values()) {
      for (const count of mermaidNodeCounts(text)) {
        fences += 1;
        expect(count).toBeLessThanOrEqual(cap);
      }
    }
    expect(fences).toBeGreaterThan(0);
  });

  for (const cap of [25, 7, 3]) {
    test("no fence exceeds a cap of " + cap + " for a 300-file package", () => {
      const synthetic = manyFiles(300, 12, cap);
      const rendered = renderArtifacts(synthetic);
      let fences = 0;
      for (const text of rendered.values()) {
        for (const count of mermaidNodeCounts(text)) {
          fences += 1;
          expect(count).toBeLessThanOrEqual(cap);
        }
      }
      expect(fences).toBeGreaterThan(1);
    });
  }

  test("a split package map labels each diagram with its own heading", () => {
    const rendered = renderArtifacts(manyFiles(300, 12, 25));
    const map = rendered.get("packages/acme__wide/MAP.md") ?? "";
    expect(map).toContain("### packages/wide (overview)");
    expect(map.split("```mermaid").length - 1).toBeGreaterThan(1);
  });
});

describe("card", () => {
  test("separates every field with a blank line so GitHub renders paragraphs", () => {
    for (const [rel, text] of artifacts) {
      if (!rel.includes("/modules/")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        const here = lines[i] ?? "";
        const next = lines[i + 1] ?? "";
        if (!here.startsWith("**")) continue;
        // A field is a paragraph of its own: the only thing that may follow its
        // line directly is its own bullet list (Key symbols).
        const ok = next === "" || next.startsWith("- ");
        expect({ rel, here, next, ok }).toEqual({ rel, here, next, ok: true });
      }
      const callsAt = lines.findIndex((l) => l.startsWith("**Calls:**"));
      if (callsAt !== -1) expect({ rel, before: lines[callsAt - 1] }).toEqual({ rel, before: "" });
      // Trailing double spaces are not a line-break mechanism here: editors strip them.
      expect({ rel, hit: /  $/m.test(text) }).toEqual({ rel, hit: false });
    }
  });

  test("keeps the staleness banner as its own blockquote", () => {
    const bus = artifacts.get("packages/tiny__core/modules/src/bus.ts.md") ?? "";
    expect(bus).toContain(
      "> Fan-out event bus used by the registry.\n\n> summary may lag code, last refreshed 2026-08-15\n",
    );
  });

  test("formats exports as signatures for callables and name (kind) otherwise", () => {
    const sqs = artifacts.get("packages/tiny__adapters/modules/src/sqs.ts.md") ?? "";
    expect(fieldLine(sqs, "Exports")).toBe(
      "**Exports:** `SqsAdapter (class)`, `SqsConfig (interface)`, `createSqsAdapter(cfg: SqsConfig): SqsAdapter`",
    );
    const types = artifacts.get("packages/tiny__core/modules/src/types.ts.md") ?? "";
    expect(fieldLine(types, "Exports")).toBe(
      "**Exports:** `Handler (type)`, `Priority (enum)`, `VERSION (const)`",
    );
  });

  test("renders None. for a file that exports nothing", () => {
    const rendered = renderArtifacts(
      synthInput({
        packages: [{ name: "solo", path: "." }],
        files: [{ path: "src/private.ts", pkg: "solo", exports: [] }],
      }),
    );
    const text = rendered.get("packages/solo/modules/src/private.ts.md") ?? "";
    expect(fieldLine(text, "Exports")).toBe("**Exports:** None.");
    expect(fieldLine(text, "Imports")).toBe("**Imports:** None.");
    expect(fieldLine(text, "Imported by")).toBe("**Imported by:** None.");
    expect(text).not.toContain("**Calls:**");
  });

  test("groups imports by specifier in source order with sorted symbols", () => {
    const sqs = artifacts.get("packages/tiny__adapters/modules/src/sqs.ts.md") ?? "";
    expect(fieldLine(sqs, "Imports")).toBe(
      "**Imports:** [`@tiny/core`](../../../tiny__core/modules/src/index.ts.md) (Ack, Msg, Priority, Queue, retry), `@aws-sdk/client-sqs` (SQSClient, SendMessageCommand)",
    );
  });

  test("marks an unresolved specifier and leaves it unlinked", () => {
    const rendered = renderArtifacts(
      synthInput({
        packages: [{ name: "solo", path: "." }],
        files: [{ path: "src/a.ts", pkg: "solo", exports: ["a"] }],
        imports: [
          {
            from: "src/a.ts",
            to: "unresolved:./missing",
            kind: "import",
            symbols: ["Gone"],
            confidence: "high",
            specifier: "./missing",
            importKind: "static",
          },
        ],
      }),
    );
    const text = rendered.get("packages/solo/modules/src/a.ts.md") ?? "";
    expect(fieldLine(text, "Imports")).toBe("**Imports:** `./missing` (unresolved)");
  });

  test("lists a side-effect import with no symbol list", () => {
    const rendered = renderArtifacts(
      synthInput({
        packages: [{ name: "solo", path: "." }],
        files: [
          { path: "src/a.ts", pkg: "solo", exports: ["a"] },
          { path: "src/polyfill.ts", pkg: "solo", exports: [] },
        ],
        imports: [
          {
            from: "src/a.ts",
            to: "src/polyfill.ts",
            kind: "import",
            symbols: [],
            confidence: "high",
            specifier: "./polyfill",
            importKind: "side-effect",
          },
        ],
      }),
    );
    const text = rendered.get("packages/solo/modules/src/a.ts.md") ?? "";
    expect(fieldLine(text, "Imports")).toBe("**Imports:** [`./polyfill`](polyfill.ts.md)");
  });

  test("links every importer to its own module card", () => {
    const retry = artifacts.get("packages/tiny__core/modules/src/retry.ts.md") ?? "";
    expect(fieldLine(retry, "Imported by")).toBe(
      "**Imported by:** [`packages/core/src/index.ts`](index.ts.md), [`packages/core/src/registry.ts`](registry.ts.md)",
    );
  });

  test("states the blast radius with the impact command", () => {
    const types = artifacts.get("packages/tiny__core/modules/src/types.ts.md") ?? "";
    expect(fieldLine(types, "Blast radius")).toBe(
      "**Blast radius:** 9 files (`greplost impact packages/core/src/types.ts`)",
    );
  });

  test("lists key symbols in line order, qualified by their parent", () => {
    const registry = artifacts.get("packages/tiny__core/modules/src/registry.ts.md") ?? "";
    const symbols = registry
      .split("\n")
      .filter((l) => l.startsWith("- `"))
      .join("\n");
    expect(symbols).toBe(
      [
        "- `class Registry`  L5-26",
        "- `Registry.register(name: string, queue: Queue): void`  L9-12",
        "- `Registry.publishAll(msg: string): Promise<number>`  L14-21",
        "- `Registry.get(name: string): Queue | undefined`  L23-25",
        "- `function createRegistry(): Registry`  L28-30",
      ].join("\n"),
    );
  });

  test("caps key symbols at 50 and says how many were dropped", () => {
    const decls: Declaration[] = [];
    for (let i = 0; i < 60; i++) {
      decls.push({
        id: "src/big.ts#fn" + pad(i, 2),
        file: "src/big.ts",
        name: "fn" + pad(i, 2),
        kind: "function",
        signature: "export function fn" + pad(i, 2) + "(): void",
        exported: true,
        span: [i + 1, i + 1],
      });
    }
    const rendered = renderArtifacts(
      synthInput({
        packages: [{ name: "solo", path: "." }],
        files: [{ path: "src/big.ts", pkg: "solo", exports: decls.map((d) => d.name), decls }],
      }),
    );
    const text = rendered.get("packages/solo/modules/src/big.ts.md") ?? "";
    const bullets = text.split("\n").filter((l) => l.startsWith("- `"));
    expect(bullets.length).toBe(50);
    expect(text).toContain("- … 10 more");
  });

  test("lists resolved calls with their confidence and card links", () => {
    const sqs = artifacts.get("packages/tiny__adapters/modules/src/sqs.ts.md") ?? "";
    expect(fieldLine(sqs, "Calls")).toBe(
      "**Calls:** `SqsAdapter` → [`packages/adapters/src/sqs.ts#SqsAdapter`](sqs.ts.md) (high), " +
        "`retry` → [`packages/core/src/retry.ts#retry`](../../../tiny__core/modules/src/retry.ts.md) (med)",
    );
  });

  test("names the package and links its map", () => {
    const bus = artifacts.get("packages/tiny__core/modules/src/bus.ts.md") ?? "";
    expect(fieldLine(bus, "Package")).toBe("**Package:** `@tiny/core` ([map](../../MAP.md))");
  });

  test("uses the full repo path for a root-package module", () => {
    const rendered = renderArtifacts(
      synthInput({
        packages: [{ name: "solo", path: "." }],
        files: [{ path: "src/deep/nested/a.ts", pkg: "solo", exports: ["a"] }],
      }),
    );
    const text = rendered.get("packages/solo/modules/src/deep/nested/a.ts.md") ?? "";
    expect(text.split("\n")[0]).toBe("# src/deep/nested/a.ts");
    expect(fieldLine(text, "Package")).toBe("**Package:** `solo` ([map](../../../../MAP.md))");
  });

  test("renders a callable const export as a signature", () => {
    const decls: Declaration[] = [
      {
        id: "src/fn.ts#add",
        file: "src/fn.ts",
        name: "add",
        kind: "const",
        signature: "export const add = (a: number, b: number): number =>",
        exported: true,
        span: [1, 1],
      },
      {
        id: "src/fn.ts#LIMIT",
        file: "src/fn.ts",
        name: "LIMIT",
        kind: "const",
        signature: "export const LIMIT = 3",
        exported: true,
        span: [2, 2],
      },
    ];
    const rendered = renderArtifacts(
      synthInput({
        packages: [{ name: "solo", path: "." }],
        files: [{ path: "src/fn.ts", pkg: "solo", exports: ["LIMIT", "add"], decls }],
      }),
    );
    const text = rendered.get("packages/solo/modules/src/fn.ts.md") ?? "";
    expect(fieldLine(text, "Exports")).toBe("**Exports:** `LIMIT (const)`, `add(a: number, b: number): number`");
  });
});

describe("package docs", () => {
  test("a package with no indexed files is left out of the tree and the diagram", () => {
    const index = artifacts.get("INDEX.md") ?? "";
    const repo = artifacts.get("repo/MAP.md") ?? "";
    // tiny-ts (the fixture root) has zero indexed files.
    const indexTree = index.slice(index.indexOf("```text"), index.indexOf("| Package |"));
    expect(indexTree).not.toContain("tiny-ts");
    const repoTree = repo.slice(repo.indexOf("```text"), repo.indexOf("## Package dependencies"));
    expect(repoTree).not.toContain("tiny-ts");
    const diagram = repo.slice(repo.indexOf("## Package dependencies"), repo.indexOf("## Packages"));
    expect(diagram).not.toContain("tiny_ts");
    // But it keeps its table row in both documents, and its own artifacts.
    expect(index).toContain("| tiny-ts | . | 0 | 0 |");
    expect(repo).toContain("| tiny-ts | . | 0 | 0 | none |");
    expect(artifacts.has("packages/tiny-ts/MAP.md")).toBe(true);
  });

  test("renderArtifacts refuses two package names that slug to one directory", () => {
    const input = synthInput({
      packages: [
        { name: "root", path: "." },
        { name: "@tiny/core", path: "packages/a" },
        { name: "tiny__core", path: "packages/b" },
      ],
      files: [
        { path: "packages/a/x.ts", pkg: "@tiny/core", exports: ["x"] },
        { path: "packages/b/y.ts", pkg: "tiny__core", exports: ["y"] },
      ],
    });
    expect(() => renderArtifacts(input)).toThrow(
      "greplost: package slug collision: @tiny/core and tiny__core both map to packages/tiny__core",
    );
  });

  test("API.md keeps a section for an anonymous default export", () => {
    const rendered = renderArtifacts(
      synthInput({
        packages: [{ name: "solo", path: "." }],
        files: [{ path: "src/anon.ts", pkg: "solo", exports: ["default"], exportRecords: [{ name: "default", kind: "default" }] }],
      }),
    );
    const api = rendered.get("packages/solo/API.md") ?? "";
    expect(api).toContain("## src/anon.ts");
    expect(api).toContain("- `default` (expression)");
  });

  test("a renamed export shows the local declaration's signature", () => {
    const decls: Declaration[] = [
      {
        id: "src/r.ts#helper",
        file: "src/r.ts",
        name: "helper",
        kind: "function",
        signature: "function helper(x: string): number",
        exported: false,
        span: [1, 3],
      },
    ];
    const rendered = renderArtifacts(
      synthInput({
        packages: [{ name: "solo", path: "." }],
        files: [
          {
            path: "src/r.ts",
            pkg: "solo",
            exports: ["pub"],
            decls,
            exportRecords: [{ name: "pub", kind: "named", local: "helper" }],
          },
        ],
      }),
    );
    const card = rendered.get("packages/solo/modules/src/r.ts.md") ?? "";
    expect(fieldLine(card, "Exports")).toBe("**Exports:** `helper(x: string): number`");
    expect(rendered.get("packages/solo/API.md") ?? "").toContain(
      "- `function helper(x: string): number` L1-3",
    );
  });

  test("an empty package renders None. in every section", () => {
    const map = artifacts.get("packages/tiny-ts/MAP.md") ?? "";
    expect(map.split("\n")[0]).toBe("# tiny-ts");
    expect(map).toContain("Path: `.` · 0 files · 0 LOC · depends on: none · depended on by: none");
    expect(map).toContain("## Modules\n\nNone.");
    expect(map).toContain("## Module table\n\nNone.");
    expect(map).toContain("## Components\n\nNone.");
    expect(map).toContain("## External dependencies\n\nNone.");
    expect(map).not.toContain("```");
  });

  test("a package whose files export nothing says so in API.md", () => {
    const rendered = renderArtifacts(
      synthInput({
        packages: [
          { name: "root", path: "." },
          { name: "quiet", path: "packages/quiet" },
        ],
        files: [{ path: "packages/quiet/src/main.ts", pkg: "quiet", exports: [] }],
      }),
    );
    expect(rendered.get("packages/quiet/API.md")).toBe(
      [
        "# quiet: API",
        "",
        "> Generated by greplost. Do not edit by hand; run `greplost update`.",
        "",
        "No exported symbols.",
        "",
      ].join("\n"),
    );
    expect(rendered.get("packages/root/API.md") ?? "").toContain("No exported symbols.");
  });

  test("a single component diagram carries no heading, like the container view", () => {
    const map = artifacts.get("packages/tiny__core/MAP.md") ?? "";
    const section = map.slice(map.indexOf("## Components"), map.indexOf("## External dependencies"));
    expect(section).not.toContain("###");
    expect(section).toContain("```mermaid");
  });

  test("a split component view titles each diagram, never with a bare dot", () => {
    const rendered = renderArtifacts(manyFiles(300, 12, 25));
    const map = rendered.get("packages/acme__wide/MAP.md") ?? "";
    expect(map).toContain("### packages/wide (overview)");
    const rootPkg = renderArtifacts(manyFilesInRootPackage(300, 12, 25));
    const rootMap = rootPkg.get("packages/solo/MAP.md") ?? "";
    expect(rootMap).toContain("### solo (overview)");
    expect(rootMap).not.toContain("### .");
  });

  test("the package dependency diagram is unheaded when it is the only one", () => {
    const map = artifacts.get("repo/MAP.md") ?? "";
    const section = map.slice(map.indexOf("## Package dependencies"), map.indexOf("## Packages"));
    expect(section).not.toContain("###");
    expect(section).toContain("```mermaid");
  });

  test("the package dependency diagram is headed once auto-split kicks in", () => {
    const rendered = renderArtifacts(manyPackages(60));
    const map = rendered.get("repo/MAP.md") ?? "";
    expect(map).toContain("### . (overview)");
    expect(map.split("```mermaid").length - 1).toBeGreaterThan(1);
  });

  test("a deeply nested module links back through every level", () => {
    const rendered = renderArtifacts(
      synthInput({
        packages: [
          { name: "root", path: "." },
          { name: "@deep/pkg", path: "packages/outer/inner" },
        ],
        files: [{ path: "packages/outer/inner/src/a/b/c.ts", pkg: "@deep/pkg", exports: ["c"] }],
      }),
    );
    const card = rendered.get("packages/deep__pkg/modules/src/a/b/c.ts.md") ?? "";
    expect(fieldLine(card, "Package")).toBe("**Package:** `@deep/pkg` ([map](../../../../MAP.md))");
    const map = rendered.get("packages/deep__pkg/MAP.md") ?? "";
    expect(map).toContain("[`src/a/b/c.ts`](modules/src/a/b/c.ts.md)");
    for (const [rel, text] of rendered) {
      for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), match[1] ?? ""));
        expect({ rel, resolved, known: rendered.has(resolved) }).toEqual({ rel, resolved, known: true });
      }
    }
  });
});

describe("stale banner", () => {
  test("renders a fresh summary without a banner", () => {
    const retry = artifacts.get("packages/tiny__core/modules/src/retry.ts.md") ?? "";
    expect(retry).toContain(
      "> Retries an async operation a fixed number of times before rethrowing the last error.",
    );
    expect(retry).not.toContain("summary may lag code");
  });

  test("renders a stale summary behind the banner with its date", () => {
    const bus = artifacts.get("packages/tiny__core/modules/src/bus.ts.md") ?? "";
    expect(bus).toContain("> Fan-out event bus used by the registry.");
    expect(bus).toContain("> summary may lag code, last refreshed 2026-08-15");
    expect(input.snapshot.manifest.files["packages/core/src/bus.ts"]?.staleSummary).toBe(true);
  });

  test("renders the placeholder when a file was never summarised", () => {
    const queue = artifacts.get("packages/tiny__core/modules/src/queue.ts.md") ?? "";
    expect(queue).toContain("> No summary yet; run `greplost refresh`.");
    expect(queue).not.toContain("summary may lag code");
  });

  test("only the banner line carries a date", () => {
    for (const [rel, text] of artifacts) {
      for (const line of text.split("\n")) {
        if (/\b20\d{2}-\d{2}-\d{2}\b/.test(line)) {
          expect({ rel, line }).toEqual({ rel, line: "> summary may lag code, last refreshed 2026-08-15" });
        }
      }
    }
  });
});

describe("no leaks", () => {
  test("no artifact contains an absolute path or a hostname", () => {
    const hostname = os.hostname();
    for (const [rel, text] of artifacts) {
      expect({ rel, hit: text.includes("/Users/") }).toEqual({ rel, hit: false });
      expect({ rel, hit: text.includes("/home/") }).toEqual({ rel, hit: false });
      expect({ rel, hit: text.includes(FIXTURE_ROOT) }).toEqual({ rel, hit: false });
      // A path token that starts at a slash is an absolute path; relative
      // links and `packages/<pkg>/...` prose never begin one.
      expect({ rel, hit: /(?:^|[\s("'`[])\/[A-Za-z]/m.test(text) }).toEqual({ rel, hit: false });
      if (hostname.length >= 4) {
        expect({ rel, hit: text.toLowerCase().includes(hostname.toLowerCase()) }).toEqual({ rel, hit: false });
      }
    }
  });

  test("no artifact carries a date outside the semantic banner", () => {
    for (const [rel, text] of artifacts) {
      const offenders = text
        .split("\n")
        .filter((line) => /\b20\d{2}-\d{2}-\d{2}\b/.test(line))
        .filter((line) => !line.startsWith("> summary may lag code, last refreshed "));
      expect({ rel, offenders }).toEqual({ rel, offenders: [] });
    }
  });

  test("no artifact carries a bare angle bracket outside code", () => {
    for (const [rel, text] of artifacts) {
      const prose = withoutCode(text);
      expect({ rel, hit: prose.includes("<") }).toEqual({ rel, hit: false });
    }
  });

  test("no artifact carries a clock time or an ISO timestamp", () => {
    for (const [rel, text] of artifacts) {
      expect({ rel, hit: /\d{2}:\d{2}:\d{2}/.test(text) }).toEqual({ rel, hit: false });
      expect({ rel, hit: text.includes("GMT") || text.includes("UTC") }).toEqual({ rel, hit: false });
    }
  });
});

describe("deterministic", () => {
  test("rendering the same input twice yields identical maps", () => {
    const first = renderArtifacts(input);
    const second = renderArtifacts(input);
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  test("a snapshot rebuilt from the same fixture renders identically", async () => {
    const summaries = goldenSummaries();
    const snapshot = await buildSnapshot({ root: FIXTURE_ROOT, summaries });
    const again = renderArtifacts({ snapshot, summaries });
    expect([...again.entries()]).toEqual([...artifacts.entries()]);
  });

  test("input ordering does not change the output", () => {
    const shuffled: Snapshot = {
      ...input.snapshot,
      packages: [...input.snapshot.packages].reverse(),
      files: [...input.snapshot.files].reverse(),
      imports: [...input.snapshot.imports].reverse(),
      calls: [...input.snapshot.calls].reverse(),
      symbols: [...input.snapshot.symbols].reverse(),
    };
    const again = renderArtifacts({ snapshot: shuffled, summaries: input.summaries });
    expect([...again.entries()].sort()).toEqual([...artifacts.entries()].sort());
  });

  test("rendering does not mutate the snapshot", () => {
    const before = JSON.stringify({
      packages: input.snapshot.packages,
      files: input.snapshot.files,
      imports: input.snapshot.imports,
      calls: input.snapshot.calls,
      symbols: input.snapshot.symbols,
      metrics: input.snapshot.metrics,
    });
    renderArtifacts(input);
    const after = JSON.stringify({
      packages: input.snapshot.packages,
      files: input.snapshot.files,
      imports: input.snapshot.imports,
      calls: input.snapshot.calls,
      symbols: input.snapshot.symbols,
      metrics: input.snapshot.metrics,
    });
    expect(after).toBe(before);
  });

  test("the per-document renderers agree with the full render", () => {
    expect(renderIndex(input)).toBe(artifacts.get("INDEX.md") ?? "");
    expect(renderRepoMap(input)).toBe(artifacts.get("repo/MAP.md") ?? "");
    expect(renderHotspots(input)).toBe(artifacts.get("repo/HOTSPOTS.md") ?? "");
    const core = input.snapshot.packages.find((p) => p.name === "@tiny/core");
    expect(core).toBeDefined();
    if (core) {
      expect(renderPackageMap(input, core)).toBe(artifacts.get("packages/tiny__core/MAP.md") ?? "");
      expect(renderApi(input, core)).toBe(artifacts.get("packages/tiny__core/API.md") ?? "");
    }
    expect(renderCard(input, "packages/core/src/bus.ts")).toBe(
      artifacts.get("packages/tiny__core/modules/src/bus.ts.md") ?? "",
    );
  });
});

describe("hotspots", () => {
  test("lists the bus/events import cycle", () => {
    const text = artifacts.get("repo/HOTSPOTS.md") ?? "";
    expect(text).toContain("## Import cycles");
    expect(text).toContain(
      "- packages/core/src/bus.ts → packages/core/src/events.ts → packages/core/src/bus.ts",
    );
    expect(text).toContain("## Package cycles");
    expect(text).toContain("None.");
  });

  test("ranks god nodes by fan-in with module links", () => {
    const text = artifacts.get("repo/HOTSPOTS.md") ?? "";
    const rows = tableRows(text, "## God nodes");
    expect(rows[0]).toBe(
      "| [`packages/core/src/index.ts`](../packages/tiny__core/modules/src/index.ts.md) | 3 | 4 | 4 |",
    );
    expect(rows[1]).toBe(
      "| [`packages/core/src/types.ts`](../packages/tiny__core/modules/src/types.ts.md) | 3 | 0 | 9 |",
    );
    expect(rows.length).toBe(input.snapshot.files.length);
  });

  test("ranks the largest blast radius first", () => {
    const text = artifacts.get("repo/HOTSPOTS.md") ?? "";
    const rows = tableRows(text, "## Largest blast radius");
    expect(rows[0]).toBe(
      "| [`packages/core/src/types.ts`](../packages/tiny__core/modules/src/types.ts.md) | 3 | 0 | 9 |",
    );
  });

  test("the INDEX repeats the top god nodes and the cycle count", () => {
    const text = artifacts.get("INDEX.md") ?? "";
    expect(text).toContain("- Most imported: `packages/core/src/index.ts` (fan-in 3)");
    expect(text).toContain("- Largest blast radius: `packages/core/src/types.ts` (9 files)");
    expect(text).toContain("- Import cycles: 1, see [repo/HOTSPOTS.md](repo/HOTSPOTS.md)");
  });

  test("reports package cycles when the package graph has one", () => {
    const rendered = renderArtifacts(
      synthInput({
        packages: [
          { name: "root", path: "." },
          { name: "a", path: "packages/a" },
          { name: "b", path: "packages/b" },
        ],
        files: [
          { path: "packages/a/src/a.ts", pkg: "a", exports: ["a"] },
          { path: "packages/b/src/b.ts", pkg: "b", exports: ["b"] },
        ],
        packageEdges: [
          { from: "a", to: "b", count: 1 },
          { from: "b", to: "a", count: 2 },
        ],
      }),
    );
    const text = rendered.get("repo/HOTSPOTS.md") ?? "";
    expect(text).toContain("- a → b → a");
  });

  test("says None. when there are no cycles at all", () => {
    const rendered = renderArtifacts(
      synthInput({
        packages: [{ name: "solo", path: "." }],
        files: [{ path: "src/a.ts", pkg: "solo", exports: ["a"] }],
      }),
    );
    const text = rendered.get("repo/HOTSPOTS.md") ?? "";
    const importSection = text.slice(text.indexOf("## Import cycles"));
    expect(importSection).toContain("None.");
  });
});
