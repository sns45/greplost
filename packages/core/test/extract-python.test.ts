/**
 * Python extraction, resolution and linking (build 2, leaf 2.1; spec section 1.2).
 *
 * Six `describe` blocks, named by the spec: `declarations`, `imports`, `exports`, `calls`,
 * `__all__` and `tiny-python`. The first five run the extractor over one-file sources; the
 * last builds `fixtures/tiny-python` end to end, which is the only place resolution, the
 * export index and the cycle detector are exercised together.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshot } from "../src/build.ts";
import { extractFile } from "../src/extract/index.ts";
import { extractPython } from "../src/extract/python.ts";
import { createParser } from "../src/parser.ts";
import { buildPythonCallIndex, PY_STDLIB, resolvePythonCall } from "../src/resolve/python.ts";
import { createResolver } from "../src/resolve/resolver.ts";
import { DEFAULT_CONFIG, isFileId } from "../src/schema.ts";
import type { GreplostConfig, Snapshot } from "../src/schema.ts";

const parser = await createParser();
const ZERO_SHA = "0".repeat(64);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TINY_PYTHON = join(REPO_ROOT, "fixtures/tiny-python");
const PYTHON_CONFIG: GreplostConfig = { ...DEFAULT_CONFIG, languages: ["python"] };

function run(filePath: string, source: string) {
  const tree = parser.parse(source, "python");
  try {
    return extractPython(filePath, "python", source, tree);
  } finally {
    tree.delete();
  }
}

describe("declarations", () => {
  test("functions, classes, methods and module constants", () => {
    const out = run(
      "m.py",
      "DEFAULT = 3\n\nclass S:\n    def put(self, k):\n        pass\n\nasync def go():\n    pass\n",
    );
    expect(out.decls.map((d) => [d.name, d.kind, d.exported])).toEqual([
      ["DEFAULT", "const", true],
      ["S", "class", true],
      ["S.put", "method", true],
      ["go", "function", true],
    ]);
    expect(out.decls[3]?.signature).toBe("async def go()");
  });

  test("a leading underscore is not exported", () => {
    const out = run("m.py", "def _hidden():\n    pass\n");
    expect(out.decls[0]?.exported).toBe(false);
  });

  test("annotated module assignments keep the annotation and drop the value", () => {
    const out = run("m.py", "size: int = compute()\nNAME = 'x'\n");
    expect(out.decls.map((d) => [d.name, d.kind, d.signature])).toEqual([
      ["size", "var", "size: int"],
      ["NAME", "const", "NAME"],
    ]);
  });

  test("decorators join the signature (first only) and meta.decorators (sorted)", () => {
    const out = run(
      "m.py",
      "@second\n@app.route('/x')\ndef handler():\n    pass\n",
    );
    expect(out.decls[0]?.signature).toBe("@second def handler()");
    expect(out.decls[0]?.meta).toEqual({ decorators: "app.route,second" });
    // The span covers the decorators, not just the `def`.
    expect(out.decls[0]?.span).toEqual([1, 4]);
  });

  test("nested classes carry a dotted path and a parent", () => {
    const out = run("m.py", "class Outer:\n    class Inner:\n        def deep(self):\n            pass\n");
    expect(out.decls.map((d) => [d.name, d.kind, d.parent])).toEqual([
      ["Outer", "class", undefined],
      ["Outer.Inner", "class", "Outer"],
      ["Outer.Inner.deep", "method", "Outer.Inner"],
    ]);
  });

  test("a def inside a def is a local, not a declaration", () => {
    const out = run("m.py", "def top():\n    def inner():\n        pass\n    return inner\n");
    expect(out.decls.map((d) => d.name)).toEqual(["top"]);
  });

  test("a def guarded by a module-level if or try is still a module-level declaration", () => {
    const out = run(
      "m.py",
      "import sys\n\nif sys.version_info >= (3, 12):\n    def modern():\n        pass\nelse:\n    def modern():\n        pass\n",
    );
    expect(out.decls.map((d) => d.name)).toEqual(["modern", "modern"]);
  });

  test("a chained assignment declares every name it binds", () => {
    const out = run("m.py", "a = b = 1\n");
    expect(out.decls.map((d) => [d.name, d.kind])).toEqual([
      ["a", "var"],
      ["b", "var"],
    ]);
  });

  test("every clause of a compound statement is the same scope", () => {
    const out = run(
      "m.py",
      "try:\n    def in_try(): pass\nexcept OSError:\n    def in_except(): pass\nelse:\n    def in_else(): pass\nfinally:\n    def in_finally(): pass\n\nmatch kind:\n    case 1:\n        def in_case(): pass\n",
    );
    expect(out.decls.map((d) => d.name)).toEqual([
      "in_try",
      "in_except",
      "in_else",
      "in_finally",
      "in_case",
    ]);
  });

  test("class-body assignments are attributes, not declarations", () => {
    const out = run("m.py", "class C:\n    field = 1\n    def m(self):\n        pass\n");
    expect(out.decls.map((d) => d.name)).toEqual(["C", "C.m"]);
  });

  test("a property and its setter are two nodes with two ids and one name", () => {
    // `@property def value` beside `@value.setter def value` is the commonest shape in
    // Python and, left alone, both declarations take the id `m.py#C.value`: `query` can
    // never name the second, and `index.members` keeps whichever came first. The `~<n>`
    // suffix the other languages carry (driver ruling 2026-09-04) lands on the id only;
    // the name stays what the source wrote, because that is what a reader searches for.
    const out = run(
      "m.py",
      "class C:\n" +
        "    @property\n    def value(self):\n        return self._v\n\n" +
        "    @value.setter\n    def value(self, v):\n        self._v = v\n",
    );
    expect(out.decls.map((d) => d.id)).toEqual(["m.py#C", "m.py#C.value", "m.py#C.value~2"]);
    expect(out.decls.map((d) => d.name)).toEqual(["C", "C.value", "C.value"]);
  });

  test("a name declared three times in one file numbers from 2 in source order", () => {
    const out = run("m.py", "def f():\n    pass\n\ndef f():\n    pass\n\ndef f():\n    pass\n");
    expect(out.decls.map((d) => d.id)).toEqual(["m.py#f", "m.py#f~2", "m.py#f~3"]);
  });

  test("a redefined module-level name is exported once", () => {
    const out = run("m.py", "def f():\n    pass\n\ndef f():\n    pass\n");
    expect(out.exports).toEqual([{ name: "f", kind: "named" }]);
  });

  test("the signature is clipped and whitespace-collapsed", () => {
    const long = "a".repeat(400);
    const out = run("m.py", `def wide(\n    ${long},\n) -> None:\n    pass\n`);
    const signature = out.decls[0]?.signature ?? "";
    expect(signature.length).toBe(200);
    expect(signature.startsWith("def wide( aaaa")).toBe(true);
    expect(signature.endsWith("…")).toBe(true);
  });
});

describe("imports", () => {
  test("absolute, dotted and aliased plain imports", () => {
    const out = run("m.py", "import os\nimport os.path\nimport numpy as np\n");
    expect(out.imports.map((i) => [i.specifier, i.kind, i.symbols])).toEqual([
      ["os", "static", [{ name: "*", local: "os" }]],
      // `import a.b` binds `a`, never `a.b`.
      ["os.path", "static", [{ name: "*", local: "os" }]],
      ["numpy", "static", [{ name: "*", local: "np" }]],
    ]);
  });

  test("relative imports keep their dots, one per level", () => {
    const out = run(
      "pkg/sub/m.py",
      "from . import sibling\nfrom .mod import thing as t\nfrom ..pkg.deep import x, y\n",
    );
    expect(out.imports.map((i) => i.specifier)).toEqual([".", ".mod", "..pkg.deep"]);
    expect(out.imports[1]?.symbols).toEqual([{ name: "thing", local: "t" }]);
    expect(out.imports[2]?.symbols).toEqual([
      { name: "x", local: "x" },
      { name: "y", local: "y" },
    ]);
  });

  test("a star import is one symbol named *", () => {
    const out = run("m.py", "from .errors import *\n");
    expect(out.imports).toEqual([
      { specifier: ".errors", kind: "static", symbols: [{ name: "*", local: "*" }], reexport: false, line: 1 },
    ]);
  });

  test("`if TYPE_CHECKING:` bodies and __future__ are type imports", () => {
    const out = run(
      "m.py",
      "from __future__ import annotations\nfrom typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from .models import User\nelse:\n    from .stub import User\n",
    );
    expect(out.imports.map((i) => [i.specifier, i.kind])).toEqual([
      ["__future__", "type"],
      ["typing", "static"],
      [".models", "type"],
      // The `else:` branch is the runtime path and is not type-only.
      [".stub", "static"],
    ]);
  });

  test("`typing.TYPE_CHECKING` is the same guard", () => {
    const out = run("m.py", "import typing\n\nif typing.TYPE_CHECKING:\n    from .models import User\n");
    expect(out.imports.map((i) => [i.specifier, i.kind])).toEqual([
      ["typing", "static"],
      [".models", "type"],
    ]);
  });

  test("an import inside a function body is static, not dynamic", () => {
    const out = run("m.py", "def f():\n    from .late import thing\n    return thing\n");
    expect(out.imports.map((i) => [i.specifier, i.kind])).toEqual([[".late", "static"]]);
  });

  test("importlib.import_module with a string literal is dynamic", () => {
    const out = run(
      "m.py",
      "import importlib\nfrom importlib import import_module\n\nm = importlib.import_module('json')\nn = import_module('csv')\no = importlib.import_module(name)\n",
    );
    expect(out.imports.map((i) => [i.specifier, i.kind])).toEqual([
      ["importlib", "static"],
      ["importlib", "static"],
      ["json", "dynamic"],
      ["csv", "dynamic"],
      // A computed argument names no module this extractor can know: nothing is recorded.
    ]);
  });

  test("imports inside try/except are collected wherever they are written", () => {
    const out = run("m.py", "try:\n    import ujson as json\nexcept ImportError:\n    import json\n");
    expect(out.imports.map((i) => [i.specifier, i.symbols[0]?.local])).toEqual([
      ["ujson", "json"],
      ["json", "json"],
    ]);
  });
});

describe("exports", () => {
  test("public declarations are the surface when there is no __all__", () => {
    const out = run("m.py", "SIZE = 1\n_hidden = 2\n\n\ndef f():\n    pass\n\n\nclass C:\n    def m(self):\n        pass\n");
    expect(out.exports).toEqual([
      { name: "C", kind: "named" },
      { name: "SIZE", kind: "named" },
      { name: "f", kind: "named" },
    ]);
  });

  test("a method is never a module export", () => {
    const out = run("m.py", "class C:\n    def m(self):\n        pass\n");
    expect(out.exports.map((e) => e.name)).toEqual(["C"]);
  });

  test("an __all__ entry naming an import is a re-export carrying its specifier", () => {
    const out = run("m.py", "from .store import Store\nfrom os import sep\n\n__all__ = ['Store', 'sep']\n");
    expect(out.exports).toEqual([
      { name: "Store", kind: "named", from: ".store", local: "Store" },
      { name: "sep", kind: "named", from: "os", local: "sep" },
    ]);
  });

  test("Python never emits a default or a star export", () => {
    const out = run("m.py", "from .errors import *\n\ndef f():\n    pass\n");
    expect(out.exports.every((e) => e.kind === "named")).toBe(true);
  });
});

describe("__all__", () => {
  test("it exports a private name and withholds a public one", () => {
    const out = run("m.py", "def _private():\n    pass\n\n\ndef public():\n    pass\n\n\n__all__ = ['_private']\n");
    expect(out.decls.map((d) => [d.name, d.exported])).toEqual([
      ["_private", true],
      ["public", false],
    ]);
    expect(out.exports.map((e) => e.name)).toEqual(["_private"]);
  });

  test("a tuple and a bare expression list count as literals", () => {
    const bare = run("m.py", "def a():\n    pass\n\n\ndef b():\n    pass\n\n\n__all__ = 'a', 'b'\n");
    expect(bare.decls.map((d) => d.exported)).toEqual([true, true]);
    const tuple = run("m.py", "def a():\n    pass\n\n\ndef b():\n    pass\n\n\n__all__ = ('a',)\n");
    expect(tuple.decls.map((d) => d.exported)).toEqual([true, false]);
  });

  test("`__all__ +=` widens the surface", () => {
    const out = run(
      "m.py",
      "def a():\n    pass\n\n\ndef b():\n    pass\n\n\n__all__ = ['a']\n__all__ += ['b']\n",
    );
    expect(out.decls.map((d) => d.exported)).toEqual([true, true]);
  });

  test("a comment between entries, and an implicitly concatenated name, still read", () => {
    // Both forms are everywhere in real `__all__` blocks; either one silently turning the
    // whole surface unreadable is how an export set goes wrong across a whole corpus.
    const out = run(
      "m.py",
      "def alpha():\n    pass\n\n\ndef beta():\n    pass\n\n\n__all__ = (\n    # the good one\n    'al' 'pha',\n)\n",
    );
    expect(out.decls.map((d) => [d.name, d.exported])).toEqual([
      ["alpha", true],
      ["beta", false],
    ]);
  });

  test("one unreadable write makes the whole surface unreadable, in any order", () => {
    const later =
      "def _private():\n    pass\n\n\n__all__ = ['_private']\nif FLAG:\n    __all__ = compute()\n";
    const out = run("m.py", later);
    expect(out.decls.map((d) => [d.name, d.exported])).toEqual([["_private", false]]);
  });

  test("a computed __all__ falls back to the underscore rule rather than guessing", () => {
    const out = run(
      "m.py",
      "from .base import __all__ as base_all\n\n\ndef _private():\n    pass\n\n\ndef public():\n    pass\n\n\n__all__ = base_all + ['_private']\n",
    );
    expect(out.decls.map((d) => [d.name, d.exported])).toEqual([
      ["_private", false],
      ["public", true],
    ]);
  });

  test("__all__ governs module names only, never members", () => {
    const out = run("m.py", "class C:\n    def put(self):\n        pass\n\n\n__all__ = ['C']\n");
    expect(out.decls.map((d) => [d.name, d.exported])).toEqual([
      ["C", true],
      ["C.put", true],
    ]);
  });

  test("__all__ is the statement of the surface, never a declaration of its own", () => {
    // Emitting it would put `__all__` on every Python module's card, and
    // `__all__ = [...]` followed by `__all__ += [...]` would emit one symbol id twice.
    const out = run("m.py", "SIZE = 1\n\n\ndef a():\n    pass\n\n\n__all__ = ['a']\n__all__ += ['SIZE']\n");
    expect(out.decls.map((d) => d.name)).toEqual(["SIZE", "a"]);
    expect(out.exports.map((e) => e.name)).toEqual(["SIZE", "a"]);
  });
});

describe("calls", () => {
  test("plain, qualified and self calls, with the caller attributed", () => {
    const out = run(
      "m.py",
      "import mod\n\n\nclass C:\n    def put(self, k):\n        self.record(k)\n        mod.helper(k)\n\n    def record(self, k):\n        pass\n\n\ndef main():\n    top()\n",
    );
    expect(out.calls.map((c) => [c.caller, c.callee])).toEqual([
      ["C.put", "this.record"],
      ["C.put", "mod.helper"],
      ["main", "top"],
    ]);
  });

  test("a constructor call is a plain name call: Python has no `new`", () => {
    const out = run("m.py", "from .store import Store\n\n\ndef make():\n    return Store()\n");
    expect(out.calls.map((c) => c.callee)).toEqual(["Store"]);
  });

  test("deeper chains, subscripts and calls on call results are dropped", () => {
    const out = run("m.py", "def f():\n    a.b.c()\n    d[0]()\n    e()()\n    g()\n");
    expect(out.calls.map((c) => c.callee)).toEqual(["e", "g"]);
  });

  test("a callee bound locally is withheld, never guessed at the module name", () => {
    const out = run(
      "m.py",
      "def helper():\n    pass\n\n\ndef f(fn):\n    helper = fn\n    helper()\n    fn()\n    store = Store()\n    store.put(1)\n",
    );
    // `helper` and `fn` are locals; `store` is a local, so `store.put` is not a module call.
    expect(out.calls.map((c) => c.callee)).toEqual(["Store"]);
  });

  test("every binding form shadows: as-clauses, comprehensions, walruses and local imports", () => {
    const out = run(
      "m.py",
      [
        "def handler():",
        "    pass",
        "",
        "",
        "def f(items):",
        "    try:",
        "        pass",
        "    except OSError as handler:",
        "        handler()",
        "    with open('x') as opener:",
        "        opener()",
        "    picked = [p for p in items]",
        "    picked()",
        "    if (walrus := 1):",
        "        walrus()",
        "    from .late import shadowed",
        "    shadowed()",
        "    return None",
        "",
      ].join("\n"),
    );
    // Every callee written against a bound name is withheld; `open(...)` is the one call
    // that names nothing local, and the linker drops it as a builtin later.
    expect(out.calls.map((c) => c.callee)).toEqual(["open"]);
  });

  test("the module path of a `from` import binds nothing and never shadows", () => {
    const out = run("m.py", "def f():\n    from helper import thing\n    helper()\n    return thing\n");
    // `helper` is the module path, not a name the statement bound: the call stays.
    expect(out.calls.map((c) => c.callee)).toEqual(["helper"]);
  });

  test("a class body's own names shadow the module, but a method's body does not see them", () => {
    const out = run(
      "m.py",
      [
        "def helper():",
        "    pass",
        "",
        "",
        "class C:",
        "    helper = 2",
        "    made = helper()",
        "",
        "    def use(self):",
        "        return helper()",
        "",
      ].join("\n"),
    );
    // `helper()` in the class body calls the class attribute; inside `use` the class
    // namespace is not in scope, so that one really is the module-level `helper`.
    expect(out.calls.map((c) => [c.caller, c.callee])).toEqual([["C.use", "helper"]]);
  });

  test("a class attribute with only an annotation binds nothing", () => {
    const out = run("m.py", "def helper():\n    pass\n\n\nclass C:\n    helper: int\n    made = helper()\n");
    // `helper: int` declares a type and binds no value, so the call is the module's.
    expect(out.calls.map((c) => [c.caller, c.callee])).toEqual([["C", "helper"]]);
  });

  test("a `global` name is not a local binding", () => {
    const out = run(
      "m.py",
      "def helper():\n    pass\n\n\ndef f():\n    global helper\n    helper()\n",
    );
    expect(out.calls.map((c) => c.callee)).toEqual(["helper"]);
  });

  test("a call written at module level has no caller", () => {
    const out = run("m.py", "configure()\n");
    expect(out.calls).toEqual([{ caller: "", callee: "configure", line: 1 }]);
  });

  test("a call inside a nested def belongs to the enclosing declaration", () => {
    const out = run("m.py", "def outer():\n    def inner():\n        target()\n    return inner\n");
    expect(out.calls.map((c) => [c.caller, c.callee])).toEqual([["outer", "target"]]);
  });
});

describe("tiny-python", () => {
  let snapshot: Snapshot;

  beforeAll(async () => {
    snapshot = await buildSnapshot({ root: TINY_PYTHON, parser, config: PYTHON_CONFIG });
  });

  const targets = (from: string): string[] =>
    snapshot.imports
      .filter((e) => e.from === from)
      .map((e) => e.to)
      .sort();

  test("the fixture holds eight Python files and indexes seven of them", () => {
    expect(snapshot.files.map((f) => f.path)).toEqual([
      "tiny/__init__.py",
      "tiny/app.py",
      "tiny/cycle_a.py",
      "tiny/cycle_b.py",
      "tiny/plugins.py",
      "tiny/retry.py",
      "tiny/store.py",
    ]);
    // The eighth file exists and is excluded by `DEFAULT_CONFIG.exclude`'s `**/test_*.py`.
    expect(existsSync(join(TINY_PYTHON, "tests/test_store.py"))).toBe(true);
  });

  test("a literal importlib.import_module is a dynamic import edge, a computed one is not", () => {
    const edges = snapshot.imports.filter((e) => e.from === "tiny/plugins.py");
    // Two static edges to `importlib`: `import importlib` and `from importlib import
    // import_module` are one specifier with two symbol sets, which `linkImports` keeps apart.
    expect(edges.map((e) => [e.specifier, e.importKind, e.to, (e.symbols ?? []).join(",")]).sort()).toEqual([
      ["importlib", "static", "ext:importlib", "*"],
      ["importlib", "static", "ext:importlib", "import_module"],
      ["tiny.retry", "dynamic", "tiny/retry.py", ""],
      ["tiny.store", "dynamic", "tiny/store.py", ""],
    ]);
    // `import_module(name)` and `import_module(PLUGIN)` name no module a reader can follow.
    expect(edges.some((e) => e.specifier === "name" || e.specifier === "PLUGIN")).toBe(false);
  });

  test("relative and absolute imports resolve inside the package", () => {
    expect(targets("tiny/app.py")).toEqual(["tiny/__init__.py", "tiny/retry.py", "tiny/store.py"]);
    expect(targets("tiny/__init__.py")).toEqual(["tiny/retry.py", "tiny/store.py"]);
    expect(targets("tiny/cycle_a.py")).toEqual(["tiny/cycle_b.py"]);
  });

  test("a package specifier targets its __init__.py, which is a file id", () => {
    const edge = snapshot.imports.find((e) => e.from === "tiny/app.py" && e.specifier === ".");
    expect(edge?.to).toBe("tiny/__init__.py");
    for (const other of snapshot.imports) {
      if (isFileId(other.to)) expect(other.to.endsWith(".py")).toBe(true);
    }
  });

  test("a package importing itself is not an edge", () => {
    // `tiny/__init__.py` names the package it is; `from . import x` written there would
    // resolve to itself, and a self-loop is not a dependency between files (leaf 2.3).
    expect(snapshot.imports.some((e) => e.from === e.to)).toBe(false);
  });

  test("the one import cycle is found", () => {
    expect(snapshot.metrics.cycles).toEqual([["tiny/cycle_a.py", "tiny/cycle_b.py"]]);
  });

  test("__all__ decides the package surface", () => {
    expect(snapshot.manifest.files["tiny/__init__.py"]?.exports).toEqual(["Store", "retry"]);
    expect(snapshot.manifest.files["tiny/store.py"]?.exports).toEqual(["DEFAULT_SIZE", "Store"]);
    // cycle_b lists only `b`, so the public `unlisted` is withheld.
    expect(snapshot.manifest.files["tiny/cycle_b.py"]?.exports).toEqual(["b"]);
  });

  test("the five call rules resolve, and nothing else does", () => {
    expect(snapshot.calls.map((e) => `${e.from} -> ${e.to} (${e.confidence})`)).toEqual([
      // a module alias (`import tiny.retry as r`)
      "tiny/app.py#boot -> tiny/retry.py#retry (high)",
      // a name re-exported through exactly one __init__.py
      "tiny/app.py#main -> tiny/retry.py#retry (med)",
      // a constructor call is a plain name call resolved to the class declaration
      "tiny/app.py#main -> tiny/store.py#Store (high)",
      // a name imported directly from the file that declares it
      "tiny/cycle_a.py#a -> tiny/cycle_b.py#b (high)",
      // a top-level name of the caller's own file
      "tiny/retry.py#retry -> tiny/retry.py#_backoff (high)",
      // `self.method` inside a class, normalised to the schema's `this.` form
      "tiny/store.py#Store.put -> tiny/store.py#Store._record (high)",
    ]);
    // `store.put(...)` in app.py is a call on a local: withheld, never guessed at the class.
    expect(snapshot.calls.some((e) => e.to.endsWith("#Store.put"))).toBe(false);
    // `fn()` in retry.py is a call on a parameter, and `range(...)` leaves the repo.
    expect(snapshot.calls.some((e) => e.from === "tiny/retry.py#retry" && e.to.includes("fn"))).toBe(false);
  });

  test("the standalone Python call index agrees with the shared linker", () => {
    const index = buildPythonCallIndex(snapshot.files, snapshot.imports);
    const resolved: string[] = [];
    for (const file of snapshot.files) {
      for (const site of file.calls) {
        const hit = resolvePythonCall(file, site, index);
        if (hit === null) continue;
        const key = `${site.caller === "" ? file.path : `${file.path}#${site.caller}`} -> ${hit.to} (${hit.confidence})`;
        if (!resolved.includes(key)) resolved.push(key);
      }
    }
    expect(resolved.sort()).toEqual([
      "tiny/app.py#boot -> tiny/retry.py#retry (high)",
      "tiny/app.py#main -> tiny/retry.py#retry (med)",
      "tiny/app.py#main -> tiny/store.py#Store (high)",
      "tiny/cycle_a.py#a -> tiny/cycle_b.py#b (high)",
      "tiny/retry.py#retry -> tiny/retry.py#_backoff (high)",
      "tiny/store.py#Store.put -> tiny/store.py#Store._record (high)",
    ]);
  });

  test("import roots come from the sections that declare them, and never repeat", () => {
    // A `from = "..."` under some unrelated tool's table is not a package root, and a bare
    // pattern match would have made `docs` one. `""` is the repo root and appears once.
    const pyproject = [
      "[project]",
      'name = "app"',
      "",
      "[tool.setuptools.package-dir]",
      '"" = "lib"',
      "",
      "[tool.towncrier]",
      'from = "docs"',
      "",
      "[tool.mypy]",
      'packages = ["app"]',
      "",
    ].join("\n");
    const resolver = createResolver({
      root: TINY_PYTHON,
      files: new Set(["lib/app/__init__.py", "lib/app/mod.py", "docs/app/mod.py"]),
      packages: [],
      readFile: (rel) => (rel === "pyproject.toml" ? pyproject : null),
    });
    expect(resolver.resolve("lib/app/mod.py", "app.mod", "python")).toEqual({
      type: "file",
      path: "lib/app/mod.py",
    });
    // `docs` was never a root, so `app.mod` can only ever be the one under `lib`.
    expect(resolver.resolve("lib/app/mod.py", "app", "python")).toEqual({
      type: "file",
      path: "lib/app/__init__.py",
    });
  });

  test("a poetry src layout is read from its own table", () => {
    const pyproject = [
      "[tool.poetry]",
      'name = "app"',
      'packages = [{ include = "app", from = "src" }]',
      "",
    ].join("\n");
    const resolver = createResolver({
      root: TINY_PYTHON,
      files: new Set(["src/app/__init__.py", "src/app/mod.py"]),
      packages: [],
      readFile: (rel) => (rel === "pyproject.toml" ? pyproject : null),
    });
    expect(resolver.resolve("src/app/mod.py", "app.mod", "python")).toEqual({
      type: "file",
      path: "src/app/mod.py",
    });
  });

  test("a namespace package's submodule resolves through the `from` import that names it", async () => {
    // The exact repo from the driver's probe, built the way `bench:structural` builds one.
    // `ns/` is a PEP 420 namespace package: no `__init__.py`, so the specifier `ns` names no
    // module file, and the only thing that can decide the edge is the imported symbol.
    const root = mkdtempSync(join(tmpdir(), "greplost-ns-"));
    try {
      mkdirSync(join(root, "ns"), { recursive: true });
      writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "probe"\n');
      writeFileSync(join(root, "ns", "mod.py"), "def go():\n    return 1\n");
      writeFileSync(
        join(root, "user.py"),
        "from ns import mod\nfrom ns import missing\nimport requests\n",
      );
      const built = await buildSnapshot({ root, config: PYTHON_CONFIG });
      // The edge *set* is what the map and S1 are about, and it is exact: the file imports
      // `ns/mod.py` and `requests`, and nothing else.
      expect([...new Set(built.imports.map((e) => `${e.from} -> ${e.to}`))].sort()).toEqual([
        "user.py -> ext:pypi/requests",
        "user.py -> ns/mod.py",
      ]);
      // No edge points at the namespace directory, and none was invented for a distribution
      // that is really a directory of this repo.
      expect(built.imports.some((e) => e.to === "unresolved:ns" || e.to === "ext:pypi/ns")).toBe(false);

      // The limit, pinned so it is a decision rather than a surprise: both statements write
      // the specifier `ns`, and `Resolver.resolve` is given a specifier and memoised per
      // (lang, file, specifier) - so one answer serves both records, and the second line's
      // `symbols` attribution is approximate. Per-statement precision needs `link.ts` to pass
      // `record.symbols` through; see the leaf report.
      const lines = built.imports
        .filter((e) => e.specifier === "ns")
        .map((e) => `${(e.symbols ?? []).join(",")} -> ${e.to}`)
        .sort();
      expect(lines).toEqual(["missing -> ns/mod.py", "mod -> ns/mod.py"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a namespace import that names nothing indexed stays unresolved", () => {
    // The common case - a typo, or a submodule not written yet - must never become an edge.
    const resolver = createResolver({
      root: TINY_PYTHON,
      files: new Set(["ns/mod.py", "user.py"]),
      packages: [],
      readFile: (rel) => (rel === "user.py" ? "from ns import missing\n" : null),
    });
    expect(resolver.resolve("user.py", "ns", "python")).toEqual({ type: "unresolved" });
  });

  test("two candidate submodules in one statement are ambiguous, so neither is guessed", () => {
    const resolver = createResolver({
      root: TINY_PYTHON,
      files: new Set(["ns/mod.py", "ns/other.py", "user.py"]),
      packages: [],
      readFile: (rel) => (rel === "user.py" ? "from ns import mod, other\n" : null),
    });
    // One import record carries one target, and picking one of two would be a guess.
    expect(resolver.resolve("user.py", "ns", "python")).toEqual({ type: "unresolved" });
  });

  test("the standard library and third-party distributions are external, never a file", () => {
    const resolver = createResolver({
      root: TINY_PYTHON,
      files: new Set(snapshot.files.map((f) => f.path)),
      packages: snapshot.packages,
      readFile: () => null,
    });
    expect(resolver.resolve("tiny/app.py", "os", "python")).toEqual({ type: "external", pkg: "os" });
    expect(resolver.resolve("tiny/app.py", "os.path", "python")).toEqual({ type: "external", pkg: "os" });
    expect(resolver.resolve("tiny/app.py", "numpy.linalg", "python")).toEqual({
      type: "external",
      pkg: "pypi/numpy",
    });
    // A relative specifier that names nothing indexed is unresolved, never invented.
    expect(resolver.resolve("tiny/app.py", ".nope", "python")).toEqual({ type: "unresolved" });
    // A PEP 420 namespace package in the repo is never a pypi distribution: `ns` holds
    // indexed files but no `__init__.py`, so it is unresolved, and `ns.mod` is the file.
    const withNamespace = createResolver({
      root: TINY_PYTHON,
      files: new Set([...snapshot.files.map((f) => f.path), "ns/mod.py", "ns/deep/leaf.py"]),
      packages: snapshot.packages,
      readFile: () => null,
    });
    expect(withNamespace.resolve("tiny/app.py", "ns", "python")).toEqual({ type: "unresolved" });
    expect(withNamespace.resolve("tiny/app.py", "ns.deep", "python")).toEqual({ type: "unresolved" });
    expect(withNamespace.resolve("tiny/app.py", "ns.mod", "python")).toEqual({
      type: "file",
      path: "ns/mod.py",
    });
    expect(withNamespace.resolve("tiny/app.py", "ns.deep.leaf", "python")).toEqual({
      type: "file",
      path: "ns/deep/leaf.py",
    });
    // A submodule of the namespace package that does not exist is still *in the repo*: the
    // reader can open `ns/`, so naming a pypi distribution for it would be a fabrication.
    expect(withNamespace.resolve("tiny/app.py", "ns.missing", "python")).toEqual({ type: "unresolved" });
    expect(withNamespace.resolve("tiny/app.py", "ns.deep.gone", "python")).toEqual({ type: "unresolved" });
    expect(withNamespace.resolve("tiny/app.py", "ns.a.b.c.d", "python")).toEqual({ type: "unresolved" });
    // A name that only *prefixes* an indexed directory is still external.
    expect(withNamespace.resolve("tiny/app.py", "n", "python")).toEqual({
      type: "external",
      pkg: "pypi/n",
    });
    expect(withNamespace.resolve("tiny/app.py", "n.missing", "python")).toEqual({
      type: "external",
      pkg: "pypi/n",
    });
    // And a real distribution whose name matches no directory is untouched.
    expect(withNamespace.resolve("tiny/app.py", "numpy.linalg.norm", "python")).toEqual({
      type: "external",
      pkg: "pypi/numpy",
    });
    // The stdlib list is a committed literal, never read from the host interpreter.
    expect(PY_STDLIB.has("os")).toBe(true);
    expect(PY_STDLIB.has("tomllib")).toBe(true);
    expect(PY_STDLIB.has("numpy")).toBe(false);
    expect([...PY_STDLIB].length).toBe(297);
    const record = extractFile(
      { path: "m.py", lang: "python", source: "import os\nimport numpy\n", sha256: ZERO_SHA },
      parser,
    );
    expect(record.imports.map((i) => i.specifier)).toEqual(["os", "numpy"]);
  });
});
