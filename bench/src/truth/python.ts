/**
 * Python structural truth for Eval 1 (bench spec 1.6, build 2 leaf 2.1).
 *
 * The structure layer is never scored against itself (tech spec 10.1, principle 2), so
 * nothing here imports greplost's extractor, resolver or parser. The oracle is
 * `bench/truth/pytruth/main.py`: a standalone python3 3.14 program, standard library only,
 * that parses every file with `ast.parse` and prints one JSON document on stdout.
 *
 * **It never imports or executes corpus code.** Module resolution inside the tool is a path
 * probe over the explicit file list this module hands it, never `sys.path` and never
 * site-packages, so a corpus that raises at import time (or tries to) is still read
 * correctly and cannot run. `bench/test/truth-python.test.ts` holds both halves of that.
 *
 * Nothing is compiled and nothing is cached: the oracle is a script, so the content-address
 * dance `truth/go.ts` does for its binary has nothing to build. `pytruthScript()` is
 * exported anyway, so a test can assert *which* file was run.
 *
 * Residual, disclosed as `pep420-namespace-packages`: a PEP 420 namespace package (a
 * directory with no `__init__.py`) is not a module file, so an import of one is not an edge
 * on either side. `ast-only` says the oracle reads syntax rather than a type-checked
 * program: a name produced by `globals().update(...)` or by a module `__getattr__` is
 * invisible to it, as it is to any static reader.
 *
 * An empty result is an error, never a score: a run where nothing parsed would otherwise
 * report four vacuous 1.000s and pass the gate.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compareEdges, compareStrings, type Edge } from "@greplost/core/schema";
import type { Truth } from "./ts.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
/** The vendored oracle. A script, so there is nothing to build and nothing to cache. */
const TOOL_SOURCE = path.join(REPO_ROOT, "bench", "truth", "pytruth", "main.py");
/** The interpreter the oracle is pinned to (`GREPLOST_PYTHON` overrides it in CI). */
const PYTHON = process.env["GREPLOST_PYTHON"] ?? "python3";
/** Parsing a large corpus is fast, but a cold filesystem on CI is not. */
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_BUFFER = 512 * 1024 * 1024;

/** Oracle choices this generator applies, for `RESULTS.md` to disclose. */
export const NOTES: readonly string[] = ["ast-only", "no-import-execution", "pep420-namespace-packages"];

/** Absolute path of the oracle program. Exported so a test can name what it ran. */
export function pytruthScript(): string {
  return TOOL_SOURCE;
}

/** The document `pytruth` prints. */
interface PyToolOutput {
  files: string[];
  imports: Array<{ from: string; to: string }>;
  exports: Record<string, string[]>;
  calls: Array<{ from: string; to: string }>;
  cycles: string[][];
  errors: string[];
  modules: number;
}

function stderrOf(cause: unknown): string {
  const err = cause as { stderr?: Buffer | string; message?: string };
  const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString("utf8");
  const text = (stderr ?? err.message ?? String(cause)).trim();
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

/**
 * Run the oracle over `files` under `root`.
 *
 * The file list goes through a temporary file rather than the command line: a tier-S corpus
 * subset is hundreds of paths, and `ARG_MAX` is not a limit worth discovering on CI.
 */
function runTool(root: string, files: string[]): PyToolOutput {
  const scratch = mkdtempSync(path.join(tmpdir(), "greplost-pytruth-"));
  const listFile = path.join(scratch, "files.txt");
  let stdout: string;
  try {
    writeFileSync(listFile, `${files.join("\n")}\n`, "utf8");
    stdout = execFileSync(PYTHON, [TOOL_SOURCE, "--root", root, "--files", listFile], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  } catch (cause) {
    throw new Error(
      `greplost: pytruth failed on ${root} (needs ${PYTHON} 3.14 with tomllib): ${stderrOf(cause)}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`greplost: pytruth printed something that is not JSON for ${root}`);
  }
  const value = parsed as Partial<PyToolOutput>;
  return {
    files: value.files ?? [],
    imports: value.imports ?? [],
    exports: value.exports ?? {},
    calls: value.calls ?? [],
    cycles: value.cycles ?? [],
    errors: value.errors ?? [],
    modules: value.modules ?? 0,
  };
}

/** The file part of a node id: `a/b.py#Sym` -> `a/b.py`. */
function fileOf(id: string): string {
  const hash = id.indexOf("#");
  return hash === -1 ? id : id.slice(0, hash);
}

function edge(from: string, to: string, kind: Edge["kind"]): Edge {
  return { from, to, kind, confidence: "high" };
}

/**
 * Structural truth for `files` (repo-relative posix paths) under `root`.
 *
 * `files` is the harness's own file list; the returned `files` is that list intersected
 * with what actually parsed, and every edge has both ends inside it.
 */
export function generateTruth(root: string, files: string[]): Truth {
  const absRoot = path.resolve(root);
  const requested = new Set(files);
  const tool = runTool(absRoot, files);

  const covered = tool.files.filter((file) => requested.has(file)).sort(compareStrings);
  const coveredSet = new Set(covered);

  // Integrity guard (tech spec 10.1, principle 2). An empty truth set scores an empty
  // prediction as a perfect 1.000 across the board, so a repo nothing parsed must fail the
  // run rather than rubber-stamp it.
  if (files.length > 0 && covered.length === 0) {
    throw new Error(
      `greplost: python truth is empty for ${absRoot} (none of the ${files.length} requested ` +
        `file(s) parsed${tool.errors[0] === undefined ? "" : `; first error: ${tool.errors[0]}`})`,
    );
  }

  const imports = tool.imports
    .filter((e) => coveredSet.has(e.from) && coveredSet.has(e.to))
    .map((e) => edge(e.from, e.to, "import"))
    .sort(compareEdges);

  const calls = tool.calls
    .filter((e) => coveredSet.has(fileOf(e.from)) && coveredSet.has(fileOf(e.to)))
    .map((e) => edge(e.from, e.to, "call"))
    .sort(compareEdges);

  const exports: Record<string, string[]> = {};
  for (const file of covered) exports[file] = [...(tool.exports[file] ?? [])].sort(compareStrings);

  const cycles = tool.cycles
    .filter((cycle) => cycle.every((member) => coveredSet.has(member)))
    .map((cycle) => [...cycle].sort(compareStrings))
    .sort((a, b) => compareStrings(a[0] ?? "", b[0] ?? ""));

  if (tool.errors.length > 0) {
    // A file that does not parse contributes nothing rather than failing the run, but the
    // harness must be able to say how many there were.
    console.error(
      `truth-python: ${tool.errors.length} file(s) did not parse in ${absRoot}; first: ${tool.errors[0] ?? ""}`,
    );
  }

  return { files: covered, imports, exports, calls, cycles, notes: [...NOTES] };
}
