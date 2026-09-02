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
 *  - the element order is the argument order.
 *
 * Rasterisation uses `@resvg/resvg-js` with its default font resolution. Glyph
 * rendering therefore depends on the fonts installed on the machine that ran
 * the report — that is a property of the PNG, not of the SVG, and the SVG is
 * what the golden test locks. `RESULTS.md` links the PNG and inlines a Mermaid
 * `xychart-beta` fence of the same data (`mermaidXy`), so a reader who cannot
 * see the image still gets the numbers on GitHub with no image pipeline.
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
  boxes: readonly BoxDatum[];
  yLabel?: string;
  yMax?: number;
  note?: string;
  width?: number;
  height?: number;
}

// ---------------------------------------------------------------------------
// palette and geometry
// ---------------------------------------------------------------------------

/**
 * Fixed, ordered palette. Index 0 is always greplost in every head-to-head
 * chart, so the hero chart's colour means the same thing as the X1 chart's.
 * Chosen for contrast in greyscale print as well as on screen.
 */
export const PALETTE: readonly string[] = ["#1d4ed8", "#ea580c", "#0f766e", "#a21caf", "#4d7c0f", "#b91c1c"];

const INK = "#111827";
const MUTED = "#6b7280";
const GRID = "#e5e7eb";
const AXIS = "#9ca3af";
const PAPER = "#ffffff";

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 380;
const PAD_LEFT = 64;
const PAD_RIGHT = 20;
const PAD_TOP = 58;
const PAD_BOTTOM = 58;
/** Number of gaps between y gridlines; five lines, four intervals. */
const Y_INTERVALS = 4;
/** Baseline-to-baseline distance for a wrapped note line. */
const NOTE_LINE_HEIGHT = 13;
/** Average advance of the 10px note font, in pixels. Deliberately conservative. */
const NOTE_CHAR_WIDTH = 5.2;

/** How many characters of the note font fit across the canvas, minus margins. */
function noteWidth(width: number): number {
  return Math.max(20, Math.floor((width - 40) / NOTE_CHAR_WIDTH));
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

/** Kills the 0.30000000000000004 class of float noise before a number is printed. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
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
  lines: string[];
  /** Value -> y pixel. */
  y(value: number): number;
}

function startFrame(
  opts: {
    title: string;
    yLabel: string | undefined;
    xLabel: string | undefined;
    note: string | undefined;
    width: number | undefined;
    height: number | undefined;
    max: number;
    legend: readonly { name: string; color: string }[];
  },
): Frame {
  const width = opts.width ?? DEFAULT_WIDTH;
  // The note is the part of a benchmark chart that says what was left out, so it
  // is wrapped and the canvas grows for it rather than being clipped at the
  // right edge. A caveat nobody can read is a caveat nobody was given.
  const noteLines = opts.note === undefined ? [] : wrapText(opts.note, noteWidth(width));
  const height = (opts.height ?? DEFAULT_HEIGHT) + Math.max(0, noteLines.length - 1) * NOTE_LINE_HEIGHT;
  const left = PAD_LEFT;
  const right = width - PAD_RIGHT;
  const top = PAD_TOP;
  const bottom = height - PAD_BOTTOM - Math.max(0, noteLines.length - 1) * NOTE_LINE_HEIGHT;
  const max = opts.max;

  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" font-family="sans-serif" font-size="12">`,
  );
  lines.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${PAPER}"/>`);
  lines.push(`<text x="20" y="26" font-size="15" font-weight="bold" fill="${INK}">${esc(opts.title)}</text>`);

  // Legend: one swatch and one name per series, laid out left to right at a
  // fixed pitch so the geometry does not depend on text metrics.
  let legendX = 20;
  for (const entry of opts.legend) {
    lines.push(`<rect x="${coord(legendX)}" y="38" width="10" height="10" fill="${entry.color}"/>`);
    lines.push(`<text x="${coord(legendX + 15)}" y="47" fill="${MUTED}">${esc(entry.name)}</text>`);
    legendX += 30 + entry.name.length * 7;
  }

  const y = (value: number): number => bottom - (value / max) * (bottom - top);

  // Gridlines and y tick labels.
  for (let i = 0; i <= Y_INTERVALS; i++) {
    const value = round6((max * i) / Y_INTERVALS);
    const at = coord(y(value));
    lines.push(`<line x1="${left}" y1="${at}" x2="${right}" y2="${at}" stroke="${GRID}"/>`);
    lines.push(`<text x="${left - 8}" y="${coord(y(value) + 4)}" fill="${MUTED}" font-size="11" text-anchor="end">${label(value)}</text>`);
  }

  // Axes on top of the grid.
  lines.push(`<line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="${AXIS}"/>`);
  lines.push(`<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="${AXIS}"/>`);

  if (opts.yLabel !== undefined) {
    lines.push(
      `<text x="18" y="${coord((top + bottom) / 2)}" fill="${MUTED}" font-size="11" text-anchor="middle" ` +
        `transform="rotate(-90 18 ${coord((top + bottom) / 2)})">${esc(opts.yLabel)}</text>`,
    );
  }
  if (opts.xLabel !== undefined) {
    lines.push(
      // Anchored to the plot, not to the canvas: the note below can be one line
      // or four, and the axis label must clear it either way.
      `<text x="${coord((left + right) / 2)}" y="${coord(bottom + 34)}" fill="${MUTED}" font-size="11" text-anchor="middle">${esc(opts.xLabel)}</text>`,
    );
  }
  for (let i = 0; i < noteLines.length; i++) {
    const y = height - 8 - (noteLines.length - 1 - i) * NOTE_LINE_HEIGHT;
    lines.push(`<text x="20" y="${coord(y)}" fill="${MUTED}" font-size="10">${esc(noteLines[i] ?? "")}</text>`);
  }

  return { width, height, left, right, top, bottom, max, lines, y };
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

function legendOf(series: readonly Series[]): { name: string; color: string }[] {
  return series.map((one, index) => ({ name: one.name, color: PALETTE[index % PALETTE.length] ?? INK }));
}

/** Category tick label, drawn under the plot at `x`. */
function categoryLabel(frame: Frame, x: number, text: string): string {
  return `<text x="${coord(x)}" y="${coord(frame.bottom + 16)}" fill="${MUTED}" font-size="11" text-anchor="middle">${esc(text)}</text>`;
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
  const frame = startFrame({
    title: spec.title,
    yLabel: spec.yLabel,
    xLabel: spec.xLabel,
    note: spec.note,
    width: spec.width,
    height: spec.height,
    max,
    legend: series.length > 1 ? legendOf(series) : [],
  });

  const slots = Math.max(spec.categories.length, 1);
  const slot = (frame.right - frame.left) / slots;
  const groupWidth = slot * 0.72;
  const barWidth = series.length > 0 ? groupWidth / series.length : groupWidth;

  for (let c = 0; c < spec.categories.length; c++) {
    const slotLeft = frame.left + slot * c + (slot - groupWidth) / 2;
    for (let s = 0; s < series.length; s++) {
      const value = series[s]?.values[c];
      const x = slotLeft + barWidth * s;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        // "not measured" is a dashed outline at the axis, not a bar of height 0.
        frame.lines.push(
          `<rect x="${coord(x)}" y="${coord(frame.bottom - 8)}" width="${coord(barWidth - 2)}" height="8" ` +
            `fill="none" stroke="${AXIS}" stroke-dasharray="2 2"/>`,
        );
        frame.lines.push(
          `<text x="${coord(x + barWidth / 2)}" y="${coord(frame.bottom - 12)}" fill="${MUTED}" font-size="10" text-anchor="middle">n/a</text>`,
        );
        continue;
      }
      const top = frame.y(Math.min(value, max));
      frame.lines.push(
        `<rect x="${coord(x)}" y="${coord(top)}" width="${coord(barWidth - 2)}" height="${coord(frame.bottom - top)}" ` +
          `fill="${PALETTE[s % PALETTE.length] ?? INK}"/>`,
      );
      // A bar at the top of the axis has no room above it for its own label, and
      // the space it would use belongs to the legend. Those labels go inside the
      // bar instead, in the paper colour.
      const tight = top - 4 < frame.top + 8;
      frame.lines.push(
        `<text x="${coord(x + barWidth / 2)}" y="${coord(tight ? top + 13 : top - 4)}" ` +
          `fill="${tight ? PAPER : INK}" font-size="10" text-anchor="middle">${label(value)}</text>`,
      );
    }
    frame.lines.push(categoryLabel(frame, frame.left + slot * c + slot / 2, spec.categories[c] ?? ""));
  }

  return finishFrame(frame);
}

// ---------------------------------------------------------------------------
// line
// ---------------------------------------------------------------------------

/**
 * One polyline per series: the X2 staleness curve and the build-time chart.
 *
 * A run of `null`s breaks the line into segments rather than interpolating over
 * a gap, and a series with no finite value at all draws nothing — which is how
 * the hero chart shows "greplost only" honestly (tech spec 10.9).
 */
export function lineChart(spec: ChartSpec): string {
  const max = spec.yMax ?? axisMax(peak(spec.series));
  const frame = startFrame({
    title: spec.title,
    yLabel: spec.yLabel,
    xLabel: spec.xLabel,
    note: spec.note,
    width: spec.width,
    height: spec.height,
    max,
    legend: legendOf(spec.series),
  });

  const count = Math.max(spec.categories.length, 1);
  const step = count > 1 ? (frame.right - frame.left) / (count - 1) : 0;
  const xAt = (index: number): number => (count > 1 ? frame.left + step * index : (frame.left + frame.right) / 2);

  for (let s = 0; s < spec.series.length; s++) {
    const one = spec.series[s];
    if (one === undefined) continue;
    const color = PALETTE[s % PALETTE.length] ?? INK;
    let segment: string[] = [];
    const flush = (): void => {
      if (segment.length >= 2) {
        frame.lines.push(`<polyline points="${segment.join(" ")}" fill="none" stroke="${color}" stroke-width="2"/>`);
      } else if (segment.length === 1) {
        // A single point is still data; draw it as a dot so it is not lost.
        const [x = "0", y = "0"] = (segment[0] ?? "").split(",");
        frame.lines.push(`<circle cx="${x}" cy="${y}" r="3" fill="${color}"/>`);
      }
      segment = [];
    };
    for (let c = 0; c < count; c++) {
      const value = one.values[c];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        flush();
        continue;
      }
      segment.push(`${coord(xAt(c))},${coord(frame.y(Math.min(value, max)))}`);
    }
    flush();
  }

  // Category labels are thinned so a 500-commit x axis stays readable; the
  // divisor is derived from the count, so it does not depend on the data.
  const every = Math.max(1, Math.ceil(count / 10));
  for (let c = 0; c < spec.categories.length; c++) {
    if (c % every !== 0 && c !== spec.categories.length - 1) continue;
    frame.lines.push(categoryLabel(frame, xAt(c), spec.categories[c] ?? ""));
  }

  return finishFrame(frame);
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
    yLabel: spec.yLabel,
    xLabel: undefined,
    note: spec.note,
    width: spec.width,
    height: spec.height,
    max,
    legend: [],
  });

  const slots = Math.max(spec.boxes.length, 1);
  const slot = (frame.right - frame.left) / slots;
  const boxWidth = Math.min(slot * 0.5, 60);

  for (let i = 0; i < spec.boxes.length; i++) {
    const box = spec.boxes[i];
    if (box === undefined) continue;
    const centre = frame.left + slot * i + slot / 2;
    const x = centre - boxWidth / 2;
    const color = PALETTE[i % PALETTE.length] ?? INK;
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
        `fill="${color}" fill-opacity="0.18" stroke="${color}"/>`,
    );
    const mid = frame.y(Math.min(box.mid, max));
    frame.lines.push(`<line x1="${coord(x)}" y1="${coord(mid)}" x2="${coord(x + boxWidth)}" y2="${coord(mid)}" stroke="${color}" stroke-width="2"/>`);
    frame.lines.push(
      `<text x="${coord(centre)}" y="${coord(top - 6)}" fill="${INK}" font-size="10" text-anchor="middle">${label(box.mid)}</text>`,
    );
    frame.lines.push(categoryLabel(frame, centre, box.name));
  }

  return finishFrame(frame);
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

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
  const lines = ["xychart-beta", `    title "${spec.title.replace(/"/g, "'")}"`];
  const axisLabel = spec.xLabel === undefined ? "" : `"${spec.xLabel.replace(/"/g, "'")}" `;
  lines.push(`    x-axis ${axisLabel}[${kept.map((i) => quoteCategory(spec.categories[i] ?? String(i))).join(", ")}]`);
  lines.push(`    y-axis "${(spec.yLabel ?? "").replace(/"/g, "'")}" 0 --> ${label(max)}`);
  for (const row of rows) lines.push(`    ${kind} [${row.values.map(label).join(", ")}]`);

  // `%%` is a Mermaid comment: it renders as nothing and reads as everything.
  const notes: string[] = [];
  if (rows.length > 0) notes.push(`%% series, in order: ${rows.map((row) => row.name).join(", ")}`);
  if (droppedCategories.length > 0) notes.push(`%% not measured, omitted from the x axis: ${droppedCategories.join(", ")}`);
  if (droppedSeries.length > 0) notes.push(`%% omitted (no data, or a gap Mermaid cannot draw): ${droppedSeries.join(", ")}`);
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
 * SVG to PNG through `@resvg/resvg-js`.
 *
 * The renderer is constructed per call with a fixed configuration; nothing is
 * cached, because a cache keyed on anything but the SVG text would be a place
 * for non-determinism to hide.
 */
export function toPng(svg: string): Buffer {
  const { Resvg } = loadResvg();
  const resvg = new Resvg(svg, { font: { defaultFontFamily: "sans-serif" } });
  return resvg.render().asPng();
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
