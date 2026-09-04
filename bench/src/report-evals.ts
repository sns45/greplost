/**
 * One `RESULTS.md` section per single-tool suite (bench leaf 1.5.7).
 *
 * Eval 1 to Eval 5, Bench 3 and Map quality. Each function turns one payload
 * into an `EvalSection`: the section 3 target-vs-measured rows for its ids, the
 * notes that qualify them, and the charts that belong beside them. A payload
 * that is absent produces a section that says `not run` and names the command
 * that would fill it; a payload whose shape this reader cannot follow produces
 * the same thing plus a note saying so.
 *
 * Nothing here writes a number that did not come out of a payload through
 * `report-payload.ts`. That is the mechanical half of tech spec 10.10's
 * "filled by the harness, never by hand". Split out of `report-sections.ts`,
 * which keeps the head-to-head table and the single-tool summary.
 */
import { boxChart, groupedBarChart, lineChart, mermaidXy, type BoxDatum, type ChartSpec } from "./charts.ts";
import { structuralAccuracyChart } from "./report-charts.ts";
import {
  emptySection,
  type EvalRow,
  type EvalSection,
  type RunTarget,
} from "./results-md.ts";
import {
  agentCategories,
  arr,
  firstNum,
  firstStr,
  fmt,
  num,
  provenanceOf,
  rec,
  replayF1,
  replayF2,
  runFor,
  scenariosOf,
  str,
  targetOf,
  type ConditionStats,
  type Payload,
} from "./report-payload.ts";

// ---------------------------------------------------------------------------
// Eval 1: structural
// ---------------------------------------------------------------------------

export function eval1Section(payload: Payload | null, assetsRel = "docs/assets"): EvalSection {
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
    const run = runFor(name, files);
    const withRun = (row: EvalRow): EvalRow => (run === undefined ? row : { ...row, run });
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
    ].map(withRun);
    // The two integrity flags from `structural.ts`. They are misses in their own
    // right, so they belong in the table, not in a footnote nobody reads.
    if (repo["truthEmpty"] === true) {
      section.notes.push(`${name}: the compiler truth was empty, so its S1 to S4 scores are meaningless (\`truth-empty\`).`);
    }
    if (repo["noFiles"] === true) {
      section.notes.push(`${name}: greplost indexed no file of the repo's language, so its scores are vacuous (\`no-files\`).`);
    }
    section.groups.push({ name: files === null ? name : `${name} (${fmt(files)} files)`, rows });

    // One chart, for the first repo in sorted order: a second one would need a
    // second slug, and the table below already carries every repo.
    if (section.charts.length === 0) {
      const chart = structuralAccuracyChart(
        name,
        files,
        [
          { id: "S1", label: "S1 imports P", value: num(rec(repo["S1"])?.["precision"]) },
          { id: "S1", label: "S1 imports R", value: num(rec(repo["S1"])?.["recall"]) },
          { id: "S2", label: "S2 exports P", value: num(rec(repo["S2"])?.["precision"]) },
          { id: "S2", label: "S2 exports R", value: num(rec(repo["S2"])?.["recall"]) },
          { id: "S3", label: "S3 calls P", value: num(rec(repo["S3"])?.["precision"]) },
          { id: "S3", label: "S3 calls R", value: num(rec(repo["S3"])?.["recall"]) },
          { id: "S4", label: "S4 cycles J", value: num(repo["S4"]) },
        ],
        assetsRel,
      );
      if (chart !== null) section.charts.push(chart);
    }
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
  "nearest-tsconfig-resolution":
    "the TypeScript truth generator resolved a specifier with the compiler options of the nearest `tsconfig.json` " +
    "above the importing file, and only after standard resolution from the repo root had failed to land on a file " +
    "already in the scored set; a corpus of independent example apps (TanStack `examples/`, Next.js `examples/`) " +
    "keeps its path aliases there and the root config knows none of them (leaf 2.3 ruling).",
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

/** The `run` field for a perf row, from the scenario it was read out of. */
function runOfScenario(scenario: { repo: string | null; files: number | null } | undefined): { run?: RunTarget } {
  if (scenario === undefined) return {};
  const run = runFor(scenario.repo, scenario.files);
  return run === undefined ? {} : { run };
}

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
  const largest = scenarios.reduce<(typeof scenarios)[number] | undefined>(
    (best, s) => ((s.files ?? 0) > (best?.files ?? 0) ? s : best),
    undefined,
  ) ?? full;

  section.groups.push({
    name: null,
    rows: [
      {
        id: "P1",
        metric: "full build, 1k / 10k files",
        target: "<= 1s / <= 10s",
        measured: full?.p50 == null ? null : `${fmt(full.p50)} ms (p50)`,
        detail: full === undefined ? "" : `scenario \`${full.name}\`${full.files === null ? "" : `, ${fmt(full.files)} files`}`,
        ...runOfScenario(full),
      },
      {
        id: "P2",
        metric: "incremental update p95, 1k / 10k files",
        target: "<= 500ms / <= 1s",
        measured: incremental?.p95 == null ? null : `${fmt(incremental.p95)} ms`,
        detail: incremental === undefined ? "" : `scenario \`${incremental.name}\`${incremental.p50 === null ? "" : `, p50 ${fmt(incremental.p50)} ms`}`,
        ...runOfScenario(incremental),
      },
      {
        id: "P3",
        metric: "peak RSS at 10k files",
        target: "<= 500MB (reported)",
        measured: peakRss === null ? null : `${fmt(peakRss / 1024 / 1024)} MB`,
        detail: peakRss === null ? "" : "highest `maxRSS` across the scenarios below",
        // The largest scenario is the one the peak came from, and it is the
        // scale the 10k-file target has to be checked against.
        ...runOfScenario(largest),
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
  // The scale M1's budget is written against (tech spec 3: "<= 3,000 tokens at 10k
  // files"). Carried on the row so `scopeTarget` can qualify the target with what was
  // actually measured, exactly as it does for P1 and P3.
  const run = targetOf(payload);
  const withRun = (row: EvalRow): EvalRow => (run === undefined ? row : { ...row, run });

  section.groups.push({
    name: null,
    rows: [
      {
        id: "M1",
        metric: "INDEX.md token budget",
        target: `<= ${fmt(budget)} tokens at 10k files`,
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
    ].map(withRun),
  });
  // Zero headroom is a fact to publish, not to hide: a map sitting exactly on the cap
  // passes M2 today and fails on the next node the splitter has to place.
  if (maxNodeCount !== null && maxNodes !== null && maxNodeCount === maxNodes) {
    section.notes.push(
      `M2 has no headroom: the largest fence is ${fmt(maxNodeCount)} nodes against a cap of ${fmt(maxNodes)}. ` +
        "The metric passes — nothing exceeds the cap — but one more node in that diagram fails it, so the " +
        "auto-split is at its limit rather than comfortably inside it.",
    );
  }
  section.notes.push(
    `Artifact dir: \`${dir ?? "not recorded"}\`. Mermaid checker: \`${checker ?? "not recorded"}\`` +
      (checker === "subset"
        ? " — `mermaid` 11 under jsdom could not run headless here, so fences were validated against a strict " +
          "grammar for the subset greplost emits (bench spec 1.5.4)."
        : "."),
  );
  return section;
}
