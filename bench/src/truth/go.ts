/**
 * Go compiler truth for Eval 1 (tech spec 10.3, go sub-project spec).
 *
 * The structure layer is never scored against itself (tech spec 10.1, principle
 * 2), so nothing here imports greplost's extractor or resolver. The oracle is
 * the Go toolchain: `bench/truth/gocallgraph` loads the repo through
 * `golang.org/x/tools/go/packages` (which drives `go list -json -deps`) and
 * prints, in greplost's own id vocabulary:
 *
 *   files    the files the toolchain actually loaded - a file behind a build
 *            constraint (`//go:build appengine`) is absent, and the harness
 *            intersects both sides with this list before scoring;
 *   imports  one edge per (importing file, imported in-repo package directory).
 *            Import targets are **directory ids** because a Go import names a
 *            package, not a file (tech spec Appendix C);
 *   exports  the exported package-level identifiers of each file (methods
 *            belong to their type, not to the package);
 *   calls    static calls plus CHA-resolved dynamic ones, between named
 *            in-repo functions.
 *
 * Per-file import edges, and why they are read from the syntax rather than from
 * `go list`'s package-level `Imports` field: `go list` reports imports per
 * *package*, and every metric here is per *file*. The program therefore takes
 * the package set from the toolchain (so build constraints, `vendor/` and
 * `testdata/` are handled exactly as the go command handles them) and reads
 * each loaded file's own import block from the AST the toolchain parsed. That
 * is deterministic - the same checkout gives the same set every time - and it
 * cannot invent an edge the compiler did not see.
 *
 * Cycles are always empty: Go forbids import cycles between packages, and these
 * edges run from a file to a directory, so the graph has no cycle to find.
 *
 * Residual, disclosed as the `cha-over-approximation` note: CHA resolves a
 * dynamic call to *every* function whose signature or interface method matches,
 * so the call truth is an over-approximation of the real call graph. S3 recall
 * is therefore a floor rather than a measurement, and S3 *precision* cannot see
 * a predicted edge that happens to be one of CHA's extra candidates. That is
 * why the extractor withholds a call whose callee is a locally bound name
 * instead of leaving it for the oracle to catch (leaf 1.8 fix round 1).
 *
 * An empty result is an error, never a score: a run where the toolchain loaded
 * nothing would otherwise report four vacuous 1.000s and pass the gate.
 *
 * The helper is compiled once into `bench/.corpus/.tools/`, named by a hash of
 * its own sources and `go.sum`, so a pinned dependency change rebuilds it and
 * nothing else does.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { compareEdges, compareStrings, type Edge } from "@greplost/core/schema";
import type { Truth } from "./ts.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
/** The vendored helper program, and the build cache it lands in. */
const TOOL_SOURCE_DIR = path.join(REPO_ROOT, "bench", "truth", "gocallgraph");
const TOOL_CACHE_DIR = path.join(REPO_ROOT, "bench", ".corpus", ".tools");
/** Files whose bytes name the built binary; changing any of them rebuilds it. */
const TOOL_SOURCES = ["go.mod", "go.sum", "main.go"] as const;
/** Loading a large repo through go/packages is slow the first time (module downloads). */
const LOAD_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_BUFFER = 512 * 1024 * 1024;

/** Emulations and oracle choices this generator applies, for `RESULTS.md`. */
export const GO_TRUTH_NOTES = [
  "go-packages-per-file-imports",
  "cha-callgraph",
  "cha-over-approximation",
] as const;

/** The document `gocallgraph` prints. */
interface GoToolOutput {
  files: string[];
  imports: Array<{ from: string; to: string }>;
  exports: Record<string, string[]>;
  calls: Array<{ from: string; to: string }>;
  errors: string[];
  packages: number;
}

/** sha256 of the helper's sources: the identity of the binary they build. */
function toolHash(): string {
  const hash = createHash("sha256");
  for (const name of TOOL_SOURCES) {
    const file = path.join(TOOL_SOURCE_DIR, name);
    if (!existsSync(file)) {
      throw new Error(`greplost: ${path.relative(REPO_ROOT, file)} is missing; the Go truth generator cannot build`);
    }
    hash.update(name);
    hash.update("\n");
    hash.update(readFileSync(file));
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Absolute path of the built helper, compiling it on first use.
 *
 * The binary is content-addressed by its sources, so a warm cache never shells
 * out to `go build` and a dependency bump never reuses a stale binary.
 */
export function goCallgraphTool(): string {
  const binary = path.join(TOOL_CACHE_DIR, `gocallgraph-${toolHash()}`);
  if (existsSync(binary)) return binary;
  mkdirSync(TOOL_CACHE_DIR, { recursive: true });
  try {
    execFileSync("go", ["build", "-o", binary, "."], {
      cwd: TOOL_SOURCE_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: LOAD_TIMEOUT_MS,
    });
  } catch (cause) {
    const detail = stderrOf(cause);
    throw new Error(
      `greplost: cannot build bench/truth/gocallgraph (needs Go 1.25 and the pinned golang.org/x/tools ` +
        `in the module cache): ${detail}`,
    );
  }
  return binary;
}

function stderrOf(cause: unknown): string {
  const err = cause as { stderr?: Buffer | string; message?: string };
  const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString("utf8");
  const text = (stderr ?? err.message ?? String(cause)).trim();
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

/**
 * The tool's view of `root`, one module at a time.
 *
 * `go list ./...` is a *module* command: run from a directory that is not inside a module it
 * matches nothing at all, and it never descends into a nested module. A repository that is one
 * module (every build-1 Go corpus, and every Go fixture) is loaded exactly as it always was,
 * from its own root. A repository that is a bag of modules, `pulumi/examples`, the pinned
 * `pulumi-go` corpus, is fifty of them with nothing at the top, is loaded once per module and
 * the ids are re-rooted onto the repository, so both sides of the score still speak repo paths
 * (leaf 2.7).
 */
function runTool(root: string): GoToolOutput {
  const dirs = moduleDirs(root);
  if (dirs.length === 1 && dirs[0] === ".") return runToolIn(root, "");

  const merged: GoToolOutput = { files: [], imports: [], exports: {}, calls: [], errors: [], packages: 0 };
  const seenErrors = new Set<string>();
  for (const dir of dirs) {
    // One module the go command refuses to start on (an unbuildable `go.mod`, a missing
    // `go.sum` entry) is a disclosed error, not a dead run: the other forty-nine still have
    // something to say, and the emptiness guards below still catch a repo where none do.
    let part: GoToolOutput;
    try {
      part = runToolIn(path.join(root, dir), `${dir}/`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!seenErrors.has(message)) {
        seenErrors.add(message);
        merged.errors.push(message);
      }
      continue;
    }
    merged.files.push(...part.files);
    merged.imports.push(...part.imports);
    merged.calls.push(...part.calls);
    merged.packages += part.packages;
    for (const [file, names] of Object.entries(part.exports)) merged.exports[file] = names;
    for (const message of part.errors) {
      if (seenErrors.has(message)) continue;
      seenErrors.add(message);
      merged.errors.push(message);
    }
  }
  merged.files.sort(compareStrings);
  merged.errors.sort(compareStrings);
  return merged;
}

/** Module directories under `root`, repo-relative and sorted; `["."]` when the root is one. */
function moduleDirs(root: string): string[] {
  if (existsSync(path.join(root, "go.mod"))) return ["."];
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const name = entry.name;
        if (name.startsWith(".") || name === "vendor" || name === "testdata" || name === "node_modules") continue;
        walk(path.join(dir, name), prefix === "" ? name : `${prefix}/${name}`);
        continue;
      }
      if (entry.name === "go.mod" && prefix !== "") out.push(prefix);
    }
  };
  walk(root, "");
  return out.sort(compareStrings);
}

/** One module's output, with every id re-rooted onto the repository by `prefix`. */
function runToolIn(dir: string, prefix: string): GoToolOutput {
  const binary = goCallgraphTool();
  let stdout: string;
  try {
    stdout = execFileSync(binary, ["-root", dir], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: LOAD_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  } catch (cause) {
    throw new Error(`greplost: gocallgraph failed on ${dir}: ${stderrOf(cause)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`greplost: gocallgraph printed something that is not JSON for ${dir}`);
  }
  const value = parsed as Partial<GoToolOutput>;
  const at = (id: string): string => (prefix === "" ? id : `${prefix}${id}`);
  const exports: Record<string, string[]> = {};
  for (const [file, names] of Object.entries(value.exports ?? {})) exports[at(file)] = names;
  return {
    files: (value.files ?? []).map(at),
    imports: (value.imports ?? []).map((e) => ({ from: at(e.from), to: at(e.to) })),
    exports,
    calls: (value.calls ?? []).map((e) => ({ from: at(e.from), to: at(e.to) })),
    errors: value.errors ?? [],
    packages: value.packages ?? 0,
  };
}

/** The file part of a node id: `a/b.go#Sym` -> `a/b.go`. */
function fileOf(id: string): string {
  const hash = id.indexOf("#");
  return hash === -1 ? id : id.slice(0, hash);
}

function edge(from: string, to: string, kind: Edge["kind"]): Edge {
  return { from, to, kind, confidence: "high" };
}

/**
 * Compiler truth for `files` (repo-relative posix paths) under `root`.
 *
 * `files` is the harness's own file list; the returned `files` is that list
 * intersected with what the Go toolchain loaded, and every edge has both ends
 * inside it (import targets excepted: those are package directories, which the
 * harness maps back onto the covered files itself).
 */
export function generateGoTruth(root: string, files: string[]): Truth {
  const absRoot = path.resolve(root);
  const requested = new Set(files);
  const tool = runTool(absRoot);

  const covered = tool.files.filter((file) => requested.has(file)).sort(compareStrings);
  const coveredSet = new Set(covered);

  // Integrity guard (tech spec 10.1, principle 2). An empty truth set scores an
  // empty prediction as a perfect 1.000 across the board, so a repo the Go
  // toolchain could not load must fail the run rather than rubber-stamp it.
  // `packages` is decoded from the helper for exactly this question.
  if (tool.packages === 0) {
    throw new Error(
      `greplost: go truth is empty for ${absRoot} (go list matched no packages` +
        `${tool.errors[0] === undefined ? "" : `; first error: ${tool.errors[0]}`})`,
    );
  }
  if (files.length > 0 && covered.length === 0) {
    throw new Error(
      `greplost: go truth is empty for ${absRoot} (the Go toolchain loaded none of the ` +
        `${files.length} requested files; ${tool.files.length} file(s) were loaded from elsewhere)`,
    );
  }

  const imports = tool.imports
    .filter((e) => coveredSet.has(e.from))
    .map((e) => edge(e.from, e.to, "import"))
    .sort(compareEdges);

  const calls = tool.calls
    .filter((e) => coveredSet.has(fileOf(e.from)) && coveredSet.has(fileOf(e.to)))
    .map((e) => edge(e.from, e.to, "call"))
    .sort(compareEdges);

  const exports: Record<string, string[]> = {};
  for (const file of covered) exports[file] = [...(tool.exports[file] ?? [])].sort(compareStrings);

  if (tool.errors.length > 0) {
    // Loading is best effort: a package that does not type-check contributes
    // nothing rather than failing the run, but the harness must be able to say so.
    console.error(
      `truth-go: ${tool.errors.length} package load error(s) in ${absRoot}; first: ${tool.errors[0] ?? ""}`,
    );
  }

  return {
    files: covered,
    imports,
    exports,
    calls,
    // Go forbids package import cycles, and these edges run file -> directory.
    cycles: [],
    notes: [...GO_TRUTH_NOTES],
  };
}
