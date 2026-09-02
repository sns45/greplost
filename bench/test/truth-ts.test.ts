/**
 * Truth generator tests (leaf 1.5.1, gates G1 and G3).
 *
 * Everything asserted in `fixture truth` is derived from `fixtures/tiny-ts` by hand
 * and pinned: these are the numbers the structure layer is scored against, so they
 * are written out in full rather than recomputed from the thing under test.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stableStringify } from "@greplost/core/schema";
import { generateTsTruth, listTypeScriptFiles, type Truth } from "../src/truth/ts.ts";
import { run } from "../src/structural.ts";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const fixtureRoot = path.join(repoRoot, "fixtures", "tiny-ts");

const FIXTURE_FILES = [
  "apps/worker/src/config.ts",
  "apps/worker/src/main.ts",
  "packages/adapters/src/index.ts",
  "packages/adapters/src/memory.ts",
  "packages/adapters/src/sqs.ts",
  "packages/core/src/bus.ts",
  "packages/core/src/events.ts",
  "packages/core/src/index.ts",
  "packages/core/src/queue.ts",
  "packages/core/src/registry.ts",
  "packages/core/src/retry.ts",
  "packages/core/src/types.ts",
];

const truth: Truth = generateTsTruth(fixtureRoot, FIXTURE_FILES);

const edgeKeys = (edges: { from: string; to: string }[]): string[] => edges.map((e) => `${e.from} -> ${e.to}`);

describe("fixture truth", () => {
  test("the fixture is the twelve TypeScript files the scoring is pinned to", () => {
    expect(listTypeScriptFiles(fixtureRoot)).toEqual(FIXTURE_FILES);
  });

  test("pins the import edge set, including type-only, dynamic and re-export edges", () => {
    expect(edgeKeys(truth.imports)).toEqual([
      "apps/worker/src/main.ts -> apps/worker/src/config.ts",
      "apps/worker/src/main.ts -> packages/adapters/src/index.ts",
      "apps/worker/src/main.ts -> packages/core/src/index.ts",
      "packages/adapters/src/index.ts -> packages/adapters/src/memory.ts",
      "packages/adapters/src/index.ts -> packages/adapters/src/sqs.ts",
      "packages/adapters/src/memory.ts -> packages/core/src/index.ts",
      "packages/adapters/src/sqs.ts -> packages/core/src/index.ts",
      "packages/core/src/bus.ts -> packages/core/src/events.ts",
      "packages/core/src/bus.ts -> packages/core/src/types.ts",
      "packages/core/src/events.ts -> packages/core/src/bus.ts",
      "packages/core/src/index.ts -> packages/core/src/queue.ts",
      "packages/core/src/index.ts -> packages/core/src/registry.ts",
      "packages/core/src/index.ts -> packages/core/src/retry.ts",
      "packages/core/src/index.ts -> packages/core/src/types.ts",
      "packages/core/src/queue.ts -> packages/core/src/types.ts",
      "packages/core/src/registry.ts -> packages/core/src/bus.ts",
      "packages/core/src/registry.ts -> packages/core/src/queue.ts",
      "packages/core/src/registry.ts -> packages/core/src/retry.ts",
    ]);
  });

  test("marks the `export ... from` edges of the two index files as re-exports", () => {
    const reexports = truth.imports.filter((e) => e.kind === "reexport");
    expect(edgeKeys(reexports)).toEqual([
      "packages/adapters/src/index.ts -> packages/adapters/src/memory.ts",
      "packages/adapters/src/index.ts -> packages/adapters/src/sqs.ts",
      "packages/core/src/index.ts -> packages/core/src/queue.ts",
      "packages/core/src/index.ts -> packages/core/src/registry.ts",
      "packages/core/src/index.ts -> packages/core/src/retry.ts",
      "packages/core/src/index.ts -> packages/core/src/types.ts",
    ]);
  });

  test("merges the type-only and dynamic imports of memory.ts into one edge", () => {
    // memory.ts has `import type { Queue, Ack, Msg } from "@tiny/core"` and
    // `await import("@tiny/core")` inside MemoryAdapter.publish.
    const edge = truth.imports.find(
      (e) => e.from === "packages/adapters/src/memory.ts" && e.to === "packages/core/src/index.ts",
    );
    expect(edge).toBeDefined();
    expect(edge?.kind).toBe("import");
    expect(edge?.symbols).toEqual(["*", "Ack", "Msg", "Queue"]);
  });

  test("carries the union of value and type imported symbols for sqs.ts", () => {
    const edge = truth.imports.find(
      (e) => e.from === "packages/adapters/src/sqs.ts" && e.to === "packages/core/src/index.ts",
    );
    expect(edge?.symbols).toEqual(["Ack", "Msg", "Priority", "Queue", "retry"]);
  });

  test("records `export * from` with a star symbol", () => {
    const edge = truth.imports.find(
      (e) => e.from === "packages/core/src/index.ts" && e.to === "packages/core/src/registry.ts",
    );
    expect(edge?.kind).toBe("reexport");
    expect(edge?.symbols).toEqual(["*"]);
  });

  test("drops the uninstalled @aws-sdk/client-sqs import: every target is a listed file", () => {
    for (const edge of truth.imports) {
      expect(FIXTURE_FILES).toContain(edge.from);
      expect(FIXTURE_FILES).toContain(edge.to);
    }
    expect(truth.imports.some((e) => e.to.includes("aws-sdk"))).toBe(false);
  });

  test("pins the exports of packages/core/src/index.ts, including the star re-export", () => {
    expect(truth.exports["packages/core/src/index.ts"]).toEqual([
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

  test("pins the exports of every fixture file", () => {
    expect(truth.exports).toEqual({
      "apps/worker/src/config.ts": ["WorkerConfig", "loadConfig"],
      "apps/worker/src/main.ts": ["main"],
      "packages/adapters/src/index.ts": ["MemoryAdapter", "SqsAdapter", "SqsConfig", "createSqsAdapter"],
      "packages/adapters/src/memory.ts": ["MemoryAdapter"],
      "packages/adapters/src/sqs.ts": ["SqsAdapter", "SqsConfig", "createSqsAdapter"],
      "packages/core/src/bus.ts": ["Bus"],
      "packages/core/src/events.ts": ["createBus", "formatEvent"],
      "packages/core/src/index.ts": [
        "Ack",
        "DEFAULT_ATTEMPTS",
        "Msg",
        "Priority",
        "Queue",
        "Registry",
        "createRegistry",
        "retry",
      ],
      "packages/core/src/queue.ts": ["Ack", "Msg", "Queue"],
      "packages/core/src/registry.ts": ["Registry", "createRegistry"],
      "packages/core/src/retry.ts": ["DEFAULT_ATTEMPTS", "RetryOptions", "retry"],
      "packages/core/src/types.ts": ["Handler", "Priority", "VERSION"],
    });
  });

  test("pins the call edge set", () => {
    expect(edgeKeys(truth.calls)).toEqual([
      "apps/worker/src/main.ts -> apps/worker/src/main.ts#main",
      "apps/worker/src/main.ts#main -> apps/worker/src/config.ts#loadConfig",
      "apps/worker/src/main.ts#main -> packages/adapters/src/memory.ts#MemoryAdapter",
      "apps/worker/src/main.ts#main -> packages/adapters/src/sqs.ts#createSqsAdapter",
      "apps/worker/src/main.ts#main -> packages/core/src/registry.ts#Registry.publishAll",
      "apps/worker/src/main.ts#main -> packages/core/src/registry.ts#Registry.register",
      "apps/worker/src/main.ts#main -> packages/core/src/registry.ts#createRegistry",
      "packages/adapters/src/sqs.ts#SqsAdapter.publish -> packages/core/src/retry.ts#retry",
      "packages/adapters/src/sqs.ts#createSqsAdapter -> packages/adapters/src/sqs.ts#SqsAdapter",
      "packages/core/src/bus.ts#Bus.emit -> packages/core/src/events.ts#formatEvent",
      "packages/core/src/events.ts#createBus -> packages/core/src/bus.ts#Bus",
      "packages/core/src/registry.ts#Registry -> packages/core/src/bus.ts#Bus",
      "packages/core/src/registry.ts#Registry.publishAll -> packages/core/src/queue.ts#Queue.publish",
      "packages/core/src/registry.ts#Registry.publishAll -> packages/core/src/retry.ts#retry",
      "packages/core/src/registry.ts#Registry.register -> packages/core/src/bus.ts#Bus.emit",
      "packages/core/src/registry.ts#createRegistry -> packages/core/src/registry.ts#Registry",
    ]);
  });

  test("pins the callers of packages/core/src/retry.ts#retry", () => {
    const callers = truth.calls.filter((e) => e.to === "packages/core/src/retry.ts#retry").map((e) => e.from);
    expect(callers).toEqual([
      "packages/adapters/src/sqs.ts#SqsAdapter.publish",
      "packages/core/src/registry.ts#Registry.publishAll",
    ]);
  });

  test("resolves a call through the `export *` alias in packages/core/src/index.ts", () => {
    // main.ts calls createRegistry(), imported from @tiny/core, which re-exports it
    // with `export * from "./registry"`. Truth must point at the real declaration.
    expect(edgeKeys(truth.calls)).toContain(
      "apps/worker/src/main.ts#main -> packages/core/src/registry.ts#createRegistry",
    );
  });

  test("resolves method calls made through `this`", () => {
    // registry.ts: `this.bus.emit("registered", name)` inside Registry.register.
    expect(edgeKeys(truth.calls)).toContain(
      "packages/core/src/registry.ts#Registry.register -> packages/core/src/bus.ts#Bus.emit",
    );
  });

  test("resolves constructor calls to the class declaration", () => {
    const constructions = edgeKeys(truth.calls).filter((k) => k.endsWith("#Bus") || k.endsWith("#SqsAdapter"));
    expect(constructions).toEqual([
      "packages/adapters/src/sqs.ts#createSqsAdapter -> packages/adapters/src/sqs.ts#SqsAdapter",
      "packages/core/src/events.ts#createBus -> packages/core/src/bus.ts#Bus",
      "packages/core/src/registry.ts#Registry -> packages/core/src/bus.ts#Bus",
    ]);
  });

  test("attributes a top-level call to the file id and a property initializer to the class", () => {
    expect(edgeKeys(truth.calls)).toContain("apps/worker/src/main.ts -> apps/worker/src/main.ts#main");
    // `private bus = new Bus()` has no enclosing function; the enclosing declaration is the class.
    expect(edgeKeys(truth.calls)).toContain("packages/core/src/registry.ts#Registry -> packages/core/src/bus.ts#Bus");
  });

  test("drops calls whose declaration is outside the file list or is a local binding", () => {
    // console.log / Array.push / Map.set (lib), SQSClient.send (@aws-sdk, not installed),
    // `h(label)` (a for-of binding) and `fn()` (a parameter) must all be absent.
    for (const edge of truth.calls) {
      const file = edge.to.split("#")[0] ?? "";
      expect(FIXTURE_FILES).toContain(file);
    }
    expect(edgeKeys(truth.calls)).not.toContain("packages/core/src/bus.ts#Bus.emit -> packages/core/src/bus.ts#h");
    expect(truth.calls.some((e) => e.to.endsWith("#fn"))).toBe(false);
    expect(truth.calls.every((e) => e.confidence === "high")).toBe(true);
  });

  test("finds the single bus <-> events cycle", () => {
    expect(truth.cycles).toEqual([["packages/core/src/bus.ts", "packages/core/src/events.ts"]]);
  });

  test("is deterministic: two runs are byte-identical", () => {
    const again = generateTsTruth(fixtureRoot, [...FIXTURE_FILES].reverse());
    expect(stableStringify(again, 2)).toBe(stableStringify(truth, 2));
  });
});

describe("resolution edge cases", () => {
  const dirs: string[] = [];
  const project = (files: Record<string, string>, tsconfig?: string): string => {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-truth-"));
    dirs.push(dir);
    writeFileSync(
      path.join(dir, "tsconfig.json"),
      tsconfig ??
        JSON.stringify({
          compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
        }),
    );
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "tmp", type: "module" }));
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
      writeFileSync(path.join(dir, name), body);
    }
    return dir;
  };
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  test("resolves a `.js` specifier to the `.ts` source file", () => {
    const dir = project({
      "src/b.ts": "export function b(): number { return 1; }\n",
      "src/a.ts": "import { b } from './b.js';\nexport const a = b();\n",
    });
    const local = generateTsTruth(dir, ["src/a.ts", "src/b.ts"]);
    expect(edgeKeys(local.imports)).toEqual(["src/a.ts -> src/b.ts"]);
    // Core's rule: a variable_declarator owns its calls only when its value is a function,
    // so `export const a = b();` attributes to the file, not to `a`.
    expect(edgeKeys(local.calls)).toEqual(["src/a.ts -> src/b.ts#b"]);
  });

  test("attributes a call inside a function-valued const to that const", () => {
    const dir = project({
      "src/g.ts": "export function g(): void {}\n",
      "src/a.ts":
        "import { g } from './g.js';\nexport const f = () => g();\nexport const h = function (): void { g(); };\n",
    });
    const local = generateTsTruth(dir, ["src/a.ts", "src/g.ts"]);
    expect(edgeKeys(local.calls)).toEqual(["src/a.ts#f -> src/g.ts#g", "src/a.ts#h -> src/g.ts#g"]);
  });

  test("attributes a call in a namespace function to the dotted path, and one in the body to the file", () => {
    const dir = project({
      "src/g.ts": "export function g(): void {}\n",
      "src/n.ts": "import { g } from './g.js';\nexport namespace N {\n  export function f(): void { g(); }\n  g();\n}\n",
    });
    const local = generateTsTruth(dir, ["src/g.ts", "src/n.ts"]);
    // The namespace itself never owns calls: a call directly in its body is file-level.
    expect(edgeKeys(local.calls)).toEqual(["src/n.ts -> src/g.ts#g", "src/n.ts#N.f -> src/g.ts#g"]);
  });

  test("treats a function-valued class field as a method, and a plain field initializer as the class", () => {
    const dir = project({
      "src/g.ts": "export function g(): void {}\nexport class Dep {}\n",
      "src/c.ts":
        "import { g, Dep } from './g.js';\nexport class C {\n" +
        "  dep = new Dep();\n" +
        "  handle = (): void => { g(); };\n" +
        "  run(): void { this.handle(); }\n" +
        "}\n",
    });
    const local = generateTsTruth(dir, ["src/c.ts", "src/g.ts"]);
    expect(edgeKeys(local.calls)).toEqual([
      // `dep = new Dep()` is not a function value, so the class owns it.
      "src/c.ts#C -> src/g.ts#Dep",
      // `handle = () => …` is a method in core, so it owns its own body.
      "src/c.ts#C.handle -> src/g.ts#g",
      // and `this.handle()` resolves to that field as a method.
      "src/c.ts#C.run -> src/c.ts#C.handle",
    ]);
  });

  test("attributes a call in a class static block to the class", () => {
    const dir = project({
      "src/g.ts": "export function g(): void {}\n",
      "src/c.ts": "import { g } from './g.js';\nexport class C {\n  static {\n    g();\n  }\n}\n",
    });
    const local = generateTsTruth(dir, ["src/c.ts", "src/g.ts"]);
    expect(edgeKeys(local.calls)).toEqual(["src/c.ts#C -> src/g.ts#g"]);
  });

  test("resolves a call to an abstract method declared on the class", () => {
    const dir = project({
      "src/base.ts": "export abstract class Base {\n  abstract m(): void;\n}\n",
      "src/use.ts": "import type { Base } from './base.js';\nexport function use(b: Base): void { b.m(); }\n",
    });
    const local = generateTsTruth(dir, ["src/base.ts", "src/use.ts"]);
    expect(edgeKeys(local.calls)).toEqual(["src/use.ts#use -> src/base.ts#Base.m"]);
  });

  test("records `type X = import('./mod').Foo` as an import edge", () => {
    const dir = project({
      "src/mod.ts": "export interface Foo {\n  a: number;\n}\n",
      "src/use.ts": "export type X = import('./mod.js').Foo;\nexport type W = typeof import('./mod.js');\n",
    });
    const local = generateTsTruth(dir, ["src/mod.ts", "src/use.ts"]);
    expect(edgeKeys(local.imports)).toEqual(["src/use.ts -> src/mod.ts"]);
    const edge = local.imports[0];
    expect(edge?.kind).toBe("import");
    expect(edge?.symbols).toEqual(["*", "Foo"]);
  });

  test("records `import x = require(...)` and a namespaced declaration path", () => {
    const dir = project(
      {
        "src/ns.ts": "export namespace Deep {\n  export function fn(): void {}\n}\n",
        "src/use.ts": "import ns = require('./ns');\nexport function use(): void { ns.Deep.fn(); }\n",
      },
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "CommonJS", moduleResolution: "Node10", esModuleInterop: true },
      }),
    );
    const local = generateTsTruth(dir, ["src/ns.ts", "src/use.ts"]);
    expect(edgeKeys(local.imports)).toEqual(["src/use.ts -> src/ns.ts"]);
    expect(edgeKeys(local.calls)).toEqual(["src/use.ts#use -> src/ns.ts#Deep.fn"]);
  });

  test("records a top-level `require()` call as an import edge", () => {
    const dir = project(
      {
        "src/lib.ts": "export const v = 1;\n",
        "src/entry.ts":
          "declare function require(id: string): unknown;\nconst lib = require('./lib');\nexport default lib;\n",
      },
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "CommonJS", moduleResolution: "Node10" },
      }),
    );
    const local = generateTsTruth(dir, ["src/entry.ts", "src/lib.ts"]);
    expect(edgeKeys(local.imports)).toEqual(["src/entry.ts -> src/lib.ts"]);
  });

  test("works with no tsconfig.json at the root (bundler fallback options)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-truth-"));
    dirs.push(dir);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "b.ts"), "export function b(): void {}\n");
    writeFileSync(path.join(dir, "src", "a.ts"), "import { b } from './b';\nb();\n");
    const local = generateTsTruth(dir, ["src/a.ts", "src/b.ts"]);
    expect(edgeKeys(local.imports)).toEqual(["src/a.ts -> src/b.ts"]);
    expect(edgeKeys(local.calls)).toEqual(["src/a.ts -> src/b.ts#b"]);
  });

  test("detects a three-file cycle", () => {
    const dir = project({
      "src/a.ts": "import './b.js';\nexport const a = 1;\n",
      "src/b.ts": "import './c.js';\nexport const b = 1;\n",
      "src/c.ts": "import './a.js';\nexport const c = 1;\n",
      "src/lonely.ts": "export const lonely = 1;\n",
    });
    const local = generateTsTruth(dir, ["src/a.ts", "src/b.ts", "src/c.ts", "src/lonely.ts"]);
    expect(local.cycles).toEqual([["src/a.ts", "src/b.ts", "src/c.ts"]]);
  });

  test("reports `export =` as a default export, not the exported value's static members", () => {
    const dir = project(
      {
        "src/thing.ts": "class Thing {\n  run(): void {}\n}\nexport = Thing;\n",
        "src/use.ts": "import Thing = require('./thing');\nexport function use(): void { new Thing().run(); }\n",
      },
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "CommonJS", moduleResolution: "Node10", esModuleInterop: true },
      }),
    );
    const local = generateTsTruth(dir, ["src/thing.ts", "src/use.ts"]);
    // `checker.getExportsOfModule` follows the `export =` into the class and lists its
    // statics ("prototype"); greplost's export vocabulary has no such name.
    expect(local.exports["src/thing.ts"]).toEqual(["default"]);
    expect(local.exports["src/use.ts"]).toEqual(["use"]);
    expect(edgeKeys(local.calls)).toEqual([
      "src/use.ts#use -> src/thing.ts#Thing",
      "src/use.ts#use -> src/thing.ts#Thing.run",
    ]);
  });

  test("resolves files reached through a symlinked repo root", () => {
    const dir = project({
      "src/a.ts": "import { b } from './b.js';\nexport const a = b();\n",
      "src/b.ts": "export function b(): number { return 1; }\n",
    });
    const link = `${dir}-link`;
    symlinkSync(dir, link, "dir");
    dirs.push(link);
    const local = generateTsTruth(link, ["src/a.ts", "src/b.ts"]);
    expect(edgeKeys(local.imports)).toEqual(["src/a.ts -> src/b.ts"]);
    expect(edgeKeys(local.calls)).toEqual(["src/a.ts -> src/b.ts#b"]);
  });

  test("reports semantic diagnostics only when asked, and says so when it has not", () => {
    // A full semantic check costs more than the truth set itself, so it is opt-in
    // (`structural --diagnostics` / GREPLOST_BENCH_DIAGNOSTICS=1). The stderr line must
    // never let a reader mistake "not checked" for "clean".
    const dir = project({
      "src/a.ts": "import { b } from './b.js';\nexport const a = b();\n",
      "src/b.ts": "export function b(): number { return 1; }\n",
    });
    const lines: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]): void => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      generateTsTruth(dir, ["src/a.ts", "src/b.ts"]);
      generateTsTruth(dir, ["src/a.ts", "src/b.ts"], { diagnostics: true });
    } finally {
      console.error = realError;
    }
    expect(lines[0]).toBe(
      "truth-ts: 2 files, 0 tsconfig errors (semantic diagnostics off: --diagnostics or GREPLOST_BENCH_DIAGNOSTICS=1 to check them)",
    );
    expect(lines[1]).toMatch(/^truth-ts: 2 files, 0 tsconfig errors, \d+ semantic diagnostics$/);
  });

  test("the diagnostics flag never changes the truth set", () => {
    const dir = project({
      "src/a.ts": "import { b } from './b.js';\nexport const a = b();\n",
      "src/b.ts": "export function b(): number { return 1; }\n",
    });
    const off = generateTsTruth(dir, ["src/a.ts", "src/b.ts"], { diagnostics: false });
    const on = generateTsTruth(dir, ["src/a.ts", "src/b.ts"], { diagnostics: true });
    expect(stableStringify(on, 2)).toBe(stableStringify(off, 2));
  });

  test("ignores program files that are not in the given list", () => {
    const dir = project({
      "src/a.ts": "import { b } from './b.js';\nexport const a = b;\n",
      "src/b.ts": "export const b = 1;\n",
      "src/c.ts": "import { a } from './a.js';\nexport const c = a;\n",
    });
    // c.ts is deliberately excluded from the list; nothing about it may appear.
    const local = generateTsTruth(dir, ["src/a.ts", "src/b.ts"]);
    expect(Object.keys(local.exports)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(local.imports.every((e) => !e.from.includes("c.ts") && !e.to.includes("c.ts"))).toBe(true);
  });
});

/**
 * The end-to-end Eval 1 assertion the bench spec calls for: `structural --fixture --gate`
 * exits 0. This runs the suite in process, so it needs `buildSnapshot` from
 * `@greplost/core` (leaf 1.1.5) and is red until that leaf lands.
 */
describe("structural gate", () => {
  test("structural --fixture --gate passes on fixtures/tiny-ts", async () => {
    const results = mkdtempSync(path.join(tmpdir(), "greplost-gate-"));
    const previous = process.env["GREPLOST_BENCH_RESULTS_DIR"];
    process.env["GREPLOST_BENCH_RESULTS_DIR"] = results;

    const stdout: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]): void => {
      stdout.push(args.map((arg) => String(arg)).join(" "));
    };

    let code: number;
    try {
      code = await run(["--fixture", "--gate"]);
    } finally {
      console.log = realLog;
      if (previous === undefined) delete process.env["GREPLOST_BENCH_RESULTS_DIR"];
      else process.env["GREPLOST_BENCH_RESULTS_DIR"] = previous;
      rmSync(results, { recursive: true, force: true });
    }

    expect(stdout[stdout.length - 1]).toBe("structural: GATE PASS");
    expect(code).toBe(0);
  });
});
