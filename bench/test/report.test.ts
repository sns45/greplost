/**
 * Head-to-head, charts, RESULTS.md and screenshots (bench leaf 1.5.7, gates G1 to G9).
 *
 * Gate CHECK lines filter on describe names, so the charts block is named exactly
 * `charts`. Every other block is ungated but counts toward G1
 * (`bun test bench/test/report.test.ts`).
 *
 * Nothing here writes into `bench/results/`, `bench/RESULTS.md` or `docs/assets/`:
 * every test that drives a suite end to end points it at a temp directory
 * (`GREPLOST_BENCH_RESULTS_DIR` for reads, `--out`/`--assets` for writes), because a
 * test run must never change a committed artifact.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  axisMax,
  barChart,
  boxChart,
  categoryOffsets,
  displayValue,
  groupedBarChart,
  lineChart,
  logScaleFor,
  mermaidXy,
  MERMAID_DARK_INIT,
  PALETTE,
  paretoFrontier,
  pngChunks,
  scatterChart,
  sortDesc,
  sortSeriesDesc,
  stripPngMetadata,
  toPng,
  TOOL_COLORS,
  wrapText,
  writeChart,
} from "../src/charts.ts";
import { renderResultsMd, SECTION_HEADERS, X_IDS, provenanceLine, scopeTarget } from "../src/results-md.ts";
import { buildModel, run as reportRun } from "../src/report.ts";
import {
  METRIC_PLAN,
  TOOLS,
  byteDistance,
  decayReason,
  describeDifference,
  decayVerdict,
  describeFreshness,
  describeLineChange,
  diffLineCount,
  emptyMetrics,
  fillMissingReasons,
  median,
  planImportEdits,
  needsCorpus,
  readHookLog,
  resultSuite as headtoheadResultSuite,
  run as headtoheadRun,
  scaleTitles,
  shimRuns,
  shimTime,
  signed,
  syncEvidence,
  verdictFor,
  x3GreplostVerdict,
} from "../src/headtohead.ts";
import { stalenessCharts, scaleNote, freshnessNote } from "../src/report-charts.ts";
import { latestResult, writeResult } from "../src/results-io.ts";
import { CAPTURES, checkTools, fitForCapture, run as screenshotsRun, x4Summary } from "../src/screenshots.ts";
import { checkMermaid } from "../src/mermaid-check.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

/**
 * A chart's note, read back out of the SVG with the line wrapping undone.
 *
 * `startFrame` wraps the note into one `<text font-size="10">` per line, so a phrase
 * that happens to straddle a wrap is not findable in the raw markup.
 */
function svgNote(svg: string): string {
  return [...svg.matchAll(/<text[^>]*font-size="10"[^>]*>([^<]*)<\/text>/g)]
    .map((match) => match[1] ?? "")
    .join(" ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-${prefix}-`));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// charts (gate G2)
// ---------------------------------------------------------------------------

/**
 * The fixed dataset every chart test renders. Small on purpose: the golden below is
 * read by humans reviewing a determinism change, so it has to fit on a screen.
 */
const FIXED_BARS = {
  title: "X1 import precision",
  yLabel: "precision",
  categories: ["greplost", "graphify", "crg"],
  series: [{ name: "imports", values: [1, 0.8, 0.5] }],
} as const;

/**
 * Golden SVG for `FIXED_BARS`, inline so a determinism change is visible in the test
 * diff itself. Regenerate only on a deliberate renderer change (tech spec 10.9,
 * "deterministic, seed-free"): print `barChart(FIXED_BARS)` and paste it here.
 *
 * Re-baselined once, deliberately, when the charts were restyled onto the black
 * Artificial Analysis surface (1200px wide, dotted gridlines, no plot frame, one
 * hue per tool rather than per row, values inside the bars). Everything the old
 * golden locked is still locked: the same three bars, the same values, the same
 * `coord()` rounding, and no id, clock or random anywhere in the markup.
 */
const GOLDEN_BAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="620" viewBox="0 0 1200 620" font-family="system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="12">
<rect x="0" y="0" width="1200" height="620" fill="#000000"/>
<rect x="0.5" y="0.5" width="1199" height="619" fill="none" stroke="#262626"/>
<text x="32" y="40" font-size="20" font-weight="600" fill="#FFFFFF">X1 import precision</text>
<text x="1168" y="40" font-size="11" fill="#8A8983" text-anchor="end">greplost bench · bench/RESULTS.md</text>
<line x1="84" y1="516" x2="1160" y2="516" stroke="#262626" stroke-dasharray="2 4"/>
<text x="74" y="520" fill="#8A8983" font-size="11" text-anchor="end">0</text>
<line x1="84" y1="418.5" x2="1160" y2="418.5" stroke="#262626" stroke-dasharray="2 4"/>
<text x="74" y="422.5" fill="#8A8983" font-size="11" text-anchor="end">0.25</text>
<line x1="84" y1="321" x2="1160" y2="321" stroke="#262626" stroke-dasharray="2 4"/>
<text x="74" y="325" fill="#8A8983" font-size="11" text-anchor="end">0.5</text>
<line x1="84" y1="223.5" x2="1160" y2="223.5" stroke="#262626" stroke-dasharray="2 4"/>
<text x="74" y="227.5" fill="#8A8983" font-size="11" text-anchor="end">0.75</text>
<line x1="84" y1="126" x2="1160" y2="126" stroke="#262626" stroke-dasharray="2 4"/>
<text x="74" y="130" fill="#8A8983" font-size="11" text-anchor="end">1</text>
<line x1="84" y1="516" x2="1160" y2="516" stroke="#3A3A3A"/>
<text x="24" y="321" fill="#C3C2B7" font-size="11" text-anchor="middle" transform="rotate(-90 24 321)">precision</text>
<path d="M 228.33 516 L 228.33 130 Q 228.33 126 232.33 126 L 294.33 126 Q 298.33 126 298.33 130 L 298.33 516 Z" fill="#0fa976"/>
<text x="263.33" y="504" fill="#FFFFFF" font-size="12" font-weight="600" text-anchor="middle">1</text>
<text x="263.33" y="538" fill="#C3C2B7" font-size="12" text-anchor="middle">greplost</text>
<path d="M 587 516 L 587 208 Q 587 204 591 204 L 653 204 Q 657 204 657 208 L 657 516 Z" fill="#e0561c"/>
<text x="622" y="504" fill="#FFFFFF" font-size="12" font-weight="600" text-anchor="middle">0.8</text>
<text x="622" y="538" fill="#C3C2B7" font-size="12" text-anchor="middle">Graphify</text>
<path d="M 945.67 516 L 945.67 325 Q 945.67 321 949.67 321 L 1011.67 321 Q 1015.67 321 1015.67 325 L 1015.67 516 Z" fill="#2f86ef"/>
<text x="980.67" y="504" fill="#FFFFFF" font-size="12" font-weight="600" text-anchor="middle">0.5</text>
<text x="980.67" y="538" fill="#C3C2B7" font-size="12" text-anchor="middle">code-review-graph</text>
</svg>
`;

describe("charts", () => {
  test("a fixed dataset renders to the golden SVG", () => {
    expect(barChart(FIXED_BARS)).toBe(GOLDEN_BAR_SVG);
  });

  test("rendering twice is byte-identical (no ids, no clock, no randomness)", () => {
    expect(barChart(FIXED_BARS)).toBe(barChart(FIXED_BARS));
    expect(lineChart(FIXED_BARS)).toBe(lineChart(FIXED_BARS));
    const svg = groupedBarChart(FIXED_BARS);
    expect(svg).toBe(groupedBarChart(FIXED_BARS));
    // The two things that make an SVG non-reproducible.
    expect(svg).not.toMatch(/\bid="/);
    expect(svg).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
  });

  test("the golden SVG rasterises to a non-empty PNG", () => {
    const png = toPng(GOLDEN_BAR_SVG);
    expect(png.length).toBeGreaterThan(0);
    // PNG magic number, so "non-empty" cannot be satisfied by an error string.
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect([...toPng(GOLDEN_BAR_SVG)]).toEqual([...png]);
  });

  test("writeChart lands an SVG and a PNG of non-zero size", () => {
    const dir = tempDir("charts");
    const written = writeChart(dir, "x1-precision", barChart(FIXED_BARS));
    expect(existsSync(written.svg)).toBe(true);
    expect(existsSync(written.png)).toBe(true);
    expect(readFileSync(written.png).length).toBeGreaterThan(0);
    expect(path.basename(written.png)).toBe("x1-precision.png");
  });

  test("every chart kind renders a well-formed root element", () => {
    const svgs = [
      barChart(FIXED_BARS),
      groupedBarChart({ ...FIXED_BARS, series: [...FIXED_BARS.series, { name: "calls", values: [1, 0.4, 0.6] }] }),
      lineChart({ ...FIXED_BARS, xLabel: "commit" }),
      boxChart({
        title: "P2 incremental latency",
        yLabel: "ms",
        boxes: [{ name: "single file", low: 10, q1: 12, mid: 20, q3: 40, high: 50 }],
      }),
    ];
    for (const svg of svgs) {
      expect(svg.startsWith("<svg xmlns=")).toBe(true);
      expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
      expect(toPng(svg).length).toBeGreaterThan(0);
    }
  });

  test("a null value is a gap, not a zero", () => {
    const svg = lineChart({
      title: "X2 staleness",
      yLabel: "F1",
      categories: ["0", "25", "50"],
      series: [{ name: "greplost", values: [1, 1, 1] }, { name: "ua", values: [null, null, null] }],
    });
    // A series with no data contributes no polyline points at all.
    expect(svg.match(/<polyline/g)?.length ?? 0).toBe(1);
  });

  test("a numeric ascending x axis is plotted to scale, not evenly by slot", () => {
    // The X2 checkpoints are 0, 12, 24 … 96, 100: the last gap is 4 commits, not 12.
    // Even spacing stretched it threefold and gave every curve a slope at the end that
    // the data does not have (review round 3, minor).
    expect(categoryOffsets(["0", "12", "24", "96", "100"])).toEqual([0, 0.12, 0.24, 0.96, 1]);
    // Evenly spaced input stays evenly spaced.
    expect(categoryOffsets(["0", "25", "50", "75", "100"])).toEqual([0, 0.25, 0.5, 0.75, 1]);
    // Non-numeric, repeated or descending labels have no scale to read: even slots.
    expect(categoryOffsets(["greplost", "graphify", "crg"])).toEqual([0, 0.5, 1]);
    expect(categoryOffsets(["58", "58", "148"])).toEqual([0, 0.5, 1]);
    expect(categoryOffsets(["100", "50", "0"])).toEqual([0, 0.5, 1]);
    expect(categoryOffsets(["7"])).toEqual([0]);
    expect(categoryOffsets([])).toEqual([]);

    // And the SVG follows it: the last segment of the polyline is the short one.
    const svg = lineChart({
      title: "X2 staleness",
      yLabel: "F1",
      yMax: 1,
      categories: ["0", "50", "100", "104"],
      series: [{ name: "greplost", values: [1, 1, 1, 1] }],
    });
    const points = (/<polyline points="([^"]+)"/.exec(svg)?.[1] ?? "").split(" ").map((p) => Number(p.split(",")[0]));
    expect(points).toHaveLength(4);
    const gaps = points.slice(1).map((x, i) => x - (points[i] as number));
    // To a tenth of a pixel: every coordinate is printed through `coord()`, which
    // rounds to two decimals, so two equal gaps across a 1076px plot can differ
    // in the last printed digit.
    expect(gaps[0]).toBeCloseTo(gaps[1] as number, 1);
    expect(gaps[2] as number).toBeLessThan((gaps[0] as number) / 10);
    // Two labels that would collide print as one, and the end of the walk survives.
    expect(svg).toContain(">104<");
    expect(svg).not.toContain(">100<");
  });

  test("axisMax climbs a fixed ladder, so a new series cannot silently rescale a chart", () => {
    expect(axisMax(1)).toBe(1);
    expect(axisMax(0.987)).toBe(1);
    expect(axisMax(900)).toBe(1000);
    expect(axisMax(0)).toBe(1);
    expect(axisMax(Number.NaN)).toBe(1);
    expect(axisMax(41)).toBe(50);
  });

  test("wrapText wraps a note on whitespace and keeps every word", () => {
    const words = "one two three four five six seven".split(" ");
    const lines = wrapText(words.join(" "), 12);
    expect(lines.every((line) => line.length <= 12)).toBe(true);
    expect(lines.join(" ").split(" ")).toEqual(words);
    // A word wider than the column gets its own line rather than being cut.
    expect(wrapText("supercalifragilistic x", 5)).toEqual(["supercalifragilistic", "x"]);
  });

  test("mermaidXy omits an unmeasured category instead of drawing it at zero", () => {
    const text = mermaidXy({
      title: "X1 precision",
      yLabel: "precision",
      yMax: 1,
      categories: ["greplost", "graphify", "ua"],
      series: [{ name: "imports", values: [1, 0.5, null] }],
    });
    // Mermaid has no null, so the whole category goes rather than becoming a 0.
    expect(text).toContain('x-axis ["greplost", "graphify"]');
    expect(text).toContain("line [1, 0.5]");
    expect(text).not.toContain('"ua"');
    expect(text).toContain("%% not measured, omitted from the x axis: ua");
  });

  test("mermaidXy drops a series with an interior gap rather than shifting it", () => {
    const text = mermaidXy({
      title: "X2 staleness",
      yLabel: "F1",
      categories: ["0", "25", "50"],
      series: [{ name: "greplost", values: [1, 1, 1] }, { name: "graphify", values: [1, null, 0.4] }],
    });
    expect(text.match(/^\s+line \[/gm)?.length ?? 0).toBe(1);
    expect(text).toContain("%% omitted (no data, or a gap Mermaid cannot draw): graphify");
  });

  test("mermaidXy emits an xychart-beta fence body with one line per series", () => {
    const text = mermaidXy({
      title: "X2 staleness",
      yLabel: "F1",
      categories: ["0", "25", "50"],
      series: [{ name: "greplost", values: [1, 0.99, 0.99] }],
    });
    // The dark init directive comes first, then the diagram: a Mermaid
    // directive is only honoured before the diagram type.
    expect(text.startsWith(MERMAID_DARK_INIT)).toBe(true);
    expect(text.split("\n")[1]).toBe("xychart-beta");
    expect(text).toContain('"plotColorPalette": "#0fa976,#e0561c,#2f86ef"');
    expect(text).toContain('title "X2 staleness"');
    expect(text).toContain("x-axis");
    expect(text).toContain("y-axis");
    expect(text.match(/^\s+line \[/gm)?.length ?? 0).toBe(1);
  });

  /**
   * The palette is not a taste. It was validated against this exact surface
   * with the dataviz skill's checker before it was written into `charts.ts`:
   *
   *   node <dataviz-skill>/scripts/validate_palette.js "#0fa976,#e0561c,#2f86ef" \
   *     --mode dark --surface "#000000" --pairs all
   *
   *   Palette (dark, surface #000000, categorical): 3 slots
   *     [PASS] Lightness band         all 3 inside L 0.48-0.67
   *     [PASS] Chroma floor           all 3 >= 0.1
   *     [PASS] CVD separation         worst all-pairs #e0561c<->#0fa976 dE 9.7 (deutan) - tritan 4.7
   *     [PASS] Normal-vision floor    worst all-pairs #2f86ef<->#0fa976 dE 23.3 (normal)
   *     [PASS] Contrast vs surface    all 3 >= 3:1
   *     -> ALL CHECKS PASS
   *
   * The checker is not run from here: it lives in a skill directory that exists
   * on one machine, and a test that shells out to it would fail everywhere else.
   * What this test locks is the thing the run was about, the exact hexes, in the
   * exact order, bound to the exact tools, so a later edit to any of them has to
   * come with a new run of the command above.
   */
  test("the validated palette is the one the charts draw, bound to the tools", () => {
    expect(PALETTE).toEqual(["#0fa976", "#e0561c", "#2f86ef"]);
    expect(TOOL_COLORS).toEqual({ greplost: "#0fa976", graphify: "#e0561c", crg: "#2f86ef" });
    // Understand-Anything has never been runnable here, so it has no hue to
    // reuse and no way to appear as a mark.
    expect(Object.keys(TOOL_COLORS)).not.toContain("ua");
  });

  test("colour follows the tool, not the row: sorting does not repaint a bar", () => {
    const spec = {
      title: "X6 cold start",
      yLabel: "seconds",
      categories: ["greplost", "graphify", "crg"],
      highlight: "greplost",
      series: [{ name: "seconds", values: [0.283, 2.159, 1.207] }],
    };
    const sorted = sortDesc(spec);
    // Descending by value puts graphify first and greplost last...
    expect(sorted.categories).toEqual(["graphify", "crg", "greplost"]);
    expect(sorted.series[0]?.values).toEqual([2.159, 1.207, 0.283]);
    // ...and every tool still wears the hue it wears on every other chart.
    const svg = barChart(sorted);
    expect(svg).toContain('fill="#0fa976"');
    expect(svg).toContain('fill="#e0561c"');
    expect(svg).toContain('fill="#2f86ef"');
    // greplost keeps its anchor ring wherever the sort put it.
    expect(svg).toContain(`stroke="#FFFFFF" stroke-width="1.5"`);
  });

  test("sortDesc is stable and puts an unmeasured category last", () => {
    const sorted = sortDesc({
      title: "t",
      categories: ["a", "b", "ua", "c"],
      series: [{ name: "v", values: [1, 1, null, 2] }],
    });
    // `c` leads on value; `a` and `b` tie and keep their input order; the
    // category nobody measured is last, because n/a is not a small number.
    expect(sorted.categories).toEqual(["c", "a", "b", "ua"]);
  });

  test("sortSeriesDesc orders the series of a grouped chart, gaps last", () => {
    const sorted = sortSeriesDesc({
      title: "t",
      categories: ["call edges", "import edges"],
      series: [
        { name: "ua", values: [null, null] },
        { name: "crg", values: [0.361, 1] },
        { name: "greplost", values: [1, 1] },
      ],
    });
    expect(sorted.series.map((one) => one.name)).toEqual(["greplost", "crg", "ua"]);
  });

  test("a tool with no value gets an n/a legend entry and no mark", () => {
    const svg = lineChart({
      title: "X2 staleness",
      yLabel: "F1",
      yMax: 1,
      categories: ["0", "50", "100"],
      series: [{ name: "greplost", values: [1, 1, 1] }],
      absent: ["ua"],
    });
    expect(svg).toContain("Understand-Anything: n/a");
    // The n/a entry is muted text and a hollow ring: no hue is invented for it.
    expect(svg).toContain('fill="none" stroke="#8A8983"');
    expect(svg.match(/<polyline/g)?.length ?? 0).toBe(1);
  });

  test("a measured zero keeps ink; an unmeasured value is a dashed stub", () => {
    const svg = barChart({
      title: "X4 bytes",
      yLabel: "bytes",
      categories: ["greplost", "crg", "ua"],
      series: [{ name: "bytes", values: [0, 5160286, null] }],
    });
    // The zero is a bar of its own colour with its own label...
    expect(svg).toContain('fill="#0fa976"');
    expect(svg).toContain(">0<");
    // ...and the thousands separator is for the reader, not for Mermaid.
    expect(svg).toContain(">5,160,286<");
    // ...while "not measured" is a dashed outline and the word itself.
    expect(svg).toContain('stroke-dasharray="2 2"');
    expect(svg).toContain(">n/a<");
  });

  test("a value that will not fit inside its bar is printed above it", () => {
    // A short bar cannot hold a label: it goes above the bar's end rather than
    // being clipped by the mark it belongs to.
    const svg = barChart({
      title: "X5 lines",
      yLabel: "lines",
      yMax: 100,
      categories: ["greplost", "crg"],
      series: [{ name: "lines", values: [1, 100] }],
    });
    // Each bar's own top edge, off its path: `M x bottom L x top …`.
    const tops = [...svg.matchAll(/<path d="M [\d.]+ [\d.]+ L [\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
    const labels = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)"[^>]*font-weight="600"[^>]*>([\d.]+)<\/text>/g)];
    expect(labels.map((m) => m[2])).toEqual(["1", "100"]);
    // The short bar's value is above its own top edge; the tall bar's is inside
    // it, near the baseline. Neither is clipped by the mark it belongs to.
    expect(Number(labels[0]?.[1])).toBeLessThan(tops[0] as number);
    expect(Number(labels[1]?.[1])).toBeGreaterThan(tops[1] as number);
  });

  test("text never wears a series colour", () => {
    const svgs = [
      barChart({
        title: "X6",
        yLabel: "seconds",
        categories: ["greplost", "graphify"],
        series: [{ name: "seconds", values: [0.283, 2.159] }],
      }),
      lineChart({
        title: "X2",
        yLabel: "F1",
        yMax: 1,
        categories: ["0", "100"],
        series: [{ name: "greplost", values: [1, 1] }, { name: "crg", values: [0.9, 0.8] }],
      }),
      scatterChart({
        title: "quadrant",
        points: [{ name: "greplost", x: 0.3, y: 1 }, { name: "crg", x: 0.9, y: 0.9 }],
        xLabel: "minutes",
        yLabel: "F1",
        yMax: 1,
      }),
    ];
    for (const svg of svgs) {
      for (const element of svg.match(/<text[^>]*>/g) ?? []) {
        const fill = /fill="([^"]+)"/.exec(element)?.[1] ?? "";
        expect(PALETTE).not.toContain(fill);
      }
    }
  });

  test("logScaleFor asks for two decades and no zero", () => {
    expect(logScaleFor([1, 5160286])).toBe(true);
    expect(logScaleFor([100, 10000])).toBe(true);
    // A measured zero has no place on a log axis, and dropping it to get the
    // axis would drop the best result X4 has.
    expect(logScaleFor([0, 0, 5160286])).toBe(false);
    expect(logScaleFor([24, 54, 60])).toBe(false);
    expect(logScaleFor([1])).toBe(false);
    expect(logScaleFor([null, null])).toBe(false);
  });

  test("a log axis prints decade ticks and says so in the axis title", () => {
    const svg = barChart({
      title: "X4 bytes",
      yLabel: "bytes (log scale)",
      logY: true,
      categories: ["greplost", "crg"],
      series: [{ name: "bytes", values: [12, 5160286] }],
    });
    for (const tick of ["10", "1,000", "100,000", "10,000,000"]) expect(svg).toContain(`>${tick}<`);
    expect(svg).toContain("bytes (log scale)");
  });

  test("paretoFrontier keeps the points nothing dominates, left to right", () => {
    // Lower x is better, higher y is better.
    const points = [
      { name: "graphify", x: 2.36, y: 0.125 },
      { name: "greplost", x: 0.29, y: 1 },
      { name: "crg", x: 0.85, y: 0.897 },
    ];
    expect(paretoFrontier(points).map((p) => p.name)).toEqual(["greplost"]);
    // With no single winner, both survivors are kept in x order.
    const split = [
      { name: "cheap", x: 0.1, y: 0.4 },
      { name: "good", x: 2, y: 0.9 },
      { name: "neither", x: 2.5, y: 0.3 },
    ];
    expect(paretoFrontier(split).map((p) => p.name)).toEqual(["cheap", "good"]);
  });

  test("the quadrant scatter shades the corner under the marks and labels every dot", () => {
    const svg = scatterChart({
      title: "Cost to stay fresh vs freshness",
      subtitle: "Arm: documented-sync; corpus hono, tier M (248 files)",
      points: [
        { name: "greplost", x: 0.2987, y: 1 },
        { name: "graphify", x: 2.3648, y: 0.125 },
        { name: "crg", x: 0.8575, y: 0.897 },
      ],
      xLabel: "minutes over 100 commits (lower is better)",
      yLabel: "F1 at the last commit",
      yMax: 1,
      highlight: "greplost",
      absent: ["ua"],
      note: "the shaded corner is a reading aid",
    });
    // The wash is drawn before the first gridline, so it is behind the marks.
    const wash = svg.indexOf('fill-opacity="0.12"');
    const grid = svg.indexOf('stroke-dasharray="2 4"');
    const dot = svg.indexOf('<circle cx="');
    expect(wash).toBeGreaterThan(0);
    expect(wash).toBeLessThan(grid);
    expect(grid).toBeLessThan(svg.lastIndexOf("<circle"));
    expect(dot).toBeGreaterThan(0);
    // Every tool is named beside its own dot, and the one that was not run is
    // named in the legend instead of being drawn at zero.
    for (const name of ["greplost", "Graphify", "code-review-graph"]) expect(svg).toContain(`>${name}</text>`);
    expect(svg).toContain("Understand-Anything: n/a");
    expect(svg).toContain("Most attractive quadrant");
    expect(svg).toContain("Pareto line");
    // greplost's dot carries the white ring; the others carry the surface ring.
    expect(svg).toContain('r="5" fill="#0fa976" stroke="#FFFFFF" stroke-width="2"');
    expect(svg).toContain('r="5" fill="#2f86ef" stroke="#000000" stroke-width="2"');
    // Two runs, one file.
    expect(svg).toBe(
      scatterChart({
        title: "Cost to stay fresh vs freshness",
        subtitle: "Arm: documented-sync; corpus hono, tier M (248 files)",
        points: [
          { name: "greplost", x: 0.2987, y: 1 },
          { name: "graphify", x: 2.3648, y: 0.125 },
          { name: "crg", x: 0.8575, y: 0.897 },
        ],
        xLabel: "minutes over 100 commits (lower is better)",
        yLabel: "F1 at the last commit",
        yMax: 1,
        highlight: "greplost",
        absent: ["ua"],
        note: "the shaded corner is a reading aid",
      }),
    );
  });

  test("no scatter label is clipped by the canvas or printed on another one", () => {
    // Two tools at the same cost and almost the same score: the second label
    // cannot take the same side as the first.
    const svg = scatterChart({
      title: "collision",
      points: [
        { name: "greplost", x: 1, y: 0.5 },
        { name: "graphify", x: 1, y: 0.5 },
        // Hard against the right edge: its label has to flip to the left.
        { name: "crg", x: 2, y: 0.9 },
      ],
      xLabel: "x",
      yLabel: "y",
      yMax: 1,
    });
    const labels = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" fill="#FFFFFF" font-size="12" text-anchor="(\w+)"/g)];
    expect(labels.length).toBe(3);
    for (const [, x, , anchor] of labels) {
      const at = Number(x);
      expect(at).toBeGreaterThan(0);
      // An `end`-anchored label runs left from its x, a `start` label runs
      // right: either way it has to have landed inside the canvas.
      expect(anchor === "end" ? at : at + 120).toBeLessThan(1200);
    }
    // The two coincident dots did not both take the right-hand side.
    expect(new Set(labels.map((match) => match[3])).size).toBeGreaterThan(1);
  });

  test("every chart is 1200px wide with a hairline inner border", () => {
    const svgs = [
      barChart(FIXED_BARS),
      groupedBarChart({ ...FIXED_BARS, series: [...FIXED_BARS.series, { name: "calls", values: [1, 0.4, 0.6] }] }),
      lineChart({ ...FIXED_BARS, xLabel: "commit" }),
      scatterChart({
        title: "quadrant",
        points: [{ name: "greplost", x: 1, y: 1 }],
        xLabel: "x",
        yLabel: "y",
        yMax: 1,
      }),
      boxChart({ title: "P2", yLabel: "ms", boxes: [{ name: "full", low: null, q1: 12, mid: 20, q3: 40, high: null }] }),
    ];
    for (const svg of svgs) {
      expect(svg).toContain('width="1200"');
      // The border is inside the image, so a black card does not bleed into
      // GitHub's black page.
      expect(svg).toContain('fill="none" stroke="#262626"/>');
      expect(svg).toContain('fill="#000000"/>');
    }
  });

  test("a rasterised PNG carries pixels and nothing else", () => {
    const png = toPng(GOLDEN_BAR_SVG);
    // No tEXt, no tIME, no eXIf: these files are committed, and a chunk that
    // says which machine drew them is a diff nobody can read.
    expect(pngChunks(png)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(png.readUInt32BE(16)).toBe(1200);
    // Well under the 250KB the README budget allows per image.
    expect(png.length).toBeLessThan(250 * 1024);
  });

  test("stripPngMetadata drops an ancillary chunk and keeps pHYs", () => {
    const png = toPng(GOLDEN_BAR_SVG);
    const insertAt = 8 + 12 + png.readUInt32BE(8);
    const chunk = (type: string, body: Buffer): Buffer => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(body.length);
      // The CRC is not recomputed: nothing downstream of a dropped chunk
      // depends on it, which is why dropping one is safe in the first place.
      return Buffer.concat([length, Buffer.from(type, "ascii"), body, Buffer.alloc(4)]);
    };
    const dirty = Buffer.concat([
      png.subarray(0, insertAt),
      chunk("tEXt", Buffer.from("Software\0resvg", "latin1")),
      chunk("pHYs", Buffer.alloc(9)),
      png.subarray(insertAt),
    ]);
    expect(pngChunks(dirty)).toEqual(["IHDR", "tEXt", "pHYs", "IDAT", "IEND"]);
    expect(pngChunks(stripPngMetadata(dirty))).toEqual(["IHDR", "pHYs", "IDAT", "IEND"]);
  });

  test("the dark init directive still parses as Mermaid", async () => {
    const fence = mermaidXy({
      title: "X2 staleness",
      xLabel: "commit index",
      yLabel: "F1 vs compiler truth",
      yMax: 1,
      categories: ["0", "50", "100"],
      series: [{ name: "greplost", values: [1, 1, 1] }, { name: "crg", values: [0.894, 0.9, 0.897] }],
    });
    const result = await checkMermaid(fence);
    // The fallback checker validates the `graph LR` subset the render package
    // emits, not an xychart, so it can only speak when mermaid itself loaded.
    if (result.checker === "mermaid") expect(result.ok).toBe(true);
  });

  test("displayValue groups digits for a reader and label() does not for Mermaid", () => {
    expect(displayValue(5160286)).toBe("5,160,286");
    expect(displayValue(0.283)).toBe("0.283");
    expect(displayValue(-1234)).toBe("-1,234");
    // The fence keeps bare digits: a comma inside an xychart series is a
    // value separator and would not parse.
    const fence = mermaidXy(
      { title: "X4", yLabel: "bytes", categories: ["crg"], series: [{ name: "bytes", values: [5160286] }] },
      "bar",
    );
    expect(fence).toContain("bar [5160286]");
    expect(fence).not.toContain("5,160,286");
  });
});

// ---------------------------------------------------------------------------
// head-to-head
// ---------------------------------------------------------------------------

describe("headtohead", () => {
  test("the metric plan covers X1 to X10 exactly once, in order", () => {
    expect(METRIC_PLAN.map((m) => m.id)).toEqual([
      "X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8", "X9", "X10",
    ]);
    for (const metric of METRIC_PLAN) {
      expect(metric.target.length).toBeGreaterThan(0);
      expect(metric.title.length).toBeGreaterThan(0);
    }
  });

  test("the tool list is greplost plus the three competitors in competitors.json order", () => {
    expect(TOOLS).toEqual(["greplost", "graphify", "ua", "crg"]);
  });

  test("an unmeasured metric is na with a reason, never a zero", () => {
    const metrics = emptyMetrics("not measured in this run");
    expect(Object.keys(metrics).length).toBe(10);
    for (const id of X_IDS) {
      const metric = metrics[id];
      expect(metric).toBeDefined();
      for (const tool of TOOLS) {
        const cell = metric?.tools[tool];
        expect(cell?.verdict).toBe("na");
        expect(cell?.value).toBe(null);
        expect((cell?.reason ?? "").length).toBeGreaterThan(0);
      }
    }
  });

  test("verdictFor compares on the metric's direction and tolerance", () => {
    // higher-is-better with a required margin (X1: +3 points on imports)
    expect(verdictFor({ ours: 1.0, theirs: 0.8, higherIsBetter: true, margin: 0.03 })).toBe("win");
    expect(verdictFor({ ours: 0.8, theirs: 1.0, higherIsBetter: true, margin: 0.03 })).toBe("loss");
    expect(verdictFor({ ours: 1.0, theirs: 0.99, higherIsBetter: true, margin: 0.03 })).toBe("tie");
    // lower-is-better (X5 artifact lines changed, X3 cost)
    expect(verdictFor({ ours: 4, theirs: 900, higherIsBetter: false, margin: 1 })).toBe("win");
    expect(verdictFor({ ours: 900, theirs: 4, higherIsBetter: false, margin: 1 })).toBe("loss");
    expect(verdictFor({ ours: 4, theirs: 4, higherIsBetter: false, margin: 1 })).toBe("tie");
    // a missing number is never a win by default
    expect(verdictFor({ ours: 1, theirs: null, higherIsBetter: true, margin: 0 })).toBe("na");
    expect(verdictFor({ ours: null, theirs: 1, higherIsBetter: true, margin: 0 })).toBe("na");
  });

  test("byteDistance trims the common prefix and suffix, so one insertion is one insertion", () => {
    // The naive position-wise count called this 6; it is 3.
    expect(byteDistance("abcdef", "abcXYZdef")).toBe(3);
    expect(byteDistance("abc", "abc")).toBe(0);
    expect(byteDistance("", "abcd")).toBe(4);
    expect(byteDistance("abcd", "")).toBe(4);
    // A wholly different file is its own length, not more.
    expect(byteDistance("aaaa", "bbbbbb")).toBe(6);
  });

  test("diffLineCount is added plus removed lines", () => {
    expect(diffLineCount(["a", "b", "c"], ["a", "b", "c"])).toBe(0);
    expect(diffLineCount(["a", "b", "c"], ["a", "x", "c"])).toBe(2);
    expect(diffLineCount(["a"], ["a", "b"])).toBe(1);
    expect(diffLineCount([], ["a", "b"])).toBe(2);
  });

  test("describeDifference names the file, the JSON keys and a timestamp", () => {
    const before = new Map([["graph.json", JSON.stringify({ nodes: [1], stamp: "2026-09-02T08:00:00", same: 1 })]]);
    const after = new Map([["graph.json", JSON.stringify({ nodes: [2], stamp: "2026-09-02T09:00:00", same: 1 })]]);
    const text = describeDifference(before, after);
    expect(text).toContain("graph.json");
    expect(text).toContain("nodes");
    expect(text).toContain("stamp");
    expect(text).not.toContain("same");
    expect(text).toContain("wall-clock timestamp");
    // Identical inputs describe nothing, rather than describing "no change".
    expect(describeDifference(before, before)).toBe("");
  });

  test("median is the middle value, and null for nothing", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(null);
  });

  test("planImportEdits returns distinct, resolvable one-line edits in a stable order", () => {
    const snapshot = {
      files: [
        { path: "src/a.ts", imports: [{ specifier: "./b", line: 1 }] },
        { path: "src/b.ts", imports: [] },
        { path: "src/c.ts", imports: [] },
      ],
      imports: [{ from: "src/a.ts", to: "src/b.ts", kind: "import", confidence: "high", specifier: "./b" }],
    } as unknown as Parameters<typeof planImportEdits>[0];
    const edits = planImportEdits(snapshot, 5);
    // Only `src/c.ts` can take `./b`: `src/a.ts` already has it and `src/b.ts` is the target.
    expect(edits).toEqual([{ file: "src/c.ts", specifier: "./b", to: "src/b.ts" }]);
    expect(planImportEdits(snapshot, 5)).toEqual(edits);
  });

  test("X3's greplost verdict is not a win against an arm nobody walked", () => {
    // The target is "<= 1% of ua, <= 20% of graphify". ua cannot be run here at
    // all, so a bare `win` claims a comparison nobody made (review round 1).
    const none = x3GreplostVerdict(0.2, null);
    expect(none.verdict).toBe("na");
    expect(none.reason).toContain("ratio");

    const under = x3GreplostVerdict(0.2, 5.4);
    expect(under.verdict).toBe("win");
    expect(under.reason).toContain("graphify arm");
    expect(under.reason).toContain("ua arm cannot be evaluated");

    const over = x3GreplostVerdict(3, 5);
    expect(over.verdict).toBe("loss");

    expect(x3GreplostVerdict(null, 5).verdict).toBe("na");
  });

  test("scaleTitles rewrites X2 and X3 from the walk that actually ran", () => {
    const metrics = emptyMetrics("not run");
    scaleTitles(metrics, 100);
    expect(metrics["X2"].title).toBe("Staleness after 100 replayed commits");
    expect(metrics["X2"].target).toContain("100 commits");
    expect(metrics["X3"].title).toContain("100 replayed commits");
    expect(metrics["X2"].tools["greplost"]?.target).toBe(metrics["X2"].target);

    const nothing = emptyMetrics("not run");
    scaleTitles(nothing, 0);
    expect(nothing["X2"].title).toBe("Staleness after no replayed commits");
    expect(nothing["X2"].target).toContain("not walked");
    expect(nothing["X2"].title).not.toContain("500");
  });

  test("the shim log is per-invocation evidence a hook ran, and for how long", () => {
    const dir = tempDir("shim-log");
    const file = path.join(dir, "hook.log");
    writeFileSync(
      file,
      [
        "start\tgreplost\t1000",
        "end\tgreplost\t1128\t0",
        "start\tcode-review-graph\t1200",
        "end\tcode-review-graph\t1900\t0",
        "start\tgreplost\t2000",
        "end\tgreplost\t2100\t0",
        "nonsense line that is not a fact",
        "start\tgreplost\t3000",
        "",
      ].join("\n"),
    );
    const calls = readHookLog(file);
    expect(shimRuns(calls, "greplost")).toEqual([128, 100]);
    expect(shimRuns(calls, "code-review-graph")).toEqual([700]);
    const ours = shimTime(calls, "greplost");
    expect(ours.ms).toBe(228);
    expect(ours.runs).toBe(3);
    // The third start has no end: a process still running is a call with no time.
    expect(ours.pending).toBe(1);
    expect(readHookLog(path.join(dir, "absent.log"))).toEqual([]);
  });

  test("describeLineChange names the artifacts and their line counts, largest first", () => {
    const before = new Map([
      ["INDEX.md", "a\nb\nc"],
      ["repo/MAP.md", "x\ny"],
      ["graph/imports.jsonl", "one"],
      ["packages/core/MAP.md", "keep"],
    ]);
    const after = new Map([
      ["INDEX.md", "a\nb\nc\nd"],
      ["repo/MAP.md", "x\ny\nz\nw\nv"],
      ["graph/imports.jsonl", "two"],
      ["packages/core/MAP.md", "keep"],
    ]);
    const text = describeLineChange(before, after);
    expect(text).toContain("`repo/MAP.md` 3 lines");
    expect(text).toContain("`INDEX.md` 1 line");
    expect(text.indexOf("repo/MAP.md")).toBeLessThan(text.indexOf("INDEX.md"));
    // Unchanged files are not named.
    expect(text).not.toContain("packages/core/MAP.md");
    // The tail is counted, never dropped.
    expect(describeLineChange(before, after, 1)).toContain("and 2 more files");
    expect(describeLineChange(before, before)).toBe("");
  });

  test("X2's verdict is decay, not the end-point, so coverage cannot pass for staleness", () => {
    // hono's real shape: graphify starts at 0.131 and ends at 0.125, greplost
    // holds 1.0. The end-point gap is eight-fold; the decay gap is 0.006.
    expect(decayVerdict(0, 0.006)).toBe("tie");
    expect(decayVerdict(0, 0.2)).toBe("win");
    expect(decayVerdict(0.2, 0)).toBe("loss");
    // Inside a hundredth of an F1 point the walk cannot tell them apart.
    expect(decayVerdict(0.001, 0.004)).toBe("tie");
    // A tool with no commit-0 point has no decay to compare.
    expect(decayVerdict(null, 0.2)).toBe("na");
    expect(decayVerdict(0, null)).toBe("na");
  });

  test("describeFreshness separates the level from the fall", () => {
    const text = describeFreshness("graphify", { at0: 0.131, atLast: 0.125, decay: 0.006 });
    expect(text).toContain("started the walk at 0.131");
    expect(text).toContain("ended at 0.125");
    expect(text).toContain("a fall of 0.006");
    expect(text).toContain("The level is coverage");
    // A line that gained ground says so rather than reporting a negative fall.
    expect(describeFreshness("crg", { at0: 0.896, atLast: 0.897, decay: -0.001 })).toContain("a rise of 0.001");
    expect(describeFreshness("greplost", { at0: 1, atLast: 1, decay: 0 })).toContain("a fall of 0.000");
    expect(describeFreshness("ua", { at0: null, atLast: null, decay: null })).toContain("decay is unknown");
    expect(signed(0.006)).toBe("+0.006");
    expect(signed(-0.001)).toBe("-0.001");
  });

  test("decayReason never says a tool `lost` ground its F1 gained", () => {
    const flat = { at0: 1, atLast: 1, decay: 0 };
    // crg's F1 rose over the walk: `lost -0.001` was the wrong verb (review round 3).
    const rose = decayReason(flat, { at0: 0.896, atLast: 0.897, decay: -0.001 }, "crg");
    expect(rose).toContain("crg gained 0.001");
    expect(rose).not.toContain("lost -");
    expect(rose).toContain("greplost held level");

    const fell = decayReason(flat, { at0: 0.131, atLast: 0.125, decay: 0.006 }, "graphify");
    expect(fell).toContain("graphify lost 0.006");

    // Both sides are always stated, whichever decayed more.
    const worse = decayReason({ at0: 1, atLast: 0.9, decay: 0.1 }, { at0: 0.9, atLast: 0.89, decay: 0.01 }, "crg");
    expect(worse).toContain("crg lost 0.01");
    expect(worse).toContain("greplost lost 0.1");

    // Nothing to compare, nothing said.
    expect(decayReason(flat, { at0: null, atLast: null, decay: null }, "ua")).toBe("");
  });

  test("every loss carries a reason, even one no metric wrote", () => {
    const metrics = emptyMetrics("not run");
    metrics["X5"].title = "Diff signal after a one-line change";
    metrics["X5"].tools["greplost"] = { value: "54 of 10511 lines", target: "<= 10", verdict: "loss", reason: "over target" };
    metrics["X5"].tools["graphify"] = { value: "24 of 99031 lines", target: "<= 10", verdict: "loss", reason: "" };
    metrics["X5"].tools["crg"] = { value: "60 of 88119 lines", target: "<= 10", verdict: "win", reason: "" };
    fillMissingReasons(metrics);
    expect(metrics["X5"].tools["graphify"]?.reason).toContain("24 of 99031 lines");
    expect(metrics["X5"].tools["graphify"]?.reason).toContain("greplost's 54 of 10511 lines");
    // A win needs no reason, and greplost's own reason is never overwritten.
    expect(metrics["X5"].tools["crg"]?.reason).toBe("");
    expect(metrics["X5"].tools["greplost"]?.reason).toBe("over target");
  });

  test("the sync evidence is per commit, so 100 of 100 is auditable", () => {
    const evidence = syncEvidence(
      new Map([
        ["greplost", {
          tool: "greplost", install: ["greplost init"], hook: ".git/hooks/post-commit",
          evidence: "shim log", automatic: true, fired: 3, walked: 4, ms: 400,
          perCommit: [
            { fired: true, ms: 100 },
            { fired: false, ms: 0 },
            { fired: true, ms: 150 },
            { fired: true, ms: 150 },
          ],
          notes: [],
        }],
      ]),
    );
    const ours = evidence[0];
    expect(ours?.firedPerCommit).toBe("1011");
    expect(ours?.msPerCommit).toEqual([100, 0, 150, 150]);
    expect(ours?.missedCommits).toEqual([2]);
    expect(ours?.fired).toBe(3);
    expect(ours?.walked).toBe(4);
  });

  test("X9 and X10 need no corpus checkout, every other metric does", () => {
    expect(needsCorpus(null)).toBe(true);
    expect(needsCorpus(new Set(["X10"]))).toBe(false);
    expect(needsCorpus(new Set(["X9", "X10"]))).toBe(false);
    expect(needsCorpus(new Set(["X9", "X10", "X4"]))).toBe(true);
    expect(needsCorpus(new Set(["X1"]))).toBe(true);
    // Nothing selected is nothing to run, and nothing to run needs no corpus.
    expect(needsCorpus(new Set())).toBe(false);
  });

  test("--metrics X10 measures the cross-repo blast radius without a corpus", async () => {
    // X10 was implemented and free, and read `n/a`: the probe asked for a `greplost
    // workspace` subcommand that by design does not exist, and the suite refused to
    // start at all without a corpus checkout (review round 3, important 5).
    const results = tempDir("x10-results");
    const work = tempDir("x10-work");
    const beforeResults = process.env["GREPLOST_BENCH_RESULTS_DIR"];
    const beforeWork = process.env["GREPLOST_BENCH_WORK_DIR"];
    process.env["GREPLOST_BENCH_RESULTS_DIR"] = results;
    process.env["GREPLOST_BENCH_WORK_DIR"] = work;
    const log = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = await headtoheadRun(["--metrics", "X10"]);
    } finally {
      console.log = log;
      if (beforeResults === undefined) delete process.env["GREPLOST_BENCH_RESULTS_DIR"];
      else process.env["GREPLOST_BENCH_RESULTS_DIR"] = beforeResults;
      if (beforeWork === undefined) delete process.env["GREPLOST_BENCH_WORK_DIR"];
      else process.env["GREPLOST_BENCH_WORK_DIR"] = beforeWork;
    }
    expect(code).toBe(0);

    const payload = latestResult("headtohead", results)?.payload as Record<string, unknown>;
    const x10 = (payload["metrics"] as Record<string, { tools: Record<string, Record<string, unknown>> }>)["X10"];
    const ours = x10?.tools["greplost"];
    expect(ours?.["value"]).toBe("works");
    expect(ours?.["verdict"]).toBe("win");
    // Measured, not asserted: the answer reached files in the *other* repository.
    const detail = ours?.["detail"] as Record<string, number>;
    expect(detail["crossRepoFiles"]).toBeGreaterThan(0);
    expect(detail["affectedFiles"]).toBeGreaterThanOrEqual(detail["crossRepoFiles"] as number);
    // A run that touched no repository records no corpus and no scale.
    expect(payload["corpus"]).toEqual([]);
    expect(payload["target"]).toEqual({});
    const method = (payload["method"] as string[]).find((line) => line.startsWith("X10 (greplost)"));
    expect(method).toContain("greplost impact");
    expect(method).toContain("crossed the repository boundary");
  }, 180_000);

  test("a fixture run writes to headtohead-fixture, so it cannot become the corpus latest", () => {
    // Review round 3, important 1: the suite wrote `--fixture` runs under the corpus
    // name, so a twelve-file fixture run on the same day at the same commit replaced the
    // published head-to-head table under it.
    expect(headtoheadResultSuite(false)).toBe("headtohead");
    expect(headtoheadResultSuite(true)).toBe("headtohead-fixture");

    const dir = tempDir("h2h-suite-name");
    writeResult(headtoheadResultSuite(false), { marker: "corpus" }, dir);
    writeResult(headtoheadResultSuite(true), { marker: "fixture" }, dir);
    expect(readdirSync(dir).some((name) => name.startsWith("headtohead-fixture-"))).toBe(true);
    expect(latestResult("headtohead", dir)?.payload["marker"]).toBe("corpus");
  });

  test("--fixture --dry-run prints the convention line and writes nothing", async () => {
    const results = tempDir("h2h-results");
    const before = process.env["GREPLOST_BENCH_RESULTS_DIR"];
    process.env["GREPLOST_BENCH_RESULTS_DIR"] = results;
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      const code = await headtoheadRun(["--fixture", "--dry-run"]);
      expect(code).toBe(0);
    } finally {
      console.log = log;
      if (before === undefined) delete process.env["GREPLOST_BENCH_RESULTS_DIR"];
      else process.env["GREPLOST_BENCH_RESULTS_DIR"] = before;
    }
    expect(lines[lines.length - 1]).toBe("headtohead: dry-run ok");
    // The plan is printed, so a dry run still shows what a real run would measure.
    for (const id of X_IDS) expect(lines.some((l) => l.includes(id))).toBe(true);
    // "without running the expensive part" includes writing a result nobody measured.
    expect(existsSync(path.join(results, "."))).toBe(true);
    expect(readdirSafe(results).length).toBe(0);
  });
});

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// RESULTS.md
// ---------------------------------------------------------------------------

describe("results-md", () => {
  test("an all-empty model still renders every 10.9 section and all ten X rows", () => {
    const text = renderResultsMd(buildModel({ resultsDir: tempDir("empty-results") }));
    for (const header of SECTION_HEADERS) {
      expect(text.split("\n").filter((l) => l === `## ${header}`).length).toBe(1);
    }
    for (const id of X_IDS) {
      expect(text.split("\n").filter((l) => l.startsWith(`| ${id} `)).length).toBe(1);
    }
    expect(text).toContain("not run");
  });

  test("the measured column comes from the payload, never from a literal", () => {
    const dir = tempDir("one-result");
    writeFileSync(
      path.join(dir, "structural-2026-09-02-abc1234.json"),
      JSON.stringify({
        suite: "structural",
        date: "2026-09-02",
        greplostSha: "abc1234",
        corpus: [{ name: "tiny-ts" }],
        truth: { notes: ["workspace-entry-mapping"] },
        repos: {
          "tiny-ts": {
            files: 12,
            S1: { precision: 0.987, recall: 0.912, f1: 0.948, tp: 10, fp: 1, fn: 1 },
            S2: { precision: 1, recall: 1, f1: 1, tp: 4, fp: 0, fn: 0 },
            S3: { precision: 1, recall: 0.5, f1: 0.667, tp: 2, fp: 0, fn: 2 },
            S4: 1,
          },
        },
      }),
    );
    const text = renderResultsMd(buildModel({ resultsDir: dir }));
    expect(text).toContain("0.987");
    expect(text).toContain("0.912");
    // Truth notes are disclosed under Eval 1 (Appendix C ruling on 10.3).
    expect(text).toContain("workspace-entry-mapping");
    // A suite with no result still says so rather than inventing a number.
    expect(text).toMatch(/## Eval 2[\s\S]*not run/);
  });

  test("every truth note RESULTS.md can print carries its own gloss", () => {
    const dir = tempDir("truth-notes");
    writeFileSync(
      path.join(dir, "structural-2026-09-02-abc1234.json"),
      JSON.stringify({
        suite: "structural",
        date: "2026-09-02",
        greplostSha: "abc1234",
        corpus: [{ name: "tanstack-start" }],
        truth: { notes: ["workspace-entry-mapping", "nearest-tsconfig-resolution"] },
        repos: { "tanstack-start": { files: 389, S4: 1 } },
      }),
    );
    const text = renderResultsMd(buildModel({ resultsDir: dir }));
    // A note without a gloss is printed with the "no gloss for it" pointer; a disclosed
    // emulation must not reach RESULTS.md that way (leaf 2.3 review, Important 2).
    expect(text).toContain("nearest-tsconfig-resolution");
    expect(text).toContain("nearest `tsconfig.json`");
    expect(text).not.toContain("no gloss for it");
  });

  test("provenanceLine names the corpus, the file count and the walk length", () => {
    expect(
      provenanceLine("2026-09-02", "ac3bcd1", { repo: "tiny-ts", fixture: true, files: 12, commits: 24 }),
    ).toBe("Measured 2026-09-02 at ac3bcd1 on fixtures/tiny-ts (12 files, 24 commits).");
    expect(
      provenanceLine("2026-09-02", "ac3bcd1", { repo: "hono", fixture: false, tier: "M", files: 618, commits: 100 }),
    ).toBe("Measured 2026-09-02 at ac3bcd1 on hono, tier M (618 files, 100 commits).");
    // No walk, no commit count invented.
    expect(provenanceLine("2026-09-02", "ac3bcd1", { repo: "anyq", fixture: false, tier: "S", files: 148 })).toBe(
      "Measured 2026-09-02 at ac3bcd1 on anyq, tier S (148 files).",
    );
    // `commits: 0` means no walk was asked for, not a walk of length zero.
    expect(provenanceLine("2026-09-02", "ac3bcd1", { repo: "anyq", fixture: false, tier: "S", files: 148, commits: 0 })).toBe(
      "Measured 2026-09-02 at ac3bcd1 on anyq, tier S (148 files).",
    );
    expect(provenanceLine("2026-09-02", "ac3bcd1", undefined)).toBe("Measured 2026-09-02 at ac3bcd1.");
  });

  test("a tier-scoped target is not printed verbatim against a run at another scale", () => {
    const tierM = "<= 5s and $0 (tier M)";
    // The run that earned it keeps it.
    expect(scopeTarget(tierM, { repo: "hono", fixture: false, tier: "M" })).toBe(tierM);
    // A fixture run says so instead of implying a tier-M result.
    expect(scopeTarget(tierM, { repo: "tiny-ts", fixture: true })).toBe(
      "<= 5s and $0 (measured on fixtures/tiny-ts, not tier M)",
    );
    expect(scopeTarget(tierM, { repo: "anyq", fixture: false, tier: "S" })).toBe(
      "<= 5s and $0 (measured on anyq, tier S, not tier M)",
    );
    // A target with no tier clause is untouched.
    expect(scopeTarget("0 bytes differ", { repo: "tiny-ts", fixture: true })).toBe("0 bytes differ");
  });

  test("a file-scoped target is not printed verbatim against a run at another scale", () => {
    // P1's scale claim lives in the metric column, P3's in both; either way the
    // target the reader compares against has to carry what was measured.
    expect(scopeTarget("<= 1s / <= 10s", { repo: "anyq", fixture: false, tier: "S", files: 148 }, "full build, 1k / 10k files"))
      .toBe("<= 1s / <= 10s (measured on anyq, tier S, 148 files)");
    expect(scopeTarget("<= 500MB (reported)", { repo: "anyq", fixture: false, tier: "S", files: 148 }, "peak RSS at 10k files"))
      .toBe("<= 500MB (reported) (measured on anyq, tier S, 148 files)");
    // A run that reached the largest scale the text names earned the target as
    // written; one between the two named scales has still not earned the 10k
    // half, so it is qualified.
    expect(scopeTarget("<= 1s / <= 10s", { repo: "grafana", fixture: false, tier: "L", files: 12_000 }, "full build, 1k / 10k files"))
      .toBe("<= 1s / <= 10s");
    expect(scopeTarget("<= 1s / <= 10s", { repo: "vite", fixture: false, tier: "L", files: 4200 }, "full build, 1k / 10k files"))
      .toBe("<= 1s / <= 10s (measured on vite, tier L, 4200 files)");
    // No scale named, or no file count known: untouched.
    expect(scopeTarget("0 bytes differ", { repo: "anyq", fixture: false, files: 148 })).toBe("0 bytes differ");
    expect(scopeTarget("<= 1s / <= 10s", undefined, "full build, 1k / 10k files")).toBe("<= 1s / <= 10s");
  });

  test("the Single-tool P rows carry the scale they were measured at", () => {
    const dir = tempDir("single-tool-scale");
    writeFileSync(
      path.join(dir, "perf-2026-09-02-abc1234.json"),
      JSON.stringify({
        suite: "perf", date: "2026-09-02", greplostSha: "abc1234",
        corpus: [{ name: "anyq" }],
        repos: [{
          name: "anyq",
          files: 148,
          scenarios: [
            { scenario: "full", ms: { p50: 203, p95: 216 }, peakRssBytes: 241_000_000 },
            { scenario: "incremental-1", ms: { p50: 131, p95: 145 }, peakRssBytes: 147_000_000 },
          ],
        }],
      }),
    );
    const text = renderResultsMd(buildModel({ resultsDir: dir }));
    const single = text.slice(text.indexOf("## Single-tool"), text.indexOf("## Eval 1"));
    const p1 = single.split("\n").find((line) => line.startsWith("| P1 "));
    const p3 = single.split("\n").find((line) => line.startsWith("| P3 "));
    expect(p1).toContain("measured on anyq, tier S, 148 files");
    expect(p3).toContain("measured on anyq, tier S, 148 files");
    // The measurement itself is untouched; only the target is qualified.
    expect(p1).toContain("203 ms (p50)");
  });

  test("a fixture-shaped X2 payload renders decay, not the end-point gap", () => {
    const dir = tempDir("x2-decay-payload");
    const series = (at0: number, mid: number, last: number, decay: number) => ({
      value: `decay ${decay >= 0 ? "+" : ""}${decay} (${at0} to ${last})`,
      target: "greplost F1 >= 0.99 after 24 commits",
      verdict: "tie",
      reason: "",
      detail: { "syncF1@0": at0, "syncF1@12": mid, "syncF1@24": last, freshF1: at0, decay, finalF1: last },
    });
    writeFileSync(
      path.join(dir, "headtohead-2026-09-02-fix1234.json"),
      JSON.stringify({
        suite: "headtohead", date: "2026-09-02", greplostSha: "fix1234",
        tools: ["greplost", "graphify", "ua", "crg"],
        target: { repo: "tiny-ts", fixture: true, files: 12, commits: 24 },
        metrics: {
          X2: {
            id: "X2",
            title: "Staleness after 24 replayed commits",
            target: "greplost F1 >= 0.99 after 24 commits",
            tools: {
              greplost: {
                value: 1, target: "greplost F1 >= 0.99 after 24 commits", verdict: "win",
                reason: "greplost started the walk at 1.000 import F1 and ended at 1.000, a fall of 0.000",
                detail: { "syncF1@0": 1, "syncF1@12": 1, "syncF1@24": 1, freshF1: 1, decay: 0, commits: 24 },
              },
              graphify: series(0.563, 0.556, 0.571, -0.008),
              crg: series(0.813, 0.833, 0.842, -0.029),
            },
          },
        },
      }),
    );
    const text = renderResultsMd(buildModel({ resultsDir: dir }));
    const row = text.split("\n").find((line) => line.startsWith("| X2 "));
    // The cell states the fall and both absolutes, never the end-point alone.
    expect(row).toContain("decay -0.008 (0.563 to 0.571)");
    expect(row).toContain("decay -0.029 (0.813 to 0.842)");
    // greplost's own cell keeps the spec target, an absolute F1.
    expect(row).toContain("| 1 |");
    expect(row).toContain("greplost: greplost started the walk at 1.000");
    // And the hero chart opens at commit 0 with each tool's fresh artifact.
    const fence = text.slice(text.indexOf("Freshness under each tool"), text.indexOf("![X2 (hero chart)"));
    expect(fence).toContain('["0", "12", "24"]');
    expect(fence).toContain("At commit 0 the freshly built artifacts scored greplost 1.000, graphify 0.563, crg 0.813");
    expect(fence).toContain("coverage");
  });

  test("regenerating from the committed payloads is byte-identical in a fresh copy", () => {
    const committed = path.join(REPO_ROOT, "bench", "results");
    const fresh = tempDir("fresh-clone-results");
    // Copied newest-name-first, so every mtime ordering is the reverse of the
    // original's: a report that depended on write order would differ here.
    const names = readdirSync(committed).filter((name) => name.endsWith(".json")).sort().reverse();
    for (const name of names) writeFileSync(path.join(fresh, name), readFileSync(path.join(committed, name)));

    const original = renderResultsMd(buildModel({ resultsDir: committed }));
    const clone = renderResultsMd(buildModel({ resultsDir: fresh }));
    expect(clone).toBe(original);
    expect(clone.length).toBeGreaterThan(0);
  });

  test("a head-to-head payload fills the win/loss/tie columns and every loss reason", () => {
    const dir = tempDir("h2h-result");
    writeFileSync(
      path.join(dir, "headtohead-2026-09-02-abc1234.json"),
      JSON.stringify({
        suite: "headtohead",
        date: "2026-09-02",
        greplostSha: "abc1234",
        tools: ["greplost", "graphify", "ua", "crg"],
        method: ["X4: both builds ran in the same process"],
        metrics: {
          X1: {
            id: "X1",
            title: "Structural precision",
            target: ">= +10pt calls",
            tools: {
              greplost: {
                value: "calls 1 P",
                target: ">= +10pt calls",
                verdict: "tie",
                reason: "gap over the best competitor is 0 on calls",
              },
            },
          },
          X4: {
            id: "X4",
            title: "Reproducibility",
            target: "0 bytes",
            tools: {
              greplost: { value: 0, target: "0 bytes", verdict: "win", reason: "" },
              graphify: { value: 128, target: "0 bytes", verdict: "win", reason: "" },
              ua: { value: null, target: "0 bytes", verdict: "na", reason: "no headless CLI" },
              crg: { value: 900, target: "0 bytes", verdict: "loss", reason: "sqlite rowids differ" },
            },
          },
        },
      }),
    );
    const text = renderResultsMd(buildModel({ resultsDir: dir }));
    const row = text.split("\n").find((l) => l.startsWith("| X4 "));
    expect(row).toBeDefined();
    expect(row).toContain("win");
    expect(row).toContain("loss");
    expect(row).toContain("n/a");
    // The Reason column is the loss column (tech spec 10.0's publishing rule)...
    expect(row).toContain("sqlite rowids differ");
    expect(row).not.toContain("no headless CLI");
    // ...and every n/a reason is published under the table instead, once.
    expect(text).toContain("**Why a cell is n/a**");
    expect(text).toContain("X4 (ua): no headless CLI");
    // A metric the payload did not carry is still a row, and still says not run.
    expect(text.split("\n").find((l) => l.startsWith("| X7 "))).toContain("not run");
    // The method the suite recorded reaches the document, not only the JSON:
    // a head-to-head with no method is a scoreboard (tech spec 10.1).
    expect(text).toContain("X4: both builds ran in the same process");
    // greplost's own reason is published whatever its verdict: a `tie` against
    // a gap target is a miss, and the reason is why it missed.
    const x1 = text.split("\n").find((l) => l.startsWith("| X1 "));
    expect(x1).toContain("gap over the best competitor is 0");
  });

  test("the README sync contract: `## Head-to-head` and `## Single-tool`, once each", () => {
    const text = renderResultsMd(buildModel({ resultsDir: tempDir("sync-contract") }));
    const lines = text.split("\n");
    // scripts/sync-readme.ts copies exactly these two sections between markers.
    expect(lines.filter((l) => l === "## Head-to-head").length).toBe(1);
    expect(lines.filter((l) => l === "## Single-tool").length).toBe(1);
    // Head-to-head comes first, so the README reads the comparison before the
    // single-tool numbers (tech spec 11, "README structure").
    expect(lines.indexOf("## Head-to-head")).toBeLessThan(lines.indexOf("## Single-tool"));
  });

  test("the Single-tool table carries every section 3 id, with `not run` where no suite ran", () => {
    const text = renderResultsMd(buildModel({ resultsDir: tempDir("single-tool") }));
    const section = text.slice(text.indexOf("## Single-tool"), text.indexOf("## Eval 1"));
    for (const id of ["S1", "S2", "S3", "S4", "F1", "F2", "P1", "P2", "M1", "A1", "A2", "A3", "A4"]) {
      expect(section.split("\n").filter((l) => l.startsWith(`| ${id} `)).length).toBe(1);
    }
    // Never a zero for something nobody measured.
    expect(section).toContain("not run");
  });

  test("the head-to-head table carries a legend for X1's two kinds of verdict", () => {
    // The `vs <tool>` columns are call precision; greplost's own cell is both halves of
    // the 3.1 target at once, which is how a row reads `tie` beside three `win`s.
    const text = renderResultsMd(buildModel({ resultsDir: tempDir("x1-legend") }));
    const section = text.slice(text.indexOf("## Head-to-head"), text.indexOf("## Single-tool"));
    const legend = section.split("\n").find((line) => line.startsWith("> Reading the X1 row:"));
    expect(legend).toBeDefined();
    expect(legend).toContain("call edge precision");
    expect(legend).toContain("both halves");
    expect(legend).toContain("+0.10 on calls and +0.03 on imports");
    // Under the table, not above it.
    expect(section.indexOf("| X10 ")).toBeLessThan(section.indexOf("> Reading the X1 row:"));
  });

  test("the F2 note states how many comparisons it rests on", () => {
    const dir = tempDir("f2-denominator");
    writeFileSync(
      path.join(dir, "replay-2026-09-02-abc1234.json"),
      JSON.stringify({
        suite: "replay",
        date: "2026-09-02",
        greplostSha: "abc1234",
        commits: 100,
        driftCaught: 82,
        driftTotal: 82,
        f2Mismatches: 0,
        f2Checks: 1,
      }),
    );
    const note = renderResultsMd(buildModel({ resultsDir: dir }))
      .split("\n")
      .find((line) => line.startsWith("> F2 rests on"));
    // "0% divergence" over one comparison and over fifty read identically in the
    // measured column; the denominator has to be visible (review round 3, minor).
    expect(note).toContain("1 full-vs-incremental comparison over a walk of 100 commits");
    expect(note).not.toContain("comparisons over");

    // No replay at all: the note says there is nothing behind the rate, not a number.
    const empty = renderResultsMd(buildModel({ resultsDir: tempDir("f2-none") }))
      .split("\n")
      .find((line) => line.startsWith("> F2 rests on"));
    expect(empty).toContain("the replay suite has not run");
  });

  test("the two 2026-09-02 caveats are stated where they are read", () => {
    const text = renderResultsMd(buildModel({ resultsDir: tempDir("caveats") }));
    const section = text.slice(text.indexOf("## Single-tool"), text.indexOf("## Eval 1"));
    // (a) F2's comparison set.
    expect(section).toContain("listStructurePaths");
    expect(section).toContain("not the whole");
    // (b) the unparsable bucket, its row, and the upstream issue.
    expect(section).toContain("| unparsable ");
    expect(section).toContain("tree-sitter/tree-sitter-typescript/issues/335");
  });

  test("the unparsable count is read from the payload, or left n/a", () => {
    const withCount = tempDir("unparsable-yes");
    writeFileSync(
      path.join(withCount, "structural-2026-09-02-abc1234.json"),
      JSON.stringify({ suite: "structural", date: "2026-09-02", greplostSha: "abc1234", unparsable: 3, repos: {} }),
    );
    const filled = renderResultsMd(buildModel({ resultsDir: withCount }));
    expect(filled.split("\n").find((l) => l.startsWith("| unparsable "))).toContain("| 3 |");

    // The shape `structural.ts` writes: a count and the files behind it.
    const bucket = tempDir("unparsable-bucket");
    writeFileSync(
      path.join(bucket, "structural-2026-09-02-abc1234.json"),
      JSON.stringify({
        suite: "structural",
        date: "2026-09-02",
        greplostSha: "abc1234",
        repos: {},
        unparsable: {
          count: 2,
          files: [
            { repo: "hono", path: "src/types.ts", reason: "error-child" },
            { repo: "hono", path: "src/hono-base.ts", reason: "error-child" },
          ],
        },
      }),
    );
    const bucketRow = renderResultsMd(buildModel({ resultsDir: bucket }))
      .split("\n")
      .find((l) => l.startsWith("| unparsable "));
    expect(bucketRow).toContain("| 2 |");
    // Read, not derived: the payload said so.
    expect(bucketRow).not.toContain("derived");

    // Derived when the payload carries per-file truth totals: a file every one
    // of whose truth items was missed is a file nothing was extracted from.
    const derived = tempDir("unparsable-derived");
    writeFileSync(
      path.join(derived, "structural-2026-09-02-abc1234.json"),
      JSON.stringify({
        suite: "structural", date: "2026-09-02", greplostSha: "abc1234",
        repos: {
          hono: {
            perFile: {
              "src/a.ts": { truth: 12, missed: 12 },
              "src/b.ts": { truth: 40, missed: 1 },
              "src/c.ts": { truth: 3, missed: 3 },
            },
          },
        },
      }),
    );
    const derivedRow = renderResultsMd(buildModel({ resultsDir: derived }))
      .split("\n")
      .find((l) => l.startsWith("| unparsable "));
    expect(derivedRow).toContain("| 2 |");
    expect(derivedRow).toContain("derived");

    // Neither reported nor derivable: `not measured`, and no claim about why.
    const without = renderResultsMd(buildModel({ resultsDir: tempDir("unparsable-no") }));
    const row = without.split("\n").find((l) => l.startsWith("| unparsable "));
    expect(row).toContain("n/a");
    expect(row).toContain("not measured");
    expect(row).not.toContain("recovery is in progress");
  });

  test("the X2 row's target names the walk that was actually run", () => {
    const dir = tempDir("x2-title");
    writeFileSync(
      path.join(dir, "headtohead-2026-09-02-abc1234.json"),
      JSON.stringify({
        suite: "headtohead", date: "2026-09-02", greplostSha: "abc1234",
        tools: ["greplost"],
        target: { repo: "hono", fixture: false, tier: "M", files: 618, commits: 100 },
        metrics: {
          X2: {
            id: "X2",
            title: "Staleness after 100 replayed commits",
            target: "greplost F1 >= 0.99 after 100 commits",
            tools: { greplost: { value: 1, target: "greplost F1 >= 0.99 after 100 commits", verdict: "win", reason: "" } },
          },
        },
      }),
    );
    const text = renderResultsMd(buildModel({ resultsDir: dir }));
    const row = text.split("\n").find((l) => l.startsWith("| X2 "));
    expect(row).toContain("100 commits");
    expect(row).not.toContain("500");
    expect(text).toContain("100 commits");
  });

  test("two head-to-head runs fill one table, each row keeping its own corpus", () => {
    const dir = tempDir("h2h-two-runs");
    const na = (reason: string) => ({ value: null, target: "", verdict: "na", reason });
    // The corpus run: X1 measured on anyq, X2 not selected.
    writeFileSync(
      path.join(dir, "headtohead-2026-09-02-aaa1111.json"),
      JSON.stringify({
        suite: "headtohead", date: "2026-09-02", greplostSha: "aaa1111",
        tools: ["greplost", "graphify"],
        target: { repo: "anyq", fixture: false, tier: "S", files: 148, commits: 0 },
        metrics: {
          X1: {
            id: "X1", title: "Structural precision", target: ">= +10pt calls",
            tools: { greplost: { value: "calls 1 P", target: ">= +10pt calls", verdict: "tie", reason: "" } },
          },
          X2: { id: "X2", title: "Staleness after no replayed commits", target: "greplost F1 >= 0.99 (not walked)", tools: { greplost: na("not selected by --metrics") } },
          X6: {
            id: "X6", title: "Cold start", target: "<= 5s and $0 (tier M)",
            tools: { greplost: { value: "0.27 s", target: "<= 5s and $0 (tier M)", verdict: "win", reason: "" } },
          },
        },
        method: ["X1: scored over every emitted edge."],
      }),
    );
    // The walk run: X2 measured on hono over 100 commits, X1 not selected.
    writeFileSync(
      path.join(dir, "headtohead-2026-09-02-bbb2222.json"),
      JSON.stringify({
        suite: "headtohead", date: "2026-09-02", greplostSha: "bbb2222",
        tools: ["greplost", "graphify"],
        target: { repo: "hono", fixture: false, tier: "M", files: 248, commits: 100 },
        metrics: {
          X1: { id: "X1", title: "Structural precision", target: ">= +10pt calls", tools: { greplost: na("not selected by --metrics") } },
          X2: {
            id: "X2", title: "Staleness after 100 replayed commits", target: "greplost F1 >= 0.99 after 100 commits",
            tools: { greplost: { value: 1, target: "greplost F1 >= 0.99 after 100 commits", verdict: "win", reason: "", detail: { "syncF1@50": 1, "syncF1@100": 1 } } },
          },
          X6: { id: "X6", title: "Cold start", target: "<= 5s and $0 (tier M)", tools: { greplost: na("not selected by --metrics") } },
        },
        method: ["X2: the walk is 100 synthetic commits over hono."],
      }),
    );

    const text = renderResultsMd(buildModel({ resultsDir: dir }));
    const x1 = text.split("\n").find((line) => line.startsWith("| X1 "));
    const x2 = text.split("\n").find((line) => line.startsWith("| X2 "));
    // Neither run is dropped: each id keeps the number the run that measured it produced.
    expect(x1).toContain("calls 1 P");
    expect(x2).toContain("100 commits");
    // Each row's corpus travels with it, so the tier-M target is not printed
    // against the tier-S run and vice versa.
    const head = text.slice(text.indexOf("## Head-to-head"), text.indexOf("| ID |"));
    expect(head).toContain("on anyq, tier S (148 files)");
    expect(head).toContain("on hono, tier M (248 files, 100 commits)");
    const x6 = text.split("\n").find((line) => line.startsWith("| X6 "));
    expect(x6).toContain("not tier M");
    // Both runs' method lines survive the merge.
    expect(text).toContain("scored over every emitted edge");
    expect(text).toContain("100 synthetic commits over hono");
  });

  test("shape differences in a neighbour payload degrade to `not run`, never to a throw", () => {
    const dir = tempDir("odd-results");
    for (const suite of ["replay", "perf", "agent"]) {
      writeFileSync(
        path.join(dir, `${suite}-2026-09-02-abc1234.json`),
        JSON.stringify({ suite, date: "2026-09-02", greplostSha: "abc1234", somethingElse: [1, 2, 3] }),
      );
    }
    const text = renderResultsMd(buildModel({ resultsDir: dir }));
    expect(text).toContain("## Eval 2");
    expect(text).toContain("## Bench 3");
    expect(text).toContain("## Eval 4");
  });

  test("the perf suite's actual payload shape fills P1 to P3", () => {
    // `repos` is an ARRAY of { name, files, tier, scenarios: [...] }, and each
    // scenario is { scenario, ms: { p50, p95 }, peakRssBytes }, not the flat
    // `scenarios` object this reader first assumed. Captured from
    // bench/results/perf-2026-09-02-334b337.json.
    const dir = tempDir("perf-real");
    writeFileSync(
      path.join(dir, "perf-2026-09-02-abc1234.json"),
      JSON.stringify({
        suite: "perf", date: "2026-09-02", greplostSha: "abc1234",
        peakRssTargetBytes: 524_288_000,
        repos: [
          {
            name: "anyq", files: 148, tier: "S",
            scenarios: [
              { scenario: "full", iterations: 10, ms: { p50: 203, p95: 216 }, peakRssBytes: 241_041_408 },
              { scenario: "incremental-1", iterations: 10, ms: { p50: 131, p95: 145 }, peakRssBytes: 147_406_848 },
              { scenario: "package-rename", iterations: 10, ms: { p50: 126, p95: 134 }, peakRssBytes: 117_293_056 },
            ],
          },
        ],
      }),
    );
    const text = renderResultsMd(buildModel({ resultsDir: dir }));
    const bench3 = text.slice(text.indexOf("## Bench 3"), text.indexOf("## Eval 4"));
    expect(bench3).not.toContain("not run");
    expect(bench3).toContain("203");   // P1: the full build's p50
    expect(bench3).toContain("145");   // P2: the incremental p95
    expect(bench3).toContain("229");   // P3: 241041408 bytes as MB
    expect(bench3).toContain("148");   // the file count the scenario ran over
  });

  test("replay, perf and agent payloads in their documented shapes are read", () => {
    const dir = tempDir("neighbour-results");
    writeFileSync(
      path.join(dir, "replay-2026-09-02-abc1234.json"),
      JSON.stringify({
        suite: "replay", date: "2026-09-02", greplostSha: "abc1234",
        commits: 500, driftCaught: 500, driftTotal: 500, noops: 0,
        f2Checks: 10, f2Mismatches: 0, updateP50: 41, updateP95: 88,
      }),
    );
    writeFileSync(
      path.join(dir, "perf-2026-09-02-abc1234.json"),
      JSON.stringify({
        suite: "perf", date: "2026-09-02", greplostSha: "abc1234",
        scenarios: { "full build": { p50: 820, p95: 900, rss: 310_000_000 } },
      }),
    );
    writeFileSync(
      path.join(dir, "agent-2026-09-02-abc1234.json"),
      JSON.stringify({
        suite: "agent", date: "2026-09-02", greplostSha: "abc1234",
        categories: {
          definition: {
            base: { accuracy: 0.6, tokens: 40_000, toolCalls: 12, wallClock: 30, cost: 0.2 },
            gl: { accuracy: 0.9, tokens: 12_000, toolCalls: 3, wallClock: 12, cost: 0.05 },
          },
        },
        winLossTie: { gl: { win: 1, loss: 0, tie: 0 } },
      }),
    );
    const text = renderResultsMd(buildModel({ resultsDir: dir }));
    expect(text).toContain("500");   // F1 catch rate denominator
    expect(text).toContain("88");    // update p95
    expect(text).toContain("820");   // full build p50
    expect(text).toContain("0.9");   // gl accuracy
  });
});

// ---------------------------------------------------------------------------
// report suite
// ---------------------------------------------------------------------------

describe("charts: X2 arms", () => {
  const cell = (detail: Record<string, number>) => ({ value: 1, target: "", verdict: "win" as const, reason: "", detail });

  test("the documented-sync arm is the hero and its note names arm, corpus and walk", () => {
    const row = {
      id: "X2" as const,
      title: "Staleness after 100 replayed commits",
      target: "greplost F1 >= 0.99 after 100 commits",
      tools: {
        greplost: cell({ "syncF1@25": 1, "syncF1@50": 1, "syncF1@100": 1, commits: 100 }),
        graphify: cell({ "syncF1@25": 0.9, "syncF1@50": 0.7, "syncF1@100": 0.5 }),
      },
    };
    const target = { repo: "hono", fixture: false, tier: "M", files: 618, commits: 100 };
    const charts = stalenessCharts(row, null, "docs/assets", target);
    const hero = charts.find((chart) => chart.png === "docs/assets/x2-staleness.png");
    expect(hero).toBeDefined();
    expect(hero?.svg).toContain("documented-sync");
    expect(hero?.svg).toContain("100 replayed commits");
    expect(hero?.svg).toContain("hono, tier M");
    // A tool that was not walked is named as omitted, never drawn at zero.
    expect(hero?.svg).toContain("Omitted (not run here): ua, crg");
  });

  test("the harness-driven arm never lands on the hero path", () => {
    const row = {
      id: "X2" as const,
      title: "Staleness after 24 replayed commits",
      target: "greplost F1 >= 0.99",
      tools: {
        // `f1@` is the spelling the first round wrote: the refresh-every-commit arm.
        greplost: cell({ "f1@12": 1, "f1@24": 1, "staleF1@12": 0.8, "staleF1@24": 0.6 }),
      },
    };
    const charts = stalenessCharts(row, null, "docs/assets", { repo: "tiny-ts", fixture: true, files: 12, commits: 24 });
    const paths = charts.map((chart) => chart.png);
    expect(paths).toContain("docs/assets/x2-refresh-every-commit.png");
    expect(paths).toContain("docs/assets/x2-no-refresh.png");
    // The hero still exists, and says nothing was measured in its arm.
    const hero = charts.find((chart) => chart.png === "docs/assets/x2-staleness.png");
    expect(hero).toBeDefined();
    expect(hero?.svg).not.toContain("documented-sync");
    const companion = charts.find((chart) => chart.png === "docs/assets/x2-refresh-every-commit.png");
    expect(companion?.svg).toContain("refresh-every-commit");
    expect(companion?.svg).toContain("24 replayed commits");
    expect(companion?.svg).toContain("fixtures/tiny-ts");
    const noRefresh = charts.find((chart) => chart.png === "docs/assets/x2-no-refresh.png");
    expect(noRefresh?.svg).toContain("no-refresh");
  });

  test("the hero chart opens at commit 0 and its note separates coverage from decay", () => {
    const row = {
      id: "X2" as const,
      title: "Staleness after 100 replayed commits",
      target: "greplost F1 >= 0.99 after 100 commits",
      tools: {
        greplost: cell({ "syncF1@0": 1, "syncF1@50": 1, "syncF1@100": 1, freshF1: 1, decay: 0 }),
        graphify: cell({ "syncF1@0": 0.131, "syncF1@50": 0.127, "syncF1@100": 0.125, freshF1: 0.131, decay: 0.006 }),
        crg: cell({ "syncF1@0": 0.896, "syncF1@50": 0.904, "syncF1@100": 0.897, freshF1: 0.896, decay: -0.001 }),
      },
    };
    const target = { repo: "hono", fixture: false, tier: "M", files: 248, commits: 100 };
    const hero = stalenessCharts(row, null, "docs/assets", target)
      .find((chart) => chart.png === "docs/assets/x2-staleness.png");
    expect(hero).toBeDefined();
    // The curve starts where each tool starts.
    expect(hero?.body).toContain('["0", "50", "100"]');
    expect(hero?.caption).toContain("freshness under each tool's own sync mechanism");
    expect(hero?.svg).toContain("Freshness under each tool's own sync mechanism");
    // And the note says what the distance between the lines actually is. The note is
    // wrapped across several `<text>` elements, so it is read back unwrapped.
    const note = svgNote(hero?.svg ?? "");
    expect(note).toContain("At commit 0");
    expect(note).toContain("graphify 0.131");
    expect(note).toContain("coverage");
    expect(hero?.svg).not.toContain("X2 staleness under each tool");
    // The walk is synthetic, and the chart a README reader meets first says so.
    expect(note).toContain("The walk is synthetic");
    expect(note).toContain("no deletions, no renames and no new files");
    expect(hero?.caption).toContain("synthetic commit walk");
    // The documented-sync arm's one qualification: crg's export at each checkpoint.
    expect(note).toContain("crg's `visualize --format json` export is run at each scoring checkpoint");
  });

  test("freshnessNote falls back to the cell's freshF1 when the curve has no @0", () => {
    const row = {
      id: "X2" as const,
      title: "",
      target: "",
      tools: { graphify: cell({ freshF1: 0.131, decay: 0.006 }) },
    };
    const note = freshnessNote(row, { categories: ["50", "100"], series: [{ name: "graphify", values: [0.127, 0.125] }] });
    expect(note).toContain("graphify 0.131");
    expect(note).toContain("graphify +0.006");
    expect(freshnessNote(undefined, { categories: [], series: [] })).toBe("");
  });

  test("scaleNote states the corpus and the walk, and nothing it was not given", () => {
    expect(scaleNote({ repo: "anyq", fixture: false, tier: "S", files: 148 }, null)).toBe(
      " Measured on corpus anyq, tier S (148 files).",
    );
    expect(scaleNote(undefined, null)).toBe("");
    // A run with no walk does not claim "0 replayed commits".
    expect(scaleNote({ repo: "anyq", fixture: false, tier: "S", files: 148, commits: 0 }, null)).toBe(
      " Measured on corpus anyq, tier S (148 files).",
    );
  });
});

describe("report", () => {
  test("--dry-run on an empty results dir writes a complete RESULTS.md and no PNG", async () => {
    const results = tempDir("report-results");
    const out = path.join(tempDir("report-out"), "RESULTS.md");
    const assets = tempDir("report-assets");
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    let code: number;
    try {
      code = await reportRun(["--dry-run", "--results-dir", results, "--out", out, "--assets", assets]);
    } finally {
      console.log = log;
    }
    expect(code).toBe(0);
    expect(lines[lines.length - 1]).toBe("report: wrote bench/RESULTS.md");
    const text = readFileSync(out, "utf8");
    for (const header of SECTION_HEADERS) expect(text).toContain(`## ${header}`);
    expect(text.split("\n").filter((l) => /^\| X(10|[1-9]) /.test(l)).length).toBe(10);
    expect(readdirSafe(assets).length).toBe(0);
  });

  test("a real run writes the hero chart even when only greplost has data", async () => {
    const results = tempDir("hero-results");
    const out = path.join(tempDir("hero-out"), "RESULTS.md");
    const assets = tempDir("hero-assets");
    writeFileSync(
      path.join(results, "replay-2026-09-02-abc1234.json"),
      JSON.stringify({
        suite: "replay", date: "2026-09-02", greplostSha: "abc1234",
        commits: 100, driftCaught: 100, driftTotal: 100, f2Checks: 4, f2Mismatches: 0,
        updateP50: 40, updateP95: 90,
      }),
    );
    const log = console.log;
    console.log = () => {};
    try {
      expect(await reportRun(["--results-dir", results, "--out", out, "--assets", assets])).toBe(0);
    } finally {
      console.log = log;
    }
    const hero = path.join(assets, "x2-staleness.png");
    expect(existsSync(hero)).toBe(true);
    expect(readFileSync(hero).length).toBeGreaterThan(0);
    // The legend says which tools are absent rather than drawing them at zero.
    expect(readFileSync(out, "utf8")).toContain("x2-staleness.png");
  });

  test("the hero chart exists with no results at all", async () => {
    const assets = tempDir("hero2-assets");
    const out = path.join(tempDir("hero2-out"), "RESULTS.md");
    const log = console.log;
    console.log = () => {};
    try {
      await reportRun(["--results-dir", tempDir("hero2-results"), "--out", out, "--assets", assets]);
    } finally {
      console.log = log;
    }
    expect(existsSync(path.join(assets, "x2-staleness.png"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// screenshots
// ---------------------------------------------------------------------------

describe("screenshots", () => {
  test("checkTools reports every section 11 tool with an install instruction", () => {
    const tools = checkTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["freeze", "playwright (chromium)", "vhs"]);
    for (const tool of tools) {
      expect(typeof tool.available).toBe("boolean");
      expect(tool.install.length).toBeGreaterThan(0);
    }
  });

  test("--check prints the convention line and never fails", async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    let code: number;
    try {
      code = await screenshotsRun(["--check"]);
    } finally {
      console.log = log;
    }
    expect(code).toBe(0);
    expect(lines[lines.length - 1]).toMatch(/^screenshots: \d+ available, \d+ missing$/);
  });

  test("the tapes for captures 1 and 5 are committed and name their output", () => {
    for (const tape of ["init.tape", "side-by-side-baseline.tape", "side-by-side-greplost.tape"]) {
      const file = path.join(REPO_ROOT, "docs", "tapes", tape);
      expect(existsSync(file)).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(text).toContain("Output");
      // A still is a `Screenshot`. `Output <name>.png` makes vhs write a
      // directory of one PNG per frame at that path (5,282 files for init.tape).
      expect(text).toContain("Screenshot docs/assets/");
      const outputs = [...text.matchAll(/^\s*Output\s+(\S+)/gm)].map((match) => match[1] ?? "");
      expect(outputs.filter((out) => out.endsWith(".png"))).toEqual([]);
    }
  });

  test("captures 7 to 9 are listed as produced by `bench report`", () => {
    for (const id of [7, 8, 9]) {
      const capture = CAPTURES.find((entry) => entry.id === id);
      expect(capture).toBeDefined();
      expect(capture?.description).toContain("bench report");
      expect(capture?.needs).toEqual([]);
      expect(capture?.perform({ assets: "/tmp", tools: new Map(), paid: false }).skipped).toContain("bench report");
    }
    expect(CAPTURES.map((capture) => capture.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test("the reproducibility capture leaves no competitor artifacts in the shared work dir", () => {
    const capture = CAPTURES.find((entry) => entry.id === 11);
    expect(capture).toBeDefined();
    // Both redirects, or photographing X4 writes a benchmark result and flips
    // the agent suite's competitor conditions as a side effect.
    const source = readFileSync(path.join(REPO_ROOT, "bench", "src", "screenshots.ts"), "utf8");
    expect(source).toContain("GREPLOST_BENCH_RESULTS_DIR: results");
    expect(source).toContain("GREPLOST_BENCH_WORK_DIR: work");
    // And the suite it drives has to honour the redirect.
    const harness = readFileSync(path.join(REPO_ROOT, "bench", "src", "headtohead.ts"), "utf8");
    expect(harness).toContain('process.env["GREPLOST_BENCH_WORK_DIR"]');
  });

  test("a captured terminal is wrapped and clipped, so freeze cannot size a 15,000px canvas", () => {
    const wide = `${"x".repeat(250)}\nshort`;
    const fitted = fitForCapture(wide, 100, 40);
    for (const line of fitted.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    expect(fitted.split("\n")).toHaveLength(4);

    const tall = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const clipped = fitForCapture(tall, 100, 10);
    expect(clipped.split("\n")).toHaveLength(10);
    expect(clipped).toContain("more lines, cut so the image stays a screenshot");
  });

  test("capture 11 keeps the X4 rows and byte counts, not the whole transcript", () => {
    const transcript = [
      "  ID    Measured   vs graphify   vs ua   vs crg",
      "  X4    0 bytes    0 bytes       n/a     79098 bytes",
      "  X4 crg: graph.json differs in nodes, edges, stats; 79098 bytes",
      "  X4 ua: no headless CLI, so nothing was built to compare",
      "headtohead: wrote bench/results/headtohead-2026-09-02-abc1234.json",
      "",
    ].join("\n");
    const shaped = x4Summary(transcript);
    expect(shaped).toContain("X4 crg:");
    expect(shaped).toContain("ID");
    expect(shaped).not.toContain("headtohead: wrote");
    // A tool that was never built has no reproducibility finding to show.
    expect(shaped).not.toContain("no headless CLI");
  });

  test("a run with no tools available skips every capture and still returns 0", async () => {
    const assets = tempDir("shot-assets");
    const log = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = await screenshotsRun(["--assets", assets, "--only", "nothing-matches-this"]);
    } finally {
      console.log = log;
    }
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dispatcher wiring
// ---------------------------------------------------------------------------

describe("dispatcher", () => {
  test("every suite this leaf owns exports run(args)", async () => {
    for (const name of ["headtohead", "report", "screenshots"]) {
      const mod = (await import(`../src/${name}.ts`)) as { run?: unknown };
      expect(typeof mod.run).toBe("function");
    }
  });
});
