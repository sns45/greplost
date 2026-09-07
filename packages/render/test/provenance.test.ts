/**
 * `INDEX.md` provenance and the Nodes legend, and the display name a workflow
 * step card carries (leaf 2.15, PLAN "Build 2.1").
 *
 * The evaluation could not tell, from a map alone, which greplost wrote it,
 * whether anything had been left out of it, or what the `Nodes` column counted;
 * and it read step cards titled by position (`step.build.~3`) with no way to
 * tell which step that was. All four are properties of the rendered bytes, so
 * they are asserted here against real fixture snapshots.
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildSnapshot } from "@greplost/core";
import type { Lang, Snapshot } from "@greplost/core/schema";
import { DEFAULT_CONFIG } from "@greplost/core/schema";

import { GREPLOST_VERSION, renderArtifacts, renderIndex } from "../src/index.ts";

const FIXTURES = path.resolve(import.meta.dir, "../../../fixtures");

let ts: Snapshot;
let actions: Snapshot;
let terraform: Snapshot;

/** A fixture built with the one language it is a fixture for, as `init` would. */
function snapshotOf(fixture: string, ...languages: Lang[]): Promise<Snapshot> {
  return buildSnapshot({
    root: path.join(FIXTURES, fixture),
    summaries: {},
    config: { ...DEFAULT_CONFIG, languages },
  });
}

beforeAll(async () => {
  ts = await buildSnapshot({ root: path.join(FIXTURES, "tiny-ts"), summaries: {} });
  actions = await snapshotOf("tiny-actions", "yaml");
  terraform = await snapshotOf("tiny-terraform", "hcl");
});

describe("INDEX provenance", () => {
  test("names the version, the excluded count and where to date the map", () => {
    const index = renderIndex({ snapshot: ts, summaries: {}, provenance: { excluded: 12 } });
    const line = index.split("\n").find((l) => l.startsWith("> Provenance:")) as string;
    expect(line).toBeDefined();
    expect(line).toContain(`greplost ${GREPLOST_VERSION}`);
    expect(line).toContain("12 test files excluded");
    expect(line).toContain(".greplost/config.json");
    expect(line).toContain("git log .greplost/INDEX.md");
    // Under the title, with the other two banner lines, before the packages.
    const lines = index.split("\n");
    expect(lines[0]).toBe("# tiny-ts map");
    expect(lines.indexOf(line)).toBeLessThan(lines.indexOf("## Packages (4)"));
  });

  test("a map with nothing excluded says so rather than staying silent", () => {
    const index = renderIndex({ snapshot: ts, summaries: {}, provenance: { excluded: 0 } });
    expect(index).toContain("0 test files excluded");
  });

  /**
   * The line may hold nothing an environment can change. Two builds of the same
   * content, one inside a git checkout and one from an exported copy, must be
   * the same bytes, or `greplost verify` fails across that boundary on a line
   * that says nothing about the code (leaf 2.15 ruling; the same reasoning that
   * keeps the commit sha out of it).
   */
  test("the line carries no clock, path or environment", () => {
    const index = renderIndex({ snapshot: ts, summaries: {}, provenance: { excluded: 4 } });
    const line = index.split("\n").find((l) => l.startsWith("> Provenance:")) as string;
    expect(line).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // No absolute path: nothing in the line may start at the filesystem root.
    expect(line).not.toMatch(/(^|\s)\/[A-Za-z]/);
    expect(line).not.toContain("checkout");
  });

  test("is left out entirely when the caller measured none", () => {
    const index = renderIndex({ snapshot: ts, summaries: {} });
    expect(index).not.toContain("Provenance:");
  });

  test("the version tracks the published package version", () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(import.meta.dir, "../../cli/package.json"), "utf8"),
    ) as { version: string };
    expect(GREPLOST_VERSION).toBe(pkg.version);
  });

  test("carrying provenance changes exactly one line of the map", () => {
    const without = renderArtifacts({ snapshot: ts, summaries: {} });
    const with_ = renderArtifacts({ snapshot: ts, summaries: {}, provenance: { excluded: 3 } });
    expect([...with_.keys()]).toEqual([...without.keys()]);
    for (const [artifact, contents] of with_) {
      if (artifact === "INDEX.md") continue;
      expect(contents).toBe(without.get(artifact) as string);
    }
    const before = (without.get("INDEX.md") as string).split("\n");
    const after = (with_.get("INDEX.md") as string).split("\n");
    expect(after.length).toBe(before.length + 1);
  });
});

describe("Nodes legend", () => {
  test("a repo with nodes says what the column counts, once, under the table", () => {
    const index = renderIndex({ snapshot: terraform, summaries: {} });
    expect(index).toContain("| Package | Path | Files | LOC | Nodes |");
    const legend = index.split("\n").filter((l) => l.startsWith("Nodes counts"));
    expect(legend).toHaveLength(1);
    expect(legend[0]).toContain("each with its own card");
    const lines = index.split("\n");
    expect(lines.indexOf(legend[0] as string)).toBeGreaterThan(
      lines.findIndex((l) => l.startsWith("| Package |")),
    );
  });

  test("a repo with no nodes keeps the build-1 table and no legend", () => {
    const index = renderIndex({ snapshot: ts, summaries: {} });
    expect(index).toContain("| Package | Path | Files | LOC | Deps |");
    expect(index).not.toContain("Nodes counts");
  });
});

describe("workflow step names", () => {
  test("a step card prints its display name beside the positional id", () => {
    const artifacts = renderArtifacts({ snapshot: actions, summaries: {} });
    const stepCards = [...artifacts.entries()].filter(([p]) => /\/step\./.test(p));
    expect(stepCards.length).toBeGreaterThan(0);
    const named = stepCards.find(([, body]) => body.includes("**Name:**"));
    expect(named).toBeDefined();
    const [, body] = named as [string, string];
    // The heading stays the id: it is what `greplost query` takes.
    expect(body.split("\n")[0]?.startsWith("# ")).toBe(true);
    expect(body).toMatch(/\*\*Name:\*\* .+/);
  });

  test("the file card's node list names the step as well as its index", () => {
    const artifacts = renderArtifacts({ snapshot: actions, summaries: {} });
    const card = [...artifacts.entries()].find(([p]) => p.endsWith(".yml.md"))?.[1] as string;
    expect(card).toBeDefined();
    expect(card).toMatch(/- \[`step\.[^\]]+`\]\([^)]+\) \(.+\)  L\d+-\d+/);
  });

  test("a node that is not a step is unchanged", () => {
    const artifacts = renderArtifacts({ snapshot: terraform, summaries: {} });
    const card = artifacts.get("packages/root/modules/main.tf/resource.aws_vpc.main.md") as string;
    expect(card).toBeDefined();
    expect(card).not.toContain("**Name:**");
  });
});
