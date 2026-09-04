import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createParser, disposeSpareParser, grammarDir } from "../src/parser.ts";
import type { ParserHandle } from "../src/parser.ts";
import { extractFile } from "../src/extract/index.ts";
import { extractTs } from "../src/extract/ts.ts";
import type { Declaration, FileRecord, Lang } from "../src/schema.ts";
import { stableStringify } from "../src/schema.ts";

const ZERO_SHA = "0".repeat(64);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TINY_TS = join(REPO_ROOT, "fixtures/tiny-ts");

let parser: ParserHandle;

beforeAll(async () => {
  parser = await createParser();
});

function extract(source: string, lang: Lang = "ts", path = "src/a.ts"): FileRecord {
  return extractFile({ path, lang, source, sha256: ZERO_SHA }, parser);
}

function shape(record: FileRecord): Array<[string, string, boolean]> {
  return record.decls.map((d) => [d.name, d.kind, d.exported]);
}

function decl(record: FileRecord, name: string): Declaration {
  const found = record.decls.find((d) => d.name === name);
  if (!found) throw new Error(`no declaration named ${name} in [${record.decls.map((d) => d.name).join(", ")}]`);
  return found;
}

function tinyFile(rel: string): FileRecord {
  const source = readFileSync(join(TINY_TS, rel), "utf8");
  return extractFile({ path: rel, lang: "ts", source, sha256: ZERO_SHA }, parser);
}

describe("parser", () => {
  test("grammarDir resolves to the vendored grammars", () => {
    const dir = grammarDir();
    const files = readdirSync(dir);
    expect(files).toContain("web-tree-sitter.wasm");
    expect(files).toContain("tree-sitter-typescript.wasm");
    expect(files).toContain("tree-sitter-tsx.wasm");
    expect(files).toContain("tree-sitter-go.wasm");
  });

  test("GREPLOST_GRAMMAR_DIR overrides the grammar location", () => {
    const previous = process.env["GREPLOST_GRAMMAR_DIR"];
    try {
      process.env["GREPLOST_GRAMMAR_DIR"] = "/custom/grammars";
      expect(grammarDir()).toBe("/custom/grammars");
      process.env["GREPLOST_GRAMMAR_DIR"] = "";
      expect(grammarDir()).toBe(fileURLToPath(new URL("../src/../grammars", import.meta.url)));
    } finally {
      if (previous === undefined) delete process.env["GREPLOST_GRAMMAR_DIR"];
      else process.env["GREPLOST_GRAMMAR_DIR"] = previous;
    }
  });

  test("the typescript grammar parses ts and js sources", () => {
    const ts = parser.parse("const a: number = 1;\n", "ts");
    expect(ts.rootNode.type).toBe("program");
    expect(ts.rootNode.hasError).toBe(false);
    const js = parser.parse("module.exports = 1;\n", "js");
    expect(js.rootNode.type).toBe("program");
    expect(js.rootNode.hasError).toBe(false);
  });

  test("the tsx grammar parses tsx and jsx sources", () => {
    const tsx = parser.parse("const el = <div a={1}>x</div>;\n", "tsx");
    expect(tsx.rootNode.type).toBe("program");
    expect(tsx.rootNode.hasError).toBe(false);
    expect(tsx.rootNode.descendantsOfType("jsx_element").length).toBe(1);
    const jsx = parser.parse("const el = <Panel />;\n", "jsx");
    expect(jsx.rootNode.hasError).toBe(false);
  });

  test("the go grammar loads and parses", () => {
    const go = parser.parse('package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("hi") }\n', "go");
    expect(go.rootNode.type).toBe("source_file");
    expect(go.rootNode.hasError).toBe(false);
  });

  test("a second handle reuses the compiled grammars", async () => {
    const other = await createParser();
    const mine = parser.parse("export const x = 1;\n", "ts");
    const theirs = other.parse("export const x = 1;\n", "ts");
    // Identical Language object: the wasm was compiled once and cached for the process.
    expect(theirs.language).toBe(mine.language);
    expect(theirs.rootNode.hasError).toBe(false);
    expect(other.parse("const el = <p />;\n", "tsx").language).not.toBe(mine.language);
  });

  test("switching languages on one handle keeps working", () => {
    expect(parser.parse("const a = 1;\n", "ts").rootNode.hasError).toBe(false);
    expect(parser.parse("const b = <p />;\n", "tsx").rootNode.hasError).toBe(false);
    expect(parser.parse("package main\n", "go").rootNode.hasError).toBe(false);
    expect(parser.parse("const c = 1;\n", "ts").rootNode.hasError).toBe(false);
  });

  test("extractFile dispatches go to the go extractor (leaf 1.8)", () => {
    const record = extract("package main\n\nfunc main() {}\n", "go", "main.go");
    expect(record.lang).toBe("go");
    expect(record.decls.map((d) => d.name)).toEqual(["main"]);
  });

  test("the spare parser recovery uses can be released and rebuilt", () => {
    // A source the grammar cannot read, so extraction goes through `reparse`.
    const broken = ["export interface I {", "  <T = 1>(a: T): T", "  <T = 2>(): T", "}", "export type Kept = string;", ""].join(
      "\n",
    );
    const before = extract(broken);
    disposeSpareParser();
    const after = extract(broken);
    expect(stableStringify(after, 2)).toBe(stableStringify(before, 2));
    expect(after.decls.map((d) => d.name)).toContain("Kept");
    // Releasing twice is a no-op, and extraction still works afterwards.
    disposeSpareParser();
    disposeSpareParser();
    expect(extract(broken).decls.map((d) => d.name)).toContain("Kept");
  });

  test("extractFile refuses a language whose extractor is not implemented", () => {
    // Schema 2 named every language up front and gave each a module, so the "no extractor"
    // branch is gone: an unimplemented language now fails in its own module, by name, with
    // the leaf that owns it (build-2 seam, leaf 2.0).
    // `python` was the example here until leaf 2.1 implemented it; `java` is the next
    // still-stubbed one (leaf 2.5, wave 2). Each language leaf moves this to the next stub.
    expect(() => extract("x\n", "java" as Lang, "Main.java")).toThrow(
      /greplost: the java extractor is not implemented yet \(Main\.java\); see build-2 leaf 2\.5/,
    );
  });

  test("extractFile counts lines and copies the file identity", () => {
    const record = extract("const a = 1;\nconst b = 2;\n", "ts", "src/x.ts");
    expect(record.path).toBe("src/x.ts");
    expect(record.lang).toBe("ts");
    expect(record.sha256).toBe(ZERO_SHA);
    expect(record.loc).toBe(2);
    expect(extract("", "ts").loc).toBe(0);
    expect(extract("a", "ts").loc).toBe(1);
    expect(extract("a\nb", "ts").loc).toBe(2);
    expect(extract("a\n\n", "ts").loc).toBe(2);
  });

  test("extractTs can be driven directly with a tree", () => {
    const source = "export function f() {}\n";
    const tree = parser.parse(source, "ts");
    const parts = extractTs("src/a.ts", "ts", source, tree);
    expect(parts.decls.map((d) => d.id)).toEqual(["src/a.ts#f"]);
    expect(parts.imports).toEqual([]);
    expect(parts.exports).toEqual([{ name: "f", kind: "named" }]);
    expect(parts.calls).toEqual([]);
  });
});

describe("declarations", () => {
  test("functions, generators and async functions", () => {
    const r = extract("export function a() {}\nexport async function b() {}\nfunction* c() {}\n");
    expect(shape(r)).toEqual([
      ["a", "function", true],
      ["b", "function", true],
      ["c", "function", false],
    ]);
    expect(decl(r, "a").id).toBe("src/a.ts#a");
    expect(decl(r, "a").file).toBe("src/a.ts");
    expect(decl(r, "a").parent).toBeUndefined();
  });

  test("classes carry their methods, constructors, accessors and private members", () => {
    const r = extract(
      [
        "export class C {",
        "  field = 1;",
        "  constructor(private x: number) {}",
        "  static s() {}",
        "  get g() { return 1; }",
        "  set g(v: number) {}",
        "  #p() {}",
        "  async *m() {}",
        "}",
      ].join("\n"),
    );
    expect(shape(r)).toEqual([
      ["C", "class", true],
      ["C.constructor", "method", true],
      ["C.s", "method", true],
      ["C.g", "method", true],
      ["C.#p", "method", true],
      ["C.m", "method", true],
    ]);
    expect(decl(r, "C.m").parent).toBe("C");
    expect(decl(r, "C.m").id).toBe("src/a.ts#C.m");
    expect(decl(r, "C.g").span).toEqual([5, 5]);
  });

  test("abstract and ambient method signatures are methods", () => {
    const r = extract("export abstract class A {\n  abstract m(): void;\n  n() {}\n}\ndeclare class D {\n  q(): void;\n}\n");
    expect(shape(r)).toEqual([
      ["A", "class", true],
      ["A.m", "method", true],
      ["A.n", "method", true],
      ["D", "class", false],
      ["D.q", "method", false],
    ]);
    expect(decl(r, "A.m").signature).toBe("abstract m(): void");
    expect(decl(r, "A.m").parent).toBe("A");
    expect(decl(r, "D.q").signature).toBe("q(): void");
  });

  test("class fields holding a function are methods, data fields are not", () => {
    const r = extract(
      [
        "export class C {",
        "  handle = () => {};",
        "  static ready = function () {};",
        "  #priv = async () => {};",
        "  data = 1;",
        "}",
      ].join("\n"),
    );
    expect(shape(r)).toEqual([
      ["C", "class", true],
      ["C.handle", "method", true],
      ["C.ready", "method", true],
      ["C.#priv", "method", true],
    ]);
    expect(decl(r, "C.handle").signature).toBe("handle = () =>");
    expect(decl(r, "C.ready").signature).toBe("static ready = function ()");
    expect(decl(r, "C.handle").parent).toBe("C");
    expect(decl(r, "C.handle").span).toEqual([2, 2]);
  });

  test("methods with computed or literal names are skipped", () => {
    const r = extract('class C {\n  ["a" + "b"]() {}\n  1() {}\n  ok() {}\n}\n');
    expect(shape(r)).toEqual([
      ["C", "class", false],
      ["C.ok", "method", false],
    ]);
  });

  test("interfaces, type aliases and enums", () => {
    const r = extract("export interface I { a: string }\ntype T = 1 | 2;\nexport enum E { A }\n");
    expect(shape(r)).toEqual([
      ["I", "interface", true],
      ["T", "type", false],
      ["E", "enum", true],
    ]);
  });

  test("const, let and var declarators, one entry each, patterns skipped", () => {
    const r = extract("export const a = 1, b = 2;\nlet c;\nvar d = 3;\nconst { e } = obj;\nconst [f] = arr;\n");
    expect(shape(r)).toEqual([
      ["a", "const", true],
      ["b", "const", true],
      ["c", "let", false],
      ["d", "var", false],
    ]);
  });

  test("namespace members are tracked at any depth", () => {
    const r = extract(
      [
        "export namespace N {",
        "  export function f() {}",
        "  const hidden = 1;",
        "  export class K {",
        "    m() {}",
        "  }",
        "  export namespace M {",
        "    export const q = 2;",
        "  }",
        "}",
        "namespace P {",
        "  export function g() {}",
        "}",
      ].join("\n"),
    );
    expect(shape(r)).toEqual([
      ["N", "namespace", true],
      ["N.f", "function", true],
      ["N.hidden", "const", false],
      ["N.K", "class", true],
      ["N.K.m", "method", true],
      ["N.M", "namespace", true],
      ["N.M.q", "const", true],
      ["P", "namespace", false],
      ["P.g", "function", false],
    ]);
    expect(decl(r, "N.f").parent).toBe("N");
    expect(decl(r, "N.K.m").parent).toBe("N.K");
    expect(decl(r, "N.M.q").parent).toBe("N.M");
    expect(decl(r, "N").span).toEqual([1, 10]);
    // The namespace is the only file-level export; its members are not.
    expect(r.exports).toEqual([{ name: "N", kind: "named" }]);
  });

  test("export destructuring declares nothing in v1", () => {
    const r = extract("export const { a } = obj;\n");
    expect(r.decls).toEqual([]);
    expect(r.exports).toEqual([]);
  });

  test("export default keeps a written name and invents one for anonymous forms", () => {
    expect(shape(extract("export default function foo() {}\n"))).toEqual([["foo", "function", true]]);
    expect(shape(extract("export default async function foo() {}\n"))).toEqual([["foo", "function", true]]);
    expect(shape(extract("export default function* g() {}\n"))).toEqual([["g", "function", true]]);
    expect(shape(extract("export default class Named {}\n"))).toEqual([["Named", "class", true]]);
    expect(shape(extract("export default function () {}\n"))).toEqual([["default", "function", true]]);
    expect(shape(extract("export default function* () {}\n"))).toEqual([["default", "function", true]]);
    expect(shape(extract("export default class {}\n"))).toEqual([["default", "class", true]]);
  });

  test("export default of an expression declares nothing", () => {
    expect(extract("export default 42;\n").decls).toEqual([]);
    expect(extract("const v = 1;\nexport default v;\n").decls.map((d) => d.name)).toEqual(["v"]);
    expect(extract("export default () => 1;\n").decls).toEqual([]);
  });

  test("ambient declarations are ordinary declarations", () => {
    const r = extract('declare function d(): void;\nexport declare const c: number;\ndeclare module "x" {}\ndeclare namespace NS {}\n');
    expect(shape(r)).toEqual([
      ["d", "function", false],
      ["c", "const", true],
      ["NS", "namespace", false],
    ]);
  });

  test("overload signatures collapse into the implementation", () => {
    const r = extract(
      [
        "export function over(a: string): void;",
        "export function over(a: number): void;",
        "export function over(a: unknown): void {}",
        "class C {",
        "  m(a: string): void;",
        "  m(a: unknown): void {}",
        "}",
      ].join("\n"),
    );
    expect(r.decls.map((d) => d.name)).toEqual(["over", "C", "C.m"]);
    expect(decl(r, "over").span).toEqual([3, 3]);
    expect(decl(r, "over").signature).toBe("export function over(a: unknown): void");
    expect(decl(r, "C.m").span).toEqual([6, 6]);
  });

  test("tsx files declare components", () => {
    const r = extract(
      'import React from "react";\nexport function Panel() {\n  return <div>x</div>;\n}\nexport default function App() {\n  return <Panel />;\n}\n',
      "tsx",
      "src/a.tsx",
    );
    // The language declarations, and then the `component` nodes the react signal pass adds
    // alongside them (build 2, leaf 2.3): a signal node never replaces a declaration.
    expect(shape(r)).toEqual([
      ["Panel", "function", true],
      ["App", "function", true],
      // A signal node carries the bare node name, exactly as the HCL nodes do (driver ruling
      // 2026-09-04); the kind lives in the id, which is what keeps the two `Panel`s apart.
      ["Panel", "component", false],
      ["App", "component", false],
    ]);
    expect(r.decls.map((d) => d.id)).toEqual([
      "src/a.tsx#Panel",
      "src/a.tsx#App",
      "src/a.tsx#component.Panel",
      "src/a.tsx#component.App",
    ]);
  });

  test("anonymous default classes keep their methods", () => {
    const r = extract("export default class {\n  m() {}\n}\n");
    expect(shape(r)).toEqual([
      ["default", "class", true],
      ["default.m", "method", true],
    ]);
  });

  test("decorated classes and members are still declarations", () => {
    const r = extract("@Injectable()\nexport class Svc {\n  @log()\n  m(a: number) {}\n}\n");
    expect(shape(r)).toEqual([
      ["Svc", "class", true],
      ["Svc.m", "method", true],
    ]);
    expect(decl(r, "Svc").span).toEqual([1, 5]);
  });

  test("a source with a syntax error extracts what the parser recovers", () => {
    const r = extract("export const ok = 1;\nrun();\nfunction broken( {\n");
    // The broken function lands in an ERROR node and declares nothing; the
    // statements the parser did recover are extracted normally.
    expect(shape(r)).toEqual([["ok", "const", true]]);
    expect(r.calls).toEqual([{ caller: "", callee: "run", line: 2 }]);
  });

  test("declarations are recovered from a region the grammar cannot parse", () => {
    // tree-sitter-typescript 0.23 cannot read a call signature with defaulted type
    // parameters (hono's `CreateHandlersInterface`): the interface and everything
    // after it collapse into one top-level ERROR node. Recovery re-reads the region.
    const source = [
      "export interface CreateHandlersInterface<E extends Env, P extends string> {",
      "  <I extends Input = {}, R extends HandlerResponse<any> = any, E2 extends Env = E>(",
      "    handler1: H<E2, P, I, R>",
      "  ): [H<E2, P, I, R>]",
      "",
      "  // handler x2",
      "  <",
      "    I extends Input = {},",
      "    I2 extends Input = I,",
      "    R extends HandlerResponse<any> = any,",
      "    R2 extends HandlerResponse<any> = any,",
      "    E2 extends Env = E,",
      "    E3 extends Env = IntersectNonAnyTypes<[E, E2]>,",
      "  >(",
      "    handler1: H<E2, P, I, R>,",
      "    handler2: H<E3, P, I2, R2>",
      "  ): [H<E2, P, I, R>, H<E3, P, I2, R2>]",
      "}",
      "export class Late {",
      "  m() {",
      "    go();",
      "  }",
      "}",
      "export const after = () => new Late();",
      "export type Tail = string;",
      "",
    ].join("\n");
    const tree = parser.parse(source, "ts");
    expect(tree.rootNode.hasError).toBe(true);

    const r = extract(source);
    expect(r.decls.map((d) => [d.name, d.kind, d.span])).toEqual([
      ["CreateHandlersInterface", "interface", [1, 6]],
      ["Late", "class", [19, 23]],
      ["Late.m", "method", [20, 22]],
      ["after", "const", [24, 24]],
      ["Tail", "type", [25, 25]],
    ]);
    expect(r.exports.map((e) => e.name)).toEqual(["CreateHandlersInterface", "Late", "after", "Tail"]);
    // Recovered declarations are ordinary declarations: their calls are attributed too.
    expect(r.calls).toEqual([
      { caller: "Late.m", callee: "go", line: 21 },
      { caller: "after", callee: "new Late", line: 24 },
    ]);
  });

  test("recovery never emits a declaration twice", () => {
    const source = [
      "export interface I {",
      "  <T = 1>(a: T): T",
      "  <T = 2>(): T",
      "}",
      "export type Kept = string;",
      "",
    ].join("\n");
    const r = extract(source);
    const ids = r.decls.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("src/a.ts#Kept");
    expect(r.exports.filter((e) => e.name === "Kept")).toHaveLength(1);
  });

  test("a shebang line shifts nothing", () => {
    const r = extract("#!/usr/bin/env node\nexport function main() {}\n");
    expect(shape(r)).toEqual([["main", "function", true]]);
    expect(decl(r, "main").span).toEqual([2, 2]);
  });

  test("declarations appear in document order", () => {
    const r = extract("const z = 1;\nfunction a() {}\nclass B {}\n");
    expect(r.decls.map((d) => d.span[0])).toEqual([1, 2, 3]);
  });
});

describe("imports", () => {
  test("static, default, namespace and side-effect imports", () => {
    const r = extract(
      [
        'import def, { n1, n2 as n3 } from "m1";',
        'import * as star from "m2";',
        'import "m3";',
        'import def2 from "m4";',
      ].join("\n"),
    );
    expect(r.imports).toEqual([
      {
        specifier: "m1",
        kind: "static",
        symbols: [
          { name: "default", local: "def" },
          { name: "n1", local: "n1" },
          { name: "n2", local: "n3" },
        ],
        reexport: false,
        line: 1,
      },
      { specifier: "m2", kind: "static", symbols: [{ name: "*", local: "star" }], reexport: false, line: 2 },
      { specifier: "m3", kind: "side-effect", symbols: [], reexport: false, line: 3 },
      { specifier: "m4", kind: "static", symbols: [{ name: "default", local: "def2" }], reexport: false, line: 4 },
    ]);
  });

  test("type-only imports are kind type, inline type modifiers are not", () => {
    const r = extract('import type { A } from "m1";\nimport type B from "m2";\nimport { type C, d } from "m3";\n');
    expect(r.imports.map((i) => [i.specifier, i.kind])).toEqual([
      ["m1", "type"],
      ["m2", "type"],
      ["m3", "static"],
    ]);
    expect(r.imports[2]?.symbols).toEqual([
      { name: "C", local: "C" },
      { name: "d", local: "d" },
    ]);
  });

  test("re-exporting statements produce reexport records", () => {
    const r = extract(
      [
        'export * from "m1";',
        'export * as ns from "m2";',
        'export { a as b } from "m3";',
        'export type { T } from "m4";',
        'export { default as D } from "m5";',
      ].join("\n"),
    );
    expect(r.imports).toEqual([
      { specifier: "m1", kind: "static", symbols: [{ name: "*", local: "*" }], reexport: true, line: 1 },
      { specifier: "m2", kind: "static", symbols: [{ name: "*", local: "ns" }], reexport: true, line: 2 },
      { specifier: "m3", kind: "static", symbols: [{ name: "a", local: "b" }], reexport: true, line: 3 },
      { specifier: "m4", kind: "type", symbols: [{ name: "T", local: "T" }], reexport: true, line: 4 },
      { specifier: "m5", kind: "static", symbols: [{ name: "default", local: "D" }], reexport: true, line: 5 },
    ]);
  });

  test("dynamic import destructuring, binding and bare forms", () => {
    const r = extract(
      [
        'const { a, b: c } = await import("m1");',
        'const m = await import("m2");',
        'void import("m3");',
        "async function f() {",
        '  const { d } = await import("m4");',
        "}",
        "const bad = await import(name);",
      ].join("\n"),
    );
    expect(r.imports).toEqual([
      {
        specifier: "m1",
        kind: "dynamic",
        symbols: [
          { name: "a", local: "a" },
          { name: "b", local: "c" },
        ],
        reexport: false,
        line: 1,
      },
      { specifier: "m2", kind: "dynamic", symbols: [{ name: "*", local: "m" }], reexport: false, line: 2 },
      { specifier: "m3", kind: "dynamic", symbols: [{ name: "*", local: "*" }], reexport: false, line: 3 },
      { specifier: "m4", kind: "dynamic", symbols: [{ name: "d", local: "d" }], reexport: false, line: 5 },
    ]);
  });

  test("require and import-equals-require", () => {
    const r = extract(
      [
        'const m = require("m1");',
        'const { a } = require("m2");',
        'require("m3");',
        'import m4 = require("m4");',
        "const bad = require(name);",
        'use(require("m5"));',
      ].join("\n"),
      "js",
      "src/a.js",
    );
    expect(r.imports).toEqual([
      { specifier: "m1", kind: "static", symbols: [{ name: "*", local: "m" }], reexport: false, line: 1 },
      { specifier: "m2", kind: "static", symbols: [{ name: "a", local: "a" }], reexport: false, line: 2 },
      { specifier: "m3", kind: "side-effect", symbols: [], reexport: false, line: 3 },
      { specifier: "m4", kind: "static", symbols: [{ name: "*", local: "m4" }], reexport: false, line: 4 },
      { specifier: "m5", kind: "static", symbols: [{ name: "*", local: "*" }], reexport: false, line: 6 },
    ]);
  });

  test("import records are ordered by line", () => {
    const r = extract(
      ['import { a } from "m1";', "async function f() {", '  await import("m2");', "}", 'import { b } from "m3";'].join("\n"),
    );
    expect(r.imports.map((i) => [i.line, i.specifier])).toEqual([
      [1, "m1"],
      [3, "m2"],
      [5, "m3"],
    ]);
  });

  test("a type-position import is a type import of the property it reaches", () => {
    const r = extract(
      [
        'type X = import("./mod").Foo;',
        'const p: import("pkg").Bar = q;',
        'let t: typeof import("m");',
        'const real = await import("r");',
      ].join("\n"),
    );
    expect(r.imports).toEqual([
      { specifier: "./mod", kind: "type", symbols: [{ name: "Foo", local: "Foo" }], reexport: false, line: 1 },
      { specifier: "pkg", kind: "type", symbols: [{ name: "Bar", local: "Bar" }], reexport: false, line: 2 },
      { specifier: "m", kind: "type", symbols: [{ name: "*", local: "*" }], reexport: false, line: 3 },
      { specifier: "r", kind: "dynamic", symbols: [{ name: "*", local: "real" }], reexport: false, line: 4 },
    ]);
    // A type reference loads no module, so it is never a call site either.
    expect(r.calls).toEqual([]);
  });

  test("non-literal import specifiers are ignored", () => {
    const r = extract("await import(`m${x}`);\nawait import(name);\n");
    expect(r.imports).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  test("require inside a function is still an import record", () => {
    const r = extract('function f() {\n  const m = require("m1");\n}\n', "js", "src/a.js");
    expect(r.imports).toEqual([
      { specifier: "m1", kind: "static", symbols: [{ name: "*", local: "m" }], reexport: false, line: 2 },
    ]);
  });

  test("string-literal specifier names are unquoted", () => {
    const r = extract('import { "a" as b } from "m";\n');
    expect(r.imports[0]?.symbols).toEqual([{ name: "a", local: "b" }]);
  });

  test("a comment between the keywords does not hide a type-only import", () => {
    const r = extract('import /* c */ type { A } from "m";\n');
    expect(r.imports.map((i) => i.kind)).toEqual(["type"]);
  });

  test("quotes are stripped and empty specifiers survive", () => {
    const r = extract("import 'single';\nimport \"\";\n");
    expect(r.imports.map((i) => i.specifier)).toEqual(["single", ""]);
  });
});

describe("exports", () => {
  test("declarations export one record per declared name", () => {
    const r = extract("export const a = 1, b = 2;\nexport function f() {}\nexport class C { m() {} }\n");
    expect(r.exports).toEqual([
      { name: "a", kind: "named" },
      { name: "b", kind: "named" },
      { name: "f", kind: "named" },
      { name: "C", kind: "named" },
    ]);
  });

  test("export clauses, renames and default aliases", () => {
    const r = extract("const a = 1, b = 2, x = 3;\nexport { a, b as c };\nexport { x as default };\nexport {};\n");
    expect(r.exports).toEqual([
      { name: "a", kind: "named" },
      { name: "c", kind: "named", local: "b" },
      { name: "default", kind: "default", local: "x" },
    ]);
  });

  test("default exports record the local name when there is one", () => {
    expect(extract("export default function foo() {}\n").exports).toEqual([{ name: "default", kind: "default", local: "foo" }]);
    expect(extract("export default class Named {}\n").exports).toEqual([{ name: "default", kind: "default", local: "Named" }]);
    expect(extract("const v = 1;\nexport default v;\n").exports).toEqual([{ name: "default", kind: "default", local: "v" }]);
    expect(extract("export default 42;\n").exports).toEqual([{ name: "default", kind: "default" }]);
    expect(extract("export default class {}\n").exports).toEqual([{ name: "default", kind: "default" }]);
  });

  test("star, star-as and from clauses", () => {
    const r = extract(
      ['export * from "m1";', 'export * as ns from "m2";', 'export { a as b } from "m3";', 'export { default as D } from "m4";', 'export { c } from "m5";'].join(
        "\n",
      ),
    );
    expect(r.exports).toEqual([
      { name: "*", kind: "star", from: "m1" },
      { name: "ns", kind: "named", local: "*", from: "m2" },
      { name: "b", kind: "named", local: "a", from: "m3" },
      { name: "D", kind: "named", local: "default", from: "m4" },
      { name: "c", kind: "named", local: "c", from: "m5" },
    ]);
  });

  test("export equals and CommonJS assignment forms", () => {
    expect(extract("const x = 1;\nexport = x;\n").exports).toEqual([{ name: "default", kind: "default", local: "x" }]);
    const cjs = extract(
      ["module.exports = handler;", "module.exports.foo = function () {};", "exports.bar = 1;", "exports = 2;"].join("\n"),
      "js",
      "src/a.js",
    );
    expect(cjs.exports).toEqual([
      { name: "default", kind: "default", local: "handler" },
      { name: "foo", kind: "named" },
      { name: "bar", kind: "named" },
    ]);
    expect(extract("module.exports = { a: 1 };\n", "js", "src/a.js").exports).toEqual([{ name: "default", kind: "default" }]);
  });

  test("string-literal export names are unquoted", () => {
    expect(extract('const y = 1;\nexport { y as "str" };\n').exports).toEqual([
      { name: "str", kind: "named", local: "y" },
    ]);
  });

  test("a namespace re-export aliased to default is a default export", () => {
    expect(extract('export * as default from "m";\n').exports).toEqual([
      { name: "default", kind: "default", local: "*", from: "m" },
    ]);
  });

  test("nested assignments to exports are not exports", () => {
    const r = extract("function f() {\n  module.exports = 1;\n}\n", "js", "src/a.js");
    expect(r.exports).toEqual([]);
  });
});

describe("call sites", () => {
  test("plain, member, this and constructor callees", () => {
    const r = extract(
      ["name();", "obj.m();", "opt?.m();", "new X();", "new ns.X();", "class C {\n  m() {\n    this.n();\n  }\n}"].join("\n"),
    );
    expect(r.calls.map((c) => c.callee)).toEqual(["name", "obj.m", "opt.m", "new X", "new ns.X", "this.n"]);
    expect(r.calls.map((c) => c.line)).toEqual([1, 2, 3, 4, 5, 8]);
  });

  test("skip rules drop everything that cannot be named", () => {
    const r = extract(
      [
        "a.b.c();",
        "d()();",
        "(e)();",
        "(await p)();",
        "arr[0]();",
        "obj[key]();",
        "class C extends B {\n  m() {\n    super.x();\n  }\n}",
        'const mod = await import("m");',
        'const req = require("m2");',
        "ok();",
      ].join("\n"),
    );
    // `d()()` drops the outer call on a call result but keeps the inner `d()`.
    expect(r.calls.map((c) => c.callee)).toEqual(["d", "ok"]);
  });

  test("caller attribution follows the nearest tracked declaration", () => {
    const r = extract(
      [
        "top();",
        "export function f() {",
        "  inFunction();",
        "  const nested = () => { inNested(); };",
        "}",
        "export const arrow = () => {",
        "  inArrow();",
        "};",
        "export class C {",
        "  field = inField();",
        "  constructor() {",
        "    inCtor();",
        "  }",
        "  m() {",
        "    inMethod();",
        "  }",
        "}",
      ].join("\n"),
    );
    expect(r.calls.map((c) => [c.caller, c.callee])).toEqual([
      ["", "top"],
      ["f", "inFunction"],
      ["f", "inNested"],
      ["arrow", "inArrow"],
      ["C", "inField"],
      ["C.constructor", "inCtor"],
      ["C.m", "inMethod"],
    ]);
  });

  test("a shadowing local binding does not hijack caller attribution", () => {
    const r = extract(
      [
        "export const helper = () => {};",
        "export function f() {",
        "  const helper = () => { inner(); };",
        "  helper();",
        "}",
      ].join("\n"),
    );
    // `inner` keeps `f` as its caller, and the call to the local `helper` is not
    // emitted at all: it resolves to no exported symbol.
    expect(r.calls.map((c) => [c.caller, c.callee])).toEqual([["f", "inner"]]);
  });

  test("a nested function shadowing a top-level name keeps the outer caller", () => {
    const r = extract(
      ["export function g() {}", "export function f() {", "  function g() { inner(); }", "  g();", "}"].join("\n"),
    );
    expect(r.calls.map((c) => [c.caller, c.callee])).toEqual([["f", "inner"]]);
  });

  test("a call to a name bound in the enclosing function is dropped", () => {
    const r = extract(
      [
        'import { raw } from "./raw";',
        "export const createCssContext = ({ id }: { id: string }) => {",
        "  const css = (strings: string[]) => raw(strings, id);",
        "  const cssed = css([]);",
        "  return { css, cssed };",
        "};",
      ].join("\n"),
    );
    // `raw` is imported and resolves; `css` is a local binding and cannot.
    expect(r.calls.map((c) => [c.caller, c.callee])).toEqual([["createCssContext", "raw"]]);
  });

  test("a parameter shadowing an import drops the call, an unshadowed one keeps it", () => {
    const r = extract(
      [
        'import { render } from "./render";',
        "export function draw(render: () => void) {",
        "  render();",
        "}",
        "export function control() {",
        "  render();",
        "}",
      ].join("\n"),
    );
    expect(r.calls).toEqual([{ caller: "control", callee: "render", line: 6 }]);
  });

  test("a local shadowing a top-level function drops the call", () => {
    const r = extract(
      [
        "export function match(method: string): number {",
        "  const match = (m: string) => m.length;",
        "  return match(method);",
        "}",
      ].join("\n"),
    );
    expect(r.calls).toEqual([]);
  });

  test("locals are flattened over the whole enclosing function", () => {
    const r = extract(
      [
        "export function outer() {",
        "  return () => {",
        "    helper();",
        "  };",
        "  function helper() {}",
        "}",
        "export function other() {",
        "  helper();",
        "}",
      ].join("\n"),
    );
    expect(r.calls).toEqual([{ caller: "other", callee: "helper", line: 8 }]);
  });

  test("a locally bound object drops its member calls, `this` never does", () => {
    const r = extract(
      [
        "export class C {",
        "  run(items: string[]) {",
        "    const helper = make();",
        "    helper.go();",
        "    this.go();",
        "    for (const item of items) item.trim();",
        "  }",
        "  go() {}",
        "}",
      ].join("\n"),
    );
    expect(r.calls.map((c) => c.callee)).toEqual(["make", "this.go"]);
  });

  test("a named function expression binds its own name", () => {
    const r = extract(
      ["export function g() {}", "export const run = function g() {", "  g();", "};"].join("\n"),
    );
    // The inner `g` is the expression itself, not the top-level function.
    expect(r.calls).toEqual([]);
  });

  test("a named generator expression binds its own name", () => {
    const r = extract(
      ["export function* g() {}", "export const run = function* g() {", "  g();", "};"].join("\n"),
    );
    expect(r.calls).toEqual([]);
  });

  test("a class expression binds its own name", () => {
    const r = extract(
      [
        "export class Helper {}",
        "export function make() {",
        "  return class Helper {",
        "    build() {",
        "      return new Helper();",
        "    }",
        "  };",
        "}",
      ].join("\n"),
    );
    expect(r.calls).toEqual([]);
  });

  test("a local namespace or enum shadows a top-level one", () => {
    const r = extract(
      [
        "export function f() {",
        "  namespace N {",
        "    export const a = 1;",
        "  }",
        "  enum E {",
        "    A,",
        "  }",
        "  N.go();",
        "  E.valueOf();",
        "  Other.go();",
        "}",
      ].join("\n"),
    );
    expect(r.calls).toEqual([{ caller: "f", callee: "Other.go", line: 10 }]);
  });

  test("a generic arrow initialiser is a caller scope", () => {
    const r = extract(
      [
        "type UseStateType = {",
        "  <T>(initialState: T | (() => T)): [T, U<T>]",
        "  <T = undefined>(): [T | undefined, U<T | undefined>]",
        "}",
        "export const useState: UseStateType = <T>(",
        "  initialState?: T",
        "): [T, U<T>] => {",
        "  update()",
        "  return build(initialState)",
        "}",
      ].join("\n"),
    );
    expect(r.calls).toEqual([
      { caller: "useState", callee: "update", line: 8 },
      { caller: "useState", callee: "build", line: 9 },
    ]);
  });

  test("non-null assertions are erased from callees, casts are not", () => {
    const r = extract("a!.b();\nfoo!();\nthis!.z();\n(x as any).y();\n");
    expect(r.calls.map((c) => c.callee)).toEqual(["a.b", "foo", "this.z"]);
  });

  test("function-valued fields, data fields and static blocks", () => {
    const r = extract(
      [
        "export class C {",
        "  handle = () => { go(); };",
        "  data = compute();",
        "  static { boot(); }",
        "}",
      ].join("\n"),
    );
    expect(r.calls.map((c) => [c.caller, c.callee])).toEqual([
      ["C.handle", "go"],
      ["C", "compute"],
      ["C", "boot"],
    ]);
  });

  test("namespace members attribute calls to their symbol path", () => {
    const r = extract(
      [
        "export namespace N {",
        "  export function f() { deep(); }",
        "  export class K {",
        "    m() { inner(); }",
        "  }",
        "  top();",
        "}",
      ].join("\n"),
    );
    expect(r.calls.map((c) => [c.caller, c.callee])).toEqual([
      ["N.f", "deep"],
      ["N.K.m", "inner"],
      ["", "top"],
    ]);
  });

  test("new without arguments is still a constructor call", () => {
    expect(extract("const x = new Foo;\n").calls).toEqual([{ caller: "", callee: "new Foo", line: 1 }]);
  });

  test("callbacks keep the enclosing declaration as caller", () => {
    const r = extract("export function f() {\n  wrap(() => inner());\n}\n");
    expect(r.calls.map((c) => [c.caller, c.callee])).toEqual([
      ["f", "wrap"],
      ["f", "inner"],
    ]);
  });

  test("calls are recorded in document order with 1-based lines", () => {
    const r = extract("\n\nfirst();\nsecond();\n");
    expect(r.calls).toEqual([
      { caller: "", callee: "first", line: 3 },
      { caller: "", callee: "second", line: 4 },
    ]);
  });

  test("deeply nested sources do not overflow the walker", () => {
    const source = `deep(${"(".repeat(4000)}1${")".repeat(4000)});\n`;
    expect(extract(source).calls.map((c) => c.callee)).toEqual(["deep"]);
  });

  test("jsx bodies still yield calls", () => {
    const r = extract("export function P() {\n  const v = useThing();\n  return <div>{fmt(v)}</div>;\n}\n", "tsx", "src/a.tsx");
    expect(r.calls.map((c) => [c.caller, c.callee])).toEqual([
      ["P", "useThing"],
      ["P", "fmt"],
    ]);
  });
});

describe("signature", () => {
  test("function signatures stop before the body and collapse whitespace", () => {
    const r = extract(
      "export async function retry<T>(\n  fn: () => Promise<T>,\n  opts: RetryOptions = {},\n): Promise<T> {\n  return fn();\n}\n",
    );
    expect(decl(r, "retry").signature).toBe(
      "export async function retry<T>( fn: () => Promise<T>, opts: RetryOptions = {}, ): Promise<T>",
    );
    expect(decl(r, "retry").span).toEqual([1, 6]);
  });

  test("class, interface, enum, namespace and method signatures", () => {
    const r = extract(
      [
        "export class SqsAdapter implements Queue {",
        "  async publish(body: string): Promise<Ack> {",
        "    return ack;",
        "  }",
        "}",
        "export interface SqsConfig {",
        "  queueUrl: string;",
        "}",
        "export enum Priority { Low = 0 }",
        "export namespace NS {}",
      ].join("\n"),
    );
    expect(decl(r, "SqsAdapter").signature).toBe("export class SqsAdapter implements Queue");
    expect(decl(r, "SqsAdapter.publish").signature).toBe("async publish(body: string): Promise<Ack>");
    expect(decl(r, "SqsConfig").signature).toBe("export interface SqsConfig");
    expect(decl(r, "Priority").signature).toBe("export enum Priority");
    expect(decl(r, "NS").signature).toBe("export namespace NS");
  });

  test("type aliases keep their whole declaration without the semicolon", () => {
    const r = extract("export type Ack = { ok: true; id: string } | { ok: false; reason: string };\n");
    expect(decl(r, "Ack").signature).toBe("export type Ack = { ok: true; id: string } | { ok: false; reason: string }");
  });

  test("variables keep their own declarator and cut function bodies", () => {
    const r = extract(
      [
        "export const DEFAULT_ATTEMPTS = 3;",
        "export const a = 1, b = 2;",
        "export const f = (x: number) => x + 1;",
        "const g = function () { return 1; };",
        "let h: number;",
      ].join("\n"),
    );
    expect(decl(r, "DEFAULT_ATTEMPTS").signature).toBe("export const DEFAULT_ATTEMPTS = 3");
    expect(decl(r, "a").signature).toBe("export const a = 1");
    expect(decl(r, "b").signature).toBe("export const b = 2");
    expect(decl(r, "f").signature).toBe("export const f = (x: number) =>");
    expect(decl(r, "g").signature).toBe("const g = function ()");
    expect(decl(r, "h").signature).toBe("let h: number");
  });

  test("ambient and default signatures keep their leading keywords", () => {
    expect(decl(extract("declare function d(): void;\n"), "d").signature).toBe("declare function d(): void");
    expect(decl(extract("export declare const c: number;\n"), "c").signature).toBe("export declare const c: number");
    expect(decl(extract("export default class {}\n"), "default").signature).toBe("export default class");
    expect(decl(extract("export default function () {}\n"), "default").signature).toBe("export default function ()");
  });

  test("signatures longer than 200 characters are clipped with an ellipsis", () => {
    const params = Array.from({ length: 40 }, (_, i) => `p${i}: SomeLongTypeName`).join(", ");
    const source = `export function wide(${params}): void {}\n`;
    const signature = decl(extract(source), "wide").signature;
    expect(signature.length).toBe(200);
    expect(signature.endsWith("…")).toBe(true);
    expect(signature.slice(0, 199)).toBe(`export function wide(${params}): void`.slice(0, 199));
  });

  test("CRLF sources collapse like LF sources", () => {
    const r = extract("export function f(\r\n  a: number,\r\n): void {\r\n  g();\r\n}\r\n");
    expect(decl(r, "f").signature).toBe("export function f( a: number, ): void");
    expect(r.calls).toEqual([{ caller: "f", callee: "g", line: 4 }]);
    expect(r.loc).toBe(5);
  });

  test("decorators are left out of signatures", () => {
    const r = extract("@Injectable({ providedIn: 'root' })\nexport class Svc {\n  @log()\n  m(a: number): void {}\n}\n");
    expect(decl(r, "Svc").signature).toBe("export class Svc");
    expect(decl(r, "Svc.m").signature).toBe("m(a: number): void");
  });

  test("class expression initialisers are cut before their body", () => {
    expect(decl(extract("export const C = class {\n  m() {}\n};\n"), "C").signature).toBe("export const C = class");
  });

  test("spans are 1-based inclusive and cover the export statement", () => {
    const r = extract("\nexport function f(\n  a: number,\n) {\n  return a;\n}\n");
    expect(decl(r, "f").span).toEqual([2, 6]);
  });
});

describe("tiny-ts", () => {
  const files = [
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

  test("the fixture holds exactly 12 typescript files", () => {
    const found = readdirSync(TINY_TS, { recursive: true, encoding: "utf8" })
      .filter((p) => p.endsWith(".ts"))
      .map((p) => p.split("\\").join("/"))
      .sort();
    expect(found).toEqual(files);
  });

  test("every fixture file extracts with the pinned counts", () => {
    const counts = files.map((rel) => {
      const r = tinyFile(rel);
      return [rel, r.decls.length, r.imports.length, r.exports.length, r.calls.length];
    });
    expect(counts).toEqual([
      ["apps/worker/src/config.ts", 2, 0, 2, 0],
      ["apps/worker/src/main.ts", 1, 3, 1, 6],
      ["packages/adapters/src/index.ts", 0, 3, 4, 0],
      ["packages/adapters/src/memory.ts", 3, 2, 1, 1],
      ["packages/adapters/src/sqs.ts", 6, 3, 3, 5],
      ["packages/core/src/bus.ts", 3, 2, 1, 1],
      ["packages/core/src/events.ts", 2, 1, 2, 1],
      ["packages/core/src/index.ts", 0, 4, 7, 0],
      ["packages/core/src/queue.ts", 3, 1, 3, 0],
      ["packages/core/src/registry.ts", 5, 3, 2, 4],
      ["packages/core/src/retry.ts", 3, 0, 3, 0],
      ["packages/core/src/types.ts", 3, 0, 3, 0],
    ]);
  });

  test("the core index re-exports retry, DEFAULT_ATTEMPTS, Priority and a star of registry", () => {
    const r = tinyFile("packages/core/src/index.ts");
    expect(r.imports.every((i) => i.reexport)).toBe(true);
    expect(r.exports).toEqual([
      { name: "*", kind: "star", from: "./registry" },
      { name: "retry", kind: "named", local: "retry", from: "./retry" },
      { name: "DEFAULT_ATTEMPTS", kind: "named", local: "DEFAULT_ATTEMPTS", from: "./retry" },
      { name: "Queue", kind: "named", local: "Queue", from: "./queue" },
      { name: "Ack", kind: "named", local: "Ack", from: "./queue" },
      { name: "Msg", kind: "named", local: "Msg", from: "./queue" },
      { name: "Priority", kind: "named", local: "Priority", from: "./types" },
    ]);
    expect(r.imports.map((i) => [i.specifier, i.kind])).toEqual([
      ["./registry", "static"],
      ["./retry", "static"],
      ["./queue", "type"],
      ["./types", "static"],
    ]);
  });

  test("memory.ts has a dynamic import of @tiny/core binding Priority", () => {
    const r = tinyFile("packages/adapters/src/memory.ts");
    const dynamic = r.imports.filter((i) => i.kind === "dynamic");
    expect(dynamic).toEqual([
      {
        specifier: "@tiny/core",
        kind: "dynamic",
        symbols: [{ name: "Priority", local: "Priority" }],
        reexport: false,
        line: 7,
      },
    ]);
  });

  test("sqs.ts imports an external package and calls retry from publish", () => {
    const r = tinyFile("packages/adapters/src/sqs.ts");
    expect(r.imports.map((i) => i.specifier)).toEqual(["@tiny/core", "@tiny/core", "@aws-sdk/client-sqs"]);
    expect(r.calls).toEqual([
      { caller: "SqsAdapter.constructor", callee: "new SQSClient", line: 14 },
      { caller: "SqsAdapter.publish", callee: "new SendMessageCommand", line: 18 },
      { caller: "SqsAdapter.publish", callee: "retry", line: 19 },
      { caller: "SqsAdapter.poll", callee: "String", line: 25 },
      { caller: "createSqsAdapter", callee: "new SqsAdapter", line: 31 },
    ]);
  });

  test("registry.ts attributes field initialisers to the class and calls to methods", () => {
    const r = tinyFile("packages/core/src/registry.ts");
    expect(r.calls).toEqual([
      { caller: "Registry", callee: "new Map", line: 6 },
      { caller: "Registry", callee: "new Bus", line: 7 },
      { caller: "Registry.publishAll", callee: "retry", line: 17 },
      { caller: "createRegistry", callee: "new Registry", line: 29 },
    ]);
    expect(r.decls.map((d) => d.name)).toEqual([
      "Registry",
      "Registry.register",
      "Registry.publishAll",
      "Registry.get",
      "createRegistry",
    ]);
  });

  test("retry.ts signatures match the schema examples", () => {
    const r = tinyFile("packages/core/src/retry.ts");
    expect(decl(r, "DEFAULT_ATTEMPTS").signature).toBe("export const DEFAULT_ATTEMPTS = 3");
    expect(decl(r, "retry").signature).toBe(
      "export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T>",
    );
    expect(decl(r, "retry").span).toEqual([7, 18]);
  });
});

describe("deterministic", () => {
  const source = readFileSync(join(TINY_TS, "packages/core/src/registry.ts"), "utf8");

  test("extracting the same source twice yields identical output", () => {
    const a = extract(source, "ts", "packages/core/src/registry.ts");
    const b = extract(source, "ts", "packages/core/src/registry.ts");
    expect(stableStringify(a, 2)).toBe(stableStringify(b, 2));
  });

  test("a fresh parser handle yields identical output", async () => {
    const other = await createParser();
    const a = extractFile({ path: "x.ts", lang: "ts", source, sha256: ZERO_SHA }, parser);
    const b = extractFile({ path: "x.ts", lang: "ts", source, sha256: ZERO_SHA }, other);
    expect(stableStringify(b, 2)).toBe(stableStringify(a, 2));
  });

  test("every fixture file is byte-stable across repeated extraction", () => {
    const once = readdirSync(TINY_TS, { recursive: true, encoding: "utf8" })
      .filter((p) => p.endsWith(".ts"))
      .sort()
      .map((rel) => stableStringify(tinyFile(rel), 2));
    const twice = readdirSync(TINY_TS, { recursive: true, encoding: "utf8" })
      .filter((p) => p.endsWith(".ts"))
      .sort()
      .map((rel) => stableStringify(tinyFile(rel), 2));
    expect(twice).toEqual(once);
    expect(once.length).toBe(12);
  });
});
