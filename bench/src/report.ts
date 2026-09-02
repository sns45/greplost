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

import { boxChart, groupedBarChart, lineChart, mermaidXy, writeChart, type BoxDatum, type ChartSpec } from "./charts.ts";
import { latestResult } from "./results-io.ts";
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
  assumptions = [];
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
  const human = load("human");

  const model: ReportModel = {
    machine: firstMachine([headtohead, structural, perf, mapquality, replay, agent]),
    corpus: mergeCorpus([headtohead, structural, replay, perf, agent, mapquality]),
    versions: versionRows(agent, headtohead),
    headToHead: headToHead(headtohead, replay, assetsRel),
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

interface Payload {
  data: Record<string, unknown>;
  file: string;
}

/**
 * The `## Single-tool` rows, lifted out of the per-suite sections that were just
 * built rather than re-derived from the payloads. Building them twice is how a
 * summary table and the table it summarises come to disagree.
 */
function singleTool(
  sections: ReportModel["sections"],
  structural: Payload | null,
  replay: Payload | null,
  perf: Payload | null,
  agent: Payload | null,
  mapquality: Payload | null,
): ReportModel["singleTool"] {
  const rows: SummaryRow[] = [];
  const take = (section: EvalSection, ids: readonly string[], source: string): void => {
    for (const id of ids) {
      // The first group carries the gated rows; later groups are per-scenario
      // or per-condition detail, which the summary deliberately leaves behind.
      let found: EvalRow | undefined;
      let where = source;
      for (const group of section.groups) {
        const candidate = group.rows.find((row) => row.id === id);
        if (candidate === undefined) continue;
        found = candidate;
        if (group.name !== null) where = `${source} (${group.name})`;
        break;
      }
      rows.push(
        found === undefined
          ? { id, metric: METRIC_NAMES[id] ?? id, target: TARGETS[id] ?? "-", measured: null, source }
          : { id, metric: found.metric, target: found.target, measured: found.measured, source: where },
      );
    }
  };

  take(sections.eval1, ["S1", "S2", "S3", "S4"], "Eval 1, `structural`");
  rows.push(unparsableRow(structural));
  take(sections.eval2, ["F1", "F2"], "Eval 2, `replay`");
  take(sections.bench3, ["P1", "P2", "P3"], "Bench 3, `perf`");
  take(sections.mapquality, ["M1", "M2"], "Map quality, `mapquality`");
  take(sections.eval4, ["A1", "A2", "A3", "A4"], "Eval 4, `agent`");

  const notes: string[] = [
    "F2 compares the structure artifacts that `listStructurePaths` enumerates — `INDEX.md`, `manifest.json`, " +
      "`graph/*.jsonl`, `repo/*.md`, `packages/*/{MAP,API}.md` and `packages/*/modules/**` — and not the whole " +
      "`.greplost/` directory: `config.json`, `cache/` and the runtime files (`.dirty`, `.lock`, `.state.json`) " +
      "are excluded, because they are not the map and are not committed (ruling 2026-09-02).",
    "`unparsable` counts files whose tree-sitter parse returns an ERROR root node, which the extractor cannot " +
      "read at all (`src/types.ts` in hono today). They are not scored in S1 or S2, so they cost recall " +
      "silently unless they are counted here. Upstream: " +
      "https://github.com/tree-sitter/tree-sitter-typescript/issues/335.",
  ];
  if (replay === null || perf === null || agent === null || mapquality === null) {
    notes.push(
      "Rows reading `not run` have no result file behind them, not a value of zero; the section below each " +
        "metric names the command that would produce one.",
    );
  }
  return { rows, notes };
}

/**
 * The unparsable-files row. Its count comes out of the structural payload if
 * that payload carries one, under any of the names the extractor might use, and
 * is `n/a` otherwise — never a number written here, which would be exactly the
 * hand-filled cell tech spec 10.10 forbids.
 */
function unparsableRow(structural: Payload | null): SummaryRow {
  const count = structural === null ? null : firstNum(structural.data, [
    "unparsable",
    "unparsableFiles",
    "parseErrors",
    "errorFiles",
    "truth.unparsable",
  ]);
  return {
    id: "unparsable",
    metric: "files whose tree-sitter parse root is ERROR (excluded from S1 and S2)",
    target: "0",
    // `n/a` rather than `not run`: the files exist and were skipped, which is a
    // different claim from "this metric was never measured". The count itself is
    // only ever read out of the payload (ruling 2026-09-02).
    measured: count === null ? NOT_APPLICABLE : String(Math.round(count)),
    source: count === null
      ? "not reported by the structural payload; the extractor's error recovery is in progress"
      : "Eval 1, `structural`",
  };
}

/** Names and targets for a summary row whose section did not run (tech spec 3). */
const METRIC_NAMES: Record<string, string> = {
  S1: "import edge precision / recall vs tsc",
  S2: "export precision / recall vs tsc",
  S3: "call edge precision at confidence=high",
  S4: "import cycle detection vs truth",
  F1: "`verify` catch rate on stale maps",
  F2: "`verify` false-positive rate after `update`",
  P1: "full build, 1k / 10k files",
  P2: "incremental update p95, 1k / 10k files",
  P3: "peak RSS at 10k files",
  M1: "INDEX.md token budget",
  M2: "diagrams exceeding the node cap after auto-split",
  A1: "agent tokens per task vs baseline (median)",
  A2: "agent tool calls per task vs baseline",
  A3: "agent answer accuracy vs baseline",
  A4: "agent wall-clock per task vs baseline",
};

const TARGETS: Record<string, string> = {
  S1: ">= 0.99 / >= 0.97",
  S2: ">= 0.99 / >= 0.99",
  S3: ">= 0.95",
  S4: "exact set match",
  F1: "100%",
  F2: "0% (byte-identical)",
  P1: "<= 1s / <= 10s",
  P2: "<= 500ms / <= 1s",
  P3: "<= 500MB",
  M1: "<= 3,000 tokens",
  M2: "0",
  A1: "<= 50%",
  A2: "<= 40%",
  A3: "non-inferior; +10pt on blast radius",
  A4: "<= 60%",
};

/** `<date> at <sha>` for a payload, or null when it carries neither. */
function provenanceOf(payload: Payload | null): string | null {
  if (payload === null) return null;
  const date = str(payload.data["date"]);
  const sha = str(payload.data["greplostSha"]);
  if (date === null && sha === null) return null;
  return `${date ?? "an unknown date"} at ${sha ?? "an unknown commit"}`;
}

function firstMachine(payloads: readonly (Payload | null)[]): Record<string, unknown> | null {
  for (const payload of payloads) {
    if (payload === null) continue;
    const machine = rec(payload.data["machine"]);
    if (machine !== null && Object.keys(machine).length > 0) return machine;
  }
  return null;
}

function mergeCorpus(payloads: readonly (Payload | null)[]): ReportModel["corpus"] {
  const seen = new Map<string, ReportModel["corpus"][number]>();
  for (const payload of payloads) {
    if (payload === null) continue;
    for (const entry of arr(payload.data["corpus"])) {
      const record = rec(entry);
      const name = record === null ? null : str(record["name"]);
      if (name === null || seen.has(name)) continue;
      seen.set(name, {
        name,
        ...(str(record?.["sha"]) === null ? {} : { sha: str(record?.["sha"]) as string }),
        ...(str(record?.["tier"]) === null ? {} : { tier: str(record?.["tier"]) as string }),
        ...(str(record?.["lang"]) === null ? {} : { lang: str(record?.["lang"]) as string }),
      });
    }
  }
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Versions: the machine profile's toolchain, the pinned competitor versions from
 * `bench/competitors.json`, and the Claude CLI and model the agent suite recorded
 * (tech spec 10.1, "pinned everything").
 */
function versionRows(agent: Payload | null, headtohead: Payload | null): { name: string; value: string }[] {
  const rows: { name: string; value: string }[] = [];
  const machine = firstMachine([headtohead, agent]);
  for (const key of ["greplostVersion", "greplostSha", "bun", "node", "go"]) {
    const value = machine === null ? null : machine[key];
    if (typeof value === "string" && value.length > 0) rows.push({ name: key, value });
  }
  const claudeVersion = agent === null ? null : firstStr(agent.data, ["claudeVersion", "cli.version", "versions.claude"]);
  if (claudeVersion !== null) rows.push({ name: "claude CLI", value: claudeVersion });
  const model = agent === null ? null : firstStr(agent.data, ["model", "cli.model", "versions.model"]);
  if (model !== null) rows.push({ name: "claude model", value: model });

  for (const tool of competitors()) {
    rows.push({ name: `${tool.name} (pinned)`, value: `${tool.version} @ ${tool.commit.slice(0, 7)}` });
  }
  return rows;
}

interface CompetitorEntry {
  name: string;
  version: string;
  commit: string;
  syncMechanism: string | null;
}

/** `bench/competitors.json`, or an empty list when it is missing or unreadable. */
export function competitors(): CompetitorEntry[] {
  try {
    const file = path.join(REPO_ROOT, "bench", "competitors.json");
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { tools?: unknown };
    return arr(parsed.tools).flatMap((entry) => {
      const record = rec(entry);
      const name = record === null ? null : str(record["name"]);
      if (name === null) return [];
      return [{
        name,
        version: str(record?.["version"]) ?? "unknown",
        commit: str(record?.["commit"]) ?? "unknown",
        syncMechanism: str(record?.["syncMechanism"]),
      }];
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// head-to-head
// ---------------------------------------------------------------------------

function headToHead(payload: Payload | null, replay: Payload | null, assetsRel: string): ReportModel["headToHead"] {
  const tools = payload === null
    ? ["greplost", "graphify", "ua", "crg"]
    : (arr(payload.data["tools"]).filter((t): t is string => typeof t === "string"));
  const toolList = tools.length > 0 ? tools : ["greplost", "graphify", "ua", "crg"];

  const rows: MetricRow[] = [];
  const metrics = payload === null ? null : rec(payload.data["metrics"]);
  if (metrics !== null) {
    for (const id of X_IDS) {
      const entry = rec(metrics[id]);
      if (entry === null) continue;
      const cells: Record<string, MetricCell> = {};
      const toolCells = rec(entry["tools"]) ?? {};
      for (const tool of toolList) {
        const cellRecord = rec(toolCells[tool]);
        if (cellRecord === null) continue;
        cells[tool] = {
          value: (typeof cellRecord["value"] === "number" || typeof cellRecord["value"] === "string")
            ? (cellRecord["value"] as number | string)
            : null,
          target: str(cellRecord["target"]) ?? METRIC_TITLES[id].target,
          verdict: asVerdict(cellRecord["verdict"]),
          reason: str(cellRecord["reason"]) ?? "",
          ...(rec(cellRecord["detail"]) === null ? {} : { detail: numbersOf(rec(cellRecord["detail"]) as Record<string, unknown>) }),
        };
      }
      rows.push({
        id,
        title: str(entry["title"]) ?? METRIC_TITLES[id].title,
        target: str(entry["target"]) ?? METRIC_TITLES[id].target,
        tools: cells,
      });
    }
  }

  const notes: string[] = [];
  // How each number was produced, as the suite recorded it while producing them.
  // Without this the table is a scoreboard with no method, and a head-to-head
  // with no method is marketing (tech spec 10.1).
  for (const line of arr(payload?.data["method"]).filter((n): n is string => typeof n === "string")) {
    notes.push(line);
  }
  for (const tool of competitors()) {
    if (tool.syncMechanism !== null) {
      notes.push(`${tool.name} sync mechanism (X2, from bench/competitors.json): ${firstSentence(tool.syncMechanism)}`);
    }
  }
  notes.push(
    "Mechanical staleness check (tech spec 10.0 X2): greplost has `verify` (byte comparison against a " +
      "rebuild, exit 1 on drift). None of the three competitors ships an equivalent: their artifacts are " +
      "refreshed, never checked.",
  );

  return {
    tools: toolList,
    rows,
    ran: payload !== null,
    provenance: provenanceOf(payload),
    charts: headToHeadCharts(rows, replay, assetsRel),
    notes,
  };
}

function asVerdict(value: unknown): MetricCell["verdict"] {
  return value === "win" || value === "loss" || value === "tie" ? value : "na";
}

function numbersOf(record: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(record).sort()) {
    const value = num(record[key]);
    if (value !== null) out[key] = value;
  }
  return out;
}

/** The first sentence of a long prose field, so a table note stays one line. */
function firstSentence(text: string): string {
  const stop = text.indexOf(". ");
  return stop === -1 ? text : `${text.slice(0, stop)}.`;
}

// ---------------------------------------------------------------------------
// head-to-head charts (X1 precision, X2 staleness hero, X3 cost)
// ---------------------------------------------------------------------------

function headToHeadCharts(rows: readonly MetricRow[], replay: Payload | null, assetsRel: string): ChartRef[] {
  const charts: ChartRef[] = [];
  const byId = new Map(rows.map((row) => [row.id, row]));

  // Hero (tech spec 10.9, capture #9): F1 vs commit index, one line per tool.
  charts.push(...stalenessCharts(byId.get("X2"), replay, assetsRel));

  const x1 = byId.get("X1");
  if (x1 !== undefined) {
    const tools = Object.keys(x1.tools);
    const spec: ChartSpec = {
      title: "X1 structural precision vs compiler truth",
      yLabel: "precision",
      yMax: 1,
      categories: tools,
      series: [
        { name: "imports", values: tools.map((t) => x1.tools[t]?.detail?.["importPrecision"] ?? null) },
        { name: "calls", values: tools.map((t) => x1.tools[t]?.detail?.["callPrecision"] ?? null) },
      ],
      note: "A dashed stub is a tool that could not be run; see the reason column.",
    };
    if (spec.series.some((s) => s.values.some((v) => v !== null))) {
      charts.push(chartRef("X1 precision per tool per edge kind", spec, "x1-precision", assetsRel, groupedBarChart(spec), "bar"));
    }
  }

  const x3 = byId.get("X3");
  if (x3 !== undefined) {
    const tools = Object.keys(x3.tools);
    const spec: ChartSpec = {
      title: "X3 cost to stay fresh",
      yLabel: "USD per 500 commits",
      categories: tools,
      series: [{ name: "USD", values: tools.map((t) => x3.tools[t]?.detail?.["usd"] ?? num(x3.tools[t]?.value ?? null)) }],
    };
    if (spec.series.some((s) => s.values.some((v) => v !== null))) {
      charts.push(chartRef("X3 cost per tool", spec, "x3-cost", assetsRel, groupedBarChart(spec), "bar"));
    }
  }
  return charts;
}

/**
 * The hero chart (tech spec 10.9, capture #9), and its companion.
 *
 * It is produced unconditionally — with one line, or with none — because the
 * README leads with it and a missing file there is a broken page, not an absent
 * measurement. What is missing is said in the caption and in the chart's own
 * note, never drawn as a zero.
 *
 * Two charts, because the head-to-head payload carries two arms and conflating
 * them would be the most flattering possible mistake:
 *
 *   x2-staleness.png       each tool's artifact with its own documented refresh
 *                          run after every commit — an accuracy comparison
 *   x2-no-refresh.png      each tool's commit-0 artifact scored against truth at
 *                          each later commit — the actual staleness curve
 *
 * When no walk was run, the first falls back to the replay suite's flat F1 and
 * the second is omitted rather than invented.
 */
function stalenessCharts(x2: MetricRow | undefined, replay: Payload | null, assetsRel: string): ChartRef[] {
  const charts: ChartRef[] = [];
  const refreshed = curveFrom(x2, "f1");
  const stale = curveFrom(x2, "staleF1");

  let categories: string[] = refreshed?.categories ?? [];
  let series = refreshed?.series ?? [];
  let fallback = false;
  if (series.length === 0 && replay !== null) {
    // No per-tool walk: the replay suite's own catch rate, drawn flat across its
    // commit count, which is what a 1.0 catch rate means and nothing more.
    const commits = firstNum(replay.data, ["commits", "summary.commits", "commitCount"]);
    const f1 = replayF1(replay);
    if (commits !== null && f1 !== null) {
      const points = 5;
      categories = Array.from({ length: points }, (_, i) => String(Math.round((commits * i) / (points - 1))));
      series = [{ name: "greplost", values: categories.map(() => f1) }];
      fallback = true;
    }
  }

  const absent = ["graphify", "ua", "crg"].filter((tool) => !series.some((s) => s.name === tool));
  const note =
    series.length === 0
      ? "Nothing measured yet: no `headtohead --commits <n>` walk and no replay result, so this plot is " +
        "empty rather than flat at 1.0."
      : fallback
        ? "From the replay suite's `verify` catch rate, drawn flat across its commit count; no per-tool walk " +
          "has been run (`bench headtohead --commits <n>`)."
        : `Each tool's own documented refresh was invoked after every commit, so this is a comparison of ` +
          `incremental accuracy, not a decay curve.${absent.length === 0 ? "" : ` Omitted (not run here): ${absent.join(", ")}.`}`;

  const spec: ChartSpec = {
    title: fallback || series.length === 0 ? "X2 staleness decay under change" : "X2 artifact F1 with each tool's own refresh",
    xLabel: "commit index",
    yLabel: "F1 vs compiler truth",
    yMax: 1,
    categories: categories.length > 0 ? categories : ["0"],
    series,
    note,
  };
  charts.push(
    chartRef(
      series.length === 0
        ? "X2 (hero chart): no staleness walk and no replay result yet"
        : fallback
          ? "X2 staleness (hero chart): greplost only, from the replay suite's catch rate"
          : "X2 (hero chart): artifact F1 per commit, each tool refreshed by its own documented mechanism",
      spec,
      "x2-staleness",
      assetsRel,
      lineChart(spec),
    ),
  );

  if (stale !== null && stale.series.length > 0) {
    const staleSpec: ChartSpec = {
      title: "X2 staleness with no refresh",
      xLabel: "commit index",
      yLabel: "F1 vs compiler truth",
      yMax: 1,
      categories: stale.categories,
      series: stale.series,
      note:
        "Each tool's commit-0 artifact scored against truth at that commit: what a reader gets when the " +
        "sync mechanism is absent or does not fire. greplost is the only one of the four that can report " +
        "this state mechanically, through `verify`.",
    };
    charts.push(
      chartRef(
        "X2 staleness with no refresh: the same artifacts, never updated",
        staleSpec,
        "x2-no-refresh",
        assetsRel,
        lineChart(staleSpec),
      ),
    );
  }
  return charts;
}

/**
 * The `<prefix>@<commit>` series a head-to-head X2 cell carries in its detail.
 * `f1` is the refreshed arm, `staleF1` the unrefreshed one.
 */
function curveFrom(
  x2: MetricRow | undefined,
  prefix: "f1" | "staleF1",
): { categories: string[]; series: { name: string; values: (number | null)[] }[] } | null {
  if (x2 === undefined) return null;
  const pattern = new RegExp(`^${prefix}@(\\d+)$`);
  const points = new Map<string, Map<number, number>>();
  const indices = new Set<number>();
  for (const [tool, cellValue] of Object.entries(x2.tools)) {
    const detail = cellValue.detail;
    if (detail === undefined) continue;
    const own = new Map<number, number>();
    for (const [key, value] of Object.entries(detail)) {
      const match = pattern.exec(key);
      if (match === null) continue;
      const index = Number(match[1]);
      own.set(index, value);
      indices.add(index);
    }
    if (own.size > 0) points.set(tool, own);
  }
  if (points.size === 0) return null;
  const sorted = [...indices].sort((a, b) => a - b);
  return {
    categories: sorted.map(String),
    series: [...points.entries()].map(([tool, own]) => ({
      name: tool,
      values: sorted.map((index) => own.get(index) ?? null),
    })),
  };
}

function chartRef(
  caption: string,
  spec: ChartSpec,
  name: string,
  assetsRel: string,
  svg: string,
  kind: "line" | "bar" = "line",
): ChartRef {
  return { caption, body: mermaidXy(spec, kind), png: `${assetsRel}/${name}.png`, svg };
}

// ---------------------------------------------------------------------------
// Eval 1: structural
// ---------------------------------------------------------------------------

function eval1Section(payload: Payload | null): EvalSection {
  const section = emptySection();
  if (payload === null) {
    section.notes.push("Run `bun bench/src/cli.ts structural --fixture --gate` (or `--tier S`) to fill this section.");
    return section;
  }
  section.ran = true;
  section.provenance = provenanceOf(payload);

  const repos = rec(payload.data["repos"]) ?? {};
  for (const name of Object.keys(repos).sort()) {
    const repo = rec(repos[name]);
    if (repo === null) continue;
    const files = num(repo["files"]);
    const rows: EvalRow[] = [
      scoreRow("S1", "import edge precision / recall", ">= 0.99 / >= 0.97", rec(repo["S1"])),
      scoreRow("S2", "export precision / recall", ">= 0.99 / >= 0.99", rec(repo["S2"])),
      callRow(rec(repo["S3"]), rec(repo["callsAllConfidences"])),
      {
        id: "S4",
        metric: "import cycle Jaccard",
        target: "= 1.00",
        measured: fmt(num(repo["S4"])),
        detail: "",
      },
    ];
    // The two integrity flags from `structural.ts`. They are misses in their own
    // right, so they belong in the table, not in a footnote nobody reads.
    if (repo["truthEmpty"] === true) {
      section.notes.push(`${name}: the compiler truth was empty, so its S1 to S4 scores are meaningless (\`truth-empty\`).`);
    }
    if (repo["noFiles"] === true) {
      section.notes.push(`${name}: greplost indexed no file of the repo's language, so its scores are vacuous (\`no-files\`).`);
    }
    section.groups.push({ name: files === null ? name : `${name} (${fmt(files)} files)`, rows });
  }
  if (section.groups.length === 0) {
    section.groups.push({ name: null, rows: [] });
    section.notes.push("The structural payload carried no `repos` map, so no scores could be read from it.");
  }

  const notes = arr(rec(payload.data["truth"])?.["notes"]).filter((n): n is string => typeof n === "string");
  if (notes.length > 0) {
    section.notes.push(
      `Truth notes (how the oracle was built, Appendix C ruling on 10.3): ${notes.map((n) => `\`${n}\``).join(", ")}.`,
    );
    for (const note of notes) {
      const explanation = TRUTH_NOTES[note];
      section.notes.push(
        explanation === undefined
          ? `\`${note}\`: an emulation the truth generator recorded; this report has no gloss for it, so read ` +
            "`bench/src/truth/` for what it did."
          : `\`${note}\`: ${explanation}`,
      );
    }
  }
  return section;
}

/**
 * What each `Truth.notes` entry means, so a reader of RESULTS.md does not have
 * to open the truth generator to know what the oracle was allowed to assume.
 * Unknown notes are printed with a pointer rather than silently dropped.
 */
const TRUTH_NOTES: Record<string, string> = {
  "workspace-entry-mapping":
    "the TypeScript truth generator emulated the installed-and-built state of workspace packages (package " +
    "manifests plus tsconfig `outDir`/`rootDir`) so cross-package imports and calls resolve on a corpus " +
    "checkout that was never installed or built (Appendix C ruling on 10.3).",
  "cha-callgraph":
    "the Go oracle built its call graph by class-hierarchy analysis rather than by pointer analysis.",
  "cha-over-approximation":
    "class-hierarchy analysis resolves an interface call to every implementation of the method, so the " +
    "oracle's call set is an upper bound and the recall measured against it is a lower bound.",
};

function scoreRow(id: string, metric: string, target: string, score: Record<string, unknown> | null): EvalRow {
  const precision = num(score?.["precision"]);
  const recall = num(score?.["recall"]);
  return {
    id,
    metric,
    target,
    measured: precision === null && recall === null ? null : `${fmt(precision)} / ${fmt(recall)}`,
    detail: counts(score),
  };
}

function callRow(high: Record<string, unknown> | null, all: Record<string, unknown> | null): EvalRow {
  const precision = num(high?.["precision"]);
  const recall = num(high?.["recall"]);
  const allPrecision = num(all?.["precision"]);
  const allRecall = num(all?.["recall"]);
  return {
    id: "S3",
    metric: "call edge precision (confidence=high)",
    target: ">= 0.95",
    measured: precision === null ? null : fmt(precision),
    detail:
      `recall ${fmt(recall)}, ${counts(high)}` +
      (allPrecision === null ? "" : `; all confidences: precision ${fmt(allPrecision)}, recall ${fmt(allRecall)}`),
  };
}

function counts(score: Record<string, unknown> | null): string {
  const tp = num(score?.["tp"]);
  const fp = num(score?.["fp"]);
  const fn = num(score?.["fn"]);
  return tp === null ? "" : `tp ${fmt(tp)}, fp ${fmt(fp)}, fn ${fmt(fn)}`;
}

// ---------------------------------------------------------------------------
// Eval 2: replay
// ---------------------------------------------------------------------------

/** F1 as a rate in [0, 1], from either field spelling the replay suite may use. */
function replayF1(payload: Payload): number | null {
  const rate = firstNum(payload.data, ["f1CatchRate", "summary.f1CatchRate", "f1"]);
  if (rate !== null) return rate > 1 ? rate / 100 : rate;
  const caught = firstNum(payload.data, ["driftCaught", "summary.driftCaught"]);
  const total = firstNum(payload.data, ["driftTotal", "summary.driftTotal"]);
  if (caught === null || total === null || total === 0) return null;
  return caught / total;
}

function replayF2(payload: Payload): number | null {
  const rate = firstNum(payload.data, ["f2Mismatch", "summary.f2Mismatch", "f2"]);
  if (rate !== null) return rate > 1 ? rate / 100 : rate;
  const mismatches = firstNum(payload.data, ["f2Mismatches", "summary.f2Mismatches"]);
  const checks = firstNum(payload.data, ["f2Checks", "summary.f2Checks"]);
  if (mismatches === null || checks === null || checks === 0) return null;
  return mismatches / checks;
}

function eval2Section(payload: Payload | null): EvalSection {
  const section = emptySection();
  if (payload === null) {
    section.notes.push("Run `bun bench/src/cli.ts replay --fixture --commits 5` (or `--repo <name> --commits 500`) to fill this section.");
    return section;
  }
  section.ran = true;
  section.provenance = provenanceOf(payload);

  const commits = firstNum(payload.data, ["commits", "summary.commits", "commitCount"]);
  const caught = firstNum(payload.data, ["driftCaught", "summary.driftCaught"]);
  const total = firstNum(payload.data, ["driftTotal", "summary.driftTotal"]);
  const mismatches = firstNum(payload.data, ["f2Mismatches", "summary.f2Mismatches"]);
  const checks = firstNum(payload.data, ["f2Checks", "summary.f2Checks"]);
  const noops = firstNum(payload.data, ["noops", "summary.noops"]);
  const p50 = firstNum(payload.data, ["updateP50", "summary.updateP50"]);
  const p95 = firstNum(payload.data, ["updateP95", "summary.updateP95"]);
  const f1 = replayF1(payload);
  const f2 = replayF2(payload);

  const rows: EvalRow[] = [
    {
      id: "F1",
      metric: "`verify` catch rate on stale maps",
      target: "100%",
      measured: f1 === null ? null : `${fmt(f1 * 100)}%`,
      detail: caught === null || total === null ? "" : `${fmt(caught)} of ${fmt(total)} injected drifts caught`,
    },
    {
      id: "F2",
      metric: "`verify` false positives after `update`",
      target: "0% (byte-identical)",
      measured: f2 === null ? null : `${fmt(f2 * 100)}%`,
      detail:
        (mismatches === null || checks === null
          ? ""
          : `${fmt(mismatches)} of ${fmt(checks)} full-vs-incremental comparisons differed; `) +
        "compared over the structure artifacts only (`listStructurePaths`), not the whole `.greplost/`",
    },
  ];
  section.groups.push({ name: null, rows });
  section.notes.push(
    `Replay length: ${commits === null ? "not recorded" : `${fmt(commits)} commits`}` +
      (noops === null ? "" : `, ${fmt(noops)} of them no-ops`) +
      (p50 === null ? "" : `; incremental update p50 ${fmt(p50)} ms`) +
      (p95 === null ? "" : `, p95 ${fmt(p95)} ms`) +
      ".",
  );
  if (f1 === null && f2 === null) {
    section.notes.push(
      "The replay payload carried none of the fields this report knows (`driftCaught`/`driftTotal` or " +
        "`f1CatchRate`, `f2Mismatches`/`f2Checks` or `f2Mismatch`), so both rows say `not run`.",
    );
  }
  return section;
}

// ---------------------------------------------------------------------------
// Bench 3: perf
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  p50: number | null;
  p95: number | null;
  rss: number | null;
  files: number | null;
}

/**
 * Every `{ p50, p95, rss }` record in a perf payload, wherever it sits.
 *
 * Three shapes are accepted, because the perf suite landed in a parallel branch:
 * a flat `scenarios` map, a `repos.<repo>.scenarios` map, and — as a last resort —
 * any nested object whose values look like scenario records.
 */
export function scenariosOf(payload: Payload): Scenario[] {
  const found: Scenario[] = [];
  const seen = new Set<string>();
  const consider = (prefix: string, container: unknown): void => {
    const record = rec(container);
    if (record === null) return;
    for (const key of Object.keys(record).sort()) {
      const entry = rec(record[key]);
      if (entry === null) continue;
      const p50 = num(entry["p50"]);
      const p95 = num(entry["p95"]);
      if (p50 === null && p95 === null) continue;
      const name = prefix.length > 0 ? `${prefix} ${key}` : key;
      if (seen.has(name)) continue;
      seen.add(name);
      found.push({
        name,
        p50,
        p95,
        rss: num(entry["rss"]) ?? num(entry["maxRSS"]) ?? num(entry["peakRss"]),
        files: num(entry["files"]) ?? num(entry["fileCount"]),
      });
    }
  };

  consider("", payload.data["scenarios"]);
  const repos = rec(payload.data["repos"]);
  if (repos !== null) {
    for (const repo of Object.keys(repos).sort()) {
      const entry = rec(repos[repo]);
      if (entry === null) continue;
      consider(repo, entry["scenarios"] ?? entry);
    }
  }
  if (found.length === 0) consider("", payload.data);
  return found;
}

function bench3Section(payload: Payload | null, assetsRel: string): EvalSection {
  const section = emptySection();
  if (payload === null) {
    section.notes.push("Run `bun bench/src/cli.ts perf --fixture` (or `--tier S`) to fill this section.");
    return section;
  }
  section.ran = true;
  section.provenance = provenanceOf(payload);

  const scenarios = scenariosOf(payload);
  const full = scenarios.find((s) => /full|build|cold/i.test(s.name)) ?? scenarios[0];
  const incremental = scenarios.find((s) => /incremental|single|edit/i.test(s.name)) ?? scenarios[1] ?? full;
  const peakRss = scenarios.reduce<number | null>((max, s) => (s.rss === null ? max : Math.max(max ?? 0, s.rss)), null);

  section.groups.push({
    name: null,
    rows: [
      {
        id: "P1",
        metric: "full build, 1k / 10k files",
        target: "<= 1s / <= 10s",
        measured: full?.p50 == null ? null : `${fmt(full.p50)} ms (p50)`,
        detail: full === undefined ? "" : `scenario \`${full.name}\`${full.files === null ? "" : `, ${fmt(full.files)} files`}`,
      },
      {
        id: "P2",
        metric: "incremental update p95, 1k / 10k files",
        target: "<= 500ms / <= 1s",
        measured: incremental?.p95 == null ? null : `${fmt(incremental.p95)} ms`,
        detail: incremental === undefined ? "" : `scenario \`${incremental.name}\`${incremental.p50 === null ? "" : `, p50 ${fmt(incremental.p50)} ms`}`,
      },
      {
        id: "P3",
        metric: "peak RSS at 10k files",
        target: "<= 500MB (reported)",
        measured: peakRss === null ? null : `${fmt(peakRss / 1024 / 1024)} MB`,
        detail: peakRss === null ? "" : "highest `maxRSS` across the scenarios below",
      },
    ],
  });

  if (scenarios.length > 0) {
    section.groups.push({
      name: "every scenario",
      rows: scenarios.map((s) => ({
        id: "P-",
        metric: s.name,
        target: "-",
        measured: s.p50 === null ? null : `${fmt(s.p50)} ms (p50)`,
        detail: `${s.p95 === null ? "" : `p95 ${fmt(s.p95)} ms`}${s.rss === null ? "" : `, RSS ${fmt(s.rss / 1024 / 1024)} MB`}`,
      })),
    });

    const boxes: BoxDatum[] = scenarios
      .filter((s) => s.p50 !== null && s.p95 !== null)
      .map((s) => ({ name: s.name, low: null, q1: s.p50 as number, mid: s.p50 as number, q3: s.p95 as number, high: null }));
    if (boxes.length > 0) {
      const svg = boxChart({
        title: "P2 latency per scenario",
        yLabel: "ms",
        boxes,
        note: "Box spans p50 to p95; whiskers omitted because the perf payload reports those two quantiles only.",
      });
      section.charts.push({
        caption: "Latency per scenario (box spans p50 to p95)",
        body: mermaidXy(
          {
            title: "P2 latency per scenario",
            yLabel: "ms",
            categories: boxes.map((b) => b.name),
            series: [{ name: "p50", values: boxes.map((b) => b.mid) }, { name: "p95", values: boxes.map((b) => b.q3) }],
          },
          "bar",
        ),
        png: `${assetsRel}/latency-box.png`,
        svg,
      });
    }

    const withFiles = scenarios.filter((s) => s.files !== null && s.p50 !== null).sort((a, b) => (a.files as number) - (b.files as number));
    if (withFiles.length > 1) {
      const spec: ChartSpec = {
        title: "Build time vs files",
        xLabel: "files",
        yLabel: "ms",
        categories: withFiles.map((s) => fmt(s.files)),
        series: [{ name: "p50", values: withFiles.map((s) => s.p50) }],
      };
      section.charts.push({ caption: "Build time vs files", body: mermaidXy(spec), png: `${assetsRel}/build-time.png`, svg: lineChart(spec) });
    }
  } else {
    section.notes.push(
      "The perf payload carried no `{ p50, p95, rss }` scenario records this report could find, so P1 to P3 say `not run`.",
    );
  }
  return section;
}

// ---------------------------------------------------------------------------
// Eval 4: agent
// ---------------------------------------------------------------------------

interface ConditionStats {
  accuracy: number | null;
  tokens: number | null;
  toolCalls: number | null;
  wallClock: number | null;
  cost: number | null;
}

/** `category -> condition -> stats`, from whichever container the agent suite used. */
export function agentCategories(payload: Payload): Map<string, Map<string, ConditionStats>> {
  const out = new Map<string, Map<string, ConditionStats>>();
  const container =
    rec(payload.data["categories"]) ?? rec(payload.data["byCategory"]) ?? rec(payload.data["results"]) ?? null;
  if (container === null) return out;
  for (const category of Object.keys(container).sort()) {
    const conditions = rec(container[category]);
    if (conditions === null) continue;
    const inner = new Map<string, ConditionStats>();
    for (const condition of Object.keys(conditions).sort()) {
      const stats = rec(conditions[condition]);
      if (stats === null) continue;
      const read = (...names: string[]): number | null => {
        for (const name of names) {
          const direct = num(stats[name]);
          if (direct !== null) return direct;
          // `{ mean, median, std }` blocks: the spec reports variance, so a
          // scalar may be one level down. Median first: it is what A1 gates on.
          const nested = rec(stats[name]);
          if (nested !== null) {
            const value = num(nested["median"]) ?? num(nested["mean"]) ?? num(nested["p50"]);
            if (value !== null) return value;
          }
        }
        return null;
      };
      inner.set(condition, {
        accuracy: read("accuracy", "acc", "score"),
        tokens: read("tokens", "totalTokens"),
        toolCalls: read("toolCalls", "tool_calls", "calls"),
        wallClock: read("wallClock", "wallClockSeconds", "seconds"),
        cost: read("cost", "costUsd", "total_cost_usd"),
      });
    }
    if (inner.size > 0) out.set(category, inner);
  }
  return out;
}

function eval4Section(payload: Payload | null, assetsRel: string): EvalSection {
  const section = emptySection();
  if (payload === null) {
    section.notes.push("Run `bun bench/src/cli.ts agent --repo <name> --condition gl --runs 5` to fill this section (it costs money).");
    return section;
  }
  section.ran = true;
  section.provenance = provenanceOf(payload);

  const categories = agentCategories(payload);
  if (categories.size === 0) {
    section.groups.push({ name: null, rows: [] });
    section.notes.push("The agent payload carried no per-category, per-condition stats this report could find, so A1 to A4 say `not run`.");
    return section;
  }

  // A1 to A4 are ratios of the `gl` condition against `base`, aggregated over
  // categories by the unweighted mean of the per-category ratios.
  const ratios = { tokens: [] as number[], toolCalls: [] as number[], wallClock: [] as number[] };
  const accuracyDeltas: number[] = [];
  for (const conditions of categories.values()) {
    const base = conditions.get("base");
    const gl = conditions.get("gl") ?? conditions.get("gl-strict");
    if (base === undefined || gl === undefined) continue;
    if (base.tokens !== null && gl.tokens !== null && base.tokens > 0) ratios.tokens.push(gl.tokens / base.tokens);
    if (base.toolCalls !== null && gl.toolCalls !== null && base.toolCalls > 0) ratios.toolCalls.push(gl.toolCalls / base.toolCalls);
    if (base.wallClock !== null && gl.wallClock !== null && base.wallClock > 0) ratios.wallClock.push(gl.wallClock / base.wallClock);
    if (base.accuracy !== null && gl.accuracy !== null) accuracyDeltas.push(gl.accuracy - base.accuracy);
  }
  const mean = (values: number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

  section.groups.push({
    name: null,
    rows: [
      { id: "A1", metric: "tokens per task vs baseline (median)", target: "<= 50%", measured: pct(mean(ratios.tokens)), detail: `${ratios.tokens.length} categories` },
      { id: "A2", metric: "tool calls per task vs baseline", target: "<= 40%", measured: pct(mean(ratios.toolCalls)), detail: `${ratios.toolCalls.length} categories` },
      { id: "A3", metric: "answer accuracy vs baseline", target: "non-inferior; +10pt on blast radius", measured: mean(accuracyDeltas) === null ? null : `${fmt((mean(accuracyDeltas) as number) * 100)} pt`, detail: `${accuracyDeltas.length} categories` },
      { id: "A4", metric: "wall-clock per task vs baseline", target: "<= 60%", measured: pct(mean(ratios.wallClock)), detail: `${ratios.wallClock.length} categories` },
    ],
  });

  const conditionNames = [...new Set([...categories.values()].flatMap((c) => [...c.keys()]))].sort();
  for (const [category, conditions] of categories) {
    section.groups.push({
      name: `${category} by condition`,
      rows: [...conditions.entries()].map(([condition, stats]) => ({
        id: "A-",
        metric: condition,
        target: "-",
        measured: stats.accuracy === null ? null : `accuracy ${fmt(stats.accuracy)}`,
        detail: [
          stats.tokens === null ? null : `${fmt(stats.tokens)} tokens`,
          stats.toolCalls === null ? null : `${fmt(stats.toolCalls)} tool calls`,
          stats.wallClock === null ? null : `${fmt(stats.wallClock)} s`,
          stats.cost === null ? null : `$${fmt(stats.cost)}`,
        ].filter((part): part is string => part !== null).join(", "),
      })),
    });
  }

  const winLossTie = rec(payload.data["winLossTie"]);
  if (winLossTie !== null) {
    const parts = Object.keys(winLossTie).sort().map((condition) => {
      const entry = rec(winLossTie[condition]);
      return `${condition}: ${fmt(num(entry?.["win"]))}W / ${fmt(num(entry?.["loss"]))}L / ${fmt(num(entry?.["tie"]))}T`;
    });
    section.notes.push(`Win/loss/tie vs \`base\` — ${parts.join("; ")}.`);
  }

  const spec: ChartSpec = {
    title: "X7 agent accuracy and tool calls by condition",
    yLabel: "accuracy (0-1) and tool calls",
    categories: conditionNames,
    series: [
      { name: "accuracy", values: conditionNames.map((c) => meanOver(categories, c, (s) => s.accuracy)) },
      { name: "tool calls", values: conditionNames.map((c) => meanOver(categories, c, (s) => s.toolCalls)) },
    ],
  };
  if (spec.series.some((s) => s.values.some((v) => v !== null))) {
    section.charts.push({
      caption: "Accuracy and tool calls by condition",
      body: mermaidXy(spec, "bar"),
      png: `${assetsRel}/x7-agent.png`,
      svg: groupedBarChart(spec),
    });
  }
  return section;
}

function meanOver(
  categories: Map<string, Map<string, ConditionStats>>,
  condition: string,
  pick: (stats: ConditionStats) => number | null,
): number | null {
  const values: number[] = [];
  for (const conditions of categories.values()) {
    const stats = conditions.get(condition);
    const value = stats === undefined ? null : pick(stats);
    if (value !== null) values.push(value);
  }
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

function pct(ratio: number | null): string | null {
  return ratio === null ? null : `${fmt(ratio * 100)}%`;
}

// ---------------------------------------------------------------------------
// Eval 5: human study, and map quality
// ---------------------------------------------------------------------------

function eval5Section(payload: Payload | null): EvalSection {
  const section = emptySection();
  if (payload === null) {
    section.groups.push({
      name: null,
      rows: [
        { id: "H1", metric: "time to correct answer, with vs without", target: "<= 60% (median)", measured: null, detail: "" },
        { id: "H2", metric: "wrong-answer rate, with vs without", target: "lower", measured: null, detail: "" },
      ],
    });
    section.ran = true;
    section.notes.push(
      "The human navigation study (tech spec 10.7) has no harness: it needs participants, and its results " +
        "arrive as an anonymised CSV. Nothing in `bench/results/` can fill these rows, so they stay `not run` " +
        "until a study is conducted. X9 in the head-to-head table depends on the same study.",
    );
    return section;
  }
  section.ran = true;
  section.provenance = provenanceOf(payload);
  section.groups.push({
    name: null,
    rows: [
      { id: "H1", metric: "time to correct answer, with vs without", target: "<= 60% (median)", measured: fmt(firstNum(payload.data, ["h1", "timeRatio"])), detail: "" },
      { id: "H2", metric: "wrong-answer rate, with vs without", target: "lower", measured: fmt(firstNum(payload.data, ["h2", "wrongAnswerRate"])), detail: "" },
    ],
  });
  return section;
}

function mapqualitySection(payload: Payload | null): EvalSection {
  const section = emptySection();
  if (payload === null) {
    section.notes.push("Run `bun bench/src/cli.ts mapquality --fixture --gate` to fill this section.");
    return section;
  }
  section.ran = true;
  section.provenance = provenanceOf(payload);

  const tokens = firstNum(payload.data, ["tokens.indexMd"]);
  const budget = firstNum(payload.data, ["tokens.budget"]) ?? 3000;
  const maxNodeCount = firstNum(payload.data, ["diagrams.maxNodeCount"]);
  const maxNodes = firstNum(payload.data, ["diagrams.maxNodes"]);
  const fences = firstNum(payload.data, ["diagrams.fences"]);
  const checker = firstStr(payload.data, ["checker"]);
  const dir = firstStr(payload.data, ["target.dir"]);

  section.groups.push({
    name: null,
    rows: [
      {
        id: "M1",
        metric: "INDEX.md token budget",
        target: `<= ${fmt(budget)} tokens`,
        measured: tokens === null ? null : `${fmt(tokens)} tokens`,
        detail: "cl100k_base",
      },
      {
        id: "M2",
        metric: "diagrams exceeding the node cap after auto-split",
        target: "0",
        measured: maxNodeCount === null || maxNodes === null ? null : (maxNodeCount > maxNodes ? "1 or more" : "0"),
        detail: maxNodeCount === null ? "" : `largest fence ${fmt(maxNodeCount)} nodes, cap ${fmt(maxNodes)}${fences === null ? "" : `, ${fmt(fences)} fences`}`,
      },
    ],
  });
  section.notes.push(
    `Artifact dir: \`${dir ?? "not recorded"}\`. Mermaid checker: \`${checker ?? "not recorded"}\`` +
      (checker === "subset"
        ? " — `mermaid` 11 under jsdom could not run headless here, so fences were validated against a strict " +
          "grammar for the subset greplost emits (bench spec 1.5.4)."
        : "."),
  );
  return section;
}

// ---------------------------------------------------------------------------
// payload access
// ---------------------------------------------------------------------------

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** `a.b.c` against a payload; undefined at any hop yields null. */
function at(root: unknown, dotted: string): unknown {
  let cursor: unknown = root;
  for (const key of dotted.split(".")) {
    const record = rec(cursor);
    if (record === null) return undefined;
    cursor = record[key];
  }
  return cursor;
}

/**
 * Every value this report found by searching for a key name rather than at a
 * documented path. Collected per `buildModel` call and printed in the preamble,
 * because a number read out of a payload whose shape nobody agreed on is a
 * number a reader should be able to distrust on sight.
 */
let assumptions: string[] = [];

/**
 * The first of `paths` that holds a finite number; then, as a fallback, the first
 * value found anywhere in the payload under the last path segment of any
 * candidate. The fallback is what makes this report survive a neighbour suite
 * nesting its summary one level deeper than documented — and every use of it is
 * recorded in `assumptions`, so it is a disclosed guess rather than a silent one.
 */
function firstNum(root: unknown, paths: readonly string[]): number | null {
  for (const dotted of paths) {
    const value = num(at(root, dotted));
    if (value !== null) return value;
  }
  for (const dotted of paths) {
    const key = dotted.split(".").pop();
    if (key === undefined) continue;
    const found = deepFind(root, key, 5);
    const value = num(found);
    if (value !== null) {
      assumptions.push(`\`${key}\` was not at ${paths.map((path_) => `\`${path_}\``).join(" or ")}; the value used was found by searching the payload for that key`);
      return value;
    }
  }
  return null;
}

function firstStr(root: unknown, paths: readonly string[]): string | null {
  for (const dotted of paths) {
    const value = str(at(root, dotted));
    if (value !== null) return value;
  }
  return null;
}

/** Breadth-first search for `key`, so the shallowest match wins. */
function deepFind(root: unknown, key: string, maxDepth: number): unknown {
  let frontier: unknown[] = [root];
  for (let depth = 0; depth <= maxDepth; depth++) {
    const next: unknown[] = [];
    for (const node of frontier) {
      const record = rec(node);
      if (record === null) continue;
      if (key in record) return record[key];
      for (const child of Object.keys(record).sort()) next.push(record[child]);
    }
    if (next.length === 0) return undefined;
    frontier = next;
  }
  return undefined;
}

/** Three decimals under 10, one under 1000, none above; `not run` for null. */
function fmt(value: number | null): string {
  if (value === null) return "not run";
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return String(Math.round(value));
  if (magnitude >= 10) return String(Math.round(value * 10) / 10);
  return String(Math.round(value * 1000) / 1000);
}

export { SECTION_HEADERS, X_IDS, NOT_APPLICABLE };
export type { XId };
