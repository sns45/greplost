/**
 * greplost:sync verification tests (leaf 1.3.1).
 *
 * `verify` is the CI backstop (tech spec 7.3): it rebuilds the structure layer
 * in memory from the checkout plus the committed summary cache and diffs the
 * bytes against `.greplost/`. These tests drive it through the four states it
 * can report — clean, changed, missing, extra — and pin the shape of the
 * unified diff it hands to a failing build.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createParser } from "@greplost/core";
import type { ParserHandle } from "@greplost/core";

import { buildArtifacts } from "../src/build.ts";
import { unifiedDiff, verify } from "../src/verify.ts";
import { writeArtifacts } from "../src/write.ts";

const FIXTURE_ROOT = path.resolve(import.meta.dir, "../../../fixtures/tiny-ts");

const QUEUE_SOURCE = "packages/core/src/queue.ts";
const QUEUE_CARD = "packages/tiny__core/modules/src/queue.ts.md";
const WORKER_CONFIG_SOURCE = "apps/worker/src/config.ts";
const WORKER_CONFIG_CARD = "packages/worker/modules/src/config.ts.md";

const temporaries: string[] = [];
let parser: ParserHandle;

beforeAll(async () => {
  parser = await createParser();
});

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** A temp copy of the fixture with a freshly written, in-sync `.greplost/`. */
async function freshRepo(label: string): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-verify-${label}-`));
  temporaries.push(dir);
  const root = path.join(dir, "repo");
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  const built = await buildArtifacts(root, { parser });
  writeArtifacts(root, built.files);
  return root;
}

function artifact(root: string, rel: string): string {
  return path.join(root, ".greplost", rel);
}

describe("verify", () => {
  test("reports ok on a freshly written map", async () => {
    const root = await freshRepo("clean");
    const result = await verify(root, { parser, diff: true });

    expect(result.ok).toBe(true);
    expect(result.changed).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.diff).toBeUndefined();
  });

  test("reports the card of an edited source file as changed, with a unified diff", async () => {
    const root = await freshRepo("changed");
    const source = path.join(root, QUEUE_SOURCE);
    writeFileSync(source, `import { retry } from "./retry";\n${readFileSync(source, "utf8")}`);

    const result = await verify(root, { parser, diff: true });

    expect(result.ok).toBe(false);
    expect(result.changed).toContain(QUEUE_CARD);
    expect(result.changed).toContain("manifest.json");
    expect(result.changed).toContain("graph/imports.jsonl");
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);

    const diff = result.diff as string;
    const lines = diff.split("\n");
    // The diff is of the first divergent path, and `changed` is sorted.
    const first = result.changed[0] as string;
    expect(lines[0]).toBe(`--- a/.greplost/${first}`);
    expect(lines[1]).toBe(`+++ b/.greplost/${first}`);
    expect(diff.startsWith("--- a/.greplost/")).toBe(true);
    expect(lines.some((line) => line.startsWith("@@ "))).toBe(true);
    expect(lines.some((line) => line.startsWith("+") && !line.startsWith("+++"))).toBe(true);
  });

  test("writing the rebuilt map makes verify ok again", async () => {
    const root = await freshRepo("update");
    const source = path.join(root, QUEUE_SOURCE);
    writeFileSync(source, `import { retry } from "./retry";\n${readFileSync(source, "utf8")}`);
    expect((await verify(root, { parser })).ok).toBe(false);

    const rebuilt = await buildArtifacts(root, { parser });
    const written = writeArtifacts(root, rebuilt.files);
    expect(written.written.length).toBeGreaterThan(0);

    const result = await verify(root, { parser, diff: true });
    expect(`${result.changed}|${result.missing}|${result.extra}`).toBe("||");
    expect(result.ok).toBe(true);
  });

  test("reports the card of a deleted source file as extra", async () => {
    const root = await freshRepo("deleted");
    rmSync(path.join(root, WORKER_CONFIG_SOURCE));

    const result = await verify(root, { parser, diff: true });

    expect(result.ok).toBe(false);
    expect(result.extra).toContain(WORKER_CONFIG_CARD);
    expect(result.missing).toEqual([]);
  });

  test("reports a stray structure file as extra and a stray cache file not at all", async () => {
    const root = await freshRepo("stray");
    writeFileSync(artifact(root, "repo/STRAY.md"), "# stray\n");
    mkdirSync(artifact(root, "cache"), { recursive: true });
    writeFileSync(artifact(root, "cache/foo.json"), "{}\n");
    writeFileSync(artifact(root, "packages/tiny__core/FLOWS.md"), "# flows\n");
    writeFileSync(artifact(root, ".dirty"), "x\n");

    const result = await verify(root, { parser, diff: true });

    expect(result.ok).toBe(false);
    expect(result.extra).toEqual(["repo/STRAY.md"]);
    expect(result.changed).toEqual([]);
    expect(result.missing).toEqual([]);
    // An extra file reads as a whole-file removal against the expected tree.
    const lines = (result.diff as string).split("\n");
    expect(lines[0]).toBe("--- a/.greplost/repo/STRAY.md");
    expect(lines[1]).toBe("+++ b/.greplost/repo/STRAY.md");
    expect(lines).toContain("-# stray");
  });

  test("reports a deleted artifact as missing, diffed as a whole-file addition", async () => {
    const root = await freshRepo("missing");
    rmSync(artifact(root, "INDEX.md"));
    rmSync(artifact(root, "graph/calls.jsonl"));

    const result = await verify(root, { parser, diff: true });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["INDEX.md", "graph/calls.jsonl"]);
    expect(result.changed).toEqual([]);
    expect(result.extra).toEqual([]);
    const lines = (result.diff as string).split("\n");
    expect(lines[0]).toBe("--- a/.greplost/INDEX.md");
    expect(lines[1]).toBe("+++ b/.greplost/INDEX.md");
    expect(lines.filter((line) => line.startsWith("-") && !line.startsWith("---"))).toEqual([]);
    expect(lines.some((line) => line.startsWith("+# "))).toBe(true);
  });

  test("reports every artifact as missing when there is no .greplost at all", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-verify-unbuilt-"));
    temporaries.push(dir);
    const root = path.join(dir, "repo");
    cpSync(FIXTURE_ROOT, root, { recursive: true });

    const expected = (await buildArtifacts(root, { parser })).files;
    const result = await verify(root, { parser, diff: true });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([...expected.keys()].sort());
    expect(result.missing.length).toBe(27);
    expect(result.changed).toEqual([]);
    expect(result.extra).toEqual([]);

    const lines = (result.diff as string).split("\n");
    expect(lines[0]).toBe("--- a/.greplost/INDEX.md");
    expect(lines[1]).toBe("+++ b/.greplost/INDEX.md");
    expect(lines[2]).toMatch(/^@@ -0,0 \+1,\d+ @@$/);
    expect(lines.filter((line) => line.startsWith("-") && !line.startsWith("---"))).toEqual([]);
  });

  test("omits the diff unless it is asked for", async () => {
    const root = await freshRepo("nodiff");
    rmSync(artifact(root, "INDEX.md"));

    const result = await verify(root, { parser });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["INDEX.md"]);
    expect(result.diff).toBeUndefined();
  });

  test("prefers a changed path over a missing or extra one when diffing", async () => {
    const root = await freshRepo("priority");
    appendFileSync(artifact(root, "repo/MAP.md"), "edited\n");
    rmSync(artifact(root, "INDEX.md"));
    writeFileSync(artifact(root, "repo/STRAY.md"), "# stray\n");

    const result = await verify(root, { parser, diff: true });

    expect(result.changed).toEqual(["repo/MAP.md"]);
    expect(result.missing).toEqual(["INDEX.md"]);
    expect(result.extra).toEqual(["repo/STRAY.md"]);
    expect((result.diff as string).split("\n")[0]).toBe("--- a/.greplost/repo/MAP.md");
  });

  test("reports an artifact that only lost its trailing newline", async () => {
    const root = await freshRepo("newline");
    const target = artifact(root, "repo/MAP.md");
    writeFileSync(target, readFileSync(target, "utf8").replace(/\n$/, ""));

    const result = await verify(root, { parser, diff: true });

    expect(result.changed).toEqual(["repo/MAP.md"]);
    const lines = (result.diff as string).split("\n");
    expect(lines).toContain("\\ No newline at end of file");
    expect(lines.some((line) => line.startsWith("-") && !line.startsWith("---"))).toBe(true);
    expect(lines.some((line) => line.startsWith("+") && !line.startsWith("+++"))).toBe(true);
  });

  test("reports an unreadable artifact as changed rather than crashing", async () => {
    const root = await freshRepo("unreadable");
    const target = artifact(root, "INDEX.md");
    chmodSync(target, 0o000);
    try {
      const result = await verify(root, { parser, diff: true });
      expect(result.changed).toEqual(["INDEX.md"]);
      expect(result.missing).toEqual([]);
      expect(result.extra).toEqual([]);
      expect((result.diff as string).startsWith("--- a/.greplost/INDEX.md")).toBe(true);
    } finally {
      chmodSync(target, 0o644);
    }
  });

  test("reports a directory squatting on an artifact path as changed", async () => {
    const root = await freshRepo("squat");
    const target = artifact(root, "INDEX.md");
    rmSync(target);
    mkdirSync(target, { recursive: true });

    const result = await verify(root, { parser });

    expect(result.changed).toEqual(["INDEX.md"]);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  test("reads the committed summary cache, so seeded prose is not a divergence", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-verify-summaries-"));
    temporaries.push(dir);
    const root = path.join(dir, "repo");
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    mkdirSync(path.join(root, ".greplost/cache"), { recursive: true });
    writeFileSync(
      path.join(root, ".greplost/cache/summaries.json"),
      '{"0000000000000000000000000000000000000000000000000000000000000000":' +
        '{"path":"packages/core/src/bus.ts","text":"Fan-out event bus.","refreshedAt":"2026-08-15","model":"test"}}\n',
    );
    const built = await buildArtifacts(root, { parser });
    writeArtifacts(root, built.files);

    expect(readFileSync(artifact(root, "packages/tiny__core/modules/src/bus.ts.md"), "utf8")).toContain(
      "Fan-out event bus.",
    );
    expect((await verify(root, { parser, diff: true })).ok).toBe(true);
  });
});

describe("unified diff", () => {
  const lines = (text: string): string => `${text.split(" ").join("\n")}\n`;

  test("gives three lines of context on either side of a change", () => {
    const before = lines("a b c d e f g h i j");
    const after = lines("a b c d E f g h i j");

    expect(unifiedDiff("repo/MAP.md", before, after).split("\n")).toEqual([
      "--- a/.greplost/repo/MAP.md",
      "+++ b/.greplost/repo/MAP.md",
      "@@ -2,7 +2,7 @@",
      " b",
      " c",
      " d",
      "-e",
      "+E",
      " f",
      " g",
      " h",
    ]);
  });

  test("splits distant changes into separate hunks and merges near ones", () => {
    const source = "a b c d e f g h i j k l m n o p q r s t";
    const far = unifiedDiff("INDEX.md", lines(source), lines(source.replace("b", "B").replace("s", "S")));
    expect(far.split("\n").filter((line) => line.startsWith("@@ "))).toEqual(["@@ -1,5 +1,5 @@", "@@ -16,5 +16,5 @@"]);

    const near = unifiedDiff("INDEX.md", lines(source), lines(source.replace("b", "B").replace("e", "E")));
    expect(near.split("\n").filter((line) => line.startsWith("@@ "))).toEqual(["@@ -1,8 +1,8 @@"]);
  });

  test("reads a whole-file addition and removal as one hunk each", () => {
    expect(unifiedDiff("INDEX.md", "", lines("a b")).split("\n")).toEqual([
      "--- a/.greplost/INDEX.md",
      "+++ b/.greplost/INDEX.md",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
    ]);
    expect(unifiedDiff("INDEX.md", lines("a b"), "").split("\n")).toEqual([
      "--- a/.greplost/INDEX.md",
      "+++ b/.greplost/INDEX.md",
      "@@ -1,2 +0,0 @@",
      "-a",
      "-b",
    ]);
  });

  test("marks a missing trailing newline on the side that lacks it", () => {
    expect(unifiedDiff("INDEX.md", "a\nb", "a\nb\n").split("\n")).toEqual([
      "--- a/.greplost/INDEX.md",
      "+++ b/.greplost/INDEX.md",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "\\ No newline at end of file",
      "+b",
    ]);
  });

  test("has nothing to say about identical texts", () => {
    expect(unifiedDiff("INDEX.md", lines("a b c"), lines("a b c")).split("\n")).toEqual([
      "--- a/.greplost/INDEX.md",
      "+++ b/.greplost/INDEX.md",
    ]);
  });
});

describe("diff cap", () => {
  test("caps the diff at 200 lines and marks the truncation", async () => {
    const root = await freshRepo("cap");
    const target = artifact(root, "packages/tiny__core/modules/src/bus.ts.md");
    const junk = Array.from({ length: 500 }, (_, i) => `hand-written line ${i}`).join("\n");
    appendFileSync(target, `${junk}\n`);

    const result = await verify(root, { parser, diff: true });
    const diff = result.diff as string;
    const lines = diff.split("\n");

    expect(result.changed).toEqual(["packages/tiny__core/modules/src/bus.ts.md"]);
    expect(lines.length).toBe(200);
    expect(lines[lines.length - 1]).toBe("… truncated");
    expect(lines[0]).toBe("--- a/.greplost/packages/tiny__core/modules/src/bus.ts.md");
    expect(diff.endsWith("\n")).toBe(false);
  });

  test("caps a whole-file addition too", async () => {
    const root = await freshRepo("cap-missing");
    // The manifest is the one tiny-ts artifact longer than the cap.
    rmSync(artifact(root, "manifest.json"));

    const result = await verify(root, { parser, diff: true });
    const lines = (result.diff as string).split("\n");

    expect(result.missing).toEqual(["manifest.json"]);
    expect(lines.length).toBe(200);
    expect(lines[lines.length - 1]).toBe("… truncated");
    expect(lines[2]).toBe("@@ -0,0 +1,222 @@");
  });

  test("caps a rewrite far past the edit-distance bound", () => {
    // Two thousand unrelated lines: the line differ gives up and reports one
    // wholesale replacement, which the cap then trims like any other diff.
    const before = Array.from({ length: 2000 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 2000 }, (_, i) => `new ${i}`).join("\n");
    const lines = unifiedDiff("INDEX.md", `${before}\n`, `${after}\n`).split("\n");

    expect(lines.length).toBe(200);
    expect(lines[lines.length - 1]).toBe("… truncated");
    expect(lines[0]).toBe("--- a/.greplost/INDEX.md");
    expect(lines[3]).toBe("-old 0");
  });

  test("leaves a small diff untruncated", async () => {
    const root = await freshRepo("cap-small");
    appendFileSync(artifact(root, "repo/MAP.md"), "one hand-written line\n");

    const result = await verify(root, { parser, diff: true });
    const lines = (result.diff as string).split("\n");

    expect(lines.length).toBeLessThan(200);
    expect(lines).not.toContain("… truncated");
    expect(lines).toContain("-one hand-written line");
  });
});

describe("colliding node cards", () => {
  test("a case-only node collision costs one card, and verify is still clean", async () => {
    // `resource "aws_vpc" "Main"` beside `resource "aws_vpc" "main"` is legal
    // Terraform and two node ids that are one file on APFS. The render skips the
    // later card and warns (ruling 2026-09-05); the half that matters to CI is
    // here: the map is still written, and `verify` renders the same artifact set
    // and reports clean, rather than the build failing outright over one node.
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-verify-collide-"));
    temporaries.push(dir);
    const root = path.join(dir, "repo");
    mkdirSync(path.join(root, ".greplost"), { recursive: true });
    writeFileSync(path.join(root, ".greplost", "config.json"), JSON.stringify({ languages: ["hcl"] }));
    writeFileSync(
      path.join(root, "main.tf"),
      'resource "aws_vpc" "Main" {\n  cidr_block = "10.0.0.0/16"\n}\n\n' +
        'resource "aws_vpc" "main" {\n  cidr_block = "10.1.0.0/16"\n}\n',
    );

    const built = await buildArtifacts(root, { parser });
    expect(built.warnings).toHaveLength(1);
    expect(built.warnings[0]).toContain("main.tf#resource.aws_vpc.main");
    expect(built.warnings[0]).toContain("main.tf#resource.aws_vpc.Main");
    // The map was still built: the file card and the surviving node card are there.
    expect(built.files.has("packages/root/modules/main.tf.md")).toBe(true);
    expect(built.files.has("packages/root/modules/main.tf/resource.aws_vpc.Main.md")).toBe(true);

    writeArtifacts(root, built.files);
    const result = await verify(root, { parser });
    expect([result.ok, result.changed, result.missing, result.extra]).toEqual([true, [], [], []]);
  });
});
