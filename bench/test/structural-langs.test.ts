/**
 * Per-language structural coverage: the payload's `perLang` block, the rows
 * `bench/RESULTS.md` prints from it, and the build-1 flags that must keep their
 * meaning (leaf 2.12, gates G1 to G5; spec 5.2 and 5.5).
 *
 * Every number asserted here is built into a payload by the test and then read
 * back out, because that is the whole claim this leaf makes: a cell in the
 * "Languages, IaC and signals" table is a value some suite wrote to disk, an
 * `n/a` a truth module declared, or `not run`. There is no fourth case, and
 * nothing here may pass by typing a digit into a document.
 *
 * Gate CHECK lines filter on describe names, so the five blocks are named
 * exactly `per-lang targets`, `subset config`, `n/a metrics`, `S5 and S6` and
 * `build-1 flags still work`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG } from "@greplost/core/schema";

import { langRows, type LangRow, type Payload } from "../src/report-payload.ts";
import { buildModel } from "../src/report.ts";
import { LANG_SECTION_HEADER, NOT_APPLICABLE, NOT_RUN, renderResultsMd } from "../src/results-md.ts";
import type { Score } from "../src/score.ts";
import {
  TARGETS,
  buildOptionsFor,
  missedMetrics,
  perLangSummary,
  resultSuite,
  run as structuralRun,
  unsupportedMetrics,
  type RepoScores,
} from "../src/structural.ts";

const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-langs-${name}-`));
  temps.push(dir);
  return dir;
}

/** A `Score` with the counts a caller cares about and consistent rates. */
function score(tp: number, fp: number, fn: number): Score {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  return {
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    tp,
    fp,
    fn,
    falsePositives: [],
    falseNegatives: [],
  };
}

/** One repo's scores, with every field `structural.ts` fills in. */
function repoScores(name: string, over: Partial<RepoScores> = {}): RepoScores {
  return {
    name,
    files: 10,
    S1: score(10, 0, 0),
    S2: score(10, 0, 0),
    S3: score(10, 0, 0),
    callsAll: score(10, 0, 0),
    S4: 1,
    S5: null,
    S6: null,
    naMetrics: [],
    substitute: null,
    truthEmpty: false,
    noFiles: false,
    falsePositives: {},
    falseNegatives: {},
    notes: [],
    unparsable: [],
    ...over,
  };
}

/** The serialised shape `structural.ts` writes for one repo. */
function repoPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  const brief = (s: Score): Record<string, number> => ({
    precision: s.precision,
    recall: s.recall,
    f1: s.f1,
    tp: s.tp,
    fp: s.fp,
    fn: s.fn,
  });
  return {
    files: 10,
    S1: brief(score(10, 0, 0)),
    S2: brief(score(10, 0, 0)),
    S3: brief(score(10, 0, 0)),
    callsAllConfidences: brief(score(10, 0, 0)),
    S4: 1,
    S5: null,
    S6: null,
    naMetrics: [],
    substitute: null,
    truthEmpty: false,
    noFiles: false,
    ...over,
  };
}

/**
 * One language's row.
 *
 * `langRows` also emits a `not run` row for every language the pinned corpus
 * covers and the payload set lacks, so a row is found by its language and never
 * by its position.
 */
function rowFor(rows: readonly LangRow[], lang: string): LangRow {
  const found = rows.find((row) => row.lang === lang);
  if (found === undefined) throw new Error(`no row for ${lang}`);
  return found;
}

/** The languages a payload actually measured, in table order. */
function measuredLangs(rows: readonly LangRow[]): string[] {
  return rows.filter((row) => row.ran).map((row) => row.lang);
}

/** A structural payload wrapped the way `report-payload.ts` reads one. */
function payloadOf(data: Record<string, unknown>): Payload {
  return {
    data: { suite: "structural", date: "2026-09-05", greplostSha: "abc1234", ...data },
    file: "structural-2026-09-05-abc1234.json",
  };
}

/** Write one structural payload into a fresh results directory and render the document. */
function renderWith(name: string, data: Record<string, unknown>): string {
  const dir = tempDir(name);
  writeFileSync(
    path.join(dir, "structural-2026-09-05-abc1234.json"),
    JSON.stringify({ suite: "structural", date: "2026-09-05", greplostSha: "abc1234", ...data }),
  );
  return renderResultsMd(buildModel({ resultsDir: dir }));
}

/** Run the suite with stdout captured, so a dry run can be asserted on. */
async function runCapturing(args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts: unknown[]): void => void lines.push(parts.join(" "));
  console.error = (...parts: unknown[]): void => void lines.push(parts.join(" "));
  try {
    const code = await structuralRun(args);
    return { code, out: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

// ---------------------------------------------------------------------------

describe("per-lang targets", () => {
  test("the payload carries one entry per language with its repos, truth source and gated flag", () => {
    const targets = [
      { name: "tf-aws-vpc", root: "/tmp/tf-aws-vpc", lang: "hcl" as const, sha: null },
      { name: "coroutines", root: "/tmp/coroutines", lang: "kotlin" as const, sha: null },
      { name: "tf-aws-eks", root: "/tmp/tf-aws-eks", lang: "hcl" as const, sha: null },
      { name: "pydantic", root: "/tmp/pydantic", lang: "python" as const, sha: null },
    ];
    const scores = [
      repoScores("tf-aws-vpc", { naMetrics: ["S3"] }),
      // Kotlin has no corpus oracle: every gated metric is `n/a`, so the language is
      // reported, never gated (spec 1.7).
      repoScores("coroutines", { naMetrics: ["S1", "S2", "S3", "S4", "S5", "S6"] }),
      repoScores("tf-aws-eks", { naMetrics: ["S3"] }),
      repoScores("pydantic"),
    ];

    const perLang = perLangSummary(targets, scores);

    expect(perLang["kotlin"]).toEqual({
      repos: ["coroutines"],
      gated: false,
      truthSource: "bench/src/truth/kotlin.ts",
    });
    expect(perLang["python"]?.gated).toBe(true);
    // Repos are sorted, so two clones of one tree write the same payload.
    expect(perLang["hcl"]).toEqual({
      repos: ["tf-aws-eks", "tf-aws-vpc"],
      gated: true,
      truthSource: "bench/src/truth/hcl.ts",
    });
  });

  test("langRows turns the payload into one row per language, sorted, with nothing invented", () => {
    const rows = langRows(
      payloadOf({
        perLang: {
          python: { repos: ["pydantic"], gated: true, truthSource: "bench/src/truth/python.ts" },
          hcl: {
            repos: ["tf-aws-eks", "tf-aws-vpc"],
            gated: true,
            truthSource: "bench/src/truth/hcl.ts",
          },
        },
        repos: {
          pydantic: repoPayload({ files: 105 }),
          "tf-aws-vpc": repoPayload({ files: 77, naMetrics: ["S3"], S3: null }),
          "tf-aws-eks": repoPayload({ files: 87, naMetrics: ["S3"], S3: null }),
        },
      }),
    );

    expect(measuredLangs(rows)).toEqual(["hcl", "python"]);
    const hcl = rowFor(rows, "hcl");
    expect(hcl.corpus).toBe("tf-aws-eks, tf-aws-vpc");
    // The file count is the sum of the repos the language covered, not a guess.
    expect(hcl.files).toBe(164);
    expect(hcl.truthSource).toBe("bench/src/truth/hcl.ts");
    expect(hcl.gated).toBe(true);
    // S3 is declared unsupported; S5 and S6 are `n/a` because no repo of this
    // language carried a number for them.
    expect(hcl.na).toEqual(["S3", "S5", "S6"]);
    expect(hcl.s3).toBeNull();
    expect(rowFor(rows, "python").files).toBe(105);
    expect(rowFor(rows, "python").s1).toBe(1);
  });

  test("langRows takes the worst repo of a language, so an aggregate never flatters it", () => {
    const rows = langRows(
      payloadOf({
        perLang: { yaml: { repos: ["a", "b"], gated: true, truthSource: "bench/src/truth/yaml.ts" } },
        repos: {
          a: repoPayload({ S1: { precision: 1, recall: 1, f1: 1, tp: 8, fp: 0, fn: 0 } }),
          b: repoPayload({ S1: { precision: 0.5, recall: 0.5, f1: 0.5, tp: 4, fp: 4, fn: 4 } }),
        },
      }),
    );
    expect(rowFor(rows, "yaml").s1).toBe(0.5);
  });

  test("a payload with no perLang block yields no rows, and the section says the run is not there", () => {
    expect(langRows(null)).toEqual([]);
    expect(langRows(payloadOf({ repos: {} }))).toEqual([]);
    const text = renderWith("no-perlang", { repos: {} });
    expect(text).toContain(`## ${LANG_SECTION_HEADER}`);
    expect(text).toContain("not run");
  });

  test("the document prints a row per language with its corpus, truth source and gated flag", () => {
    const text = renderWith("rows", {
      corpus: [{ name: "pydantic" }, { name: "coroutines" }],
      perLang: {
        python: { repos: ["pydantic"], gated: true, truthSource: "bench/src/truth/python.ts" },
        kotlin: { repos: ["coroutines"], gated: false, truthSource: "bench/src/truth/kotlin.ts" },
      },
      repos: {
        pydantic: repoPayload({ files: 105 }),
        coroutines: repoPayload({
          files: 163,
          naMetrics: ["S1", "S2", "S3", "S4", "S5", "S6"],
          S1: null,
          S2: null,
          S3: null,
          S4: null,
          substitute: { deterministic: true, errorRate: 0, silentFiles: [], silentCount: 0 },
        }),
      },
    });

    expect(text).toContain(`## ${LANG_SECTION_HEADER}`);
    expect(text).toContain("| python | pydantic | 105 |");
    expect(text).toContain("bench/src/truth/kotlin.ts");
    // Kotlin is published as reported, with the reason, next to the losses.
    expect(text).toContain("reported");
    expect(text).toMatch(/kotlin[\s\S]*no corpus compiler truth/);
  });

  test("every language the corpus pins has a disclosure of what its oracle cannot see", () => {
    const text = renderWith("disclosures", {
      perLang: {
        python: { repos: ["pydantic"], gated: true, truthSource: "bench/src/truth/python.ts" },
        rust: { repos: ["ripgrep"], gated: true, truthSource: "bench/src/truth/rust.ts" },
        java: { repos: ["gson"], gated: true, truthSource: "bench/src/truth/java.ts" },
        kotlin: { repos: ["coroutines"], gated: false, truthSource: "bench/src/truth/kotlin.ts" },
        hcl: { repos: ["tf-aws-vpc"], gated: true, truthSource: "bench/src/truth/hcl.ts" },
        yaml: { repos: ["k8s-examples"], gated: true, truthSource: "bench/src/truth/yaml.ts" },
        dockerfile: { repos: ["docker-node"], gated: true, truthSource: "bench/src/truth/dockerfile.ts" },
        ts: { repos: ["pulumi-ts"], gated: true, truthSource: "bench/src/truth/ts.ts" },
        go: { repos: ["pulumi-go"], gated: true, truthSource: "bench/src/truth/go.ts" },
      },
      repos: {
        pydantic: repoPayload(),
        ripgrep: repoPayload(),
        gson: repoPayload(),
        coroutines: repoPayload({ naMetrics: ["S1", "S2", "S3", "S4", "S5", "S6"] }),
        "tf-aws-vpc": repoPayload({ naMetrics: ["S3"] }),
        "k8s-examples": repoPayload({ naMetrics: ["S3"] }),
        "docker-node": repoPayload({ naMetrics: ["S3"] }),
        "pulumi-ts": repoPayload(),
        "pulumi-go": repoPayload(),
      },
    });

    // One disclosure per language, each naming the oracle and its blind spot.
    for (const phrase of [
      "rule-agreement-oracle",
      "nearest-tsconfig-resolution",
      "same-rules-different-parser",
      "same-regex-both-sides",
      "if-else-arms-both-kept",
      "reported-only",
      "no-overload-resolution",
      "no-inherited-dispatch",
      "module-info-not-scored",
      "helper-attribution-differs",
    ]) {
      expect(text).toContain(phrase);
    }
    // The corpus gaps a reader would otherwise have to find in a review thread.
    expect(text).toContain("CommonJS");
    expect(text).toContain("below the tier-S band");
  });
});

// ---------------------------------------------------------------------------

describe("subset config", () => {
  test("a pinned subset becomes the include list and the language becomes the only one indexed", () => {
    const options = buildOptionsFor({
      name: "pydantic",
      root: "/tmp/pydantic",
      lang: "python",
      sha: null,
      subset: "pydantic/**",
    });
    expect(options.root).toBe("/tmp/pydantic");
    expect(options.config?.languages).toEqual(["python"]);
    expect(options.config?.include).toEqual(["pydantic/**"]);
  });

  test("the TypeScript family keeps all four dialects, so a tsx subset still scores its .ts files", () => {
    const options = buildOptionsFor({
      name: "tanstack-start",
      root: "/tmp/tanstack-start",
      lang: "tsx",
      sha: null,
      subset: "examples/react/start-*/**",
    });
    expect(options.config?.languages).toEqual([...DEFAULT_CONFIG.languages]);
    expect(options.config?.include).toEqual(["examples/react/start-*/**"]);
  });

  test("`**` is the whole repo, which is the default include, so no config is forced on a TS target", () => {
    const options = buildOptionsFor({ name: "anyq", root: "/tmp/anyq", lang: "ts", sha: null, subset: "**" });
    expect(options.config).toBeUndefined();
  });

  test("a non-TypeScript target with no subset still gets its language", () => {
    const options = buildOptionsFor({ name: "ripgrep", root: "/tmp/ripgrep", lang: "rust", sha: null });
    expect(options.config?.languages).toEqual(["rust"]);
    // No subset means the default include, which is the whole repo.
    expect(options.config?.include).toEqual([...DEFAULT_CONFIG.include]);
  });
});

// ---------------------------------------------------------------------------

describe("n/a metrics", () => {
  test("a truth module declares an unsupported metric and nothing is inferred", () => {
    expect(unsupportedMetrics(["terraform-config-inspect", "unsupported:S3"])).toEqual(["S3"]);
    expect(unsupportedMetrics(["reported-only"])).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
    expect(unsupportedMetrics(["js-yaml-oracle"])).toEqual([]);
  });

  test("an n/a metric is neither a pass nor a fail", () => {
    // Precision far below the target, but the oracle said it does not measure it.
    const missed = missedMetrics(repoScores("tf-aws-vpc", { naMetrics: ["S3"], S3: score(0, 10, 0) }));
    expect(missed).not.toContain("S3");
    // The same score without the declaration is a miss, so the `n/a` is doing the work.
    expect(missedMetrics(repoScores("tf-aws-vpc", { S3: score(0, 10, 0) }))).toContain("S3");
  });

  test("the table prints n/a for an unsupported metric, not `not run` and not a zero", () => {
    const text = renderWith("na", {
      perLang: { hcl: { repos: ["tf-aws-vpc"], gated: true, truthSource: "bench/src/truth/hcl.ts" } },
      repos: { "tf-aws-vpc": repoPayload({ files: 77, naMetrics: ["S3"], S3: null }) },
    });
    const row = text.split("\n").find((line) => line.startsWith("| hcl |"));
    expect(row).toBeDefined();
    expect(row).toContain(NOT_APPLICABLE);
    expect(row).not.toContain("0.000");
  });

  test("a metric this run's oracle did not measure is n/a, not `not run`", () => {
    // The suite prints "n/a  not measured by this oracle" for exactly this case:
    // the target was scored, and S5 has no oracle behind it. `not run` would say
    // the language was never measured at all, which is a different claim.
    const text = renderWith("unmeasured", {
      perLang: { java: { repos: ["gson"], gated: true, truthSource: "bench/src/truth/java.ts" } },
      repos: { gson: repoPayload({ files: 95 }) },
    });
    const row = text.split("\n").find((line) => line.startsWith("| java |"));
    expect(row).toBeDefined();
    expect(row).toContain(NOT_APPLICABLE);
    expect(row).not.toContain("not run");
  });

  test("a metric only some of a language's repos cannot measure keeps the value and names them", () => {
    const rows = langRows(
      payloadOf({
        perLang: {
          yaml: {
            repos: ["bitnami-charts", "k8s-examples"],
            gated: true,
            truthSource: "bench/src/truth/yaml.ts",
          },
        },
        repos: {
          // A Helm chart's node ids come from document indices, so its oracle
          // declares S6 unsupported; a plain manifest's oracle measures it.
          "bitnami-charts": repoPayload({ naMetrics: ["S3", "S6"], S3: null, S6: null }),
          "k8s-examples": repoPayload({
            naMetrics: ["S3"],
            S3: null,
            S6: { precision: 1, recall: 1, f1: 1, tp: 401, fp: 0, fn: 0 },
          }),
        },
      }),
    );
    // Declared by every repo, or carried by none: a language-wide `n/a`.
    expect(rowFor(rows, "yaml").na).toEqual(["S3", "S5"]);
    // Declared by one of two: the measured half is still a measurement.
    expect(rowFor(rows, "yaml").partial["S6"]).toEqual(["bitnami-charts"]);
    expect(rowFor(rows, "yaml").s6).toBe(1);

    const text = renderWith("partial", {
      perLang: {
        yaml: { repos: ["bitnami-charts", "k8s-examples"], gated: true, truthSource: "bench/src/truth/yaml.ts" },
      },
      repos: {
        "bitnami-charts": repoPayload({ naMetrics: ["S3", "S6"], S3: null, S6: null }),
        "k8s-examples": repoPayload({
          naMetrics: ["S3"],
          S3: null,
          S6: { precision: 1, recall: 1, f1: 1, tp: 401, fp: 0, fn: 0 },
        }),
      },
    });
    const row = text.split("\n").find((line) => line.startsWith("| yaml |"));
    expect(row).toContain("n/a for bitnami-charts");
  });

  test("Eval 1 prints n/a for a declared metric instead of a score against a target", () => {
    // The suite's own table says "n/a, not measured by this oracle" for these.
    // Eval 1 used to read the block regardless and published Kotlin's S1 as
    // `0 / 1` against a 0.99 target, which is a failing score for a metric that
    // was never measured, and a Dockerfile's S1 as a vacuous 1.
    const text = renderWith("eval1-na", {
      corpus: [{ name: "coroutines" }],
      perLang: { kotlin: { repos: ["coroutines"], gated: false, truthSource: "bench/src/truth/kotlin.ts" } },
      repos: {
        coroutines: repoPayload({
          files: 163,
          naMetrics: ["S1", "S2", "S3", "S4", "S5", "S6"],
          S1: { precision: 0, recall: 1, f1: 0, tp: 0, fp: 0, fn: 0 },
          S2: { precision: 0, recall: 1, f1: 0, tp: 0, fp: 0, fn: 0 },
          S3: { precision: 0, recall: 1, f1: 0, tp: 0, fp: 0, fn: 0 },
          S4: 1,
          substitute: { deterministic: true, errorRate: 0, silentFiles: [], silentCount: 0 },
        }),
      },
    });
    const eval1 = text.slice(text.indexOf("## Eval 1"));
    const rows = eval1.split("\n").filter((line) => /^\| S[1-4] \|/.test(line));
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row).toContain(NOT_APPLICABLE);
      // No score, and no target to read a missing score against.
      expect(row).not.toContain("0.99");
      expect(row).not.toContain("0 / 1");
    }
  });

  test("Eval 1 still scores a metric the oracle did measure", () => {
    const text = renderWith("eval1-measured", {
      corpus: [{ name: "docker-node" }],
      perLang: {
        dockerfile: { repos: ["docker-node"], gated: true, truthSource: "bench/src/truth/dockerfile.ts" },
      },
      repos: {
        "docker-node": repoPayload({
          files: 18,
          naMetrics: ["S1", "S3", "S4"],
          S2: { precision: 1, recall: 1, f1: 1, tp: 18, fp: 0, fn: 0 },
        }),
      },
    });
    const eval1 = text.slice(text.indexOf("## Eval 1"));
    const s2 = eval1.split("\n").find((line) => line.startsWith("| S2 |"));
    expect(s2).toContain("1 / 1");
    expect(s2).toContain("tp 18");
    const s1 = eval1.split("\n").find((line) => line.startsWith("| S1 |"));
    expect(s1).toContain(NOT_APPLICABLE);
  });

  test("no language paragraph claims a metric is n/a that its own row scores", () => {
    // The prose is written by hand and the row is generated, so the two can
    // drift: the Helm oracle stopped declaring `unsupported:S6` and the yaml
    // paragraph went on saying S6 was `n/a` for a chart while the row printed
    // 1.000 with 216 true positives (review I1). This is the check that keeps
    // them honest for every language at once.
    const measured = { precision: 1, recall: 1, f1: 1, tp: 216, fp: 0, fn: 0 };
    const text = renderWith("no-contradiction", {
      perLang: {
        yaml: {
          repos: ["bitnami-charts"],
          gated: true,
          truthSource: "bench/src/truth/yaml.ts",
        },
      },
      repos: {
        "bitnami-charts": repoPayload({
          files: 130,
          naMetrics: ["S1", "S3", "S4"],
          S1: null,
          S3: null,
          S4: null,
          S5: measured,
          S6: measured,
        }),
      },
    });

    const section = text.slice(text.indexOf(`## ${LANG_SECTION_HEADER}`));
    const row = section.split("\n").find((line) => line.startsWith("| yaml |"));
    expect(row).toBeDefined();
    const cells = (row ?? "").split("|").map((cell_) => cell_.trim());
    // Cells: "", lang, corpus, files, S1..S6, truth source, scored, "".
    const paragraph = section.split("\n").find((line) => line.startsWith("- **yaml**")) ?? "";
    for (const [index, id] of ["S1", "S2", "S3", "S4", "S5", "S6"].entries()) {
      const cell_ = cells[4 + index] ?? "";
      if (cell_ === NOT_APPLICABLE) continue;
      // The row carries a number for this metric, so no sentence may say the
      // oracle does not measure it.
      expect(paragraph).not.toContain(`${id} is \`${NOT_APPLICABLE}\``);
      expect(paragraph).not.toMatch(new RegExp(`\\b${id}\\b[^.]{0,60}\\bnot measured\\b`));
    }
    expect(paragraph).toContain("S1, S3 and S4 are `n/a`");
  });

  test("a metric scored on an empty set is disclosed as vacuous rather than published as 1.000", () => {
    const text = renderWith("vacuous", {
      perLang: {
        dockerfile: { repos: ["docker-node"], gated: true, truthSource: "bench/src/truth/dockerfile.ts" },
      },
      repos: {
        "docker-node": repoPayload({
          files: 21,
          naMetrics: ["S3"],
          S3: null,
          S1: { precision: 1, recall: 1, f1: 1, tp: 0, fp: 0, fn: 0 },
        }),
      },
    });
    expect(text).toContain("nothing to be wrong about");
    expect(text).toMatch(/dockerfile[\s\S]*S1/);
  });
});

// ---------------------------------------------------------------------------

describe("S5 and S6", () => {
  test("the gate carries a target for reference and signal-node precision", () => {
    expect(TARGETS.S5).toBe(0.95);
    expect(TARGETS.S6).toBe(0.95);
  });

  test("S5 and S6 are gated once an oracle measures them, and n/a before that", () => {
    expect(missedMetrics(repoScores("pulumi-ts", { S5: score(90, 10, 0), S6: score(90, 10, 0) }))).toEqual([
      "S5",
      "S6",
    ]);
    expect(missedMetrics(repoScores("pulumi-ts", { S5: null, S6: null }))).toEqual([]);
    expect(missedMetrics(repoScores("pulumi-ts", { S5: score(100, 0, 0), S6: score(100, 0, 0) }))).toEqual([]);
  });

  test("the row carries both, and an unmeasured one is n/a rather than a zero", () => {
    const rows = langRows(
      payloadOf({
        perLang: { ts: { repos: ["pulumi-ts"], gated: true, truthSource: "bench/src/truth/ts.ts" } },
        repos: {
          "pulumi-ts": repoPayload({
            files: 122,
            S5: { precision: 1, recall: 1, f1: 1, tp: 240, fp: 0, fn: 0 },
            S6: { precision: 0.98, recall: 1, f1: 0.99, tp: 49, fp: 1, fn: 0 },
          }),
        },
      }),
    );
    expect(rowFor(rows, "ts").s5).toBe(1);
    expect(rowFor(rows, "ts").s6).toBe(0.98);

    const unmeasured = langRows(
      payloadOf({
        perLang: { rust: { repos: ["ripgrep"], gated: true, truthSource: "bench/src/truth/rust.ts" } },
        repos: { ripgrep: repoPayload({ files: 95 }) },
      }),
    );
    expect(rowFor(unmeasured, "rust").s5).toBeNull();
    expect(rowFor(unmeasured, "rust").s6).toBeNull();
  });

  test("the document names S5 and S6 in the table header, with what each measures", () => {
    const text = renderWith("s5s6", {
      perLang: { hcl: { repos: ["tf-aws-vpc"], gated: true, truthSource: "bench/src/truth/hcl.ts" } },
      repos: { "tf-aws-vpc": repoPayload({ S5: { precision: 1, recall: 1, f1: 1, tp: 2431, fp: 0, fn: 0 } }) },
    });
    expect(text).toContain("S5");
    expect(text).toContain("S6");
    expect(text).toMatch(/reference edge/i);
    expect(text).toMatch(/signal node|node id/i);
  });
});

// ---------------------------------------------------------------------------

describe("payload index", () => {
  /** A results directory holding a full run and a later single-repo gate run. */
  function twoRuns(name: string): string {
    const dir = tempDir(name);
    writeFileSync(
      path.join(dir, "structural-2026-09-05-aaaaaaa.json"),
      JSON.stringify({
        suite: "structural",
        date: "2026-09-05",
        greplostSha: "aaaaaaa",
        recordedAt: "2026-09-05T10:00:00.000Z",
        corpus: [{ name: "pydantic" }, { name: "ripgrep" }],
        perLang: {
          python: { repos: ["pydantic"], gated: true, truthSource: "bench/src/truth/python.ts" },
          rust: { repos: ["ripgrep"], gated: true, truthSource: "bench/src/truth/rust.ts" },
        },
        repos: { pydantic: repoPayload({ files: 105 }), ripgrep: repoPayload({ files: 95 }) },
      }),
    );
    // The stray: one repo, written later by someone re-running a single gate.
    writeFileSync(
      path.join(dir, "structural-2026-09-05-bbbbbbb.json"),
      JSON.stringify({
        suite: "structural",
        date: "2026-09-05",
        greplostSha: "bbbbbbb",
        recordedAt: "2026-09-05T20:00:00.000Z",
        corpus: [{ name: "pydantic" }],
        perLang: { python: { repos: ["pydantic"], gated: true, truthSource: "bench/src/truth/python.ts" } },
        repos: { pydantic: repoPayload({ files: 105 }) },
      }),
    );
    return dir;
  }

  test("a stray payload written after the document cannot silently replace the set it was built from", () => {
    const dir = twoRuns("index-pinned");
    writeFileSync(
      path.join(dir, "INDEX.json"),
      JSON.stringify({ payloads: { structural: ["structural-2026-09-05-aaaaaaa.json"] } }),
    );
    const text = renderResultsMd(buildModel({ resultsDir: dir }));
    // The pinned run scored two languages; the stray one scored a single repo.
    expect(text).toContain("| rust |");
    expect(text).toContain("Measured 2026-09-05 at aaaaaaa");
  });

  test("--latest opts into the newest payload on disk and re-pins the index", () => {
    const dir = twoRuns("index-latest");
    writeFileSync(
      path.join(dir, "INDEX.json"),
      JSON.stringify({ payloads: { structural: ["structural-2026-09-05-aaaaaaa.json"] } }),
    );
    const text = renderResultsMd(buildModel({ resultsDir: dir, latest: true }));
    expect(text).toContain("Measured 2026-09-05 at bbbbbbb");
    // The rust row is `not run` now, and says so rather than vanishing.
    const row = text.split("\n").find((line) => line.startsWith("| rust |"));
    expect(row).toContain(NOT_RUN);
  });

  test("with no index at all the report still reads the newest on disk", () => {
    const dir = twoRuns("index-absent");
    const text = renderResultsMd(buildModel({ resultsDir: dir }));
    expect(text).toContain("Measured 2026-09-05 at bbbbbbb");
  });

  test("an index naming a file that is not there degrades to the newest and discloses it", () => {
    const dir = twoRuns("index-stale");
    writeFileSync(
      path.join(dir, "INDEX.json"),
      JSON.stringify({ payloads: { structural: ["structural-2026-09-05-ccccccc.json"] } }),
    );
    const text = renderResultsMd(buildModel({ resultsDir: dir }));
    expect(text).toContain("Measured 2026-09-05 at bbbbbbb");
    expect(text).toContain("structural-2026-09-05-ccccccc.json");
    expect(text).toMatch(/index|INDEX\.json/);
  });

  test("the report writes the index it used, so the set is committed with the document", () => {
    const dir = twoRuns("index-written");
    buildModel({ resultsDir: dir, latest: true, writeIndex: true });
    const index = JSON.parse(readFileSync(path.join(dir, "INDEX.json"), "utf8")) as {
      payloads: Record<string, string[]>;
      corpora: Record<string, string>;
    };
    expect(index.payloads["structural"]).toEqual(["structural-2026-09-05-bbbbbbb.json"]);
    // The per-corpus listing the ruling asks for: which file each repo's numbers came from.
    expect(index.corpora["pydantic"]).toBe("structural-2026-09-05-bbbbbbb.json");
  });
});

// ---------------------------------------------------------------------------

describe("missing languages", () => {
  test("a language the pinned corpus covers and the payload set lacks gets a not run row", () => {
    const text = renderWith("missing-langs", {
      corpus: [{ name: "pydantic" }],
      perLang: { python: { repos: ["pydantic"], gated: true, truthSource: "bench/src/truth/python.ts" } },
      repos: { pydantic: repoPayload({ files: 105 }) },
    });
    const section = text.slice(text.indexOf(`## ${LANG_SECTION_HEADER}`));

    // Python was measured.
    expect(section).toMatch(/^\| python \| pydantic \| 105 \|/m);
    // Every other language `bench/corpus.json` pins is present and honest.
    for (const lang of ["dockerfile", "go", "hcl", "java", "kotlin", "rust", "tsx", "yaml"]) {
      const row = section.split("\n").find((line) => line.startsWith(`| ${lang} |`));
      expect([lang, row === undefined]).toEqual([lang, false]);
      expect([lang, (row ?? "").includes(NOT_RUN)]).toEqual([lang, true]);
    }
    // A not run row names the repos it would have been measured on.
    const rust = section.split("\n").find((line) => line.startsWith("| rust |")) ?? "";
    expect(rust).toContain("ripgrep");
  });

  test("the opening sentence counts what was measured instead of claiming everything was", () => {
    const partial = renderWith("opening-partial", {
      corpus: [{ name: "pydantic" }],
      perLang: { python: { repos: ["pydantic"], gated: true, truthSource: "bench/src/truth/python.ts" } },
      repos: { pydantic: repoPayload({ files: 105 }) },
    });
    const section = partial.slice(partial.indexOf(`## ${LANG_SECTION_HEADER}`));
    expect(section).not.toMatch(/^Every language, IaC flavour and framework signal pass/m);
    expect(section).toMatch(/1 of the \d+ languages/);
  });
});

// ---------------------------------------------------------------------------

describe("build-1 flags still work", () => {
  test("bare --fixture is tiny-ts and --fixture-go is tiny-go", async () => {
    const ts = await runCapturing(["--fixture", "--dry-run"]);
    expect(ts.code).toBe(0);
    expect(ts.out).toContain("tiny-ts");
    expect(ts.out).not.toContain("tiny-go");

    const go = await runCapturing(["--fixture-go", "--dry-run"]);
    expect(go.code).toBe(0);
    expect(go.out).toContain("tiny-go");
  });

  test("--fixture <name> selects a build-2 fixture and an unknown one is an error, not a guess", async () => {
    const python = await runCapturing(["--fixture", "tiny-python", "--dry-run"]);
    expect(python.code).toBe(0);
    expect(python.out).toContain("tiny-python");

    const unknown = await runCapturing(["--fixture", "tiny-cobol", "--dry-run"]);
    expect(unknown.code).toBe(2);
    expect(unknown.out).toContain("unknown fixture");
  });

  test("a fixture run never becomes the published structural result", () => {
    expect(resultSuite(true)).toBe("structural-fixture");
    expect(resultSuite(false)).toBe("structural");
  });

  test("--lang only accepts a language the schema knows", async () => {
    const bad = await runCapturing(["--fixture", "--lang", "cobol", "--dry-run"]);
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("unknown --lang");
  });
});
