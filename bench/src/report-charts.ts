/**
 * The charts `RESULTS.md` carries (tech spec 10.9; bench leaf 1.5.7).
 *
 * Each builder turns already-read numbers into a `ChartRef`: a caption, an
 * inline `xychart-beta` fence and the SVG `report.ts` rasterises into
 * `docs/assets/`. Kept apart from the section builders because a chart has one
 * obligation the tables do not — it must not draw a measurement that was never
 * taken. A missing tool is a gap or an omitted category, never a zero, and every
 * chart's note names the arm, the corpus and the walk length it came from.
 */
import { groupedBarChart, lineChart, mermaidXy, type ChartSpec } from "./charts.ts";
import type { ChartRef, MetricRow } from "./results-md.ts";
import { firstNum, num, replayF1, type Payload } from "./report-payload.ts";


export function headToHeadCharts(rows: readonly MetricRow[], replay: Payload | null, assetsRel: string): ChartRef[] {
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
export function stalenessCharts(x2: MetricRow | undefined, replay: Payload | null, assetsRel: string): ChartRef[] {
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
