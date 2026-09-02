/**
 * The `bench/RESULTS.md` template (tech spec 10.9, 10.10; bench leaf 1.5.7).
 *
 * This file is pure: it takes a `ReportModel` — the numbers `report.ts` read out
 * of `bench/results/*.json` — and returns markdown. It never reads a file, never
 * asks the clock and never invents a value. That is the point of the split: the
 * rule from the tech spec is that the measured column is "filled by the harness,
 * never by hand", and the only way to keep that rule mechanically is for the
 * renderer to have no way of knowing anything the harness did not measure.
 *
 * Everything the model does not carry renders as `not run`. Not `0`, not `-`,
 * not a blank cell: a benchmark that did not run and a benchmark that scored
 * zero are different claims, and only one of them is a result (tech spec 10.0).
 *
 * Layout, in order, one `##` heading each:
 *
 *   Machine, Corpus, Versions, Head-to-head, Eval 1, Eval 2, Bench 3, Eval 4,
 *   Eval 5, Map quality
 *
 * The head-to-head table comes before the single-tool evals because that is the
 * order the README reads them in (tech spec 11, "README structure").
 */

// ---------------------------------------------------------------------------
// the model
// ---------------------------------------------------------------------------

/** The ten head-to-head ids, in table order (tech spec 3.1). */
export const X_IDS = ["X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8", "X9", "X10"] as const;
export type XId = (typeof X_IDS)[number];

/** The `##` headings, in document order. The gate counts these. */
export const SECTION_HEADERS = [
  "Machine",
  "Corpus",
  "Versions",
  "Head-to-head",
  "Eval 1",
  "Eval 2",
  "Bench 3",
  "Eval 4",
  "Eval 5",
  "Map quality",
] as const;

/** The string every unmeasured cell carries. One spelling, everywhere. */
export const NOT_RUN = "not run";

/** The string a cell carries when a tool structurally cannot be measured. */
export const NOT_APPLICABLE = "n/a";

export type Verdict = "win" | "loss" | "tie" | "na";

/** One tool's answer for one head-to-head metric. */
export interface MetricCell {
  /** The measurement. `null` means it was not produced; never a stand-in zero. */
  value: number | string | null;
  /** The section 3.1 target, repeated per cell so a row is self-describing. */
  target: string;
  /**
   * For `greplost`, the verdict against the target. For a competitor, greplost's
   * verdict *against that competitor*: `win` means greplost came out ahead.
   */
  verdict: Verdict;
  /** Required on `loss` and `na`; the publishing rule in tech spec 10.0. */
  reason: string;
  /** Machine-readable extras a chart can read (per-edge-kind precision, and so on). */
  detail?: Record<string, number>;
}

export interface MetricRow {
  id: string;
  title: string;
  target: string;
  tools: Record<string, MetricCell>;
}

/** One `ID | Metric | Target | Measured` row in a single-tool eval section. */
export interface EvalRow {
  id: string;
  metric: string;
  target: string;
  /** `null` renders as `not run`. */
  measured: string | null;
  /** Optional trailing detail column (counts, variance, denominators). */
  detail?: string;
}

export interface EvalSection {
  /** A per-repo or per-condition sub-heading; omitted when there is only one group. */
  groups: { name: string | null; rows: EvalRow[] }[];
  /** Free-form lines printed under the tables (truth notes, method, caveats). */
  notes: string[];
  /** Fenced Mermaid charts: `{ caption, body, png }`. */
  charts: ChartRef[];
  /** When the suite produced no result at all. */
  ran: boolean;
  /** `<date> at <sha>` of the result that filled this section. */
  provenance: string | null;
}

export interface ChartRef {
  caption: string;
  /** An `xychart-beta` body, already indented for a fence. Empty to omit the fence. */
  body: string;
  /** Repo-relative PNG path the document links, or null when there is no PNG. */
  png: string | null;
  /**
   * The SVG `report.ts` rasterises into that PNG. Not read by the renderer: it
   * travels on the model so that building the document and writing the images
   * stay one pass over the same data, and so `--dry-run` can skip the second
   * half without changing the first.
   */
  svg?: string;
}

/** One row of the `## Single-tool` summary: an id, its target, its measurement. */
export interface SummaryRow {
  id: string;
  metric: string;
  target: string;
  /** `null` renders as `not run`. Never a hand-typed value. */
  measured: string | null;
  /** Which suite and which corpus repo the measurement came from. */
  source: string;
}

/**
 * What a head-to-head run was measured on. Every field is optional because it
 * comes out of a payload, and a payload written by an older run may not carry it.
 */
export interface RunTarget {
  repo?: string;
  fixture?: boolean;
  tier?: string;
  /** Files the oracle loaded, which is the honest size of the thing measured. */
  files?: number;
  /** Commits walked, when the run walked any. */
  commits?: number;
}

/**
 * `Measured <date> at <sha> on <corpus> (<n> files, <m> commits).`
 *
 * The scale belongs next to the numbers. "greplost holds F1 1.000" reads as a
 * claim about software; "on fixtures/tiny-ts (12 files, 24 commits)" is what
 * makes it a measurement a reader can size. Tech spec 10.1 pins the corpus in
 * `RESULTS.md` for exactly this reason, and a head-to-head table that omits it
 * is the same table with the denominator hidden.
 */
export function provenanceLine(
  date: string | null,
  sha: string | null,
  target: RunTarget | undefined,
): string {
  const when = `Measured ${date ?? "an unknown date"} at ${sha ?? "an unknown commit"}`;
  if (target === undefined) return `${when}.`;

  const where = target.repo === undefined
    ? null
    : target.fixture === true
      ? `fixtures/${target.repo}`
      : target.tier === undefined
        ? target.repo
        : `${target.repo}, tier ${target.tier}`;

  const scale: string[] = [];
  if (typeof target.files === "number") scale.push(`${target.files} file${target.files === 1 ? "" : "s"}`);
  if (typeof target.commits === "number") scale.push(`${target.commits} commit${target.commits === 1 ? "" : "s"}`);

  return `${when}${where === null ? "" : ` on ${where}`}${scale.length === 0 ? "" : ` (${scale.join(", ")})`}.`;
}

/**
 * A target string with a tier claim it did not earn removed.
 *
 * Section 3.1 writes some targets against a tier ("<= 5s and $0 (tier M)").
 * Printing that verbatim beside a 12-file fixture number states a threshold the
 * run never tested, which is the same defect as an unlabelled measurement: the
 * reader compares a fixture result against a tier-M bar and concludes something
 * neither number supports. The tier clause is dropped and replaced with what was
 * actually run.
 */
export function scopeTarget(target: string, run: RunTarget | undefined): string {
  const match = /\s*\(tier ([A-Z]+)\)/.exec(target);
  if (match === null) return target;
  const wanted = match[1];
  if (run !== undefined && run.fixture !== true && run.tier === wanted) return target;
  const ran = run === undefined
    ? "not measured at that tier"
    : run.fixture === true
      ? `measured on fixtures/${run.repo ?? "the fixture"}, not tier ${wanted}`
      : `measured on ${run.repo ?? "another repo"}${run.tier === undefined ? "" : `, tier ${run.tier}`}, not tier ${wanted}`;
  return `${target.replace(match[0], "")} (${ran})`;
}

export interface ReportModel {
  machine: Record<string, unknown> | null;
  corpus: { name: string; sha?: string; tier?: string; lang?: string }[];
  versions: { name: string; value: string }[];
  headToHead: {
    tools: string[];
    rows: MetricRow[];
    ran: boolean;
    /** Already rendered by `provenanceLine`, so the scale travels with the date. */
    provenance: string | null;
    /** What the run was measured on, so a tier-scoped target can be checked. */
    target: RunTarget | undefined;
    charts: ChartRef[];
    notes: string[];
  };
  /**
   * The `## Single-tool` table: one row per section 3 id, flattened out of the
   * per-suite sections below. It exists because `scripts/sync-readme.ts` copies
   * this section and `## Head-to-head` into README.md between markers, so the
   * two of them have to stand on their own.
   */
  singleTool: { rows: SummaryRow[]; notes: string[] };
  sections: Record<"eval1" | "eval2" | "bench3" | "eval4" | "eval5" | "mapquality", EvalSection>;
  /** Anything the reader has to know about how this file was produced. */
  preamble: string[];
}

/** A section with nothing in it: every suite starts here and is filled if a result exists. */
export function emptySection(): EvalSection {
  return { groups: [], notes: [], charts: [], ran: false, provenance: null };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/** Render the whole document. Pure; the only entry point this module has. */
export function renderResultsMd(model: ReportModel): string {
  const out: string[] = [];
  out.push("# greplost benchmark results");
  out.push("");
  out.push(
    "Generated by `bun bench/src/cli.ts report` from the newest result file of each suite in " +
      "`bench/results/`. Every measured value in this file comes out of one of those payloads; " +
      "nothing here is typed by hand (tech spec 10.10). A suite with no result file renders as " +
      "`not run`, and a tool that could not be run renders as `n/a` with the reason, never as a zero.",
  );
  out.push("");
  for (const line of model.preamble) {
    out.push(line);
    out.push("");
  }

  out.push(...machineSection(model));
  out.push(...corpusSection(model));
  out.push(...versionsSection(model));
  out.push(...headToHeadSection(model));
  out.push(...singleToolSection(model));
  out.push(...evalSection("Eval 1", "Structural accuracy vs compiler truth (S1 to S4)", model.sections.eval1));
  out.push(...evalSection("Eval 2", "Freshness and sync under commit replay (F1, F2)", model.sections.eval2));
  out.push(...evalSection("Bench 3", "Performance (P1 to P3)", model.sections.bench3));
  out.push(...evalSection("Eval 4", "Agent navigation benchmark (A1 to A4)", model.sections.eval4));
  out.push(...evalSection("Eval 5", "Human navigation study (H1, H2)", model.sections.eval5));
  out.push(...evalSection("Map quality", "INDEX.md budget and diagram size (M1, M2)", model.sections.mapquality));

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function machineSection(model: ReportModel): string[] {
  const out = ["## Machine", ""];
  if (model.machine === null) {
    out.push(`${NOT_RUN}: no result file carried a machine profile.`, "");
    return out;
  }
  out.push("| Field | Value |", "|---|---|");
  for (const key of Object.keys(model.machine).sort()) {
    out.push(`| ${key} | ${cell(String(model.machine[key] ?? NOT_RUN))} |`);
  }
  out.push("");
  return out;
}

function corpusSection(model: ReportModel): string[] {
  const out = ["## Corpus", ""];
  if (model.corpus.length === 0) {
    out.push(`${NOT_RUN}: no result file named a corpus repo (a \`--fixture\` run scores \`fixtures/tiny-ts\`).`, "");
    return out;
  }
  out.push("| Repo | Tier | Lang | Pinned SHA |", "|---|---|---|---|");
  for (const repo of model.corpus) {
    out.push(`| ${cell(repo.name)} | ${cell(repo.tier ?? "-")} | ${cell(repo.lang ?? "-")} | ${cell(repo.sha ?? "-")} |`);
  }
  out.push("");
  return out;
}

function versionsSection(model: ReportModel): string[] {
  const out = ["## Versions", ""];
  if (model.versions.length === 0) {
    out.push(`${NOT_RUN}: no version was recorded.`, "");
    return out;
  }
  out.push("| Component | Version |", "|---|---|");
  for (const entry of model.versions) out.push(`| ${cell(entry.name)} | ${cell(entry.value)} |`);
  out.push("");
  return out;
}

function headToHeadSection(model: ReportModel): string[] {
  const { tools, rows, ran, provenance, charts, notes } = model.headToHead;
  const competitors = tools.filter((tool) => tool !== "greplost");
  const out = ["## Head-to-head", ""];
  out.push(
    "greplost against Graphify, Understand-Anything and code-review-graph (tech spec 3.1, 10.0). " +
      "The `vs` columns are greplost's verdict against that tool: `win` means greplost came out " +
      "ahead by the metric's margin, `tie` inside it, `loss` behind it, `n/a` when the tool could " +
      "not be run at all. Every loss and every `n/a` carries its reason.",
  );
  out.push("");
  if (!ran) {
    out.push(`The head-to-head suite has not been run: \`bun bench/src/cli.ts headtohead --fixture\`.`, "");
  } else if (provenance !== null) {
    out.push(provenance, "");
  }

  const header = ["ID", "Target", "Measured", ...competitors.map((tool) => `vs ${tool}`), "Reason on loss"];
  out.push(`| ${header.join(" | ")} |`);
  out.push(`|${header.map(() => "---").join("|")}|`);

  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of X_IDS) {
    const row = byId.get(id);
    const meta = METRIC_TITLES[id];
    const target = scopeTarget(row?.target ?? meta.target, model.headToHead.target);
    const measured = row === undefined ? NOT_RUN : formatCell(row.tools["greplost"]);
    const verdicts = competitors.map((tool) => (row === undefined ? NOT_RUN : verdictCell(row.tools[tool])));
    const reason = row === undefined ? "the head-to-head suite has not been run" : lossReasonsOf(row, competitors);
    out.push(`| ${id} | ${cell(target)} | ${cell(measured)} | ${verdicts.map(cell).join(" | ")} | ${cell(reason)} |`);
  }
  out.push("");

  for (const id of X_IDS) {
    const row = byId.get(id);
    if (row === undefined) continue;
    const detail = perToolLine(row, tools);
    if (detail !== null) out.push(`- **${id}** ${row.title}: ${detail}`);
  }
  out.push("");

  // The publishing rule (tech spec 10.0) is that every loss and every N/A
  // carries a reason. Losses are in the table column; the N/A reasons are here,
  // one entry per distinct reason, because otherwise the same sentence about a
  // tool with no headless CLI repeats in eight rows and nobody reads any of it.
  const naReasons = new Map<string, { ids: Set<string>; tools: Set<string> }>();
  for (const id of X_IDS) {
    const row = byId.get(id);
    if (row === undefined) continue;
    for (const tool of tools) {
      const entry = row.tools[tool];
      if (entry === undefined || entry.verdict !== "na" || entry.reason.length === 0) continue;
      const group = naReasons.get(entry.reason) ?? { ids: new Set<string>(), tools: new Set<string>() };
      group.ids.add(id);
      group.tools.add(tool);
      naReasons.set(entry.reason, group);
    }
  }
  if (naReasons.size > 0) {
    out.push("**Why a cell is n/a**", "");
    for (const [reason, group] of naReasons) {
      out.push(`- ${[...group.ids].join(", ")} (${[...group.tools].join(", ")}): ${cell(reason)}`);
    }
    out.push("");
  }
  out.push(...notes.map((note) => `> ${note}`));
  if (notes.length > 0) out.push("");
  out.push(...renderCharts(charts));
  return out;
}

/**
 * The flat section 3 table. Copied verbatim into README.md by the driver's
 * sync script, so it says everything it needs to say without the sections below
 * it: every id, its target, its measurement or `not run`, and where the number
 * came from.
 */
function singleToolSection(model: ReportModel): string[] {
  const out = ["## Single-tool", ""];
  out.push(
    "greplost measured against its own section 3 targets, one row per metric id. The measured column is " +
      "filled from `bench/results/*.json` by the harness and is never typed by hand (tech spec 10.10); a " +
      "metric whose suite has not run says `not run` rather than carrying a placeholder.",
  );
  out.push("");
  out.push("| ID | Metric | Target | Measured | Source |", "|---|---|---|---|---|");
  for (const row of model.singleTool.rows) {
    out.push(
      `| ${row.id} | ${cell(row.metric)} | ${cell(row.target)} | ${cell(row.measured ?? NOT_RUN)} | ${cell(row.source)} |`,
    );
  }
  out.push("");
  for (const note of model.singleTool.notes) out.push(`> ${note}`, "");
  return out;
}

function evalSection(heading: string, subtitle: string, section: EvalSection): string[] {
  const out = [`## ${heading}`, "", subtitle, ""];
  if (!section.ran) {
    out.push(`${NOT_RUN}.`, "");
    for (const note of section.notes) out.push(`> ${note}`, "");
    return out;
  }
  if (section.provenance !== null) out.push(section.provenance, "");
  for (const group of section.groups) {
    if (group.name !== null) out.push(`### ${group.name}`, "");
    out.push("| ID | Metric | Target | Measured | Detail |", "|---|---|---|---|---|");
    for (const row of group.rows) {
      out.push(
        `| ${row.id} | ${cell(row.metric)} | ${cell(row.target)} | ` +
          `${cell(row.measured ?? NOT_RUN)} | ${cell(row.detail ?? "")} |`,
      );
    }
    out.push("");
  }
  for (const note of section.notes) out.push(`> ${note}`, "");
  out.push(...renderCharts(section.charts));
  return out;
}

function renderCharts(charts: readonly ChartRef[]): string[] {
  const out: string[] = [];
  for (const chart of charts) {
    out.push(`**${chart.caption}**`, "");
    if (chart.body.length > 0) {
      out.push("```mermaid");
      out.push(chart.body.trimEnd());
      out.push("```");
      out.push("");
    } else {
      out.push(
        "_No inline chart: nothing in this chart was measured, and an `xychart-beta` fence with an empty " +
          "axis renders as a Mermaid error rather than as an empty plot._",
        "",
      );
    }
    if (chart.png !== null) {
      out.push(`![${chart.caption}](../${chart.png})`, "");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// cells
// ---------------------------------------------------------------------------

/** Escape a markdown table cell: a pipe or a newline would break the row. */
export function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function formatCell(cellValue: MetricCell | undefined): string {
  if (cellValue === undefined) return NOT_RUN;
  if (cellValue.value === null) return cellValue.verdict === "na" ? NOT_APPLICABLE : NOT_RUN;
  return typeof cellValue.value === "number" ? formatNumber(cellValue.value) : cellValue.value;
}

function verdictCell(cellValue: MetricCell | undefined): string {
  if (cellValue === undefined) return NOT_RUN;
  if (cellValue.verdict === "na") return NOT_APPLICABLE;
  const measured = cellValue.value === null ? "" : ` (${typeof cellValue.value === "number" ? formatNumber(cellValue.value) : cellValue.value})`;
  return `${cellValue.verdict}${measured}`;
}

/** Three decimals under 10, one under 1000, none above; matches the charts' labels. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return NOT_RUN;
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return String(Math.round(value));
  if (magnitude >= 10) return String(Math.round(value * 10) / 10);
  return String(Math.round(value * 1000) / 1000);
}

/**
 * The reason column: why greplost did not win this row.
 *
 * greplost's own reason is emitted whenever it is non-empty, whatever the
 * verdict. A `tie` against a *gap* target (X1 asks for +10 points on calls) is a
 * miss, and dropping its reason because the verdict was not the word "loss"
 * hides the one sentence that explains the row. Competitors' reasons are still
 * gated on `loss`, because a competitor's reason answers "how did it beat us",
 * which only exists when it did.
 */
function lossReasonsOf(row: MetricRow, competitors: readonly string[]): string {
  const parts: string[] = [];
  const ours = row.tools["greplost"];
  if (ours !== undefined && ours.reason.length > 0 && ours.verdict !== "na") parts.push(`greplost: ${ours.reason}`);
  for (const tool of competitors) {
    const entry = row.tools[tool];
    if (entry !== undefined && entry.verdict === "loss" && entry.reason.length > 0) parts.push(`${tool}: ${entry.reason}`);
  }
  return parts.join("; ");
}

/** The per-tool measured values, for the bullet list under the table. */
function perToolLine(row: MetricRow, tools: readonly string[]): string | null {
  const parts: string[] = [];
  for (const tool of tools) {
    const entry = row.tools[tool];
    if (entry === undefined) continue;
    parts.push(`${tool} ${formatCell(entry)}`);
  }
  return parts.length === 0 ? null : parts.join(", ");
}

// ---------------------------------------------------------------------------
// the metric catalogue
// ---------------------------------------------------------------------------

/**
 * Titles and targets for X1 to X10, verbatim from tech spec 3.1. They live here
 * as well as in `headtohead.ts` so an all-empty model still renders a complete,
 * self-describing table: a reader must be able to see what *would* be measured
 * before anything has been.
 */
export const METRIC_TITLES: Record<XId, { title: string; target: string }> = {
  X1: { title: "Structural precision vs compiler truth", target: ">= +10pt calls, >= +3pt imports" },
  X2: { title: "Staleness after 500 replayed commits", target: "greplost F1 >= 0.99" },
  X3: { title: "Cost to stay fresh over 500 commits", target: "<= 1% of ua, <= 20% of graphify" },
  X4: { title: "Reproducibility: two builds of one commit", target: "0 bytes differ" },
  X5: { title: "Diff signal after a one-line change", target: "<= 10 artifact lines" },
  X6: { title: "Cold start to first usable map", target: "<= 5s and $0 (tier M)" },
  X7: { title: "Agent structural tasks", target: "accuracy >= best, tool calls <= 50% of best" },
  X8: { title: "Orientation cost", target: "<= 50% of best competitor tokens" },
  X9: { title: "Reviewer task: spot the new cross-package dependency", target: "fastest, highest hit rate" },
  X10: { title: "Cross-repo blast radius in workspace mode", target: "works (capability, not a score)" },
};
