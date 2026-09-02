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
  groupedBarChart,
  lineChart,
  mermaidXy,
  toPng,
  wrapText,
  writeChart,
} from "../src/charts.ts";
import { renderResultsMd, SECTION_HEADERS, X_IDS, provenanceLine, scopeTarget } from "../src/results-md.ts";
import { buildModel, run as reportRun } from "../src/report.ts";
import {
  METRIC_PLAN,
  TOOLS,
  byteDistance,
  describeDifference,
  diffLineCount,
  emptyMetrics,
  median,
  planImportEdits,
  run as headtoheadRun,
  verdictFor,
} from "../src/headtohead.ts";
import { checkTools, run as screenshotsRun } from "../src/screenshots.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

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
 */
const GOLDEN_BAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="380" viewBox="0 0 720 380" font-family="sans-serif" font-size="12">
<rect x="0" y="0" width="720" height="380" fill="#ffffff"/>
<text x="20" y="26" font-size="15" font-weight="bold" fill="#111827">X1 import precision</text>
<line x1="64" y1="322" x2="700" y2="322" stroke="#e5e7eb"/>
<text x="56" y="326" fill="#6b7280" font-size="11" text-anchor="end">0</text>
<line x1="64" y1="256" x2="700" y2="256" stroke="#e5e7eb"/>
<text x="56" y="260" fill="#6b7280" font-size="11" text-anchor="end">0.25</text>
<line x1="64" y1="190" x2="700" y2="190" stroke="#e5e7eb"/>
<text x="56" y="194" fill="#6b7280" font-size="11" text-anchor="end">0.5</text>
<line x1="64" y1="124" x2="700" y2="124" stroke="#e5e7eb"/>
<text x="56" y="128" fill="#6b7280" font-size="11" text-anchor="end">0.75</text>
<line x1="64" y1="58" x2="700" y2="58" stroke="#e5e7eb"/>
<text x="56" y="62" fill="#6b7280" font-size="11" text-anchor="end">1</text>
<line x1="64" y1="58" x2="64" y2="322" stroke="#9ca3af"/>
<line x1="64" y1="322" x2="700" y2="322" stroke="#9ca3af"/>
<text x="18" y="190" fill="#6b7280" font-size="11" text-anchor="middle" transform="rotate(-90 18 190)">precision</text>
<rect x="93.68" y="58" width="150.64" height="264" fill="#1d4ed8"/>
<text x="170" y="71" fill="#ffffff" font-size="10" text-anchor="middle">1</text>
<text x="170" y="338" fill="#6b7280" font-size="11" text-anchor="middle">greplost</text>
<rect x="305.68" y="110.8" width="150.64" height="211.2" fill="#1d4ed8"/>
<text x="382" y="106.8" fill="#111827" font-size="10" text-anchor="middle">0.8</text>
<text x="382" y="338" fill="#6b7280" font-size="11" text-anchor="middle">graphify</text>
<rect x="517.68" y="190" width="150.64" height="132" fill="#1d4ed8"/>
<text x="594" y="186" fill="#111827" font-size="10" text-anchor="middle">0.5</text>
<text x="594" y="338" fill="#6b7280" font-size="11" text-anchor="middle">crg</text>
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
    expect(text.startsWith("xychart-beta")).toBe(true);
    expect(text).toContain('title "X2 staleness"');
    expect(text).toContain("x-axis");
    expect(text).toContain("y-axis");
    expect(text.match(/^\s+line \[/gm)?.length ?? 0).toBe(1);
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

    const without = renderResultsMd(buildModel({ resultsDir: tempDir("unparsable-no") }));
    const row = without.split("\n").find((l) => l.startsWith("| unparsable "));
    expect(row).toContain("n/a");
    expect(row).toContain("recovery is in progress");
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
    // scenario is { scenario, ms: { p50, p95 }, peakRssBytes } — not the flat
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
      expect(readFileSync(file, "utf8")).toContain("Output");
    }
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
