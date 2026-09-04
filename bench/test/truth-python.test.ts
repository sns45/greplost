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
import { generateTruth, NOTES, pytruthScript } from "../src/truth/python.ts";
import { loadTruth } from "../src/truth/registry.ts";
import { missedMetrics, scoreAgainstTruth } from "../src/structural.ts";
import { edgeKey, exportKeys } from "../src/score.ts";
import type { Truth } from "../src/truth/ts.ts";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const fixtureRoot = path.join(repoRoot, "fixtures", "tiny-python");

/** The six indexed files of the fixture; `tests/__tests__/test_store.py` is excluded. */
const FIXTURE_FILES = [
  "tiny/__init__.py",
  "tiny/app.py",
  "tiny/cycle_a.py",
  "tiny/cycle_b.py",
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
  const stdout = execFileSync("python3", ["-c", AUDIT_PROGRAM, pytruthScript()], { encoding: "utf8" });
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

  test("it runs on the pinned interpreter, python3 3.14", () => {
    const version = execFileSync("python3", ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], {
      encoding: "utf8",
    }).trim();
    // `tomllib` (3.11) and `sys.stdlib_module_names` (3.10) are the floor the oracle needs;
    // the pin is 3.14, and a newer interpreter is a change worth noticing rather than hiding.
    expect(version).toBe("3.14");
  });

  test("it prints one JSON document with the agreed key set", () => {
    const listFile = path.join(scratchRepo({ "list.txt": `${FIXTURE_FILES.join("\n")}\n` }), "list.txt");
    const stdout = execFileSync(
      "python3",
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
    ]);
    expect(parsed["modules"]).toBe(6);
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
    ]);
    expect(truth.imports.every((e) => e.to.endsWith(".py") && e.kind === "import")).toBe(true);
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
    expect(truth.notes).toEqual([...NOTES]);
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
    const source = readFileSync(pytruthScript(), "utf8");
    for (const name of ["tree_sitter", "tree-sitter", ".greplost/", "packages/core"]) {
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
