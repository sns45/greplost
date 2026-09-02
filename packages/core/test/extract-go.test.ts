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
    expect(shape(record)).toEqual([
      ["_", "var", false],
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
    expect(
      resolveCalls(
        {
          "app/main.go":
            'package main\n\nimport "example.com/m/store"\n\nfunc Run() {\n\tstore := newThing()\n\tstore.New()\n}\n',
          "store/a.go": "package store\n\nfunc New() {}\n",
        },
        "app/main.go",
      ),
    ).toEqual(["newThing -> (dropped)"]);
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
