/**
 * Eval 1: structural accuracy S1 to S6 (tech spec 3 and 10.3, bench spec 1.5.1 and 5.2).
 *
 * For each repo in the tier (or the fixture): build a greplost snapshot, generate
 * compiler truth for the same file list, and score the two with `src/score.ts`.
 *
 *   S1  import edge precision / recall           >= 0.99 / >= 0.97
 *   S2  export precision / recall                >= 0.99 / >= 0.99
 *   S3  call edge precision at confidence=high   >= 0.95   (recall reported, not gated)
 *   S4  import cycle Jaccard                     = 1.00 (exact set match)
 *   S5  reference edge precision                 >= 0.95   (schema 2)
 *   S6  signal node precision                    >= 0.95   (schema 2)
 *
 * Both sides are restricted to the same file set before scoring: `ext:` and
 * `unresolved:` targets are dropped, and so is any edge touching a file the truth
 * generator was not given (an import of a `.json` or `.css` file, say). A metric is
 * only meaningful when the two sides could have produced the same keys.
 *
 * A metric an oracle does not measure is `n/a`: never a pass, never a fail. A target whose
 * *every* gated metric is `n/a` (Kotlin, which has no corpus oracle) would otherwise pass
 * `--gate` on an extractor that returned nothing, so it is gated instead on three substitute
 * checks: a deterministic rebuild, a parse error rate under 1%, and no non-empty file that
 * yields neither a declaration nor an import.
 *
 * `--fixture <name>` selects a fixture from `src/fixtures.ts`; bare `--fixture` still means
 * `tiny-ts` and `--fixture-go` still means `tiny-go`, so every build-1 gate keeps passing.
 *
 * `--dry-run` prints the table shape and stops: it never loads `@greplost/core`, so
 * `bench all --dry-run` works before the core build exists and on a machine with no
 * corpus checked out.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ARTIFACT_DIR, ARTIFACT_PATHS, DEFAULT_CONFIG, compareStrings, isFileId, isNodeDeclaration, type Edge, type GreplostConfig, type Lang, type Snapshot } from "@greplost/core/schema";
import { isNodeKind, splitNodeId } from "@greplost/core/schema";

/** Languages whose import edges name a directory (a Go package, a Terraform module) rather than a file. */
const DIRECTORY_IMPORT_LANGS: ReadonlySet<string> = new Set(["go", "hcl"]);
import { exportKeys, jaccardCycles, scoreEdges, scoreSet, type Score } from "./score.ts";
import { writeResult } from "./results-io.ts";
import { generateTsTruth, type Truth } from "./truth/ts.ts";
import { FIXTURES, fixtureNames } from "./fixtures.ts";
import { loadTruth, type ExtraTruth, type TruthModule, type TruthTarget } from "./truth/registry.ts";
import type { CorpusRepoEntry } from "./corpus.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const SUITE = "structural";

/**
 * Where one run's result lands: `structural` for a corpus run, `structural-fixture` for
 * a run of `fixtures/tiny-ts` or `fixtures/tiny-go` (the same split `perf`, `replay` and
 * `agent` make).
 *
 * A fixture run and a corpus run of the same suite on the same day at the same commit
 * would otherwise write the *same file*, and a twelve-file smoke test would replace the
 * hono numbers under it. `latestResult("structural")` is what `report.ts` reads and what
 * fills the published S1 to S4 rows; it must never resolve to a fixture.
 */
export function resultSuite(fixture: boolean): string {
  return fixture ? `${SUITE}-fixture` : SUITE;
}

/**
 * Section 3 gate thresholds. S1/S2 are [precision, recall]; S3, S5 and S6 are precision; S4 is
 * Jaccard. S5 (reference precision) and S6 (signal-node precision) arrived with build 2 and are
 * `n/a` for a target whose oracle does not measure them, which is every build-1 target.
 */
export const TARGETS = { S1: [0.99, 0.97], S2: [0.99, 0.99], S3: 0.95, S4: 1.0, S5: 0.95, S6: 0.95 } as const;
/** Floating-point slack, so 0.98999999999 never fails a 0.99 gate for arithmetic reasons. */
const EPSILON = 1e-9;
const MAX_REPORTED_FALSE_POSITIVES = 20;
/** Metric ids in table order, for the verbose listing. */
const METRIC_IDS = ["S1", "S2", "S3", "S4", "S5", "S6"] as const;

/** How much of a target's files may fail to parse before the substitute gate fails it. */
const MAX_PARSE_ERROR_RATE = 0.01;

/**
 * Languages the structural suite can score.
 *
 * Build 1 pinned this to `"ts" | "go"` and `resolveTargets` coerced anything else to `"ts"`,
 * so a corpus entry in a third language would have been scored as TypeScript and quietly
 * reported four vacuous numbers. Widening it to `Lang` is what closes that.
 */
export type TruthLang = Lang;

/** The TypeScript family: four dialects, one truth generator, one scored file set. */
const TS_FAMILY: ReadonlySet<string> = new Set(["ts", "tsx", "js", "jsx"]);

/** True when `lang` is scored by the TypeScript oracle. */
function isTsFamily(lang: string): boolean {
  return TS_FAMILY.has(lang);
}

/** The truth module a target's language is scored against. */
export function truthTargetFor(lang: Lang): TruthTarget {
  return isTsFamily(lang) ? "ts" : lang;
}

interface Options {
  fixture: boolean;
  fixtureGo: boolean;
  /** `--fixture <name>`: a fixture from `FIXTURES`. Bare `--fixture` still means `tiny-ts`. */
  fixtureName: string | undefined;
  /** `--lang <lang>`: override the language a target is scored as. */
  lang: string | undefined;
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
  /** The corpus entry's picomatch subset, when the pin limits which files are scored. */
  subset?: string;
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
   * Reference-edge precision (schema 2). `null` when this target's oracle does not measure it,
   * which is every build-1 target: a metric nobody measured is `n/a`, never a pass and never a
   * fail.
   */
  S5: Score | null;
  /** Signal-node precision (schema 2). `null` when unmeasured, exactly like S5. */
  S6: Score | null;
  /**
   * Metric ids the truth module declared unsupported for this target (`unsupported:S3` in its
   * `NOTES`, or `reported-only` for all of them). Printed as `n/a`, never gated.
   */
  naMetrics: string[];
  /**
   * The substitute gate, run only when *every* gated metric is `n/a` (Kotlin, which has no
   * corpus oracle). Without it `--repo coroutines --gate` would pass on an extractor that
   * returned nothing at all.
   */
  substitute: SubstituteChecks | null;
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
  /**
   * Files whose tree-sitter parse root is an ERROR node, or has one as a direct child
   * (`findUnparsableFiles` in `@greplost/core`; Appendix C ruling 2026-09-03).
   *
   * Not a score and not gated: a bucket. These files are still scored, the extractor
   * recovers what it can, but whatever the grammar could not read costs S1 and S2 recall
   * with no line in the report saying so, which is what this counts. Empty on a run that
   * did not look (a pure `scoreAgainstTruth` call in a test).
   */
  unparsable: { path: string; reason: string }[];
}

/**
 * The three checks that stand in for a gate whose every metric is `n/a` (bench spec 5.2).
 *
 * They are deliberately not accuracy measures: they are the smallest set of properties an
 * extractor cannot satisfy by returning nothing. Determinism catches a build that depends on
 * discovery order; the error rate catches a grammar that cannot read the language; the
 * declaration floor catches an extractor that parses and then emits nothing.
 */
export interface SubstituteChecks {
  /** The snapshot serialises byte-identically when the repo is built twice. */
  deterministic: boolean;
  /** Fraction of the target's files whose parse root is (or holds) an ERROR node. */
  errorRate: number;
  /** Non-empty files that yielded neither a declaration nor an import, first few. */
  silentFiles: string[];
  /** How many non-empty files were silent in total. */
  silentCount: number;
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
  const unparsableReport = unparsableBucket(scores);
  if (unparsableReport.count > 0) {
    console.log(
      `${SUITE}: ${unparsableReport.count} unparsable file${unparsableReport.count === 1 ? "" : "s"} ` +
        `(tree-sitter root is ERROR or has an ERROR child): ${unparsableReport.files
          .slice(0, MAX_REPORTED_FALSE_POSITIVES)
          .map((file) => `${file.path} (${file.reason})`)
          .join(", ")}`,
    );
  }
  printSubstitute(scores);

  writeResult(resultSuite(isFixtureRun(options)), {
    corpus: targets.map((t) => (t.sha === null ? { name: t.name } : { name: t.name, sha: t.sha })),
    machine: await loadMachine(),
    repos: Object.fromEntries(scores.map((s) => [s.name, serializeScores(s)])),
    targets: TARGETS,
    perLang: perLangSummary(targets, scores),
    // Disclosed so RESULTS.md can state how the oracle was built, not just what it scored.
    truth: { notes: [...new Set(scores.flatMap((s) => s.notes))].sort(compareStrings) },
    unparsable: unparsableReport,
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
    fixtureName: undefined,
    lang: undefined,
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
    // `--fixture` takes an optional value. Bare `--fixture` still means `tiny-ts` and
    // `--fixture-go` still means `tiny-go`, because every build-1 gate is written that way;
    // a following token that is not a flag is read as a fixture name.
    if (arg === "--fixture") {
      options.fixture = true;
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options.fixtureName = next;
        i++;
      }
    } else if (arg === "--fixture-go") options.fixtureGo = true;
    else if (arg === "--lang") options.lang = args[++i];
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

/**
 * The corpus entry as the harness reads it. `CorpusRepoEntry` is the typed definition in
 * `corpus.ts`; the fields are optional here only because this file also has to survive a
 * hand-edited `corpus.json`, and a missing `lang` must be an error rather than a silent "ts".
 */
type CorpusRepo = Partial<CorpusRepoEntry> & { name: string };

function readCorpus(): CorpusRepo[] | null {
  const file = path.join(REPO_ROOT, "bench", "corpus.json");
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { repos?: CorpusRepo[] };
  return parsed.repos ?? [];
}

/** Every `Lang` value, for validating `--lang` and a corpus entry's `lang`. */
const KNOWN_LANGS: ReadonlySet<string> = new Set<Lang>([
  "ts",
  "tsx",
  "js",
  "jsx",
  "go",
  "python",
  "rust",
  "java",
  "kotlin",
  "hcl",
  "yaml",
  "dockerfile",
]);

function asLang(value: string | undefined): Lang | null {
  return value !== undefined && KNOWN_LANGS.has(value) ? (value as Lang) : null;
}

/** The repos to score, or an error message. */
function resolveTargets(options: Options): Target[] | string {
  const override = asLang(options.lang);
  if (options.lang !== undefined && override === null) {
    return `${SUITE}: unknown --lang "${options.lang}" (expected one of ${[...KNOWN_LANGS].sort().join(", ")})`;
  }

  if (options.fixture || options.fixtureGo) {
    // `--fixture-go` is build 1's spelling of `--fixture tiny-go` and stays exact.
    const name = options.fixtureGo ? "tiny-go" : (options.fixtureName ?? "tiny-ts");
    const entry = FIXTURES[name];
    if (entry === undefined) {
      return `${SUITE}: unknown fixture "${name}" (expected one of ${fixtureNames().join(", ")})`;
    }
    return [{ name, root: entry.root, lang: override ?? entry.lang, sha: null }];
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

  const unknown = wanted.filter((repo) => override === null && asLang(repo.lang) === null);
  if (unknown.length > 0) {
    // Build 1 coerced an unknown language to "ts" here, which would have scored a Python repo
    // against the TypeScript oracle and reported the result as fact.
    return (
      `${SUITE}: corpus entries with an unknown lang: ` +
      unknown.map((repo) => `${repo.name} (${repo.lang ?? "missing"})`).join(", ")
    );
  }

  return wanted
    .map((repo) => ({
      name: repo.name,
      root: path.join(REPO_ROOT, "bench", ".corpus", repo.name),
      lang: override ?? (asLang(repo.lang) as Lang),
      sha: repo.sha ?? null,
      ...(repo.subset === undefined ? {} : { subset: repo.subset }),
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
export function buildOptionsFor(target: Target): { root: string; config?: GreplostConfig } {
  const family = isTsFamily(target.lang);
  // `DEFAULT_CONFIG.languages` is the TypeScript family only, so every other language needs an
  // override or the repo would index nothing and score four vacuous 1.000s.
  const needsLanguage = !family;
  // `"**"` is "the whole repo", which is already what `DEFAULT_CONFIG.include` says.
  const needsSubset = target.subset !== undefined && target.subset !== "**";
  if (!needsLanguage && !needsSubset) return { root: target.root };

  // A repo that ships its own `.greplost/config.json` has made the language choice itself and
  // the harness must not silently disagree with a checked-in map. That deference only holds
  // while the harness has nothing else to say: a pinned subset means this run indexes a slice
  // of the repo that no committed config could know about, so the harness owns the config.
  if (needsLanguage && !needsSubset && existsSync(path.join(target.root, ARTIFACT_DIR, ARTIFACT_PATHS.config))) {
    return { root: target.root };
  }

  // The four JavaScript dialects are one family with one oracle: narrowing a `tsx` target to
  // `["tsx"]` would drop every `.ts` file the same repo is scored on.
  const languages = family ? [...DEFAULT_CONFIG.languages] : [target.lang];
  const config: GreplostConfig = {
    ...DEFAULT_CONFIG,
    languages,
    ...(needsSubset ? { include: [target.subset as string] } : {}),
  };
  return { root: target.root, config };
}

async function scoreTarget(target: Target, options: Options): Promise<RepoScores> {
  const buildSnapshot = await loadBuildSnapshot();
  const snapshot = await buildSnapshot(buildOptionsFor(target));
  const files = scoredFiles(snapshot, target.lang);

  const { truth, na } = await truthFor(target, files, options);
  const extra = await extraFor(target, snapshot, files);
  const scores = scoreAgainstTruth(target.name, snapshot, truth, target.lang, extra);

  const unparsable = await findUnparsable(target.root, files);
  // The substitute gate is the *only* gate a target with no gated metric has, so it runs
  // exactly then and never otherwise: it costs a second whole-repo build.
  const substitute = everyGatedMetricIsNa(na)
    ? await runSubstituteChecks(target, snapshot, files, unparsable)
    : null;

  return { ...scores, naMetrics: na, unparsable, substitute };
}

/**
 * One target's truth, and the metric ids its oracle says it does not measure.
 *
 * Build 1's two oracles are called by their own names (they predate the registry and are owned
 * by other leaves); every build-2 language goes through `loadTruth`, which finds
 * `bench/src/truth/<lang>.ts` by convention.
 */
async function truthFor(
  target: Target,
  files: string[],
  options: Options,
): Promise<{ truth: Truth; na: string[] }> {
  if (isTsFamily(target.lang)) {
    return { truth: generateTsTruth(target.root, files, { diagnostics: options.diagnostics }), na: [] };
  }
  if (target.lang === "go") {
    return { truth: (await loadGoTruth())(target.root, files), na: [] };
  }
  const module: TruthModule = await loadTruth(truthTargetFor(target.lang));
  const truth = module.generateTruth(target.root, files);
  return { truth, na: unsupportedMetrics([...(module.NOTES ?? []), ...truth.notes]) };
}

/**
 * The reference and node sets S5 and S6 are scored against, or null when nothing measures them.
 *
 * Two questions, in this order, and both of them cheap:
 *
 *  1. Did greplost predict anything at all? A repo with no signal node and no reference has
 *     nothing whose precision could be wrong, and asking a second compiler program about it
 *     would cost a whole extra build for a guaranteed empty answer. `null` is `n/a`, which is
 *     neither a pass nor a fail, the same contract every other unmeasured metric has.
 *  2. Does this target's oracle offer a `generateExtra`? For the TypeScript family that is
 *     `truth/signals-ts.ts` (S1 to S4 stay with `truth/ts.ts`, which is a different oracle for
 *     a different question); every other language asks its own truth module.
 *
 * Consequence worth stating plainly: S6 recall is only reported when greplost predicted at
 * least one node. That is deliberate, spec section 3.7 gates precision and reports recall,
 * but it does mean a pass that silently stopped emitting shows as `n/a` rather than as 0.000.
 * The fixture gate is what stands against that: `tiny-signals-ts` has known nodes.
 */
async function extraFor(
  target: Target,
  snapshot: Snapshot,
  files: string[],
): Promise<ExtraTruth | null> {
  const scored = new Set(files);
  const predictedNodes = snapshot.symbols.some(
    (decl) => scored.has(decl.file) && decl.meta?.["signal"] !== undefined,
  );
  const predictedRefs = (snapshot.references ?? []).some((edge) => scored.has(fileOf(edge.from)));
  if (!predictedNodes && !predictedRefs) return null;

  // The signal oracle is a *different* oracle from the language one, for a different question,
  // so the two languages that have signal passes name theirs here: `truth/signals-ts.ts` for
  // the TypeScript family (S1 to S4 stay with `truth/ts.ts`) and `truth/signals-pulumi-go.ts`
  // for Go (S1 to S4 stay with `truth/go.ts`). Every other language asks its own truth module,
  // which is where the IaC node and reference sets live (leaf 2.7).
  const target_: TruthTarget = isTsFamily(target.lang)
    ? "signals-ts"
    : target.lang === "go"
      ? "signals-pulumi-go"
      : truthTargetFor(target.lang);
  let module: TruthModule;
  try {
    module = await loadTruth(target_);
  } catch {
    // No oracle for this target's signals: unmeasured, which is `n/a`, not a failure.
    return null;
  }
  if (module.generateExtra === undefined) return null;
  return module.generateExtra(target.root, files);
}

/**
 * Metric ids an oracle declares it cannot measure, from its notes.
 *
 * Two spellings, both explicit: `unsupported:S3` for one metric (HCL has no calls), and
 * `reported-only` for a language with no corpus oracle at all (Kotlin, ruling 2026-09-04).
 * Nothing is inferred: a metric is only `n/a` because a truth generator said so.
 */
export function unsupportedMetrics(notes: readonly string[]): string[] {
  const na = new Set<string>();
  for (const note of notes) {
    if (note === "reported-only") for (const id of METRIC_IDS) na.add(id);
    const match = /^unsupported:(S[1-6])$/.exec(note);
    if (match !== null) na.add(match[1] as string);
  }
  return [...na].sort(compareStrings);
}

/** The metrics `--gate` actually enforces. S5 and S6 join once an oracle measures them. */
const GATED_METRICS: readonly string[] = ["S1", "S2", "S3", "S4"];

function everyGatedMetricIsNa(na: readonly string[]): boolean {
  const set = new Set(na);
  return GATED_METRICS.every((id) => set.has(id));
}

/**
 * The three substitute checks (bench spec 5.2), for a target whose every gated metric is
 * `n/a`. Without them `--repo coroutines --gate` would pass on an extractor that returned
 * nothing at all, because every metric would be `n/a` and nothing would be left to fail.
 */
async function runSubstituteChecks(
  target: Target,
  snapshot: Snapshot,
  files: string[],
  unparsable: readonly { path: string }[],
): Promise<SubstituteChecks> {
  const buildSnapshot = await loadBuildSnapshot();
  const again = await buildSnapshot(buildOptionsFor(target));
  const deterministic = snapshotDigest(snapshot) === snapshotDigest(again);

  const scored = new Set(files);
  const errorRate = files.length === 0 ? 1 : unparsable.filter((f) => scored.has(f.path)).length / files.length;

  const silent = snapshot.files
    .filter((file) => scored.has(file.path) && file.loc > 0)
    .filter((file) => file.decls.length === 0 && file.imports.length === 0)
    .map((file) => file.path)
    .sort(compareStrings);

  return {
    deterministic,
    errorRate,
    silentFiles: silent.slice(0, MAX_REPORTED_FALSE_POSITIVES),
    silentCount: silent.length,
  };
}

/**
 * A digest of everything a snapshot claims, for the determinism check.
 *
 * Not `serializeSnapshot`: `@greplost/core` is loaded dynamically here (so `--dry-run` works
 * without it) and the digest only has to change whenever the map would. It covers the four
 * collections a rebuild could reorder or repopulate differently.
 */
function snapshotDigest(snapshot: Snapshot): string {
  const files = snapshot.files
    .map((file) => `${file.path}\u0000${file.sha256}\u0000${file.loc}\u0000${file.decls.length}`)
    .join("\n");
  const symbols = snapshot.symbols.map((decl) => `${decl.id}:${decl.kind}:${decl.span.join("-")}`).join("\n");
  const imports = snapshot.imports.map((edge) => `${edge.from} -> ${edge.to}`).join("\n");
  const references = (snapshot.references ?? []).map((edge) => `${edge.from} -> ${edge.to}`).join("\n");
  return [files, symbols, imports, references].join("\n---\n");
}

/**
 * The unparsable bucket for one repo, or an empty one when core does not offer the
 * reader.
 *
 * A missing export is not a finding about the corpus, so it degrades to "nothing to
 * report" rather than failing the run; the report says `not measured` when no payload
 * carries a count.
 */
async function findUnparsable(root: string, files: string[]): Promise<{ path: string; reason: string }[]> {
  try {
    const specifier = "@greplost/core";
    const mod = (await import(specifier)) as Partial<{
      findUnparsableFiles: (
        root: string,
        files: readonly string[],
      ) => Promise<{ path: string; lang: string; reason: string }[]>;
    }>;
    if (typeof mod.findUnparsableFiles !== "function") return [];
    const found = await mod.findUnparsableFiles(root, files);
    return found.map(({ path: file, reason }) => ({ path: file, reason }));
  } catch (err) {
    console.error(`${SUITE}: could not scan for unparsable files: ${(err as Error).message}`);
    return [];
  }
}

/** The snapshot files the truth generator for `lang` can speak about, sorted. */
export function scoredFiles(snapshot: Snapshot, lang: TruthLang): string[] {
  // ts/tsx/js/jsx are one family: one grammar pair, one oracle, one scored file set. Every
  // other language matches exactly itself.
  const wanted = isTsFamily(lang)
    ? (l: string): boolean => isTsFamily(l)
    : (l: string): boolean => l === lang;
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
export function scoreAgainstTruth(
  name: string,
  snapshot: Snapshot,
  truth: Truth,
  lang: TruthLang,
  extra: ExtraTruth | null = null,
): RepoScores {
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
  const dirSet = DIRECTORY_IMPORT_LANGS.has(lang) ? new Set(files.map(directoryOf)) : new Set<string>();
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

  // S5 and S6 (schema 2). Both sides are cut to the same file universe first, exactly like
  // every other metric: a node in a file the oracle never loaded is not a false positive.
  // `S5` is scored as a key set rather than with `scoreEdges` because a reference edge's
  // identity is `(from, to, refKind)` and `scoreEdges` does not know about `refKind`.
  // S6 counts every declaration of a node kind whose id is a schema node id, on both sides (the
  // kind is authoritative: `pipeline.go#step.Run` is a method on a lowercase type, not a node),
  // so IaC nodes and framework signal nodes are scored the same way (driver ruling 2026-09-04).
  const nodeFiles = extra?.nodeFiles === undefined ? fileSet : new Set(extra.nodeFiles.filter((file) => fileSet.has(file)));
  const predNodes = snapshot.symbols
    .filter((decl) => nodeFiles.has(decl.file) && isNodeDeclaration(decl))
    .map((decl) => decl.id);
  // S5 identity is (from, to, refKind) when the oracle carries kinds; an oracle that scores
  // references by endpoints only (Terraform's) is compared by (from, to) on both sides.
  const truthCarriesKinds = extra !== null && extra.references.every((edge) => typeof (edge as { refKind?: unknown }).refKind === "string");
  const keyOf = (edge: Edge): string => (truthCarriesKinds ? referenceKey(edge) : `${edge.from} -> ${edge.to}`);
  // A reference target counts when it is a scored file, an `ext:` id, or a module directory in
  // the universe; a source must be a scored file (driver ruling 2026-09-04, Terraform review).
  const coveredReferenceTarget = (id: string): boolean => fileSet.has(fileOf(id)) || id.startsWith("ext:") || dirSet.has(id);
  const predReferences = (snapshot.references ?? [])
    .filter((edge) => fileSet.has(fileOf(edge.from)) && coveredReferenceTarget(edge.to))
    .map(keyOf);
  // Both node sets are held to the schema's node-id shape so an oracle cannot publish an id the map cannot carry.
  const truthNodes = extra === null ? [] : extra.nodes.filter((id) => nodeFiles.has(fileOf(id)) && splitNodeId(id) !== null);
  const truthReferences =
    extra === null
      ? []
      : extra.references
          .filter((edge) => fileSet.has(fileOf(edge.from)) && coveredReferenceTarget(edge.to))
          .map(keyOf);
  const S5 = extra === null ? null : scoreSet(predReferences, truthReferences);
  const S6 = extra === null ? null : scoreSet(predNodes, truthNodes);

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
  // A reported-only target (Kotlin's corpus by ruling) offers no compiler truth on purpose; that is
  // not an empty oracle, so the banner and the payload's `truthEmpty` stay quiet for it.
  const reportedOnly = truth.notes.includes("reported-only");
  const truthEmpty =
    !reportedOnly &&
    offered > 0 &&
    (files.length === 0 || (truthImports.length === 0 && exportKeys(truthExports).length === 0));
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
    // S5 and S6 need a reference and a node set from the oracle (`generateExtra`), which no
    // build-1 truth generator has. Unmeasured is `n/a`, and `n/a` is neither a pass nor a fail.
    S5,
    S6,
    naMetrics: [],
    // Filled by `scoreTarget`, the only caller that can afford a second build.
    substitute: null,
    truthEmpty,
    noFiles,
    notes: Array.isArray(truth.notes) ? truth.notes : [],
    // Filled by `scoreTarget`, which is the only caller that has a repo on disk to parse.
    unparsable: [],
    falsePositives: {
      S1: locateAll(snapshot, S1.falsePositives, "import"),
      S2: locateAll(snapshot, S2.falsePositives, "export"),
      S3: locateAll(snapshot, S3.falsePositives, "call"),
      S4: predCycles
        .filter((cycle) => !truth.cycles.some((expected) => sameCycle(expected, cycle)))
        .slice(0, MAX_REPORTED_FALSE_POSITIVES)
        .map((cycle) => `${cycle[0] ?? "?"}:1 (cycle ${cycle.join(" -> ")})`),
      S5: keysWithLocation(snapshot, S5?.falsePositives ?? []),
      S6: keysWithLocation(snapshot, S6?.falsePositives ?? []),
    },
    falseNegatives: {
      S1: locateAll(snapshot, S1.falseNegatives, "import"),
      S2: locateAll(snapshot, S2.falseNegatives, "export"),
      S3: locateAll(snapshot, S3.falseNegatives, "call"),
      S4: truth.cycles
        .filter((cycle) => !predCycles.some((predicted) => sameCycle(predicted, cycle)))
        .slice(0, MAX_REPORTED_FALSE_POSITIVES)
        .map((cycle) => `${cycle[0] ?? "?"}:1 (cycle ${cycle.join(" -> ")})`),
      S5: keysWithLocation(snapshot, S5?.falseNegatives ?? []),
      S6: keysWithLocation(snapshot, S6?.falseNegatives ?? []),
    },
  };
}

/**
 * `<from> -<refKind>-> <to>`: a reference edge's identity, for scoring it as a key set.
 *
 * `refKind` is optional on the type because the registry declares `generateExtra` in terms of
 * `Edge`; every reference edge in practice carries one, and `kind` ("reference") is the honest
 * fallback for one that does not.
 */
function referenceKey(edge: Edge & { refKind?: string }): string {
  return `${edge.from} -${edge.refKind ?? edge.kind}-> ${edge.to}`;
}

/** `file:line (key)` for a node or reference key, so an S5/S6 miss is as actionable as an S1. */
function keysWithLocation(snapshot: Snapshot, keys: readonly string[]): string[] {
  return keys.slice(0, MAX_REPORTED_FALSE_POSITIVES).map((key) => {
    const id = (key.split(" -")[0] ?? key).trim();
    const declaration = snapshot.symbols.find((decl) => decl.id === id);
    return `${fileOf(id)}:${declaration?.span[0] ?? 1} (${key})`;
  });
}

/**
 * The gate ids this repo missed, in id order. Empty means the repo passes Eval 1.
 *
 * `truth-empty` and `no-files` are misses in their own right: without them a run where the
 * oracle, or greplost, or both produced nothing would report four perfect scores and pass
 * the gate.
 */
/**
 * One row per language in the run: which repos it covered, whether the run gated it, and which
 * oracle produced its numbers. `RESULTS.md` is generated from this, so a language that is only
 * *reported* can never be printed as if it had been gated.
 */
export function perLangSummary(
  targets: readonly Target[],
  scores: readonly RepoScores[],
): Record<string, { repos: string[]; gated: boolean; truthSource: string }> {
  const byName = new Map(scores.map((score) => [score.name, score]));
  const out: Record<string, { repos: string[]; gated: boolean; truthSource: string }> = {};

  for (const target of [...targets].sort((a, b) => compareStrings(a.lang, b.lang) || compareStrings(a.name, b.name))) {
    const score = byName.get(target.name);
    const gated = score === undefined ? false : !everyGatedMetricIsNa(score.naMetrics ?? []);
    const row = out[target.lang];
    const source = `bench/src/truth/${truthTargetFor(target.lang)}.ts`;
    if (row === undefined) out[target.lang] = { repos: [target.name], gated, truthSource: source };
    else {
      row.repos.push(target.name);
      // A language is gated only if every one of its targets was.
      row.gated = row.gated && gated;
    }
  }
  for (const row of Object.values(out)) row.repos.sort(compareStrings);
  return out;
}

/** The substitute gate's three lines, printed only for a target that ran it. */
function printSubstitute(scores: readonly RepoScores[]): void {
  for (const score of scores) {
    const substitute = score.substitute;
    if (substitute === null) continue;
    console.log(
      `${SUITE}: ${score.name} has no gated metric (${score.naMetrics.join(",") || "none measured"}); ` +
        "substitute checks:",
    );
    console.log(`  deterministic build      ${substitute.deterministic ? "pass" : "FAIL"}`);
    console.log(
      `  parse error rate         ${substitute.errorRate.toFixed(4)} ` +
        `(< ${MAX_PARSE_ERROR_RATE}: ${substitute.errorRate < MAX_PARSE_ERROR_RATE ? "pass" : "FAIL"})`,
    );
    console.log(
      `  every non-empty file      ${substitute.silentCount === 0 ? "pass" : `FAIL (${substitute.silentCount} silent)`}`,
    );
    for (const file of substitute.silentFiles) console.log(`    ${file}`);
  }
}

/**
 * `{ count, files }` over every repo in the run, with the repo name on each entry.
 *
 * A count and the list behind it, in one place, because a bucket with no list is a
 * number nobody can act on and a list with no count is one nobody reads.
 */
export function unparsableBucket(
  scores: readonly RepoScores[],
): { count: number; files: { repo: string; path: string; reason: string }[] } {
  const files = scores
    .flatMap((score) => score.unparsable.map((entry) => ({ repo: score.name, ...entry })))
    .sort((a, b) => compareStrings(a.repo, b.repo) || compareStrings(a.path, b.path));
  return { count: files.length, files };
}

/**
 * True when the run scored a fixture rather than a pinned corpus repo.
 *
 * Both `--fixture` (tiny-ts) and `--fixture-go` (tiny-go) are fixtures: a dozen files
 * either way, and neither may ever become `latestResult("structural")`.
 */
function isFixtureRun(options: Options): boolean {
  return options.fixture || options.fixtureGo;
}

export function missedMetrics(scores: RepoScores): string[] {
  const missed: string[] = [];
  const na = new Set(scores.naMetrics ?? []);
  const [p1 = 1, r1 = 1] = TARGETS.S1;
  const [p2 = 1, r2 = 1] = TARGETS.S2;

  // A target whose every gated metric is `n/a` has no accuracy gate left, so the three
  // substitute checks are its gate. Reporting `truth-empty` for it would be nonsense: there
  // is no oracle to be empty.
  if (everyGatedMetricIsNa([...na])) {
    const substitute = scores.substitute;
    if (substitute === null) missed.push("substitute-not-run");
    else {
      if (!substitute.deterministic) missed.push("nondeterministic");
      if (substitute.errorRate >= MAX_PARSE_ERROR_RATE) missed.push("parse-errors");
      if (substitute.silentCount > 0) missed.push("silent-files");
    }
    if (scores.noFiles) missed.push("no-files");
    return missed.sort(compareStrings);
  }

  if (!na.has("S1") && (scores.S1.precision < p1 - EPSILON || scores.S1.recall < r1 - EPSILON)) missed.push("S1");
  if (!na.has("S2") && (scores.S2.precision < p2 - EPSILON || scores.S2.recall < r2 - EPSILON)) missed.push("S2");
  if (!na.has("S3") && scores.S3.precision < TARGETS.S3 - EPSILON) missed.push("S3");
  if (!na.has("S4") && scores.S4 < TARGETS.S4 - EPSILON) missed.push("S4");
  // S5 and S6 are gated only once an oracle actually produced them; `null` is `n/a`.
  if (!na.has("S5") && scores.S5 !== null && scores.S5.precision < TARGETS.S5 - EPSILON) missed.push("S5");
  if (!na.has("S6") && scores.S6 !== null && scores.S6.precision < TARGETS.S6 - EPSILON) missed.push("S6");
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
    S5: scores.S5 === null ? null : brief(scores.S5),
    S6: scores.S6 === null ? null : brief(scores.S6),
    naMetrics: scores.naMetrics ?? [],
    substitute: scores.substitute,
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
/** A metric this target's oracle does not measure. Never a pass, never a fail. */
const NOT_APPLICABLE = "n/a";

/** The S1 to S6 table. `scores` is null for --dry-run, which prints the shape only. */
function printTable(name: string, scores: RepoScores | null): void {
  console.log(scores === null ? `${SUITE}: ${name}` : `${SUITE}: ${name} (${scores.files} files)`);

  const na = new Set(scores?.naMetrics ?? []);
  /** The measured cell for one metric: the shape in a dry run, `n/a` when unmeasured. */
  const cell = (id: string, measured: () => string): string => {
    if (scores === null) return NOT_RUN;
    return na.has(id) ? NOT_APPLICABLE : measured();
  };

  const rows: [string, string, string, string][] = [
    [
      "S1",
      "import edge precision / recall",
      ">=0.99 / >=0.97",
      scores === null
        ? `${NOT_RUN} / ${NOT_RUN}`
        : cell("S1", () => `${num(scores.S1.precision)} / ${num(scores.S1.recall)}`),
    ],
    [
      "S2",
      "export precision / recall",
      ">=0.99 / >=0.99",
      scores === null
        ? `${NOT_RUN} / ${NOT_RUN}`
        : cell("S2", () => `${num(scores.S2.precision)} / ${num(scores.S2.recall)}`),
    ],
    ["S3", "call edge precision (confidence=high)", ">=0.95", cell("S3", () => num((scores as RepoScores).S3.precision))],
    ["S4", "import cycle Jaccard", "=1.00", cell("S4", () => num((scores as RepoScores).S4))],
    [
      "S5",
      "reference edge precision",
      ">=0.95",
      cell("S5", () => {
        const S5 = (scores as RepoScores).S5;
        return S5 === null ? NOT_APPLICABLE : num(S5.precision);
      }),
    ],
    [
      "S6",
      "signal node precision",
      ">=0.95",
      cell("S6", () => {
        const S6 = (scores as RepoScores).S6;
        return S6 === null ? NOT_APPLICABLE : num(S6.precision);
      }),
    ],
  ];
  const notes =
    scores === null
      ? ["", "", "", "", "", ""]
      : [
          counts(scores.S1),
          counts(scores.S2),
          `recall ${num(scores.S3.recall)}, ${counts(scores.S3)}`,
          `all confidences: precision ${num(scores.callsAll.precision)}, recall ${num(scores.callsAll.recall)}`,
          scores.S5 === null ? "not measured by this oracle" : counts(scores.S5),
          scores.S6 === null ? "not measured by this oracle" : counts(scores.S6),
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
