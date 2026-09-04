/**
 * Leaf 2.4: Rust extraction, resolution and linking (spec 2026-09-04 section 1.3).
 *
 * Three layers, each tested on inline sources first and then pinned against
 * `fixtures/tiny-rust` end to end:
 *   - `extractRust`      - what one `.rs` file says about itself;
 *   - `createRustResolver` - a `use`/`mod` path resolved to a file through the crate's
 *                          module tree (`Cargo.toml` -> crate root -> `<seg>.rs`/`<seg>/mod.rs`);
 *   - `resolveRustCall`  - the call rules spec 1.3 fixes, with trait dispatch dropped.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createParser } from "../src/parser.ts";
import type { ParserHandle } from "../src/parser.ts";
import { extractFile } from "../src/extract/index.ts";
import { buildSnapshot } from "../src/build.ts";
import { buildRustCallIndex, createRustResolver, resolveRustCall } from "../src/resolve/rust.ts";
import type { RepoContext, ResolvedTarget } from "../src/resolve/resolver.ts";
import type { Declaration, FileRecord, GreplostConfig, ImportEdge, Snapshot } from "../src/schema.ts";
import { DEFAULT_CONFIG } from "../src/schema.ts";

const RUST_CONFIG: GreplostConfig = { ...DEFAULT_CONFIG, languages: ["rust"] };

const ZERO_SHA = "0".repeat(64);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TINY_RUST = join(REPO_ROOT, "fixtures/tiny-rust");

let parser: ParserHandle;

beforeAll(async () => {
  parser = await createParser();
});

function extract(source: string, path = "src/lib.rs"): FileRecord {
  return extractFile({ path, lang: "rust", source, sha256: ZERO_SHA }, parser);
}

function shape(record: FileRecord): Array<[string, string, boolean]> {
  return record.decls.map((d) => [d.name, d.kind, d.exported]);
}

function decl(record: FileRecord, name: string): Declaration {
  const found = record.decls.find((d) => d.name === name);
  if (!found) throw new Error(`no declaration named ${name} in [${record.decls.map((d) => d.name).join(", ")}]`);
  return found;
}

/** The smallest `Cargo.toml` an in-memory crate needs. */
const CARGO = '[package]\nname = "tiny"\nedition = "2021"\n';

/** A `RepoContext` over an in-memory tree: `.rs` files are indexed, everything else is readable. */
function context(sources: Readonly<Record<string, string>>): RepoContext {
  return {
    root: "/repo",
    files: new Set(Object.keys(sources).filter((path) => path.endsWith(".rs"))),
    packages: [],
    readFile: (rel: string): string | null => sources[rel] ?? null,
  };
}

function resolver(sources: Readonly<Record<string, string>>): (from: string, specifier: string) => ResolvedTarget {
  return createRustResolver(context(sources));
}

// ---------------------------------------------------------------------------
// declarations
// ---------------------------------------------------------------------------

describe("declarations", () => {
  test("every item kind maps to its DeclKind", () => {
    const record = extract(`pub struct Store { name: String }
pub(crate) enum Color { Red }
pub trait Backoff { fn next(&self) -> u64; }
pub type Alias = Store;
const ATTEMPTS: u8 = 3;
pub static GLOBAL: u8 = 1;
macro_rules! shout { () => {} }
mod inner { fn q() {} }
pub fn run() {}
impl Store { pub fn new() -> Self { Store } }
impl Backoff for Store { fn next(&self) -> u64 { 0 } }
`);
    expect(shape(record)).toEqual([
      ["Store", "struct", true],
      ["Color", "enum", true],
      ["Backoff", "trait", true],
      ["Backoff.next", "method", false],
      ["Alias", "type", true],
      ["ATTEMPTS", "const", false],
      ["GLOBAL", "var", true],
      ["shout", "function", false],
      ["inner", "module", false],
      ["inner::q", "function", false],
      ["run", "function", true],
      ["Store", "impl", false],
      ["Store.new", "method", true],
      ["Backoff for Store", "impl", false],
      ["Store.next", "method", false],
    ]);
  });

  test("an impl method carries the impl's type as its parent", () => {
    const record = extract(`pub struct Store;
impl Store { pub fn put(&self) {} }
impl Backoff for Store { fn next(&self) -> u64 { 0 } }
`);
    expect(decl(record, "Store.put").parent).toBe("Store");
    expect(decl(record, "Store.next").parent).toBe("Store");
    // The impl itself is a declaration in its own right, named `<Trait> for <Type>`.
    expect(decl(record, "Backoff for Store").kind).toBe("impl");
    expect(decl(record, "Backoff for Store").parent).toBeUndefined();
  });

  test("an item inside an inline mod is nested with `::`, never with `.`", () => {
    const record = extract(`mod tests {
  struct S;
  impl S { fn a(&self) {} }
  fn b() {}
}
`);
    expect(shape(record)).toEqual([
      ["tests", "module", false],
      ["tests::S", "struct", false],
      ["tests::S", "impl", false],
      ["tests::S.a", "method", false],
      ["tests::b", "function", false],
    ]);
    expect(decl(record, "tests::b").parent).toBe("tests");
  });

  test("two declarations that would share an id take a ~<n> suffix on the id, in source order", () => {
    const record = extract(`pub struct Store;
impl Store { pub fn new() -> Self { Store } }
pub trait A { fn go(&self); }
pub trait B { fn go(&self); }
impl A for Store { fn go(&self) {} }
impl B for Store { fn go(&self) {} }
`);
    expect(record.decls.map((d) => d.id)).toEqual([
      "src/lib.rs#Store",
      "src/lib.rs#Store~2",
      "src/lib.rs#Store.new",
      "src/lib.rs#A",
      "src/lib.rs#A.go",
      "src/lib.rs#B",
      "src/lib.rs#B.go",
      "src/lib.rs#A for Store",
      "src/lib.rs#Store.go",
      "src/lib.rs#B for Store",
      "src/lib.rs#Store.go~2",
    ]);
    expect(new Set(record.decls.map((d) => d.id)).size).toBe(record.decls.length);
    // The suffix lands on the **id**. `name` stays the path as written, so the export surface
    // still reads `Store` and no reader is offered a name nobody can import.
    expect(record.decls.map((d) => d.name)).toEqual([
      "Store",
      "Store",
      "Store.new",
      "A",
      "A.go",
      "B",
      "B.go",
      "A for Store",
      "Store.go",
      "B for Store",
      "Store.go",
    ]);
    expect(record.exports).toEqual([
      { name: "Store", kind: "named" },
      { name: "A", kind: "named" },
      { name: "B", kind: "named" },
    ]);
    // Both impls' methods hang off the struct, because the struct is declared in this file.
    expect(record.decls.filter((d) => d.name === "Store.go").map((d) => d.parent)).toEqual(["Store", "Store"]);
  });

  test("an impl block's own id is the parent when the type is declared elsewhere", () => {
    const record = extract("impl Store { pub fn put(&self) {} }\nimpl Store { fn also(&self) {} }\n");
    expect(record.decls.map((d) => d.id)).toEqual([
      "src/lib.rs#Store",
      "src/lib.rs#Store.put",
      "src/lib.rs#Store~2",
      "src/lib.rs#Store.also",
    ]);
    expect(decl(record, "Store.put").parent).toBe("Store");
    expect(decl(record, "Store.also").parent).toBe("Store~2");
  });

  test("generics and where clauses stay in the signature", () => {
    const record = extract(`pub fn run<T: Backoff>(t: T) -> u64 where T: Clone { 0 }
impl<T: Send> Store<T> { }
`);
    expect(decl(record, "run").signature).toBe("pub fn run<T: Backoff>(t: T) -> u64 where T: Clone");
    expect(decl(record, "Store").signature).toBe("impl<T: Send> Store<T>");
  });

  test("a signature is clipped to the 200-character cap", () => {
    const bound = "Backoff + Clone + Send + Sync + Default + Copy + Ord + Eq + Hash";
    const record = extract(`pub fn wide<T: ${bound}, U: ${bound}, V: ${bound}>(t: T, u: U, v: V) {}\n`);
    const signature = decl(record, "wide").signature;
    expect(signature.length).toBe(200);
    expect(signature.endsWith("…")).toBe(true);
  });

  test("a macro_rules definition is a function carrying meta.macro", () => {
    const record = extract("macro_rules! shout { () => {} }\n");
    expect(decl(record, "shout").kind).toBe("function");
    expect(decl(record, "shout").meta).toEqual({ macro: "1" });
    expect(decl(record, "shout").signature).toBe("macro_rules! shout");
  });

  test("a unit struct and a tuple struct both keep their header", () => {
    const record = extract("pub struct Unit;\npub struct Pair(u32, u32);\n");
    expect(decl(record, "Unit").signature).toBe("pub struct Unit");
    expect(decl(record, "Pair").signature).toBe("pub struct Pair");
  });
});

// ---------------------------------------------------------------------------
// use trees
// ---------------------------------------------------------------------------

describe("use trees", () => {
  test("one record per leaf of a use tree", () => {
    const record = extract("use crate::store::{Store, Item as It};\n");
    expect(record.imports).toEqual([
      {
        specifier: "crate::store::Store",
        kind: "static",
        symbols: [{ name: "Store", local: "Store" }],
        reexport: false,
        line: 1,
      },
      {
        specifier: "crate::store::Item",
        kind: "static",
        symbols: [{ name: "Item", local: "It" }],
        reexport: false,
        line: 1,
      },
    ]);
  });

  test("crate, super and self are preserved in the specifier", () => {
    const record = extract("use crate::a::A;\nuse super::b::B;\nuse self::c::C;\n");
    expect(record.imports.map((i) => i.specifier)).toEqual(["crate::a::A", "super::b::B", "self::c::C"]);
  });

  test("a glob gives name `*` and a specifier without it", () => {
    const record = extract("use super::x::*;\n");
    expect(record.imports).toEqual([
      {
        specifier: "super::x",
        kind: "static",
        symbols: [{ name: "*", local: "*" }],
        reexport: false,
        line: 1,
      },
    ]);
  });

  test("`use a::{self, b}` imports the module itself and one of its names", () => {
    const record = extract("use crate::a::{self, b};\n");
    expect(record.imports.map((i) => [i.specifier, i.symbols[0]?.name])).toEqual([
      ["crate::a", "a"],
      ["crate::a::b", "b"],
    ]);
  });

  test("pub use sets reexport and records the export it re-exports", () => {
    const record = extract("pub use crate::store::Store as S;\npub use self::retry::*;\n");
    expect(record.imports.map((i) => [i.specifier, i.reexport])).toEqual([
      ["crate::store::Store", true],
      ["self::retry", true],
    ]);
    expect(record.exports).toEqual([
      { name: "S", kind: "named", local: "Store", from: "crate::store::Store" },
      { name: "*", kind: "star", from: "self::retry" },
    ]);
  });

  test("a plain use exports nothing", () => {
    const record = extract("use crate::store::Store;\n");
    expect(record.exports).toEqual([]);
  });

  test("extern crate is a static import of the crate name", () => {
    const record = extract("extern crate serde;\n");
    expect(record.imports).toEqual([
      { specifier: "serde", kind: "static", symbols: [], reexport: false, line: 1 },
    ]);
  });

  test("a use written inside an inline mod is rebased onto the file", () => {
    const record = extract("mod a {\n  use self::b::B;\n  use super::c::C;\n}\n");
    expect(record.imports.map((i) => i.specifier)).toEqual(["self::a::b::B", "self::c::C"]);
  });
});

// ---------------------------------------------------------------------------
// mod tree
// ---------------------------------------------------------------------------

describe("mod tree", () => {
  test("a bodyless mod item is a static import with no symbols", () => {
    const record = extract("mod retry;\npub mod store;\n");
    expect(record.imports).toEqual([
      { specifier: "self::retry", kind: "static", symbols: [], reexport: false, line: 1 },
      { specifier: "self::store", kind: "static", symbols: [], reexport: false, line: 2 },
    ]);
    expect(shape(record)).toEqual([
      ["retry", "module", false],
      ["store", "module", true],
    ]);
  });

  test("an inline mod declares a module but imports nothing", () => {
    const record = extract("mod inner { fn q() {} }\n");
    expect(record.imports).toEqual([]);
  });

  test("a bodyless mod inside an inline mod names the nested file", () => {
    const record = extract("mod a { mod b; }\n");
    expect(record.imports.map((i) => i.specifier)).toEqual(["self::a::b"]);
  });

  test("a module path walks from the crate root to <seg>.rs or <seg>/mod.rs", () => {
    const resolve = resolver({
      "Cargo.toml": CARGO,
      "src/lib.rs": "",
      "src/a.rs": "",
      "src/a/b.rs": "",
      "src/c/mod.rs": "",
      "src/c/d.rs": "",
    });
    expect(resolve("src/lib.rs", "crate::a")).toEqual({ type: "file", path: "src/a.rs" });
    expect(resolve("src/lib.rs", "crate::a::b::Thing")).toEqual({ type: "file", path: "src/a/b.rs" });
    expect(resolve("src/lib.rs", "crate::c")).toEqual({ type: "file", path: "src/c/mod.rs" });
    expect(resolve("src/lib.rs", "crate::c::d")).toEqual({ type: "file", path: "src/c/d.rs" });
    // A path that walks off the tree lands on the crate root, where an inline `mod`'s item is.
    expect(resolve("src/lib.rs", "crate::Inline")).toEqual({ type: "file", path: "src/lib.rs" });
  });

  test("self and super walk the module tree relative to the file", () => {
    const resolve = resolver({
      "Cargo.toml": CARGO,
      "src/lib.rs": "",
      "src/a/mod.rs": "",
      "src/a/b.rs": "",
      "src/z.rs": "",
    });
    expect(resolve("src/a/mod.rs", "self::b")).toEqual({ type: "file", path: "src/a/b.rs" });
    expect(resolve("src/a/b.rs", "super::b")).toEqual({ type: "file", path: "src/a/b.rs" });
    expect(resolve("src/a/b.rs", "super::super::z")).toEqual({ type: "file", path: "src/z.rs" });
    // A uniform path (Rust 2018) names a module of the file's own module.
    expect(resolve("src/a/mod.rs", "b::Thing")).toEqual({ type: "file", path: "src/a/b.rs" });
  });

  test("a workspace member resolves through its own crate root, hyphens normalised", () => {
    const resolve = resolver({
      "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
      "crates/matcher/Cargo.toml": '[package]\nname = "grep-matcher"\n',
      "crates/matcher/src/lib.rs": "",
      "crates/searcher/Cargo.toml": '[package]\nname = "grep-searcher"\n',
      "crates/searcher/src/lib.rs": "",
    });
    expect(resolve("crates/searcher/src/lib.rs", "grep_matcher::Matcher")).toEqual({
      type: "file",
      path: "crates/matcher/src/lib.rs",
    });
    expect(resolve("crates/searcher/src/lib.rs", "serde::Serialize")).toEqual({
      type: "external",
      pkg: "crate/serde",
    });
  });

  test("a [[bin]] path outside src/ is a crate root of its own", () => {
    const resolve = resolver({
      "Cargo.toml": '[package]\nname = "rg"\n\n[[bin]]\nname = "rg"\npath = "core/main.rs"\n',
      "core/main.rs": "",
      "core/flags/mod.rs": "",
      "core/flags/defs.rs": "",
    });
    expect(resolve("core/flags/defs.rs", "crate::flags")).toEqual({ type: "file", path: "core/flags/mod.rs" });
    expect(resolve("core/main.rs", "crate::flags::defs::Thing")).toEqual({
      type: "file",
      path: "core/flags/defs.rs",
    });
  });
});

// ---------------------------------------------------------------------------
// visibility
// ---------------------------------------------------------------------------

describe("visibility", () => {
  test("pub, pub(crate) and pub(in …) all set exported and record which", () => {
    const record = extract(`pub fn a() {}
pub(crate) fn b() {}
pub(super) fn c() {}
pub(in crate::x) fn d() {}
fn e() {}
`);
    expect(record.decls.map((d) => [d.name, d.exported, d.meta?.["visibility"]])).toEqual([
      ["a", true, "pub"],
      ["b", true, "pub(crate)"],
      ["c", true, "pub(super)"],
      ["d", true, "pub(in crate::x)"],
      ["e", false, undefined],
    ]);
  });

  test("a private item carries no meta at all", () => {
    const record = extract("fn e() {}\n");
    expect(decl(record, "e").meta).toBeUndefined();
  });

  test("only a top-level pub item is an export of the file", () => {
    const record = extract(`pub fn a() {}
pub mod m { pub fn b() {} }
pub struct S;
impl S { pub fn c() {} }
`);
    expect(record.exports).toEqual([
      { name: "a", kind: "named" },
      { name: "m", kind: "named" },
      { name: "S", kind: "named" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

/** A tiny in-memory crate: `Cargo.toml` text plus `.rs` sources, keyed by repo-relative path. */
function repo(sources: Readonly<Record<string, string>>): {
  files: FileRecord[];
  edges: ImportEdge[];
} {
  const rust = [...context(sources).files].sort();
  const resolve = resolver(sources);
  const files = rust.map((path) => extract(sources[path] ?? "", path));
  const edges: ImportEdge[] = [];
  for (const file of files) {
    for (const record of file.imports) {
      const target = resolve(file.path, record.specifier);
      edges.push({
        from: file.path,
        to: target.type === "file" ? target.path : target.type === "external" ? `ext:${target.pkg}` : "unresolved:x",
        kind: record.reexport ? "reexport" : "import",
        symbols: record.symbols.map((s) => s.name),
        confidence: "high",
        specifier: record.specifier,
        importKind: record.kind,
      });
    }
  }
  return { files, edges };
}

/** Every call site of `entry`, as `callee -> target (confidence)` or `(dropped)`. */
function resolveCalls(sources: Readonly<Record<string, string>>, entry: string): string[] {
  const { files, edges } = repo(sources);
  const index = buildRustCallIndex(files, edges);
  const file = files.find((f) => f.path === entry);
  if (file === undefined) throw new Error(`no file ${entry}`);
  return file.calls.map((site) => {
    const resolved = resolveRustCall(file, site, index);
    return `${site.callee} -> ${resolved === null ? "(dropped)" : `${resolved.to} (${resolved.confidence})`}`;
  });
}

describe("calls", () => {
  test("the callee shapes spec 1.3 fixes, and nothing else", () => {
    const record = extract(`fn f(s: Store) {
  helper();
  self::helper2();
  Store::new();
  s.put(1);
  a::b::c();
  (helper())();
  println!("hi");
}
`);
    expect(record.calls.map((c) => c.callee)).toEqual(["helper", "helper2", "Store.new", "Store.put", "helper"]);
  });

  test("a macro invocation is never a call", () => {
    // A macro's arguments are an unparsed token tree, so nothing inside one is a call either.
    const record = extract('fn f() { println!("{}", vec![1].len()); assert_eq!(1, 1); helper(); }\n');
    expect(record.calls.map((c) => c.callee)).toEqual(["helper"]);
  });

  test("a call on self is normalised to this.method", () => {
    const record = extract("struct S;\nimpl S { fn a(&self) { self.b(); Self::c(); } fn b(&self) {} fn c() {} }\n");
    expect(record.calls.map((c) => [c.caller, c.callee])).toEqual([
      ["S.a", "this.b"],
      ["S.a", "S.c"],
    ]);
  });

  test("a method on a generic or dyn receiver is dropped, never guessed", () => {
    const record = extract(`pub trait Backoff { fn next(&self) -> u64; }
pub fn generic<T: Backoff>(t: T) -> u64 { t.next() }
pub fn dynamic(b: &dyn Backoff) -> u64 { b.next() }
pub fn opaque(i: impl Backoff) -> u64 { i.next() }
`);
    expect(record.calls).toEqual([]);
  });

  test("a receiver bound twice in one function is dropped", () => {
    const record = extract(`struct S;
impl S { fn go(&self) {} }
fn f(s: S) { s.go(); }
fn g(s: S) { let s = other(); s.go(); }
`);
    expect(record.calls.map((c) => [c.caller, c.callee])).toEqual([
      ["f", "S.go"],
      ["g", "other"],
    ]);
  });

  test("a same-file item resolves at high confidence", () => {
    expect(
      resolveCalls({ "Cargo.toml": CARGO, "src/lib.rs": "fn a() { b(); }\nfn b() {}\n" }, "src/lib.rs"),
    ).toEqual(["b -> src/lib.rs#b (high)"]);
  });

  test("a name imported by exactly one use resolves at high confidence", () => {
    expect(
      resolveCalls(
        {
          "Cargo.toml": CARGO,
          "src/lib.rs": "mod a;\nuse crate::a::go;\nfn f() { go(); }\n",
          "src/a.rs": "pub fn go() {}\n",
        },
        "src/lib.rs",
      ),
    ).toEqual(["go -> src/a.rs#go (high)"]);
  });

  test("Type::method resolves through the impl that declares it", () => {
    expect(
      resolveCalls(
        {
          "Cargo.toml": CARGO,
          "src/lib.rs": "mod a;\nuse crate::a::Store;\nfn f() { Store::new(); Store::gone(); }\n",
          "src/a.rs": "pub struct Store;\nimpl Store { pub fn new() -> Self { Store } }\n",
        },
        "src/lib.rs",
      ),
    ).toEqual(["Store.new -> src/a.rs#Store.new (high)", "Store.gone -> (dropped)"]);
  });

  test("this.method inside an impl resolves to that impl's method", () => {
    expect(
      resolveCalls(
        {
          "Cargo.toml": CARGO,
          "src/lib.rs": "struct S;\nimpl S { fn a(&self) { self.b(); self.gone(); } fn b(&self) {} }\n",
        },
        "src/lib.rs",
      ),
    ).toEqual(["this.b -> src/lib.rs#S.b (high)", "this.gone -> (dropped)"]);
  });

  test("a module-qualified call resolves through the mod item", () => {
    expect(
      resolveCalls(
        {
          "Cargo.toml": CARGO,
          "src/lib.rs": "mod retry;\nfn f() { retry::run(); retry::gone(); }\n",
          "src/retry.rs": "pub fn run() {}\n",
        },
        "src/lib.rs",
      ),
    ).toEqual(["retry.run -> src/retry.rs#run (high)", "retry.gone -> (dropped)"]);
  });

  test("a name reached through exactly one pub use resolves at med confidence", () => {
    expect(
      resolveCalls(
        {
          "Cargo.toml": CARGO,
          "src/lib.rs": "pub mod a;\npub mod b;\n",
          "src/a.rs": "pub fn go() {}\n",
          "src/b.rs": "pub use crate::a::go;\n",
          "src/c.rs": "use crate::b::go;\nfn f() { go(); }\n",
        },
        "src/c.rs",
      ),
    ).toEqual(["go -> src/a.rs#go (med)"]);
  });

  test("a name two use items could supply is dropped", () => {
    expect(
      resolveCalls(
        {
          "Cargo.toml": CARGO,
          "src/lib.rs": "mod a;\nmod b;\nuse crate::a::go;\nuse crate::b::go;\nfn f() { go(); }\n",
          "src/a.rs": "pub fn go() {}\n",
          "src/b.rs": "pub fn go() {}\n",
        },
        "src/lib.rs",
      ),
    ).toEqual(["go -> (dropped)"]);
  });

  test("a block-scoped fn shadows the top-level one, so the call is dropped", () => {
    // `helper()` inside `outer` names the `fn helper` declared in `outer`'s own body, not the
    // top-level one. The extractor never descends into a body, so it cannot say which item the
    // call lands on - and a guess here would be a wrong `high` edge.
    expect(
      resolveCalls(
        {
          "Cargo.toml": CARGO,
          "src/lib.rs":
            "pub fn helper() -> i32 { 0 }\npub fn outer() -> i32 { fn helper() -> i32 { 42 } helper() }\n",
        },
        "src/lib.rs",
      ),
    ).toEqual([]);
  });

  test("an explicitly module-qualified call is not shadowed by a block-scoped fn", () => {
    expect(
      resolveCalls(
        {
          "Cargo.toml": CARGO,
          "src/lib.rs": "pub fn helper() {}\npub fn outer() { fn helper() {} self::helper() }\n",
        },
        "src/lib.rs",
      ),
    ).toEqual(["helper -> src/lib.rs#helper (high)"]);
  });

  test("a member name declared twice in one file resolves to nothing", () => {
    expect(
      resolveCalls(
        {
          "Cargo.toml": CARGO,
          "src/lib.rs": `pub struct S;
pub trait A { fn go(&self); }
pub trait B { fn go(&self); }
impl A for S { fn go(&self) {} }
impl B for S { fn go(&self) {} }
impl S { fn only(&self) {} }
fn f(s: S) { s.go(); s.only(); }
`,
        },
        "src/lib.rs",
      ),
    ).toEqual(["S.go -> (dropped)", "S.only -> src/lib.rs#S.only (high)"]);
  });

  test("a glob-imported function resolves at high confidence when one glob is in scope", () => {
    expect(
      resolveCalls(
        {
          "Cargo.toml": CARGO,
          "src/lib.rs": "mod a;\nuse crate::a::*;\nfn f() { go(); }\n",
          "src/a.rs": "pub fn go() {}\n",
        },
        "src/lib.rs",
      ),
    ).toEqual(["go -> src/a.rs#go (high)"]);
  });

  test("two globs in scope are ambiguous, so the call is dropped", () => {
    expect(
      resolveCalls(
        {
          "Cargo.toml": CARGO,
          "src/lib.rs": "mod a;\nmod b;\nuse crate::a::*;\nuse crate::b::*;\nfn f() { go(); }\n",
          "src/a.rs": "pub fn go() {}\n",
          "src/b.rs": "pub fn other() {}\n",
        },
        "src/lib.rs",
      ),
    ).toEqual(["go -> (dropped)"]);
  });

  test("a trait-dispatched call is absent from the fixture's call graph", async () => {
    const snapshot: Snapshot = await buildSnapshot({ root: TINY_RUST, config: RUST_CONFIG });
    expect(snapshot.calls.filter((c) => c.to.endsWith("#Backoff.next"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// tiny-rust
// ---------------------------------------------------------------------------

describe("tiny-rust", () => {
  let snapshot: Snapshot;

  beforeAll(async () => {
    snapshot = await buildSnapshot({ root: TINY_RUST, config: RUST_CONFIG });
  });

  test("every .rs file is indexed", () => {
    expect(snapshot.files.map((f) => f.path)).toEqual([
      "src/lib.rs",
      "src/main.rs",
      "src/retry.rs",
      "src/store.rs",
    ]);
  });

  test("a bodyless mod item is an import of the module's file", () => {
    const targets = [
      ...new Set(snapshot.imports.filter((e) => e.from === "src/main.rs").map((e) => e.to)),
    ].sort();
    expect(targets).toEqual(["src/retry.rs", "src/store.rs"]);
  });

  test("the whole import graph resolves inside the crate", () => {
    expect(snapshot.imports.map((e) => `${e.from} -> ${e.to} [${e.specifier}]`)).toEqual([
      "src/lib.rs -> src/retry.rs [self::retry]",
      "src/lib.rs -> src/retry.rs [self::retry]",
      "src/lib.rs -> src/store.rs [self::store]",
      "src/lib.rs -> src/store.rs [crate::store::Store]",
      "src/main.rs -> src/retry.rs [self::retry]",
      "src/main.rs -> src/store.rs [self::store]",
      "src/main.rs -> src/store.rs [store::Store]",
      "src/retry.rs -> src/store.rs [crate::store::Store]",
      "src/store.rs -> src/retry.rs [crate::retry::Backoff]",
    ]);
  });

  test("the `mod tests { use super::*; }` self-import is not an edge", () => {
    expect(snapshot.imports.filter((e) => e.from === e.to)).toEqual([]);
    // The record is still written down: it is the linker that drops the self-loop.
    const store = snapshot.files.find((f) => f.path === "src/store.rs");
    expect(store?.imports.map((i) => i.specifier)).toContain("self");
  });

  test("the pub use re-export carries the store's name into the lib crate", () => {
    expect(snapshot.manifest.files["src/lib.rs"]?.exports).toEqual([
      "Backoff",
      "Store",
      "poll",
      "poll_dyn",
      "run",
      "store",
      "warm",
    ]);
    expect(snapshot.imports.some((e) => e.kind === "reexport" && e.to === "src/store.rs")).toBe(true);
  });

  test("Store::new, s.put and the module-qualified retry::run all resolve through the linker", () => {
    expect(snapshot.calls.map((e) => `${e.from} -> ${e.to} (${e.confidence})`)).toEqual([
      "src/main.rs#main -> src/retry.rs#run (high)",
      "src/main.rs#main -> src/store.rs#Store.new (high)",
      "src/main.rs#main -> src/store.rs#Store.put (high)",
      "src/retry.rs#warm -> src/store.rs#Store.put (high)",
      "src/store.rs#Store.put -> src/store.rs#Store.record (high)",
      "src/store.rs#tests::puts_a_value -> src/store.rs#Store.new (high)",
      "src/store.rs#tests::puts_a_value -> src/store.rs#Store.put (high)",
    ]);
    // `retry::run()` is written down as a call site; the linker dispatches Rust files to
    // `resolveRustCall` (wired by the driver after this leaf), and the direct call agrees.
    const { files, edges } = {
      files: snapshot.files,
      edges: snapshot.imports,
    };
    const index = buildRustCallIndex(files, edges);
    const main = files.find((f) => f.path === "src/main.rs");
    const site = main?.calls.find((c) => c.callee === "retry.run");
    expect(site).toBeDefined();
    expect(main === undefined || site === undefined ? null : resolveRustCall(main, site, index)).toEqual({
      to: "src/retry.rs#run",
      confidence: "high",
    });
  });

  test("the module cycle between store and retry is found", () => {
    expect(snapshot.metrics.cycles).toEqual([["src/retry.rs", "src/store.rs"]]);
  });
});

export { TINY_RUST };
