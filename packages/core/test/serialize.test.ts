import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CallEdge,
  Declaration,
  ImportEdge,
  Manifest,
  Snapshot,
} from "../src/schema.ts";
import {
  ARTIFACT_PATHS,
  DEFAULT_CONFIG,
  SCHEMA_VERSION,
  compareDeclarations,
  compareEdges,
  symbolId,
} from "../src/schema.ts";
import { parseJsonl, readStructure, serializeSnapshot } from "../src/serialize/index.ts";

const ROOT = "/Users/someone/absolute/checkout/of/a/repo";
const temporaries: string[] = [];

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** Materialise a serialized snapshot on disk, the way the sync package will. */
function writeArtifacts(files: Map<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "greplost-serialize-"));
  temporaries.push(dir);
  for (const [relative, contents] of files) {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return dir;
}

function importEdge(from: string, to: string, symbols: string[], kind: ImportEdge["kind"] = "import"): ImportEdge {
  return { from, to, kind, symbols, confidence: "high", specifier: `./${to}`, importKind: "static" };
}

function callEdge(from: string, to: string, confidence: CallEdge["confidence"] = "high"): CallEdge {
  return { from, to, kind: "call", confidence };
}

function declaration(file: string, name: string, span: [number, number]): Declaration {
  return {
    id: symbolId(file, name),
    file,
    name,
    kind: "function",
    signature: `export function ${name}(): void`,
    exported: true,
    span,
  };
}

const MANIFEST: Manifest = {
  version: SCHEMA_VERSION,
  packages: {
    web: { path: "packages/web", deps: ["core"], rdeps: [], loc: 40, files: 1 },
    core: { path: "packages/core", deps: [], rdeps: ["web"], loc: 60, files: 2 },
  },
  files: {
    "packages/web/src/app.ts": {
      sha256: "b".repeat(64),
      pkg: "web",
      lang: "ts",
      loc: 40,
      exports: ["start"],
      fanIn: 0,
      fanOut: 1,
      blast: 0,
      staleSummary: false,
    },
    "packages/core/src/util.ts": {
      sha256: "a".repeat(64),
      pkg: "core",
      lang: "ts",
      loc: 60,
      exports: ["helper", "other"],
      fanIn: 1,
      fanOut: 0,
      blast: 1,
      summaryHash: "a".repeat(64),
      staleSummary: false,
    },
  },
};

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const base: Snapshot = {
    root: ROOT,
    config: DEFAULT_CONFIG,
    packages: [
      { name: "root", path: ".", source: "root" },
      { name: "core", path: "packages/core", source: "package.json" },
      { name: "web", path: "packages/web", source: "package.json" },
    ],
    files: [],
    manifest: MANIFEST,
    imports: [
      importEdge("packages/web/src/app.ts", "packages/core/src/util.ts", ["helper"]),
      importEdge("packages/web/src/app.ts", "ext:left-pad", ["leftPad"]),
      importEdge("packages/web/src/app.ts", "packages/core/src/util.ts", ["other"], "reexport"),
    ],
    calls: [
      callEdge("packages/web/src/app.ts#start", "packages/core/src/util.ts#helper"),
      callEdge("packages/web/src/app.ts", "packages/web/src/app.ts#start", "med"),
    ],
    symbols: [
      declaration("packages/web/src/app.ts", "start", [10, 20]),
      declaration("packages/core/src/util.ts", "other", [30, 40]),
      declaration("packages/core/src/util.ts", "helper", [3, 8]),
    ],
    metrics: { cycles: [], packageEdges: [{ from: "web", to: "core", count: 2 }] },
  };
  return { ...base, ...overrides };
}

describe("round-trip", () => {
  test("serializeSnapshot writes exactly the four structure artifacts", () => {
    expect([...serializeSnapshot(snapshot()).keys()]).toEqual([
      ARTIFACT_PATHS.calls,
      ARTIFACT_PATHS.imports,
      ARTIFACT_PATHS.symbols,
      ARTIFACT_PATHS.manifest,
    ]);
  });

  test("readStructure returns manifest, edges and symbols unchanged", () => {
    const source = snapshot();
    const dir = writeArtifacts(serializeSnapshot(source));
    const structure = readStructure(dir);
    expect(structure).not.toBeNull();
    expect(structure?.manifest).toEqual(MANIFEST);
    expect(structure?.imports).toEqual([...source.imports].sort(compareEdges));
    expect(structure?.calls).toEqual([...source.calls].sort(compareEdges));
    expect(structure?.symbols).toEqual([...source.symbols].sort(compareDeclarations));
  });

  test("re-serializing what was read reproduces the same bytes", () => {
    const first = serializeSnapshot(snapshot());
    const dir = writeArtifacts(first);
    const structure = readStructure(dir);
    expect(structure).not.toBeNull();
    const second = serializeSnapshot(snapshot({ ...structure! }));
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  test("empty collections serialize to empty files and read back as empty arrays", () => {
    const empty = snapshot({
      imports: [],
      calls: [],
      symbols: [],
      manifest: { version: SCHEMA_VERSION, packages: {}, files: {} },
    });
    const artifacts = serializeSnapshot(empty);
    expect(artifacts.get(ARTIFACT_PATHS.imports)).toBe("");
    expect(artifacts.get(ARTIFACT_PATHS.calls)).toBe("");
    expect(artifacts.get(ARTIFACT_PATHS.symbols)).toBe("");
    expect(artifacts.get(ARTIFACT_PATHS.manifest)).toBe(
      `{\n  "files": {},\n  "packages": {},\n  "version": "${SCHEMA_VERSION}"\n}\n`,
    );

    const structure = readStructure(writeArtifacts(artifacts));
    expect(structure).toEqual({
      manifest: { version: SCHEMA_VERSION, packages: {}, files: {} },
      imports: [],
      calls: [],
      symbols: [],
      references: [],
    });
  });

  test("readStructure is null without a manifest and tolerates missing jsonl files", () => {
    const dir = writeArtifacts(new Map());
    expect(readStructure(dir)).toBeNull();
    expect(readStructure(path.join(dir, "not-there"))).toBeNull();

    const onlyManifest = new Map([[ARTIFACT_PATHS.manifest, '{"version":"1","packages":{},"files":{}}\n']]);
    const structure = readStructure(writeArtifacts(onlyManifest));
    expect(structure?.imports).toEqual([]);
    expect(structure?.symbols).toEqual([]);
  });

  test("readStructure reports a broken manifest as a greplost error", () => {
    const dir = writeArtifacts(new Map([[ARTIFACT_PATHS.manifest, "{not json"]]));
    expect(() => readStructure(dir)).toThrow(/^greplost: /);
    const wrongShape = writeArtifacts(new Map([[ARTIFACT_PATHS.manifest, '{"hello":"world"}']]));
    expect(() => readStructure(wrongShape)).toThrow(/^greplost: /);
    const notAnObject = writeArtifacts(new Map([[ARTIFACT_PATHS.manifest, "[]"]]));
    expect(() => readStructure(notAnObject)).toThrow(/^greplost: /);
  });

  test("parseJsonl skips blank lines and rejects broken ones", () => {
    expect(parseJsonl<{ a: number }>('{"a":1}\n\n  \n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseJsonl("")).toEqual([]);
    expect(() => parseJsonl("{oops}\n")).toThrow(/^greplost: /);
  });

  test("serializeSnapshot does not mutate the snapshot it was given", () => {
    const source = snapshot();
    const before = source.imports.map((e) => e.to);
    serializeSnapshot(source);
    expect(source.imports.map((e) => e.to)).toEqual(before);
  });
});

describe("ordering", () => {
  const artifacts = serializeSnapshot(snapshot());
  const manifestText = artifacts.get(ARTIFACT_PATHS.manifest) ?? "";
  const importsText = artifacts.get(ARTIFACT_PATHS.imports) ?? "";
  const callsText = artifacts.get(ARTIFACT_PATHS.calls) ?? "";
  const symbolsText = artifacts.get(ARTIFACT_PATHS.symbols) ?? "";

  test("manifest.json is 2-space indented with recursively sorted keys", () => {
    expect(manifestText.startsWith("{\n  \"files\": {")).toBe(true);
    const parsed = JSON.parse(manifestText) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["files", "packages", "version"]);
    const files = parsed["files"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(files)).toEqual(["packages/core/src/util.ts", "packages/web/src/app.ts"]);
    expect(Object.keys(files["packages/core/src/util.ts"] ?? {})).toEqual([
      "blast",
      "exports",
      "fanIn",
      "fanOut",
      "lang",
      "loc",
      "pkg",
      "sha256",
      "staleSummary",
      "summaryHash",
    ]);
    expect(Object.keys((parsed["packages"] as Record<string, unknown>) ?? {})).toEqual(["core", "web"]);
  });

  test("jsonl lines follow the contract comparators", () => {
    const imports = parseJsonl<ImportEdge>(importsText);
    expect(imports).toEqual([...imports].sort(compareEdges));
    expect(imports.map((e) => `${e.to}|${(e.symbols ?? []).join(",")}`)).toEqual([
      "ext:left-pad|leftPad",
      "packages/core/src/util.ts|helper",
      "packages/core/src/util.ts|other",
    ]);
    const calls = parseJsonl<CallEdge>(callsText);
    expect(calls.map((e) => e.from)).toEqual([
      "packages/web/src/app.ts",
      "packages/web/src/app.ts#start",
    ]);
    const symbols = parseJsonl<Declaration>(symbolsText);
    expect(symbols).toEqual([...symbols].sort(compareDeclarations));
    expect(symbols.map((d) => d.id)).toEqual([
      "packages/core/src/util.ts#helper",
      "packages/core/src/util.ts#other",
      "packages/web/src/app.ts#start",
    ]);
  });

  test("jsonl lines are compact, key-sorted and newline terminated", () => {
    for (const text of [importsText, callsText, symbolsText]) {
      expect(text.endsWith("\n")).toBe(true);
      expect(text.endsWith("\n\n")).toBe(false);
      for (const line of text.split("\n").slice(0, -1)) {
        expect(line.startsWith("{")).toBe(true);
        expect(line.endsWith("}")).toBe(true);
        expect(JSON.stringify(JSON.parse(line))).toBe(line);
        const keys = Object.keys(JSON.parse(line) as Record<string, unknown>);
        expect(keys).toEqual([...keys].sort());
      }
    }
    expect(callsText.split("\n").filter(Boolean)[0]).toBe(
      '{"confidence":"med","from":"packages/web/src/app.ts","kind":"call","to":"packages/web/src/app.ts#start"}',
    );
  });

  test("no timestamps, absolute paths or machine values anywhere in the output", () => {
    for (const text of artifacts.values()) {
      expect(text).not.toContain(ROOT);
      expect(text).not.toMatch(/"\/[^"]*"/);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(text).not.toMatch(/\d{2}:\d{2}:\d{2}/);
      expect(text).not.toMatch(/\b1[6-9]\d{11}\b/);
      expect(text.toLowerCase()).not.toContain("users/");
    }
  });

  test("output is byte-identical when the snapshot arrives in a different order", () => {
    const shuffled = snapshot();
    shuffled.imports.reverse();
    shuffled.calls.reverse();
    shuffled.symbols.reverse();
    const again = serializeSnapshot(shuffled);
    for (const [key, value] of artifacts) expect(again.get(key)).toBe(value);
  });
});
