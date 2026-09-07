/**
 * Leaf 1.8: Go extraction, resolution and linking.
 *
 * Three layers, each tested on inline sources first and then pinned against
 * `fixtures/tiny-go` end to end:
 *   - `extractGo`  - what one `.go` file says about itself;
 *   - `resolveGo`  - an import path resolved to a package *directory* id
 *                    (tech spec Appendix C: a Go import names a package, not a file);
 *   - `resolveGoCall` - the three call rules the go spec fixes.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createParser } from "../src/parser.ts";
import type { ParserHandle } from "../src/parser.ts";
import { extractFile } from "../src/extract/index.ts";
import { buildSnapshot } from "../src/build.ts";
import { createResolver } from "../src/resolve/resolver.ts";
import { buildGoCallIndex, goDirectoryOf, resolveGoCall } from "../src/resolve/go.ts";
import type { ResolvedTarget } from "../src/resolve/resolver.ts";
import type { CallEdge, Declaration, FileRecord, GreplostConfig, ImportEdge, Snapshot } from "../src/schema.ts";
import { DEFAULT_CONFIG } from "../src/schema.ts";

const ZERO_SHA = "0".repeat(64);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TINY_GO = join(REPO_ROOT, "fixtures/tiny-go");
const GO_CONFIG: GreplostConfig = { ...DEFAULT_CONFIG, languages: ["go"] };

let parser: ParserHandle;

beforeAll(async () => {
  parser = await createParser();
});

function extract(source: string, path = "pkg/a.go"): FileRecord {
  return extractFile({ path, lang: "go", source, sha256: ZERO_SHA }, parser);
}

function shape(record: FileRecord): Array<[string, string, boolean]> {
  return record.decls.map((d) => [d.name, d.kind, d.exported]);
}

function decl(record: FileRecord, name: string): Declaration {
  const found = record.decls.find((d) => d.name === name);
  if (!found) throw new Error(`no declaration named ${name} in [${record.decls.map((d) => d.name).join(", ")}]`);
  return found;
}

// ---------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------

describe("extract-go declarations", () => {
  test("functions, methods, types, constants and variables", () => {
    const record = extract(`package a

const Attempts = 3

const (
	Alpha = 1
	beta  = 2
)

var Global, hidden = 1, 2

var (
	ErrX = 1
)

type Store struct {
	Name string
}

type Putter interface {
	Put(k string) error
}

type Alias = Store

type Count int

func New(name string) *Store { return &Store{} }

func (s *Store) Put(k string) error { return nil }

func (s Store) hidden2() {}
`);
    expect(shape(record)).toEqual([
      ["Attempts", "const", true],
      ["Alpha", "const", true],
      ["beta", "const", false],
      ["Global", "var", true],
      ["hidden", "var", false],
      ["ErrX", "var", true],
      ["Store", "struct", true],
      ["Putter", "interface", true],
      ["Alias", "type", true],
      ["Count", "type", true],
      ["New", "function", true],
      ["Store.Put", "method", true],
      ["Store.hidden2", "method", false],
    ]);
  });

  test("a method records its receiver type as the parent, pointer star stripped", () => {
    const record = extract("package a\n\nfunc (s *Store) Put(k string) error { return nil }\n");
    const method = decl(record, "Store.Put");
    expect(method.parent).toBe("Store");
    expect(method.kind).toBe("method");
    expect(method.id).toBe("pkg/a.go#Store.Put");
  });

  test("a receiverless method declaration still names its type", () => {
    const record = extract("package a\n\nfunc (*Store) Put() {}\n");
    expect(decl(record, "Store.Put").parent).toBe("Store");
  });

  test("exported is the first rune of the declared name, not of the receiver", () => {
    const record = extract("package a\n\nfunc (s *store) Put() {}\nfunc (s *Store) put() {}\n");
    expect(decl(record, "store.Put").exported).toBe(true);
    expect(decl(record, "Store.put").exported).toBe(false);
  });

  test("blank and non-ASCII names", () => {
    const record = extract("package a\n\nvar _ = 1\nfunc Ünicode() {}\nfunc ünicode() {}\n");
    // `_` binds nothing, so build 2.1 stopped declaring it at all.
    expect(shape(record)).toEqual([
      ["Ünicode", "function", true],
      ["ünicode", "function", false],
    ]);
  });

  test("signatures are cut before the body and whitespace collapsed", () => {
    const record = extract(`package a

func New(
	name string,
) *Store {
	return nil
}

func (s *Store) Put(k string) error { return nil }

type Store struct {
	Name string
}

type Putter interface {
	Put(k string) error
}

const Attempts = 3
`);
    expect(decl(record, "New").signature).toBe("func New( name string, ) *Store");
    expect(decl(record, "Store.Put").signature).toBe("func (s *Store) Put(k string) error");
    // A struct or interface body is a body, cut like a function's (and like a
    // TypeScript `interface_body`); a spec without one keeps its whole text.
    expect(decl(record, "Store").signature).toBe("type Store struct");
    expect(decl(record, "Putter").signature).toBe("type Putter interface");
    expect(decl(record, "Attempts").signature).toBe("const Attempts = 3");
  });

  test("a signature longer than 200 characters is truncated", () => {
    const long = "a".repeat(300);
    const record = extract(`package a\n\nfunc New(name ${long}) {}\n`);
    const signature = decl(record, "New").signature;
    expect(signature.length).toBe(200);
    expect(signature.endsWith("…")).toBe(true);
  });

  test("line spans are 1-based and inclusive", () => {
    const record = extract("package a\n\nfunc New() {\n\treturn\n}\n");
    expect(decl(record, "New").span).toEqual([3, 5]);
  });

  test("a grouped type declaration gives each spec its own signature", () => {
    const record = extract("package a\n\ntype (\n\tA int\n\tB struct{ X int }\n\tc interface{ M() }\n)\n");
    expect(shape(record)).toEqual([
      ["A", "type", true],
      ["B", "struct", true],
      ["c", "interface", false],
    ]);
    expect(record.decls.map((d) => d.signature)).toEqual(["type A int", "type B struct", "type c interface"]);
  });

  test("a generic type and its methods keep the base type name", () => {
    const record = extract(
      "package a\n\ntype List[T any] struct{ items []T }\n\nfunc (l *List[T]) Add(v T) { l.grow() }\n\nfunc (l *List[T]) grow() {}\n",
    );
    expect(shape(record)).toEqual([
      ["List", "struct", true],
      ["List.Add", "method", true],
      ["List.grow", "method", false],
    ]);
    expect(decl(record, "List.Add").signature).toBe("func (l *List[T]) Add(v T)");
  });

  test("an implicit const spec keeps its own name and signature", () => {
    const record = extract("package a\n\nconst (\n\tA Kind = iota\n\tB\n\tc\n)\n");
    expect(shape(record)).toEqual([
      ["A", "const", true],
      ["B", "const", true],
      ["c", "const", false],
    ]);
    expect(decl(record, "A").signature).toBe("const A Kind = iota");
    expect(decl(record, "B").signature).toBe("const B");
  });

  test("a binding initialised with a function literal is cut before the body", () => {
    const record = extract("package a\n\nvar Handler = func() { helper() }\n\nfunc helper() {}\n");
    expect(decl(record, "Handler").signature).toBe("var Handler = func()");
    // The call inside the literal is package-level code, so it has no caller.
    expect(record.calls).toEqual([{ caller: "", callee: "helper", line: 3 }]);
  });

  test("a file the grammar cannot parse yields nothing rather than throwing", () => {
    const record = extract("package a\n\nfunc F( {\n");
    expect(record.decls).toEqual([]);
    expect(record.calls).toEqual([]);
  });

  test("declarations inside function bodies are not top-level declarations", () => {
    const record = extract("package a\n\nfunc New() {\n\ttype local struct{}\n\tvar x = 1\n\t_ = x\n}\n");
    expect(shape(record)).toEqual([["New", "function", true]]);
  });

  test("a blank identifier declares nothing at all", () => {
    // Two `var _` interface assertions in one file used to make two declarations
    // with the same id, `<file>#_`. `_` binds no name, so neither is a declaration.
    const record = extract(
      "package a\n\nvar _ Hooks = (*C)(nil)\nvar _ error = (*D)(nil)\n\nconst _ = 1\n\nfunc _() {}\n\ntype C struct{}\n",
    );
    expect(shape(record)).toEqual([["C", "struct", true]]);
    expect(record.exports).toEqual([{ name: "C", kind: "named" }]);
  });

  test("a struct records its embedded field types, sorted, named fields excluded", () => {
    const record = extract(
      'package a\n\nimport "x/core"\n\ntype C struct {\n\t*core.Base\n\tInner\n\tBox[T]\n\tname string\n}\n',
    );
    expect(decl(record, "C").meta).toEqual({ embeds: "Box,Inner,core.Base" });
    // A struct with no embedded field carries no attribute at all.
    expect(decl(extract("package a\n\ntype P struct{ name string }\n"), "P").meta).toBeUndefined();
  });

  test("a function records the named type of its first result", () => {
    const record = extract(
      "package a\n\ntype Store struct{}\n\nfunc New() (*Store, error) { return nil, nil }\n\n" +
        "func Count() int { return 0 }\n\nfunc Anon() func() { return nil }\n",
    );
    expect(decl(record, "New").meta).toEqual({ result: "Store" });
    // A predeclared type names no declaration a call could land on, and a
    // function type is not a named type at all.
    expect(decl(record, "Count").meta).toBeUndefined();
    expect(decl(record, "Anon").meta).toBeUndefined();
  });

  test("a declaration records the local receivers its own calls use", () => {
    const record = extract(
      "package a\n\ntype delivery struct{}\n\nfunc (c *Consumer) Park() {\n\td := &delivery{}\n" +
        "\tunused := &delivery{}\n\t_ = unused\n\td.dispose()\n}\n",
    );
    // Only a local a recorded call is actually written against is worth an
    // attribute: `unused` decides nothing about the shape of the map.
    expect(decl(record, "Consumer.Park").meta).toEqual({ locals: "d:delivery" });
  });
});

describe("extract-go imports", () => {
  test("grouped, aliased, blank and dot imports", () => {
    const record = extract(`package a

import (
	"fmt"
	stdstr "strings"
	_ "net/http/pprof"
	. "math"
)

import "os"
`);
    expect(record.imports).toEqual([
      { specifier: "fmt", kind: "static", symbols: [{ name: "*", local: "fmt" }], reexport: false, line: 4 },
      { specifier: "strings", kind: "static", symbols: [{ name: "*", local: "stdstr" }], reexport: false, line: 5 },
      { specifier: "net/http/pprof", kind: "side-effect", symbols: [], reexport: false, line: 6 },
      { specifier: "math", kind: "static", symbols: [{ name: "*", local: "." }], reexport: false, line: 7 },
      { specifier: "os", kind: "static", symbols: [{ name: "*", local: "os" }], reexport: false, line: 10 },
    ]);
  });

  test("the default local name is the last path segment", () => {
    const record = extract('package a\n\nimport "example.com/tiny/internal/store"\n');
    expect(record.imports[0]?.symbols).toEqual([{ name: "*", local: "store" }]);
  });

  test("a raw-string import path keeps its text", () => {
    const record = extract("package a\n\nimport `os`\n");
    expect(record.imports[0]?.specifier).toBe("os");
  });
});

describe("extract-go exports", () => {
  test("one named record per exported top-level declaration, methods excluded", () => {
    const record = extract(`package a

const Attempts = 3
var hidden = 1
type Store struct{}
func New() {}
func (s *Store) Put() {}
`);
    expect(record.exports).toEqual([
      { name: "Attempts", kind: "named" },
      { name: "Store", kind: "named" },
      { name: "New", kind: "named" },
    ]);
  });
});

describe("extract-go call sites", () => {
  test("identifiers, one-level selectors and receiver calls", () => {
    const record = extract(`package a

import "fmt"

func New() {}

func (s *Store) Put() {
	s.set()
	New()
	fmt.Println()
	s.data.get()
	f := func() { New() }
	f()
	go s.set()
	defer s.set()
}
`);
    // `s.data.get()` is a deeper chain and `f()` calls the local `f`, which
    // shadows package scope: neither is a call site the resolver could ever use.
    expect(record.calls).toEqual([
      { caller: "Store.Put", callee: "s.set", line: 8 },
      { caller: "Store.Put", callee: "New", line: 9 },
      { caller: "Store.Put", callee: "fmt.Println", line: 10 },
      { caller: "Store.Put", callee: "New", line: 12 },
      { caller: "Store.Put", callee: "s.set", line: 14 },
      { caller: "Store.Put", callee: "s.set", line: 15 },
    ]);
  });

  test("composite literals are not calls", () => {
    const record = extract("package a\n\nfunc New() *Store { return &Store{Name: \"x\"} }\n");
    expect(record.calls).toEqual([]);
  });

  test("top-level initializers have an empty caller", () => {
    const record = extract('package a\n\nimport "fmt"\n\nvar Err = fmt.Errorf("x")\n');
    expect(record.calls).toEqual([{ caller: "", callee: "fmt.Errorf", line: 5 }]);
  });

  test("calls inside a function literal attribute to the enclosing declaration", () => {
    const record = extract("package a\n\nfunc Do() {\n\tgo func() { helper() }()\n}\n");
    expect(record.calls).toEqual([{ caller: "Do", callee: "helper", line: 4 }]);
  });
});

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

describe("resolve-go", () => {
  function resolverFor(files: string[], modules: Record<string, string>) {
    const readFile = (rel: string): string | null => modules[rel] ?? null;
    return createResolver({ root: "/repo", files: new Set(files), packages: [], readFile });
  }

  const MODULES = { "go.mod": "module example.com/tiny\n\ngo 1.25\n" };

  test("an import inside the module resolves to the package directory id", () => {
    const resolver = resolverFor(["internal/store/store.go", "cmd/app/main.go"], MODULES);
    expect(resolver.resolve("cmd/app/main.go", "example.com/tiny/internal/store", "go")).toEqual({
      type: "file",
      path: "internal/store",
    } satisfies ResolvedTarget);
  });

  test("the module root resolves to the repo-root directory id", () => {
    const resolver = resolverFor(["gin.go", "ginS/gins.go"], { "go.mod": "module github.com/gin-gonic/gin\n" });
    expect(resolver.resolve("ginS/gins.go", "github.com/gin-gonic/gin", "go")).toEqual({
      type: "file",
      path: ".",
    } satisfies ResolvedTarget);
  });

  test("the standard library and other modules are external", () => {
    const resolver = resolverFor(["cmd/app/main.go"], MODULES);
    expect(resolver.resolve("cmd/app/main.go", "fmt", "go")).toEqual({ type: "external", pkg: "fmt" });
    expect(resolver.resolve("cmd/app/main.go", "net/http", "go")).toEqual({ type: "external", pkg: "net/http" });
    expect(resolver.resolve("cmd/app/main.go", "github.com/stretchr/testify/assert", "go")).toEqual({
      type: "external",
      pkg: "github.com/stretchr/testify/assert",
    });
  });

  test("a directory inside the module with no indexed .go file is external", () => {
    const resolver = resolverFor(["cmd/app/main.go"], MODULES);
    expect(resolver.resolve("cmd/app/main.go", "example.com/tiny/internal/store", "go")).toEqual({
      type: "external",
      pkg: "example.com/tiny/internal/store",
    });
  });

  test("a module path prefix that is not a path boundary does not match", () => {
    const resolver = resolverFor(["cmd/app/main.go", "x/y.go"], MODULES);
    expect(resolver.resolve("cmd/app/main.go", "example.com/tinyother/x", "go")).toEqual({
      type: "external",
      pkg: "example.com/tinyother/x",
    });
  });

  test("a nested go.mod wins for the files beneath it (go.work layouts)", () => {
    const resolver = resolverFor(["sub/a.go", "sub/pkg/b.go", "root.go"], {
      "go.mod": "module example.com/root\n",
      "sub/go.mod": "module example.com/sub\n",
    });
    expect(resolver.resolve("sub/a.go", "example.com/sub/pkg", "go")).toEqual({ type: "file", path: "sub/pkg" });
    expect(resolver.resolve("sub/a.go", "example.com/root", "go")).toEqual({ type: "file", path: "." });
  });

  test("a quoted module directive and trailing comment are handled", () => {
    const resolver = resolverFor(["internal/store/store.go", "a.go"], {
      "go.mod": 'module "example.com/tiny" // the module\n',
    });
    expect(resolver.resolve("a.go", "example.com/tiny/internal/store", "go")).toEqual({
      type: "file",
      path: "internal/store",
    });
  });

  test("a repo with no go.mod resolves every import as external", () => {
    const resolver = resolverFor(["a.go", "pkg/b.go"], {});
    expect(resolver.resolve("a.go", "example.com/tiny/pkg", "go")).toEqual({
      type: "external",
      pkg: "example.com/tiny/pkg",
    });
  });

  test("a go.mod with no module directive is ignored", () => {
    const resolver = resolverFor(["a.go", "pkg/b.go"], { "go.mod": "go 1.25\n" });
    expect(resolver.resolve("a.go", "example.com/tiny/pkg", "go")).toEqual({
      type: "external",
      pkg: "example.com/tiny/pkg",
    });
  });

  test("go resolution never touches the TypeScript rules", () => {
    const resolver = resolverFor(["a.go", "b.ts"], MODULES);
    expect(resolver.resolve("a.go", "./b", "go")).toEqual({ type: "external", pkg: "./b" });
  });
});

// ---------------------------------------------------------------------------
// call resolution
// ---------------------------------------------------------------------------

describe("resolve-go calls", () => {
  /** Extract the given sources and resolve every call site in `entry`. */
  function resolveCalls(sources: Record<string, string>, entry: string): string[] {
    const files = Object.entries(sources).map(([path, source]) => extract(source, path));
    // The import edges the linker would have produced for module `example.com/m`:
    // a directory id when the specifier names an indexed package, else `ext:`.
    const directories = new Set(Object.keys(sources).map(goDirectoryOf));
    const edges: ImportEdge[] = [];
    for (const file of files) {
      for (const record of file.imports) {
        const inside = record.specifier.startsWith("example.com/m/");
        const target = inside ? record.specifier.slice("example.com/m/".length) : "";
        edges.push({
          from: file.path,
          to: directories.has(target) ? target : `ext:${record.specifier}`,
          kind: "import",
          symbols: record.symbols.map((sym) => sym.name),
          confidence: "high",
          specifier: record.specifier,
          importKind: record.kind,
        });
      }
    }
    const index = buildGoCallIndex(files, edges);
    const file = files.find((f) => f.path === entry);
    if (file === undefined) throw new Error(`no file ${entry}`);
    return file.calls.map((site) => {
      const resolved = resolveGoCall(file, site, index);
      return `${site.callee} -> ${resolved === null ? "(dropped)" : `${resolved.to} (${resolved.confidence})`}`;
    });
  }

  test("a bare name resolves to a package-scope function of the same directory", () => {
    expect(
      resolveCalls(
        {
          "store/a.go": "package store\n\nfunc A() { New() }\n",
          "store/b.go": "package store\n\nfunc New() {}\n",
        },
        "store/a.go",
      ),
    ).toEqual(["New -> store/b.go#New (high)"]);
  });

  test("a type conversion is never a call edge", () => {
    expect(
      resolveCalls(
        {
          "store/a.go":
            "package store\n\ntype Count int\n\nfunc B(x int) { _ = Count(x) }\n",
        },
        "store/a.go",
      ),
    ).toEqual(["Count -> (dropped)"]);
  });

  test("a name declared in two files of one directory is ambiguous", () => {
    const sources = {
      "codec/json.go": "package codec\n\nfunc Marshal() {}\n",
      "codec/sonic.go": "package codec\n\nfunc Marshal() {}\n\nfunc Use() { Marshal() }\n",
      "app/main.go": 'package main\n\nimport "example.com/m/codec"\n\nfunc main() { codec.Marshal() }\n',
    };
    // The caller's own file settles it: they are compiled together.
    expect(resolveCalls(sources, "codec/sonic.go")).toEqual(["Marshal -> codec/sonic.go#Marshal (high)"]);
    // From another package it would be a guess, so nothing is emitted.
    expect(resolveCalls(sources, "app/main.go")).toEqual(["codec.Marshal -> (dropped)"]);
  });

  test("an import alias resolves against the imported directory", () => {
    expect(
      resolveCalls(
        {
          "app/main.go": 'package main\n\nimport st "example.com/m/store"\n\nfunc main() { st.New() }\n',
          "store/a.go": "package store\n\nfunc New() {}\n",
        },
        "app/main.go",
      ),
    ).toEqual(["st.New -> store/a.go#New (high)"]);
  });

  test("an alias for a package outside the repo is dropped", () => {
    expect(
      resolveCalls(
        { "app/main.go": 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println() }\n' },
        "app/main.go",
      ),
    ).toEqual(["fmt.Println -> (dropped)"]);
  });

  test("a receiver call resolves to a method of the receiver type", () => {
    expect(
      resolveCalls(
        {
          "store/a.go": "package store\n\ntype Store struct{}\n\nfunc (s *Store) Put() { s.set() }\n",
          "store/b.go": "package store\n\nfunc (s *Store) set() {}\n",
        },
        "store/a.go",
      ),
    ).toEqual(["s.set -> store/b.go#Store.set (high)"]);
  });

  test("a member call on a package-level name that is not an alias is dropped", () => {
    // `shared` is not locally bound, so the extractor records the site; the
    // resolver drops it because `shared` is neither an import alias nor the
    // enclosing method's receiver.
    expect(
      resolveCalls(
        {
          "store/a.go":
            "package store\n\ntype Store struct{}\n\nvar shared *Store\n\nfunc (s *Store) set() {}\n\nfunc Free() { shared.set() }\n",
        },
        "store/a.go",
      ),
    ).toEqual(["shared.set -> (dropped)"]);
  });

  test("a method that rebinds its receiver name shadows it", () => {
    // Only the receiver's own parameter_declaration is exempt: `s := &Other{}`
    // is an ordinary binder, so `s.set()` is a call on the new `s`.
    expect(
      resolveCalls(
        {
          "store/a.go":
            "package store\n\ntype Store struct{}\ntype Other struct{}\n\n" +
            "func (s *Store) set() {}\n\n" +
            "func (s *Store) Put() {\n\ts := &Other{}\n\ts.set()\n}\n",
        },
        "store/a.go",
      ),
    ).toEqual([]);
  });

  test("a closure parameter named like the receiver shadows it", () => {
    expect(
      resolveCalls(
        {
          "store/a.go":
            "package store\n\ntype Store struct{}\n\n" +
            "func (s *Store) set() {}\n\n" +
            "func (s *Store) Put() {\n\tgo func(s *Store) { s.set() }(nil)\n}\n",
        },
        "store/a.go",
      ),
    ).toEqual([]);
  });

  test("an unrebound receiver call still resolves (control)", () => {
    expect(
      resolveCalls(
        {
          "store/a.go":
            "package store\n\ntype Store struct{}\n\n" +
            "func (s *Store) set() {}\n\n" +
            "func (s *Store) Put() {\n\ts.set()\n}\n",
        },
        "store/a.go",
      ),
    ).toEqual(["s.set -> store/a.go#Store.set (high)"]);
  });

  test("a method with no receiver variable resolves no member calls", () => {
    expect(
      resolveCalls(
        {
          "store/a.go":
            "package store\n\ntype Store struct{}\n\nfunc (*Store) Put() { s.set() }\n\nfunc (s *Store) set() {}\n",
        },
        "store/a.go",
      ),
    ).toEqual(["s.set -> (dropped)"]);
  });

  test("a local function value shadows a package-scope func of the same name", () => {
    // Review reproduction 1: `handler := func(){}` then `handler()`.
    expect(
      resolveCalls(
        {
          "app/a.go": "package app\n\nfunc handler() {}\n\nfunc Run() {\n\thandler := func() {}\n\thandler()\n}\n",
        },
        "app/a.go",
      ),
    ).toEqual([]);
  });

  test("a parameter shadows a package-scope func of the same name", () => {
    // Review reproduction 2: a parameter named `do` over `func do()`.
    expect(
      resolveCalls(
        { "app/a.go": "package app\n\nfunc do() {}\n\nfunc Run(do func()) {\n\tdo()\n}\n" },
        "app/a.go",
      ),
    ).toEqual([]);
  });

  test("an unshadowed call to the same func still resolves (control)", () => {
    expect(
      resolveCalls(
        { "app/a.go": "package app\n\nfunc do() {}\n\nfunc Run() {\n\tdo()\n}\n" },
        "app/a.go",
      ),
    ).toEqual(["do -> app/a.go#do (high)"]);
  });

  test("a range variable, a type-switch alias and a named result all shadow", () => {
    expect(
      resolveCalls(
        {
          "app/a.go":
            "package app\n\nfunc each() {}\nfunc kind() {}\nfunc out() {}\n\n" +
            "func Run(xs []int, v any) (out func()) {\n" +
            "\tfor each := range xs {\n\t\t_ = each\n\t}\n" +
            "\tswitch kind := v.(type) {\n\tcase int:\n\t\t_ = kind\n\t}\n" +
            "\teach()\n\tkind()\n\tout()\n\treturn nil\n}\n",
        },
        "app/a.go",
      ),
    ).toEqual([]);
  });

  test("a local named like an import alias hides that alias too", () => {
    // `store` is bound to the result of `newThing`, which this repo does not
    // declare: the site is recorded against the local, and the local is what
    // keeps the import rule from reading it as the `store` package.
    expect(
      resolveCalls(
        {
          "app/main.go":
            'package main\n\nimport "example.com/m/store"\n\nfunc Run() {\n\tstore := newThing()\n\tstore.New()\n}\n',
          "store/a.go": "package store\n\nfunc New() {}\n",
        },
        "app/main.go",
      ),
    ).toEqual(["newThing -> (dropped)", "store.New -> (dropped)"]);
  });

  test("an explicit alias wins over another import's default local name", () => {
    // The real case: a package whose declared name differs from the last segment
    // of its path (`gopkg.in/yaml.v3` declares `package yaml`, `x/baz` might
    // declare `package bar`). The extractor can only guess the default local
    // from the path, so a written-down alias must always win the name - whatever
    // order the imports appear in. The sources below are written for the
    // extractor, not for `go build`: two imports claiming `bar` would not
    // compile, which is exactly the collision this rule has to break.
    expect(
      resolveCalls(
        {
          "app/main.go":
            'package main\n\nimport (\n\t"example.com/m/y/bar"\n\tbar "example.com/m/x/baz"\n)\n\nfunc Run() { bar.Only() }\n',
          "y/bar/a.go": "package bar\n\nfunc Other() {}\n",
          "x/baz/a.go": "package baz\n\nfunc Only() {}\n",
        },
        "app/main.go",
      ),
    ).toEqual(["bar.Only -> x/baz/a.go#Only (high)"]);
  });

  // -------------------------------------------------------------------------
  // build 2.1: embedded-field promotion (leaf 2.13)
  // -------------------------------------------------------------------------

  test("a receiver call promotes through an embedded field of the same package", () => {
    expect(
      resolveCalls(
        {
          "sqs/a.go":
            "package sqs\n\ntype Inner struct{}\n\nfunc (i *Inner) Promoted() {}\n\n" +
            "type Consumer struct {\n\t*Inner\n}\n\n" +
            "func (c *Consumer) handle() { c.Promoted() }\n",
        },
        "sqs/a.go",
      ),
    ).toEqual(["c.Promoted -> sqs/a.go#Inner.Promoted (high)"]);
  });

  test("a receiver call promotes through an embedded field of an imported package", () => {
    expect(
      resolveCalls(
        {
          "core/base.go": "package core\n\ntype BaseConsumer struct{}\n\nfunc (b *BaseConsumer) ApplyStrategy() {}\n",
          "sqs/a.go":
            'package sqs\n\nimport "example.com/m/core"\n\n' +
            "type Consumer struct {\n\t*core.BaseConsumer\n}\n\n" +
            "func (c *Consumer) handle() { c.ApplyStrategy() }\n",
        },
        "sqs/a.go",
      ),
    ).toEqual(["c.ApplyStrategy -> core/base.go#BaseConsumer.ApplyStrategy (high)"]);
  });

  test("a method declared on the type itself wins over a promoted one", () => {
    expect(
      resolveCalls(
        {
          "sqs/a.go":
            "package sqs\n\ntype Inner struct{}\n\nfunc (i *Inner) M() {}\n\n" +
            "type Consumer struct {\n\tInner\n}\n\nfunc (c *Consumer) M() {}\n\n" +
            "func (c *Consumer) handle() { c.M() }\n",
        },
        "sqs/a.go",
      ),
    ).toEqual(["c.M -> sqs/a.go#Consumer.M (high)"]);
  });

  test("two embedded types supplying the member drop the call rather than guess", () => {
    expect(
      resolveCalls(
        {
          "sqs/a.go":
            "package sqs\n\ntype A struct{}\n\nfunc (a *A) M() {}\n\ntype B struct{}\n\nfunc (b *B) M() {}\n\n" +
            "type Consumer struct {\n\tA\n\tB\n}\n\nfunc (c *Consumer) handle() { c.M() }\n",
        },
        "sqs/a.go",
      ),
    ).toEqual(["c.M -> (dropped)"]);
  });

  test("promotion walks embedded embeds to depth 3 and stops there", () => {
    const chain =
      "package sqs\n\ntype L4 struct{}\n\nfunc (l *L4) Deeper() {}\n\n" +
      "type L3 struct{ L4 }\n\nfunc (l *L3) Deep() {}\n\n" +
      "type L2 struct{ L3 }\n\ntype L1 struct{ L2 }\n\ntype Top struct{ L1 }\n\n";
    // L3 sits at depth 3 from Top (L1, L2, L3) and resolves.
    expect(resolveCalls({ "sqs/a.go": `${chain}func (t *Top) run() { t.Deep() }\n` }, "sqs/a.go")).toEqual([
      "t.Deep -> sqs/a.go#L3.Deep (high)",
    ]);
    // L4 sits at depth 4 and is not searched.
    expect(resolveCalls({ "sqs/a.go": `${chain}func (t *Top) run() { t.Deeper() }\n` }, "sqs/a.go")).toEqual([
      "t.Deeper -> (dropped)",
    ]);
  });

  test("an embedded type from outside the repo promotes nothing", () => {
    expect(
      resolveCalls(
        {
          "sqs/a.go":
            'package sqs\n\nimport "sync"\n\ntype Consumer struct {\n\t*sync.Mutex\n}\n\n' +
            "func (c *Consumer) handle() { c.Lock() }\n",
        },
        "sqs/a.go",
      ),
    ).toEqual(["c.Lock -> (dropped)"]);
  });

  test("a promoted name that no embedded type declares is dropped", () => {
    expect(
      resolveCalls(
        {
          "sqs/a.go":
            "package sqs\n\ntype Inner struct{}\n\ntype Consumer struct {\n\tInner\n}\n\n" +
            "func (c *Consumer) handle() { c.Missing() }\n",
        },
        "sqs/a.go",
      ),
    ).toEqual(["c.Missing -> (dropped)"]);
  });

  // -------------------------------------------------------------------------
  // build 2.1: local and closure receivers (leaf 2.13)
  // -------------------------------------------------------------------------

  /** A package whose `delivery` type carries the method every local test calls. */
  const DELIVERY = "type delivery struct{}\n\nfunc (d *delivery) dispose() {}\n\ntype Consumer struct{}\n\n";

  test("a local bound to a composite literal is a receiver", () => {
    for (const literal of ["&delivery{}", "delivery{}"]) {
      expect(
        resolveCalls(
          {
            "sqs/a.go": `package sqs\n\n${DELIVERY}func (c *Consumer) Park() {\n\td := ${literal}\n\td.dispose()\n}\n`,
          },
          "sqs/a.go",
        ),
      ).toEqual(["d.dispose -> sqs/a.go#delivery.dispose (high)"]);
    }
  });

  test("a local declared with var, by value or by pointer, is a receiver", () => {
    for (const declared of ["var d delivery", "var d *delivery"]) {
      expect(
        resolveCalls(
          { "sqs/a.go": `package sqs\n\n${DELIVERY}func (c *Consumer) Park() {\n\t${declared}\n\td.dispose()\n}\n` },
          "sqs/a.go",
        ),
      ).toEqual(["d.dispose -> sqs/a.go#delivery.dispose (high)"]);
    }
  });

  test("a parameter typed by a named type is a receiver", () => {
    expect(
      resolveCalls(
        { "sqs/a.go": `package sqs\n\n${DELIVERY}func (c *Consumer) Park(d *delivery) {\n\td.dispose()\n}\n` },
        "sqs/a.go",
      ),
    ).toEqual(["d.dispose -> sqs/a.go#delivery.dispose (high)"]);
  });

  test("a local bound to a same-package constructor's first result is a receiver", () => {
    expect(
      resolveCalls(
        {
          "sqs/a.go":
            `package sqs\n\n${DELIVERY}func newDelivery() (*delivery, error) { return nil, nil }\n\n` +
            "func (c *Consumer) Park() {\n\td, err := newDelivery()\n\t_ = err\n\td.dispose()\n}\n",
        },
        "sqs/a.go",
      ),
    ).toEqual(["newDelivery -> sqs/a.go#newDelivery (high)", "d.dispose -> sqs/a.go#delivery.dispose (high)"]);
  });

  test("a local bound to a receiver method's first result is a receiver", () => {
    expect(
      resolveCalls(
        {
          "sqs/a.go":
            `package sqs\n\n${DELIVERY}func (c *Consumer) own() (*delivery, error) { return nil, nil }\n\n` +
            "func (c *Consumer) Park() {\n\td, err := c.own()\n\t_ = err\n\td.dispose()\n}\n",
        },
        "sqs/a.go",
      ),
    ).toEqual(["c.own -> sqs/a.go#Consumer.own (high)", "d.dispose -> sqs/a.go#delivery.dispose (high)"]);
  });

  test("a local receiver used inside a func literal belongs to the enclosing function", () => {
    expect(
      resolveCalls(
        {
          "sqs/a.go":
            `package sqs\n\n${DELIVERY}func (c *Consumer) Wrap() func() {\n\td := &delivery{}\n` +
            "\treturn func() { d.dispose() }\n}\n",
        },
        "sqs/a.go",
      ),
    ).toEqual(["d.dispose -> sqs/a.go#delivery.dispose (high)"]);
  });

  test("a local receiver promotes through its own embedded fields", () => {
    expect(
      resolveCalls(
        {
          "core/base.go": "package core\n\ntype BaseConsumer struct{}\n\nfunc (b *BaseConsumer) ApplyStrategy() {}\n",
          "sqs/a.go":
            'package sqs\n\nimport "example.com/m/core"\n\ntype Consumer struct {\n\t*core.BaseConsumer\n}\n\n' +
            "func Run() {\n\tc := &Consumer{}\n\tc.ApplyStrategy()\n}\n",
        },
        "sqs/a.go",
      ),
    ).toEqual(["c.ApplyStrategy -> core/base.go#BaseConsumer.ApplyStrategy (high)"]);
  });

  test("a name bound to two different types anywhere in one function is withheld", () => {
    expect(
      resolveCalls(
        {
          "sqs/a.go":
            `package sqs\n\n${DELIVERY}type other struct{}\n\nfunc (o *other) dispose() {}\n\n` +
            "func (c *Consumer) Park(ok bool) {\n\td := &delivery{}\n\td.dispose()\n" +
            "\tif ok {\n\t\td := &other{}\n\t\td.dispose()\n\t}\n}\n",
        },
        "sqs/a.go",
      ),
    ).toEqual([]);
  });

  test("a local whose initialiser decides nothing is still withheld", () => {
    expect(
      resolveCalls(
        {
          "sqs/a.go": `package sqs\n\n${DELIVERY}func (c *Consumer) Park(xs []*delivery) {\n\td := xs[0]\n\td.dispose()\n}\n`,
        },
        "sqs/a.go",
      ),
    ).toEqual([]);
  });

  test("a local bound to a function of another package is withheld", () => {
    // `store.New` is resolvable, but nothing in this file says what it returns:
    // the local stays untyped and the call on it is never recorded.
    expect(
      resolveCalls(
        {
          "store/a.go":
            "package store\n\ntype Store struct{}\n\nfunc (s *Store) Put() {}\n\nfunc New() *Store { return nil }\n",
          "app/main.go": 'package main\n\nimport "example.com/m/store"\n\nfunc main() {\n\ts := store.New()\n\ts.Put()\n}\n',
        },
        "app/main.go",
      ),
    ).toEqual(["store.New -> store/a.go#New (high)"]);
  });

  test("the six probe shapes of the evaluation fixture", () => {
    // gofix, the independent evaluator's probe repo: one control and five shapes
    // build 2.1 fixes. Every one of them lands on exactly one declaration.
    const sources = {
      "core/base.go":
        "package core\n\ntype ConsumerHooks interface{ Park() error }\n\ntype BaseConsumer struct{}\n\n" +
        "func (c *BaseConsumer) ApplyStrategy() error { return nil }\n",
      "sqs/consumer.go":
        'package sqs\n\nimport "example.com/m/core"\n\ntype Inner struct{}\n\n' +
        "func (i *Inner) SamePkgPromoted() error { return nil }\n\ntype delivery struct{}\n\n" +
        "func (d *delivery) dispose(action string) error { return nil }\n\n" +
        "type Consumer struct {\n\t*core.BaseConsumer\n\t*Inner\n}\n\n" +
        "func (c *Consumer) control() error { return c.direct() }\n\n" +
        "func (c *Consumer) direct() error { return nil }\n\n" +
        "func (c *Consumer) handleOne() error { return c.ApplyStrategy() }\n\n" +
        "func (c *Consumer) handleTwo() error { return c.SamePkgPromoted() }\n\n" +
        'func (c *Consumer) Park() error {\n\td := &delivery{}\n\treturn d.dispose("park")\n}\n\n' +
        "func (c *Consumer) Wrap() func() error {\n\td := &delivery{}\n" +
        '\treturn func() error { return d.dispose("delete") }\n}\n\n' +
        "var _ core.ConsumerHooks = (*Consumer)(nil)\nvar _ error = (*wrapErr)(nil)\n\n" +
        'type wrapErr struct{}\n\nfunc (w *wrapErr) Error() string { return "" }\n',
    };
    expect(resolveCalls(sources, "sqs/consumer.go")).toEqual([
      "c.direct -> sqs/consumer.go#Consumer.direct (high)",
      "c.ApplyStrategy -> core/base.go#BaseConsumer.ApplyStrategy (high)",
      "c.SamePkgPromoted -> sqs/consumer.go#Inner.SamePkgPromoted (high)",
      "d.dispose -> sqs/consumer.go#delivery.dispose (high)",
      "d.dispose -> sqs/consumer.go#delivery.dispose (high)",
    ]);
  });

  test("a repo with no Go file costs the linker nothing", () => {
    const index = buildGoCallIndex([], []);
    expect(index.functions.size).toBe(0);
    expect(index.aliases.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// the fixture, end to end
// ---------------------------------------------------------------------------

describe("tiny-go", () => {
  let snapshot: Snapshot;

  beforeAll(async () => {
    snapshot = await buildSnapshot({ root: TINY_GO, parser, config: GO_CONFIG });
  });

  const importsOf = (from: string): ImportEdge[] => snapshot.imports.filter((e) => e.from === from);
  const callKeys = (edges: CallEdge[]): string[] => edges.map((e) => `${e.from} -> ${e.to} (${e.confidence})`);

  test("the fixture holds six Go files and indexes five of them", () => {
    const onDisk = readFileSync(join(TINY_GO, "go.mod"), "utf8");
    expect(onDisk).toContain("module example.com/tiny");
    expect(snapshot.files.map((f) => f.path)).toEqual([
      "cmd/app/main.go",
      "internal/retry/backoff.go",
      "internal/retry/retry.go",
      "internal/store/memory.go",
      "internal/store/store.go",
    ]);
    // internal/store/store_test.go is the sixth: DEFAULT_CONFIG excludes **/*_test.go.
    expect(snapshot.files.every((f) => f.lang === "go")).toBe(true);
  });

  test("the module is the root package, detected from go.mod", () => {
    expect(snapshot.packages).toEqual([{ name: "tiny", path: ".", source: "root" }]);
  });

  test("declaration count and kinds are pinned", () => {
    expect(snapshot.symbols.length).toBe(15);
    expect(snapshot.symbols.map((d) => d.id)).toEqual([
      "cmd/app/main.go#main",
      "internal/retry/backoff.go#Backoff",
      "internal/retry/backoff.go#Backoff.Wait",
      "internal/retry/retry.go#DefaultAttempts",
      "internal/retry/retry.go#Do",
      "internal/store/memory.go#NewMemory",
      "internal/store/store.go#DefaultName",
      "internal/store/store.go#ErrClosed",
      "internal/store/store.go#Putter",
      "internal/store/store.go#Store",
      "internal/store/store.go#errorString",
      "internal/store/store.go#errorString.Error",
      "internal/store/store.go#New",
      "internal/store/store.go#Store.Put",
      "internal/store/store.go#Store.set",
    ]);
  });

  test("import edges target package directories, externals keep their import path", () => {
    expect(snapshot.imports.map((e) => `${e.from} -> ${e.to}`)).toEqual([
      "cmd/app/main.go -> ext:fmt",
      "cmd/app/main.go -> internal/retry",
      "cmd/app/main.go -> internal/store",
      "internal/retry/backoff.go -> ext:sort",
      "internal/retry/backoff.go -> ext:time",
      "internal/store/store.go -> internal/retry",
    ]);
    expect(importsOf("internal/retry/backoff.go").map((e) => e.importKind)).toEqual(["side-effect", "static"]);
    expect(snapshot.imports.every((e) => e.kind === "import" && e.confidence === "high")).toBe(true);
  });

  test("exported names per file are the exported top-level declarations", () => {
    const exports = Object.fromEntries(
      Object.entries(snapshot.manifest.files).map(([path, entry]) => [path, entry.exports]),
    );
    expect(exports).toEqual({
      "cmd/app/main.go": [],
      "internal/retry/backoff.go": ["Backoff"],
      "internal/retry/retry.go": ["DefaultAttempts", "Do"],
      "internal/store/memory.go": ["NewMemory"],
      "internal/store/store.go": ["DefaultName", "ErrClosed", "New", "Putter", "Store"],
    });
  });

  test("call sites are extracted before resolution", () => {
    const sites = snapshot.files.flatMap((f) => f.calls.map((c) => `${f.path}: ${c.caller} -> ${c.callee}`));
    expect(sites).toEqual([
      "cmd/app/main.go: main -> store.New",
      "cmd/app/main.go: main -> retry.Do",
      // `s.Put` is a call on the local `s`, and `op()` in retry.Do calls a
      // parameter: both are locally bound, so neither is recorded at all.
      "cmd/app/main.go: main -> fmt.Println",
      "internal/retry/backoff.go: Backoff.Wait -> time.Sleep",
      "internal/store/memory.go: NewMemory -> New",
      "internal/store/store.go:  -> errorString",
      "internal/store/store.go: errorString.Error -> string",
      "internal/store/store.go: Store.Put -> retry.Do",
      "internal/store/store.go: Store.Put -> s.set",
    ]);
  });

  test("calls resolve to same-package declarations, import aliases and method receivers", () => {
    expect(callKeys(snapshot.calls)).toEqual([
      "cmd/app/main.go#main -> internal/retry/retry.go#Do (high)",
      "cmd/app/main.go#main -> internal/store/store.go#New (high)",
      "internal/store/memory.go#NewMemory -> internal/store/store.go#New (high)",
      "internal/store/store.go#Store.Put -> internal/retry/retry.go#Do (high)",
      "internal/store/store.go#Store.Put -> internal/store/store.go#Store.set (high)",
    ]);
  });

  test("type conversions, locals and externals are never call edges", () => {
    const targets = snapshot.calls.map((e) => e.to);
    // `errorString("...")` and `string(e)` are conversions; `s.Put` in main is a local;
    // `fmt.Println` and `time.Sleep` leave the repo; `op()` is a parameter.
    expect(targets).not.toContain("internal/store/store.go#errorString");
    expect(targets.some((t) => t.includes("Store.Put"))).toBe(false);
  });

  test("the build is byte-stable", async () => {
    const again = await buildSnapshot({ root: TINY_GO, parser, config: GO_CONFIG });
    expect(JSON.stringify(again.imports)).toBe(JSON.stringify(snapshot.imports));
    expect(JSON.stringify(again.calls)).toBe(JSON.stringify(snapshot.calls));
    expect(JSON.stringify(again.symbols)).toBe(JSON.stringify(snapshot.symbols));
  });

  test("Go repos have no import cycles to report", () => {
    expect(snapshot.metrics.cycles).toEqual([]);
  });
});
