import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { CallEdge, Declaration, ImportEdge } from "../src/schema.ts";
import { symbolId } from "../src/schema.ts";
import { readStructure } from "../src/serialize/index.ts";
import { callersOf, findSymbols, importersOf } from "../src/graph/query.ts";

// The query layer works over a committed `.greplost/`-shaped directory, never
// over source: the golden tiny-ts artifacts are exactly that shape, so these
// tests exercise the same path the CLI takes.
const GOLDEN_DIR = fileURLToPath(new URL("./golden/tiny-ts", import.meta.url));

const structure = readStructure(GOLDEN_DIR);
if (structure === null) {
  throw new Error(
    `greplost: golden structure missing at ${GOLDEN_DIR} (regenerate with GREPLOST_UPDATE_GOLDEN=1 bun test packages/core/test/build.test.ts)`,
  );
}
const { calls, imports, symbols } = structure;

const CONFIG = "apps/worker/src/config.ts";
const MAIN = "apps/worker/src/main.ts";
const ADAPTERS_INDEX = "packages/adapters/src/index.ts";
const MEMORY = "packages/adapters/src/memory.ts";
const SQS = "packages/adapters/src/sqs.ts";
const BUS = "packages/core/src/bus.ts";
const CORE_INDEX = "packages/core/src/index.ts";
const REGISTRY = "packages/core/src/registry.ts";
const RETRY = "packages/core/src/retry.ts";

/** A hand-built declaration set: precedence needs names the fixture does not have. */
function decl(file: string, name: string, span: [number, number]): Declaration {
  return {
    id: symbolId(file, name),
    file,
    name,
    kind: "function",
    signature: `function ${name}()`,
    exported: true,
    span,
  };
}

describe("query", () => {
  test("the golden structure loaded", () => {
    expect(symbols).toHaveLength(31);
    expect(imports).toHaveLength(22);
    expect(calls).toHaveLength(12);
  });

  // -- findSymbols ---------------------------------------------------------

  test("findSymbols matches an exact node id", () => {
    expect(findSymbols(symbols, `${RETRY}#retry`).map((d) => d.id)).toEqual([`${RETRY}#retry`]);
    expect(findSymbols(symbols, `${REGISTRY}#Registry.publishAll`).map((d) => d.id)).toEqual([
      `${REGISTRY}#Registry.publishAll`,
    ]);
  });

  test("findSymbols matches an exact symbol path", () => {
    expect(findSymbols(symbols, "retry").map((d) => d.id)).toEqual([`${RETRY}#retry`]);
    expect(findSymbols(symbols, "Registry.publishAll").map((d) => d.id)).toEqual([
      `${REGISTRY}#Registry.publishAll`,
    ]);
  });

  test("findSymbols falls back to a name-suffix match on a path boundary", () => {
    expect(findSymbols(symbols, "publish").map((d) => d.id)).toEqual([
      `${MEMORY}#MemoryAdapter.publish`,
      `${SQS}#SqsAdapter.publish`,
    ]);
    expect(findSymbols(symbols, "poll").map((d) => d.id)).toEqual([
      `${MEMORY}#MemoryAdapter.poll`,
      `${SQS}#SqsAdapter.poll`,
    ]);
  });

  test("findSymbols never matches a partial name segment", () => {
    // "ublish" is a suffix of "publish" but not of a symbol-path segment.
    expect(findSymbols(symbols, "ublish")).toEqual([]);
    expect(findSymbols(symbols, "Adapter")).toEqual([]);
    expect(findSymbols(symbols, "")).toEqual([]);
    expect(findSymbols(symbols, "nothing-here")).toEqual([]);
  });

  test("findSymbols anchors the suffix tier on the symbol name, never on the id", () => {
    // The id ends in "...src/retry.ts#retry", so a needle that is a suffix of
    // the *path* must not match: only `name` is searched.
    const set = [decl("packages/core/src/retry.ts", "retry", [7, 18])];
    expect(findSymbols(set, "retry.ts#retry")).toEqual([]);
    expect(findSymbols(set, "src/retry.ts#retry")).toEqual([]);
    expect(findSymbols(symbols, "core/src/retry.ts#retry")).toEqual([]);
    // A member still matches through its name.
    expect(findSymbols(symbols, "publishAll").map((d) => d.id)).toEqual([
      `${REGISTRY}#Registry.publishAll`,
    ]);
  });

  test("findSymbols prefers an exact id, then an exact path, then a suffix", () => {
    const set = [
      decl("a.ts", "foo", [10, 12]),
      decl("a.ts", "Bar.foo", [20, 22]),
      decl("b.ts", "foo", [1, 3]),
      decl("b.ts", "Baz.foo", [5, 7]),
    ];
    expect(findSymbols(set, "a.ts#Bar.foo").map((d) => d.id)).toEqual(["a.ts#Bar.foo"]);
    expect(findSymbols(set, "Bar.foo").map((d) => d.id)).toEqual(["a.ts#Bar.foo"]);
    // An exact symbol path wins outright: `Bar.foo` and `Baz.foo` are not offered.
    expect(findSymbols(set, "foo").map((d) => d.id)).toEqual(["a.ts#foo", "b.ts#foo"]);
  });

  test("findSymbols sorts with compareDeclarations", () => {
    const set = [
      decl("b.ts", "Two.hit", [1, 2]),
      decl("a.ts", "Late.hit", [90, 91]),
      decl("a.ts", "Early.hit", [3, 4]),
    ];
    expect(findSymbols(set, "hit").map((d) => d.id)).toEqual([
      "a.ts#Early.hit",
      "a.ts#Late.hit",
      "b.ts#Two.hit",
    ]);
  });

  test("findSymbols does not mutate or alias its input", () => {
    const set = [decl("b.ts", "x", [1, 2]), decl("a.ts", "x", [1, 2])];
    const before = set.map((d) => d.id);
    const found = findSymbols(set, "x");
    expect(set.map((d) => d.id)).toEqual(before);
    expect(found).not.toBe(set);
  });

  // -- importersOf ---------------------------------------------------------

  test("importersOf lists the repo files importing a file, sorted and unique", () => {
    expect(importersOf(imports, RETRY)).toEqual([CORE_INDEX, REGISTRY]);
    // memory.ts and sqs.ts each carry two edges to the core index; both collapse.
    expect(importersOf(imports, CORE_INDEX)).toEqual([MAIN, MEMORY, SQS]);
    expect(importersOf(imports, CONFIG)).toEqual([MAIN]);
  });

  test("importersOf counts re-export edges", () => {
    expect(importersOf(imports, SQS)).toEqual([ADAPTERS_INDEX]);
    expect(importersOf(imports, REGISTRY)).toEqual([CORE_INDEX]);
  });

  test("importersOf is empty for an entry point and for an unknown file", () => {
    expect(importersOf(imports, MAIN)).toEqual([]);
    expect(importersOf(imports, "packages/core/src/nope.ts")).toEqual([]);
    expect(importersOf([], RETRY)).toEqual([]);
  });

  test("importersOf ignores anything that is not an import or re-export", () => {
    const mixed = [
      { from: "x.ts", to: "y.ts", kind: "call", confidence: "high" } as unknown as ImportEdge,
      { from: "z.ts", to: "y.ts", kind: "import", symbols: [], confidence: "high", specifier: "./y", importKind: "static" } as ImportEdge,
    ];
    expect(importersOf(mixed, "y.ts")).toEqual(["z.ts"]);
  });

  // -- callersOf -----------------------------------------------------------

  test("callersOf lists the callers of a symbol, sorted and unique", () => {
    expect(callersOf(calls, `${RETRY}#retry`)).toEqual([
      `${SQS}#SqsAdapter.publish`,
      `${REGISTRY}#Registry.publishAll`,
    ]);
    expect(callersOf(calls, `${BUS}#Bus`)).toEqual([
      "packages/core/src/events.ts#createBus",
      `${REGISTRY}#Registry`,
    ]);
  });

  test("callersOf reports a file id for a call from top-level code", () => {
    expect(callersOf(calls, `${MAIN}#main`)).toEqual([MAIN]);
  });

  test("callersOf is empty for a symbol nobody calls", () => {
    expect(callersOf(calls, `${RETRY}#DEFAULT_ATTEMPTS`)).toEqual([]);
    expect(callersOf(calls, "packages/core/src/nope.ts#gone")).toEqual([]);
    expect(callersOf([], `${RETRY}#retry`)).toEqual([]);
  });

  test("callersOf dedupes repeated call sites", () => {
    const repeated: CallEdge[] = [
      { from: "b.ts#one", to: "a.ts#t", kind: "call", confidence: "high" },
      { from: "a.ts#two", to: "a.ts#t", kind: "call", confidence: "med" },
      { from: "b.ts#one", to: "a.ts#t", kind: "call", confidence: "med" },
    ];
    expect(callersOf(repeated, "a.ts#t")).toEqual(["a.ts#two", "b.ts#one"]);
  });
});
