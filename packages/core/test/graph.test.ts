import { describe, expect, test } from "bun:test";
import path from "node:path";
import type {
  CallSite,
  DeclKind,
  Declaration,
  ExportRecord,
  FileRecord,
  ImportEdge,
  ImportKind,
  ImportRecord,
  Lang,
  PackageInfo,
} from "../src/schema.ts";
import { stableStringify, symbolId } from "../src/schema.ts";
import { buildExportIndex, exportNames, linkCalls, linkImports } from "../src/graph/link.ts";
import type { ResolvedTarget, Resolver } from "../src/graph/link.ts";
import { stronglyConnected } from "../src/graph/tarjan.ts";
import { blastRadius, impactOf } from "../src/graph/blast.ts";
import { computeMetrics } from "../src/graph/metrics.ts";

// ---------------------------------------------------------------------------
// Hand-built FileRecord helpers. The extractor (leaf 1.1.1) is built in
// parallel, so every record here is written by hand against schema.ts.
// ---------------------------------------------------------------------------

function decl(
  file: string,
  name: string,
  kind: DeclKind,
  opts: { exported?: boolean; parent?: string; span?: [number, number] } = {},
): Declaration {
  const base: Declaration = {
    id: symbolId(file, name),
    file,
    name,
    kind,
    signature: `${kind} ${name}`,
    exported: opts.exported ?? true,
    span: opts.span ?? [1, 2],
  };
  return opts.parent === undefined ? base : { ...base, parent: opts.parent };
}

/** A class declaration plus one method declaration per member name. */
function classDecls(file: string, name: string, members: string[], exported = true): Declaration[] {
  return [
    decl(file, name, "class", { exported }),
    ...members.map((m) => decl(file, `${name}.${m}`, "method", { exported: false, parent: name })),
  ];
}

function imp(
  specifier: string,
  names: Array<string | [string, string]>,
  opts: { kind?: ImportKind; reexport?: boolean; line?: number } = {},
): ImportRecord {
  return {
    specifier,
    kind: opts.kind ?? "static",
    symbols: names.map((n) => (typeof n === "string" ? { name: n, local: n } : { name: n[0], local: n[1] })),
    reexport: opts.reexport ?? false,
    line: opts.line ?? 1,
  };
}

function exp(
  name: string,
  kind: ExportRecord["kind"] = "named",
  opts: { local?: string; from?: string } = {},
): ExportRecord {
  const base: ExportRecord = { name, kind };
  const withLocal = opts.local === undefined ? base : { ...base, local: opts.local };
  return opts.from === undefined ? withLocal : { ...withLocal, from: opts.from };
}

function call(caller: string, callee: string, line = 1): CallSite {
  return { caller, callee, line };
}

function file(
  p: string,
  parts: Partial<Pick<FileRecord, "decls" | "imports" | "exports" | "calls" | "loc" | "lang" | "sha256">> = {},
): FileRecord {
  return {
    path: p,
    lang: parts.lang ?? ("ts" as Lang),
    sha256: parts.sha256 ?? "0".repeat(64),
    loc: parts.loc ?? 10,
    decls: parts.decls ?? [],
    imports: parts.imports ?? [],
    exports: parts.exports ?? [],
    calls: parts.calls ?? [],
  };
}

/**
 * Stand-in for the resolver from leaf 1.1.2 (structurally identical): relative
 * specifiers probe the known file set, aliases map bare specifiers, anything
 * else is external.
 */
function resolver(files: string[], aliases: Record<string, ResolvedTarget> = {}): Resolver {
  const known = new Set(files);
  return {
    resolve(fromFile: string, specifier: string): ResolvedTarget {
      const alias = aliases[specifier];
      if (alias) return alias;
      if (specifier.startsWith(".")) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
        for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
          if (known.has(candidate)) return { type: "file", path: candidate };
        }
        return { type: "unresolved" };
      }
      const segments = specifier.split("/");
      const pkg = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? specifier);
      return { type: "external", pkg };
    },
  };
}

// ---------------------------------------------------------------------------
// fixtures/tiny-ts mirrored by hand (the extractor leaf is built in parallel).
// ---------------------------------------------------------------------------

const CORE = "packages/core/src";
const ADAPTERS = "packages/adapters/src";
const WORKER = "apps/worker/src";

function tinyTsFiles(): FileRecord[] {
  return [
    file(`${WORKER}/config.ts`, {
      loc: 12,
      decls: [
        decl(`${WORKER}/config.ts`, "WorkerConfig", "interface"),
        decl(`${WORKER}/config.ts`, "loadConfig", "function", { span: [6, 11] }),
      ],
      exports: [exp("WorkerConfig"), exp("loadConfig")],
    }),
    file(`${WORKER}/main.ts`, {
      loc: 14,
      imports: [
        imp("@tiny/core", ["createRegistry"]),
        imp("@tiny/adapters", ["createSqsAdapter", "MemoryAdapter"], { line: 2 }),
        imp("./config", ["loadConfig"], { line: 3 }),
      ],
      decls: [decl(`${WORKER}/main.ts`, "main", "function", { span: [5, 12] })],
      exports: [exp("main")],
      calls: [
        call("main", "loadConfig", 6),
        call("main", "createRegistry", 7),
        call("main", "createSqsAdapter", 8),
        call("main", "registry.register", 8),
        call("main", "new MemoryAdapter", 9),
        call("main", "registry.publishAll", 10),
        call("main", "console.log", 11),
        call("", "main", 14),
      ],
    }),
    file(`${ADAPTERS}/index.ts`, {
      loc: 3,
      imports: [
        imp("./sqs", ["SqsAdapter", "createSqsAdapter"], { reexport: true }),
        imp("./sqs", ["SqsConfig"], { reexport: true, kind: "type", line: 2 }),
        imp("./memory", ["MemoryAdapter"], { reexport: true, line: 3 }),
      ],
      exports: [
        exp("SqsAdapter", "named", { local: "SqsAdapter", from: "./sqs" }),
        exp("createSqsAdapter", "named", { local: "createSqsAdapter", from: "./sqs" }),
        exp("SqsConfig", "named", { local: "SqsConfig", from: "./sqs" }),
        exp("MemoryAdapter", "named", { local: "MemoryAdapter", from: "./memory" }),
      ],
    }),
    file(`${ADAPTERS}/memory.ts`, {
      loc: 17,
      imports: [
        imp("@tiny/core", ["Queue", "Ack", "Msg"], { kind: "type" }),
        imp("@tiny/core", ["Priority"], { kind: "dynamic", line: 7 }),
      ],
      decls: classDecls(`${ADAPTERS}/memory.ts`, "MemoryAdapter", ["publish", "poll"]),
      exports: [exp("MemoryAdapter")],
      calls: [call("MemoryAdapter.publish", "String", 8)],
    }),
    file(`${ADAPTERS}/sqs.ts`, {
      loc: 33,
      imports: [
        imp("@tiny/core", ["retry", "Priority"]),
        imp("@tiny/core", ["Queue", "Ack", "Msg"], { kind: "type", line: 2 }),
        imp("@aws-sdk/client-sqs", ["SQSClient", "SendMessageCommand"], { line: 3 }),
      ],
      decls: [
        decl(`${ADAPTERS}/sqs.ts`, "SqsConfig", "interface", { span: [5, 8] }),
        ...classDecls(`${ADAPTERS}/sqs.ts`, "SqsAdapter", ["constructor", "publish", "poll"]),
        decl(`${ADAPTERS}/sqs.ts`, "createSqsAdapter", "function", { span: [29, 31] }),
      ],
      exports: [exp("SqsConfig"), exp("SqsAdapter"), exp("createSqsAdapter")],
      calls: [
        call("SqsAdapter.constructor", "new SQSClient", 14),
        call("SqsAdapter.publish", "new SendMessageCommand", 18),
        call("SqsAdapter.publish", "retry", 19),
        call("createSqsAdapter", "new SqsAdapter", 30),
      ],
    }),
    file(`${CORE}/bus.ts`, {
      loc: 15,
      imports: [imp("./events", ["formatEvent"]), imp("./types", ["Handler"], { kind: "type", line: 2 })],
      decls: classDecls(`${CORE}/bus.ts`, "Bus", ["on", "emit"]),
      exports: [exp("Bus")],
      calls: [call("Bus.emit", "formatEvent", 12), call("Bus.emit", "h", 13)],
    }),
    file(`${CORE}/events.ts`, {
      loc: 9,
      imports: [imp("./bus", ["Bus"])],
      decls: [
        decl(`${CORE}/events.ts`, "formatEvent", "function", { span: [3, 5] }),
        decl(`${CORE}/events.ts`, "createBus", "function", { span: [7, 9] }),
      ],
      exports: [exp("formatEvent"), exp("createBus")],
      calls: [call("createBus", "new Bus", 8)],
    }),
    file(`${CORE}/index.ts`, {
      loc: 4,
      imports: [
        imp("./registry", [["*", "*"]], { reexport: true }),
        imp("./retry", ["retry", "DEFAULT_ATTEMPTS"], { reexport: true, line: 2 }),
        imp("./queue", ["Queue", "Ack", "Msg"], { reexport: true, kind: "type", line: 3 }),
        imp("./types", ["Priority"], { reexport: true, line: 4 }),
      ],
      exports: [
        exp("*", "star", { from: "./registry" }),
        exp("retry", "named", { local: "retry", from: "./retry" }),
        exp("DEFAULT_ATTEMPTS", "named", { local: "DEFAULT_ATTEMPTS", from: "./retry" }),
        exp("Queue", "named", { local: "Queue", from: "./queue" }),
        exp("Ack", "named", { local: "Ack", from: "./queue" }),
        exp("Msg", "named", { local: "Msg", from: "./queue" }),
        exp("Priority", "named", { local: "Priority", from: "./types" }),
      ],
    }),
    file(`${CORE}/queue.ts`, {
      loc: 13,
      imports: [imp("./types", ["Priority"], { kind: "type" })],
      decls: [
        decl(`${CORE}/queue.ts`, "Msg", "interface", { span: [3, 7] }),
        decl(`${CORE}/queue.ts`, "Ack", "type", { span: [9, 9] }),
        decl(`${CORE}/queue.ts`, "Queue", "interface", { span: [11, 14] }),
      ],
      exports: [exp("Msg"), exp("Ack"), exp("Queue")],
    }),
    file(`${CORE}/registry.ts`, {
      loc: 28,
      imports: [
        imp("./queue", ["Queue"], { kind: "type" }),
        imp("./retry", ["retry"], { line: 2 }),
        imp("./bus", ["Bus"], { line: 3 }),
      ],
      decls: [
        ...classDecls(`${CORE}/registry.ts`, "Registry", ["register", "publishAll", "get"]),
        decl(`${CORE}/registry.ts`, "createRegistry", "function", { span: [26, 28] }),
      ],
      exports: [exp("Registry"), exp("createRegistry")],
      calls: [call("Registry.publishAll", "retry", 18), call("createRegistry", "new Registry", 27)],
    }),
    file(`${CORE}/retry.ts`, {
      loc: 18,
      decls: [
        decl(`${CORE}/retry.ts`, "DEFAULT_ATTEMPTS", "const"),
        decl(`${CORE}/retry.ts`, "RetryOptions", "interface", { span: [3, 5] }),
        decl(`${CORE}/retry.ts`, "retry", "function", { span: [7, 18] }),
      ],
      exports: [exp("DEFAULT_ATTEMPTS"), exp("RetryOptions"), exp("retry")],
      calls: [call("retry", "fn", 12)],
    }),
    file(`${CORE}/types.ts`, {
      loc: 9,
      decls: [
        decl(`${CORE}/types.ts`, "Priority", "enum"),
        decl(`${CORE}/types.ts`, "Handler", "type", { span: [7, 7] }),
        decl(`${CORE}/types.ts`, "VERSION", "const", { span: [9, 9] }),
      ],
      exports: [exp("Priority"), exp("Handler"), exp("VERSION")],
    }),
  ];
}

const TINY_PACKAGES: PackageInfo[] = [
  { name: "tiny-ts", path: ".", source: "root" },
  { name: "worker", path: "apps/worker", source: "package.json" },
  { name: "@tiny/adapters", path: "packages/adapters", source: "package.json" },
  { name: "@tiny/core", path: "packages/core", source: "package.json" },
];

function tinyTs(files: FileRecord[] = tinyTsFiles()) {
  const resolve = resolver(
    files.map((f) => f.path),
    {
      "@tiny/core": { type: "file", path: `${CORE}/index.ts` },
      "@tiny/adapters": { type: "file", path: `${ADAPTERS}/index.ts` },
      "@aws-sdk/client-sqs": { type: "external", pkg: "@aws-sdk/client-sqs" },
    },
  );
  const imports = linkImports(files, resolve);
  const index = buildExportIndex(files, imports);
  const calls = linkCalls(files, imports, index);
  return { files, imports, index, calls, packages: TINY_PACKAGES };
}

/** The file-to-file edge list the graph metrics work over. */
function fileEdges(imports: ImportEdge[]): Array<[string, string]> {
  return imports.filter((e) => !e.to.includes(":")).map((e) => [e.from, e.to] as [string, string]);
}

function edgeKey(e: { from: string; to: string; confidence: string }): string {
  return `${e.from} -> ${e.to} (${e.confidence})`;
}

// ---------------------------------------------------------------------------

describe("linkImports", () => {
  test("emits file, external and unresolved targets", () => {
    const a = file("src/a.ts", {
      imports: [
        imp("./b", ["b"]),
        imp("lodash", ["merge"], { line: 2 }),
        imp("./nope", ["x"], { line: 3 }),
        imp("@scope/pkg/sub", ["y"], { line: 4 }),
      ],
    });
    const edges = linkImports([a, file("src/b.ts")], resolver(["src/a.ts", "src/b.ts"]));
    expect(edges.map((e) => e.to)).toEqual(["ext:@scope/pkg", "ext:lodash", "src/b.ts", "unresolved:./nope"]);
    expect(edges.every((e) => e.from === "src/a.ts" && e.kind === "import" && e.confidence === "high")).toBe(true);
  });

  test("copies specifier and importKind, and marks re-exports", () => {
    const a = file("src/a.ts", {
      imports: [
        imp("./b", ["b"], { reexport: true }),
        imp("./b", ["T"], { kind: "type", line: 2 }),
        imp("./b", [], { kind: "side-effect", line: 3 }),
        imp("./b", [["*", "m"]], { kind: "dynamic", line: 4 }),
      ],
    });
    const edges = linkImports([a, file("src/b.ts")], resolver(["src/a.ts", "src/b.ts"]));
    expect(edges.map((e) => [e.kind, e.importKind, e.specifier, e.symbols])).toEqual([
      ["import", "side-effect", "./b", []],
      ["import", "dynamic", "./b", ["*"]],
      ["import", "type", "./b", ["T"]],
      ["reexport", "static", "./b", ["b"]],
    ]);
  });

  test("sorts symbol names, drops duplicate names, and dedupes identical edges", () => {
    const a = file("src/a.ts", {
      imports: [
        imp("./b", ["z", "a", "a"]),
        imp("./b", ["a", "z"], { line: 2 }),
        imp("./b", ["a", "z"], { kind: "type", line: 3 }),
      ],
    });
    const edges = linkImports([a, file("src/b.ts")], resolver(["src/a.ts", "src/b.ts"]));
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.importKind)).toEqual(["static", "type"]);
    expect(edges[0]?.symbols).toEqual(["a", "z"]);
    expect(edges[1]?.symbols).toEqual(["a", "z"]);
  });

  test("importKind is part of the dedupe key: a static and a dynamic import stay two edges", () => {
    const a = file("src/a.ts", {
      imports: [
        imp("./b", ["P"]),
        imp("./b", ["P"], { kind: "dynamic", line: 2 }),
        imp("./b", ["P"], { kind: "dynamic", line: 3 }),
      ],
    });
    const edges = linkImports([a, file("src/b.ts")], resolver(["src/a.ts", "src/b.ts"]));
    expect(edges.map((e) => e.importKind)).toEqual(["dynamic", "static"]);
    expect(edges.every((e) => e.to === "src/b.ts")).toBe(true);
  });

  test("a tie on the dedupe key keeps the smallest specifier", () => {
    const a = file("src/a.ts", { imports: [imp("./b.ts", ["x"]), imp("./b", ["x"], { line: 2 })] });
    const edges = linkImports([a, file("src/b.ts")], resolver(["src/a.ts", "src/b.ts"]));
    expect(edges).toHaveLength(1);
    expect(edges[0]?.specifier).toBe("./b");
  });

  test("sorts edges with compareEdges across files", () => {
    const files = [
      file("src/z.ts", { imports: [imp("./a", ["x"])] }),
      file("src/a.ts", { imports: [imp("./z", ["b"]), imp("./z", ["a"], { line: 2 })] }),
    ];
    const edges = linkImports(files, resolver(["src/a.ts", "src/z.ts"]));
    expect(edges.map((e) => `${e.from}|${e.to}|${(e.symbols ?? []).join(",")}`)).toEqual([
      "src/a.ts|src/z.ts|a",
      "src/a.ts|src/z.ts|b",
      "src/z.ts|src/a.ts|x",
    ]);
  });

  test("keeps a self-import as an edge without inventing a target", () => {
    const a = file("src/a.ts", { imports: [imp("./a", ["x"])] });
    const edges = linkImports([a], resolver(["src/a.ts"]));
    expect(edges).toEqual([
      {
        from: "src/a.ts",
        to: "src/a.ts",
        kind: "import",
        symbols: ["x"],
        confidence: "high",
        specifier: "./a",
        importKind: "static",
      },
    ]);
  });

  test("linking does not depend on the order the files arrive in", () => {
    const forward = tinyTs();
    const backward = tinyTs([...tinyTsFiles()].reverse());
    expect(backward.imports).toEqual(forward.imports);
    expect(backward.calls).toEqual(forward.calls);
    for (const path of tinyTsFiles().map((f) => f.path)) {
      expect(exportNames(backward.index, path)).toEqual(exportNames(forward.index, path));
    }
  });

  test("tiny-ts: 22 edges, one external, none unresolved", () => {
    const { imports } = tinyTs();
    expect(imports).toHaveLength(22);
    expect(imports.filter((e) => e.to.startsWith("ext:")).map((e) => e.to)).toEqual(["ext:@aws-sdk/client-sqs"]);
    expect(imports.filter((e) => e.to.startsWith("unresolved:"))).toHaveLength(0);
    expect(imports.filter((e) => e.kind === "reexport")).toHaveLength(7);
    expect(
      imports.find((e) => e.from === `${ADAPTERS}/memory.ts` && e.importKind === "dynamic"),
    ).toEqual({
      from: `${ADAPTERS}/memory.ts`,
      to: `${CORE}/index.ts`,
      kind: "import",
      symbols: ["Priority"],
      confidence: "high",
      specifier: "@tiny/core",
      importKind: "dynamic",
    });
  });
});

describe("export index", () => {
  test("hops 0 for exported top-level declarations, methods and private decls excluded", () => {
    const a = file("src/a.ts", {
      decls: [
        decl("src/a.ts", "pub", "function"),
        decl("src/a.ts", "priv", "function", { exported: false }),
        ...classDecls("src/a.ts", "Klass", ["m"]),
      ],
      exports: [exp("pub"), exp("Klass")],
    });
    const index = buildExportIndex([a], []);
    expect(exportNames(index, "src/a.ts")).toEqual(["Klass", "pub"]);
    expect(index.get("src/a.ts")?.get("pub")).toEqual({ file: "src/a.ts", symbol: "pub", hops: 0 });
    expect(index.get("src/a.ts")?.get("Klass.m")).toBeUndefined();
  });

  test("named re-export from another file is one hop", () => {
    const b = file("src/b.ts", { decls: [decl("src/b.ts", "impl", "function")], exports: [exp("impl")] });
    const a = file("src/a.ts", {
      imports: [imp("./b", [["impl", "alias"]], { reexport: true })],
      exports: [exp("alias", "named", { local: "impl", from: "./b" })],
    });
    const imports = linkImports([a, b], resolver(["src/a.ts", "src/b.ts"]));
    const index = buildExportIndex([a, b], imports);
    expect(index.get("src/a.ts")?.get("alias")).toEqual({ file: "src/b.ts", symbol: "impl", hops: 1 });
  });

  test("star re-export copies hops 0 names except default, pinned at one hop", () => {
    const c = file("src/c.ts", { decls: [decl("src/c.ts", "deep", "function")], exports: [exp("deep")] });
    const b = file("src/b.ts", {
      imports: [imp("./c", [["*", "*"]], { reexport: true })],
      decls: [decl("src/b.ts", "mid", "function"), decl("src/b.ts", "hidden", "function", { exported: false })],
      exports: [exp("mid"), exp("*", "star", { from: "./c" }), exp("default", "default", { local: "mid" })],
    });
    const a = file("src/a.ts", {
      imports: [imp("./b", [["*", "*"]], { reexport: true })],
      exports: [exp("*", "star", { from: "./b" })],
    });
    const files = [a, b, c];
    const index = buildExportIndex(files, linkImports(files, resolver(files.map((f) => f.path))));
    expect(exportNames(index, "src/b.ts")).toEqual(["deep", "default", "mid"]);
    expect(index.get("src/b.ts")?.get("deep")).toEqual({ file: "src/c.ts", symbol: "deep", hops: 1 });
    // The name set is transitive, "default" never travels through a star, and
    // only the first hop onto a declaration keeps a usable target.
    expect(exportNames(index, "src/a.ts")).toEqual(["deep", "mid"]);
    expect(index.get("src/a.ts")?.get("mid")).toEqual({ file: "src/b.ts", symbol: "mid", hops: 1 });
    expect(index.get("src/a.ts")?.get("deep")).toEqual({
      file: "src/b.ts",
      symbol: "deep",
      hops: 1,
      unpinned: true,
    });
  });

  test("a three-level barrel chain exports the leaf's names at the top", () => {
    const leaf = file("src/leaf.ts", {
      decls: [decl("src/leaf.ts", "leafFn", "function"), decl("src/leaf.ts", "LeafType", "type")],
      exports: [exp("leafFn"), exp("LeafType")],
    });
    const mid = file("src/mid.ts", {
      imports: [imp("./leaf", [["*", "*"]], { reexport: true })],
      decls: [decl("src/mid.ts", "midFn", "function")],
      exports: [exp("midFn"), exp("*", "star", { from: "./leaf" })],
    });
    const top = file("src/top.ts", {
      imports: [imp("./mid", [["*", "*"]], { reexport: true })],
      exports: [exp("*", "star", { from: "./mid" })],
    });
    const files = [top, mid, leaf];
    const index = buildExportIndex(files, linkImports(files, resolver(files.map((f) => f.path))));
    expect(exportNames(index, "src/top.ts")).toEqual(["LeafType", "leafFn", "midFn"]);
    expect(index.get("src/top.ts")?.get("midFn")).toEqual({ file: "src/mid.ts", symbol: "midFn", hops: 1 });
    expect(index.get("src/top.ts")?.get("leafFn")?.unpinned).toBe(true);

    // The star closure must not depend on the order the files arrive in.
    const reversed = [...files].reverse();
    const other = buildExportIndex(reversed, linkImports(reversed, resolver(reversed.map((f) => f.path))));
    for (const path of files.map((f) => f.path)) {
      expect(exportNames(other, path)).toEqual(exportNames(index, path));
      expect([...(other.get(path) ?? [])]).toEqual([...(index.get(path) ?? [])]);
    }
  });

  test("a star cycle terminates and still reports both sides' names", () => {
    const a = file("src/a.ts", {
      imports: [imp("./b", [["*", "*"]], { reexport: true })],
      decls: [decl("src/a.ts", "fromA", "function")],
      exports: [exp("fromA"), exp("*", "star", { from: "./b" })],
    });
    const b = file("src/b.ts", {
      imports: [imp("./a", [["*", "*"]], { reexport: true })],
      decls: [decl("src/b.ts", "fromB", "function")],
      exports: [exp("fromB"), exp("*", "star", { from: "./a" })],
    });
    const files = [a, b];
    const index = buildExportIndex(files, linkImports(files, resolver(files.map((f) => f.path))));
    expect(exportNames(index, "src/a.ts")).toEqual(["fromA", "fromB"]);
    expect(exportNames(index, "src/b.ts")).toEqual(["fromA", "fromB"]);
    expect(index.get("src/a.ts")?.get("fromB")).toEqual({ file: "src/b.ts", symbol: "fromB", hops: 1 });
  });

  test("a self star and an unresolved star contribute nothing", () => {
    const a = file("src/a.ts", {
      imports: [imp("./a", [["*", "*"]], { reexport: true }), imp("./gone", [["*", "*"]], { reexport: true, line: 2 })],
      decls: [decl("src/a.ts", "own", "function")],
      exports: [exp("own"), exp("*", "star", { from: "./a" }), exp("*", "star", { from: "./gone" })],
    });
    const index = buildExportIndex([a], linkImports([a], resolver(["src/a.ts"])));
    expect(exportNames(index, "src/a.ts")).toEqual(["own"]);
  });

  test("names that cannot be pinned to a declaration are marked unpinned", () => {
    const a = file("src/a.ts", {
      imports: [imp("lodash", [["merge", "merge"]], { reexport: true })],
      decls: [decl("src/a.ts", "merge", "function", { exported: false })],
      exports: [exp("merge", "named", { local: "merge", from: "lodash" })],
    });
    const index = buildExportIndex([a], linkImports([a], resolver(["src/a.ts"])));
    expect(index.get("src/a.ts")?.get("merge")).toEqual({
      file: "src/a.ts",
      symbol: "merge",
      hops: 0,
      unpinned: true,
    });
  });

  test("default export maps to the local declaration name when known", () => {
    const named = file("src/named.ts", {
      decls: [decl("src/named.ts", "widget", "function")],
      exports: [exp("widget"), exp("default", "default", { local: "widget" })],
    });
    const anon = file("src/anon.ts", {
      decls: [decl("src/anon.ts", "default", "function")],
      exports: [exp("default", "default")],
    });
    const index = buildExportIndex([anon, named], []);
    expect(index.get("src/named.ts")?.get("default")).toEqual({ file: "src/named.ts", symbol: "widget", hops: 0 });
    expect(index.get("src/anon.ts")?.get("default")).toEqual({ file: "src/anon.ts", symbol: "default", hops: 0 });
  });

  test("exportNames includes renamed locals and re-exported imported bindings, sorted", () => {
    const b = file("src/b.ts", { decls: [decl("src/b.ts", "impl", "function")], exports: [exp("impl")] });
    const a = file("src/a.ts", {
      imports: [imp("./b", ["impl"])],
      decls: [decl("src/a.ts", "local", "function", { exported: false })],
      exports: [exp("zeta", "named", { local: "local" }), exp("alpha", "named", { local: "impl" })],
    });
    const files = [a, b];
    const index = buildExportIndex(files, linkImports(files, resolver(files.map((f) => f.path))));
    expect(exportNames(index, "src/a.ts")).toEqual(["alpha", "zeta"]);
    expect(index.get("src/a.ts")?.get("zeta")).toEqual({ file: "src/a.ts", symbol: "local", hops: 0 });
    expect(index.get("src/a.ts")?.get("alpha")).toEqual({ file: "src/b.ts", symbol: "impl", hops: 1 });
  });

  test("unresolved and external re-export sources contribute nothing but the name", () => {
    const a = file("src/a.ts", {
      imports: [imp("lodash", [["merge", "merge"]], { reexport: true }), imp("./gone", [["*", "*"]], { reexport: true, line: 2 })],
      exports: [exp("merge", "named", { local: "merge", from: "lodash" }), exp("*", "star", { from: "./gone" })],
    });
    const index = buildExportIndex([a], linkImports([a], resolver(["src/a.ts"])));
    expect(exportNames(index, "src/a.ts")).toEqual(["merge"]);
  });

  test("tiny-ts: the core index re-exports registry, retry and types", () => {
    const { index } = tinyTs();
    expect(exportNames(index, `${CORE}/index.ts`)).toEqual([
      "Ack",
      "DEFAULT_ATTEMPTS",
      "Msg",
      "Priority",
      "Queue",
      "Registry",
      "createRegistry",
      "retry",
    ]);
    expect(index.get(`${CORE}/index.ts`)?.get("retry")).toEqual({
      file: `${CORE}/retry.ts`,
      symbol: "retry",
      hops: 1,
    });
    expect(index.get(`${CORE}/index.ts`)?.get("createRegistry")).toEqual({
      file: `${CORE}/registry.ts`,
      symbol: "createRegistry",
      hops: 1,
    });
    expect(exportNames(index, `${CORE}/retry.ts`)).toEqual(["DEFAULT_ATTEMPTS", "RetryOptions", "retry"]);
  });
});

describe("linkCalls", () => {
  function linkOne(files: FileRecord[], aliases: Record<string, ResolvedTarget> = {}) {
    const imports = linkImports(files, resolver(files.map((f) => f.path), aliases));
    return linkCalls(files, imports, buildExportIndex(files, imports));
  }

  test("same-file declaration resolves high; types and interfaces are not callable", () => {
    const a = file("src/a.ts", {
      decls: [
        decl("src/a.ts", "helper", "function"),
        decl("src/a.ts", "Shape", "interface"),
        decl("src/a.ts", "Alias", "type"),
        decl("src/a.ts", "caller", "function"),
      ],
      calls: [call("caller", "helper"), call("caller", "Shape"), call("caller", "Alias"), call("caller", "missing")],
    });
    expect(linkOne([a]).map(edgeKey)).toEqual(["src/a.ts#caller -> src/a.ts#helper (high)"]);
  });

  test("imported symbol resolves high at hops 0 and med through one re-export hop", () => {
    const impl = file("src/impl.ts", { decls: [decl("src/impl.ts", "work", "function")], exports: [exp("work")] });
    const idx = file("src/index.ts", {
      imports: [imp("./impl", ["work"], { reexport: true })],
      exports: [exp("work", "named", { local: "work", from: "./impl" })],
    });
    const direct = file("src/direct.ts", {
      imports: [imp("./impl", ["work"])],
      decls: [decl("src/direct.ts", "go", "function")],
      calls: [call("go", "work")],
    });
    const viaIndex = file("src/via.ts", {
      imports: [imp("./index", ["work"])],
      decls: [decl("src/via.ts", "go", "function")],
      calls: [call("go", "work")],
    });
    expect(linkOne([impl, idx, direct, viaIndex]).map(edgeKey)).toEqual([
      "src/direct.ts#go -> src/impl.ts#work (high)",
      "src/via.ts#go -> src/impl.ts#work (med)",
    ]);
  });

  test("default imports resolve to the default export target", () => {
    const impl = file("src/impl.ts", {
      decls: [decl("src/impl.ts", "widget", "function")],
      exports: [exp("widget"), exp("default", "default", { local: "widget" })],
    });
    const user = file("src/user.ts", {
      imports: [imp("./impl", [["default", "w"]])],
      decls: [decl("src/user.ts", "go", "function")],
      calls: [call("go", "w")],
    });
    expect(linkOne([impl, user]).map(edgeKey)).toEqual(["src/user.ts#go -> src/impl.ts#widget (high)"]);
  });

  test("this.m resolves against the enclosing class", () => {
    const a = file("src/a.ts", {
      decls: [...classDecls("src/a.ts", "Klass", ["run", "step"]), decl("src/a.ts", "loose", "function")],
      calls: [call("Klass.run", "this.step"), call("Klass.run", "this.nope"), call("loose", "this.step")],
    });
    expect(linkOne([a]).map(edgeKey)).toEqual(["src/a.ts#Klass.run -> src/a.ts#Klass.step (high)"]);
  });

  test("namespace member calls resolve through the namespace module", () => {
    const impl = file("src/impl.ts", { decls: [decl("src/impl.ts", "work", "function")], exports: [exp("work")] });
    const impl2 = file("src/impl2.ts", { decls: [decl("src/impl2.ts", "work2", "function")], exports: [exp("work2")] });
    const idx = file("src/index.ts", {
      imports: [imp("./impl2", [["*", "*"]], { reexport: true })],
      exports: [exp("*", "star", { from: "./impl2" })],
    });
    const user = file("src/user.ts", {
      imports: [imp("./impl", [["*", "ns"]]), imp("./index", [["*", "re"]], { line: 2 })],
      decls: [decl("src/user.ts", "go", "function")],
      calls: [call("go", "ns.work"), call("go", "re.work2"), call("go", "ns.missing"), call("go", "work")],
    });
    expect(linkOne([impl, impl2, idx, user]).map(edgeKey)).toEqual([
      "src/user.ts#go -> src/impl.ts#work (high)",
      "src/user.ts#go -> src/impl2.ts#work2 (med)",
    ]);
  });

  test("static member calls resolve on same-file and imported classes", () => {
    const lib = file("src/lib.ts", { decls: classDecls("src/lib.ts", "Lib", ["make"]), exports: [exp("Lib")] });
    const user = file("src/user.ts", {
      imports: [imp("./lib", ["Lib"])],
      decls: [...classDecls("src/user.ts", "Local", ["build"]), decl("src/user.ts", "go", "function")],
      calls: [call("go", "Lib.make"), call("go", "Local.build"), call("go", "Lib.absent"), call("go", "unknown.x")],
    });
    expect(linkOne([lib, user]).map(edgeKey)).toEqual([
      "src/user.ts#go -> src/lib.ts#Lib.make (high)",
      "src/user.ts#go -> src/user.ts#Local.build (high)",
    ]);
  });

  test("new X and new ns.X follow the same rules as plain calls", () => {
    const lib = file("src/lib.ts", { decls: classDecls("src/lib.ts", "Lib", ["m"]), exports: [exp("Lib")] });
    const user = file("src/user.ts", {
      imports: [imp("./lib", ["Lib"]), imp("./lib", [["*", "ns"]], { line: 2 })],
      decls: [...classDecls("src/user.ts", "Local", ["m"]), decl("src/user.ts", "go", "function")],
      calls: [call("go", "new Lib"), call("go", "new ns.Lib"), call("go", "new Local"), call("go", "new Unknown")],
    });
    expect(linkOne([lib, user]).map(edgeKey)).toEqual([
      "src/user.ts#go -> src/lib.ts#Lib (high)",
      "src/user.ts#go -> src/user.ts#Local (high)",
    ]);
  });

  test("drops calls through type-only, side-effect, external, unresolved and namespace-bare bindings", () => {
    const impl = file("src/impl.ts", { decls: [decl("src/impl.ts", "work", "function")], exports: [exp("work")] });
    const user = file("src/user.ts", {
      imports: [
        imp("./impl", ["work"], { kind: "type" }),
        imp("./impl", [], { kind: "side-effect", line: 2 }),
        imp("./impl", [["*", "ns"]], { line: 3 }),
        imp("lodash", ["merge"], { line: 4 }),
        imp("./gone", ["ghost"], { line: 5 }),
      ],
      decls: [decl("src/user.ts", "go", "function")],
      calls: [call("go", "work"), call("go", "ns"), call("go", "merge"), call("go", "ghost")],
    });
    expect(linkOne([impl, user])).toEqual([]);
  });

  test("re-export bindings never resolve a local call, and dangling index entries are dropped", () => {
    const impl = file("src/impl.ts", { decls: [decl("src/impl.ts", "work", "function")], exports: [exp("work")] });
    const idx = file("src/index.ts", {
      imports: [imp("./impl", ["work"], { reexport: true })],
      decls: [decl("src/index.ts", "go", "function")],
      exports: [exp("work", "named", { local: "work", from: "./impl" })],
      calls: [call("go", "work")],
    });
    const ghost = file("src/ghost.ts", {
      exports: [exp("phantom", "named", { local: "phantom" })],
    });
    const user = file("src/user.ts", {
      imports: [imp("./ghost", ["phantom"])],
      decls: [decl("src/user.ts", "go", "function")],
      calls: [call("go", "phantom")],
    });
    expect(linkOne([impl, idx, ghost, user])).toEqual([]);
  });

  test("top-level calls use the file id as from, and duplicates collapse keeping the best confidence", () => {
    const impl = file("src/impl.ts", { decls: [decl("src/impl.ts", "work", "function")], exports: [exp("work")] });
    const idx = file("src/index.ts", {
      imports: [imp("./impl", ["work"], { reexport: true })],
      exports: [exp("work", "named", { local: "work", from: "./impl" })],
    });
    const user = file("src/user.ts", {
      imports: [imp("./impl", ["work"]), imp("./index", [["work", "viaIndex"]], { line: 2 })],
      calls: [call("", "work", 3), call("", "work", 4), call("", "viaIndex", 5)],
    });
    const edges = linkOne([impl, idx, user]);
    expect(edges.map(edgeKey)).toEqual(["src/user.ts -> src/impl.ts#work (high)"]);
    expect(edges[0]?.kind).toBe("call");
    expect(edges[0]).not.toHaveProperty("symbols");
  });

  test("an external re-export never fabricates an edge onto a same-named local declaration", () => {
    // `export { retry } from "lodash"` puts the name in a.ts's export set, but
    // a.ts's own non-exported `retry` is a different function entirely.
    const a = file("src/a.ts", {
      imports: [imp("lodash", [["retry", "retry"]], { reexport: true })],
      decls: [decl("src/a.ts", "retry", "function", { exported: false })],
      exports: [exp("retry", "named", { local: "retry", from: "lodash" })],
    });
    const user = file("src/user.ts", {
      imports: [imp("./a", ["retry"])],
      decls: [decl("src/user.ts", "go", "function")],
      calls: [call("go", "retry")],
    });
    expect(linkOne([a, user])).toEqual([]);
    // The name is still reported as an export of a.ts.
    const imports = linkImports([a, user], resolver(["src/a.ts", "src/user.ts"]));
    expect(exportNames(buildExportIndex([a, user], imports), "src/a.ts")).toEqual(["retry"]);
  });

  test("the same trap through an unresolved specifier and a namespace re-export", () => {
    const a = file("src/a.ts", {
      imports: [
        imp("./gone", [["work", "work"]], { reexport: true }),
        imp("./b", [["*", "ns"]], { reexport: true, line: 2 }),
      ],
      decls: [decl("src/a.ts", "work", "function", { exported: false }), decl("src/a.ts", "ns", "class")],
      exports: [
        exp("work", "named", { local: "work", from: "./gone" }),
        exp("ns", "named", { local: "*", from: "./b" }),
      ],
    });
    const b = file("src/b.ts", { decls: [decl("src/b.ts", "thing", "function")], exports: [exp("thing")] });
    const user = file("src/user.ts", {
      imports: [imp("./a", ["work", "ns"])],
      decls: [decl("src/user.ts", "go", "function")],
      calls: [call("go", "work"), call("go", "ns.thing")],
    });
    expect(linkOne([a, b, user])).toEqual([]);
  });

  test("a call through a two-hop barrel chain is dropped, one hop is med", () => {
    const leaf = file("src/leaf.ts", { decls: [decl("src/leaf.ts", "work", "function")], exports: [exp("work")] });
    const mid = file("src/mid.ts", {
      imports: [imp("./leaf", [["*", "*"]], { reexport: true })],
      exports: [exp("*", "star", { from: "./leaf" })],
    });
    const top = file("src/top.ts", {
      imports: [imp("./mid", [["*", "*"]], { reexport: true })],
      exports: [exp("*", "star", { from: "./mid" })],
    });
    const viaMid = file("src/via-mid.ts", {
      imports: [imp("./mid", ["work"])],
      decls: [decl("src/via-mid.ts", "go", "function")],
      calls: [call("go", "work")],
    });
    const viaTop = file("src/via-top.ts", {
      imports: [imp("./top", ["work"]), imp("./top", [["*", "ns"]], { line: 2 })],
      decls: [decl("src/via-top.ts", "go", "function")],
      calls: [call("go", "work"), call("go", "ns.work")],
    });
    expect(linkOne([leaf, mid, top, viaMid, viaTop]).map(edgeKey)).toEqual([
      "src/via-mid.ts#go -> src/leaf.ts#work (med)",
    ]);
  });

  test("a med edge is upgraded when a later call site resolves the same pair at high", () => {
    const impl = file("src/impl.ts", { decls: [decl("src/impl.ts", "work", "function")], exports: [exp("work")] });
    const idx = file("src/index.ts", {
      imports: [imp("./impl", ["work"], { reexport: true })],
      exports: [exp("work", "named", { local: "work", from: "./impl" })],
    });
    const medFirst = file("src/med-first.ts", {
      imports: [imp("./index", [["work", "viaIndex"]]), imp("./impl", ["work"], { line: 2 })],
      decls: [decl("src/med-first.ts", "go", "function")],
      calls: [call("go", "viaIndex", 3), call("go", "work", 4)],
    });
    const medOnly = file("src/med-only.ts", {
      imports: [imp("./index", [["work", "viaIndex"]])],
      decls: [decl("src/med-only.ts", "go", "function")],
      calls: [call("go", "viaIndex", 3)],
    });
    expect(linkOne([impl, idx, medFirst, medOnly]).map(edgeKey)).toEqual([
      "src/med-first.ts#go -> src/impl.ts#work (high)",
      "src/med-only.ts#go -> src/impl.ts#work (med)",
    ]);
  });

  test("paths and symbol names containing spaces do not collide", () => {
    const lib = file("src/my lib.ts", { decls: [decl("src/my lib.ts", "work", "function")], exports: [exp("work")] });
    const user = file("src/user.ts", {
      imports: [imp("./my lib", ["work"])],
      decls: [decl("src/user.ts", "go", "function")],
      calls: [call("go", "work")],
    });
    expect(linkOne([lib, user]).map(edgeKey)).toEqual(["src/user.ts#go -> src/my lib.ts#work (high)"]);
  });

  test("tiny-ts: publish reaches retry through the re-export at med, publishAll directly at high", () => {
    const { calls } = tinyTs();
    expect(calls.map(edgeKey)).toEqual([
      `${WORKER}/main.ts -> ${WORKER}/main.ts#main (high)`,
      `${WORKER}/main.ts#main -> ${WORKER}/config.ts#loadConfig (high)`,
      `${WORKER}/main.ts#main -> ${ADAPTERS}/memory.ts#MemoryAdapter (med)`,
      `${WORKER}/main.ts#main -> ${ADAPTERS}/sqs.ts#createSqsAdapter (med)`,
      `${WORKER}/main.ts#main -> ${CORE}/registry.ts#createRegistry (med)`,
      `${ADAPTERS}/sqs.ts#SqsAdapter.publish -> ${CORE}/retry.ts#retry (med)`,
      `${ADAPTERS}/sqs.ts#createSqsAdapter -> ${ADAPTERS}/sqs.ts#SqsAdapter (high)`,
      `${CORE}/bus.ts#Bus.emit -> ${CORE}/events.ts#formatEvent (high)`,
      `${CORE}/events.ts#createBus -> ${CORE}/bus.ts#Bus (high)`,
      `${CORE}/registry.ts#Registry.publishAll -> ${CORE}/retry.ts#retry (high)`,
      `${CORE}/registry.ts#createRegistry -> ${CORE}/registry.ts#Registry (high)`,
    ]);
  });
});

describe("tarjan", () => {
  test("returns only components larger than one node", () => {
    const nodes = ["a", "b", "c", "d"];
    const edges: Array<[string, string]> = [
      ["a", "b"],
      ["b", "a"],
      ["c", "d"],
    ];
    expect(stronglyConnected(nodes, edges)).toEqual([["a", "b"]]);
  });

  test("ignores self loops", () => {
    expect(stronglyConnected(["a", "b"], [["a", "a"], ["a", "b"]])).toEqual([]);
  });

  test("sorts members and orders components by first id", () => {
    const nodes = ["m", "z", "a", "k", "b"];
    const edges: Array<[string, string]> = [
      ["z", "m"],
      ["m", "z"],
      ["k", "b"],
      ["b", "a"],
      ["a", "k"],
    ];
    expect(stronglyConnected(nodes, edges)).toEqual([
      ["a", "b", "k"],
      ["m", "z"],
    ]);
  });

  test("returns nothing for a DAG and tolerates duplicate and unknown edges", () => {
    const nodes = ["a", "b", "c"];
    const edges: Array<[string, string]> = [
      ["a", "b"],
      ["a", "b"],
      ["b", "c"],
      ["c", "ghost"],
      ["ghost", "a"],
    ];
    expect(stronglyConnected(nodes, edges)).toEqual([]);
    expect(stronglyConnected([], [])).toEqual([]);
  });

  test("handles a long chain without blowing the stack", () => {
    const n = 20000;
    const nodes = Array.from({ length: n }, (_, i) => `n${String(i).padStart(6, "0")}`);
    const edges: Array<[string, string]> = [];
    for (let i = 0; i + 1 < n; i++) edges.push([nodes[i]!, nodes[i + 1]!]);
    edges.push([nodes[n - 1]!, nodes[0]!]);
    const sccs = stronglyConnected(nodes, edges);
    expect(sccs).toHaveLength(1);
    expect(sccs[0]).toHaveLength(n);
  });

  test("tiny-ts: bus and events are the only cycle", () => {
    const { imports } = tinyTs();
    const files = tinyTsFiles().map((f) => f.path);
    expect(stronglyConnected(files, fileEdges(imports))).toEqual([[`${CORE}/bus.ts`, `${CORE}/events.ts`]]);
  });
});

// ---------------------------------------------------------------------------
// Deterministic PRNG + brute-force reference for the blast radius proofs.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGraph(
  seed: number,
  nodeCount: number,
  edgeCount: number,
  acyclic: boolean,
): { nodes: string[]; edges: Array<[string, string]> } {
  const rnd = mulberry32(seed);
  const nodes = Array.from({ length: nodeCount }, (_, i) => `f${String(i).padStart(3, "0")}.ts`);
  const edges: Array<[string, string]> = [];
  for (let e = 0; e < edgeCount; e++) {
    let i = Math.floor(rnd() * nodeCount);
    let j = Math.floor(rnd() * nodeCount);
    if (acyclic) {
      if (i === j) continue;
      if (i > j) [i, j] = [j, i];
    }
    edges.push([nodes[i]!, nodes[j]!]);
  }
  return { nodes, edges };
}

function reversePredecessors(
  nodes: string[],
  edges: ReadonlyArray<readonly [string, string]>,
): Map<string, string[]> {
  const preds = new Map<string, string[]>();
  for (const n of nodes) preds.set(n, []);
  for (const [from, to] of edges) preds.get(to)?.push(from);
  return preds;
}

function bruteBlast(nodes: string[], edges: ReadonlyArray<readonly [string, string]>): Map<string, number> {
  const preds = reversePredecessors(nodes, edges);
  const out = new Map<string, number>();
  for (const start of nodes) {
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      for (const p of preds.get(cur) ?? []) {
        if (!seen.has(p)) {
          seen.add(p);
          queue.push(p);
        }
      }
    }
    out.set(start, seen.size - 1);
  }
  return out;
}

function bruteImpact(
  nodes: string[],
  edges: ReadonlyArray<readonly [string, string]>,
  target: string,
): Array<{ path: string; depth: number }> {
  const preds = reversePredecessors(nodes, edges);
  const seen = new Set<string>([target]);
  const out: Array<{ path: string; depth: number }> = [];
  let frontier = [target];
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];
    for (const cur of frontier) {
      for (const p of preds.get(cur) ?? []) {
        if (!seen.has(p)) {
          seen.add(p);
          out.push({ path: p, depth });
          next.push(p);
        }
      }
    }
    frontier = next;
  }
  return out.sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

describe("blast", () => {
  test("counts the reverse transitive closure, excluding the node itself", () => {
    const nodes = ["a.ts", "b.ts", "c.ts", "d.ts"];
    const edges: Array<[string, string]> = [
      ["b.ts", "a.ts"],
      ["c.ts", "b.ts"],
      ["d.ts", "a.ts"],
    ];
    expect([...blastRadius(nodes, edges).entries()].sort()).toEqual([
      ["a.ts", 3],
      ["b.ts", 1],
      ["c.ts", 0],
      ["d.ts", 0],
    ]);
  });

  test("every node in a cycle sees the same radius and never counts itself", () => {
    const nodes = ["a.ts", "b.ts", "c.ts"];
    const edges: Array<[string, string]> = [
      ["a.ts", "b.ts"],
      ["b.ts", "a.ts"],
      ["c.ts", "a.ts"],
      ["a.ts", "a.ts"],
    ];
    const radius = blastRadius(nodes, edges);
    expect(radius.get("a.ts")).toBe(2);
    expect(radius.get("b.ts")).toBe(2);
    expect(radius.get("c.ts")).toBe(0);
  });

  test("empty graphs, isolated nodes and unknown endpoints", () => {
    expect(blastRadius([], [])).toEqual(new Map());
    expect(blastRadius(["a.ts"], [])).toEqual(new Map([["a.ts", 0]]));
    expect(blastRadius(["a.ts"], [["ghost.ts", "a.ts"], ["a.ts", "ghost.ts"]])).toEqual(new Map([["a.ts", 0]]));
  });

  test("matches brute force on seeded random DAGs", () => {
    for (const seed of [1, 2, 3, 7, 11]) {
      const { nodes, edges } = randomGraph(seed, 60, 180, true);
      expect([...blastRadius(nodes, edges).entries()].sort()).toEqual([...bruteBlast(nodes, edges).entries()].sort());
    }
  });

  test("matches brute force on seeded random cyclic graphs", () => {
    for (const seed of [4, 5, 6, 13, 21]) {
      const { nodes, edges } = randomGraph(seed, 50, 200, false);
      expect([...blastRadius(nodes, edges).entries()].sort()).toEqual([...bruteBlast(nodes, edges).entries()].sort());
    }
  });

  test("matches brute force on dense and sparse extremes", () => {
    for (const [n, e] of [[8, 60], [40, 3], [100, 400]] as Array<[number, number]>) {
      const { nodes, edges } = randomGraph(n * 31 + e, n, e, false);
      expect([...blastRadius(nodes, edges).entries()].sort()).toEqual([...bruteBlast(nodes, edges).entries()].sort());
    }
  });

  test("impactOf is sorted by depth then path and excludes the target", () => {
    const edges: Array<[string, string]> = [
      ["b.ts", "a.ts"],
      ["z.ts", "a.ts"],
      ["c.ts", "b.ts"],
      ["a.ts", "a.ts"],
    ];
    expect(impactOf(edges, "a.ts")).toEqual([
      { path: "b.ts", depth: 1 },
      { path: "z.ts", depth: 1 },
      { path: "c.ts", depth: 2 },
    ]);
    expect(impactOf(edges, "unknown.ts")).toEqual([]);
  });

  test("impactOf matches a brute-force reverse BFS on seeded random graphs", () => {
    for (const seed of [8, 9, 10]) {
      const { nodes, edges } = randomGraph(seed, 40, 120, false);
      for (const target of [nodes[0]!, nodes[13]!, nodes[39]!]) {
        expect(impactOf(edges, target)).toEqual(bruteImpact(nodes, edges, target));
      }
    }
  });

  test("impactOf agrees with blastRadius on the closure size", () => {
    const { nodes, edges } = randomGraph(99, 45, 150, false);
    const radius = blastRadius(nodes, edges);
    for (const node of nodes) expect(impactOf(edges, node)).toHaveLength(radius.get(node) ?? -1);
  });

  test("tiny-ts: retry, types and bus blast radii", () => {
    const { imports } = tinyTs();
    const files = tinyTsFiles().map((f) => f.path);
    const radius = blastRadius(files, fileEdges(imports));
    expect(radius.get(`${CORE}/retry.ts`)).toBe(6);
    expect(radius.get(`${CORE}/types.ts`)).toBe(9);
    expect(radius.get(`${CORE}/bus.ts`)).toBe(7);
    expect(radius.get(`${WORKER}/main.ts`)).toBe(0);
    expect(impactOf(fileEdges(imports), `${WORKER}/config.ts`)).toEqual([
      { path: `${WORKER}/main.ts`, depth: 1 },
    ]);
  });
});

describe("metrics", () => {
  const packages: PackageInfo[] = [
    { name: "root", path: ".", source: "root" },
    { name: "alpha", path: "packages/alpha", source: "package.json" },
    { name: "beta", path: "packages/beta", source: "package.json" },
  ];

  function smallRepo(): FileRecord[] {
    return [
      file("packages/alpha/src/a.ts", {
        loc: 10,
        imports: [imp("./b", ["b"]), imp("beta", ["c"], { line: 2 }), imp("lodash", ["merge"], { line: 3 })],
      }),
      file("packages/alpha/src/b.ts", { loc: 20, imports: [imp("./b", ["self"]), imp("./nope", ["x"], { line: 2 })] }),
      file("packages/beta/src/c.ts", { loc: 30, imports: [imp("../../alpha/src/a.ts", ["a"])] }),
      file("root.ts", { loc: 5 }),
    ];
  }

  function metricsOf(files: FileRecord[], pkgs: PackageInfo[] = packages) {
    const imports = linkImports(files, resolver(files.map((f) => f.path), { beta: { type: "file", path: "packages/beta/src/c.ts" } }));
    return computeMetrics(files, pkgs, imports);
  }

  test("fanIn, fanOut and blast per file, ignoring self-imports and non-file targets", () => {
    const { manifestFiles } = metricsOf(smallRepo());
    expect(manifestFiles["packages/alpha/src/a.ts"]).toEqual({
      sha256: "0".repeat(64),
      pkg: "alpha",
      lang: "ts",
      loc: 10,
      fanIn: 1,
      fanOut: 2,
      blast: 1,
    });
    expect(manifestFiles["packages/alpha/src/b.ts"]?.fanIn).toBe(1);
    expect(manifestFiles["packages/alpha/src/b.ts"]?.fanOut).toBe(0);
    expect(manifestFiles["packages/alpha/src/b.ts"]?.blast).toBe(2);
    expect(manifestFiles["root.ts"]).toEqual({
      sha256: "0".repeat(64),
      pkg: "root",
      lang: "ts",
      loc: 5,
      fanIn: 0,
      fanOut: 0,
      blast: 0,
    });
  });

  test("packageOf uses the deepest path prefix with a root fallback", () => {
    const nested: PackageInfo[] = [
      { name: "root", path: ".", source: "root" },
      { name: "outer", path: "packages/outer", source: "package.json" },
      { name: "inner", path: "packages/outer/nested/inner", source: "package.json" },
    ];
    const files = [
      file("packages/outer/src/x.ts"),
      file("packages/outer/nested/inner/src/y.ts"),
      file("scripts/z.ts"),
    ];
    const { manifestFiles } = metricsOf(files, nested);
    expect(manifestFiles["packages/outer/src/x.ts"]?.pkg).toBe("outer");
    expect(manifestFiles["packages/outer/nested/inner/src/y.ts"]?.pkg).toBe("inner");
    expect(manifestFiles["scripts/z.ts"]?.pkg).toBe("root");
  });

  test("package entries carry sorted deps, rdeps, loc and file counts", () => {
    const { manifestPackages } = metricsOf(smallRepo());
    expect(manifestPackages["alpha"]).toEqual({
      path: "packages/alpha",
      deps: ["beta"],
      rdeps: ["beta"],
      loc: 30,
      files: 2,
    });
    expect(manifestPackages["beta"]).toEqual({
      path: "packages/beta",
      deps: ["alpha"],
      rdeps: ["alpha"],
      loc: 30,
      files: 1,
    });
    expect(manifestPackages["root"]).toEqual({ path: ".", deps: [], rdeps: [], loc: 5, files: 1 });
    expect(Object.keys(manifestPackages).sort()).toEqual(["alpha", "beta", "root"]);
  });

  test("package edges count the file edges behind them and are sorted", () => {
    const { metrics } = metricsOf(smallRepo());
    expect(metrics.packageEdges).toEqual([
      { from: "alpha", to: "beta", count: 1 },
      { from: "beta", to: "alpha", count: 1 },
    ]);
  });

  test("package names containing spaces keep their own edges", () => {
    // detectPackages disambiguates duplicate names as "<name> (<path>)".
    const spaced: PackageInfo[] = [
      { name: "root", path: ".", source: "root" },
      { name: "core (packages/alpha)", path: "packages/alpha", source: "package.json" },
      { name: "core", path: "packages/gamma", source: "package.json" },
    ];
    const files = [
      file("packages/alpha/src/a.ts", { loc: 1, imports: [imp("../../gamma/src/g.ts", ["g"])] }),
      file("packages/gamma/src/g.ts", { loc: 2 }),
    ];
    const { metrics, manifestPackages } = metricsOf(files, spaced);
    expect(metrics.packageEdges).toEqual([{ from: "core (packages/alpha)", to: "core", count: 1 }]);
    expect(manifestPackages["core (packages/alpha)"]?.deps).toEqual(["core"]);
    expect(manifestPackages["core"]?.rdeps).toEqual(["core (packages/alpha)"]);
  });

  test("cycles come from Tarjan over file-level import and reexport edges", () => {
    const files = [
      file("a.ts", { imports: [imp("./b", ["b"])] }),
      file("b.ts", { imports: [imp("./a", ["a"], { reexport: true })] }),
      file("c.ts", { imports: [imp("./c", ["self"])] }),
    ];
    const { metrics } = metricsOf(files, [{ name: "root", path: ".", source: "root" }]);
    expect(metrics.cycles).toEqual([["a.ts", "b.ts"]]);
  });

  test("metrics are byte-stable under file and package reordering", () => {
    const forward = tinyTs();
    const backward = tinyTs([...tinyTsFiles()].reverse());
    const a = computeMetrics(forward.files, TINY_PACKAGES, forward.imports);
    const b = computeMetrics(backward.files, [...TINY_PACKAGES].reverse(), backward.imports);
    expect(stableStringify(b, 2)).toBe(stableStringify(a, 2));
  });

  test("tiny-ts: 12 files, 4 packages, one cycle, and the package graph", () => {
    const { files, imports, packages: pkgs } = tinyTs();
    const { manifestFiles, manifestPackages, metrics } = computeMetrics(files, pkgs, imports);
    expect(Object.keys(manifestFiles)).toHaveLength(12);
    expect(Object.keys(manifestPackages).sort()).toEqual(["@tiny/adapters", "@tiny/core", "tiny-ts", "worker"]);
    expect(metrics.cycles).toEqual([[`${CORE}/bus.ts`, `${CORE}/events.ts`]]);
    expect(metrics.packageEdges).toEqual([
      { from: "@tiny/adapters", to: "@tiny/core", count: 4 },
      { from: "worker", to: "@tiny/adapters", count: 1 },
      { from: "worker", to: "@tiny/core", count: 1 },
    ]);
    expect(manifestPackages["@tiny/core"]).toEqual({
      path: "packages/core",
      deps: [],
      rdeps: ["@tiny/adapters", "worker"],
      loc: 96,
      files: 7,
    });
    expect(manifestPackages["worker"]).toEqual({
      path: "apps/worker",
      deps: ["@tiny/adapters", "@tiny/core"],
      rdeps: [],
      loc: 26,
      files: 2,
    });
    expect(manifestPackages["tiny-ts"]).toEqual({ path: ".", deps: [], rdeps: [], loc: 0, files: 0 });
    expect(manifestFiles[`${CORE}/retry.ts`]).toEqual({
      sha256: "0".repeat(64),
      pkg: "@tiny/core",
      lang: "ts",
      loc: 18,
      fanIn: 2,
      fanOut: 0,
      blast: 6,
    });
    expect(manifestFiles[`${CORE}/index.ts`]?.fanOut).toBe(4);
    expect(manifestFiles[`${CORE}/index.ts`]?.fanIn).toBe(3);
  });
});
