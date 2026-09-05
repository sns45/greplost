/**
 * The `## Head-to-head` table and the `## Single-tool` summary (bench leaf 1.5.7).
 *
 * These two are the sections a reader is asked to trust first, and they are the
 * two whose numbers come from somewhere else: the head-to-head from every
 * head-to-head payload on disk, and the single-tool summary from the per-suite
 * sections that were already built rather than re-derived. The remaining
 * sections (Eval 1 to Eval 5, Bench 3, Map quality) are in `report-evals.ts`.
 *
 * Nothing in this file writes a number that did not come out of a payload
 * through `report-payload.ts`. That is the mechanical half of tech spec 10.10's
 * "filled by the harness, never by hand".
 */
import {
  METRIC_TITLES,
  NOT_APPLICABLE,
  X_IDS,
  type EvalRow,
  type EvalSection,
  type MetricCell,
  type MetricRow,
  type ReportModel,
  type SummaryRow,
  type XId,
} from "./results-md.ts";
import {
  arr,
  competitors,
  firstNum,
  fmt,
  num,
  provenanceOf,
  rec,
  str,
  targetOf,
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
          : {
              id,
              metric: found.metric,
              target: found.target,
              measured: found.measured,
              source: where,
              // Carried through so the summary can qualify a scale-bearing
              // target with the scale it was actually measured at.
              ...(found.run === undefined ? {} : { run: found.run }),
            },
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
    `F2 rests on ${f2Denominator(replay)}. It compares the structure artifacts that \`listStructurePaths\` ` +
      "enumerates, `INDEX.md`, `manifest.json`, `graph/*.jsonl`, `repo/*.md`, `packages/*/{MAP,API}.md` and " +
      "`packages/*/modules/**`, and not the whole `.greplost/` directory: `config.json`, `cache/` and the " +
      "runtime files (`.dirty`, `.lock`, `.state.json`) are excluded, because they are not the map and are " +
      "not committed (ruling 2026-09-02).",
    "`unparsable` counts files whose tree-sitter parse root is an ERROR node or has one as a direct child: " +
      "the top level of the file is not a program the grammar recognises (`findUnparsableFiles` in " +
      "`@greplost/core`, Appendix C ruling 2026-09-03). The extractor recovers around ERROR nodes, so these " +
      "files are still scored, which is the problem: whatever the grammar could not read costs S1 and S2 " +
      "recall with no line saying so unless it is counted here. tree-sitter-typescript 0.23.2 is the newest " +
      "grammar that exists, and hono's generic call signatures hit open upstream issue " +
      "https://github.com/tree-sitter/tree-sitter-typescript/issues/335. The count is read from the " +
      "structural payload when it reports one, and otherwise derived from it, a file every one of whose " +
      "truth items was missed is a file nothing was extracted from, and it is `n/a` with `not measured` " +
      "when the payload carries neither. Nothing about it is asserted here.",
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
 * How many full-vs-incremental comparisons F2's `0%` rests on.
 *
 * "0% divergence" is a rate, and a rate with a hidden denominator is the weakest claim in
 * the table pretending to be the strongest: one comparison and fifty read identically in
 * the measured column. The replay suite runs a full rebuild every `--f2-every` commits,
 * so the count is the number the reader has to see (review round 3, minor).
 */
function f2Denominator(replay: Payload | null): string {
  if (replay === null) return "no comparison yet: the replay suite has not run";
  const checks = firstNum(replay.data, ["f2Checks", "summary.f2Checks"]);
  const commits = firstNum(replay.data, ["commits", "summary.commits", "commitCount"]);
  if (checks === null) return "an unrecorded number of full-vs-incremental comparisons";
  const walk = commits === null ? "" : ` over a walk of ${fmt(commits)} commits`;
  return `${fmt(checks)} full-vs-incremental comparison${checks === 1 ? "" : "s"}${walk}`;
}

/**
 * The unparsable-files row.
 *
 * Three sources, in order, and never a fourth: the payload's own count under
 * any of the names the extractor might use; a count derived from the payload,
 * files every one of whose truth items was missed, which is what "nothing was
 * extracted from this file" looks like in a score sheet; and `n/a` with `not
 * measured`. The third branch used to carry a sentence about the extractor's
 * error recovery being in progress, which is a claim about the code and not a
 * reading of a payload, exactly the hand-filled cell tech spec 10.10 forbids.
 */
function unparsableRow(structural: Payload | null): SummaryRow {
  const reported = structural === null ? null : firstNum(structural.data, [
    "unparsable.count",
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
    metric: "files whose tree-sitter parse is broken at the root level",
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
  M1: "<= 3,000 tokens at 10k files",
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
  // What the X2 walk is, stated at render time rather than read out of a payload.
  //
  // The suite records it in its own method list, but a payload written before that
  // sentence existed carries the old wording, and the disclosure a reader most needs,
  // that the history is generated, one added import per commit, with no deletions and no
  // renames, must not depend on which run last touched `bench/results/` (review round 3,
  // important 8). It is a fact about how this harness builds every X2 walk, so it is true
  // of every X2 row the table can show.
  if (rows.some((row) => row.id === "X2")) {
    notes.push(
      "X2: the commit walk is **synthetic**. It is generated over the corpus repo's pinned checkout rather " +
        "than replayed from its real history: each commit appends exactly one resolvable import line to one " +
        "file, so truth moves by exactly one edge per commit, and the walk contains no deletions, no renames " +
        "and no new files, the easy direction for an incremental updater. Tech spec 10.0 X2 asks for 500 " +
        "real commits of a corpus checkout; that is not what was run.",
    );
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
