/**
 * The provenance figure `INDEX.md` carries (leaf 2.15, fix round 1 I3).
 *
 * `buildArtifacts` counts the files the config's *test* patterns keep out of
 * the map, and that count reaches a committed artifact, so it has to be a
 * function of the source and of nothing else. It was not: the counting pass
 * dropped every exclude but `node_modules` and `.git`, so build output that git
 * ignores was invisible inside a checkout and counted outside one, and the same
 * tree produced two different `INDEX.md` files depending on whether `.git` had
 * come along. `greplost verify` on an exported copy would have called that
 * drift.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildArtifacts } from "../src/build.ts";

const temporaries: string[] = [];

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/**
 * The reviewer's tree: one source file, one test file the config excludes, and
 * one build artifact that a checkout's `.gitignore` hides and a bare copy does
 * not. `git` decides only whether the directory is a work tree.
 */
function tree(label: string, git: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-prov-${label}-`));
  temporaries.push(dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, "dist"), { recursive: true });
  writeFileSync(path.join(dir, "src", "index.ts"), "export const index = 1;\n");
  writeFileSync(path.join(dir, "src", "index.test.ts"), "export const spec = 1;\n");
  writeFileSync(path.join(dir, "dist", "bundle.js"), "export const bundled = 1;\n");
  writeFileSync(path.join(dir, ".gitignore"), "dist/\n");
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  }
  return dir;
}

/** The provenance line of a freshly built `INDEX.md`. */
async function provenanceLine(dir: string): Promise<string> {
  const { files } = await buildArtifacts(dir);
  const index = files.get("INDEX.md") ?? "";
  return index.split("\n").find((line) => line.startsWith("> Provenance:")) ?? "";
}

describe("provenance count", () => {
  test("counts the test files the config excludes, and nothing else", async () => {
    const line = await provenanceLine(tree("git", true));
    expect(line).toContain("1 test file excluded");
    expect(line).toContain(".greplost/config.json");
  });

  test("is the same inside a checkout and in an exported copy of it", async () => {
    const inside = await provenanceLine(tree("inside", true));
    const exported = await provenanceLine(tree("exported", false));
    expect(exported).toBe(inside);
  });

  test("a tree with no excluded tests says zero rather than nothing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-prov-plain-"));
    temporaries.push(dir);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.ts"), "export const index = 1;\n");

    expect(await provenanceLine(dir)).toContain("0 test files excluded");
  });
});
