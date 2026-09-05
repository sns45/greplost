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
 * order the README reads them in (tech spec 11, "README structure"). Build 2 adds
 * "Languages, IaC and signals" between the single-tool summary and Eval 1: the
 * per-language view of the same structural payload, with the disclosure of what
 * each language's oracle is and what it cannot see.
 */

// Type-only, so nothing at runtime imports back into `report-payload.ts`, which
// imports `provenanceLine` from here.
import type { LangRow } from "./report-payload.ts";

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
  "Languages, IaC and signals",
  "Eval 1",
  "Eval 2",
  "Bench 3",
  "Eval 4",
  "Eval 5",
  "Map quality",
] as const;

/**
 * The `##` heading of build 2's per-language section. Exported because the gate,
 * the README sync and the tests all name the same string.
 */
export const LANG_SECTION_HEADER = "Languages, IaC and signals";

/**
 * The one sentence that keeps the published comparison honest.
 *
 * It sits directly under the X table because that is where a reader forms the
 * impression the sentence corrects: the head-to-head suite ran on TypeScript and
 * Go, no competitor adapter was ever pointed at a build-2 language, and the
 * per-language table further down is greplost against its own compiler truth
 * with no second arm (spec 5.4; PLAN.md ruling 2026-09-04).
 */
export const HEAD_TO_HEAD_SCOPE =
  "X1 to X10 cover TypeScript and Go only; build 2's languages are scored against their own compiler " +
  "truth in the single-tool table below, with no competitor arm.";

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
  /**
   * The run this row's numbers came from, when the table was assembled from
   * more than one.
   *
   * X1 and X5 want a whole corpus repo and X2 wants a commit walk, which are
   * different runs with different costs, so the head-to-head table is often
   * filled from two payloads. A single provenance line above such a table would
   * put one run's corpus under the other run's numbers, which is the same
   * defect as printing a tier-M target against a fixture — so the scale travels
   * on the row.
   */
  run?: RunTarget;
  /** `Measured … on …` for that run, already rendered. */
  runLabel?: string;
}

/** One `ID | Metric | Target | Measured` row in a single-tool eval section. */
export interface EvalRow {
  /** The run this row was measured on, when the section knows it. */
  run?: RunTarget;
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
  /**
   * Why there is no fence, when `body` is empty on purpose.
   *
   * The default sentence says the data was not measured, which is true of an
   * empty plot and wrong about a form Mermaid cannot draw at all (the quadrant
   * scatters). A chart that has numbers must not print a line saying it has none.
   */
  bodyNote?: string;
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
  /** The run this row was measured on, so a scale-bearing target can be checked. */
  run?: RunTarget;
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
  // A zero is "no walk was asked for", not "a walk of length zero": printing
  // `0 commits` beside a corpus reads as a measurement that was taken.
  if (typeof target.commits === "number" && target.commits > 0) {
    scale.push(`${target.commits} commit${target.commits === 1 ? "" : "s"}`);
  }

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
export function scopeTarget(target: string, run: RunTarget | undefined, scaleText?: string): string {
  const tier = /\s*\(tier ([A-Z]+)\)/.exec(target);
  if (tier !== null) {
    const wanted = tier[1];
    if (run !== undefined && run.fixture !== true && run.tier === wanted) return target;
    const ran = run === undefined
      ? "not measured at that tier"
      : run.fixture === true
        ? `measured on fixtures/${run.repo ?? "the fixture"}, not tier ${wanted}`
        : `measured on ${run.repo ?? "another repo"}${run.tier === undefined ? "" : `, tier ${run.tier}`}, not tier ${wanted}`;
    return `${target.replace(tier[0], "")} (${ran})`;
  }

  // A target written against a file count is the same claim in another shape.
  // Bench 3's P1 is "full build, 1k / 10k files" and P3 is "peak RSS at 10k
  // files"; printing either beside a 148-file run invites the reader to take a
  // 10k-file result from a number nobody measured at 10k (review round 2).
  const named = [...(scaleText ?? target).matchAll(/(\d+)k\s+files/g)].map((hit) => Number(hit[1]) * 1000);
  if (named.length === 0 || run === undefined || run.files === undefined) return target;
  // The *largest* scale the text names, not the smallest: "1k / 10k files" is
  // two claims, and a run that reached only the first has not earned the second.
  if (run.files >= Math.max(...named)) return target;
  return `${target} (${describeRun(run)})`;
}

/** `measured on anyq, tier S, 148 files` — the scale a row was actually taken at. */
function describeRun(run: RunTarget): string {
  const where = run.repo === undefined
    ? "measured on an unnamed corpus"
    : run.fixture === true
      ? `measured on fixtures/${run.repo}`
      : `measured on ${run.repo}${run.tier === undefined ? "" : `, tier ${run.tier}`}`;
  return run.files === undefined ? where : `${where}, ${run.files} file${run.files === 1 ? "" : "s"}`;
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
  /**
   * One row per language the structural payload scored (build 2). Empty when no
   * payload carried a `perLang` block, which is what a build-1 result looks like.
   */
  langs: LangRow[];
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
  out.push(...langsSection(model));
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
  } else {
    // One line per run that supplied a row, each naming the ids it supplied.
    // With a single run this is the one provenance sentence; with two it is the
    // only way the reader can tell which corpus each number was taken on.
    const byRun = new Map<string, string[]>();
    for (const row of rows) {
      const label = row.runLabel;
      if (label === undefined) continue;
      byRun.set(label, [...(byRun.get(label) ?? []), row.id]);
    }
    if (byRun.size > 1) {
      for (const [label, ids] of byRun) out.push(`- ${ids.join(", ")}: ${label}`);
      out.push("");
    } else if (provenance !== null) {
      out.push(provenance, "");
    }
  }

  const header = ["ID", "Target", "Measured", ...competitors.map((tool) => `vs ${tool}`), "Reason on loss"];
  out.push(`| ${header.join(" | ")} |`);
  out.push(`|${header.map(() => "---").join("|")}|`);

  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of X_IDS) {
    const row = byId.get(id);
    const meta = METRIC_TITLES[id];
    const target = scopeTarget(row?.target ?? meta.target, row?.run ?? model.headToHead.target);
    const measured = row === undefined ? NOT_RUN : formatCell(row.tools["greplost"]);
    const verdicts = competitors.map((tool) => (row === undefined ? NOT_RUN : verdictCell(row.tools[tool])));
    const reason = row === undefined ? "the head-to-head suite has not been run" : lossReasonsOf(row, competitors);
    out.push(`| ${id} | ${cell(target)} | ${cell(measured)} | ${verdicts.map(cell).join(" | ")} | ${cell(reason)} |`);
  }
  out.push("");

  // Directly under the table, before anything that reads like a caveat about the
  // numbers: the scope of the comparison is not a caveat, it is what the table is.
  out.push(HEAD_TO_HEAD_SCOPE, "");

  // One line, because the X1 row's two verdict kinds are not the same comparison and a
  // reader has no way to tell from the cells. The `vs <tool>` columns are decided on
  // call precision alone (tech spec 10.0's headline for X1); greplost's own cell is
  // decided against both halves of the section 3.1 target at once, +0.10 on calls *and*
  // +0.03 on imports, which is why it can read `tie` beside three `win`s.
  out.push(
    "> Reading the X1 row: each `vs <tool>` column is greplost against that tool on **call edge precision**, " +
      "the headline tech spec 10.0 names. greplost's own `Measured` verdict is against **both halves** of the " +
      "3.1 target at once (+0.10 on calls and +0.03 on imports), so it can be a `tie` in the same row where " +
      "every competitor column is a `win`.",
    "",
  );

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
    // The scale claim can sit in either column — P1's "1k / 10k files" is in the
    // metric, X6's "(tier M)" is in the target — so both are offered to
    // `scopeTarget`, and the qualifier lands in the target the reader compares
    // the measurement against.
    const target = scopeTarget(row.target, row.run, `${row.metric} ${row.target}`);
    out.push(
      `| ${row.id} | ${cell(row.metric)} | ${cell(target)} | ${cell(row.measured ?? NOT_RUN)} | ${cell(row.source)} |`,
    );
  }
  out.push("");
  for (const note of model.singleTool.notes) out.push(`> ${note}`, "");
  return out;
}

/**
 * The per-language table and its disclosures (spec 5.4).
 *
 * Two rules hold this section together. The first is the one every table in this
 * file obeys: a cell is a number a suite wrote to disk, an `n/a` a truth module
 * declared, or `not run`. The second is this section's own: **every language says
 * what its oracle is and what that oracle cannot see**, in prose, next to its
 * numbers. A benchmark that publishes 1.000 for a format whose oracle is the same
 * regular expression the extractor uses, or for a metric scored on an empty set,
 * is not reporting a result, and a reader has no way to tell the difference from
 * the digits alone (tech spec 10.1, principle 6).
 */
function langsSection(model: ReportModel): string[] {
  const out = [`## ${LANG_SECTION_HEADER}`, ""];
  const measured = model.langs.filter((row) => row.ran).length;
  const total = model.langs.length;
  // The opening sentence is a claim about coverage, so it counts. "Every
  // language greplost indexes, scored against its own compiler truth" is true
  // of a complete run and a lie about a payload set that reached six of ten,
  // and the reader has no way to check it except by counting rows (review I5).
  const opening =
    total === 0 || measured === total
      ? "Every language, IaC flavour and framework signal pass greplost indexes, scored against its own " +
        "compiler truth."
      : `${measured} of the ${total} languages the pinned corpus covers were measured by the payload set ` +
        "this document was built from. The rest carry `not run` rows: nothing here stands in for them, " +
        "and `bun run bench:structural --tier S --gate` is what fills them.";
  out.push(
    opening +
      " One row per language, filled from the structural payload's `perLang` block; " +
      "`Files` is the files greplost scored, which is not the file count the corpus pin's glob names " +
      "(a pinned `Dockerfile*` glob counts templates the indexer does not read). " +
      "`S1`, `S2`, `S3`, `S5` and `S6` are precision and `S4` is the cycle Jaccard, with recall, the " +
      "tp/fp/fn counts and the per-repo split in Eval 1 below. A language scored on more than one corpus " +
      "repo shows the **worst** of its repos, never an average: an average hides the weaker half, and the " +
      "worst repo is what the gate decided on. `n/a` is a metric this language's oracle does not measure, " +
      "either because it declared it unsupported or because it produced no number for it: never a pass, " +
      "never a fail. `n/a for <repo>` means only that repo's oracle sat the metric out and the value beside " +
      "it is the rest. No competitor was run on any of these languages.",
  );
  out.push("");

  if (model.langs.length === 0) {
    out.push(
      `${NOT_RUN}: no structural result carried a \`perLang\` block. Run ` +
        "`bun run bench:structural --tier S --gate` to fill this section.",
      "",
    );
    return out;
  }

  if (model.sections.eval1.provenance !== null) out.push(model.sections.eval1.provenance, "");

  const header = [
    "Lang",
    "Corpus",
    "Files",
    "S1 imports P",
    "S2 exports P",
    "S3 calls P",
    "S4 cycles J",
    "S5 reference edges P",
    "S6 signal nodes P",
    "Truth source",
    "Scored",
  ];
  out.push(`| ${header.join(" | ")} |`);
  out.push(`|${header.map(() => "---").join("|")}|`);
  for (const row of model.langs) {
    const cells = [
      row.lang,
      row.corpus.length === 0 ? NOT_RUN : row.corpus,
      row.files === null ? NOT_RUN : String(row.files),
      langCell(row, "S1", row.s1),
      langCell(row, "S2", row.s2),
      langCell(row, "S3", row.s3),
      langCell(row, "S4", row.s4),
      langCell(row, "S5", row.s5),
      langCell(row, "S6", row.s6),
      row.ran ? `\`${row.truthSource}\`` : NOT_RUN,
      !row.ran ? NOT_RUN : row.gated ? "gated" : "reported",
    ];
    out.push(`| ${cells.map(cell).join(" | ")} |`);
  }
  out.push("");

  out.push(...oracleDisclosures(model.langs));
  out.push(...vacuousDisclosures(model.langs));
  out.push(...substituteDisclosures(model.langs));
  return out;
}

/**
 * One metric's cell.
 *
 * `n/a` when every one of the language's oracles declared the metric unsupported,
 * or when the run scored the language and simply produced no number for it: the
 * suite prints "n/a, not measured by this oracle" for that second case, and
 * `not run` would say the language was never measured at all. `not run` is kept
 * for exactly that: a language in the payload whose repos carried no scores.
 *
 * A metric only *some* of a language's repos could not measure keeps its value
 * and names the repos that sat it out, because `yaml` is three oracles and a
 * chart's `n/a` must not erase two measured corpora.
 */
function langCell(row: LangRow, id: string, value: number | null): string {
  if (!row.ran) return NOT_RUN;
  if (row.na.includes(id)) return NOT_APPLICABLE;
  if (value === null) return row.files === null ? NOT_RUN : NOT_APPLICABLE;
  const base = row.vacuous.includes(id) ? `${formatNumber(value)} (vacuous)` : formatNumber(value);
  const sitting = row.partial[id];
  return sitting === undefined || sitting.length === 0 ? base : `${base} (n/a for ${sitting.join(", ")})`;
}

/**
 * The oracle paragraph for each language in the table.
 *
 * The four TypeScript dialects share one oracle and one paragraph, so they are
 * printed once under the langs they cover rather than four times.
 */
function oracleDisclosures(langs: readonly LangRow[]): string[] {
  const byKey = new Map<string, string[]>();
  // Only for a language this payload set measured: a paragraph about what an
  // oracle can and cannot see reads as a report on a run that happened.
  for (const row of langs.filter((entry) => entry.ran)) {
    const key = TS_FAMILY_LANGS.has(row.lang) ? "ts" : row.lang;
    byKey.set(key, [...(byKey.get(key) ?? []), row.lang]);
  }
  if (byKey.size === 0) return [];

  const out = ["**What each oracle is, and what it cannot see**", ""];
  for (const key of [...byKey.keys()].sort()) {
    const covered = (byKey.get(key) ?? []).sort();
    const text = ORACLE_DISCLOSURES[key];
    out.push(
      `- **${covered.join(", ")}**: ${
        text ??
        "this report has no disclosure written for that language; read `bench/src/truth/` for what its " +
          "oracle does, and treat the row above as unlabelled until one is added here."
      }`,
    );
  }
  out.push("");
  return out;
}

/** Metrics whose 1.000 was measured on an empty universe, named per language. */
function vacuousDisclosures(langs: readonly LangRow[]): string[] {
  const rows = langs.filter((row) => row.vacuous.some((id) => !row.na.includes(id)));
  if (rows.length === 0) return [];
  const out = ["**Metrics scored on an empty set**", ""];
  out.push(
    "A metric whose true positives, false positives and false negatives are all zero was scored on an " +
      "empty universe: the 1.000 means there was nothing to be wrong about, not that everything was " +
      "right. It is marked `(vacuous)` in the table and is not evidence of accuracy.",
    "",
  );
  for (const row of rows) {
    const ids = row.vacuous.filter((id) => !row.na.includes(id)).sort();
    out.push(`- **${row.lang}** (${row.corpus}): ${ids.join(", ")}.`);
  }
  out.push("");
  return out;
}

/** What gates a language whose every gated metric is `n/a` (spec 5.2). */
function substituteDisclosures(langs: readonly LangRow[]): string[] {
  const rows = langs.filter((row) => row.substitute !== null);
  if (rows.length === 0) return [];
  const out = ["**What gates a language with no accuracy gate**", ""];
  out.push(
    "A target whose every gated metric is `n/a` would pass `--gate` on an extractor that returned " +
      "nothing, so the gate becomes three substitute checks instead: the snapshot is byte-identical when " +
      "built twice, fewer than 1% of the files carry a root-level parse error, and every non-empty file " +
      "yields at least one declaration or import.",
    "",
  );
  for (const row of rows) {
    const checks = row.substitute;
    if (checks === null) continue;
    out.push(
      `- **${row.lang}** (${row.corpus}): deterministic rebuild ${checks.deterministic ? "pass" : "FAIL"}, ` +
        `parse error rate ${checks.errorRate === null ? NOT_RUN : formatNumber(checks.errorRate)}, ` +
        `silent files ${checks.silentCount === null ? NOT_RUN : String(checks.silentCount)}.`,
    );
  }
  out.push("");
  return out;
}

/** The four dialects one TypeScript oracle covers. */
const TS_FAMILY_LANGS: ReadonlySet<string> = new Set(["ts", "tsx", "js", "jsx"]);

/**
 * What each language's oracle is, and what it structurally cannot see.
 *
 * Every tag in these paragraphs is a `NOTES` entry a truth module emits, so a
 * reader can grep `bench/src/truth/` for it and find the code that made the
 * choice. They are written here rather than derived because a tag is a name and
 * this is the sentence the name stands for; the tags a *run* actually recorded
 * are printed from the payload under Eval 1.
 */
const ORACLE_DISCLOSURES: Record<string, string> = {
  ts:
    "`bench/src/truth/ts.ts` for S1 to S4 (the TypeScript compiler's own checker) and " +
    "`bench/src/truth/signals-ts.ts` for S5 and S6 (`tsc-checker-oracle`, `base-type-chain-for-pulumi`, " +
    "`app-router-path-rules`). Two disclosed emulations: `workspace-entry-mapping` stands in for the " +
    "installed-and-built state a corpus checkout does not have, and `nearest-tsconfig-resolution` " +
    "resolves a specifier with the compiler options of the nearest `tsconfig.json` above the importing " +
    "file, but only after resolution from the repo root has failed, because a corpus of independent " +
    "example apps keeps its path aliases there and the root config knows none of them. The pinned Pulumi subset " +
    "is `aws-ts-*/**/*.ts`, which admits TypeScript only: the JavaScript and `.tsx` files in those " +
    "examples are outside the scored set, so **build 1's CommonJS handling has no corpus coverage at " +
    "all** (`.js` is parsed with the TypeScript grammar, and nothing in this benchmark measures that).",
  go:
    "`bench/src/truth/go.ts` for S1 to S4 (`go/packages` per-file imports and a class-hierarchy call " +
    "graph) and `bench/src/truth/signals-pulumi-go.ts` for S5 and S6 (`go-types-oracle`, a resource " +
    "being a type that implements Pulumi's resource interface). `cha-over-approximation`: " +
    "class-hierarchy analysis resolves an interface call to every implementation of the method, so the " +
    "oracle's call set is an upper bound and the recall measured against it is a lower bound. " +
    "`helper-attribution-differs`: a resource built inside a helper function is filed under the file the " +
    "constructor is written in, by the map and by the oracle alike, so the two agree and neither loses a " +
    "point; a reader of a program that calls that helper from `main.go` will nonetheless find the " +
    "resource under the helper's file rather than the call site, and S5 and S6 are both scored per file. " +
    "`test-files-not-loaded`: the loader runs with tests off, so a `_test.go` file is outside the covered " +
    "universe entirely and the resources a program's unit tests construct are scored by neither side. A " +
    "package the loader cannot build is dropped from truth rather than scored, so part of the Pulumi Go " +
    "corpus is in greplost's map with no oracle opinion about it; the run prints how many on stderr.",
  python:
    "`bench/src/truth/python.ts`: `pytruth`, CPython's own `ast` module on Python 3.11 or newer " +
    "(`ast-only`, `python>=3.11`). It reads source and never executes an import " +
    "(`no-import-execution`), so a module reached through `importlib`, a module-level `__getattr__` or " +
    "a runtime `sys.path` edit is in neither side; PEP 420 namespace packages are resolved by directory " +
    "(`pep420-namespace-packages`).",
  rust:
    "`bench/src/truth/rust.ts`: `rusttruth`, a `syn` re-implementation of the extractor's rules " +
    "(`syn-item-tree`, `cargo-metadata-roots`), **not** `rustc`, which has no stable public " +
    "name-resolution API. `rule-agreement-oracle`: S1 to S4 on Rust measure two independent " +
    "implementations of one rule set agreeing (a different parser, a different language, no shared " +
    "line of code) and not agreement with a compiler, so a rule that is wrong in the specification is " +
    "wrong on both sides and scores 1.000. `no-trait-dispatch`: a method call on a generic or `dyn` " +
    "receiver is absent from truth exactly as it is absent from the map, because neither side does type " +
    "inference, so that whole class of call is unmeasured rather than measured and missed.",
  java:
    "`bench/src/truth/java.ts`: `javac`'s own Tree API (`javac-tree-api`) on a source-only classpath " +
    "(`source-classpath-only`). Third-party jars are deliberately absent, so a file whose dependency is " +
    "a jar does not compile and is dropped from truth instead of scored (`unresolved-files-dropped`): " +
    "those files are in greplost's map with no oracle opinion about them, and the run prints how many " +
    "on stderr. `no-overload-resolution`: a call is matched to a method by name, so two overloads of " +
    "one name are one target on both sides. `no-inherited-dispatch`: a call that lands on a member " +
    "inherited from a supertype is attributed to the type that declares it, not to the receiver's type. " +
    "`module-info-not-scored`: `module-info.java` declares a module rather than a type and carries no " +
    "scored declaration. The pinned gson subset `**/src/main/**` spans several Maven modules and " +
    "includes `gson/src/main/java-templates`, a templating-maven-plugin source root whose " +
    "`GsonBuildConfig.java` Maven filters into the build directory: both sides read the template copy, " +
    "so gson resolves that dependency inside its own source tree rather than against generated sources.",
  kotlin:
    "`bench/src/truth/kotlin.ts`: **reported-only** (`reported-only`, `fixture-oracle-only`, " +
    "`no-corpus-compiler-truth`). A real `kotlinc` plus `javap -v` classfile oracle covers " +
    "`fixtures/tiny-kotlin` and nothing else: there is **no corpus compiler truth** for Kotlin, because " +
    "`kotlin-compiler-embeddable`'s PSI and FIR APIs are internal and unstable and compiling a Gradle " +
    "multiplatform corpus outside Gradle is not reliable (Appendix C, 2026-09-04). Every corpus metric " +
    "is therefore `n/a` and the run is gated on the three substitute checks below. Kotlin's accuracy " +
    "numbers in this repository are fixture numbers: a smoke test, not accuracy against a compiler. " +
    "JVM synthetics are dropped and a property access is not a call (`jvm-synthetics-dropped`, " +
    "`property-access-not-a-call`). Two disagreements with the map are measured rather than papered " +
    "over: `internal-class-is-public-in-bytecode` (an `internal` class stays public in the bytecode, so " +
    "the oracle calls it exported where the map does not) and `object-protocol-overrides-dropped` " +
    "(`equals`, `hashCode` and `toString` are dropped because every data class generates them, which " +
    "drops a hand-written override with them).",
  hcl:
    "`bench/src/truth/hcl.ts`: `tfinspect`, built on `terraform-config-inspect` and `hclsyntax` " +
    "(`terraform-config-inspect`, `hclsyntax-traversals`). `same-rules-different-parser`: references " +
    "and nodes are scored against an independent re-implementation of the same rules on a different " +
    "parser, not against Terraform's own evaluator, so S5 and S6 measure two implementations agreeing. " +
    "`no-call-edges`: HCL has no calls at all, so S3 is `n/a` rather than 0, because there is nothing " +
    "for either side to be right or wrong about.",
  yaml:
    "`bench/src/truth/yaml.ts`, dispatching by flavour (`yaml-flavour-dispatch`) to `yaml-k8s.ts`, " +
    "`yaml-helm.ts` and `yaml-actions.ts`, all reading with `js-yaml` (`js-yaml-oracle`) and, for a " +
    "chart, `helm template` (`helm-template-render`). A manifest, a chart and a workflow have no call " +
    "site, no import statement and therefore no import cycle, so S1, S3 and S4 are `n/a` rather than a " +
    "1.000 found by looking for nothing; S2, S5 and S6 are the objects, the reference edges and the node " +
    "ids, and they are measured and gated. Helm: a " +
    "template is not valid YAML, so every `{{ ... }}` span is blanked in place before parsing and a " +
    "templated name falls back to the document index, which is why names are not compared for templates " +
    "(`names-not-compared-for-templates`): a chart's node ids are scored, but the *name* inside one is a " +
    "document index rather than the name a real render would give it. `same-regex-both-sides`: a " +
    "chart's `.Values.<path>` references are found by one regular expression that both sides apply, so " +
    "S5 on Helm measures that regex against itself and not two independent implementations. " +
    "`if-else-arms-both-kept`: blanking keeps both arms of an `if`/`else`, so a chart's document set " +
    "holds documents a real render would produce only one of. Workflows: a `${{ ... }}` value is chosen " +
    "when the workflow runs and is never a name in the map; `anchors-not-expanded` means `js-yaml` " +
    "resolves anchors and merge keys while greplost reads the text as written, so a workflow using one " +
    "is scored as the divergence it is; and `config-precision-unmeasured` means the `config` reference " +
    "kind, which points a `run:` body at a script in the repo, has no corpus-scale measurement at all, " +
    "because a YAML target indexes YAML only and the target of such an edge is never a scored file. It " +
    "is covered by `fixtures/tiny-actions` and the extractor tests, and by nothing in this table.",
  dockerfile:
    "`bench/src/truth/dockerfile.ts`: an independent Dockerfile AST reader (`dockerfile-ast-oracle`). " +
    "`same-rules-different-parser`: the same rules read by a different parser, not by BuildKit, so this " +
    "is rule agreement rather than builder truth. The format has no call site, no import statement and " +
    "therefore no import cycle, so S1, S3 and S4 are `n/a` rather than a 1.000 found by looking for " +
    "nothing; S2, S5 and S6 are the stage names, the reference edges and the node ids, which is " +
    "everything a Dockerfile actually says, and they are measured and gated. The two " +
    "pinned corpora are honestly **below the tier-S band**: no public repository carries a hundred " +
    "Dockerfiles, and `docker-python` and `docker-node` together are the realistic ceiling for the " +
    "format.",
};

/**
 * One line of English for every `NOTES` tag a build-2 truth module can emit, so
 * Eval 1 can print the run's own tags without sending the reader to the source.
 *
 * It lives here, next to the per-language paragraphs, because the two say the
 * same things at two lengths and drifting apart would be worse than repeating
 * them. `report-evals.ts` spreads this map into its own, which keeps build 1's
 * four entries where they were written.
 */
export const TRUTH_NOTE_GLOSS: Record<string, string> = {
  "unsupported:S1": "the truth module declares that it does not measure import edges, so S1 is `n/a` for it.",
  "unsupported:S2": "the truth module declares that it does not measure exports, so S2 is `n/a` for it.",
  "unsupported:S3":
    "the truth module declares that it does not measure call edges (the format has none), so S3 is `n/a`, " +
    "which is neither a pass nor a fail.",
  "unsupported:S4": "the truth module declares that it does not measure import cycles, so S4 is `n/a` for it.",
  "unsupported:S5": "the truth module declares that it does not measure reference edges, so S5 is `n/a` for it.",
  "unsupported:S6": "the truth module declares that it does not measure signal nodes, so S6 is `n/a` for it.",
  "reported-only":
    "the oracle cannot measure this target at all, so every metric is `n/a` and the run is gated on the " +
    "three substitute checks instead (Kotlin, Appendix C 2026-09-04).",
  "ast-only": "the Python oracle reads the source with CPython's `ast` module and never runs the code.",
  "no-import-execution":
    "no import is executed, so a module reached through `importlib`, a module-level `__getattr__` or a " +
    "runtime `sys.path` edit is in neither the map nor the truth.",
  "pep420-namespace-packages": "PEP 420 namespace packages are resolved by directory rather than by `__init__.py`.",
  "python>=3.11": "the oracle needs Python 3.11 or newer for the `ast` fields it reads.",
  "syn-item-tree": "the Rust oracle walks `syn`'s item tree rather than a compiler's resolved graph.",
  "cargo-metadata-roots": "crate roots come from `cargo metadata`.",
  "no-trait-dispatch":
    "a method call on a generic or `dyn` receiver is in neither side, because neither does type inference: " +
    "that class of call is unmeasured rather than measured and missed.",
  "rule-agreement-oracle":
    "the oracle re-implements the extractor's rules on a different parser instead of asking a compiler " +
    "(`rustc` has no stable public name-resolution API), so the metric is two independent implementations " +
    "of one rule set agreeing, not agreement with the compiler.",
  "javac-tree-api": "the Java oracle reads `javac`'s own Tree API, not a re-implementation.",
  "source-classpath-only":
    "the classpath is the corpus sources alone: third-party jars are deliberately absent.",
  "unresolved-files-dropped":
    "a file that does not compile on that source-only classpath is dropped from truth rather than scored, so " +
    "it is in greplost's map with no oracle opinion about it; the run prints how many on stderr.",
  "no-overload-resolution":
    "a call is matched to a method by name, so two overloads of one name are one target on both sides.",
  "no-inherited-dispatch":
    "a call that lands on a member inherited from a supertype is attributed to the type that declares it, " +
    "not to the receiver's type.",
  "module-info-not-scored": "`module-info.java` declares a module rather than a type and carries no scored declaration.",
  "fixture-oracle-only": "the oracle covers the fixture only; there is no corpus-scale run of it.",
  "no-corpus-compiler-truth":
    "no compiler truth exists for this language's corpus, so its corpus numbers are `n/a` and its accuracy " +
    "numbers come from the fixture alone.",
  "kotlinc-javap-classfiles": "the Kotlin fixture oracle compiles with `kotlinc` and reads the classfiles with `javap -v`.",
  "jvm-synthetics-dropped": "JVM synthetic members the compiler generates are dropped rather than scored.",
  "property-access-not-a-call": "a Kotlin property access is not counted as a call, on either side.",
  "terraform-config-inspect": "the Terraform oracle is built on `terraform-config-inspect`.",
  "hclsyntax-traversals": "reference edges come from `hclsyntax`'s own traversal set.",
  "no-call-edges": "the format has no call edges at all, so S3 is `n/a` rather than 0.",
  "same-rules-different-parser":
    "both sides implement the same documented rules with different parsers, so the metric measures two " +
    "implementations agreeing rather than agreement with the format's own tooling.",
  "yaml-flavour-dispatch": "YAML files are split by flavour (Kubernetes manifest, Helm chart, Actions workflow) and each flavour has its own oracle.",
  "js-yaml-oracle": "the YAML oracle parses with `js-yaml`, independently of the tree-sitter grammar greplost uses.",
  "anchors-not-expanded":
    "`js-yaml` resolves anchors, aliases and merge keys and greplost reads the text as written, so a " +
    "workflow that uses one is a real divergence and is scored as one rather than papered over.",
  "config-precision-unmeasured":
    "the `config` reference kind has no corpus-scale measurement: a YAML target is indexed with " +
    "`languages: [\"yaml\"]`, so a `run:` body naming a script resolves to nothing on either side and the " +
    "edge falls outside S5. It is covered by the fixture and the extractor tests only.",
  "internal-class-is-public-in-bytecode":
    "Kotlin mangles an `internal` member to `name$module`, which the oracle drops, but an `internal` " +
    "class stays public in the bytecode, so the oracle calls it exported where the map does not: a known " +
    "S2 false positive on the truth side.",
  "object-protocol-overrides-dropped":
    "`equals`, `hashCode` and `toString` at their standard descriptors are dropped because every data " +
    "class generates them, which drops a hand-written override with them: a known S2 false negative on " +
    "the truth side.",
  "helm-template-render": "chart truth comes from `helm template`; greplost never runs helm.",
  "names-not-compared-for-templates":
    "a templated name falls back to the document index, so names are not compared for a chart's templates.",
  "same-regex-both-sides":
    "a chart's `.Values.<path>` references are found by one regular expression that both sides apply, so S5 " +
    "on Helm measures that regex against itself rather than two independent implementations.",
  "if-else-arms-both-kept":
    "blanking a template's `{{ ... }}` spans keeps both arms of an `if`/`else`, so a chart's document set " +
    "holds documents a real render would produce only one of.",
  "dockerfile-ast-oracle": "the Dockerfile oracle reads an independent Dockerfile AST, not BuildKit's.",
  "go-packages-per-file-imports": "Go import edges come from `go/packages`, per file.",
  "tsc-checker-oracle": "the signal oracle asks the TypeScript compiler's checker, not the extractor's heuristics.",
  "base-type-chain-for-pulumi": "a Pulumi resource is recognised by walking the base type chain in the checker.",
  "app-router-path-rules": "the Next.js App Router path rules are re-implemented independently of the extractor.",
  "go-types-oracle": "the Pulumi Go oracle loads the program with `go/types`.",
  "types-implements-pulumi-resource": "a resource is a type that implements Pulumi's resource interface, decided by the type checker.",
  "helper-attribution-differs":
    "a resource built inside a helper function is filed under the file the constructor is written in, by the " +
    "map and by the oracle alike, so the two agree and neither loses a point; but a reader of a program that " +
    "calls that helper from `main.go` will find the resource under the helper's file rather than the call " +
    "site, and both S5 and S6 are scored per file.",
  "test-files-not-loaded":
    "the Go loader runs with tests off, so `_test.go` files are outside the covered universe entirely: a " +
    "Pulumi program's unit tests construct resources, and none of those are scored.",
};

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
        `_${chart.bodyNote ?? "No inline chart: nothing in this chart was measured, and an `xychart-beta` fence " +
          "with an empty axis renders as a Mermaid error rather than as an empty plot."}_`,
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
