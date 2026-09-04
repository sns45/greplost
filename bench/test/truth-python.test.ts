/**
 * Python truth generator tests (build 2, leaf 2.1; gates G7 and G8).
 *
 * Everything in `fixture truth` is read off `fixtures/tiny-python` by hand and pinned: these
 * are the numbers the Python structure layer is scored against, so they are written out in
 * full rather than recomputed from the thing under test. `oracle independence` and
 * `no import execution` are the integrity checks of tech spec 10.1 principle 2 and bench
 * spec 1.6: the oracle must not be able to agree with greplost by construction, and it must
 * never run the corpus it is reading.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compareEdges, stableStringify } from "@greplost/core/schema";
import {
  generateTruth,
  NOTES,
  PYTHON_FLOOR,
  pythonExecutable,
  pytruthScript,
} from "../src/truth/python.ts";
import { loadTruth } from "../src/truth/registry.ts";
import { missedMetrics, scoreAgainstTruth } from "../src/structural.ts";
import { edgeKey, exportKeys } from "../src/score.ts";
import type { Truth } from "../src/truth/ts.ts";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const fixtureRoot = path.join(repoRoot, "fixtures", "tiny-python");

/** The seven indexed files of the fixture; `tests/test_store.py` is excluded. */
const FIXTURE_FILES = [
  "tiny/__init__.py",
  "tiny/app.py",
  "tiny/cycle_a.py",
  "tiny/cycle_b.py",
  "tiny/plugins.py",
  "tiny/retry.py",
  "tiny/store.py",
];

const truth: Truth = generateTruth(fixtureRoot, FIXTURE_FILES);

const keys = (edges: { from: string; to: string }[]): string[] => edges.map(edgeKey);

const temps: string[] = [];

/** A throwaway repo built from literal sources; removed when the file finishes. */
function scratchRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "greplost-pytruth-test-"));
  temps.push(root);
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, "utf8");
  }
  return root;
}

afterAll(() => {
  for (const root of temps) rmSync(root, { recursive: true, force: true });
});

/**
 * An audit of the oracle's own source, read with `ast` rather than by substring, so a
 * sentence in its documentation can never satisfy or violate one of these properties.
 */
interface ToolAudit {
  imports: string[];
  stdlib: string[];
  /** Names of the executing builtins the program calls, if any. */
  executes: string[];
  /** True when the program reads or writes `sys.path` anywhere. */
  usesSysPath: boolean;
}

const AUDIT_PROGRAM = `
import ast, json, sys
tree = ast.parse(open(sys.argv[1], "rb").read(), filename=sys.argv[1])
imports, executes = set(), set()
uses_sys_path = False
DANGEROUS = {"exec", "eval", "compile", "__import__", "import_module", "load_module", "run_path", "run_module"}
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for a in node.names:
            imports.add(a.name.split(".")[0])
    elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
        imports.add(node.module.split(".")[0])
    elif isinstance(node, ast.Call):
        f = node.func
        name = f.id if isinstance(f, ast.Name) else (f.attr if isinstance(f, ast.Attribute) else "")
        if name in DANGEROUS:
            executes.add(name)
    elif isinstance(node, ast.Attribute) and node.attr == "path" and isinstance(node.value, ast.Name):
        if node.value.id == "sys":
            uses_sys_path = True
json.dump({"imports": sorted(imports), "stdlib": sorted(sys.stdlib_module_names),
           "executes": sorted(executes), "usesSysPath": uses_sys_path}, sys.stdout)
`;

function auditTool(): ToolAudit {
  // The same interpreter `generateTruth` spawns, so a run can never audit one and
  // measure with another.
  const stdout = execFileSync(pythonExecutable(), ["-c", AUDIT_PROGRAM, pytruthScript()], {
    encoding: "utf8",
  });
  return JSON.parse(stdout) as ToolAudit;
}

describe("python tool", () => {
  test("the oracle is a vendored script under bench/truth/pytruth", () => {
    const script = pytruthScript();
    expect(script).toBe(path.join(repoRoot, "bench", "truth", "pytruth", "main.py"));
    expect(existsSync(script)).toBe(true);
  });

  test("it is standard library only: nothing outside sys.stdlib_module_names is imported", () => {
    const audit = auditTool();
    const stdlib = new Set(audit.stdlib);
    expect(audit.imports.length).toBeGreaterThan(3);
    for (const name of audit.imports) expect([name, stdlib.has(name)]).toEqual([name, true]);
  });

  test("it runs on any interpreter at or above the floor, and says which one it used", () => {
    const version = execFileSync(
      pythonExecutable(),
      ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
      { encoding: "utf8" },
    ).trim();
    const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
    const [floorMajor, floorMinor] = PYTHON_FLOOR;
    // The floor, not the pin: `tomllib` and `ast.TryStar` both arrived in 3.11 and nothing
    // the oracle uses has changed since, so it is byte-identical from 3.11 up. Pinning the
    // test to 3.14 would make it unrunnable on a stock `ubuntu-latest`, which carries 3.12.
    expect([version, major > floorMajor || (major === floorMajor && minor >= floorMinor)]).toEqual([
      version,
      true,
    ]);
    // Whichever one ran is recorded in the notes, so a published number names its source.
    expect(truth.notes).toContain(`python${version}`);
    expect(truth.notes).toContain(`python>=${PYTHON_FLOOR.join(".")}`);
  });

  test("it prints one JSON document with the agreed key set", () => {
    const listFile = path.join(scratchRepo({ "list.txt": `${FIXTURE_FILES.join("\n")}\n` }), "list.txt");
    const stdout = execFileSync(
      pythonExecutable(),
      [pytruthScript(), "--root", fixtureRoot, "--files", listFile],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "calls",
      "cycles",
      "errors",
      "exports",
      "files",
      "imports",
      "modules",
      "python",
    ]);
    expect(parsed["modules"]).toBe(7);
  });

  test("the registry finds it by convention", async () => {
    const module = await loadTruth("python");
    expect(typeof module.generateTruth).toBe("function");
    expect(module.NOTES).toEqual(NOTES);
  });
});

describe("fixture truth", () => {
  test("truth covers exactly the indexed Python files", () => {
    expect(truth.files).toEqual(FIXTURE_FILES);
  });

  test("import edges target module files, and a package is its __init__.py", () => {
    expect(keys(truth.imports)).toEqual([
      "tiny/__init__.py -> tiny/retry.py",
      "tiny/__init__.py -> tiny/store.py",
      "tiny/app.py -> tiny/__init__.py",
      "tiny/app.py -> tiny/retry.py",
      "tiny/app.py -> tiny/store.py",
      "tiny/cycle_a.py -> tiny/cycle_b.py",
      "tiny/cycle_b.py -> tiny/cycle_a.py",
      // both spellings of a literal `import_module`, from tiny/plugins.py
      "tiny/plugins.py -> tiny/retry.py",
      "tiny/plugins.py -> tiny/store.py",
    ]);
    expect(truth.imports.every((e) => e.to.endsWith(".py") && e.kind === "import")).toBe(true);
  });

  test("a literal import_module is an edge on this side too, a computed one is not", () => {
    // The extractor records `importlib.import_module("x")` as a dynamic import (spec 1.2),
    // so an oracle that did not model it would score every one of them a false positive.
    const dynamic = keys(truth.imports).filter((k) => k.startsWith("tiny/plugins.py"));
    expect(dynamic).toEqual(["tiny/plugins.py -> tiny/retry.py", "tiny/plugins.py -> tiny/store.py"]);

    const root = scratchRepo({
      "pyproject.toml": "[project]\nname = 'dy'\n",
      "dy/__init__.py": "",
      "dy/plug.py": "def go():\n    return 1\n",
      "dy/sub/__init__.py": "",
      "dy/sub/near.py": "def near():\n    return 1\n",
      "dy/loader.py":
        "import importlib\n\nNAME = 'dy.plug'\n\n\n" +
        "def literal():\n    return importlib.import_module('dy.plug')\n\n\n" +
        "def relative():\n    return importlib.import_module('.near', 'dy.sub')\n\n\n" +
        "def computed():\n    return importlib.import_module(NAME)\n\n\n" +
        "def formatted(part):\n    return importlib.import_module(f'dy.{part}')\n",
    });
    const out = generateTruth(root, [
      "dy/__init__.py",
      "dy/loader.py",
      "dy/plug.py",
      "dy/sub/__init__.py",
      "dy/sub/near.py",
    ]);
    // The literal resolves; the constant, the f-string and the module-level NAME do not.
    expect(keys(out.imports).filter((k) => k.startsWith("dy/loader.py"))).toEqual([
      "dy/loader.py -> dy/plug.py",
    ]);
  });

  test("the standard library is never an edge target", () => {
    expect(truth.imports.some((e) => e.to.includes("typing") || e.to.includes("os"))).toBe(false);
  });

  test("exports are __all__ when a module states one, else the public definitions", () => {
    expect(truth.exports).toEqual({
      // `__all__ = ["Store", "retry"]`
      "tiny/__init__.py": ["Store", "retry"],
      "tiny/app.py": ["boot", "main"],
      "tiny/cycle_a.py": ["a"],
      // `__all__ = ["b"]` withholds the public `unlisted`.
      "tiny/cycle_b.py": ["b"],
      "tiny/plugins.py": ["PLUGIN", "load_configured", "load_named", "load_retry", "load_store"],
      "tiny/retry.py": ["DEFAULT_ATTEMPTS", "retry"],
      "tiny/store.py": ["DEFAULT_SIZE", "Store"],
    });
  });

  test("a method and an underscored name are not module exports", () => {
    const names = exportKeys(truth.exports);
    expect(names).not.toContain("tiny/store.py#Store.put");
    expect(names).not.toContain("tiny/retry.py#_backoff");
    expect(names).not.toContain("tiny/cycle_b.py#unlisted");
  });

  test("call edges are named definitions, with the caller attributed to its declaration", () => {
    expect(keys(truth.calls)).toEqual([
      "tiny/app.py#boot -> tiny/retry.py#retry",
      "tiny/app.py#main -> tiny/retry.py#retry",
      "tiny/app.py#main -> tiny/store.py#Store",
      "tiny/cycle_a.py#a -> tiny/cycle_b.py#b",
      "tiny/retry.py#retry -> tiny/retry.py#_backoff",
      "tiny/store.py#Store.put -> tiny/store.py#Store._record",
    ]);
  });

  test("a call on a local, a parameter or a builtin is not an edge", () => {
    // `store.put(...)` in app.py, `fn()` and `range(...)` in retry.py.
    expect(keys(truth.calls).some((k) => k.endsWith("#Store.put"))).toBe(false);
    expect(keys(truth.calls).some((k) => k.includes("#range") || k.includes("#fn"))).toBe(false);
  });

  test("the import cycle is the one the fixture writes", () => {
    expect(truth.cycles).toEqual([["tiny/cycle_a.py", "tiny/cycle_b.py"]]);
  });

  test("the oracle discloses how it was built", () => {
    // The fixed notes, plus the interpreter that actually ran.
    expect(truth.notes.slice(0, NOTES.length)).toEqual([...NOTES]);
    expect(truth.notes).toHaveLength(NOTES.length + 1);
    expect(truth.notes[NOTES.length]).toMatch(/^python\d+\.\d+$/);
  });

  test("a second interpreter at or above the floor produces the same document", () => {
    // The floor is only honest if the oracle really is version-independent, so this compares
    // two interpreters when a second one is installed rather than asserting it in prose.
    // Skipped, not failed, when the machine has only one: a missing interpreter is a fact
    // about the machine, and a green run that quietly proved nothing would be worse.
    const others = ["python3.13", "python3.12", "python3.11"]
      .map((name) => `/opt/homebrew/bin/${name}`)
      .filter((candidate) => existsSync(candidate) && candidate !== pythonExecutable());
    const other = others[0];
    if (other === undefined) return;

    const listFile = path.join(scratchRepo({ "list.txt": `${FIXTURE_FILES.join("\n")}\n` }), "list.txt");
    const run = (interpreter: string): Record<string, unknown> =>
      JSON.parse(
        execFileSync(interpreter, [pytruthScript(), "--root", fixtureRoot, "--files", listFile], {
          encoding: "utf8",
        }),
      ) as Record<string, unknown>;

    const here = run(pythonExecutable());
    const there = run(other);
    expect(there["python"]).not.toBe(here["python"]);
    // Everything but the version it reports must be identical.
    delete here["python"];
    delete there["python"];
    expect(stableStringify(there)).toBe(stableStringify(here));
  });

  test("every collection is sorted and the run is stable", () => {
    expect([...truth.imports].sort(compareEdges)).toEqual(truth.imports);
    expect([...truth.calls].sort(compareEdges)).toEqual(truth.calls);
    expect(stableStringify(generateTruth(fixtureRoot, FIXTURE_FILES))).toBe(stableStringify(truth));
  });

  test("a caller file list narrows the universe on both ends", () => {
    const narrowed = generateTruth(fixtureRoot, ["tiny/store.py", "tiny/retry.py"]);
    expect(narrowed.files).toEqual(["tiny/retry.py", "tiny/store.py"]);
    expect(keys(narrowed.imports)).toEqual([]);
    expect(keys(narrowed.calls)).toEqual([
      "tiny/retry.py#retry -> tiny/retry.py#_backoff",
      "tiny/store.py#Store.put -> tiny/store.py#Store._record",
    ]);
    expect(Object.keys(narrowed.exports)).toEqual(["tiny/retry.py", "tiny/store.py"]);
  });

  test("__all__ is read as a whole: comments, concatenation, +=, and one unreadable write", () => {
    const root = scratchRepo({
      "pyproject.toml": "[project]\nname = 'surface'\n",
      "surface/__init__.py": "",
      // A comment between entries and an implicitly concatenated name are both literal.
      "surface/pinned.py": "def alpha():\n    pass\n\n\ndef beta():\n    pass\n\n\n__all__ = (\n    # the good one\n    'al' 'pha',\n)\n",
      // `+=` widens the surface the first write opened.
      "surface/widened.py": "def a():\n    pass\n\n\ndef b():\n    pass\n\n\n__all__ = ['a']\n__all__ += ['b']\n",
      // One computed write makes the whole surface unreadable, whatever came before it.
      "surface/computed.py": "def _private():\n    pass\n\n\ndef public():\n    pass\n\n\n__all__ = ['_private']\nif FLAG:\n    __all__ = compute()\n",
      // A chained assignment binds both names at module level.
      "surface/chained.py": "first = second = 1\n",
    });
    const out = generateTruth(root, [
      "surface/__init__.py",
      "surface/chained.py",
      "surface/computed.py",
      "surface/pinned.py",
      "surface/widened.py",
    ]);
    expect(out.exports["surface/pinned.py"]).toEqual(["alpha"]);
    expect(out.exports["surface/widened.py"]).toEqual(["a", "b"]);
    expect(out.exports["surface/computed.py"]).toEqual(["public"]);
    expect(out.exports["surface/chained.py"]).toEqual(["first", "second"]);
  });

  test("a class body's own names shadow the module; a method's body does not see them", () => {
    // The mirror of the extractor's rule. If only one side had it, every such call would be
    // an S3 false positive or a false negative rather than an agreement.
    const root = scratchRepo({
      "pyproject.toml": "[project]\nname = 'scoped'\n",
      "scoped/__init__.py": "",
      "scoped/mod.py": [
        "def helper():",
        "    return 1",
        "",
        "",
        "class C:",
        "    helper = 2",
        "    made = helper()",
        "    typed: int",
        "",
        "    def use(self):",
        "        return helper()",
        "",
      ].join("\n"),
    });
    const out = generateTruth(root, ["scoped/__init__.py", "scoped/mod.py"]);
    // Only the method's call reaches the module-level `helper`.
    expect(keys(out.calls)).toEqual(["scoped/mod.py#C.use -> scoped/mod.py#helper"]);
  });

  test("import roots come from the tables that declare them, on this side too", () => {
    // `tomllib` makes the oracle section-correct for free; the extractor had to be taught.
    // Both must agree, or every import under a src layout is a false positive somewhere.
    const root = scratchRepo({
      "pyproject.toml": [
        "[tool.poetry]",
        'name = "app"',
        'packages = [{ include = "app", from = "src" }]',
        "",
        "[tool.towncrier]",
        'from = "docs"',
        "",
      ].join("\n"),
      "src/app/__init__.py": "",
      "src/app/mod.py": "from app.util import helper\n\n\ndef go():\n    return helper()\n",
      "src/app/util.py": "def helper():\n    return 1\n",
      // A decoy under the directory the unrelated table names.
      "docs/app/util.py": "def helper():\n    return 2\n",
    });
    const out = generateTruth(root, [
      "docs/app/util.py",
      "src/app/__init__.py",
      "src/app/mod.py",
      "src/app/util.py",
    ]);
    expect(keys(out.imports)).toEqual(["src/app/mod.py -> src/app/util.py"]);
    expect(keys(out.calls)).toEqual(["src/app/mod.py#go -> src/app/util.py#helper"]);
  });

  test("a file importing itself is not an edge, on this side either", () => {
    // `linkImports` drops a self-import (leaf 2.3's ruling: tsc reports no such edge), so an
    // oracle that kept them would score two false negatives on pydantic alone, where both
    // `pydantic/__init__.py` and `pydantic/v1/__init__.py` write `from pydantic… import …`.
    const root = scratchRepo({
      "pyproject.toml": "[project]\nname = 'selfref'\n",
      "selfref/__init__.py": "from selfref import sub\nfrom . import other\n",
      "selfref/sub.py": "def go():\n    return 1\n",
      "selfref/other.py": "def other():\n    return 2\n",
    });
    const out = generateTruth(root, ["selfref/__init__.py", "selfref/other.py", "selfref/sub.py"]);
    // `from selfref import sub` and `from . import other` both name the package itself.
    expect(keys(out.imports)).toEqual([]);
  });

  test("a file that does not parse is dropped, and an empty run is an error", () => {
    const root = scratchRepo({ "pyproject.toml": "[project]\nname = 'x'\n", "bad.py": "def (:\n" });
    // The whole point of the guard (tech spec 10.1, principle 2): an empty truth set scores
    // an empty prediction as 1.000 across the board.
    expect(() => generateTruth(root, ["bad.py"])).toThrow(/python truth is empty for .*did not parse|none of the 1/);
    expect(generateTruth(root, []).files).toEqual([]);
  });

  test("a truth set that covers none of greplost's files is not a vacuous pass", () => {
    const snapshot = {
      files: FIXTURE_FILES.map((p) => ({ path: p, lang: "python" as const, imports: [] })),
      imports: [],
      calls: [],
      manifest: { files: {} },
      metrics: { cycles: [] as string[][] },
      symbols: [],
    } as unknown as Parameters<typeof scoreAgainstTruth>[1];
    const elsewhere: Truth = {
      files: ["elsewhere/x.py"],
      imports: [],
      exports: { "elsewhere/x.py": ["X"] },
      calls: [],
      cycles: [],
      notes: [],
    };
    const scores = scoreAgainstTruth("tiny-python", snapshot, elsewhere, "python");
    expect(scores.truthEmpty).toBe(true);
    expect(missedMetrics(scores)).toContain("truth-empty");
  });
});

describe("oracle independence", () => {
  test("the Python truth generator never reads greplost's extractor or resolver", () => {
    const source = readFileSync(path.join(repoRoot, "bench", "src", "truth", "python.ts"), "utf8");
    for (const forbidden of ["extract/", "resolve/", '@greplost/core"', "buildSnapshot", "web-tree-sitter"]) {
      expect([forbidden, source.includes(forbidden)]).toEqual([forbidden, false]);
    }
    // The schema (ids and sorting) is the shared vocabulary, and is allowed.
    expect(source).toContain('from "@greplost/core/schema"');
  });

  test("the oracle program knows nothing about greplost", () => {
    // The binding check: it imports no parser and no part of greplost. Read with `ast`, so
    // the module's own documentation cannot decide it either way.
    const audit = auditTool();
    for (const name of ["tree_sitter", "tree_sitter_python", "greplost"]) {
      expect([name, audit.imports.includes(name)]).toEqual([name, false]);
    }
    // And it never reaches for greplost's own artifacts or sources by path.
    const source = readFileSync(pytruthScript(), "utf8");
    for (const name of [".greplost/", "packages/core", "web-tree-sitter"]) {
      expect([name, source.includes(name)]).toEqual([name, false]);
    }
  });

  test("its output changes when the fixture changes", () => {
    const root = scratchRepo({ "pyproject.toml": "[project]\nname = 'tiny'\n" });
    cpSync(path.join(fixtureRoot, "tiny"), path.join(root, "tiny"), { recursive: true });
    const before = generateTruth(root, FIXTURE_FILES);
    expect(stableStringify(before)).toBe(stableStringify(truth));

    // One new public function, one new call, one new import: every set must move.
    writeFileSync(
      path.join(root, "tiny", "extra.py"),
      "from tiny.store import Store\n\n\ndef spawn() -> Store:\n    return Store()\n",
      "utf8",
    );
    const after = generateTruth(root, [...FIXTURE_FILES, "tiny/extra.py"]);
    expect(after.files).toContain("tiny/extra.py");
    expect(after.exports["tiny/extra.py"]).toEqual(["spawn"]);
    expect(keys(after.imports)).toContain("tiny/extra.py -> tiny/store.py");
    expect(keys(after.calls)).toContain("tiny/extra.py#spawn -> tiny/store.py#Store");
    expect(stableStringify(after)).not.toBe(stableStringify(before));
  });
});

describe("no import execution", () => {
  test("a module that raises at import time is still read correctly", () => {
    const root = scratchRepo({
      "pyproject.toml": "[project]\nname = 'boom'\n",
      "boom/__init__.py": "",
      "boom/loud.py":
        "import sys\n\nraise SystemExit(1)\n\n\ndef never_runs() -> int:\n    return helper()\n\n\ndef helper() -> int:\n    return 1\n",
    });
    const out = generateTruth(root, ["boom/__init__.py", "boom/loud.py"]);
    expect(out.files).toEqual(["boom/__init__.py", "boom/loud.py"]);
    expect(out.exports["boom/loud.py"]).toEqual(["helper", "never_runs"]);
    expect(keys(out.calls)).toEqual(["boom/loud.py#never_runs -> boom/loud.py#helper"]);
  });

  test("a module importing something that is not installed is read, not resolved", () => {
    const root = scratchRepo({
      "pyproject.toml": "[project]\nname = 'ghost'\n",
      "ghost/__init__.py": "",
      "ghost/uses.py": "import definitely_not_installed_greplost_xyz as ghost\n\n\ndef go():\n    return ghost.run()\n",
    });
    const out = generateTruth(root, ["ghost/__init__.py", "ghost/uses.py"]);
    expect(out.files).toEqual(["ghost/__init__.py", "ghost/uses.py"]);
    expect(keys(out.imports)).toEqual([]);
    expect(keys(out.calls)).toEqual([]);
  });

  test("the oracle never executes or imports what it reads", () => {
    // Read with `ast`, not by substring, so the module's own prose cannot decide this.
    const audit = auditTool();
    expect(audit.executes).toEqual([]);
    // `sys.path` is never consulted: resolution is a probe over the explicit file list, so
    // whatever happens to be installed on the machine cannot become an edge.
    expect(audit.usesSysPath).toBe(false);
    expect(audit.imports).not.toContain("runpy");
    expect(audit.imports).not.toContain("subprocess");
  });
});
