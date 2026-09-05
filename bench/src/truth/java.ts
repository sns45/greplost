/**
 * Java compiler-grade truth for Eval 1 (spec 2026-09-04 sections 1.6 and 5.2).
 *
 * The structure layer is never scored against itself (tech spec 10.1, principle 2), so nothing
 * here imports greplost's extractor, its resolver, or tree-sitter. The oracle is
 * `bench/truth/javatruth/Truth.java`, a program that drives a real `JavacTask` through the
 * `com.sun.source` Compiler Tree API over the corpus's own sources, with `-proc:none` and a
 * classpath of exactly those source roots, and prints, in greplost's own id vocabulary:
 *
 *   files    the requested `.java` files javac parsed *and* type-checked without an error. A
 *            file whose third-party jar is missing reports an unresolved symbol, goes into
 *            `errors`, and is dropped, so a file the compiler never fully saw is never scored;
 *   imports  one edge per (importing file, imported file), from each unit's own import list;
 *   exports  the public names each file declares, from `Elements.getAllMembers`;
 *   calls    edges between symbol ids, resolved by `Trees.getElement`;
 *   cycles   Tarjan SCCs of size > 1 over the import graph, computed here (Java permits an
 *            import cycle between two files of different packages; Go forbids one entirely).
 *
 * Even the one type import below is erased at runtime; this module's own module graph contains
 * no greplost code at all, which `bench/test/truth-java.test.ts` asserts.
 *
 * Two residuals, disclosed here and in the leaf's report because they bound what S3 measures:
 *
 *  - **no overload resolution.** A member name declared more than once in its file is not a
 *    call target on either side. greplost cannot pick between `put(String)` and `put(int)`
 *    without type inference, and an oracle that did would be scoring a coin flip; the Java
 *    program applies the same rule from javac's own element model, so the two sides drop the
 *    same class of call rather than disagreeing about it.
 *  - **no inherited dispatch.** Neither side walks a superclass or an interface, so a call
 *    that only resolves through one is absent from both.
 *
 * The helper is compiled once into `bench/.corpus/.tools/javatruth-<16 hex>/`, named by a hash
 * of its own source, so a change to the oracle rebuilds it and nothing else does. It needs a
 * JDK, `javac`, not just `java`, of at least the pinned major version; the pin is a floor,
 * not an exact match, and the version is never read into the output.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Edge } from "@greplost/core/schema";
import type { Truth } from "./ts.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
/** The vendored oracle, and the build cache its classes land in. */
const TOOL_SOURCE_DIR = path.join(REPO_ROOT, "bench", "truth", "javatruth");
const TOOL_CACHE_DIR = path.join(REPO_ROOT, "bench", ".corpus", ".tools");
/** Files whose bytes name the built classes; changing any of them rebuilds them. */
const TOOL_SOURCES = ["Truth.java"] as const;
/** The Compiler Tree API surface this oracle uses; a newer JDK is fine, an older one is not. */
const MINIMUM_JDK = 21;
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;
/** Type-checking a whole corpus is slow exactly once per run. */
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Oracle choices this generator applies, for `RESULTS.md` to disclose.
 *
 * The first three name how truth is produced; the last three name what it deliberately leaves
 * out, so a reader of a recall number can see which calls neither side was ever asked about.
 * None of them is a gating spelling (`unsupported:S<n>` and `reported-only` are), so they are
 * disclosure and nothing else.
 */
export const NOTES: readonly string[] = [
  "javac-tree-api",
  "source-classpath-only",
  "unresolved-files-dropped",
  "no-overload-resolution",
  "no-inherited-dispatch",
  "module-info-not-scored",
];

/** The document `Truth` prints. */
interface JavaToolOutput {
  files: string[];
  imports: Array<{ from: string; to: string }>;
  exports: Record<string, string[]>;
  calls: Array<{ from: string; to: string }>;
  errors: string[];
  units: number;
}

/**
 * Deterministic code-unit order. Written out rather than imported from `@greplost/core/schema`,
 * because an oracle that shares a line of runtime code with the thing it scores is not an
 * oracle, and `oracle independence` in the test file enforces exactly that.
 */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEdge(a: Edge, b: Edge): number {
  return compare(a.from, b.from) || compare(a.to, b.to);
}

function stderrOf(cause: unknown): string {
  const err = cause as { stderr?: Buffer | string; message?: string };
  const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString("utf8");
  const text = (stderr ?? err.message ?? String(cause)).trim();
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

/** sha256 of the oracle's sources: the identity of the classes they compile to. */
function toolHash(): string {
  const hash = createHash("sha256");
  for (const name of TOOL_SOURCES) {
    const file = path.join(TOOL_SOURCE_DIR, name);
    if (!existsSync(file)) {
      throw new Error(`greplost: ${path.relative(REPO_ROOT, file)} is missing; the Java truth generator cannot build`);
    }
    hash.update(name);
    hash.update("\n");
    hash.update(readFileSync(file));
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * The JDK's major version, from `javac -version`.
 *
 * A floor, never an exact match (driver ruling 2026-09-04): the Compiler Tree API this oracle
 * uses has been stable since 21, so any later JDK is fine, and pinning an exact build would
 * make the benchmark unrunnable on every machine but one. The number is checked and thrown
 * away: it never reaches the truth set, which must depend on the corpus alone.
 */
function javacMajor(): number {
  let out: string;
  try {
    out = execFileSync("javac", ["-version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: BUILD_TIMEOUT_MS,
    });
  } catch (cause) {
    throw new Error(
      `greplost: javac is not on PATH; the Java truth generator needs a JDK ${MINIMUM_JDK} or newer ` +
        `(a JRE is not enough): ${stderrOf(cause)}`,
    );
  }
  const match = /(\d+)/u.exec(out);
  const major = match === null ? 0 : Number.parseInt(match[1] ?? "0", 10);
  if (major < MINIMUM_JDK) {
    throw new Error(
      `greplost: javac ${major || "?"} is too old for the Java truth generator; it needs ${MINIMUM_JDK} or newer`,
    );
  }
  return major;
}

/**
 * Absolute path of the directory holding the built classes, compiling them on first use.
 *
 * Content-addressed by the oracle's source, so a warm cache never shells out to javac and an
 * edit to the oracle never reuses stale classes.
 */
export function javaTruthTool(): string {
  const classes = path.join(TOOL_CACHE_DIR, `javatruth-${toolHash()}`);
  if (existsSync(path.join(classes, "Truth.class"))) return classes;
  javacMajor();
  mkdirSync(classes, { recursive: true });
  try {
    execFileSync("javac", ["-d", classes, ...TOOL_SOURCES], {
      cwd: TOOL_SOURCE_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: BUILD_TIMEOUT_MS,
    });
  } catch (cause) {
    throw new Error(`greplost: cannot compile bench/truth/javatruth/Truth.java: ${stderrOf(cause)}`);
  }
  if (!existsSync(path.join(classes, "Truth.class"))) {
    throw new Error(`greplost: javac reported success but ${path.relative(REPO_ROOT, classes)}/Truth.class is absent`);
  }
  return classes;
}

function runTool(root: string, files: readonly string[]): JavaToolOutput {
  const classes = javaTruthTool();
  // The file list goes through a temp file, not argv: a corpus subset is thousands of paths and
  // every operating system has an argv limit.
  const scratch = mkdtempSync(path.join(tmpdir(), "greplost-javatruth-"));
  const listing = path.join(scratch, "files.txt");
  let stdout: string;
  try {
    writeFileSync(listing, `${[...files].join("\n")}\n`, "utf8");
    stdout = execFileSync("java", ["-cp", classes, "Truth", "--root", root, "--files", listing], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  } catch (cause) {
    throw new Error(`greplost: javatruth failed on ${root}: ${stderrOf(cause)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`greplost: javatruth printed something that is not JSON for ${root}`);
  }
  const value = parsed as Partial<JavaToolOutput>;
  return {
    files: value.files ?? [],
    imports: value.imports ?? [],
    exports: value.exports ?? {},
    calls: value.calls ?? [],
    errors: value.errors ?? [],
    units: value.units ?? 0,
  };
}

/** The file part of a node id: `a/b/C.java#C.m` -> `a/b/C.java`. */
function fileOf(id: string): string {
  const hash = id.indexOf("#");
  return hash === -1 ? id : id.slice(0, hash);
}

function edge(from: string, to: string, kind: Edge["kind"]): Edge {
  return { from, to, kind, confidence: "high" };
}

/**
 * Strongly connected components of size > 1 over the import graph: Tarjan, iteratively, so a
 * deep import chain cannot overflow the stack.
 *
 * Written here rather than reused from `graph/tarjan.ts` for the same reason `compare` is: an
 * oracle that borrows the implementation it is checking is not checking anything.
 */
function importCycles(nodes: readonly string[], edges: ReadonlyArray<{ from: string; to: string }>): string[][] {
  const order = new Map<string, number>();
  for (const node of nodes) if (!order.has(node)) order.set(node, order.size);
  const adjacency: number[][] = nodes.map(() => []);
  for (const { from, to } of edges) {
    const a = order.get(from);
    const b = order.get(to);
    if (a === undefined || b === undefined || a === b) continue;
    adjacency[a]?.push(b);
  }

  const count = order.size;
  const index = new Int32Array(count).fill(-1);
  const low = new Int32Array(count);
  const onStack = new Uint8Array(count);
  const stack: number[] = [];
  const out: string[][] = [];
  let next = 0;

  for (let start = 0; start < count; start++) {
    if (index[start] !== -1) continue;
    const frames: Array<{ node: number; at: number }> = [{ node: start, at: 0 }];
    index[start] = next;
    low[start] = next;
    next += 1;
    stack.push(start);
    onStack[start] = 1;

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame === undefined) break;
      const neighbours = adjacency[frame.node] ?? [];
      if (frame.at < neighbours.length) {
        const child = neighbours[frame.at] ?? 0;
        frame.at += 1;
        if (index[child] === -1) {
          index[child] = next;
          low[child] = next;
          next += 1;
          stack.push(child);
          onStack[child] = 1;
          frames.push({ node: child, at: 0 });
        } else if (onStack[child] === 1) {
          low[frame.node] = Math.min(low[frame.node] ?? 0, index[child] ?? 0);
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined) low[parent.node] = Math.min(low[parent.node] ?? 0, low[frame.node] ?? 0);
      if (low[frame.node] !== index[frame.node]) continue;
      const component: string[] = [];
      for (;;) {
        const member = stack.pop();
        if (member === undefined) break;
        onStack[member] = 0;
        component.push(nodes[member] ?? "");
        if (member === frame.node) break;
      }
      if (component.length > 1) out.push(component.sort(compare));
    }
  }
  return out.sort((a, b) => compare(a.join(","), b.join(",")));
}

/**
 * Compiler-grade truth for `files` (repo-relative posix paths) under `root`.
 *
 * `files` is the harness's own file list; the returned `files` is that list intersected with
 * what javac type-checked, and every edge has both ends inside it.
 */
export function generateTruth(root: string, files: string[]): Truth {
  const absRoot = path.resolve(root);
  const requested = new Set(files);
  const tool = runTool(absRoot, files);

  const covered = tool.files.filter((file) => requested.has(file)).sort(compare);
  const coveredSet = new Set(covered);

  // Integrity guard (tech spec 10.1, principle 2). An empty truth set scores an empty
  // prediction as a perfect 1.000 across the board, so a repo javac could not read must fail
  // the run rather than rubber-stamp it.
  if (tool.units === 0) {
    throw new Error(
      `greplost: java truth is empty for ${absRoot} (javac parsed no compilation unit` +
        `${tool.errors[0] === undefined ? "" : `; first error: ${tool.errors[0]}`})`,
    );
  }
  if (files.length > 0 && covered.length === 0) {
    throw new Error(
      `greplost: java truth is empty for ${absRoot} (javac type-checked none of the ` +
        `${files.length} requested files; ${tool.errors.length} file(s) reported errors)`,
    );
  }

  // The tool reports the import graph over every file it parsed, dropped ones included, and
  // the *scored* edges are the ones with both ends covered. Cycles are found over the wider
  // graph and then filtered, which is exactly what the harness does to greplost's own cycles:
  // a component that runs through a file javac could not type-check is a cycle neither side
  // should be asked about, and splitting it would invent one that neither side got wrong.
  const whole = tool.imports.filter((e) => e.from !== e.to);
  const imports = whole
    .filter((e) => coveredSet.has(e.from) && coveredSet.has(e.to))
    .map((e) => edge(e.from, e.to, "import"))
    .sort(compareEdge);
  const nodes = [...new Set([...covered, ...whole.map((e) => e.from), ...whole.map((e) => e.to)])].sort(compare);
  const cycles = importCycles(nodes, whole).filter((cycle) => cycle.every((file) => coveredSet.has(file)));

  const calls = tool.calls
    .filter((e) => coveredSet.has(fileOf(e.from)) && coveredSet.has(fileOf(e.to)))
    .map((e) => edge(e.from, e.to, "call"))
    .sort(compareEdge);

  const exports: Record<string, string[]> = {};
  for (const file of covered) exports[file] = [...(tool.exports[file] ?? [])].sort(compare);

  if (tool.errors.length > 0) {
    // Type-checking is best effort: a file whose dependency is a jar this oracle deliberately
    // does not have contributes nothing and is dropped, rather than failing the whole run,
    // but the harness must be able to say how much of the corpus that was.
    console.error(
      `truth-java: ${tool.errors.length} file(s) with compile errors in ${absRoot}; ` +
        `first: ${tool.errors[0] ?? ""}`,
    );
  }

  return { files: covered, imports, exports, calls, cycles, notes: [...NOTES] };
}
