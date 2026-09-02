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
const ARMS: readonly { prefix: string; slug: string; title: string; caption: string; note: string }[] = [
  {
    prefix: "syncF1",
    slug: "x2-staleness",
    title: "Freshness under each tool's own sync mechanism: F1 vs commit",
    caption: "X2 (hero chart): freshness under each tool's own sync mechanism, F1 vs commit",
    note:
      "Arm: documented-sync — each tool's sync mechanism was installed exactly as its README describes and " +
      "then left alone; the harness only commits. This is the arm tech spec 10.0 X2 words. Read the FALL of " +
      "each line, not its height: the height is that tool's import coverage (X1's subject) and only the fall " +
      "is staleness.",
  },
  {
    prefix: "refreshF1",
    slug: "x2-refresh-every-commit",
    title: "X2 artifact F1 with every refresh invoked by hand",
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
    caption: "X2 companion: artifact F1 when the harness invokes every tool's refresh after every commit",
    note:
      "Arm: refresh-every-commit (a payload written before the arms were named apart) — the harness invoked " +
      "each tool's documented refresh after every commit, so no line decays and this is not a staleness curve.",
  },
  {
    prefix: "staleF1",
    slug: "x2-no-refresh",
    title: "X2 staleness with no refresh",
    caption: "X2 companion: the same artifacts, never updated",
    note:
      "Arm: no-refresh — each tool's commit-0 artifact scored against truth at that commit, which is what a " +
      "reader gets when a sync mechanism is absent or silently does not fire. greplost is the only one of the " +
      "four that can report this state mechanically, through `verify`.",
  },
];

/**
 * ` Corpus: hono, tier M (618 files); walk: 100 commits.`
 *
 * Appended to every head-to-head chart's note, because a curve with no
 * denominator invites the reader to size it wrongly and these walks are short.
 */
export function scaleNote(target: RunTarget | undefined, commits: number | null): string {
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
  return parts.length === 0 ? "" : ` Measured on ${parts.join("; ")}.`;
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
      note: `A dashed stub is a tool that could not be run; see the reason column.${scaleNote(runOf(x1), null)}`,
    };
    if (spec.series.some((s) => s.values.some((v) => v !== null))) {
      charts.push(chartRef("X1 precision per tool per edge kind", spec, "x1-precision", assetsRel, groupedBarChart(spec), "bar"));
    }
  }

  const x3 = byId.get("X3");
  if (x3 !== undefined) {
    const tools = Object.keys(x3.tools);
    const x3Run = runOf(x3);
    const commits = walkLength(x3) ?? x3Run?.commits ?? null;
    const spec: ChartSpec = {
      title: "X3 cost to stay fresh",
      yLabel: commits === null ? "USD over the walk" : `USD over ${commits} commits`,
      categories: tools,
      series: [{ name: "USD", values: tools.map((t) => x3.tools[t]?.detail?.["usd"] ?? num(x3.tools[t]?.value ?? null)) }],
      note:
        "Every tool that ran here ran its no-LLM path, so USD is 0 for all of them; the wall-clock that " +
        `separates them is in the table.${scaleNote(x3Run, commits)}`,
    };
    if (spec.series.some((s) => s.values.some((v) => v !== null))) {
      charts.push(chartRef("X3 cost per tool", spec, "x3-cost", assetsRel, groupedBarChart(spec), "bar"));
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
    const absent = ["graphify", "ua", "crg"].filter((tool) => !curve.series.some((s) => s.name === tool));
    // Only the hero carries the coverage-versus-decay sentence: it is the chart
    // a README reader meets first, and without it a line at 0.13 reads as eight
    // times staler than one at 1.0 when the two started that far apart.
    const freshness = arm.slug === "x2-staleness" ? freshnessNote(x2, curve) : "";
    const spec: ChartSpec = {
      title: arm.title,
      xLabel: "commit index",
      yLabel: "F1 vs compiler truth",
      yMax: 1,
      categories: curve.categories,
      series: curve.series,
      note: `${arm.note}${freshness}${absent.length === 0 ? "" : ` Omitted (not run here): ${absent.join(", ")}.`}${scale}`,
    };
    charts.push(chartRef(arm.caption, spec, arm.slug, assetsRel, lineChart(spec)));
  }

  if (!drawn.has("x2-staleness")) {
    // No walk: the replay suite's own catch rate, drawn flat across its commit
    // count, which is what a 1.0 catch rate means and nothing more.
    let categories: string[] = ["0"];
    let series: { name: string; values: (number | null)[] }[] = [];
    let note =
      "Nothing measured yet: no `headtohead --commits <n>` walk and no replay result, so this plot is " +
      "empty rather than flat at 1.0.";
    if (replay !== null) {
      const walked = firstNum(replay.data, ["commits", "summary.commits", "commitCount"]);
      const f1 = replayF1(replay);
      if (walked !== null && f1 !== null) {
        const points = 5;
        categories = Array.from({ length: points }, (_, i) => String(Math.round((walked * i) / (points - 1))));
        series = [{ name: "greplost", values: categories.map(() => f1) }];
        note =
          "Arm: none — no per-tool walk has been run (`bench headtohead --commits <n>`), so this is the " +
          `replay suite's \`verify\` catch rate drawn flat across its ${walked} commits.`;
      }
    }
    const spec: ChartSpec = {
      title: "X2 staleness decay under change",
      xLabel: "commit index",
      yLabel: "F1 vs compiler truth",
      yMax: 1,
      categories,
      series,
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
    if (decay !== null) falls.push(`${series.name} ${decay > 0 ? "-" : "+"}${Math.abs(decay).toFixed(3)}`);
  }
  if (starts.length === 0) return "";
  return (
    ` At commit 0 the freshly built artifacts scored ${starts.join(", ")}` +
    (falls.length === 0 ? "." : `; over the walk they moved ${falls.join(", ")}.`) +
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
