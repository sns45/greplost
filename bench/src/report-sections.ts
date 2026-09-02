/**
 * Building one `RESULTS.md` section per suite (bench leaf 1.5.7).
 *
 * Each function here turns one payload into an `EvalSection`: the section 3
 * target-vs-measured rows for its ids, the notes that qualify them, and the
 * charts that belong beside them. A payload that is absent produces a section
 * that says `not run` and names the command that would fill it; a payload whose
 * shape this reader cannot follow produces the same thing plus a note saying so.
 *
 * Nothing in this file writes a number that did not come out of a payload
 * through `report-payload.ts`. That is the mechanical half of tech spec 10.10's
 * "filled by the harness, never by hand".
 */
import { boxChart, groupedBarChart, lineChart, mermaidXy, type BoxDatum, type ChartSpec } from "./charts.ts";
import {
  METRIC_TITLES,
  NOT_APPLICABLE,
  X_IDS,
  emptySection,
  type ChartRef,
  type EvalRow,
  type EvalSection,
  type MetricCell,
  type MetricRow,
  type ReportModel,
  type SummaryRow,
  type XId,
} from "./results-md.ts";
import {
  agentCategories,
  arr,
  competitors,
  firstNum,
  firstStr,
  fmt,
  num,
  provenanceOf,
  rec,
  replayF1,
  replayF2,
  scenariosOf,
  str,
  targetOf,
  type ConditionStats,
  type Payload,
} from "./report-payload.ts";
import { headToHeadCharts } from "./report-charts.ts";

/**
 * The `## Single-tool` rows, lifted out of the per-suite sections that were just
 * built rather than re-derived from the payloads. Building them twice is how a
 * summary table and the table it summarises come to disagree.
 */
export function singleTool(
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
    "`unparsable` counts files whose tree-sitter parse returns an ERROR root node, which the extractor " +
      "cannot read at all. They are not scored in S1 or S2, so they cost recall silently unless they are " +
      "counted here. The count is read from the structural payload when it reports one, and otherwise " +
      "derived from it — a file every one of whose truth items was missed is a file nothing was extracted " +
      "from — and it is `n/a` with `not measured` when the payload carries neither. Nothing about it is " +
      "asserted here. Upstream: https://github.com/tree-sitter/tree-sitter-typescript/issues/335.",
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
 * The unparsable-files row.
 *
 * Three sources, in order, and never a fourth: the payload's own count under
 * any of the names the extractor might use; a count derived from the payload —
 * files every one of whose truth items was missed, which is what "nothing was
 * extracted from this file" looks like in a score sheet; and `n/a` with `not
 * measured`. The third branch used to carry a sentence about the extractor's
 * error recovery being in progress, which is a claim about the code and not a
 * reading of a payload — exactly the hand-filled cell tech spec 10.10 forbids.
 */
function unparsableRow(structural: Payload | null): SummaryRow {
  const reported = structural === null ? null : firstNum(structural.data, [
    "unparsable",
    "unparsableFiles",
    "parseErrors",
    "errorFiles",
    "truth.unparsable",
  ]);
  const derived = reported === null ? derivedUnparsable(structural) : null;
  const count = reported ?? derived;
  return {
    id: "unparsable",
    metric: "files whose tree-sitter parse root is ERROR (excluded from S1 and S2)",
    target: "0",
    // `n/a` rather than `not run`: the files exist and were skipped, which is a
    // different claim from "this metric was never measured". The count itself is
    // only ever read out of the payload (ruling 2026-09-02).
    measured: count === null ? NOT_APPLICABLE : String(Math.round(count)),
    source: reported !== null
      ? "Eval 1, `structural`"
      : derived !== null
        ? "Eval 1, `structural` (derived: files where every truth item was missed)"
        : "not measured: the structural payload reports no unparsable count and carries no per-file truth totals to derive one from",
  };
}

/**
 * Files where every truth item was missed, summed over the payload's repos.
 *
 * Needs per-file truth totals beside per-file misses; a payload that carries
 * only flat false-negative lists cannot answer the question, and this returns
 * null rather than guessing from the list's length (a file with one missed edge
 * out of forty would otherwise be counted as unreadable).
 */
function derivedUnparsable(structural: Payload | null): number | null {
  if (structural === null) return null;
  const repos = rec(structural.data["repos"]);
  if (repos === null) return null;
  let total = 0;
  let sawAny = false;
  for (const repo of Object.values(repos)) {
    const entry = rec(repo);
    if (entry === null) continue;
    const perFile = rec(entry["perFile"]) ?? rec(entry["fileScores"]);
    if (perFile === null) continue;
    for (const value of Object.values(perFile)) {
      const file = rec(value);
      if (file === null) continue;
      const truth = num(file["truth"]) ?? num(file["truthItems"]) ?? num(file["expected"]);
      const missed = num(file["missed"]) ?? num(file["fn"]) ?? num(file["falseNegatives"]);
      if (truth === null || missed === null || truth <= 0) continue;
      sawAny = true;
      if (missed >= truth) total++;
    }
  }
  return sawAny ? total : null;
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

// ---------------------------------------------------------------------------
// head-to-head
// ---------------------------------------------------------------------------

/**
 * The head-to-head section, assembled from every head-to-head payload on disk.
 *
 * One run rarely fills the table. X1, X4, X5 and X6 want a whole corpus repo;
 * X2 and X3 want a commit walk, which is a different repo and an order of
 * magnitude more time. `--metrics` exists so the two can be run apart, and a
 * cell a run did not select records that as its reason. This reader therefore
 * takes each id from the newest payload that actually measured it, and carries
 * that payload's corpus and scale on the row, so the table can never print one
 * run's numbers under another run's denominator.
 */
export function headToHeadFrom(
  payloads: readonly Payload[],
  replay: Payload | null,
  assetsRel: string,
): ReportModel["headToHead"] {
  if (payloads.length === 0) return headToHead(null, replay, assetsRel);
  // Newest last on disk (`latestResult` orders by name); newest first here.
  const ordered = [...payloads].reverse();
  const primary = ordered[0] as Payload;
  const base = headToHead(primary, replay, assetsRel);
  if (ordered.length === 1) return base;

  // Seeded empty rather than from the primary: every row has to carry the run
  // it came from, the primary's included, or a two-run table shows one
  // provenance line and silently attributes half its numbers to the wrong repo.
  const byId = new Map<string, MetricRow>();
  for (const payload of ordered) {
    const contributed = headToHead(payload, replay, assetsRel);
    const target = targetOf(payload);
    const label = provenanceOf(payload);
    for (const row of contributed.rows) {
      const held = byId.get(row.id);
      // The newest payload that measured this id wins; a payload that skipped
      // it (`--metrics`) or could not read it never displaces a real number.
      if (held !== undefined && measuredAtAll(held)) continue;
      if (!measuredAtAll(row) && held !== undefined) continue;
      // A row nobody measured belongs to no run: attributing X7 to whichever
      // payload was read last would put a corpus behind an `n/a`.
      const attributed = measuredAtAll(row);
      byId.set(row.id, {
        ...row,
        ...(target === undefined || !attributed ? {} : { run: target }),
        ...(label === null || !attributed ? {} : { runLabel: label }),
      });
    }
  }
  const rows = X_IDS.map((id) => byId.get(id)).filter((row): row is MetricRow => row !== undefined);

  // Notes and charts follow the rows, not the primary payload: the hero chart
  // is X2's, wherever X2 came from.
  const x2Payload = ordered.find((payload) => {
    const metrics = rec(payload.data["metrics"]);
    const entry = metrics === null ? null : rec(metrics["X2"]);
    return entry !== null && measuredAtAll(rowOf("X2", entry, base.tools));
  });
  const notes = new Set<string>(base.notes);
  for (const payload of ordered) {
    for (const line of arr(payload.data["method"]).filter((n): n is string => typeof n === "string")) notes.add(line);
  }
  return {
    ...base,
    rows,
    notes: [...notes],
    // The fallback target only matters for a row with no run of its own; each
    // chart prefers the run recorded on the row it draws.
    charts: headToHeadCharts(rows, replay, assetsRel, targetOf(x2Payload ?? primary)),
  };
}

/** Did any tool get a real number on this row, or is every cell an n/a? */
function measuredAtAll(row: MetricRow): boolean {
  return Object.values(row.tools).some((cell) => cell.verdict !== "na" || cell.value !== null);
}

/** One row out of a payload's `metrics` entry, for the X2 lookup above. */
function rowOf(id: string, entry: Record<string, unknown>, tools: readonly string[]): MetricRow {
  const cells: Record<string, MetricCell> = {};
  const toolCells = rec(entry["tools"]) ?? {};
  for (const tool of tools) {
    const cellRecord = rec(toolCells[tool]);
    if (cellRecord === null) continue;
    cells[tool] = {
      value: (typeof cellRecord["value"] === "number" || typeof cellRecord["value"] === "string")
        ? (cellRecord["value"] as number | string)
        : null,
      target: str(cellRecord["target"]) ?? "",
      verdict: asVerdict(cellRecord["verdict"]),
      reason: str(cellRecord["reason"]) ?? "",
    };
  }
  return { id, title: "", target: "", tools: cells };
}

export function headToHead(payload: Payload | null, replay: Payload | null, assetsRel: string): ReportModel["headToHead"] {
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

  const target = targetOf(payload);
  return {
    tools: toolList,
    rows,
    ran: payload !== null,
    provenance: provenanceOf(payload),
    target,
    charts: headToHeadCharts(rows, replay, assetsRel, target),
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
// Eval 1: structural
// ---------------------------------------------------------------------------

export function eval1Section(payload: Payload | null): EvalSection {
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

export function eval2Section(payload: Payload | null): EvalSection {
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

export function bench3Section(payload: Payload | null, assetsRel: string): EvalSection {
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

export function eval4Section(payload: Payload | null, assetsRel: string): EvalSection {
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

export function eval5Section(payload: Payload | null): EvalSection {
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

export function mapqualitySection(payload: Payload | null): EvalSection {
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
