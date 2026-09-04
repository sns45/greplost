/**
 * Terraform (HCL) truth for Eval 1 (tech spec 10.3, spec 2026-09-04 section 2.2).
 *
 * The structure layer is never scored against itself (tech spec 10.1, principle 2), so nothing
 * here imports greplost's extractor, resolver or tree-sitter. The oracle is HashiCorp's own
 * code: `bench/truth/tfinspect` reads the repository with **terraform-config-inspect** (the
 * static module reader behind terraform-docs and the Terraform registry) and with
 * **hclsyntax** (HCL's own parser), and prints, in greplost's id vocabulary:
 *
 *   files       the `.tf` files it read; the harness intersects both sides with this list;
 *   imports     one edge per (calling file, called in-repo module **directory**), because a
 *               Terraform module is a directory and not a file;
 *   exports     each file's variables and outputs — a module's whole public surface;
 *   calls       always empty: HCL has no call edges, which is why S3 is `n/a` and never 0;
 *   references  the fifth metric's truth: every expression address resolved to the one block
 *               it names, at the confidence spec 0.3 fixes;
 *   nodes       every declaration id, so a node set can be scored alongside the edges.
 *
 * `terraform graph` was measured and rejected as the reference oracle; the reason is written
 * out in `bench/truth/tfinspect/main.go` and summarised by the `hclsyntax-traversals` note.
 *
 * An empty result is an error, never a score: a run where the reader loaded nothing would
 * otherwise report vacuous 1.000s and pass the gate.
 *
 * The helper is compiled once into `bench/.corpus/.tools/`, named by a hash of its own sources
 * and `go.sum`, so a pinned dependency change rebuilds it and nothing else does.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { compareEdges, compareStrings, splitNodeId, type Confidence, type Edge } from "@greplost/core/schema";
import type { Truth } from "./ts.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
/** The vendored helper program, and the build cache it lands in. */
const TOOL_SOURCE_DIR = path.join(REPO_ROOT, "bench", "truth", "tfinspect");
const TOOL_CACHE_DIR = path.join(REPO_ROOT, "bench", ".corpus", ".tools");
/** Files whose bytes name the built binary; changing any of them rebuilds it. */
const TOOL_SOURCES = ["go.mod", "go.sum", "main.go"] as const;
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Oracle choices this generator applies, for `RESULTS.md` to disclose.
 *
 * `graph-only-on-fixture` (the note the design sketched) is replaced by `hclsyntax-traversals`:
 * `terraform graph -type=plan` transitively reduces its own output, so it omits real direct
 * references and would score correct greplost edges as false positives. The measurement and
 * the ruling are in `bench/truth/tfinspect/main.go`.
 *
 * `same-rules-different-parser` states the residual plainly, because the two halves of this
 * oracle are not equally independent. `imports` and `exports` (S1, S2) come out of
 * terraform-config-inspect's own module model, which nobody here wrote. `references` and
 * `nodes` (S5, S6) come from a **re-implementation of spec 2.2's rules** over hclsyntax's
 * traversals: a different parser and a separately written resolver, but the same rules, so
 * they measure "does the tree-sitter extractor see what HashiCorp's parser sees" rather than
 * "are spec 2.2's rules the right rules".
 */
export const NOTES: readonly string[] = [
  "terraform-config-inspect",
  "no-call-edges",
  "hclsyntax-traversals",
  "same-rules-different-parser",
];

/**
 * S3 is not a miss for Terraform, it is unmeasurable: HCL has no call edges at all, so there is
 * nothing for an oracle to be right or wrong about. `structural.ts` reads this spelling out of
 * the notes and prints `n/a` (leaf 2.0 ruling R10); nothing is inferred.
 */
const UNSUPPORTED = ["unsupported:S3"] as const;

/** The document `tfinspect` prints. */
interface TfToolOutput {
  files: string[];
  imports: Array<{ from: string; to: string }>;
  exports: Record<string, string[]>;
  calls: Array<{ from: string; to: string }>;
  references: Array<{ from: string; to: string; refKind: string; symbol: string; confidence: string }>;
  nodes: string[];
  errors: string[];
  modules: number;
}

/** sha256 of the helper's sources: the identity of the binary they build. */
function toolHash(): string {
  const hash = createHash("sha256");
  for (const name of TOOL_SOURCES) {
    const file = path.join(TOOL_SOURCE_DIR, name);
    if (!existsSync(file)) {
      throw new Error(`greplost: ${path.relative(REPO_ROOT, file)} is missing; the HCL truth generator cannot build`);
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
export function tfinspectTool(): string {
  const binary = path.join(TOOL_CACHE_DIR, `tfinspect-${toolHash()}`);
  if (existsSync(binary)) return binary;
  mkdirSync(TOOL_CACHE_DIR, { recursive: true });
  try {
    execFileSync("go", ["build", "-o", binary, "."], {
      cwd: TOOL_SOURCE_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: RUN_TIMEOUT_MS,
    });
  } catch (cause) {
    throw new Error(
      `greplost: cannot build bench/truth/tfinspect (needs Go 1.25 and the pinned ` +
        `terraform-config-inspect in the module cache): ${stderrOf(cause)}`,
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

function runToolUncached(root: string): TfToolOutput {
  const binary = tfinspectTool();
  let stdout: string;
  try {
    stdout = execFileSync(binary, ["-root", root], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  } catch (cause) {
    throw new Error(`greplost: tfinspect failed on ${root}: ${stderrOf(cause)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`greplost: tfinspect printed something that is not JSON for ${root}`);
  }
  const value = parsed as Partial<TfToolOutput>;
  const result: TfToolOutput = {
    files: value.files ?? [],
    imports: value.imports ?? [],
    exports: value.exports ?? {},
    calls: value.calls ?? [],
    references: value.references ?? [],
    nodes: value.nodes ?? [],
    errors: value.errors ?? [],
    modules: value.modules ?? 0,
  };
  return result;
}

/**
 * One helper run per target, memoised so `generateTruth` and `generateExtra` — two views of the
 * same read, both of which the structural runner calls — do not parse the repository twice.
 *
 * The key is the root, the requested file list, and a fingerprint of those files' size and
 * mtime. The fingerprint is what makes the memo safe: `headtohead` and `replay` check the
 * *same* root out at several commits inside one process, and without it the second commit
 * would be handed the first one's truth. Stat-ing 90 files costs far less than the 0.09s run
 * it saves, and a checkout that changed anything the tool reads gets a new key.
 */
const RUN_CACHE = new Map<string, TfToolOutput>();

function runKey(root: string, files: readonly string[]): string {
  const parts = [root];
  for (const file of files) {
    let stamp = "-";
    try {
      const info = statSync(path.join(root, file));
      stamp = `${info.size}:${info.mtimeMs}`;
    } catch {
      // A requested file the tool will not find either; its absence is part of the identity.
    }
    parts.push(`${file}=${stamp}`);
  }
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function runTool(root: string, files: readonly string[]): TfToolOutput {
  const key = runKey(root, files);
  const cached = RUN_CACHE.get(key);
  if (cached !== undefined) return cached;
  const result = runToolUncached(root);
  RUN_CACHE.set(key, result);
  return result;
}

/**
 * The tool's read of `root`, with the integrity guards that stop an empty truth from scoring as
 * a perfect one (tech spec 10.1, principle 2).
 */
function coveredRun(root: string, files: string[]): { tool: TfToolOutput; covered: string[] } {
  const absRoot = path.resolve(root);
  const tool = runTool(absRoot, files);
  const requested = new Set(files);
  const covered = tool.files.filter((file) => requested.has(file)).sort(compareStrings);

  if (tool.modules === 0) {
    throw new Error(
      `greplost: hcl truth is empty for ${absRoot} (tfinspect found no directory holding a .tf file` +
        `${tool.errors[0] === undefined ? "" : `; first error: ${tool.errors[0]}`})`,
    );
  }
  if (files.length > 0 && covered.length === 0) {
    throw new Error(
      `greplost: hcl truth is empty for ${absRoot} (tfinspect read none of the ${files.length} ` +
        `requested files; ${tool.files.length} file(s) were read from elsewhere)`,
    );
  }
  return { tool, covered };
}

function edge(from: string, to: string, kind: Edge["kind"]): Edge {
  return { from, to, kind, confidence: "high" };
}

/**
 * Terraform truth for `files` (repo-relative posix paths) under `root`.
 *
 * Import targets are module *directories*, so the harness maps them back onto the covered files
 * itself, exactly as it does for Go.
 */
export function generateTruth(root: string, files: string[]): Truth {
  const { tool, covered } = coveredRun(root, files);
  const coveredSet = new Set(covered);

  const imports = tool.imports
    .filter((e) => coveredSet.has(e.from))
    .map((e) => edge(e.from, e.to, "import"))
    .sort(compareEdges);

  const exports: Record<string, string[]> = {};
  for (const file of covered) exports[file] = [...(tool.exports[file] ?? [])].sort(compareStrings);

  if (tool.errors.length > 0) {
    // Reading is best effort: a directory that does not parse contributes nothing rather than
    // failing the run, but the harness must be able to say so.
    console.error(
      `truth-hcl: ${tool.errors.length} load problem(s) under ${root}; first: ${tool.errors[0] ?? ""}`,
    );
  }

  return {
    files: covered,
    imports,
    exports,
    // HCL has no call edges (spec 2.2).
    calls: [],
    // Import edges run file -> directory and a directory has no outgoing edge, so the graph has
    // no cycle to find; Terraform forbids module call cycles besides.
    cycles: [],
    notes: [...NOTES, ...UNSUPPORTED],
  };
}

/**
 * The reference and node sets S5 is scored on (`TruthModule.generateExtra`, bench spec 5.2).
 *
 * Both sides are restricted to the covered files first, so greplost is never punished for an
 * edge whose ends the oracle was not shown. An `ext:` target survives — an `ext:module/…` or
 * `ext:provider/…` is a real reference and both sides can produce it.
 */
export function generateExtra(root: string, files: string[]): { references: Edge[]; nodes: string[] } {
  const { tool, covered } = coveredRun(root, files);
  const coveredSet = new Set(covered);
  // Module directories that hold at least one covered file, `.` for the repo root: a `uses`
  // edge targets one of these, and it is in scope exactly when the module it names is.
  const coveredDirs = new Set<string>();
  for (const file of covered) {
    const slash = file.lastIndexOf("/");
    coveredDirs.add(slash === -1 ? "." : file.slice(0, slash));
  }
  const inScope = (id: string): boolean => {
    if (id.startsWith("ext:")) return true;
    const hash = id.indexOf("#");
    if (hash !== -1) return coveredSet.has(id.slice(0, hash));
    // A bare id is either a covered file or a covered module directory.
    return coveredSet.has(id) || coveredDirs.has(id);
  };

  const references = tool.references
    .filter((e) => inScope(e.from) && inScope(e.to))
    .map((e) => ({
      from: e.from,
      to: e.to,
      kind: "reference" as const,
      symbols: [e.symbol],
      confidence: (e.confidence === "med" ? "med" : "high") as Confidence,
    }))
    .sort(compareEdges);

  // S6 scores *node ids*, so an id the schema cannot read back is not truth about a node — it
  // is a key greplost could never produce, and every one of them would be counted as a miss.
  // `main.go` already stops emitting the one case there is (`<file>#terraform`, the `terraform`
  // settings block, which is a symbol and not a node); this is the standing guard, so a future
  // declaration kind cannot reintroduce the same silent 19-per-repo penalty.
  const nodes = tool.nodes
    .filter((id) => inScope(id) && splitNodeId(id) !== null)
    .sort(compareStrings);
  return { references, nodes };
}
