/**
 * Rust compiler-grade truth for Eval 1 (spec 2026-09-04 sections 1.6 and 5.2).
 *
 * The structure layer is never scored against itself (tech spec 10.1, principle 2), so nothing
 * here imports greplost's extractor, its resolver, or tree-sitter. The oracle is
 * `bench/truth/rusttruth`, a cargo binary that takes the crate roots from
 * `cargo metadata --no-deps` and the item tree from `syn::parse_file`, walks the module tree
 * from each root, and prints - in greplost's own id vocabulary:
 *
 *   files    the `.rs` files `syn` actually parsed; the harness intersects both sides with this
 *            list before scoring, so a file the oracle never read is never scored as "a file
 *            that exports nothing";
 *   imports  one edge per (importing file, imported file), from `mod` items and `use` trees;
 *   exports  the `pub` names of each file, with `pub use …::*` followed transitively;
 *   calls    edges between symbol ids under spec 1.3's call rules;
 *   cycles   Tarjan SCCs of size > 1 over the import graph, which Rust permits and Go does not.
 *
 * Even the two type imports below are erased at runtime; this module's own module graph
 * contains no greplost code at all, which `bench/test/truth-rust.test.ts` asserts.
 *
 * Residual, disclosed through `NOTES`: `no-trait-dispatch`. A method call on a generic or `dyn`
 * receiver is absent from truth, exactly as it is absent from greplost's map, because neither
 * side does type inference. S3 recall over that class of call is therefore not measured by
 * either side, and `RESULTS.md` says so.
 *
 * Second disclosure, `rule-agreement-oracle`: this oracle is a `syn` re-implementation of the
 * same rules the extractor applies, not `rustc`. Its two implementations are independent (a
 * different parser, a different language, no shared line of code) and they disagree freely, but
 * a rule that is wrong in the *specification* is wrong on both sides, so S1 to S4 on Rust are
 * rule agreement rather than compiler truth. `rustc` has no stable public name-resolution API,
 * which is why the Go and TypeScript oracles get a compiler and this one does not.
 *
 * The helper is compiled once into `bench/.corpus/.tools/`, named by a 16-hex hash of its own
 * sources - `Cargo.toml`, the vendored `Cargo.lock` and `src/main.rs` - so a pinned dependency
 * change rebuilds it and nothing else does. **The first build on a cold machine needs the
 * network**: `cargo fetch` populates `~/.cargo/registry` from the vendored lockfile, and every
 * build after that is `cargo build --release --offline`. CI must cache `~/.cargo/registry`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Edge } from "@greplost/core/schema";
import type { Truth } from "./ts.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
/** The vendored helper crate, and the build cache its binary lands in. */
const TOOL_SOURCE_DIR = path.join(REPO_ROOT, "bench", "truth", "rusttruth");
const TOOL_CACHE_DIR = path.join(REPO_ROOT, "bench", ".corpus", ".tools");
/** Files whose bytes name the built binary; changing any of them rebuilds it. */
const TOOL_SOURCES = ["Cargo.toml", "Cargo.lock", "src/main.rs"] as const;
/** A cold `cargo fetch` plus a release build of `syn` is slow exactly once. */
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 512 * 1024 * 1024;

/** Oracle choices this generator applies, for `RESULTS.md` to disclose. */
export const NOTES: readonly string[] = [
  "syn-item-tree",
  "cargo-metadata-roots",
  "no-trait-dispatch",
  // Disclosure, not a choice: `rusttruth` re-implements spec 1.3's rules on `syn`'s item tree
  // rather than asking `rustc`, so S1 to S4 on Rust measure two independent implementations of
  // one rule set agreeing, not agreement with the compiler's own name resolution.
  "rule-agreement-oracle",
];

/** The document `rusttruth` prints. */
interface RustToolOutput {
  files: string[];
  imports: Array<{ from: string; to: string }>;
  exports: Record<string, string[]>;
  calls: Array<{ from: string; to: string }>;
  cycles: string[][];
  errors: string[];
  crates: number;
}

/**
 * Deterministic code-unit order. Written out rather than imported from `@greplost/core/schema`,
 * because an oracle that shares a line of runtime code with the thing it scores is not an
 * oracle - and `oracle independence` in the test file enforces exactly that.
 */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEdge(a: Edge, b: Edge): number {
  return compare(a.from, b.from) || compare(a.to, b.to);
}

/** sha256 of the helper's sources: the identity of the binary they build. */
function toolHash(): string {
  const hash = createHash("sha256");
  for (const name of TOOL_SOURCES) {
    const file = path.join(TOOL_SOURCE_DIR, name);
    if (!existsSync(file)) {
      throw new Error(`greplost: ${path.relative(REPO_ROOT, file)} is missing; the Rust truth generator cannot build`);
    }
    hash.update(name);
    hash.update("\n");
    hash.update(readFileSync(file));
  }
  return hash.digest("hex").slice(0, 16);
}

function stderrOf(cause: unknown): string {
  const err = cause as { stderr?: Buffer | string; message?: string };
  const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString("utf8");
  const text = (stderr ?? err.message ?? String(cause)).trim();
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

function cargo(args: string[]): void {
  execFileSync("cargo", args, {
    cwd: TOOL_SOURCE_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
}

/**
 * Absolute path of the built helper, compiling it on first use.
 *
 * The binary is content-addressed by its sources, so a warm cache never shells out to cargo and
 * a dependency bump never reuses a stale binary. The offline build is tried first; only a
 * genuinely cold registry falls through to `cargo fetch`, and the error says so when even that
 * cannot help.
 */
export function rustTruthTool(): string {
  const binary = path.join(TOOL_CACHE_DIR, `rusttruth-${toolHash()}`);
  if (existsSync(binary)) return binary;
  mkdirSync(TOOL_CACHE_DIR, { recursive: true });

  let offlineFailure = "";
  try {
    cargo(["build", "--release", "--offline"]);
  } catch (cause) {
    offlineFailure = stderrOf(cause);
    try {
      // The one network step, documented as a CI prerequisite: everything is pinned by the
      // vendored Cargo.lock, so this downloads exactly the recorded versions and nothing else.
      cargo(["fetch", "--locked"]);
      cargo(["build", "--release", "--offline"]);
    } catch (retry) {
      throw new Error(
        `greplost: cannot build bench/truth/rusttruth (needs cargo 1.88 and the pinned crates in ` +
          `~/.cargo/registry; run "cargo fetch" in bench/truth/rusttruth once, with network). ` +
          `Offline build said: ${offlineFailure}. After cargo fetch: ${stderrOf(retry)}`,
      );
    }
  }

  const built = path.join(TOOL_SOURCE_DIR, "target", "release", "rusttruth");
  if (!existsSync(built)) {
    throw new Error(`greplost: cargo reported success but ${path.relative(REPO_ROOT, built)} does not exist`);
  }
  copyFileSync(built, binary);
  chmodSync(binary, 0o755);
  return binary;
}

function runTool(root: string): RustToolOutput {
  const binary = rustTruthTool();
  let stdout: string;
  try {
    stdout = execFileSync(binary, ["--root", root], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  } catch (cause) {
    throw new Error(`greplost: rusttruth failed on ${root}: ${stderrOf(cause)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`greplost: rusttruth printed something that is not JSON for ${root}`);
  }
  const value = parsed as Partial<RustToolOutput>;
  return {
    files: value.files ?? [],
    imports: value.imports ?? [],
    exports: value.exports ?? {},
    calls: value.calls ?? [],
    cycles: value.cycles ?? [],
    errors: value.errors ?? [],
    crates: value.crates ?? 0,
  };
}

/** The file part of a node id: `a/b.rs#Sym` -> `a/b.rs`. */
function fileOf(id: string): string {
  const hash = id.indexOf("#");
  return hash === -1 ? id : id.slice(0, hash);
}

function edge(from: string, to: string, kind: Edge["kind"]): Edge {
  return { from, to, kind, confidence: "high" };
}

/**
 * Compiler-grade truth for `files` (repo-relative posix paths) under `root`.
 *
 * `files` is the harness's own file list; the returned `files` is that list intersected with
 * what `syn` parsed, and every edge has both ends inside it.
 */
export function generateTruth(root: string, files: string[]): Truth {
  const absRoot = path.resolve(root);
  const requested = new Set(files);
  const tool = runTool(absRoot);

  const covered = tool.files.filter((file) => requested.has(file)).sort(compare);
  const coveredSet = new Set(covered);

  // Integrity guard (tech spec 10.1, principle 2). An empty truth set scores an empty
  // prediction as a perfect 1.000 across the board, so a repo cargo could not read must fail
  // the run rather than rubber-stamp it.
  if (tool.crates === 0) {
    throw new Error(
      `greplost: rust truth is empty for ${absRoot} (cargo metadata reported no package` +
        `${tool.errors[0] === undefined ? "" : `; first error: ${tool.errors[0]}`})`,
    );
  }
  if (files.length > 0 && covered.length === 0) {
    throw new Error(
      `greplost: rust truth is empty for ${absRoot} (rusttruth parsed none of the ` +
        `${files.length} requested files; ${tool.files.length} file(s) were parsed from elsewhere)`,
    );
  }

  // A file's import edge to itself is not an edge. Rust writes one constantly - `mod tests {
  // use super::*; }` names the very file it sits in - and `graph/link.ts` drops a self-loop for
  // every language (leaf 2.3), because it would put the file in its own fan-in, fan-out and
  // blast radius. Truth has to agree: keeping them here scored 44 of ripgrep's `#[cfg(test)]`
  // modules as misses and took S1 recall to 0.835. This retires the leaf's ruling R10, which had
  // kept them on the grounds that both sides produced them; only one side does now.
  const imports = tool.imports
    .filter((e) => e.from !== e.to && coveredSet.has(e.from) && coveredSet.has(e.to))
    .map((e) => edge(e.from, e.to, "import"))
    .sort(compareEdge);

  const calls = tool.calls
    .filter((e) => coveredSet.has(fileOf(e.from)) && coveredSet.has(fileOf(e.to)))
    .map((e) => edge(e.from, e.to, "call"))
    .sort(compareEdge);

  const exports: Record<string, string[]> = {};
  for (const file of covered) exports[file] = [...(tool.exports[file] ?? [])].sort(compare);

  const cycles = tool.cycles
    .filter((cycle) => cycle.every((file) => coveredSet.has(file)))
    .map((cycle) => [...cycle].sort(compare))
    .sort((a, b) => compare(a.join(","), b.join(",")));

  if (tool.errors.length > 0) {
    // Parsing is best effort: a file `syn` cannot read contributes nothing and is dropped from
    // `files`, rather than failing the whole run - but the harness must be able to say so.
    console.error(`truth-rust: ${tool.errors.length} parse error(s) in ${absRoot}; first: ${tool.errors[0] ?? ""}`);
  }

  return { files: covered, imports, exports, calls, cycles, notes: [...NOTES] };
}
