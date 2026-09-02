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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { compareStrings } from "@greplost/core/schema";

import { boxChart, groupedBarChart, lineChart, mermaidXy, writeChart, type BoxDatum, type ChartSpec } from "./charts.ts";
import { latestResult, resultsDir } from "./results-io.ts";
import { assumptions, firstMachine, mergeCorpus, resetAssumptions, versionRows, type Payload } from "./report-payload.ts";
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

export interface BuildOptions {
  /** Where to read `*.json` results from; defaults to `bench/results`. */
  resultsDir?: string;
  /** Repo-relative directory the PNG links point at; defaults to `docs/assets`. */
  assetsRel?: string;
}

interface Options {
  dryRun: boolean;
  resultsDir: string | undefined;
  out: string;
  assets: string;
  /** True when `--out` was not given, so the convention line is the whole truth. */
  defaultOut: boolean;
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
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Unknown flags are ignored: `bench all` forwards one argument list to every suite.
    if (arg === "--dry-run") options.dryRun = true;
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
   * Every result of one suite, oldest first by file name.
   *
   * `latestResult` answers "the newest one", which is the right question for a
   * suite that measures the same thing every time. The head-to-head suite does
   * not: a run selects metrics, and two runs at the same commit measure
   * different halves of the table.
   */
  const loadAll = (suite: string, from: string | undefined): Payload[] => {
    const found: Payload[] = [];
    try {
      const target = resultsDir(from);
      if (!existsSync(target)) return found;
      const pattern = new RegExp(`^${suite}-\\d{4}-\\d{2}-\\d{2}-[^/]*\\.json$`);
      const names = readdirSync(target).filter((entry) => pattern.test(entry));
      // Oldest first, by the payload's own date, then its commit sha, then the
      // file name. Every key is content the repository carries, so two clones of
      // the same tree regenerate the same `RESULTS.md`; an earlier attempt broke
      // the date tie on `mtime`, which is a checkout-time fact and made the
      // document differ between clones (review round 2, important b).
      const keyed = names.flatMap((name) => {
        const file = path.join(target, name);
        try {
          const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
          return [{
            file,
            name,
            date: typeof parsed["date"] === "string" ? parsed["date"] : "",
            sha: typeof parsed["greplostSha"] === "string" ? parsed["greplostSha"] : "",
            payload: parsed,
          }];
        } catch {
          // One corrupt result must not take the report down with it.
          return [];
        }
      });
      keyed.sort(
        (a, b) => compareStrings(a.date, b.date) || compareStrings(a.sha, b.sha) || compareStrings(a.name, b.name),
      );
      for (const entry of keyed) found.push({ data: entry.payload, file: entry.file });
    } catch {
      return found;
    }
    return found;
  };

  const load = (suite: string): Payload | null => {
    try {
      const found = latestResult(suite, dir);
      return found === undefined ? null : { data: found.payload, file: found.file };
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

  const model: ReportModel = {
    machine: firstMachine([headtohead, structural, perf, mapquality, replay, agent]),
    corpus: mergeCorpus([headtohead, structural, replay, perf, agent, mapquality]),
    versions: versionRows(agent, headtohead),
    headToHead: headToHeadFrom(headtoheads, replay, assetsRel),
    singleTool: { rows: [], notes: [] },
    sections: {
      eval1: eval1Section(structural),
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
  return model;
}
