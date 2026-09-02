/**
 * Eval 1: structural accuracy S1 to S4 (tech spec 3 and 10.3, bench spec 1.5.1).
 *
 * For each repo in the tier (or the fixture): build a greplost snapshot, generate
 * compiler truth for the same file list, and score the two with `src/score.ts`.
 *
 *   S1  import edge precision / recall           >= 0.99 / >= 0.97
 *   S2  export precision / recall                >= 0.99 / >= 0.99
 *   S3  call edge precision at confidence=high   >= 0.95   (recall reported, not gated)
 *   S4  import cycle Jaccard                     = 1.00 (exact set match)
 *
 * Both sides are restricted to the same file set before scoring: `ext:` and
 * `unresolved:` targets are dropped, and so is any edge touching a file the truth
 * generator was not given (an import of a `.json` or `.css` file, say). A metric is
 * only meaningful when the two sides could have produced the same keys.
 *
 * `--dry-run` prints the table shape and stops: it never loads `@greplost/core`, so
 * `bench all --dry-run` works before the core build exists and on a machine with no
 * corpus checked out.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ARTIFACT_DIR,
  ARTIFACT_PATHS,
  DEFAULT_CONFIG,
  compareStrings,
  isFileId,
  type GreplostConfig,
  type Snapshot,
} from "@greplost/core/schema";
import { exportKeys, jaccardCycles, scoreEdges, scoreSet, type Score } from "./score.ts";
import { writeResult } from "./results-io.ts";
import { generateTsTruth, type Truth } from "./truth/ts.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const SUITE = "structural";
/** Section 3 gate thresholds. S1/S2 are [precision, recall]; S3 is precision; S4 is Jaccard. */
export const TARGETS = { S1: [0.99, 0.97], S2: [0.99, 0.99], S3: 0.95, S4: 1.0 } as const;
/** Floating-point slack, so 0.98999999999 never fails a 0.99 gate for arithmetic reasons. */
const EPSILON = 1e-9;
const MAX_REPORTED_FALSE_POSITIVES = 20;
/** Metric ids in table order, for the verbose listing. */
const METRIC_IDS = ["S1", "S2", "S3", "S4"] as const;

/** Languages the structural suite can score; each has its own truth generator. */
export type TruthLang = "ts" | "go";

interface Options {
  fixture: boolean;
  fixtureGo: boolean;
  repo: string | undefined;
  tier: string;
  gate: boolean;
  dryRun: boolean;
  /** Run a full semantic check in the truth generator and report the count (expensive). */
  diagnostics: boolean;
  /** List false positives *and* false negatives for every metric, not only failed ones. */
  verbose: boolean;
}

interface Target {
  name: string;
  /** Absolute repo root, or "" for the placeholder printed by --dry-run with no corpus. */
  root: string;
  lang: TruthLang;
  sha: string | null;
}

/** One repo's S1 to S4 result. */
export interface RepoScores {
  name: string;
  files: number;
  S1: Score;
  S2: Score;
  /** Calls at confidence=high: the S3 gate. */
  S3: Score;
  /** Calls at any confidence, reported next to S3 so dropped edges stay visible. */
  callsAll: Score;
  S4: number;
  /**
   * True when the compiler truth for a non-empty file set contains no imports and no
   * exports at all. Every metric then scores a vacuous 1.000, so this is a gate miss in
   * its own right (`truth-empty`) rather than a warning.
   */
  truthEmpty: boolean;
  /**
   * True when the snapshot indexed no file at all in the target's declared language.
   * Nothing was predicted and nothing was expected, so all four metrics score 1.000 on
   * an empty universe: a miss of its own (`no-files`), usually a config that excluded
   * the language or a repo root that is not the checkout.
   */
  noFiles: boolean;
  /** Metric id -> `file:line (key)` for the first false positives, so a failure is actionable. */
  falsePositives: Record<string, string[]>;
  /**
   * Metric id -> `file:line (key)` for the first false negatives: edges the compiler found
   * and greplost did not. Never gated (S3 recall is reported, not gated) but printed by
   * `--fp all`, because a recall gap is the thing worth reading after precision is clean.
   */
  falseNegatives: Record<string, string[]>;
  /** Emulations the truth generator applied for this repo (see `Truth.notes`). */
  notes: string[];
}

export async function run(args: string[]): Promise<number> {
  const options = parseArgs(args);
  warnOnRedirectedResults();
  try {
    return await execute(options);
  } catch (err) {
    // Nothing below the argument parser may escape: `run` always returns an exit code, and
    // the last stdout line always follows the suite's convention.
    console.error(`${SUITE}: ${(err as Error).message}`);
    console.log(`${SUITE}: GATE FAIL (error)`);
    return 1;
  }
}

async function execute(options: Options): Promise<number> {
  const targets = resolveTargets(options);
  if (typeof targets === "string") {
    console.error(targets);
    console.log(`${SUITE}: GATE FAIL (targets)`);
    return 2;
  }

  if (options.dryRun) {
    for (const target of targets) printTable(target.name, null);
    console.log(`${SUITE}: dry-run ok`);
    return 0;
  }

  const scores: RepoScores[] = [];
  try {
    for (const target of targets) scores.push(await scoreTarget(target, options));
  } catch (err) {
    console.error(`${SUITE}: ${(err as Error).message}`);
    console.log(`${SUITE}: GATE FAIL (build)`);
    return 1;
  }
  for (const score of scores) printTable(score.name, score);
  if (options.verbose) printMisses(scores, METRIC_IDS, true);

  const missed = [...new Set(scores.flatMap(missedMetrics))].sort(compareStrings);
  writeResult(SUITE, {
    corpus: targets.map((t) => (t.sha === null ? { name: t.name } : { name: t.name, sha: t.sha })),
    machine: await loadMachine(),
    repos: Object.fromEntries(scores.map((s) => [s.name, serializeScores(s)])),
    targets: TARGETS,
    // Disclosed so RESULTS.md can state how the oracle was built, not just what it scored.
    truth: { notes: [...new Set(scores.flatMap((s) => s.notes))].sort(compareStrings) },
    gate: options.gate ? { passed: missed.length === 0, missed } : null,
  });

  if (!options.gate) return 0;
  if (missed.length > 0) {
    if (!options.verbose) printMisses(scores, missed, false);
    console.log(`${SUITE}: GATE FAIL (${missed.join(",")})`);
    return 1;
  }
  console.log(`${SUITE}: GATE PASS`);
  return 0;
}

// ---------------------------------------------------------------------------
// arguments and targets
// ---------------------------------------------------------------------------

/**
 * `GREPLOST_BENCH_RESULTS_DIR` is a test-only escape hatch (see `results-io.ts`). If it is
 * set for a real run, results are not landing in `bench/results/` and nobody would know.
 */
function warnOnRedirectedResults(): void {
  const override = process.env["GREPLOST_BENCH_RESULTS_DIR"];
  if (!override || process.env["NODE_ENV"] === "test") return;
  console.error(
    `${SUITE}: warning: GREPLOST_BENCH_RESULTS_DIR is set, so results go to ${override} ` +
      "instead of bench/results/; that override is meant for tests only",
  );
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    fixture: false,
    fixtureGo: false,
    repo: undefined,
    tier: "S",
    gate: false,
    dryRun: false,
    diagnostics: process.env["GREPLOST_BENCH_DIAGNOSTICS"] === "1",
    verbose: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Unknown flags are ignored on purpose: `bench all` forwards one argument list to
    // every suite, so structural also sees replay's and perf's flags.
    if (arg === "--fixture") options.fixture = true;
    else if (arg === "--fixture-go") options.fixtureGo = true;
    else if (arg === "--gate") options.gate = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--diagnostics") options.diagnostics = true;
    else if (arg === "--verbose") options.verbose = true;
    // `--fp all` lists every metric's misses; any other value keeps the default (failed only).
    else if (arg === "--fp") options.verbose = args[++i] === "all";
    else if (arg === "--repo") options.repo = args[++i];
    else if (arg === "--tier") options.tier = args[++i] ?? "S";
  }
  return options;
}

interface CorpusRepo {
  name: string;
  sha?: string;
  tier?: string;
  lang?: string;
}

function readCorpus(): CorpusRepo[] | null {
  const file = path.join(REPO_ROOT, "bench", "corpus.json");
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { repos?: CorpusRepo[] };
  return parsed.repos ?? [];
}

/** The repos to score, or an error message. */
function resolveTargets(options: Options): Target[] | string {
  if (options.fixture) {
    return [{ name: "tiny-ts", root: path.join(REPO_ROOT, "fixtures", "tiny-ts"), lang: "ts", sha: null }];
  }
  if (options.fixtureGo) {
    return [{ name: "tiny-go", root: path.join(REPO_ROOT, "fixtures", "tiny-go"), lang: "go", sha: null }];
  }

  const corpus = readCorpus();
  if (corpus === null) {
    // Nothing is measured in a dry run, so an absent corpus is not an error there:
    // print the shape for the tier that would have run.
    if (options.dryRun) return [{ name: `tier ${options.tier} (corpus not set up)`, root: "", lang: "ts", sha: null }];
    return `${SUITE}: bench/corpus.json is missing; run \`bun bench/src/cli.ts corpus setup --tier ${options.tier}\` or pass --fixture`;
  }

  const wanted =
    options.repo === undefined
      ? corpus.filter((repo) => (repo.tier ?? "S") === options.tier)
      : corpus.filter((repo) => repo.name === options.repo);
  if (wanted.length === 0) {
    return options.repo === undefined
      ? `${SUITE}: no repos in tier ${options.tier} in bench/corpus.json`
      : `${SUITE}: unknown repo "${options.repo}" in bench/corpus.json`;
  }

  return wanted
    .map((repo) => ({
      name: repo.name,
      root: path.join(REPO_ROOT, "bench", ".corpus", repo.name),
      lang: repo.lang === "go" ? ("go" as const) : ("ts" as const),
      sha: repo.sha ?? null,
    }))
    .sort((a, b) => compareStrings(a.name, b.name));
}

// ---------------------------------------------------------------------------
// lazily loaded neighbours (none of this may run in --dry-run)
// ---------------------------------------------------------------------------

/** `buildSnapshot` lives in leaf 1.1.5 and is loaded only when something is measured. */
type BuildSnapshot = (opts: { root: string; config?: GreplostConfig }) => Promise<Snapshot>;

async function loadBuildSnapshot(): Promise<BuildSnapshot> {
  // The specifier is built at runtime so this file typechecks before core's build lands
  // (the dispatcher in cli.ts does the same for the suites themselves).
  const specifier = "@greplost/core";
  const mod = (await import(specifier)) as Partial<{ buildSnapshot: BuildSnapshot }>;
  const { buildSnapshot } = mod;
  if (typeof buildSnapshot !== "function") {
    throw new Error("greplost: @greplost/core does not export buildSnapshot yet (leaf 1.1.5 provides it)");
  }
  return buildSnapshot;
}

/**
 * Go truth (leaf 1.8), loaded the same way. The contract that file must satisfy:
 * `export function generateGoTruth(root: string, files: string[]): Truth`, using the
 * same id vocabulary as `generateTsTruth` (directory ids for Go import targets).
 */
async function loadGoTruth(): Promise<(root: string, files: string[]) => Truth> {
  const specifier = "./truth/go.ts";
  type GoModule = Partial<{ generateGoTruth: (root: string, files: string[]) => Truth }>;
  let mod: GoModule;
  try {
    mod = (await import(specifier)) as GoModule;
  } catch {
    throw new Error("greplost: bench/src/truth/go.ts is not implemented yet (leaf 1.8 provides it)");
  }
  const { generateGoTruth } = mod;
  if (typeof generateGoTruth !== "function") {
    throw new Error("greplost: bench/src/truth/go.ts does not export generateGoTruth");
  }
  return generateGoTruth;
}

/** The optional machine profile (leaf 1.5.3); null until that suite lands. */
async function loadMachine(): Promise<unknown> {
  const specifier = "./machine.ts";
  try {
    const mod = (await import(specifier)) as Partial<{ machineProfile: () => unknown; machine: () => unknown }>;
    const read = mod.machineProfile ?? mod.machine;
    return typeof read === "function" ? read() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

/**
 * Build options for one target. `DEFAULT_CONFIG.languages` does not include `go`
 * (it is opt-in per repo), so a Go corpus checkout with no committed
 * `.greplost/config.json` would index nothing at all and score four vacuous
 * 1.000s. The runner supplies exactly that one override, and only when the repo
 * has not already made the choice itself.
 */
function buildOptionsFor(target: Target): { root: string; config?: GreplostConfig } {
  if (target.lang !== "go") return { root: target.root };
  if (existsSync(path.join(target.root, ARTIFACT_DIR, ARTIFACT_PATHS.config))) return { root: target.root };
  return { root: target.root, config: { ...DEFAULT_CONFIG, languages: ["go"] } };
}

async function scoreTarget(target: Target, options: Options): Promise<RepoScores> {
  const buildSnapshot = await loadBuildSnapshot();
  const snapshot = await buildSnapshot(buildOptionsFor(target));
  const files = scoredFiles(snapshot, target.lang);
  const truth =
    target.lang === "go"
      ? (await loadGoTruth())(target.root, files)
      : generateTsTruth(target.root, files, { diagnostics: options.diagnostics });
  return scoreAgainstTruth(target.name, snapshot, truth, target.lang);
}

/** The snapshot files the truth generator for `lang` can speak about, sorted. */
export function scoredFiles(snapshot: Snapshot, lang: TruthLang): string[] {
  const wanted =
    lang === "go"
      ? (l: string) => l === "go"
      : (l: string) => l === "ts" || l === "tsx" || l === "js" || l === "jsx";
  return snapshot.files
    .filter((file) => wanted(file.lang))
    .map((file) => file.path)
    .sort(compareStrings);
}

/**
 * Score one snapshot against one truth set. Pure: everything expensive already happened.
 *
 * Both sides are cut down to the same file universe first, so a metric never punishes
 * greplost for an edge the truth generator was structurally unable to produce.
 */
export function scoreAgainstTruth(name: string, snapshot: Snapshot, truth: Truth, lang: TruthLang): RepoScores {
  // The universe is what *both* sides could speak about: the snapshot's files for this
  // language, intersected with the files the truth generator actually covered. A file the
  // compiler could not load would otherwise be scored as "exports nothing".
  // `truth.files` is defensive: a truth generator that predates the field (leaf 1.8's Go
  // implementation) falls back to the snapshot's own list.
  const covered = Array.isArray(truth.files) && truth.files.length > 0 ? new Set(truth.files) : null;
  const files = scoredFiles(snapshot, lang).filter((file) => covered === null || covered.has(file));
  const fileSet = new Set(files);
  // A Go import names a package, so both sides target the package *directory*
  // (tech spec Appendix C). Those ids are not files and would otherwise be
  // filtered off both sides, turning S1 into a vacuous 1.000; the covered
  // universe therefore includes the directories the covered files live in.
  const dirSet = lang === "go" ? new Set(files.map(directoryOf)) : new Set<string>();
  const coveredTarget = (id: string): boolean => fileSet.has(id) || dirSet.has(id);

  const predImports = snapshot.imports.filter((e) => isFileId(e.to) && fileSet.has(e.from) && coveredTarget(e.to));
  const predCalls = snapshot.calls.filter((e) => fileSet.has(fileOf(e.from)) && fileSet.has(fileOf(e.to)));
  const predExports: Record<string, string[]> = {};
  for (const file of files) predExports[file] = snapshot.manifest.files[file]?.exports ?? [];
  const predCycles = snapshot.metrics.cycles.filter((cycle) => cycle.every((id) => fileSet.has(id)));

  const truthImports = truth.imports.filter((e) => fileSet.has(e.from) && coveredTarget(e.to));
  const truthCalls = truth.calls.filter((e) => fileSet.has(fileOf(e.from)) && fileSet.has(fileOf(e.to)));
  const truthExports: Record<string, string[]> = {};
  for (const file of files) truthExports[file] = truth.exports[file] ?? [];

  const S1 = scoreEdges(predImports, truthImports);
  const S2 = scoreSet(exportKeys(predExports), exportKeys(truthExports));
  const S3 = scoreEdges(
    predCalls.filter((e) => e.confidence === "high"),
    truthCalls,
  );
  const callsAll = scoreEdges(predCalls, truthCalls);
  const S4 = jaccardCycles(predCycles, truth.cycles);

  // Integrity guard (tech spec 10.1, principle 2). An empty truth set scores an empty
  // prediction as a perfect 1.000 across the board, so a truth generator that quietly
  // resolved nothing would turn Eval 1 into a rubber stamp.
  //
  // Two ways to be empty, and the second one used to slip through: a truth set
  // that covered *none* of the language's files leaves `files` empty, so every
  // "across the covered files" test is vacuously true. The universe therefore
  // has to be judged against what the snapshot offered, not against what
  // survived the intersection.
  const offered = scoredFiles(snapshot, lang).length;
  // The snapshot side of the same integrity question: a repo greplost indexed
  // nothing in scores four vacuous 1.000s just as loudly as an empty oracle.
  const noFiles = offered === 0;
  if (noFiles) {
    console.error(
      `${SUITE}: greplost indexed no ${lang} file in ${name}; the scores below are meaningless ` +
        `(check the repo root and .greplost/config.json "languages")`,
    );
  }
  const truthEmpty =
    offered > 0 && (files.length === 0 || (truthImports.length === 0 && exportKeys(truthExports).length === 0));
  if (truthEmpty) {
    console.error(
      `${SUITE}: compiler truth for ${name} is empty across ${offered} files ` +
        `(${files.length} covered); the scores below are meaningless (check the repo root and its toolchain)`,
    );
  }

  return {
    name,
    files: files.length,
    S1,
    S2,
    S3,
    callsAll,
    S4,
    truthEmpty,
    noFiles,
    notes: Array.isArray(truth.notes) ? truth.notes : [],
    falsePositives: {
      S1: locateAll(snapshot, S1.falsePositives, "import"),
      S2: locateAll(snapshot, S2.falsePositives, "export"),
      S3: locateAll(snapshot, S3.falsePositives, "call"),
      S4: predCycles
        .filter((cycle) => !truth.cycles.some((expected) => sameCycle(expected, cycle)))
        .slice(0, MAX_REPORTED_FALSE_POSITIVES)
        .map((cycle) => `${cycle[0] ?? "?"}:1 (cycle ${cycle.join(" -> ")})`),
    },
    falseNegatives: {
      S1: locateAll(snapshot, S1.falseNegatives, "import"),
      S2: locateAll(snapshot, S2.falseNegatives, "export"),
      S3: locateAll(snapshot, S3.falseNegatives, "call"),
      S4: truth.cycles
        .filter((cycle) => !predCycles.some((predicted) => sameCycle(predicted, cycle)))
        .slice(0, MAX_REPORTED_FALSE_POSITIVES)
        .map((cycle) => `${cycle[0] ?? "?"}:1 (cycle ${cycle.join(" -> ")})`),
    },
  };
}

/**
 * The gate ids this repo missed, in id order. Empty means the repo passes Eval 1.
 *
 * `truth-empty` and `no-files` are misses in their own right: without them a run where the
 * oracle, or greplost, or both produced nothing would report four perfect scores and pass
 * the gate.
 */
export function missedMetrics(scores: RepoScores): string[] {
  const missed: string[] = [];
  const [p1 = 1, r1 = 1] = TARGETS.S1;
  const [p2 = 1, r2 = 1] = TARGETS.S2;
  if (scores.S1.precision < p1 - EPSILON || scores.S1.recall < r1 - EPSILON) missed.push("S1");
  if (scores.S2.precision < p2 - EPSILON || scores.S2.recall < r2 - EPSILON) missed.push("S2");
  if (scores.S3.precision < TARGETS.S3 - EPSILON) missed.push("S3");
  if (scores.S4 < TARGETS.S4 - EPSILON) missed.push("S4");
  if (scores.truthEmpty) missed.push("truth-empty");
  if (scores.noFiles) missed.push("no-files");
  return missed;
}

function serializeScores(scores: RepoScores): Record<string, unknown> {
  const brief = (score: Score): Record<string, number> => ({
    precision: score.precision,
    recall: score.recall,
    f1: score.f1,
    tp: score.tp,
    fp: score.fp,
    fn: score.fn,
  });
  return {
    files: scores.files,
    S1: brief(scores.S1),
    S2: brief(scores.S2),
    S3: brief(scores.S3),
    callsAllConfidences: brief(scores.callsAll),
    S4: scores.S4,
    truthEmpty: scores.truthEmpty,
    noFiles: scores.noFiles,
    falsePositives: scores.falsePositives,
    falseNegatives: scores.falseNegatives,
  };
}

// ---------------------------------------------------------------------------
// locating false positives (`file:line`)
// ---------------------------------------------------------------------------

/** The directory of a repo-relative file, `"."` at the repo root (a Go package id). */
function directoryOf(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? "." : file.slice(0, slash);
}

/** The file part of a node id: `a/b.ts#Sym` -> `a/b.ts`, `a/b.ts` -> `a/b.ts`. */
function fileOf(id: string): string {
  const hash = id.indexOf("#");
  return hash === -1 ? id : id.slice(0, hash);
}

function locateAll(snapshot: Snapshot, keys: string[], kind: "import" | "call" | "export"): string[] {
  return keys.slice(0, MAX_REPORTED_FALSE_POSITIVES).map((key) => `${locate(snapshot, key, kind)} (${key})`);
}

/**
 * `file:line` for a scoring key: the import statement's line for an import edge, the
 * declaration's first line for a call edge or an export, and line 1 when the snapshot
 * has nothing more precise (top-level code, or a file with no declaration for the name).
 */
export function locate(snapshot: Snapshot, key: string, kind: "import" | "call" | "export"): string {
  if (kind === "import") {
    const [from = "", to = ""] = key.split(" -> ");
    const edge = snapshot.imports.find((e) => e.from === from && e.to === to);
    const record = edge
      ? snapshot.files.find((file) => file.path === from)?.imports.find((i) => i.specifier === edge.specifier)
      : undefined;
    return `${from}:${record?.line ?? 1}`;
  }
  const id = kind === "call" ? (key.split(" -> ")[0] ?? "") : key;
  const declaration = snapshot.symbols.find((d) => d.id === id);
  return `${fileOf(id)}:${declaration?.span[0] ?? 1}`;
}

function sameCycle(a: string[], b: string[]): boolean {
  return [...a].sort(compareStrings).join(",") === [...b].sort(compareStrings).join(",");
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

const NOT_RUN = "not run";

/** The S1 to S4 table. `scores` is null for --dry-run, which prints the shape only. */
function printTable(name: string, scores: RepoScores | null): void {
  console.log(scores === null ? `${SUITE}: ${name}` : `${SUITE}: ${name} (${scores.files} files)`);

  const rows: [string, string, string, string][] = [
    [
      "S1",
      "import edge precision / recall",
      ">=0.99 / >=0.97",
      scores === null ? `${NOT_RUN} / ${NOT_RUN}` : `${num(scores.S1.precision)} / ${num(scores.S1.recall)}`,
    ],
    [
      "S2",
      "export precision / recall",
      ">=0.99 / >=0.99",
      scores === null ? `${NOT_RUN} / ${NOT_RUN}` : `${num(scores.S2.precision)} / ${num(scores.S2.recall)}`,
    ],
    ["S3", "call edge precision (confidence=high)", ">=0.95", scores === null ? NOT_RUN : num(scores.S3.precision)],
    ["S4", "import cycle Jaccard", "=1.00", scores === null ? NOT_RUN : num(scores.S4)],
  ];
  const notes =
    scores === null
      ? ["", "", "", ""]
      : [
          counts(scores.S1),
          counts(scores.S2),
          `recall ${num(scores.S3.recall)}, ${counts(scores.S3)}`,
          `all confidences: precision ${num(scores.callsAll.precision)}, recall ${num(scores.callsAll.recall)}`,
        ];

  const header: [string, string, string, string] = ["ID", "Metric", "Target", "Measured"];
  const widths = [0, 1, 2, 3].map((column) =>
    Math.max(header[column]?.length ?? 0, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: [string, string, string, string], note: string): string =>
    `  ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ")}${note ? `  ${note}` : ""}`.trimEnd();

  console.log(line(header, scores === null ? "" : "Detail"));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row) console.log(line(row, notes[i] ?? ""));
  }
}

function counts(score: Score): string {
  return `tp ${score.tp}, fp ${score.fp}, fn ${score.fn}`;
}

function num(value: number): string {
  return value.toFixed(3);
}

/**
 * List the misses behind the numbers. With `--fp all` this runs for every metric whether it
 * passed or not, and includes false negatives: precision can be clean while recall hides a
 * large, routable gap (anyq's S3 is 0.973 precision with 49 false negatives).
 */
function printMisses(scores: RepoScores[], ids: readonly string[], includeNegatives: boolean): void {
  for (const repo of scores) {
    for (const id of ids) {
      const positives = repo.falsePositives[id] ?? [];
      if (positives.length > 0) {
        console.log(`${SUITE}: ${repo.name} ${id} false positives (first ${positives.length}):`);
        for (const entry of positives) console.log(`  ${entry}`);
      }
      if (!includeNegatives) continue;
      const negatives = repo.falseNegatives[id] ?? [];
      if (negatives.length > 0) {
        console.log(`${SUITE}: ${repo.name} ${id} false negatives (first ${negatives.length}):`);
        for (const entry of negatives) console.log(`  ${entry}`);
      }
    }
  }
}
