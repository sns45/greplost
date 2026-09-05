/**
 * `bench report`: read the newest result of every suite and write `bench/RESULTS.md`
 * plus the `docs/assets/*.png` charts (tech spec 10.9, 11; bench leaf 1.5.7).
 *
 * The one rule this file exists to enforce: **the measured column is filled from a
 * result payload or it says `not run`.** There is no path through this module that
 * puts a number in `RESULTS.md` that some suite did not write to disk first, and no
 * path that turns a missing measurement into a zero.
 *
 * Reading neighbours' payloads is deliberately forgiving. `replay`, `perf` and
 * `agent` were written in parallel with this file, so every value is looked up
 * through a list of candidate paths and then, as a last resort, by key name
 * anywhere in the payload. A payload whose shape does not match at all degrades to
 * `not run` for that section and never throws: a report that crashes because one
 * suite renamed a field is worse than a report that says which section it could
 * not read. Whatever assumption a value came from is recorded in the section's
 * notes, so a wrong reading is visible rather than silent.
 *
 *   bun bench/src/cli.ts report                 # RESULTS.md + docs/assets/*.png
 *   bun bench/src/cli.ts report --dry-run       # RESULTS.md only, no rasterisation
 *   bun bench/src/cli.ts report --results-dir <d> --out <f> --assets <d>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { compareStrings, stableStringify } from "@greplost/core/schema";

import { boxChart, groupedBarChart, lineChart, mermaidXy, writeChart, type BoxDatum, type ChartSpec } from "./charts.ts";
import { latestResult, orderedResults, resultsDir } from "./results-io.ts";
import {
  assumptions,
  buildOf,
  langRows,
  machineWithSource,
  mergeCorpus,
  resetAssumptions,
  versionRows,
  type Payload,
} from "./report-payload.ts";
import { headToHeadFrom, singleTool } from "./report-sections.ts";
import {
  bench3Section,
  eval1Section,
  eval2Section,
  eval4Section,
  eval5Section,
  mapqualitySection,
} from "./report-evals.ts";
import {
  METRIC_TITLES,
  NOT_APPLICABLE,
  SECTION_HEADERS,
  X_IDS,
  emptySection,
  renderResultsMd,
  type ChartRef,
  type EvalRow,
  type EvalSection,
  type MetricCell,
  type MetricRow,
  type ReportModel,
  type SummaryRow,
  type XId,
} from "./results-md.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const SUITE = "report";
/** The path the convention line names, and the default `--out`. */
const RESULTS_MD = "bench/RESULTS.md";
/** Where the PNGs land, repo-relative (tech spec 10.9). */
const ASSETS_DIR = "docs/assets";

/** The committed payload set this document was built from (ruling 2026-09-05). */
export const PAYLOAD_INDEX = "INDEX.json";

export interface BuildOptions {
  /** Where to read `*.json` results from; defaults to `bench/results`. */
  resultsDir?: string;
  /** Repo-relative directory the PNG links point at; defaults to `docs/assets`. */
  assetsRel?: string;
  /** Ignore `INDEX.json` and read the newest payload of each suite instead. */
  latest?: boolean;
  /** Write `INDEX.json` from the payload set this pass actually read. */
  writeIndex?: boolean;
}

interface Options {
  dryRun: boolean;
  resultsDir: string | undefined;
  out: string;
  assets: string;
  /** True when `--out` was not given, so the convention line is the whole truth. */
  defaultOut: boolean;
  /** `--latest`: re-pin the index to the newest payloads on disk. */
  latest: boolean;
}
// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export async function run(args: string[]): Promise<number> {
  const options = parseArgs(args);
  try {
    const model = buildModel({
      ...(options.resultsDir === undefined ? {} : { resultsDir: options.resultsDir }),
      assetsRel: path.relative(REPO_ROOT, options.assets).split(path.sep).join("/") || ASSETS_DIR,
      ...(options.latest ? { latest: true } : {}),
      // A real run records what it read, so the document and its payload set are
      // committed together and the next run reproduces this document exactly.
      writeIndex: true,
    });
    const text = renderResultsMd(model);

    mkdirSync(path.dirname(options.out), { recursive: true });
    writeFileSync(options.out, text);

    if (!options.dryRun) {
      const written = rasterise(model, options.assets);
      console.log(`${SUITE}: rendered ${written} chart${written === 1 ? "" : "s"} into ${path.relative(REPO_ROOT, options.assets) || ASSETS_DIR}`);
    }
    if (!options.defaultOut) console.log(`${SUITE}: output redirected to ${options.out}`);
    // The gate and `bench all` match this exact string, always last on stdout.
    console.log(`${SUITE}: wrote ${RESULTS_MD}`);
    return 0;
  } catch (err) {
    console.error(`${SUITE}: ${(err as Error).message}`);
    return 1;
  }
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    dryRun: false,
    resultsDir: undefined,
    out: path.join(REPO_ROOT, RESULTS_MD),
    assets: path.join(REPO_ROOT, ASSETS_DIR),
    defaultOut: true,
    latest: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Unknown flags are ignored: `bench all` forwards one argument list to every suite.
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--latest") options.latest = true;
    else if (arg === "--results-dir") options.resultsDir = args[++i];
    else if (arg === "--out") {
      const next = args[++i];
      if (next !== undefined) {
        options.out = path.resolve(next);
        options.defaultOut = false;
      }
    } else if (arg === "--assets") {
      const next = args[++i];
      if (next !== undefined) options.assets = path.resolve(next);
    }
  }
  return options;
}

/** Write every planned chart that carries an SVG; returns how many landed. */
function rasterise(model: ReportModel, assetsDir: string): number {
  let count = 0;
  for (const chart of allCharts(model)) {
    if (chart.svg === undefined || chart.png === null) continue;
    writeChart(assetsDir, path.basename(chart.png, ".png"), chart.svg);
    count++;
  }
  return count;
}

function allCharts(model: ReportModel): ChartRef[] {
  return [...model.headToHead.charts, ...Object.values(model.sections).flatMap((s) => s.charts)];
}
// ---------------------------------------------------------------------------
// the model
// ---------------------------------------------------------------------------

export function buildModel(options: BuildOptions = {}): ReportModel {
  const dir = options.resultsDir;
  const assetsRel = options.assetsRel ?? ASSETS_DIR;
  resetAssumptions();
  /**
   * Every result of one suite, oldest first.
   *
   * `latestResult` answers "the newest one", which is the right question for a
   * suite that measures the same thing every time. The head-to-head suite does
   * not: a run selects metrics, and two runs at the same commit measure
   * different halves of the table.
   *
   * The order is `orderedResults`': the payload's own `recordedAt`, then the file
   * name, with unstamped payloads first. Both keys are content the repository
   * carries, so two clones of the same tree regenerate the same `RESULTS.md`; an
   * earlier attempt broke ties on `mtime`, which is a checkout-time fact and made
   * the document differ between clones (review round 2, important b), and a later
   * one broke them on the short sha, which does not sort by time at all.
   */
  /**
   * The payload set this document is pinned to, or null when there is none and
   * when `--latest` asked for the newest on disk instead (ruling 2026-09-05).
   *
   * Newest-on-disk is the wrong default for a committed document. Any gate run
   * writes a payload, and a `--repo one-thing --gate` run writes one that covers
   * a single corpus: the next `bench:report` would then rebuild `RESULTS.md`
   * from it and silently drop nine languages, with every remaining number still
   * true and the document as a whole a lie. Pinning the set makes that a
   * deliberate act (`--latest`) rather than an accident.
   */
  const index = options.latest === true ? null : readPayloadIndex(dir);
  /** Suite to the payload file names this pass actually read, for the index. */
  const used = new Map<string, string[]>();

  const record = (suite: string, payloads: readonly Payload[]): void => {
    if (payloads.length > 0) used.set(suite, payloads.map((payload) => path.basename(payload.file)));
  };

  /** The payloads the index pins for a suite, or null when it pins none it can read. */
  const pinned = (suite: string): Payload[] | null => {
    const listed = index?.payloads[suite];
    if (listed === undefined || listed.length === 0) return null;
    const found: Payload[] = [];
    const missing: string[] = [];
    for (const name of listed) {
      const file = path.join(resultsDir(dir), name);
      try {
        found.push({ data: JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>, file });
      } catch {
        missing.push(name);
      }
    }
    if (missing.length === 0) return found;
    // A pinned file that is not there is a disclosed fallback, never a silent
    // one: the document says which file it wanted and what it read instead.
    assumptions.push(
      `\`bench/results/${PAYLOAD_INDEX}\` pins ${missing.map((name) => `\`${name}\``).join(", ")} for the ` +
        `${suite} suite and ${missing.length === 1 ? "it is" : "they are"} not in the results directory; ` +
        "the newest payload on disk was read instead",
    );
    return found.length > 0 ? found : null;
  };

  const loadAll = (suite: string, from: string | undefined): Payload[] => {
    const set = pinned(suite);
    if (set !== null) {
      record(suite, set);
      return set;
    }
    try {
      const found = orderedResults(suite, from).map((entry) => ({ data: entry.payload, file: entry.file }));
      record(suite, found);
      return found;
    } catch {
      return [];
    }
  };

  const load = (suite: string): Payload | null => {
    const set = pinned(suite);
    if (set !== null) {
      record(suite, set);
      return set[set.length - 1] ?? null;
    }
    try {
      const found = latestResult(suite, dir);
      if (found === undefined) return null;
      const payload = { data: found.payload, file: found.file };
      record(suite, [payload]);
      return payload;
    } catch {
      // A corrupt result file must not take the whole report down with it.
      return null;
    }
  };

  const structural = load("structural");
  const replay = load("replay");
  const perf = load("perf");
  const agent = load("agent");
  const mapquality = load("mapquality");
  const headtohead = load("headtohead");
  // Every head-to-head payload, oldest first: one run rarely fills the whole
  // table (`--metrics` splits the corpus metrics from the commit walk), so the
  // section takes each id from the newest run that measured it and keeps that
  // run's corpus on the row.
  const headtoheads = loadAll("headtohead", dir);
  const human = load("human");

  const machineSource = machineWithSource([headtohead, structural, perf, mapquality, replay, agent]);
  const structuralBuild = buildOf(structural);
  const model: ReportModel = {
    machine: machineSource?.machine ?? null,
    machineSource:
      machineSource === null
        ? null
        : {
            suite: machineSource.suite,
            structural: machineSource.suite === "structural" ? null : structuralBuild,
          },
    corpus: mergeCorpus([headtohead, structural, replay, perf, agent, mapquality]),
    versions: versionRows(agent, headtohead, structural),
    headToHead: headToHeadFrom(headtoheads, replay, assetsRel),
    singleTool: { rows: [], notes: [] },
    // Build 2's per-language view of the same structural payload. A build-1
    // payload has no `perLang` block and yields no rows, which the section says.
    langs: langRows(structural),
    sections: {
      eval1: eval1Section(structural, assetsRel),
      eval2: eval2Section(replay),
      bench3: bench3Section(perf, assetsRel),
      eval4: eval4Section(agent, assetsRel),
      eval5: eval5Section(human),
      mapquality: mapqualitySection(mapquality),
    },
    preamble: [],
  };

  model.singleTool = singleTool(model.sections, structural, replay, perf, agent, mapquality);

  const missing = [
    structural === null ? "structural" : null,
    replay === null ? "replay" : null,
    perf === null ? "perf" : null,
    agent === null ? "agent" : null,
    mapquality === null ? "mapquality" : null,
    headtohead === null ? "headtohead" : null,
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    model.preamble.push(
      `Suites with no result file in \`bench/results/\`, rendered as \`not run\`: ${missing.join(", ")}.`,
    );
  }
  const guesses = [...new Set(assumptions)].sort();
  if (guesses.length > 0) {
    model.preamble.push(
      `Shape assumptions this report had to make, because a suite's payload did not carry a field where ` +
        `this reader expected it: ${guesses.join("; ")}. Every other value came from a documented path.`,
    );
  }

  if (options.writeIndex === true) writePayloadIndex(dir, used, structural);
  return model;
}

// ---------------------------------------------------------------------------
// the payload index
// ---------------------------------------------------------------------------

/** `bench/results/INDEX.json`: the payload set `RESULTS.md` was generated from. */
export interface PayloadIndexFile {
  note: string;
  /** Suite to the payload file names it was read from, oldest first. */
  payloads: Record<string, string[]>;
  /** Corpus repo to the structural payload file its numbers came from. */
  corpora: Record<string, string>;
}

/** The committed index, or null when there is none or it cannot be read. */
export function readPayloadIndex(dir?: string): PayloadIndexFile | null {
  const file = path.join(resultsDir(dir), PAYLOAD_INDEX);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PayloadIndexFile>;
    const payloads = parsed.payloads;
    if (typeof payloads !== "object" || payloads === null) return null;
    const cleaned: Record<string, string[]> = {};
    for (const [suite, listed] of Object.entries(payloads)) {
      if (!Array.isArray(listed)) continue;
      cleaned[suite] = listed.filter((name): name is string => typeof name === "string");
    }
    return { note: parsed.note ?? "", payloads: cleaned, corpora: parsed.corpora ?? {} };
  } catch {
    // An unreadable index is one the report ignores, never one it dies on.
    return null;
  }
}

/**
 * Record the payload set this pass read, so the document and the files behind it
 * are committed together.
 *
 * `corpora` is the per-corpus half of the ruling: which structural payload
 * supplied each repo's numbers. With one full run it is one file repeated, and
 * with a run per corpus it is the map that says so.
 */
function writePayloadIndex(
  dir: string | undefined,
  used: ReadonlyMap<string, string[]>,
  structural: Payload | null,
): void {
  const payloads: Record<string, string[]> = {};
  for (const suite of [...used.keys()].sort(compareStrings)) payloads[suite] = used.get(suite) ?? [];

  const corpora: Record<string, string> = {};
  if (structural !== null) {
    const name = path.basename(structural.file);
    const repos = structural.data["repos"];
    if (typeof repos === "object" && repos !== null) {
      for (const repo of Object.keys(repos).sort(compareStrings)) corpora[repo] = name;
    }
  }

  const index: PayloadIndexFile = {
    note:
      "The payload set bench/RESULTS.md was generated from. `bun run bench:report` reads these files by " +
      "default, so a payload written later by a gate run cannot silently replace them; " +
      "`bun run bench:report --latest` re-pins this file to the newest payload of each suite on disk. " +
      "`corpora` names the structural payload each corpus repo's numbers came from.",
    payloads,
    corpora,
  };
  try {
    const target = resultsDir(dir);
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, PAYLOAD_INDEX), `${stableStringify(index, 2)}\n`);
  } catch {
    // The document is the product; failing to record the set it came from is
    // worth a missing file, never a failed report.
  }
}
