/**
 * Leaf 2.9: GitHub Actions workflow extraction and reference linking.
 *
 * Three layers, each tested on inline sources first and then pinned against
 * `fixtures/tiny-actions` end to end:
 *   - `extractYamlActions`           — the `job`, `step` and `task` nodes one workflow makes
 *                                      (spec 2.4, "Declarations");
 *   - `resolveYamlActionsReferences` — `needs`, `uses` and `config` resolved to the one node or
 *                                      file each names, or dropped rather than guessed;
 *   - the fixture                    — every rule at once, through `buildSnapshot`.
 *
 * The `describe` names are fixed by spec section 2.6: `jobs`, `steps`, `needs`, `uses`,
 * `run scripts`, `tiny-actions`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createParser } from "../src/parser.ts";
import type { ParserHandle } from "../src/parser.ts";
import { extractFile } from "../src/extract/index.ts";
import { buildSnapshot } from "../src/build.ts";
import type { Declaration, FileRecord, GreplostConfig, ReferenceEdge, Snapshot } from "../src/schema.ts";
import { DEFAULT_CONFIG } from "../src/schema.ts";

const ZERO_SHA = "0".repeat(64);
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TINY_ACTIONS = path.join(REPO_ROOT, "fixtures", "tiny-actions");
const CI = ".github/workflows/ci.yml";
const RELEASE = ".github/workflows/release.yml";
const SETUP = ".github/actions/setup/action.yml";
/** The fixture indexes scripts alongside workflows, so a `config` edge has a real target. */
const WORKFLOW_CONFIG: GreplostConfig = { ...DEFAULT_CONFIG, languages: ["yaml", "ts", "js"] };

let parser: ParserHandle;

beforeAll(async () => {
  parser = await createParser();
});

function run(file: string, source: string): FileRecord {
  return extractFile({ path: file, lang: "yaml", source, sha256: ZERO_SHA }, parser);
}

function decl(record: FileRecord, name: string): Declaration {
  const found = record.decls.find((d) => d.name === name);
  if (!found) throw new Error(`no declaration named ${name} in [${record.decls.map((d) => d.name).join(", ")}]`);
  return found;
}

const temporaryDirs: string[] = [];
afterAll(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

/** Build a snapshot over a throwaway repo written from `files` (repo-relative path -> text). */
async function snapshotOf(files: Readonly<Record<string, string>>): Promise<Snapshot> {
  const dir = mkdtempSync(path.join(tmpdir(), "greplost-actions-"));
  temporaryDirs.push(dir);
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(dir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
  }
  return buildSnapshot({ root: dir, config: WORKFLOW_CONFIG });
}

/** Reference edges as `<from> -<refKind>-> <to> [symbols] <confidence>`, in artifact order. */
function references(snapshot: Snapshot): string[] {
  return (snapshot.references ?? []).map(
    (edge: ReferenceEdge) =>
      `${edge.from} -${edge.refKind}-> ${edge.to} [${(edge.symbols ?? []).join(",")}] ${edge.confidence}`,
  );
}

const CI_YML = `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    name: Build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build the thing
        run: bun run scripts/x.ts
  test:
    runs-on: ubuntu-latest
    needs: build
    if: github.event_name == 'push'
    steps:
      - uses: ./.github/actions/setup
`;

const RELEASE_YML = `name: Release

on:
  release:
    types: [published]

jobs:
  publish:
    uses: ./.github/workflows/ci.yml
  announce:
    runs-on: ubuntu-latest
    needs: [publish]
    steps:
      - name: Say so
        run: node scripts/announce.mjs
`;

const SETUP_YML = `name: Setup
description: Install the toolchain this repository builds with.

runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
      with:
        node-version: 20
    - name: Install dependencies
      run: bun install --frozen-lockfile
      shell: bash
`;

describe("jobs", () => {
  test("jobs and steps become nodes in document order, with index-suffixed step names", () => {
    const out = run(CI, CI_YML);
    expect(out.decls.map((d) => d.id)).toEqual([
      `${CI}#job.build`,
      `${CI}#step.build.~0`,
      `${CI}#step.build.~1`,
      `${CI}#job.test`,
      `${CI}#step.test.~0`,
    ]);
  });

  test("a job carries its display name, runner and condition in meta", () => {
    const out = run(CI, CI_YML);
    expect(decl(out, "build").meta).toEqual({ flavour: "actions", name: "Build", runsOn: "ubuntu-latest" });
    expect(decl(out, "test").meta).toEqual({
      flavour: "actions",
      if: "github.event_name == 'push'",
      runsOn: "ubuntu-latest",
    });
  });

  test("a job whose body is a reusable-workflow call is a task node named after the job", () => {
    const out = run(RELEASE, RELEASE_YML);
    expect(out.decls.map((d) => `${d.kind} ${d.name}`)).toEqual([
      "task publish",
      "job announce",
      "step announce.~0",
    ]);
    expect(decl(out, "publish").meta?.["uses"]).toBe("./.github/workflows/ci.yml");
  });

  test("the file exports its job ids, which is what another workflow reaches for", () => {
    expect(run(RELEASE, RELEASE_YML).exports.map((e) => e.name).sort()).toEqual(["announce", "publish"]);
    expect(run(CI, CI_YML).exports.map((e) => e.name)).toEqual(["build", "test"]);
  });

  test("a workflow has neither imports nor calls: every dependency it has is a reference", () => {
    const out = run(CI, CI_YML);
    expect(out.imports).toEqual([]);
    expect(out.calls).toEqual([]);
  });

  test("a YAML file that is not a workflow contributes nothing through this flavour", () => {
    const out = run("config/app.yml", "server:\n  port: 8080\n");
    expect(out.decls).toEqual([]);
  });
});

describe("steps", () => {
  test("a step's name is its 0-based position in the job, never a hash", () => {
    const out = run(CI, CI_YML);
    expect(out.decls.filter((d) => d.kind === "step").map((d) => d.name)).toEqual([
      "build.~0",
      "build.~1",
      "test.~0",
    ]);
    for (const step of out.decls) expect(step.name).not.toContain("#");
  });

  test("a step carries meta.uses or meta.run, and its display name when it has one", () => {
    const out = run(CI, CI_YML);
    expect(decl(out, "build.~0").meta).toEqual({ flavour: "actions", uses: "actions/checkout@v4" });
    expect(decl(out, "build.~1").meta).toEqual({
      flavour: "actions",
      name: "Build the thing",
      run: "bun run scripts/x.ts",
    });
  });

  test("a run body is clipped to 80 characters with its whitespace collapsed", () => {
    const body = `echo ${"a".repeat(200)}`;
    const out = run(CI, `on: push\njobs:\n  j:\n    steps:\n      - run: |\n          echo one\n          ${body}\n`);
    const meta = decl(out, "j.~0").meta as Record<string, string>;
    expect(meta["run"]).toBe(`echo one echo ${"a".repeat(200)}`.slice(0, 80));
    expect(meta["run"]).not.toContain("\n");
  });

  test("a composite action's action.yml produces the same steps under the synthetic job id runs", () => {
    const out = run(SETUP, SETUP_YML);
    expect(out.decls.map((d) => d.id)).toEqual([`${SETUP}#step.runs.~0`, `${SETUP}#step.runs.~1`]);
    expect(decl(out, "runs.~0").meta?.["uses"]).toBe("actions/setup-node@v4");
  });

  test("renaming one job does not renumber another job's steps", () => {
    const first = run(CI, CI_YML);
    const renamed = run(CI, CI_YML.replace("  build:\n", "  compile:\n").replace("needs: build", "needs: compile"));
    expect(renamed.decls.filter((d) => d.kind === "step").map((d) => d.name)).toEqual([
      "compile.~0",
      "compile.~1",
      "test.~0",
    ]);
    expect(first.decls.filter((d) => d.name.startsWith("test.")).map((d) => d.name)).toEqual(["test.~0"]);
  });
});

describe("needs", () => {
  test("needs becomes a high-confidence edge to the named job", async () => {
    const snapshot = await snapshotOf({ [CI]: CI_YML });
    expect(references(snapshot)).toContain(`${CI}#job.test -needs-> ${CI}#job.build [build] high`);
  });

  test("a needs sequence resolves each entry, including one naming a reusable-workflow job", async () => {
    const snapshot = await snapshotOf({ [RELEASE]: RELEASE_YML });
    expect(references(snapshot)).toContain(
      `${RELEASE}#job.announce -needs-> ${RELEASE}#task.publish [publish] high`,
    );
  });

  test("needs naming a job that does not exist is dropped, never guessed", async () => {
    const snapshot = await snapshotOf({
      [CI]: "on: push\njobs:\n  a:\n    needs: nowhere\n    steps:\n      - run: true\n",
    });
    expect(references(snapshot).filter((line) => line.includes("-needs->"))).toEqual([]);
  });

  test("needs never reaches into another file, even when that file has the job id", async () => {
    const snapshot = await snapshotOf({
      [CI]: "on: push\njobs:\n  build:\n    steps:\n      - run: true\n",
      [RELEASE]: "on: push\njobs:\n  ship:\n    needs: build\n    steps:\n      - run: true\n",
    });
    expect(references(snapshot).filter((line) => line.includes("-needs->"))).toEqual([]);
  });
});

describe("uses", () => {
  test("a third-party action resolves to ext:action/<owner>/<repo> with the ref in meta", async () => {
    const snapshot = await snapshotOf({ [CI]: CI_YML });
    expect(references(snapshot)).toContain(
      `${CI}#step.build.~0 -uses-> ext:action/actions/checkout [actions/checkout@v4] high`,
    );
    const step = snapshot.symbols.find((d) => d.id === `${CI}#step.build.~0`) as Declaration;
    expect(step.meta?.["usesRef"]).toBe("v4");
  });

  test("an action in a subdirectory of a repo keeps the subdirectory: two actions, two nodes", () => {
    const out = run(CI, [
      "on: push",
      "jobs:",
      "  j:",
      "    steps:",
      "      - uses: github/codeql-action/init@v3",
      "      - uses: github/codeql-action/analyze@v3",
      "",
    ].join("\n"));
    expect(out.refs?.map((r) => r.to)).toEqual(["github/codeql-action/init@v3", "github/codeql-action/analyze@v3"]);
  });

  test("a repo-local action resolves to its action.yml file", async () => {
    const snapshot = await snapshotOf({ [CI]: CI_YML, [SETUP]: SETUP_YML });
    expect(references(snapshot)).toContain(
      `${CI}#step.test.~0 -uses-> ${SETUP} [./.github/actions/setup] high`,
    );
  });

  test("a reusable workflow call resolves to the workflow file", async () => {
    const snapshot = await snapshotOf({ [CI]: CI_YML, [RELEASE]: RELEASE_YML });
    expect(references(snapshot)).toContain(
      `${RELEASE}#task.publish -uses-> ${CI} [./.github/workflows/ci.yml] high`,
    );
  });

  test("a local action whose directory holds no action.yml is dropped, not invented", async () => {
    const snapshot = await snapshotOf({
      [CI]: "on: push\njobs:\n  j:\n    steps:\n      - uses: ./.github/actions/missing\n",
    });
    expect(references(snapshot).filter((line) => line.includes("-uses->"))).toEqual([]);
  });

  test("a uses built from an expression names no action and is dropped", () => {
    const out = run(CI, "on: push\njobs:\n  j:\n    steps:\n      - uses: ${{ matrix.action }}\n");
    expect(out.refs).toEqual([]);
  });

  test("a docker:// action is not a repository and is dropped", () => {
    const out = run(CI, "on: push\njobs:\n  j:\n    steps:\n      - uses: docker://alpine:3.18\n");
    expect(out.refs).toEqual([]);
  });
});

describe("run scripts", () => {
  test("a run body naming exactly one repo path links the workflow to the script", async () => {
    const snapshot = await snapshotOf({ [CI]: CI_YML, "scripts/x.ts": "export const x = 1;\n" });
    expect(references(snapshot)).toContain(
      `${CI}#step.build.~1 -config-> scripts/x.ts [scripts/x.ts] high`,
    );
  });

  test("a run body naming a token that matches two files is dropped", async () => {
    const snapshot = await snapshotOf({
      [CI]: "on: push\njobs:\n  j:\n    steps:\n      - run: node build.js\n",
      "a/build.js": "export const a = 1;\n",
      "b/build.js": "export const b = 1;\n",
    });
    expect(references(snapshot).filter((line) => line.includes("-config->"))).toEqual([]);
  });

  test("a run body naming no repo path at all produces no edge", async () => {
    const snapshot = await snapshotOf({
      [CI]: "on: push\njobs:\n  j:\n    steps:\n      - run: echo hello && make release\n",
      "scripts/x.ts": "export const x = 1;\n",
    });
    expect(references(snapshot).filter((line) => line.includes("-config->"))).toEqual([]);
  });

  test("a token holding a shell expansion is never a literal path", async () => {
    const snapshot = await snapshotOf({
      [CI]: "on: push\njobs:\n  j:\n    steps:\n      - run: node ${{ matrix.dir }}/x.ts\n",
      "scripts/x.ts": "export const x = 1;\n",
    });
    expect(references(snapshot).filter((line) => line.includes("-config->"))).toEqual([]);
  });
});

describe("tiny-actions", () => {
  test("the fixture builds the expected node set", async () => {
    const snapshot = await buildSnapshot({ root: TINY_ACTIONS, config: WORKFLOW_CONFIG });
    const nodes = snapshot.symbols.filter((d) => d.file.endsWith(".yml")).map((d) => d.id);
    expect(nodes).toEqual([
      `${SETUP}#step.runs.~0`,
      `${SETUP}#step.runs.~1`,
      `${CI}#job.build`,
      `${CI}#step.build.~0`,
      `${CI}#step.build.~1`,
      `${CI}#job.test`,
      `${CI}#step.test.~0`,
      `${RELEASE}#task.publish`,
      `${RELEASE}#job.announce`,
      `${RELEASE}#step.announce.~0`,
    ]);
  });

  test("the fixture draws all three reference kinds and nothing else", async () => {
    const snapshot = await buildSnapshot({ root: TINY_ACTIONS, config: WORKFLOW_CONFIG });
    expect(references(snapshot)).toEqual([
      `${SETUP}#step.runs.~0 -uses-> ext:action/actions/setup-node [actions/setup-node@v4] high`,
      `${CI}#job.test -needs-> ${CI}#job.build [build] high`,
      `${CI}#step.build.~0 -uses-> ext:action/actions/checkout [actions/checkout@v4] high`,
      `${CI}#step.build.~1 -config-> scripts/x.ts [scripts/x.ts] high`,
      `${CI}#step.test.~0 -uses-> ${SETUP} [./.github/actions/setup] high`,
      `${RELEASE}#job.announce -needs-> ${RELEASE}#task.publish [publish] high`,
      `${RELEASE}#step.announce.~0 -config-> scripts/announce.mjs [scripts/announce.mjs] high`,
      `${RELEASE}#task.publish -uses-> ${CI} [./.github/workflows/ci.yml] high`,
    ]);
  });

  test("no node id and no artifact key the fixture produces contains a '#' inside a name", async () => {
    const snapshot = await buildSnapshot({ root: TINY_ACTIONS, config: WORKFLOW_CONFIG });
    for (const decl_ of snapshot.symbols) expect(decl_.name).not.toContain("#");
  });
});
