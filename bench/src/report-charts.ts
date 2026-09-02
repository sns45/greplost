/**
 * The charts `RESULTS.md` carries (tech spec 10.9; bench leaf 1.5.7).
 *
 * Each builder turns already-read numbers into a `ChartRef`: a caption, an
 * inline `xychart-beta` fence and the SVG `report.ts` rasterises into
 * `docs/assets/`. Kept apart from the section builders because a chart has one
 * obligation the tables do not — it must not draw a measurement that was never
 * taken. A missing tool is a gap or an omitted category, never a zero, and every
 * chart's note names the arm, the corpus and the walk length it came from.
 *
 * Nothing here types a number. Every value is read out of a head-to-head cell's
 * `detail` (or, for a derived one, computed from two of them: `f1` is the
 * harmonic mean of the precision and recall the payload carries), so a chart
 * and the table above it cannot disagree.
 */
import {
  displayValue,
  groupedBarChart,
  barChart,
  lineChart,
  logScaleFor,
  mermaidXy,
  scatterChart,
  sortDesc,
  sortSeriesDesc,
  type ChartSpec,
  type ScatterPoint,
  type ScatterSpec,
} from "./charts.ts";
import type { ChartRef, MetricRow, RunTarget } from "./results-md.ts";
import { firstNum, num, replayF1, type Payload } from "./report-payload.ts";

/**
 * The three curves an X2 payload can carry, and the sentence each one is.
 *
 * The key prefix in a cell's `detail` is the arm's name on disk. `f1@` is the
 * spelling the first round of this suite wrote, before the arms were separated;
 * it is the refresh-every-commit arm, and it is labelled as such rather than
 * quietly redrawn as the hero.
 */
const ARMS: readonly { prefix: string; slug: string; title: string; arm: string; caption: string; note: string }[] = [
  {
    prefix: "syncF1",
    slug: "x2-staleness",
    title: "Freshness under each tool's own sync mechanism: F1 vs commit",
    arm: "documented-sync",
    caption: "X2 (hero chart): freshness under each tool's own sync mechanism over a synthetic commit walk, F1 vs commit",
    note:
      "Arm: documented-sync — each tool's sync mechanism was installed exactly as its README describes and " +
      "then left alone; the harness only commits, except that crg's `visualize --format json` export is run " +
      "at each scoring checkpoint because nothing else writes the JSON its artifact is read from (it is " +
      "outside every timing and does not rebuild). This is the arm tech spec 10.0 X2 words. Read the FALL of " +
      "each line, not its height: the height is that tool's import coverage (X1's subject) and only the fall " +
      "is staleness.",
  },
  {
    prefix: "refreshF1",
    slug: "x2-refresh-every-commit",
    title: "X2 artifact F1 with every refresh invoked by hand",
    arm: "refresh-every-commit",
    caption: "X2 companion: artifact F1 when the harness invokes every tool's refresh after every commit",
    note:
      "Arm: refresh-every-commit — the harness invoked each tool's documented refresh command after every " +
      "commit. Nothing decays here for anyone, so this is a comparison of incremental accuracy and not a " +
      "staleness curve.",
  },
  {
    prefix: "f1",
    slug: "x2-refresh-every-commit",
    title: "X2 artifact F1 with every refresh invoked by hand",
    arm: "refresh-every-commit",
    caption: "X2 companion: artifact F1 when the harness invokes every tool's refresh after every commit",
    note:
      "Arm: refresh-every-commit (a payload written before the arms were named apart) — the harness invoked " +
      "each tool's documented refresh after every commit, so no line decays and this is not a staleness curve.",
  },
  {
    prefix: "staleF1",
    slug: "x2-no-refresh",
    title: "X2 staleness with no refresh",
    arm: "no-refresh",
    caption: "X2 companion: the same artifacts, never updated",
    note:
      "Arm: no-refresh — each tool's commit-0 artifact scored against truth at that commit, which is what a " +
      "reader gets when a sync mechanism is absent or silently does not fire. greplost is the only one of the " +
      "four that can report this state mechanically, through `verify`.",
  },
];

/** Every tool the head-to-head table knows, so an unrun one can still be named. */
const KNOWN_TOOLS: readonly string[] = ["greplost", "graphify", "ua", "crg"];

/**
 * What the commit walk behind every X2 curve actually is.
 *
 * The tech spec asks for 500 real commits of a corpus checkout; what runs here is a
 * generated history over the pinned tree (`planImportEdits`). One added import line per
 * commit is the easy direction for an incremental updater, and a chart that does not say
 * so lets a reader take a flat line for a claim about real repository churn.
 */
export const SYNTHETIC_WALK_NOTE =
  " The walk is synthetic: each commit appends exactly one resolvable import line to one file, so truth " +
  "moves by exactly one edge per commit, and the walk contains no deletions, no renames and no new files.";

/**
 * What the shaded corner of a quadrant scatter is, said on the chart itself.
 *
 * It is a reading aid at a fixed fraction of each axis, not a threshold anybody
 * measured. Saying so on the image matters more than saying it in the document:
 * the PNG is what travels into a README.
 */
const QUADRANT_NOTE =
  " The shaded corner is a reading aid, not a threshold: it covers the cheapest 40% of the x axis and the " +
  "best 40% of the y axis, and no measurement decides where it sits. The dotted line is the Pareto front — " +
  "a tool is on it when nothing else is at least as good on both axes and better on one.";

/** ` corpus hono, tier M (248 files); 100 replayed commits` — the scale, without a verb. */
export function scaleParts(target: RunTarget | undefined, commits: number | null): string {
  const parts: string[] = [];
  if (target?.repo !== undefined) {
    const where = target.fixture === true
      ? `fixtures/${target.repo}`
      : target.tier === undefined
        ? target.repo
        : `${target.repo}, tier ${target.tier}`;
    parts.push(`corpus ${where}${target.files === undefined ? "" : ` (${target.files} files)`}`);
  }
  const walked = commits ?? target?.commits ?? null;
  // Zero is "no walk was asked for", not "a walk of length zero".
  if (walked !== null && walked > 0) parts.push(`${walked} replayed commit${walked === 1 ? "" : "s"}`);
  return parts.join("; ");
}

/**
 * ` Corpus: hono, tier M (618 files); walk: 100 commits.`
 *
 * Appended to every head-to-head chart's note, because a curve with no
 * denominator invites the reader to size it wrongly and these walks are short.
 */
export function scaleNote(target: RunTarget | undefined, commits: number | null): string {
  const parts = scaleParts(target, commits);
  return parts.length === 0 ? "" : ` Measured on ${parts}.`;
}

/** The harmonic mean the F1 charts plot, or null when either half is missing. */
export function f1(precision: number | null | undefined, recall: number | null | undefined): number | null {
  if (typeof precision !== "number" || typeof recall !== "number") return null;
  if (!Number.isFinite(precision) || !Number.isFinite(recall)) return null;
  if (precision + recall <= 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/** One `detail` number of one tool, or null. */
function detailOf(row: MetricRow | undefined, tool: string, key: string): number | null {
  const value = row?.tools[tool]?.detail?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The tools a row carries, in the payload's own order. */
function toolsOf(row: MetricRow | undefined): string[] {
  return row === undefined ? [] : Object.keys(row.tools);
}

/** The tools this chart could not draw, so the legend can still name them. */
function absentTools(drawn: readonly string[], known: readonly string[] = KNOWN_TOOLS): string[] {
  return known.filter((tool) => !drawn.includes(tool));
}

export function headToHeadCharts(
  rows: readonly MetricRow[],
  replay: Payload | null,
  assetsRel: string,
  target: RunTarget | undefined,
): ChartRef[] {
  const charts: ChartRef[] = [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const x2 = byId.get("X2");
  // Each chart takes its scale from the row it draws, not from the table's: X1
  // and X2 are routinely different runs on different repos, and a chart that
  // named the other run's corpus in its own note would be the disclosure defect
  // the note exists to prevent.
  const runOf = (row: MetricRow | undefined): RunTarget | undefined => row?.run ?? target;

  // Hero (tech spec 10.9, capture #9): F1 vs commit index, one line per tool.
  charts.push(...stalenessCharts(x2, replay, assetsRel, runOf(x2)));

  // The two quadrant charts the README leads with: a cost on x, the quality it
  // bought on y, so a reader who will not read a table still sees the trade.
  charts.push(...quadrantCharts(byId, assetsRel, runOf));

  const x1 = byId.get("X1");
  if (x1 !== undefined) {
    const tools = toolsOf(x1);
    // Transposed against the table: the *series* are the tools, so every tool
    // keeps its own colour here and on the scatter, and the two edge kinds are
    // the groups. Colour that followed a row number instead would repaint a
    // tool the moment another one was dropped.
    const spec: ChartSpec = sortSeriesDesc({
      title: "X1 structural precision vs compiler truth",
      subtitle:
        `Precision by edge kind, every confidence; higher is better. ${capitalise(scaleParts(runOf(x1), null))}.`,
      yLabel: "precision vs compiler truth",
      yMax: 1,
      highlight: "greplost",
      categories: ["call edges", "import edges"],
      series: tools.map((tool) => ({
        name: tool,
        values: [detailOf(x1, tool, "callPrecision"), detailOf(x1, tool, "importPrecision")],
      })),
      note: `A dashed stub is a tool that could not be run; see the reason column.${scaleNote(runOf(x1), null)}`,
    });
    if (spec.series.some((s) => s.values.some((v) => v !== null))) {
      charts.push(chartRef("X1 precision per tool per edge kind", spec, "x1-precision", assetsRel, groupedBarChart(spec), "bar"));
    }
  }

  const x3 = byId.get("X3");
  if (x3 !== undefined) {
    const tools = toolsOf(x3);
    const x3Run = runOf(x3);
    const commits = walkLength(x3) ?? x3Run?.commits ?? null;
    const spec: ChartSpec = sortDesc({
      title: "X3 cost to stay fresh",
      subtitle: `USD spent keeping the artifact fresh; lower is better. ${capitalise(scaleParts(x3Run, commits))}.`,
      yLabel: commits === null ? "USD over the walk" : `USD over ${commits} commits`,
      highlight: "greplost",
      categories: tools,
      series: [{ name: "USD", values: tools.map((t) => x3.tools[t]?.detail?.["usd"] ?? num(x3.tools[t]?.value ?? null)) }],
      note:
        "Every tool that ran here ran its no-LLM path, so USD is 0 for all of them; the wall-clock that " +
        "separates them is in the table and on the freshness quadrant chart. A bar at the baseline is a " +
        `measured zero; a dashed stub is a tool that could not be run.${scaleNote(x3Run, commits)}`,
    });
    if (spec.series.some((s) => s.values.some((v) => v !== null))) {
      charts.push(chartRef("X3 cost per tool", spec, "x3-cost", assetsRel, barChart(spec), "bar"));
    }
  }

  charts.push(...metricBarChart(byId.get("X4"), runOf, assetsRel, {
    slug: "x4-bytes",
    key: "bytes",
    caption: "X4 bytes that differ between two builds of one commit",
    title: "X4 reproducibility: bytes that differ between two builds",
    unit: "bytes differing between two builds of one commit",
    note:
      "Two builds of the same tree, each in its own process, compared over that tool's own documented " +
      "artifact files; viewer and database files are excluded per competitor and each cell's caveat says " +
      "which. A bar at the baseline is a measured zero — the best result this metric has — and a dashed " +
      "stub is a tool that could not be run.",
  }));

  charts.push(...metricBarChart(byId.get("X5"), runOf, assetsRel, {
    slug: "x5-lines",
    key: "lines",
    caption: "X5 artifact lines changed by a one-line source change",
    title: "X5 diff signal after a one-line change",
    unit: "artifact lines added plus removed",
    note:
      "Absolute lines, and the artifacts they are lines of are not the same size: the denominators are " +
      "in the table (and in each cell's value) and they differ by an order of magnitude, so this chart " +
      "ranks the size of the diff a reviewer reads, not the share of the artifact it touched.",
  }));

  charts.push(...metricBarChart(byId.get("X6"), runOf, assetsRel, {
    slug: "x6-seconds",
    key: "seconds",
    caption: "X6 cold start to a first usable map",
    title: "X6 cold start to a first usable map",
    unit: "seconds, median of the timed runs",
    note:
      "Timed from a fresh copy of the repo (no cache, no artifact) to the tool's own first usable output, " +
      "every tool in its own child process so interpreter startup is counted for all of them; the spread " +
      "is in each cell's detail.",
  }));

  return charts;
}

/** Sentence case for a scale fragment that starts a sentence. */
function capitalise(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}

/**
 * One sorted bar chart of one head-to-head metric, one bar per tool.
 *
 * Descending by value with greplost anchored by a white ring under its label,
 * which is the Artificial Analysis layout this restyle follows. Every one of
 * these metrics is *lower is better*, so the subtitle says so rather than
 * letting the tallest bar read as the winner.
 */
function metricBarChart(
  row: MetricRow | undefined,
  runOf: (row: MetricRow | undefined) => RunTarget | undefined,
  assetsRel: string,
  about: { slug: string; key: string; caption: string; title: string; unit: string; note: string },
): ChartRef[] {
  if (row === undefined) return [];
  const tools = toolsOf(row);
  const values = tools.map((tool) => detailOf(row, tool, about.key));
  if (!values.some((value) => value !== null)) return [];
  const run = runOf(row);
  // A log axis only where the data earns one: every value positive and the
  // spread over two decades. X4's best result is a measured zero, and an axis
  // that cannot draw a zero would have to drop the winner to exist.
  const log = logScaleFor(values);
  const spec: ChartSpec = sortDesc({
    title: about.title,
    subtitle: `${capitalise(about.unit)}; lower is better. ${capitalise(scaleParts(run, null))}.`,
    yLabel: log ? `${about.unit} (log scale)` : about.unit,
    ...(log ? { logY: true } : {}),
    highlight: "greplost",
    categories: tools,
    series: [{ name: about.key, values }],
    note: `${about.note}${scaleNote(run, null)}`,
  });
  return [chartRef(about.caption, spec, about.slug, assetsRel, barChart(spec), "bar")];
}

/**
 * The two quadrant scatters (Artificial Analysis' "Cost vs. Time per task").
 *
 * Both plot a cost the reader pays on x against the quality it bought on y, so
 * the cheap-and-good corner is up and to the left. Each is built from two
 * metrics of the *same* run — freshness from X2 and X3 (the commit walk),
 * accuracy from X1 and X6 (the corpus run) — because pairing two runs on two
 * corpora would make an axis a reader cannot check.
 */
export function quadrantCharts(
  byId: Map<string, MetricRow>,
  assetsRel: string,
  runOf: (row: MetricRow | undefined) => RunTarget | undefined,
): ChartRef[] {
  const charts: ChartRef[] = [];

  const x2 = byId.get("X2");
  const x3 = byId.get("X3");
  const curve = curveFrom(x2, "syncF1");
  if (x2 !== undefined && x3 !== undefined && curve !== null) {
    const commits = walkLength(x2) ?? runOf(x2)?.commits ?? null;
    const points: ScatterPoint[] = [];
    for (const series of curve.series) {
      // The last checkpoint of the same curve the hero chart draws, so the two
      // charts cannot disagree about where a tool ended up.
      const last = [...series.values].reverse().find((value) => value !== null) ?? null;
      const minutes = detailOf(x3, series.name, "minutes");
      if (last === null || minutes === null) continue;
      points.push({ name: series.name, x: minutes, y: last });
    }
    if (points.length > 0) {
      const spec: ScatterSpec = {
        title: "Cost to stay fresh vs freshness",
        subtitle:
          `Arm: documented-sync; ${scaleParts(runOf(x2), commits)}; the walk is synthetic (one added import ` +
          "line per commit).",
        points,
        xLabel:
          commits === null
            ? "minutes of machine time to stay fresh over the walk (lower is better)"
            : `minutes of machine time to stay fresh over ${commits} commits (lower is better)`,
        yLabel: "import edge F1 vs compiler truth at the last commit",
        yMax: 1,
        highlight: "greplost",
        absent: absentTools(points.map((point) => point.name)),
        note:
          "x is X3 (the wall-clock of the child processes each tool's own commit-time mechanism started) and " +
          "y is the last point of the X2 documented-sync curve. The height of a dot is mostly import " +
          `coverage, which is X1's subject; X2 is the fall, and it is in the hero chart.${QUADRANT_NOTE}` +
          `${scaleNote(runOf(x2), commits)}${SYNTHETIC_WALK_NOTE}`,
      };
      charts.push({
        caption: "Cost to stay fresh against freshness, one dot per tool",
        body: "",
        bodyNote:
          "Mermaid's `xychart-beta` has no scatter form, so this quadrant has no inline fence: the numbers " +
          "behind it are the X2 and X3 rows of the table above.",
        png: `${assetsRel}/x-quadrant-freshness.png`,
        svg: scatterChart(spec),
      });
    }
  }

  const x1 = byId.get("X1");
  const x6 = byId.get("X6");
  if (x1 !== undefined && x6 !== undefined) {
    const points: ScatterPoint[] = [];
    for (const tool of toolsOf(x1)) {
      const accuracy = f1(detailOf(x1, tool, "callPrecision"), detailOf(x1, tool, "callRecall"));
      const seconds = detailOf(x6, tool, "seconds");
      if (accuracy === null || seconds === null) continue;
      points.push({ name: tool, x: seconds, y: accuracy });
    }
    if (points.length > 0) {
      const spec: ScatterSpec = {
        title: "Cold start vs call graph accuracy",
        subtitle:
          `Arm: no-LLM path, every confidence; ${scaleParts(runOf(x1), null)}; cold start is the median of ` +
          "the timed runs.",
        points,
        xLabel: "seconds from a fresh checkout to a first usable map (lower is better)",
        yLabel: "call edge F1 vs compiler truth",
        highlight: "greplost",
        absent: absentTools(points.map((point) => point.name)),
        note:
          "y is the harmonic mean of the call edge precision and recall each cell carries, computed from " +
          "those two numbers and not measured separately; x is X6, timed from a fresh copy of the repo with " +
          `no cache and no artifact.${QUADRANT_NOTE}${scaleNote(runOf(x1), null)}`,
      };
      charts.push({
        caption: "Cold start against call graph accuracy, one dot per tool",
        body: "",
        bodyNote:
          "Mermaid's `xychart-beta` has no scatter form, so this quadrant has no inline fence: the numbers " +
          "behind it are the X1 and X6 rows of the table above.",
        png: `${assetsRel}/x-quadrant-accuracy.png`,
        svg: scatterChart(spec),
      });
    }
  }

  return charts;
}

/** The last commit index any arm of an X2 row carries a point for. */
function walkLength(x2: MetricRow | undefined): number | null {
  if (x2 === undefined) return null;
  let last: number | null = null;
  for (const cell of Object.values(x2.tools)) {
    const commits = cell.detail?.["commits"];
    if (typeof commits === "number" && commits > 0) return commits;
    for (const key of Object.keys(cell.detail ?? {})) {
      const at = /@(\d+)$/.exec(key);
      if (at === null) continue;
      const index = Number(at[1]);
      if (Number.isFinite(index)) last = last === null ? index : Math.max(last, index);
    }
  }
  return last;
}

/**
 * The hero chart (tech spec 10.9, capture #9) and its companions.
 *
 * The hero is produced unconditionally — with every line, with one, or with
 * none — because the README leads with it and a missing file there is a broken
 * page, not an absent measurement. What is missing is said in the caption and
 * in the chart's own note, never drawn as a zero.
 *
 * One chart per arm the payload carries, because conflating them would be the
 * most flattering possible mistake:
 *
 *   x2-staleness.png              the documented-sync arm: each tool's own
 *                                 mechanism installed and left to fire (hero)
 *   x2-no-refresh.png             each tool's commit-0 artifact against later
 *                                 truth — the curve that actually decays
 *   x2-refresh-every-commit.png   the harness driving every refresh by hand,
 *                                 which is an accuracy comparison, not decay
 *
 * When no walk was run at all, the hero falls back to the replay suite's flat
 * F1 and says so; the companions are omitted rather than invented.
 */
export function stalenessCharts(
  x2: MetricRow | undefined,
  replay: Payload | null,
  assetsRel: string,
  target: RunTarget | undefined,
): ChartRef[] {
  const charts: ChartRef[] = [];
  const commits = walkLength(x2) ?? target?.commits ?? null;
  const scale = scaleNote(target, commits);
  const drawn = new Set<string>();

  for (const arm of ARMS) {
    if (drawn.has(arm.slug)) continue;
    const curve = curveFrom(x2, arm.prefix);
    if (curve === null || curve.series.length === 0) continue;
    drawn.add(arm.slug);
    const absent = absentTools(curve.series.map((s) => s.name)).filter((tool) => tool !== "greplost");
    // Only the hero carries the coverage-versus-decay sentence: it is the chart
    // a README reader meets first, and without it a line at 0.13 reads as eight
    // times staler than one at 1.0 when the two started that far apart.
    const freshness = arm.slug === "x2-staleness" ? freshnessNote(x2, curve) : "";
    const spec: ChartSpec = {
      title: arm.title,
      subtitle:
        `Arm: ${arm.arm}; ${scaleParts(target, commits)}; the walk is synthetic (one added import line per ` +
        "commit). Read the fall of a line, not its height.",
      xLabel: "commit index",
      yLabel: "F1 vs compiler truth",
      yMax: 1,
      highlight: "greplost",
      categories: curve.categories,
      series: curve.series,
      absent,
      note:
        `${arm.note}${freshness}${absent.length === 0 ? "" : ` Omitted (not run here): ${absent.join(", ")}.`}` +
        `${scale}${SYNTHETIC_WALK_NOTE}`,
    };
    charts.push(chartRef(arm.caption, spec, arm.slug, assetsRel, lineChart(spec)));
  }

  if (!drawn.has("x2-staleness")) {
    // No walk: the replay suite's own catch rate, drawn flat across its commit
    // count, which is what a 1.0 catch rate means and nothing more.
    let categories: string[] = ["0"];
    let series: { name: string; values: (number | null)[] }[] = [];
    let subtitle = "No walk has been run yet.";
    let note =
      "Nothing measured yet: no `headtohead --commits <n>` walk and no replay result, so this plot is " +
      "empty rather than flat at 1.0.";
    if (replay !== null) {
      const walked = firstNum(replay.data, ["commits", "summary.commits", "commitCount"]);
      const f1Value = replayF1(replay);
      if (walked !== null && f1Value !== null) {
        const points = 5;
        categories = Array.from({ length: points }, (_, i) => String(Math.round((walked * i) / (points - 1))));
        series = [{ name: "greplost", values: categories.map(() => f1Value) }];
        subtitle = `Arm: none; the replay suite's \`verify\` catch rate over ${walked} commits, drawn flat.`;
        note =
          "Arm: none — no per-tool walk has been run (`bench headtohead --commits <n>`), so this is the " +
          `replay suite's \`verify\` catch rate drawn flat across its ${walked} commits.`;
      }
    }
    const spec: ChartSpec = {
      title: "X2 staleness decay under change",
      subtitle,
      xLabel: "commit index",
      yLabel: "F1 vs compiler truth",
      yMax: 1,
      highlight: "greplost",
      categories,
      series,
      absent: absentTools(series.map((one) => one.name)).filter((tool) => tool !== "greplost"),
      note: `${note}${scaleNote(target, null)}`,
    };
    charts.unshift(
      chartRef(
        series.length === 0
          ? "X2 (hero chart): no staleness walk and no replay result yet"
          : "X2 (hero chart): greplost only, from the replay suite's catch rate",
        spec,
        "x2-staleness",
        assetsRel,
        lineChart(spec),
      ),
    );
  }
  return charts;
}

/**
 * ` At commit 0: greplost 1.000, graphify 0.131, crg 0.896. Over the walk they
 * lost 0.000, 0.006 and -0.001 …`
 *
 * The numbers a reader needs to separate the two things the chart shows: where
 * each tool starts (coverage) and how far it falls (staleness). Built from the
 * X2 row's own detail, so it cannot disagree with the plotted points.
 */
export function freshnessNote(
  x2: MetricRow | undefined,
  curve: { categories: string[]; series: { name: string; values: (number | null)[] }[] },
): string {
  if (x2 === undefined) return "";
  const zero = curve.categories.indexOf("0");
  const starts: string[] = [];
  const falls: string[] = [];
  for (const series of curve.series) {
    const at0 = zero === -1 ? (x2.tools[series.name]?.detail?.["freshF1"] ?? null) : (series.values[zero] ?? null);
    const decay = x2.tools[series.name]?.detail?.["decay"] ?? null;
    if (at0 === null) continue;
    starts.push(`${series.name} ${at0.toFixed(3)}`);
    // Signed the way the table's `decay` column is signed — F1 at commit 0
    // minus F1 at the last commit — so the chart and the row cannot appear to
    // disagree about which way a tool moved.
    if (decay !== null) falls.push(`${series.name} ${decay > 0 ? "+" : ""}${decay.toFixed(3)}`);
  }
  if (starts.length === 0) return "";
  return (
    ` At commit 0 the freshly built artifacts scored ${starts.join(", ")}` +
    (falls.length === 0
      ? "."
      : `; over the walk their decay (F1 at commit 0 minus F1 at the last commit) was ${falls.join(", ")}, ` +
        "a negative decay being ground gained.") +
    " The distance between the lines is mostly that starting difference, which is coverage and belongs to X1;" +
    " the staleness X2 measures is the movement."
  );
}

/**
 * The `<prefix>@<commit>` series a head-to-head X2 cell carries in its detail,
 * one arm per prefix (see `ARMS`).
 */
function curveFrom(
  x2: MetricRow | undefined,
  prefix: string,
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

/**
 * The single-series bar chart of greplost's own structural scores (S1 to S4).
 *
 * One tool, one colour, no legend: the categories are the metrics, and a hue
 * per bar would spend the identity channel on something the labels already say.
 * Sorted descending like every other bar chart here, which puts the one score
 * that is not at the ceiling at the end where it is read.
 */
export function structuralAccuracyChart(
  repo: string,
  files: number | null,
  scores: { id: string; label: string; value: number | null }[],
  assetsRel: string,
): ChartRef | null {
  if (!scores.some((score) => score.value !== null)) return null;
  const spec: ChartSpec = sortDesc({
    title: "S1 to S4: greplost against compiler truth",
    subtitle:
      `Precision, recall and cycle agreement on ${repo}${files === null ? "" : ` (${displayValue(files)} files)`}; ` +
      "higher is better.",
    yLabel: "score vs compiler truth",
    yMax: 1,
    categories: scores.map((score) => score.label),
    series: [{ name: "greplost", values: scores.map((score) => score.value) }],
    note:
      "greplost only: these are the single-tool gates of tech spec section 3, not a comparison. S3 is the " +
      "confidence=high arm, which is the gate; the all-confidence arm is in the table. A dashed stub is a " +
      "score the payload did not carry.",
  });
  return chartRef(
    "S1 to S4 against compiler truth (greplost only)",
    spec,
    "s-accuracy",
    assetsRel,
    barChart(spec),
    "bar",
  );
}

export function chartRef(
  caption: string,
  spec: ChartSpec,
  name: string,
  assetsRel: string,
  svg: string,
  kind: "line" | "bar" = "line",
): ChartRef {
  return { caption, body: mermaidXy(spec, kind), png: `${assetsRel}/${name}.png`, svg };
}
