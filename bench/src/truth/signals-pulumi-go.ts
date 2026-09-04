/**
 * Pulumi Go signal truth (build 2, leaf 2.7; spec 2026-09-04 section 3.7).
 *
 * The oracle is **`go/types`**: `bench/truth/pulumigotruth` loads the repo through
 * `golang.org/x/tools/go/packages` and calls a Go expression a resource constructor when its
 * result type implements `pulumi.Resource`, tested with `types.Implements` against the
 * interface looked up in the loaded package set. Nothing here, and nothing there, reads
 * greplost's extractor: `bench/test/signals-pulumi-go.test.ts` asserts that on both files,
 * because an oracle that shares code with what it scores measures nothing at all.
 *
 * What it produces:
 *   `generateExtra` -> the resource **node set** S6 scores, and the `resource-input`
 *                      **reference edges** that fold into S5.
 *   `generateTruth` -> the covered file list, with S1 to S4 declared unsupported: this module
 *                      is not an import/export/call oracle and must never be mistaken for one
 *                      (`truth/go.ts` is, and the harness uses it for Go).
 *
 * The helper is compiled once into `bench/.corpus/.tools/`, named by a hash of its own sources
 * and `go.sum`, exactly as `truth/go.ts` caches `gocallgraph`: a pinned dependency change
 * rebuilds it and nothing else does. Building it needs the Go toolchain and the pinned
 * `golang.org/x/tools` in the module cache; loading a Pulumi program additionally needs that
 * program's own provider SDKs, so a cold machine pays one `go mod download` per corpus module.
 *
 * An empty result is an error, never a score: a run where the toolchain loaded none of the
 * requested files would otherwise report a vacuous 1.000 for S5 and S6.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { compareStrings, type ReferenceEdge } from "@greplost/core/schema";
import type { Truth } from "./ts.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
/** The vendored helper program, and the build cache it lands in. */
const TOOL_SOURCE_DIR = path.join(REPO_ROOT, "bench", "truth", "pulumigotruth");
const TOOL_CACHE_DIR = path.join(REPO_ROOT, "bench", ".corpus", ".tools");
/** Files whose bytes name the built binary; changing any of them rebuilds it. */
const TOOL_SOURCES = ["go.mod", "go.sum", "main.go"] as const;
/** Loading a repo of Pulumi programs is slow the first time (provider SDK downloads). */
const LOAD_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BUFFER = 512 * 1024 * 1024;

/** Oracle choices this generator applies, for `RESULTS.md`. */
export const NOTES: readonly string[] = ["go-types-oracle", "types-implements-pulumi-resource"];

/**
 * S1 to S4 are not this oracle's business. Declaring them unsupported is what stops a caller
 * that reaches for `generateTruth` from scoring greplost's imports against an empty set and
 * publishing four vacuous 1.000s.
 */
const UNSUPPORTED = ["unsupported:S1", "unsupported:S2", "unsupported:S3", "unsupported:S4"] as const;

/** The document `pulumigotruth` prints. */
interface ToolOutput {
  files: string[];
  nodes: string[];
  references: Array<{ from: string; to: string; refKind: string; symbols?: string[] }>;
  errors: string[];
  packages: number;
  modules: number;
  pulumiModules: number;
}

/** The signal node and reference sets, in greplost's id vocabulary. */
export interface SignalExtra {
  references: ReferenceEdge[];
  nodes: string[];
}

export function generateExtra(root: string, files: string[]): SignalExtra {
  const scan = analyse(root, files);
  return { nodes: scan.nodes, references: scan.references };
}

/**
 * The `Truth` shape the registry expects. This oracle covers signals, not imports and calls, so
 * every S1-to-S4 metric is declared unsupported rather than reported as an empty set.
 */
export function generateTruth(root: string, files: string[]): Truth {
  const scan = analyse(root, files);
  const exports: Record<string, string[]> = {};
  for (const file of scan.covered) exports[file] = [];
  return {
    files: scan.covered,
    imports: [],
    exports,
    calls: [],
    cycles: [],
    notes: [...NOTES, ...UNSUPPORTED],
  };
}

// ---------------------------------------------------------------------------
// the helper program
// ---------------------------------------------------------------------------

/** sha256 of the helper's sources: the identity of the binary they build. */
function toolHash(): string {
  const hash = createHash("sha256");
  for (const name of TOOL_SOURCES) {
    const file = path.join(TOOL_SOURCE_DIR, name);
    if (!existsSync(file)) {
      throw new Error(
        `greplost: ${path.relative(REPO_ROOT, file)} is missing; the Pulumi Go truth generator cannot build`,
      );
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
 * The binary is content-addressed by its sources, so a warm cache never shells out to
 * `go build` and a dependency bump never reuses a stale binary.
 */
export function pulumiGoTruthTool(): string {
  const binary = path.join(TOOL_CACHE_DIR, `pulumigotruth-${toolHash()}`);
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
    throw new Error(
      `greplost: cannot build bench/truth/pulumigotruth (needs the Go toolchain and the pinned ` +
        `golang.org/x/tools in the module cache): ${stderrOf(cause)}`,
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

function runTool(root: string): ToolOutput {
  const binary = pulumiGoTruthTool();
  let stdout: string;
  try {
    stdout = execFileSync(binary, ["-root", root], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: LOAD_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  } catch (cause) {
    throw new Error(`greplost: pulumigotruth failed on ${root}: ${stderrOf(cause)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`greplost: pulumigotruth printed something that is not JSON for ${root}`);
  }
  const value = parsed as Partial<ToolOutput>;
  return {
    files: value.files ?? [],
    nodes: value.nodes ?? [],
    references: value.references ?? [],
    errors: value.errors ?? [],
    packages: value.packages ?? 0,
    modules: value.modules ?? 0,
    pulumiModules: value.pulumiModules ?? 0,
  };
}

// ---------------------------------------------------------------------------
// scoring sets
// ---------------------------------------------------------------------------

interface Scan {
  covered: string[];
  nodes: string[];
  references: ReferenceEdge[];
}

/** The file part of a node id: `a/b.go#resource.x` -> `a/b.go`. */
function fileOf(id: string): string {
  const hash = id.indexOf("#");
  return hash === -1 ? id : id.slice(0, hash);
}

function analyse(root: string, files: string[]): Scan {
  // Nothing to ask about, and nothing an empty answer could rubber-stamp.
  if (files.length === 0) return { covered: [], nodes: [], references: [] };

  const absRoot = path.resolve(root);
  const requested = new Set(files);
  const tool = runTool(absRoot);

  const covered = tool.files.filter((file) => requested.has(file)).sort(compareStrings);
  const coveredSet = new Set(covered);

  // Integrity guard (tech spec 10.1, principle 2). An empty truth set scores an empty
  // prediction as a perfect 1.000, so a repo the Go toolchain could not load must fail the
  // run rather than rubber-stamp it.
  if (covered.length === 0) {
    throw new Error(
      `greplost: the signals-pulumi-go oracle loaded none of ${files.length} file(s) under ${absRoot} ` +
        `(${tool.modules} module(s), ${tool.packages} package(s), ${tool.files.length} file(s) loaded from ` +
        `elsewhere${tool.errors[0] === undefined ? "" : `; first error: ${tool.errors[0]}`})`,
    );
  }

  if (tool.errors.length > 0) {
    // Loading is best effort: a module that does not type-check contributes nothing rather
    // than failing the run, but the harness must be able to say so.
    console.error(
      `truth-signals-pulumi-go: ${tool.errors.length} package load error(s) in ${absRoot}; ` +
        `first: ${tool.errors[0] ?? ""}`,
    );
  }

  const nodes = tool.nodes.filter((id) => coveredSet.has(fileOf(id))).sort(compareStrings);
  const references = tool.references
    .filter((edge) => coveredSet.has(fileOf(edge.from)) && coveredSet.has(fileOf(edge.to)))
    .map(
      (edge): ReferenceEdge => ({
        from: edge.from,
        to: edge.to,
        kind: "reference",
        refKind: "resource-input",
        symbols: [...(edge.symbols ?? [])],
        confidence: "high",
      }),
    )
    .sort(
      (a, b) =>
        compareStrings(a.from, b.from) ||
        compareStrings(a.to, b.to) ||
        compareStrings((a.symbols ?? []).join(","), (b.symbols ?? []).join(",")),
    );

  return { covered, nodes, references };
}
