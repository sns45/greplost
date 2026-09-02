/**
 * Eval 4 task suite (tech spec 10.6, Appendix A; bench spec 1.5.6).
 *
 * Two sources, one shape. Four of the five categories are *generated* from the
 * compiler truth of a repo, so the ground truth for "which files import x" is
 * the same oracle Eval 1 is scored against and nobody hand-writes an answer key
 * that can drift. The fifth, `flow`, cannot be derived from a static graph at
 * all: it is an ordered walk through a request, so it is hand-curated per repo
 * in `bench/tasks/<repo>-flow.json` with its provenance recorded.
 *
 * Determinism (tech spec 10.1, principle 3) is the whole point of the generator:
 * `generateStructuralTasks(repo, truth, n)` returns the same tasks, in the same
 * order, with the same ids, for the same truth and seed. The selection is a
 * seeded Fisher-Yates over a `compareStrings`-sorted candidate list, and the
 * seed is mixed with the repo name and the category, so two categories of the
 * same repo do not walk their candidate lists in lockstep.
 *
 * Ids are positions, not names: `hono-def-01` is "the first definition task of
 * the hono suite at this seed". Changing the seed changes the subject behind an
 * id, which is why every results payload records the seed alongside the tasks.
 */
import { compareStrings, type Edge } from "@greplost/core/schema";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Truth } from "./truth/ts.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

/**
 * The exact answer instruction every prompt ends with. Scoring parses the last
 * fenced JSON block out of the answer (see `agent.ts`), so the shape has to be
 * stated identically in every condition: a condition that got a friendlier
 * prompt would win on parse rate rather than on navigation.
 */
export const ANSWER_FILES = 'Answer with a JSON block {"files": [...]}';
/** The `callers` variant: the same instruction plus the enclosing symbols. */
export const ANSWER_FILES_AND_SYMBOLS = 'Answer with a JSON block {"files": [...], "symbols": [...]}';
/** The answer shape every prompt has to state, wherever it states it. */
export const ANSWER_SHAPE = '{"files": [...]}';

/**
 * The task categories: the five of tech spec 10.6 plus `orientation`, which is
 * X8's one-per-repo "what are the main components of this repo?" (10.0).
 */
export type TaskCategory = "definition" | "importers" | "callers" | "blast_radius" | "flow" | "orientation";

/** The four categories generated from compiler truth: X7's restriction (10.0). */
export const STRUCTURAL_CATEGORIES: readonly TaskCategory[] = [
  "definition",
  "importers",
  "callers",
  "blast_radius",
];

/** Every category name, for validating `--categories`. */
export const ALL_CATEGORIES: readonly TaskCategory[] = [...STRUCTURAL_CATEGORIES, "flow", "orientation"];

/** Ground truth for one task. `symbols` is present only for `callers`. */
export interface TaskTruth {
  /** Repo-relative posix paths. Ordered for `flow`, sorted for every other category. */
  files: string[];
  /** Enclosing function/method/class names of each call site, sorted (`callers` only). */
  symbols?: string[];
}

/** One benchmark task. Serialised as-is into `bench/tasks/<repo>-flow.json`. */
export interface Task {
  /** `<repo>-<def|imp|call|blast|flow>-NN`, stable for a (repo, seed, truth). */
  id: string;
  category: TaskCategory;
  /** Ends with `ANSWER_FILES`, or `ANSWER_FILES_AND_SYMBOLS` for `callers`. */
  prompt: string;
  truth: TaskTruth;
  /** Where the answer key came from, quoted verbatim in `RESULTS.md`. */
  truth_source: string;
}

/** The four generated categories, in the order their tasks are emitted. */
const STRUCTURAL: readonly { category: TaskCategory; slug: string }[] = [
  { category: "definition", slug: "def" },
  { category: "importers", slug: "imp" },
  { category: "callers", slug: "call" },
  { category: "blast_radius", slug: "blast" },
];

/**
 * Files that may not be a task *subject*. Asking "what imports this test file"
 * measures nothing about navigating a codebase, and hono's `runtime-tests/`
 * alone would otherwise supply most of the candidate pool.
 *
 * They stay in the *answers*: a test file that imports the subject really does
 * import it, and hiding that would make the answer key disagree with tsc.
 */
const NON_SUBJECT = /(^|\/)(tests?|__tests__|runtime-tests|benchmarks?|perf-measures|examples?|fixtures)\//;
const NON_SUBJECT_FILE = /\.(test|spec|bench)\.[cm]?[jt]sx?$/;

function isSubjectCandidate(file: string): boolean {
  return !NON_SUBJECT.test(file) && !NON_SUBJECT_FILE.test(file);
}

// ---------------------------------------------------------------------------
// deterministic selection
// ---------------------------------------------------------------------------

/** FNV-1a over a string, so a seed can be mixed with the repo and category names. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32: 32 bits of state, uniform enough to shuffle a candidate list. */
function mulberry32(state: number): () => number {
  let value = state >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The first `count` of `items` after a seeded Fisher-Yates shuffle.
 *
 * `items` must already be in a deterministic order (every caller sorts with
 * `compareStrings`), because the shuffle permutes the input, it does not order it.
 */
function pick<T>(items: T[], count: number, seed: number): T[] {
  const shuffled = items.slice();
  const random = mulberry32(seed);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = shuffled[i] as T;
    const b = shuffled[j] as T;
    shuffled[i] = b;
    shuffled[j] = a;
  }
  return shuffled.slice(0, Math.max(0, count));
}

/**
 * `preferred` when it can fill the quota on its own, `all` otherwise.
 *
 * Used to bias every category towards the interesting end of its pool (a file
 * with several importers, a symbol with several call sites) without ever
 * shrinking the suite: a repo that cannot supply `count` interesting subjects
 * gets the boring ones rather than fewer tasks.
 */
function preferring<T>(all: T[], preferred: T[], count: number): T[] {
  return preferred.length >= count ? preferred : all;
}

/** `n` split over `parts` buckets, the remainder going to the earliest buckets. */
function split(n: number, parts: number): number[] {
  const base = Math.floor(Math.max(0, n) / parts);
  const extra = Math.max(0, n) % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

// ---------------------------------------------------------------------------
// truth-derived candidate pools
// ---------------------------------------------------------------------------

/** The file part of a node id: `a/b.ts#Sym` -> `a/b.ts`. */
function fileOf(id: string): string {
  const hash = id.indexOf("#");
  return hash === -1 ? id : id.slice(0, hash);
}

/** The symbol part of a node id: `a/b.ts#C.m` -> `C.m`, `a/b.ts` -> `""`. */
function symbolOf(id: string): string {
  const hash = id.indexOf("#");
  return hash === -1 ? "" : id.slice(hash + 1);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

interface DefinitionCandidate {
  symbol: string;
  file: string;
}

/**
 * Symbols whose declaring file the compiler pinned down exactly once.
 *
 * The source is the call graph, not the export map: `truth.calls` targets are
 * `<file>#<symbol>` ids resolved by the checker, so they name the file that
 * *declares* the symbol. Export lists cannot do that job, because a barrel
 * re-exports a name it does not declare and "where is `retry` defined" would
 * have two answers, one of them wrong.
 *
 * A name declared in two files is dropped: the question would then have two
 * right answers and `definition` is scored as an exact match.
 */
function definitionCandidates(truth: Truth): DefinitionCandidate[] {
  const files = new Map<string, Set<string>>();
  for (const edge of truth.calls) {
    const symbol = symbolOf(edge.to);
    // Members are addressed as `Class.method`; "where is `publish` defined" is a
    // different, much weaker question, so only top-level names are subjects.
    if (symbol === "" || symbol.includes(".")) continue;
    const file = fileOf(edge.to);
    if (!isSubjectCandidate(file)) continue;
    const seen = files.get(symbol) ?? new Set<string>();
    seen.add(file);
    files.set(symbol, seen);
  }
  const out: DefinitionCandidate[] = [];
  for (const [symbol, declaring] of files) {
    const [only] = [...declaring];
    if (declaring.size === 1 && only !== undefined) out.push({ symbol, file: only });
  }
  return out.sort((a, b) => compareStrings(a.symbol, b.symbol));
}

interface FileCandidate {
  file: string;
  related: string[];
}

/** Every file with at least one direct importer, with those importers. */
function importerCandidates(truth: Truth): FileCandidate[] {
  const importers = new Map<string, string[]>();
  for (const edge of truth.imports) {
    if (edge.from === edge.to) continue;
    importers.set(edge.to, [...(importers.get(edge.to) ?? []), edge.from]);
  }
  return [...importers]
    .filter(([file]) => isSubjectCandidate(file))
    .map(([file, from]) => ({ file, related: sortedUnique(from) }))
    .sort((a, b) => compareStrings(a.file, b.file));
}

interface CallerCandidate {
  /** The called declaration, `<file>#<symbol>`. */
  id: string;
  file: string;
  symbol: string;
  files: string[];
  symbols: string[];
}

/** Every called declaration, with the files and enclosing symbols that call it. */
function callerCandidates(truth: Truth): CallerCandidate[] {
  const callers = new Map<string, Edge[]>();
  for (const edge of truth.calls) {
    if (edge.from === edge.to) continue;
    callers.set(edge.to, [...(callers.get(edge.to) ?? []), edge]);
  }
  const out: CallerCandidate[] = [];
  for (const [id, edges] of callers) {
    const file = fileOf(id);
    const symbol = symbolOf(id);
    if (symbol === "" || !isSubjectCandidate(file)) continue;
    // A call at a file's top level has no enclosing declaration; it contributes
    // a file and no symbol rather than an invented one.
    const symbols = sortedUnique(edges.map((edge) => symbolOf(edge.from)).filter((name) => name !== ""));
    // Every call site being top-level leaves the prompt asking for symbols whose
    // right answer is "none". That is an unanswerable question, not a hard one,
    // so the symbol is a candidacy requirement rather than a preference.
    if (symbols.length === 0) continue;
    out.push({
      id,
      file,
      symbol,
      files: sortedUnique(edges.map((edge) => fileOf(edge.from))),
      symbols,
    });
  }
  return out.sort((a, b) => compareStrings(a.id, b.id));
}

/**
 * Reverse closure over the truth import graph: every file that reaches `file`
 * through any chain of imports, excluding `file` itself.
 *
 * Iterative and visited-guarded, because import cycles are real (the fixture
 * has one) and a recursive walk over them does not terminate.
 */
export function reverseClosure(imports: Edge[], file: string): string[] {
  const importers = new Map<string, string[]>();
  for (const edge of imports) {
    importers.set(edge.to, [...(importers.get(edge.to) ?? []), edge.from]);
  }
  const seen = new Set<string>([file]);
  const queue = [file];
  const out: string[] = [];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const importer of importers.get(current) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      out.push(importer);
      queue.push(importer);
    }
  }
  return out.sort(compareStrings);
}

/** Every file something transitively imports, with that reverse closure. */
function blastCandidates(truth: Truth): FileCandidate[] {
  return truth.files
    .filter(isSubjectCandidate)
    .map((file) => ({ file, related: reverseClosure(truth.imports, file) }))
    .filter((candidate) => candidate.related.length > 0)
    .sort((a, b) => compareStrings(a.file, b.file));
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------

function id(repo: string, slug: string, index: number): string {
  return `${repo}-${slug}-${String(index + 1).padStart(2, "0")}`;
}

/**
 * `n` structural tasks for `repo`, derived from `truth`.
 *
 * `n` is split evenly over the four generated categories (remainder to the
 * earliest), and a category that cannot supply its share contributes what it
 * has: the suite shrinks, it never invents a task whose answer key is guessed.
 *
 * `seed` selects *which* candidates are used; it does not affect ids, ordering
 * or the answer keys. Record it next to the results.
 */
export function generateStructuralTasks(repo: string, truth: Truth, n: number, seed: number = 1): Task[] {
  const quotas = split(n, STRUCTURAL.length);
  const tasks: Task[] = [];

  const definitions = definitionCandidates(truth);
  const importers = importerCandidates(truth);
  const callers = callerCandidates(truth);
  const blast = blastCandidates(truth);

  for (let category = 0; category < STRUCTURAL.length; category++) {
    const entry = STRUCTURAL[category] as { category: TaskCategory; slug: string };
    const quota = quotas[category] ?? 0;
    // The seed is mixed with the repo and the category so the four categories
    // walk their candidate lists independently.
    const stream = (fnv1a(`${repo}/${entry.category}`) ^ Math.imul(seed >>> 0, 0x9e3779b1)) >>> 0;

    if (entry.category === "definition") {
      const chosen = pick(definitions, quota, stream);
      chosen.forEach((candidate, index) => {
        tasks.push({
          id: id(repo, entry.slug, index),
          category: "definition",
          prompt:
            `Where is \`${candidate.symbol}\` defined? Give the repository-relative path of the ` +
            `single file that declares it. ${ANSWER_FILES}`,
          truth: { files: [candidate.file] },
          truth_source: "tsc call-graph declaration site",
        });
      });
    } else if (entry.category === "importers") {
      const chosen = pick(
        preferring(importers, importers.filter((c) => c.related.length >= 2), quota),
        quota,
        stream,
      );
      chosen.forEach((candidate, index) => {
        tasks.push({
          id: id(repo, entry.slug, index),
          category: "importers",
          prompt:
            `Which files import \`${candidate.file}\`? List every file in this repository that ` +
            `imports or re-exports it directly, as repository-relative paths. ${ANSWER_FILES}`,
          truth: { files: candidate.related },
          truth_source: "tsc import graph",
        });
      });
    } else if (entry.category === "callers") {
      const chosen = pick(preferring(callers, callers.filter((c) => c.files.length >= 2), quota), quota, stream);
      chosen.forEach((candidate, index) => {
        tasks.push({
          id: id(repo, entry.slug, index),
          category: "callers",
          prompt:
            `What calls \`${candidate.symbol}\`, declared in \`${candidate.file}\`? List every ` +
            `repository-relative file with a call site, and for "symbols" the name of the ` +
            `function, method or class that encloses each call ` +
            `(\`method\` as \`Class.method\`). ${ANSWER_FILES_AND_SYMBOLS}`,
          truth: { files: candidate.files, symbols: candidate.symbols },
          truth_source: "tsc call graph",
        });
      });
    } else {
      const chosen = pick(preferring(blast, blast.filter((c) => c.related.length >= 2), quota), quota, stream);
      chosen.forEach((candidate, index) => {
        tasks.push({
          id: id(repo, entry.slug, index),
          category: "blast_radius",
          prompt:
            `What breaks if I change \`${candidate.file}\`? List every file that transitively ` +
            `imports it, as repository-relative paths. ${ANSWER_FILES}`,
          truth: { files: candidate.related },
          truth_source: "tsc import graph, reverse closure",
        });
      });
    }
  }

  return tasks;
}

/** The two categories curated by hand rather than derived from compiler truth. */
export type CuratedCategory = "flow" | "orientation";

/** Where a repo's curated tasks for `category` live. `dir` is a test-only override. */
export function curatedTasksFile(repo: string, category: CuratedCategory, dir?: string): string {
  return path.join(dir ?? path.join(REPO_ROOT, "bench", "tasks"), `${repo}-${category}.json`);
}

/** Where a repo's curated flow tasks live. */
export function flowTasksFile(repo: string, dir?: string): string {
  return curatedTasksFile(repo, "flow", dir);
}

/**
 * Load and validate one category of curated tasks for `repo`, or `[]` when the
 * repo has no file for it.
 *
 * Validation is strict and total, because these are the only answer keys in the
 * suite a human wrote: a typo has to stop the run rather than quietly change
 * what is being measured. Ids must carry the `<repo>-<category>-` prefix (an id
 * copied from another repo would collide in the results table) and be unique
 * inside the file (a duplicate id silently overwrites its twin in every
 * per-task aggregation, including the win/loss/tie count).
 */
function loadCuratedTasks(repo: string, category: CuratedCategory, dir?: string): Task[] {
  const file = curatedTasksFile(repo, category, dir);
  if (!existsSync(file)) return [];
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`greplost: ${file} must contain a JSON array of tasks`);

  const prefix = `${repo}-${category}-`;
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    const task = entry as Partial<Task>;
    const where = `${file}[${index}]`;
    if (typeof task.id !== "string" || task.id === "") throw new Error(`greplost: ${where} has no id`);
    if (!task.id.startsWith(prefix)) {
      throw new Error(`greplost: ${where} id "${task.id}" must start with "${prefix}"`);
    }
    if (seen.has(task.id)) throw new Error(`greplost: ${where} has the duplicate id "${task.id}"`);
    seen.add(task.id);
    if (task.category !== category) {
      throw new Error(`greplost: ${where} (${task.id}) is not category "${category}"`);
    }
    if (typeof task.prompt !== "string" || !task.prompt.includes(ANSWER_SHAPE)) {
      throw new Error(`greplost: ${where} (${task.id}) prompt must state the answer shape ${ANSWER_SHAPE}`);
    }
    // A flow prompt is shaped like a generated one and must end with the
    // instruction; the orientation prompt is fixed wording for X8 that carries
    // the shape mid-sentence, so it only has to contain it.
    if (category === "flow" && !task.prompt.endsWith(ANSWER_FILES)) {
      throw new Error(`greplost: ${where} (${task.id}) prompt must end with: ${ANSWER_FILES}`);
    }
    const files = task.truth?.files;
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error(`greplost: ${where} (${task.id}) has no truth.files`);
    }
    if (typeof task.truth_source !== "string" || task.truth_source === "") {
      throw new Error(`greplost: ${where} (${task.id}) has no truth_source`);
    }
    return { id: task.id, category, prompt: task.prompt, truth: { files }, truth_source: task.truth_source };
  });
}

/**
 * The curated `flow` tasks for `repo`, or `[]` when the repo has none.
 *
 * These are the one category no oracle can produce: an ordered walk from an
 * entry point to an effect. Each file records who traced it and against which
 * commit (`truth_source`), because an answer key nobody can audit is not truth.
 */
export function loadFlowTasks(repo: string, dir?: string): Task[] {
  return loadCuratedTasks(repo, "flow", dir);
}

/**
 * The curated `orientation` task for `repo`: X8's "what are the main components
 * of this repo?" (tech spec 10.0), scored as set overlap against a curated answer.
 *
 * Curated for the same reason flows are - no compiler knows what a *component*
 * is - and held to the same bar: the `truth_source` states the rule that picked
 * every file and the rule that excluded the rest, so the key can be argued with.
 */
export function loadOrientationTasks(repo: string, dir?: string): Task[] {
  return loadCuratedTasks(repo, "orientation", dir);
}

/**
 * The full suite for a repo: generated structural tasks, then the curated flow
 * and orientation tasks, optionally narrowed to `categories`.
 *
 * Narrowing is what X7 needs (Eval 4 restricted to the four structural
 * categories) and what X8 needs (the orientation task alone).
 */
export function loadTasks(
  repo: string,
  truth: Truth,
  n: number,
  seed: number = 1,
  categories?: readonly TaskCategory[],
): Task[] {
  const wanted = categories === undefined ? null : new Set<TaskCategory>(categories);
  const all = [
    ...generateStructuralTasks(repo, truth, n, seed),
    ...loadFlowTasks(repo),
    ...loadOrientationTasks(repo),
  ];
  return wanted === null ? all : all.filter((task) => wanted.has(task.category));
}
