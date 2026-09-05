/**
 * Kotlin truth for Eval 1 — the fixture only, by ruling (spec 2026-09-04 section 1.7).
 *
 * Build 2 does not build a corpus-scale Kotlin oracle. `kotlin-compiler-embeddable`'s PSI and
 * FIR APIs are internal and change shape between minor versions, and the pinned corpus
 * (`kotlinx.coroutines`) is a Gradle multiplatform build that does not compile reliably outside
 * Gradle. So Kotlin's structural numbers are **reported, never gated**, and `RESULTS.md` says
 * so next to the losses table rather than hiding it.
 *
 * What is built instead, so Kotlin is not merely asserted: a genuine compiler oracle over
 * `fixtures/tiny-kotlin`, where compilation is trivially controllable. `bench/truth/kotlintruth`
 * runs `kotlinc` and reads the emitted classfiles back with `javap -v -p`; the `SourceFile`
 * attribute restores per-`.kt` attribution and the constant pool and method bodies give exports,
 * imports and call edges. Nothing here imports `packages/core` or tree-sitter at runtime - the
 * two type imports below are erased - because an oracle that shares code with the thing it
 * scores is not an oracle (tech spec 10.1, principle 2).
 *
 * For a corpus root this module measures nothing and says so: the returned notes carry
 * `reported-only`, which is how `structural.ts` prints `n/a` for S1 to S6 and falls back to the
 * three substitute checks (a deterministic rebuild, a parse-error rate under 1%, no silent
 * file). `n/a` is never a pass and never a fail.
 *
 * The recorded path for a later build, so it is not rediscovered: pin a Kotlin version, run
 * `./gradlew compileKotlin` inside the corpus, then point this same `javap -v` reader at the
 * Gradle-produced classfiles.
 *
 * Numbers `RESULTS.md` should carry next to Kotlin's row, measured on the pinned corpus
 * (kotlinx.coroutines, 163 files) at leaf 2.6 fix round 1: of 515 import records, 77 are named
 * imports and 438 are wildcards. The named ones give 24 in-repo file edges; a wildcard names a
 * package rather than a file and is left `unresolved` rather than guessed, and 193 of those
 * sites have exactly one in-repo declarer of the name actually used - so a per-symbol use
 * analysis would recover them. That is a build-3 job, not a threshold to move here.
 *
 * The oracle's output is cached under `bench/.corpus/.tools/`, keyed by a 16-hex hash of the
 * tool's own sources and of the sources it is asked about, exactly as `truth/go.ts` caches its
 * built helper: a fixture edit invalidates the cache and nothing else does. The host's
 * `kotlinc` version is deliberately **not** part of the key and never reaches the output (driver
 * ruling 2026-09-04): a benchmark artifact may not carry a fact about the machine that made it.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Edge } from "@greplost/core/schema";
import type { Truth } from "./ts.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
/** The oracle, and the cache its output lands in. */
const TOOL_SOURCE_DIR = path.join(REPO_ROOT, "bench", "truth", "kotlintruth");
const TOOL_CACHE_DIR = path.join(REPO_ROOT, "bench", ".corpus", ".tools");
/** Files whose bytes name a cached run; changing any of them invalidates it. */
const TOOL_SOURCES = ["run.sh", "parse_javap.py"] as const;
/** The roots whose truth is measured: only a fixture is compiled (spec 1.7). */
const FIXTURE_DIR = path.join(REPO_ROOT, "fixtures");
/** A cold `kotlinc` start-up is slow, and the JVM's first run slower still. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 128 * 1024 * 1024;

/**
 * What this oracle is and is not, for `RESULTS.md` to publish.
 *
 * `reported-only` is deliberately absent here and added per run, for a corpus root only: in
 * `NOTES` it would make the *fixture* gate vacuous too, and the fixture is the one place Kotlin
 * has compiler truth.
 *
 * The last two tags are the oracle's two known disagreements with the map, both measured and
 * both kept out of the fixture rather than papered over:
 *
 *  - `internal-class-is-public-in-bytecode`: Kotlin mangles an `internal` *member* to
 *    `name$module`, which this reader drops, so it agrees with the map that an internal member
 *    is not exported - but an `internal` *class* stays `ACC_PUBLIC`, so the oracle would call
 *    it exported where the map does not (an S2 false positive on the truth side).
 *  - `object-protocol-overrides-dropped`: `equals`, `hashCode` and `toString` at their standard
 *    descriptors are dropped, because every data class generates them; a hand-written
 *    `override fun toString()` is dropped with them (an S2 false negative on the truth side).
 */
export const NOTES: readonly string[] = [
  "fixture-oracle-only",
  "no-corpus-compiler-truth",
  "kotlinc-javap-classfiles",
  "jvm-synthetics-dropped",
  "property-access-not-a-call",
  "internal-class-is-public-in-bytecode",
  "object-protocol-overrides-dropped",
];

/** The note that turns every metric into `n/a` for a target this oracle cannot measure. */
const REPORTED_ONLY = "reported-only";

/** The document `parse_javap.py` prints. Keys are `<package>/<SourceFile>`, never repo paths. */
interface KotlinToolOutput {
  files: string[];
  imports: Array<{ from: string; to: string }>;
  exports: Record<string, string[]>;
  calls: Array<{ from: string; to: string }>;
  errors: string[];
}

/**
 * Deterministic code-unit order. Written out rather than imported from `@greplost/core/schema`,
 * because an oracle that shares a line of runtime code with the thing it scores is not one.
 */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEdge(a: Edge, b: Edge): number {
  return compare(a.from, b.from) || compare(a.to, b.to);
}

function edge(from: string, to: string, kind: Edge["kind"]): Edge {
  return { from, to, kind, confidence: "high" };
}

/** The file part of a node id: `tiny/App.kt#main` -> `tiny/App.kt`. */
function fileOf(id: string): string {
  const hash = id.indexOf("#");
  return hash === -1 ? id : id.slice(0, hash);
}

/** Absolute path of the oracle's entry point. */
export function kotlinTruthTool(): string {
  const script = path.join(TOOL_SOURCE_DIR, "run.sh");
  if (!existsSync(script)) {
    throw new Error(`greplost: ${path.relative(REPO_ROOT, script)} is missing; the Kotlin oracle cannot run`);
  }
  return script;
}

/**
 * True when this machine can run the oracle at all.
 *
 * A boolean, never the version string: the version is a fact about the machine and belongs in
 * the leaf's gate evidence, not in a benchmark artifact (driver ruling 2026-09-04).
 */
export function hasKotlinToolchain(): boolean {
  for (const [command, args] of [
    ["kotlinc", ["-version"]],
    ["javap", ["-version"]],
    ["python3", ["--version"]],
  ] as const) {
    try {
      execFileSync(command, [...args], { stdio: "ignore", timeout: RUN_TIMEOUT_MS });
    } catch {
      return false;
    }
  }
  return true;
}

/** True when `root` is one of this repo's own fixtures, which is all this oracle measures. */
export function isFixtureRoot(root: string): boolean {
  const resolved = path.resolve(root);
  return resolved === FIXTURE_DIR || resolved.startsWith(`${FIXTURE_DIR}${path.sep}`);
}

function stderrOf(cause: unknown): string {
  const err = cause as { stderr?: Buffer | string; message?: string };
  const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString("utf8");
  const text = (stderr ?? err.message ?? String(cause)).trim();
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

/**
 * The compiler's own version banner, or "" when it cannot be read.
 *
 * It goes into the **cache key** and nowhere else. A cached document is only valid for the
 * compiler that produced it - two kotlinc versions disagree about which synthetics they emit -
 * and a key is not output, so this puts no fact about the machine into an artifact (driver
 * ruling 2026-09-04). `generateTruth` never sees it.
 */
function compilerStamp(): string {
  try {
    return execFileSync("kotlinc", ["-version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: RUN_TIMEOUT_MS,
    }).trim();
  } catch (cause) {
    // kotlinc prints its banner on stderr, so a non-zero exit still carries the version.
    const err = cause as { stderr?: Buffer | string };
    const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString("utf8");
    return (stderr ?? "").trim();
  }
}

/**
 * sha256 of the oracle's sources, of the compiler that will run them, and of the sources it is
 * asked about, as 16 hex characters.
 */
function runHash(root: string, files: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(compilerStamp());
  hash.update("\n");
  for (const name of TOOL_SOURCES) {
    const file = path.join(TOOL_SOURCE_DIR, name);
    if (!existsSync(file)) {
      throw new Error(`greplost: ${path.relative(REPO_ROOT, file)} is missing; the Kotlin oracle cannot run`);
    }
    hash.update(name);
    hash.update("\n");
    hash.update(readFileSync(file));
  }
  for (const file of [...files].sort(compare)) {
    hash.update(file);
    hash.update("\n");
    const absolute = path.join(root, file);
    hash.update(existsSync(absolute) ? readFileSync(absolute) : Buffer.from("<absent>"));
  }
  return hash.digest("hex").slice(0, 16);
}

function parseOutput(stdout: string, root: string): KotlinToolOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`greplost: kotlintruth printed something that is not JSON for ${root}`);
  }
  const value = parsed as Partial<KotlinToolOutput>;
  return {
    files: value.files ?? [],
    imports: value.imports ?? [],
    exports: value.exports ?? {},
    calls: value.calls ?? [],
    errors: value.errors ?? [],
  };
}

/**
 * The oracle's document for one root, compiled on first use and cached by content.
 *
 * A warm cache never starts a JVM, which is what makes the fixture gate cheap enough to run on
 * every commit.
 */
export function kotlinToolOutput(root: string, files: readonly string[]): KotlinToolOutput {
  const absRoot = path.resolve(root);
  const cache = path.join(TOOL_CACHE_DIR, `kotlintruth-${runHash(absRoot, files)}.json`);
  if (existsSync(cache)) return parseOutput(readFileSync(cache, "utf8"), absRoot);

  let stdout: string;
  try {
    stdout = execFileSync("bash", [kotlinTruthTool(), absRoot], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  } catch (cause) {
    throw new Error(
      `greplost: the Kotlin oracle failed on ${absRoot} (it needs kotlinc 2.4 or newer, a JDK's ` +
        `javap, and python3; install the compiler with "brew install kotlin"): ${stderrOf(cause)}`,
    );
  }
  const output = parseOutput(stdout, absRoot);
  mkdirSync(TOOL_CACHE_DIR, { recursive: true });
  writeFileSync(cache, `${stdout.trim()}\n`, "utf8");
  return output;
}

/**
 * Repo-relative path for one `<package>/<SourceFile>` key, or null when it is not exactly one.
 *
 * The oracle speaks in packages because that is what a classfile knows; the harness speaks in
 * repo paths. Two indexed files under the same package suffix would make the key ambiguous, and
 * an ambiguous key is dropped rather than guessed.
 */
function mapKey(key: string, files: readonly string[]): string | null {
  const hits = files.filter((file) => file === key || file.endsWith(`/${key}`));
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/**
 * Import cycles over the truth import graph: the groups of files that reach each other.
 *
 * Written here rather than borrowed from `graph/tarjan.ts` for the same reason as `compare`:
 * the oracle shares no runtime code with what it scores. The graphs are fixture-sized, so
 * mutual reachability is computed directly instead of with Tarjan's algorithm - the same answer,
 * in a form that can be checked by reading it.
 */
function cyclesOf(nodes: readonly string[], edges: readonly Edge[]): string[][] {
  const out = new Map<string, Set<string>>();
  for (const node of nodes) out.set(node, new Set<string>());
  for (const e of edges) out.get(e.from)?.add(e.to);

  const reach = new Map<string, Set<string>>();
  for (const start of nodes) {
    const seen = new Set<string>();
    const stack = [...(out.get(start) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const further of out.get(next) ?? []) stack.push(further);
    }
    reach.set(start, seen);
  }

  const groups: string[][] = [];
  const placed = new Set<string>();
  for (const node of nodes) {
    if (placed.has(node)) continue;
    const group = nodes.filter(
      (other) => other === node || (reach.get(node)?.has(other) === true && reach.get(other)?.has(node) === true),
    );
    if (group.length < 2) continue;
    for (const member of group) placed.add(member);
    groups.push([...group].sort(compare));
  }
  return groups.sort((a, b) => compare(a.join(","), b.join(",")));
}

/**
 * Compiler truth for `files` (repo-relative posix paths) under `root`.
 *
 * A fixture root is compiled and read back; every other root is unmeasured by ruling, and says
 * so through `reported-only` rather than by returning zeros that would look like a score.
 */
export function generateTruth(root: string, files: string[]): Truth {
  if (!isFixtureRoot(root)) {
    return {
      files: [],
      imports: [],
      exports: {},
      calls: [],
      cycles: [],
      notes: [...NOTES, REPORTED_ONLY],
    };
  }

  const tool = kotlinToolOutput(root, files);
  const mapped = new Map<string, string>();
  for (const key of tool.files) {
    const file = mapKey(key, files);
    if (file !== null) mapped.set(key, file);
  }
  const covered = [...mapped.values()].sort(compare);
  const coveredSet = new Set(covered);

  // Integrity guard (tech spec 10.1, principle 2). An empty truth set scores an empty
  // prediction as a perfect 1.000 across the board, so a fixture the compiler could not read
  // must fail the run rather than rubber-stamp it.
  if (files.length > 0 && covered.length === 0) {
    throw new Error(
      `greplost: kotlin truth is empty for ${path.relative(REPO_ROOT, path.resolve(root))} ` +
        `(the compiler covered none of the ${files.length} requested files; ` +
        `${tool.files.length} source file(s) were compiled)`,
    );
  }

  const remap = (id: string): string | null => {
    const file = mapped.get(fileOf(id));
    if (file === undefined || !coveredSet.has(file)) return null;
    const hash = id.indexOf("#");
    return hash === -1 ? file : `${file}${id.slice(hash)}`;
  };

  const imports: Edge[] = [];
  for (const record of tool.imports) {
    const from = remap(record.from);
    const to = remap(record.to);
    // A file importing itself is not a dependency between files, and the linker drops one for
    // every language (build 2, leaf 2.3): the oracle must not carry what the map cannot.
    if (from === null || to === null || from === to) continue;
    imports.push(edge(from, to, "import"));
  }
  imports.sort(compareEdge);

  const calls: Edge[] = [];
  for (const record of tool.calls) {
    const from = remap(record.from);
    const to = remap(record.to);
    if (from === null || to === null) continue;
    calls.push(edge(from, to, "call"));
  }
  calls.sort(compareEdge);

  const exports: Record<string, string[]> = {};
  for (const [key, file] of mapped) exports[file] = [...(tool.exports[key] ?? [])].sort(compare);
  for (const file of covered) exports[file] = exports[file] ?? [];

  if (tool.errors.length > 0) {
    console.error(`truth-kotlin: ${tool.errors.length} classfile note(s); first: ${tool.errors[0] ?? ""}`);
  }

  return {
    files: covered,
    imports,
    exports,
    calls,
    cycles: cyclesOf(covered, imports),
    notes: [...NOTES],
  };
}
