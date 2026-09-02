/**
 * Deterministic charts for `RESULTS.md` and `docs/assets/` (tech spec 10.9, 11;
 * bench leaf 1.5.7).
 *
 * SVG is written by hand — no charting library, no template engine — for one
 * reason: the PNGs are committed, so two runs of `bench report` on the same
 * results must produce the same bytes. That rules out anything that reaches for
 * a clock, a random id, a hash-suffixed class name, or an iteration order that
 * depends on insertion. Everything below is a pure function of its arguments:
 *
 *  - no `id=` attributes and no `<defs>`, so nothing needs a unique name;
 *  - no `Date`, no `Math.random`, no environment reads;
 *  - every coordinate is rounded through `coord()` before it is printed, so a
 *    floating-point last digit cannot move between architectures;
 *  - the element order is the argument order;
 *  - text is never measured by the renderer: label placement uses `textWidth`,
 *    a character count times a fixed advance, so the layout cannot depend on
 *    the fonts installed on the machine that drew it.
 *
 * ## The look (Artificial Analysis, on an AMOLED surface)
 *
 * Pure black surface, white primary text, one three-colour categorical palette
 * bound to the tools rather than to a row number, dotted gridlines and no plot
 * frame. The rules the charts hold themselves to:
 *
 *  - **Colour follows the entity.** `TOOL_COLORS` binds greplost to aqua,
 *    Graphify to orange and code-review-graph to blue in every chart, so a
 *    reader who learned a hue on the hero chart still knows it on the scatter.
 *    The palette is never cycled: a fourth *tool* would need a validated fourth
 *    hue, not a reused one.
 *  - **Understand-Anything is `n/a`, never a zero.** A series with no finite
 *    value draws no mark and takes a muted `n/a` legend entry, and a category
 *    nobody measured draws a dashed stub at the baseline.
 *  - **Text wears text tokens.** Labels, values and axis text are white,
 *    secondary or muted; identity is carried by the coloured mark beside them.
 *  - **One axis per chart.** There is no dual-axis path in this file.
 *
 * The palette was validated against this surface with the dataviz skill's
 * checker before it was written down here:
 *
 *   node <dataviz-skill>/scripts/validate_palette.js "#0fa976,#e0561c,#2f86ef" \
 *     --mode dark --surface "#000000" --pairs all
 *   -> ALL CHECKS PASS (worst all-pairs CVD Delta E and every contrast floor clear)
 *
 * The command is recorded rather than run: the report must not shell out to a
 * skill directory that only exists on one machine.
 *
 * Rasterisation uses `@resvg/resvg-js` with its default font resolution. Glyph
 * rendering therefore depends on the fonts installed on the machine that ran
 * the report — that is a property of the PNG, not of the SVG, and the SVG is
 * what the golden test locks. Every PNG is passed through `stripPngMetadata`,
 * which drops every ancillary chunk except `pHYs`, so a committed image carries
 * no text, no timestamp and no tool signature.
 *
 * `RESULTS.md` links the PNG and inlines a Mermaid `xychart-beta` fence of the
 * same data (`mermaidXy`), so a reader who cannot see the image still gets the
 * numbers on GitHub with no image pipeline.
 *
 * A missing measurement is `null` and is drawn as a gap. It is never drawn as a
 * zero: a competitor that could not be run must not look like a competitor that
 * scored nothing (tech spec 10.0, "the table says N/A rather than 0").
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/** One line, or one bar group, over the chart's categories. */
export interface Series {
  name: string;
  /** One value per category; `null` is "not measured", drawn as a gap. */
  values: readonly (number | null)[];
}

export interface ChartSpec {
  title: string;
  /** One line under the title, in secondary text: corpus, walk length, arm. */
  subtitle?: string;
  /** Category labels along the x axis; the series values are positional against these. */
  categories: readonly string[];
  series: readonly Series[];
  yLabel?: string;
  xLabel?: string;
  /** Force the top of the y axis (F1 and precision charts pin this to 1). */
  yMax?: number;
  /** A caption under the plot: what was omitted, which unit, which machine. */
  note?: string;
  width?: number;
  height?: number;
  /**
   * Draw the y axis on a log scale. Decided by the caller from the data with
   * `logScaleFor`, never by taste, and the axis title has to say "log scale".
   */
  logY?: boolean;
  /**
   * The category or series greplost owns, drawn with a white anchor ring so the
   * reader can find it without reading every label.
   */
  highlight?: string;
  /** Tools that produced no mark at all, as muted `n/a` legend entries. */
  absent?: readonly string[];
}

/** One box in a box plot; `low`/`high` are the whiskers, `mid` the median line. */
export interface BoxDatum {
  name: string;
  low: number | null;
  q1: number;
  mid: number;
  q3: number;
  high: number | null;
}

export interface BoxSpec {
  title: string;
  subtitle?: string;
  boxes: readonly BoxDatum[];
  yLabel?: string;
  yMax?: number;
  note?: string;
  width?: number;
  height?: number;
}

/** One tool on a quadrant scatter: a cost on x, a quality on y. */
export interface ScatterPoint {
  name: string;
  x: number;
  y: number;
}

export interface ScatterSpec {
  title: string;
  subtitle?: string;
  points: readonly ScatterPoint[];
  xLabel: string;
  yLabel: string;
  /** Force the top of the y axis (an F1 scatter pins this to 1). */
  yMax?: number;
  /** The point drawn with the white ring: greplost, on every chart that has it. */
  highlight?: string;
  /** Tools with no point at all, as muted `n/a` legend entries. */
  absent?: readonly string[];
  note?: string;
  width?: number;
  height?: number;
}

interface LegendEntry {
  name: string;
  /** `null` for an entry with no mark: the tool was not run. */
  color: string | null;
  kind: "dot" | "swatch" | "rule";
  /** Draw the white anchor ring around this entry's dot. */
  ring?: boolean;
}

// ---------------------------------------------------------------------------
// palette and geometry
// ---------------------------------------------------------------------------

/**
 * The categorical palette, validated on `#000000` (see the file header).
 *
 * Three slots, in a fixed order, never cycled. Index 0 is greplost in every
 * head-to-head chart, so the hero chart's colour means the same thing as the
 * X1 chart's.
 */
export const PALETTE: readonly string[] = ["#0fa976", "#e0561c", "#2f86ef"];

/**
 * Colour by entity, not by row number.
 *
 * Sorting a bar chart, or dropping a tool that could not be run, must not
 * repaint the survivors: a reader who learned "greplost is aqua" on one chart
 * would be misled by the next one. Tools not in this map draw no mark (`ua`
 * has never been runnable here), so they need no hue.
 */
export const TOOL_COLORS: Readonly<Record<string, string>> = {
  greplost: "#0fa976",
  graphify: "#e0561c",
  crg: "#2f86ef",
};

/** How a tool is spelled on a chart. The tables keep the short ids. */
export const TOOL_NAMES: Readonly<Record<string, string>> = {
  greplost: "greplost",
  graphify: "Graphify",
  ua: "Understand-Anything",
  crg: "code-review-graph",
};

const SURFACE = "#000000";
const TEXT_PRIMARY = "#FFFFFF";
const TEXT_SECONDARY = "#C3C2B7";
const TEXT_MUTED = "#8A8983";
const GRID = "#262626";
/** Dotted, not solid: the Artificial Analysis grid this restyle is modelled on. */
const GRID_DASH = "2 4";
const AXIS = "#3A3A3A";
/** The 1px inner frame that keeps a black card off a black GitHub page. */
const BORDER = "#262626";
/** The wash behind the "most attractive quadrant" of a scatter. */
const QUADRANT_OPACITY = "0.12";

const FONT_STACK = "system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif";
const SOURCE_MARK = "greplost bench · bench/RESULTS.md";

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 620;
/** Left padding before the y tick labels are measured; `startFrame` may widen it. */
const PAD_LEFT = 84;
const PAD_RIGHT = 40;
/** Extra right padding on a chart whose series are labelled at their end. */
const PAD_RIGHT_LABELLED = 200;
/**
 * Room under the plot for the category labels, the anchor ring and the axis
 * title, with air before the note block. A container whose height excludes its
 * own axis band is the defect that gives a chart card a nested scrollbar.
 */
const PAD_BOTTOM = 104;
/** Baselines under the plot: category label, its second line, ring, axis title. */
const CATEGORY_LABEL_Y = 22;
const CATEGORY_LABEL_Y2 = 36;
const ANCHOR_RING_Y = 40;
const ANCHOR_RING_Y2 = 52;
const AXIS_TITLE_Y = 70;
const TITLE_Y = 40;
const SUBTITLE_Y = 64;
const LEGEND_Y = 94;
const LEGEND_ROW_HEIGHT = 22;
const PLOT_TOP = 126;
/** Number of gaps between y gridlines when the axis is linear. */
const Y_INTERVALS = 4;
/** Baseline-to-baseline distance for a wrapped note line. */
const NOTE_LINE_HEIGHT = 13;
/** Average advance of the 10px note font, in pixels. Deliberately conservative. */
const NOTE_CHAR_WIDTH = 5.2;
/** Left and right margin of the note block. */
const NOTE_MARGIN = 32;
/** Widest a single bar is allowed to get, so three bars are not three slabs. */
const BAR_MAX = 72;
/** Surface-coloured gap between two bars that share a group. */
const BAR_GAP = 2;
/** A measured zero still gets ink, so the entity is visible; its label says `0`. */
const BAR_ZERO_HEIGHT = 2;
/** Shortest bar that can hold its value inside it. */
const BAR_LABEL_MIN_HEIGHT = 30;
/**
 * Minimum horizontal distance between two x-axis labels, in pixels.
 *
 * Wide enough for a four-character label in the 12px axis font plus air, so a
 * proportionally spaced axis whose last two checkpoints sit close together prints one
 * label rather than two overlapping ones.
 */
const MIN_LABEL_GAP = 44;
/** Minimum vertical distance between two direct labels before one is nudged. */
const MIN_DIRECT_LABEL_GAP = 15;
/**
 * The corner of a quadrant scatter that is shaded "most attractive".
 *
 * A reading aid at a fixed fraction of each axis, not a threshold anybody
 * measured: low cost is the left 40% of the x axis, high quality the top 40% of
 * the y axis. Every chart that shades it says so in its note.
 */
const QUADRANT_X_FRACTION = 0.4;
const QUADRANT_Y_FRACTION = 0.4;

/** How many characters of the note font fit across the canvas, minus margins. */
function noteWidth(width: number): number {
  return Math.max(20, Math.floor((width - NOTE_MARGIN * 2) / NOTE_CHAR_WIDTH));
}

/**
 * Greedy word wrap. Deterministic and metric-free: it counts characters, not
 * glyph advances, because a chart whose layout depended on the rendering
 * machine's font metrics would not be byte-reproducible.
 */
export function wrapText(text: string, columns: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (candidate.length <= columns) {
      line = candidate;
      continue;
    }
    if (line.length > 0) out.push(line);
    line = word;
  }
  if (line.length > 0) out.push(line);
  return out;
}

/**
 * A width estimate for a run of text, in pixels.
 *
 * Used to decide whether a value fits inside its bar and whether a dot's label
 * fits to its right. It is an estimate on purpose: measuring real glyphs would
 * make the SVG depend on the machine's fonts, and a label that is placed by
 * measurement on one machine and not on another is not a deterministic chart.
 * The factor is generous for the digits and lower-case names these charts
 * carry, so the decision errs towards moving a label out rather than clipping it.
 */
export function textWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.55;
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

/**
 * A coordinate, rounded to two decimals and printed without a trailing zero.
 * Every number that reaches the SVG goes through here or `label()`, which is
 * what makes two runs byte-identical rather than merely visually identical.
 */
export function coord(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  // `-0` prints as "-0" and would differ from a run that produced `0`.
  return String(rounded === 0 ? 0 : rounded);
}

/** A value label: three decimals under 10, one under 1000, none above. */
export function label(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return String(Math.round(value));
  if (magnitude >= 10) return trimZeros(value.toFixed(1));
  return trimZeros(value.toFixed(3));
}

/**
 * `label()` with thousands separators, for text a human reads off the chart.
 *
 * The Mermaid fence and the golden SVG keep `label()`'s bare digits: a comma
 * inside an `xychart-beta` series is a value separator, so a grouped number
 * there would not parse.
 */
export function displayValue(value: number): string {
  const text = label(value);
  const dot = text.indexOf(".");
  const whole = dot === -1 ? text : text.slice(0, dot);
  const rest = dot === -1 ? "" : text.slice(dot);
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${rest}`;
}

function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/** XML text escaping. Chart labels carry tool names and units, not markup. */
export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A round number at or above `raw`, from the 1 / 1.25 / 1.5 / 2 / 2.5 / 3 / 4 /
 * 5 / 7.5 / 10 ladder. Deterministic and independent of the data's spread, so
 * adding a series cannot silently rescale a chart that is compared across runs.
 */
export function axisMax(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const exponent = Math.floor(Math.log10(raw));
  const base = 10 ** exponent;
  for (const step of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (raw <= step * base * (1 + 1e-12)) return round6(step * base);
  }
  return round6(10 * base);
}

/**
 * Whether a set of values earns a log axis.
 *
 * Two rules, both mechanical: every value has to be positive (a log axis has no
 * room for a measured zero, and dropping the zero to get the axis would be the
 * chart lying about the best result it has), and the spread has to cross two
 * decades. Anything narrower reads better linear, and `logY` is never set by
 * taste — the caller asks this function and puts "log scale" in the axis title
 * when it says yes.
 */
export function logScaleFor(values: readonly (number | null | undefined)[]): boolean {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (finite.length < 2) return false;
  if (finite.some((value) => value <= 0)) return false;
  return Math.max(...finite) / Math.min(...finite) >= 100;
}

/** Kills the 0.30000000000000004 class of float noise before a number is printed. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * How many gridline intervals a linear axis gets.
 *
 * Four unless the axis maximum's leading digits make quarters ugly: 2.5 in four
 * steps is 0.625 a tick, and an axis nobody can read in their head is an axis
 * that sends the reader to the table.
 */
function tickCount(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return Y_INTERVALS;
  const mantissa = round6(max / 10 ** Math.floor(Math.log10(max)));
  return mantissa === 1.25 || mantissa === 1.5 || mantissa === 2.5 || mantissa === 5 || mantissa === 7.5 ? 5 : 4;
}

/** The tick values of an axis, low to high. */
function ticksFor(min: number, max: number, log: boolean): number[] {
  if (!log) {
    const count = tickCount(max);
    return Array.from({ length: count + 1 }, (_, i) => round6((max * i) / count));
  }
  const low = Math.round(Math.log10(min));
  const high = Math.round(Math.log10(max));
  const out: number[] = [];
  for (let exponent = low; exponent <= high; exponent++) out.push(round6(10 ** exponent));
  return out;
}

/** The decade below the smallest positive value, which is where a log axis starts. */
function logFloor(values: readonly (number | null)[]): number {
  const positive = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  if (positive.length === 0) return 1;
  return 10 ** Math.floor(Math.log10(Math.min(...positive)));
}

// ---------------------------------------------------------------------------
// colour and naming
// ---------------------------------------------------------------------------

/** A tool's spelling on a chart; anything else is printed as it arrived. */
export function displayName(name: string): string {
  return TOOL_NAMES[name] ?? name;
}

/**
 * The colour of a series or a category.
 *
 * A tool keeps its own hue wherever it appears. Anything else — an edge kind, a
 * perf scenario — takes a palette slot by position, and a chart with one such
 * series uses slot 1 for every mark rather than colouring by magnitude.
 */
export function markColor(name: string, index: number): string {
  return TOOL_COLORS[name] ?? PALETTE[index % PALETTE.length] ?? TEXT_PRIMARY;
}

function hasFinite(values: readonly (number | null)[]): boolean {
  return values.some((value) => typeof value === "number" && Number.isFinite(value));
}

// ---------------------------------------------------------------------------
// sorting
// ---------------------------------------------------------------------------

/**
 * The same spec with its categories in descending order of value.
 *
 * Applied by the chart builders, not by the renderer, so the Mermaid fence and
 * the SVG cannot disagree about the order. Ties and unmeasured categories keep
 * their original relative order (a stable sort on the original index), so the
 * result is a pure function of the input and two runs cannot swap two equal
 * bars. Unmeasured categories sort last: `n/a` is not a small number.
 */
export function sortDesc(spec: ChartSpec): ChartSpec {
  const score = (index: number): number | null => {
    let found: number | null = null;
    for (const series of spec.series) {
      const value = series.values[index];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      found = found === null ? value : Math.max(found, value);
    }
    return found;
  };
  const order = spec.categories.map((_, index) => index).sort((a, b) => {
    const left = score(a);
    const right = score(b);
    if (left === null && right === null) return a - b;
    if (left === null) return 1;
    if (right === null) return -1;
    return right === left ? a - b : right - left;
  });
  return {
    ...spec,
    categories: order.map((index) => spec.categories[index] ?? ""),
    series: spec.series.map((series) => ({
      name: series.name,
      values: order.map((index) => series.values[index] ?? null),
    })),
  };
}

/**
 * The same spec with its series in descending order of their mean value.
 *
 * For a grouped chart, where sorting the categories would say nothing: the
 * order of the bars *inside* every group is one order, so the groups stay
 * comparable, and a series nobody measured sorts last rather than leading with
 * a row of dashed stubs.
 */
export function sortSeriesDesc(spec: ChartSpec): ChartSpec {
  const mean = (series: Series): number | null => {
    const finite = series.values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (finite.length === 0) return null;
    return finite.reduce((sum, value) => sum + value, 0) / finite.length;
  };
  const scored = spec.series.map((series, index) => ({ series, index, mean: mean(series) }));
  scored.sort((a, b) => {
    if (a.mean === null && b.mean === null) return a.index - b.index;
    if (a.mean === null) return 1;
    if (b.mean === null) return -1;
    return b.mean === a.mean ? a.index - b.index : b.mean - a.mean;
  });
  return { ...spec, series: scored.map((entry) => entry.series) };
}

// ---------------------------------------------------------------------------
// the shared frame
// ---------------------------------------------------------------------------

interface Frame {
  width: number;
  height: number;
  /** Plot rectangle. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  max: number;
  min: number;
  log: boolean;
  lines: string[];
  /** Value -> y pixel. */
  y(value: number): number;
  /** Value -> x pixel; only meaningful when the frame was given an `xMax`. */
  x(value: number): number;
}

interface FrameOptions {
  title: string;
  subtitle: string | undefined;
  yLabel: string | undefined;
  xLabel: string | undefined;
  note: string | undefined;
  width: number | undefined;
  height: number | undefined;
  max: number;
  /** Values the axis has to cover, so a log axis can find its floor decade. */
  values?: readonly (number | null)[];
  log?: boolean;
  legend: readonly LegendEntry[];
  padRight?: number;
  /** A numeric x axis (the quadrant scatters); categories draw their own labels. */
  xMax?: number;
  /**
   * The shaded corner of a quadrant scatter, as a fraction of each axis.
   *
   * Drawn by the frame rather than by the caller so that it lands *under* the
   * gridlines and the marks: a wash painted over the data would hide the thing
   * it is pointing at.
   */
  quadrant?: { xFraction: number; yFraction: number; color: string };
}

function startFrame(opts: FrameOptions): Frame {
  const width = opts.width ?? DEFAULT_WIDTH;
  // The note is the part of a benchmark chart that says what was left out, so it
  // is wrapped and the canvas grows for it rather than being clipped at the
  // right edge. A caveat nobody can read is a caveat nobody was given.
  const noteLines = opts.note === undefined ? [] : wrapText(opts.note, noteWidth(width));
  const noteGrowth = Math.max(0, noteLines.length - 1) * NOTE_LINE_HEIGHT;

  const log = opts.log === true;
  const min = log ? logFloor(opts.values ?? []) : 0;
  const max = opts.max;
  const yTicks = ticksFor(min, max, log);

  // The plot starts to the right of the widest tick label, so a byte count and
  // an F1 score can share a renderer without one of them running into the axis
  // title.
  const widestTick = yTicks.reduce((found, value) => Math.max(found, textWidth(displayValue(value), 11)), 0);
  const left = Math.max(PAD_LEFT, 34 + Math.ceil(widestTick) + 12);
  const right = width - (opts.padRight ?? PAD_RIGHT);

  // A legend is always present for two or more series, and never for one: with
  // a single colour on the plot the title already says what is plotted, and a
  // box with one swatch restates it. An `n/a` entry is not a series, so a lone
  // one still prints — it is the only place that tool is named.
  const legend = opts.legend.length === 1 && opts.legend[0]?.color !== null ? [] : opts.legend;
  const legendRows = layoutLegend(legend, right);
  const legendGrowth = Math.max(0, legendRows.length - 1) * LEGEND_ROW_HEIGHT;
  const top = PLOT_TOP + legendGrowth;
  const height = (opts.height ?? DEFAULT_HEIGHT) + legendGrowth + noteGrowth;
  const bottom = height - PAD_BOTTOM - noteGrowth;

  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" font-family="${FONT_STACK}" font-size="12">`,
  );
  lines.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${SURFACE}"/>`);
  // A hairline inside the image, so a black card does not bleed into GitHub's
  // black page and lose its edges.
  lines.push(
    `<rect x="0.5" y="0.5" width="${coord(width - 1)}" height="${coord(height - 1)}" fill="none" stroke="${BORDER}"/>`,
  );
  lines.push(
    `<text x="${NOTE_MARGIN}" y="${TITLE_Y}" font-size="20" font-weight="600" fill="${TEXT_PRIMARY}">${esc(opts.title)}</text>`,
  );
  lines.push(
    `<text x="${coord(width - NOTE_MARGIN)}" y="${TITLE_Y}" font-size="11" fill="${TEXT_MUTED}" text-anchor="end">${esc(SOURCE_MARK)}</text>`,
  );
  if (opts.subtitle !== undefined) {
    lines.push(`<text x="${NOTE_MARGIN}" y="${SUBTITLE_Y}" font-size="13" fill="${TEXT_SECONDARY}">${esc(opts.subtitle)}</text>`);
  }

  // Legend: a coloured dot and a name per series, laid out at a pitch derived
  // from the name lengths, so the geometry does not depend on text metrics.
  for (let row = 0; row < legendRows.length; row++) {
    const y = LEGEND_Y + row * LEGEND_ROW_HEIGHT;
    for (const placed of legendRows[row] ?? []) lines.push(...legendMark(placed.entry, placed.x, y));
  }

  const plotHeight = bottom - top;
  const logMin = Math.log10(min <= 0 ? 1 : min);
  const logSpan = Math.log10(max) - logMin;
  const y = (value: number): number => {
    if (!log) return bottom - (value / max) * plotHeight;
    if (!(value > 0) || logSpan <= 0) return bottom;
    return bottom - ((Math.log10(value) - logMin) / logSpan) * plotHeight;
  };
  const xMax = opts.xMax ?? 1;
  const x = (value: number): number => left + (value / xMax) * (right - left);

  if (opts.quadrant !== undefined) {
    lines.push(
      `<rect x="${coord(left)}" y="${coord(top)}" width="${coord((right - left) * opts.quadrant.xFraction)}" ` +
        `height="${coord((bottom - top) * opts.quadrant.yFraction)}" fill="${opts.quadrant.color}" ` +
        `fill-opacity="${QUADRANT_OPACITY}"/>`,
    );
  }

  // Gridlines and y tick labels. Dotted, one step off the surface: the grid is
  // a reading aid, and on black a solid rule at this weight reads as data.
  for (const value of yTicks) {
    const at = coord(y(value));
    lines.push(
      `<line x1="${coord(left)}" y1="${at}" x2="${coord(right)}" y2="${at}" stroke="${GRID}" stroke-dasharray="${GRID_DASH}"/>`,
    );
    lines.push(
      `<text x="${coord(left - 10)}" y="${coord(y(value) + 4)}" fill="${TEXT_MUTED}" font-size="11" text-anchor="end">${esc(displayValue(value))}</text>`,
    );
  }

  // The baseline only: no frame, and no y rule. The bars stand on the baseline,
  // so it is structure; a box around the plot is ink that is not data.
  lines.push(
    `<line x1="${coord(left)}" y1="${coord(bottom)}" x2="${coord(right)}" y2="${coord(bottom)}" stroke="${AXIS}"/>`,
  );

  if (opts.xMax !== undefined) {
    for (const value of ticksFor(0, opts.xMax, false)) {
      lines.push(
        `<text x="${coord(x(value))}" y="${coord(bottom + CATEGORY_LABEL_Y)}" fill="${TEXT_MUTED}" font-size="11" text-anchor="middle">${esc(displayValue(value))}</text>`,
      );
    }
  }

  if (opts.yLabel !== undefined) {
    lines.push(
      `<text x="24" y="${coord((top + bottom) / 2)}" fill="${TEXT_SECONDARY}" font-size="11" text-anchor="middle" ` +
        `transform="rotate(-90 24 ${coord((top + bottom) / 2)})">${esc(opts.yLabel)}</text>`,
    );
  }
  if (opts.xLabel !== undefined) {
    lines.push(
      // Anchored to the plot, not to the canvas: the note below can be one line
      // or four, and the axis label must clear it either way.
      `<text x="${coord((left + right) / 2)}" y="${coord(bottom + AXIS_TITLE_Y)}" fill="${TEXT_SECONDARY}" font-size="11" text-anchor="middle">${esc(opts.xLabel)}</text>`,
    );
  }
  for (let i = 0; i < noteLines.length; i++) {
    const at = height - 10 - (noteLines.length - 1 - i) * NOTE_LINE_HEIGHT;
    lines.push(`<text x="${NOTE_MARGIN}" y="${coord(at)}" fill="${TEXT_MUTED}" font-size="10">${esc(noteLines[i] ?? "")}</text>`);
  }

  return { width, height, left, right, top, bottom, max, min, log, lines, y, x };
}

/** Legend entries packed into rows that fit inside the canvas. */
function layoutLegend(
  entries: readonly LegendEntry[],
  right: number,
): { entry: LegendEntry; x: number }[][] {
  const rows: { entry: LegendEntry; x: number }[][] = [];
  let row: { entry: LegendEntry; x: number }[] = [];
  let x = NOTE_MARGIN;
  for (const entry of entries) {
    const width = 20 + textWidth(entry.name, 12) + 24;
    if (row.length > 0 && x + width > right) {
      rows.push(row);
      row = [];
      x = NOTE_MARGIN;
    }
    row.push({ entry, x });
    x += width;
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

function legendMark(entry: LegendEntry, x: number, y: number): string[] {
  const out: string[] = [];
  const textFill = entry.color === null ? TEXT_MUTED : TEXT_SECONDARY;
  if (entry.color === null) {
    // No mark on the plot, so no mark in the legend: a hollow ring in muted ink
    // says "this tool has no value here" without inventing a colour for it.
    out.push(`<circle cx="${coord(x + 6)}" cy="${coord(y - 4)}" r="5" fill="none" stroke="${TEXT_MUTED}" stroke-width="1.5"/>`);
  } else if (entry.kind === "swatch") {
    out.push(
      `<rect x="${coord(x)}" y="${coord(y - 10)}" width="12" height="12" fill="${entry.color}" ` +
        `fill-opacity="${QUADRANT_OPACITY}" stroke="${entry.color}" stroke-opacity="0.35"/>`,
    );
  } else if (entry.kind === "rule") {
    out.push(
      `<line x1="${coord(x)}" y1="${coord(y - 4)}" x2="${coord(x + 14)}" y2="${coord(y - 4)}" ` +
        `stroke="${entry.color}" stroke-width="2" stroke-dasharray="2 6"/>`,
    );
  } else {
    out.push(`<circle cx="${coord(x + 6)}" cy="${coord(y - 4)}" r="5" fill="${entry.color}"/>`);
    if (entry.ring === true) {
      out.push(
        `<circle cx="${coord(x + 6)}" cy="${coord(y - 4)}" r="8" fill="none" stroke="${TEXT_PRIMARY}" stroke-width="1.5"/>`,
      );
    }
  }
  out.push(`<text x="${coord(x + 20)}" y="${coord(y)}" fill="${textFill}" font-size="12">${esc(entry.name)}</text>`);
  return out;
}

function finishFrame(frame: Frame): string {
  frame.lines.push("</svg>");
  return `${frame.lines.join("\n")}\n`;
}

/** The largest finite value across every series, or 0 when there is none. */
function peak(series: readonly Series[]): number {
  let found = 0;
  for (const one of series) {
    for (const value of one.values) {
      if (typeof value === "number" && Number.isFinite(value) && value > found) found = value;
    }
  }
  return found;
}

/** Every finite value of every series, for the log-floor decision. */
function allValues(series: readonly Series[]): (number | null)[] {
  return series.flatMap((one) => [...one.values]);
}

function legendOf(spec: ChartSpec): LegendEntry[] {
  const out: LegendEntry[] = spec.series.map((one, index) => (
    hasFinite(one.values)
      ? {
          name: displayName(one.name),
          color: markColor(one.name, index),
          kind: "dot" as const,
          ...(spec.highlight === one.name ? { ring: true } : {}),
        }
      : { name: `${displayName(one.name)}: n/a`, color: null, kind: "dot" as const }
  ));
  for (const name of spec.absent ?? []) out.push({ name: `${displayName(name)}: n/a`, color: null, kind: "dot" });
  return out;
}

/**
 * The legend of a chart whose *categories* are the entities (one bar each).
 *
 * Only what the axis does not already say. Every bar is labelled with its own
 * tool under the baseline, so a legend row repeating those names in the same
 * order is ink for nothing; what it can still carry is a tool that has no bar
 * at all, which the axis has no way to mention.
 */
function categoryLegend(spec: ChartSpec): LegendEntry[] {
  const drawn = new Set(spec.categories);
  return (spec.absent ?? [])
    .filter((name) => !drawn.has(name))
    .map((name) => ({ name: `${displayName(name)}: n/a`, color: null, kind: "dot" as const }));
}

/**
 * Category tick label, drawn under the plot at `x`.
 *
 * A label wider than its slot is split at a space and dropped a size rather
 * than left to run into its neighbour: ten perf scenarios with three-word names
 * printed on one line each is an axis band of overlapping text, which reads as
 * a rendering bug and hides the names it was drawn for. A single word too wide
 * for its slot is still printed whole — cropping the end of a name is worse
 * than crowding it.
 */
function categoryLabel(frame: Frame, x: number, text: string, highlighted: boolean, slot = Infinity): string[] {
  const shown = displayName(text);
  const fits = textWidth(shown, 12) <= slot;
  const rows = fits ? [shown] : wrapToWidth(shown, slot, 11);
  const size = fits ? 12 : 11;
  const out = rows.slice(0, 2).map((row, index) =>
    `<text x="${coord(x)}" y="${coord(frame.bottom + (index === 0 ? CATEGORY_LABEL_Y : CATEGORY_LABEL_Y2))}" ` +
      `fill="${highlighted ? TEXT_PRIMARY : TEXT_SECONDARY}" font-size="${size}" text-anchor="middle">${esc(row)}</text>`,
  );
  if (highlighted) {
    // The anchor: one white ring under greplost's label, so the eye finds the
    // subject of the chart without reading every name.
    const y = frame.bottom + (out.length > 1 ? ANCHOR_RING_Y2 : ANCHOR_RING_Y);
    out.push(`<circle cx="${coord(x)}" cy="${coord(y)}" r="4" fill="none" stroke="${TEXT_PRIMARY}" stroke-width="1.5"/>`);
  }
  return out;
}

/** Greedy wrap on spaces to a pixel width, using the same estimate as everything else. */
function wrapToWidth(text: string, width: number, fontSize: number): string[] {
  const columns = Math.max(1, Math.floor(width / (fontSize * 0.55)));
  return wrapText(text, columns);
}

/** A bar with a 4px rounded top, standing on the baseline. */
function barPath(x: number, top: number, width: number, bottom: number): string {
  const height = Math.max(bottom - top, 0);
  const radius = Math.min(4, height / 2, width / 2);
  return (
    `M ${coord(x)} ${coord(bottom)} L ${coord(x)} ${coord(top + radius)} ` +
    `Q ${coord(x)} ${coord(top)} ${coord(x + radius)} ${coord(top)} ` +
    `L ${coord(x + width - radius)} ${coord(top)} ` +
    `Q ${coord(x + width)} ${coord(top)} ${coord(x + width)} ${coord(top + radius)} ` +
    `L ${coord(x + width)} ${coord(bottom)} Z`
  );
}

// ---------------------------------------------------------------------------
// bar and grouped bar
// ---------------------------------------------------------------------------

/** One bar per category. Extra series are ignored; use `groupedBarChart` for those. */
export function barChart(spec: ChartSpec): string {
  return bars(spec, spec.series.slice(0, 1));
}

/** One bar per (category, series) pair: the X1 and X7 charts (tech spec 10.9). */
export function groupedBarChart(spec: ChartSpec): string {
  return bars(spec, spec.series);
}

function bars(spec: ChartSpec, series: readonly Series[]): string {
  const max = spec.yMax ?? axisMax(peak(series));
  // One series over categories that are *entities* means the entities are the
  // subject, so each bar wears its own tool's colour and the legend names them.
  // One series over anything else (S1 to S4, a list of scenarios) gets one
  // colour for every bar: hue there would double-encode the bar's own height
  // and spend the identity channel on nothing. More than one series means the
  // series are the subject, so colour follows the series instead.
  const byCategory = series.length === 1 && spec.categories.every((name) => name in TOOL_NAMES);
  const frame = startFrame({
    title: spec.title,
    subtitle: spec.subtitle,
    yLabel: spec.yLabel,
    xLabel: spec.xLabel,
    note: spec.note,
    width: spec.width,
    height: spec.height,
    max,
    values: allValues(series),
    ...(spec.logY === true ? { log: true } : {}),
    legend: byCategory ? categoryLegend({ ...spec, series }) : legendOf({ ...spec, series }),
  });

  const slots = Math.max(spec.categories.length, 1);
  const slot = (frame.right - frame.left) / slots;
  const count = Math.max(series.length, 1);
  const groupWidth = Math.min(slot * 0.72, BAR_MAX * count);
  const barWidth = groupWidth / count;

  for (let c = 0; c < spec.categories.length; c++) {
    const slotLeft = frame.left + slot * c + (slot - groupWidth) / 2;
    for (let s = 0; s < series.length; s++) {
      const value = series[s]?.values[c];
      // Half the gap on each side, so a bar sits centred in its own share of
      // the slot and its value label lines up with the category label below it.
      const x = slotLeft + barWidth * s + BAR_GAP / 2;
      const width = barWidth - BAR_GAP;
      const centre = x + width / 2;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        // "not measured" is a dashed outline at the axis, not a bar of height 0.
        frame.lines.push(
          `<rect x="${coord(x)}" y="${coord(frame.bottom - 8)}" width="${coord(width)}" height="8" ` +
            `fill="none" stroke="${AXIS}" stroke-dasharray="2 2"/>`,
        );
        frame.lines.push(
          `<text x="${coord(centre)}" y="${coord(frame.bottom - 14)}" fill="${TEXT_MUTED}" font-size="11" text-anchor="middle">n/a</text>`,
        );
        continue;
      }
      const name = byCategory ? (spec.categories[c] ?? "") : (series[s]?.name ?? "");
      const color = markColor(name, byCategory ? c : s);
      const drawn = Math.min(value, max);
      // A measured zero is a real result (X4's "0 bytes differ" is the best one
      // there is), so it keeps a sliver of ink and its own `0` label. The
      // dashed stub above is the only thing that means "not measured".
      const top = Math.min(frame.y(drawn), frame.bottom - BAR_ZERO_HEIGHT);
      frame.lines.push(`<path d="${barPath(x, top, width, frame.bottom)}" fill="${color}"/>`);

      const text = displayValue(value);
      // Inside the bar near its baseline when the text fits with padding on
      // both sides and the bar is tall enough to hold it; above the bar's end
      // otherwise. A value is never clipped by the mark it belongs to.
      const fits = textWidth(text, 12) + 8 <= width && frame.bottom - top >= BAR_LABEL_MIN_HEIGHT;
      frame.lines.push(
        `<text x="${coord(centre)}" y="${coord(fits ? frame.bottom - 12 : top - 8)}" ` +
          `fill="${TEXT_PRIMARY}" font-size="12" font-weight="600" text-anchor="middle">${esc(text)}</text>`,
      );
    }
    frame.lines.push(
      ...categoryLabel(
        frame,
        frame.left + slot * c + slot / 2,
        spec.categories[c] ?? "",
        spec.highlight === spec.categories[c],
        slot - 8,
      ),
    );
  }

  return finishFrame(frame);
}

// ---------------------------------------------------------------------------
// line
// ---------------------------------------------------------------------------

/**
 * Where each category sits on the x axis, as a fraction of the plot width.
 *
 * Evenly spaced by position, unless every category is a number and they ascend — then
 * spaced by *value*. The X2 checkpoints are commit indices `0, 12, 24 … 96, 100`, and the
 * last gap is 4 commits, not 12: drawing it the same width as the others stretched the
 * final segment threefold and made the end of every curve look like a slope it does not
 * have (review round 3, minor).
 */
export function categoryOffsets(categories: readonly string[]): number[] {
  const count = categories.length;
  if (count <= 1) return count === 1 ? [0] : [];
  const even = categories.map((_, index) => index / (count - 1));

  const values = categories.map((label) => Number(label));
  if (values.some((value) => !Number.isFinite(value))) return even;
  const first = values[0] as number;
  const last = values[count - 1] as number;
  const span = last - first;
  // A flat or descending axis (every label the same, or unsorted) has no scale to
  // read; fall back to even spacing rather than folding points on top of each other.
  if (!(span > 0)) return even;
  for (let i = 1; i < count; i++) {
    if ((values[i] as number) <= (values[i - 1] as number)) return even;
  }
  return values.map((value) => (value - first) / span);
}

/**
 * One polyline per series: the X2 staleness curves and the build-time chart.
 *
 * A run of `null`s breaks the line into segments rather than interpolating over
 * a gap, and a series with no finite value at all draws nothing — which is how
 * the hero chart shows "greplost only" honestly (tech spec 10.9).
 *
 * A numeric, ascending x axis is plotted to scale (`categoryOffsets`), so a chart of
 * commit indices reads as commits rather than as checkpoints.
 *
 * Each curve carries a dot at its first point (commit 0 is where every artifact
 * was fresh, which is the number the note asks the reader to start from) and a
 * dot plus its own name at its last. Direct labels are the dependable identity
 * channel; the legend above the plot repeats it for anyone reading in
 * greyscale. Where two end labels would collide, the lower one is nudged down
 * and given a leader line back to its curve rather than being stacked loose.
 */
export function lineChart(spec: ChartSpec): string {
  const max = spec.yMax ?? axisMax(peak(spec.series));
  const frame = startFrame({
    title: spec.title,
    subtitle: spec.subtitle,
    yLabel: spec.yLabel,
    xLabel: spec.xLabel,
    note: spec.note,
    width: spec.width,
    height: spec.height,
    max,
    values: allValues(spec.series),
    ...(spec.logY === true ? { log: true } : {}),
    legend: legendOf(spec),
    padRight: PAD_RIGHT_LABELLED,
  });

  const count = Math.max(spec.categories.length, 1);
  const offsets = categoryOffsets(spec.categories);
  const xAt = (index: number): number =>
    count > 1
      ? frame.left + (frame.right - frame.left) * (offsets[index] ?? index / (count - 1))
      : (frame.left + frame.right) / 2;

  const ends: { name: string; color: string; x: number; y: number }[] = [];
  for (let s = 0; s < spec.series.length; s++) {
    const one = spec.series[s];
    if (one === undefined) continue;
    const color = markColor(one.name, s);
    let segment: string[] = [];
    const flush = (): void => {
      if (segment.length >= 2) {
        frame.lines.push(
          `<polyline points="${segment.join(" ")}" fill="none" stroke="${color}" stroke-width="2" ` +
            `stroke-linejoin="round" stroke-linecap="round"/>`,
        );
      } else if (segment.length === 1) {
        // A single point is still data; draw it as a dot so it is not lost.
        const [x = "0", y = "0"] = (segment[0] ?? "").split(",");
        frame.lines.push(`<circle cx="${x}" cy="${y}" r="4" fill="${color}" stroke="${SURFACE}" stroke-width="2"/>`);
      }
      segment = [];
    };
    const points: { x: number; y: number }[] = [];
    for (let c = 0; c < count; c++) {
      const value = one.values[c];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        flush();
        continue;
      }
      const x = xAt(c);
      const y = frame.y(Math.min(value, max));
      points.push({ x, y });
      segment.push(`${coord(x)},${coord(y)}`);
    }
    flush();
    const first = points[0];
    const last = points[points.length - 1];
    if (first !== undefined && points.length > 1) {
      frame.lines.push(
        `<circle cx="${coord(first.x)}" cy="${coord(first.y)}" r="4" fill="${color}" stroke="${SURFACE}" stroke-width="2"/>`,
      );
    }
    if (last !== undefined) {
      frame.lines.push(
        `<circle cx="${coord(last.x)}" cy="${coord(last.y)}" r="4" fill="${color}" stroke="${SURFACE}" stroke-width="2"/>`,
      );
      ends.push({ name: displayName(one.name), color, x: last.x, y: last.y });
    }
  }

  // Direct end labels, top to bottom, each pushed clear of the one above it.
  const placed = [...ends].sort((a, b) => (a.y === b.y ? a.name.localeCompare(b.name) : a.y - b.y));
  let previous = Number.NEGATIVE_INFINITY;
  for (const end of placed) {
    const at = Math.max(end.y + 4, previous + MIN_DIRECT_LABEL_GAP);
    if (Math.abs(at - (end.y + 4)) > 1) {
      // The label moved, so it gets a thread back to the curve it belongs to.
      frame.lines.push(
        `<line x1="${coord(end.x + 6)}" y1="${coord(end.y)}" x2="${coord(end.x + 10)}" y2="${coord(at - 4)}" ` +
          `stroke="${AXIS}" stroke-width="1"/>`,
      );
    }
    frame.lines.push(
      `<text x="${coord(end.x + 12)}" y="${coord(at)}" fill="${TEXT_PRIMARY}" font-size="12">${esc(end.name)}</text>`,
    );
    previous = at;
  }

  // Category labels are thinned so a 500-commit x axis stays readable; the divisor is
  // derived from the count, so it does not depend on the data. With proportional spacing
  // two checkpoints can also land close together (the X2 walk ends 96, 100), so a label
  // is additionally dropped when it would collide with the one before it. The last
  // category always survives: it is the end of the walk.
  const every = Math.max(1, Math.ceil(count / 10));
  const last = spec.categories.length - 1;
  let previousX = Number.NEGATIVE_INFINITY;
  for (let c = 0; c < spec.categories.length; c++) {
    if (c % every !== 0 && c !== last) continue;
    const x = xAt(c);
    if (c !== last && x - previousX < MIN_LABEL_GAP) continue;
    // The final label wins its slot: drop the neighbour that would run into it.
    if (c === last && x - previousX < MIN_LABEL_GAP) frame.lines.pop();
    frame.lines.push(...categoryLabel(frame, x, spec.categories[c] ?? "", false));
    previousX = x;
  }

  return finishFrame(frame);
}

// ---------------------------------------------------------------------------
// quadrant scatter
// ---------------------------------------------------------------------------

/**
 * Cost against quality, one dot per tool (the `x-quadrant-*` charts).
 *
 * Modelled on Artificial Analysis' "Cost vs. Time per task": a shaded corner
 * where both axes are good, a dotted Pareto staircase separating what has been
 * achieved from what has not, and every dot labelled with the tool it is.
 *
 * The shaded corner is a *reading aid* at a fixed fraction of each axis, not a
 * threshold anybody measured, and the note says so. The Pareto staircase is
 * data: a point is on it when no other point is at least as cheap and at least
 * as good, with one of the two strictly better.
 */
export function scatterChart(spec: ScatterSpec): string {
  const yMax = spec.yMax ?? axisMax(spec.points.reduce((found, point) => Math.max(found, point.y), 0));
  const xMax = axisMax(spec.points.reduce((found, point) => Math.max(found, point.x), 0));
  const legend: LegendEntry[] = spec.points.map((point, index) => ({
    name: displayName(point.name),
    color: markColor(point.name, index),
    kind: "dot" as const,
    ...(spec.highlight === point.name ? { ring: true } : {}),
  }));
  for (const name of spec.absent ?? []) legend.push({ name: `${displayName(name)}: n/a`, color: null, kind: "dot" });
  legend.push({ name: "Most attractive quadrant", color: PALETTE[0] ?? TEXT_PRIMARY, kind: "swatch" });
  legend.push({ name: "Pareto line", color: TEXT_SECONDARY, kind: "rule" });

  const frame = startFrame({
    title: spec.title,
    subtitle: spec.subtitle,
    yLabel: spec.yLabel,
    xLabel: spec.xLabel,
    note: spec.note,
    width: spec.width,
    height: spec.height,
    max: yMax,
    legend,
    xMax,
    // The wash goes in before the grid and the marks, so nothing it covers is
    // hidden by it: it is the background of the corner, not a layer over data.
    quadrant: {
      xFraction: QUADRANT_X_FRACTION,
      yFraction: QUADRANT_Y_FRACTION,
      color: PALETTE[0] ?? TEXT_PRIMARY,
    },
  });

  // Space a label may not be placed in: the marks, and the Pareto line.
  const boxes: { x1: number; y1: number; x2: number; y2: number }[] = [];

  // The Pareto staircase: down from the top at the frontier's first point, then
  // right and down through every point nothing dominates, and out to the right
  // edge — everything under the line is dominated by something on it.
  const frontier = paretoFrontier(spec.points);
  if (frontier.length > 0) {
    const steps: string[] = [];
    const head = frontier[0] as ScatterPoint;
    steps.push(`${coord(frame.x(head.x))},${coord(frame.top)}`);
    for (const point of frontier) {
      steps.push(`${coord(frame.x(point.x))},${coord(frame.y(Math.min(point.y, yMax)))}`);
      // The horizontal leg to the right of each frontier point is where a label
      // would sit on top of the line; reserve it before any label is placed.
      boxes.push({
        x1: frame.x(point.x),
        y1: frame.y(Math.min(point.y, yMax)) - 5,
        x2: frame.right,
        y2: frame.y(Math.min(point.y, yMax)) + 5,
      });
    }
    const tail = frontier[frontier.length - 1] as ScatterPoint;
    steps.push(`${coord(frame.right)},${coord(frame.y(Math.min(tail.y, yMax)))}`);
    frame.lines.push(
      `<polyline points="${steps.join(" ")}" fill="none" stroke="${TEXT_SECONDARY}" stroke-width="2" stroke-dasharray="2 6"/>`,
    );
  }

  // Dots, then labels: every dot is drawn before any label, so a label can
  // never end up under a mark.
  for (let index = 0; index < spec.points.length; index++) {
    const point = spec.points[index];
    if (point === undefined) continue;
    const cx = frame.x(point.x);
    const cy = frame.y(Math.min(point.y, yMax));
    const ring = spec.highlight === point.name ? TEXT_PRIMARY : SURFACE;
    frame.lines.push(
      `<circle cx="${coord(cx)}" cy="${coord(cy)}" r="5" fill="${markColor(point.name, index)}" stroke="${ring}" stroke-width="2"/>`,
    );
    boxes.push({ x1: cx - 7, y1: cy - 7, x2: cx + 7, y2: cy + 7 });
  }
  for (let index = 0; index < spec.points.length; index++) {
    const point = spec.points[index];
    if (point === undefined) continue;
    const cx = frame.x(point.x);
    const cy = frame.y(Math.min(point.y, yMax));
    const text = displayName(point.name);
    const width = textWidth(text, 12);
    // Right of the dot when it fits and nothing is there; left when the plot
    // edge or another label is; above when both sides are taken. A label is
    // never clipped and never printed over another one.
    const candidates: { x: number; y: number; anchor: string; box: { x1: number; y1: number; x2: number; y2: number } }[] = [
      { x: cx + 12, y: cy + 4, anchor: "start", box: { x1: cx + 10, y1: cy - 8, x2: cx + 14 + width, y2: cy + 8 } },
      { x: cx - 12, y: cy + 4, anchor: "end", box: { x1: cx - 14 - width, y1: cy - 8, x2: cx - 10, y2: cy + 8 } },
      { x: cx, y: cy - 14, anchor: "middle", box: { x1: cx - width / 2, y1: cy - 26, x2: cx + width / 2, y2: cy - 10 } },
    ];
    const chosen =
      candidates.find(
        (candidate) =>
          candidate.box.x1 >= 4 &&
          candidate.box.x2 <= frame.width - 4 &&
          candidate.box.y1 >= frame.top - 18 &&
          !boxes.some((box) => overlaps(box, candidate.box)),
      ) ?? candidates[0] as (typeof candidates)[number];
    boxes.push(chosen.box);
    frame.lines.push(
      `<text x="${coord(chosen.x)}" y="${coord(chosen.y)}" fill="${TEXT_PRIMARY}" font-size="12" ` +
        `text-anchor="${chosen.anchor}">${esc(text)}</text>`,
    );
  }

  return finishFrame(frame);
}

function overlaps(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
): boolean {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

/**
 * The non-dominated points, left to right.
 *
 * Lower x is better and higher y is better, so `a` dominates `b` when it is at
 * least as cheap and at least as good and strictly better at one of the two.
 * Ties on both axes keep the first point in the input order, so the frontier is
 * a pure function of the input.
 */
export function paretoFrontier(points: readonly ScatterPoint[]): ScatterPoint[] {
  const kept = points.filter((point, index) =>
    !points.some((other, otherIndex) => {
      if (otherIndex === index) return false;
      const better = other.x <= point.x && other.y >= point.y;
      const strict = other.x < point.x || other.y > point.y;
      // A duplicate point does not dominate its twin; the earlier one wins.
      if (other.x === point.x && other.y === point.y) return otherIndex < index;
      return better && strict;
    }),
  );
  return [...kept].sort((a, b) => (a.x === b.x ? b.y - a.y : a.x - b.x));
}

// ---------------------------------------------------------------------------
// box
// ---------------------------------------------------------------------------

/** The P2 incremental-latency box plot (tech spec 10.9). */
export function boxChart(spec: BoxSpec): string {
  const highest = spec.boxes.reduce((found, box) => Math.max(found, box.high ?? box.q3, box.q3), 0);
  const max = spec.yMax ?? axisMax(highest);
  const frame = startFrame({
    title: spec.title,
    subtitle: spec.subtitle,
    yLabel: spec.yLabel,
    xLabel: undefined,
    note: spec.note,
    width: spec.width,
    height: spec.height,
    max,
    // One measurement of one tool, over its own scenarios: one colour for every
    // box, not a hue per row. Colouring by row would spend the identity channel
    // on information the axis already carries.
    legend: [],
  });

  const slots = Math.max(spec.boxes.length, 1);
  const slot = (frame.right - frame.left) / slots;
  const boxWidth = Math.min(slot * 0.5, BAR_MAX);
  const color = PALETTE[0] ?? TEXT_PRIMARY;

  for (let i = 0; i < spec.boxes.length; i++) {
    const box = spec.boxes[i];
    if (box === undefined) continue;
    const centre = frame.left + slot * i + slot / 2;
    const x = centre - boxWidth / 2;
    const top = frame.y(Math.min(box.q3, max));
    const bottomEdge = frame.y(Math.min(box.q1, max));

    if (box.high !== null) {
      const whisker = frame.y(Math.min(box.high, max));
      frame.lines.push(`<line x1="${coord(centre)}" y1="${coord(whisker)}" x2="${coord(centre)}" y2="${coord(top)}" stroke="${color}"/>`);
      frame.lines.push(`<line x1="${coord(centre - boxWidth / 4)}" y1="${coord(whisker)}" x2="${coord(centre + boxWidth / 4)}" y2="${coord(whisker)}" stroke="${color}"/>`);
    }
    if (box.low !== null) {
      const whisker = frame.y(Math.min(box.low, max));
      frame.lines.push(`<line x1="${coord(centre)}" y1="${coord(bottomEdge)}" x2="${coord(centre)}" y2="${coord(whisker)}" stroke="${color}"/>`);
      frame.lines.push(`<line x1="${coord(centre - boxWidth / 4)}" y1="${coord(whisker)}" x2="${coord(centre + boxWidth / 4)}" y2="${coord(whisker)}" stroke="${color}"/>`);
    }
    frame.lines.push(
      `<rect x="${coord(x)}" y="${coord(top)}" width="${coord(boxWidth)}" height="${coord(Math.max(bottomEdge - top, 1))}" ` +
        `fill="${color}" fill-opacity="0.22" stroke="${color}"/>`,
    );
    const mid = frame.y(Math.min(box.mid, max));
    frame.lines.push(`<line x1="${coord(x)}" y1="${coord(mid)}" x2="${coord(x + boxWidth)}" y2="${coord(mid)}" stroke="${color}" stroke-width="2"/>`);
    frame.lines.push(
      `<text x="${coord(centre)}" y="${coord(top - 8)}" fill="${TEXT_PRIMARY}" font-size="12" text-anchor="middle">${esc(displayValue(box.mid))}</text>`,
    );
    frame.lines.push(...categoryLabel(frame, centre, box.name, false, slot - 8));
  }

  return finishFrame(frame);
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

/**
 * The init directive every inline fence carries, so the Mermaid that GitHub
 * renders sits on the same black surface with the same three hues as the PNG
 * beside it. `plotColorPalette` is positional, which is why the series order
 * the fence prints is the order the SVG draws.
 */
export const MERMAID_DARK_INIT =
  '%%{init: {"theme": "dark", "themeVariables": {"xyChart": {"backgroundColor": "#000000", ' +
  '"titleColor": "#ffffff", "xAxisLabelColor": "#c3c2b7", "yAxisLabelColor": "#c3c2b7", ' +
  '"xAxisTitleColor": "#ffffff", "yAxisTitleColor": "#ffffff", ' +
  '"plotColorPalette": "#0fa976,#e0561c,#2f86ef"}}}}%%';

/**
 * The same data as an `xychart-beta` fence body, for inlining in `RESULTS.md`.
 *
 * Mermaid's xychart has no legend, no null and no gap: every series is a bare
 * list of numbers. That is a problem here, because a `0` in a benchmark chart is
 * a claim ("it scored nothing") and a missing measurement is not. So the fence
 * is built by omission rather than by substitution:
 *
 *  - a category no series measured is dropped from the x axis entirely;
 *  - a series with a hole in the middle is dropped whole, because shifting its
 *    remaining points left would silently redraw the curve;
 *  - every omission is named in a `%%` comment inside the fence, which Mermaid
 *    ignores and a reader does not.
 *
 * The PNG next to the fence draws the same data with real gaps, so nothing is
 * lost; the fence is the version that renders on GitHub with no image pipeline.
 */
export function mermaidXy(spec: ChartSpec, kind: "line" | "bar" = "line"): string {
  const finite = (value: number | null | undefined): value is number =>
    typeof value === "number" && Number.isFinite(value);

  // Categories anyone measured, in the original order.
  const kept: number[] = [];
  const droppedCategories: string[] = [];
  for (let i = 0; i < spec.categories.length; i++) {
    if (spec.series.some((one) => finite(one.values[i]))) kept.push(i);
    else droppedCategories.push(spec.categories[i] ?? String(i));
  }

  const rows: { name: string; values: number[] }[] = [];
  const droppedSeries: string[] = [];
  for (const one of spec.series) {
    const values = kept.map((i) => one.values[i]);
    if (values.length > 0 && values.every(finite)) rows.push({ name: one.name, values: values as number[] });
    else droppedSeries.push(one.name);
  }

  // Nothing was measured: an `xychart-beta` with an empty x axis does not parse,
  // and a fence that renders as a Mermaid error is worse than no fence. The
  // caller prints the caption and the PNG, which shows the empty plot honestly.
  if (rows.length === 0 || kept.length === 0) return "";

  const max = spec.yMax ?? axisMax(rows.reduce((found, row) => Math.max(found, ...row.values), 0));
  const lines = [MERMAID_DARK_INIT, "xychart-beta", `    title "${spec.title.replace(/"/g, "'")}"`];
  const axisLabel = spec.xLabel === undefined ? "" : `"${spec.xLabel.replace(/"/g, "'")}" `;
  lines.push(`    x-axis ${axisLabel}[${kept.map((i) => quoteCategory(spec.categories[i] ?? String(i))).join(", ")}]`);
  lines.push(`    y-axis "${(spec.yLabel ?? "").replace(/"/g, "'")}" 0 --> ${label(max)}`);
  for (const row of rows) lines.push(`    ${kind} [${row.values.map(label).join(", ")}]`);

  // `%%` is a Mermaid comment: it renders as nothing and reads as everything.
  const notes: string[] = [];
  if (rows.length > 0) notes.push(`%% series, in order: ${rows.map((row) => row.name).join(", ")}`);
  if (droppedCategories.length > 0) notes.push(`%% not measured, omitted from the x axis: ${droppedCategories.join(", ")}`);
  if (droppedSeries.length > 0) notes.push(`%% omitted (no data, or a gap Mermaid cannot draw): ${droppedSeries.join(", ")}`);
  if (spec.subtitle !== undefined) notes.push(`%% ${spec.subtitle}`);
  if (spec.note !== undefined) notes.push(`%% ${spec.note}`);
  return `${[...lines, ...notes.map((note) => `    ${note}`)].join("\n")}\n`;
}

/** Mermaid category tokens are bare words unless quoted; quote everything for safety. */
function quoteCategory(text: string): string {
  return `"${text.replace(/"/g, "'")}"`;
}

// ---------------------------------------------------------------------------
// rasterisation
// ---------------------------------------------------------------------------

/**
 * SVG to PNG through `@resvg/resvg-js`, with every ancillary chunk stripped.
 *
 * The renderer is constructed per call with a fixed configuration; nothing is
 * cached, because a cache keyed on anything but the SVG text would be a place
 * for non-determinism to hide.
 */
export function toPng(svg: string): Buffer {
  const { Resvg } = loadResvg();
  const resvg = new Resvg(svg, { font: { defaultFontFamily: "sans-serif" } });
  return stripPngMetadata(resvg.render().asPng());
}

/** The PNG chunks a committed chart is allowed to carry. */
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "pHYs"]);

/**
 * A PNG with every chunk but the pixels dropped.
 *
 * These files are committed, so anything the encoder decides to write about
 * itself — a `tEXt` signature, a `tIME` stamp, an `eXIf` block — is a byte that
 * can differ between two machines rendering the same chart, and a diff on a
 * binary nobody can read. `pHYs` survives because it is the pixel density a
 * retina display needs, and it is a constant of the image rather than of the
 * run. Dropping a chunk cannot invalidate another one: each carries its own
 * CRC over its own bytes.
 */
export function stripPngMetadata(png: Buffer): Buffer {
  const signature = png.subarray(0, 8);
  const kept: Buffer[] = [signature];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > png.length) break;
    if (PNG_KEEP.has(type)) kept.push(png.subarray(offset, end));
    offset = end;
  }
  return Buffer.concat(kept);
}

/** The chunk types a PNG carries, in file order. For the hygiene test. */
export function pngChunks(png: Buffer): string[] {
  const out: string[] = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    out.push(png.toString("ascii", offset + 4, offset + 8));
    offset += 12 + length;
  }
  return out;
}

interface ResvgModule {
  Resvg: new (svg: string, options?: { font?: { defaultFontFamily?: string } }) => {
    render(): { asPng(): Buffer };
  };
}

let resvgModule: ResvgModule | undefined;

/**
 * `@resvg/resvg-js` is a native addon, so it is required lazily: `report
 * --dry-run` renders no PNG and must work on a machine where the platform
 * binary did not install. The failure message names the dependency rather than
 * letting a `Cannot find module` escape from three frames down.
 */
function loadResvg(): ResvgModule {
  if (resvgModule !== undefined) return resvgModule;
  try {
    resvgModule = createRequire(import.meta.url)("@resvg/resvg-js") as ResvgModule;
  } catch (err) {
    throw new Error(
      `greplost: cannot load @resvg/resvg-js (bench dependency, needed to rasterise charts): ${(err as Error).message}`,
    );
  }
  return resvgModule;
}

/** Write `<dir>/<name>.svg` and `<dir>/<name>.png`; returns both absolute paths. */
export function writeChart(dir: string, name: string, svg: string): { svg: string; png: string } {
  mkdirSync(dir, { recursive: true });
  const svgPath = path.join(dir, `${name}.svg`);
  const pngPath = path.join(dir, `${name}.png`);
  writeFileSync(svgPath, svg);
  writeFileSync(pngPath, toPng(svg));
  return { svg: svgPath, png: pngPath };
}
