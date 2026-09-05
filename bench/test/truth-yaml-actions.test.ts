/**
 * GitHub Actions truth generator tests (leaf 2.9, gates G8 and G9).
 *
 * Everything in `workflow oracle` is read off `fixtures/tiny-actions` by hand and pinned: these
 * are the numbers the Actions structure layer is scored against, so they are written out in
 * full rather than recomputed from the thing under test.
 *
 * `oracle independence` is the integrity check of tech spec 10.1 principle 2: the oracle may
 * not be able to agree with greplost by construction. Two properties, and both are needed — a
 * generator that imported greplost's extractor could not disagree with it, and one that
 * returned a constant could not disagree with anything.
 *
 * The `describe` names are fixed by spec section 2.6: `workflow oracle`, `oracle independence`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NOTES, generateExtra, generateTruth, isActionsFile } from "../src/truth/yaml-actions.ts";
import {
  flavourOf,
  generateExtra as generateYamlExtra,
  generateTruth as generateYamlTruth,
  groupByFlavour,
} from "../src/truth/yaml.ts";
import { edgeKey } from "../src/score.ts";
import { loadTruth } from "../src/truth/registry.ts";
import { FIXTURES } from "../src/fixtures.ts";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const actionsRoot = path.join(repoRoot, "fixtures", "tiny-actions");

const SETUP = ".github/actions/setup/action.yml";
const CI = ".github/workflows/ci.yml";
const RELEASE = ".github/workflows/release.yml";
const FILES = [SETUP, CI, RELEASE];
/** The whole file set the fixture is indexed with: the workflows plus the scripts they run. */
const UNIVERSE = [...FILES, "scripts/announce.mjs", "scripts/x.ts"];

const truth = generateTruth(actionsRoot, FILES);
const extra = generateExtra(actionsRoot, FILES, UNIVERSE);

const temporaryDirs: string[] = [];
afterAll(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

const keys = (edges: ReadonlyArray<{ from: string; to: string }>): string[] => edges.map(edgeKey);

// ---------------------------------------------------------------------------

describe("workflow oracle", () => {
  test("the truth registry finds the flavour by convention and it declares which oracle ran", async () => {
    const actions = await loadTruth("yaml-actions");
    expect(typeof actions.generateTruth).toBe("function");
    expect(typeof actions.generateExtra).toBe("function");
    expect(actions.NOTES).toEqual(NOTES);
    // `@actions/workflow-parser` would be a manifest edit this leaf may not make, so the note
    // says what actually read the files.
    expect(NOTES).toEqual(["js-yaml-oracle"]);
    expect(FIXTURES["tiny-actions"]?.lang).toBe("yaml");
  });

  test("truth covers exactly the indexed workflows, and neither imports nor calls exist", () => {
    expect(truth.files).toEqual(FILES.slice().sort());
    expect(truth.imports).toEqual([]);
    expect(truth.calls).toEqual([]);
    expect(truth.cycles).toEqual([]);
    expect(truth.notes).toContain("unsupported:S3");
    expect(truth.notes).toContain("js-yaml-oracle");
  });

  test("exports are each file's sorted job ids, and an action definition has none", () => {
    expect(truth.exports).toEqual({
      [SETUP]: [],
      [CI]: ["build", "test"],
      [RELEASE]: ["announce", "publish"],
    });
  });

  test("the node set is every job, step and task the fixture declares", () => {
    expect(extra.nodes).toEqual([
      `${SETUP}#step.runs.~0`,
      `${SETUP}#step.runs.~1`,
      `${CI}#job.build`,
      `${CI}#job.test`,
      `${CI}#step.build.~0`,
      `${CI}#step.build.~1`,
      `${CI}#step.test.~0`,
      `${RELEASE}#job.announce`,
      `${RELEASE}#step.announce.~0`,
      `${RELEASE}#task.publish`,
    ]);
  });

  test("the reference set carries the needs, the uses and the run scripts", () => {
    expect(keys(extra.references)).toEqual([
      `${SETUP}#step.runs.~0 -> ext:action/actions/setup-node`,
      `${CI}#job.test -> ${CI}#job.build`,
      `${CI}#step.build.~0 -> ext:action/actions/checkout`,
      `${CI}#step.build.~1 -> scripts/x.ts`,
      `${CI}#step.test.~0 -> ${SETUP}`,
      `${RELEASE}#job.announce -> ${RELEASE}#task.publish`,
      `${RELEASE}#step.announce.~0 -> scripts/announce.mjs`,
      `${RELEASE}#task.publish -> ${CI}`,
    ]);
    // Every edge carries its `refKind`, which is what makes the S5 key (from, to, refKind).
    expect(extra.references.every((edge) => typeof (edge as { refKind?: string }).refKind === "string")).toBe(true);
    expect(extra.references.map((edge) => (edge as unknown as { refKind: string }).refKind)).toEqual([
      "uses",
      "needs",
      "uses",
      "config",
      "uses",
      "needs",
      "config",
      "uses",
    ]);
  });

  test("a run token that names no file in the universe draws no edge", () => {
    // The default universe is the workflow group alone, so neither script is reachable.
    const narrow = generateExtra(actionsRoot, FILES);
    expect(keys(narrow.references).filter((key) => key.includes("scripts/"))).toEqual([]);
    expect(narrow.nodes).toEqual(extra.nodes);
  });

  test("an empty truth is an error, never a score", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "greplost-actions-empty-"));
    temporaryDirs.push(empty);
    expect(() => generateTruth(empty, ["nowhere.yml"])).toThrow(/yaml-actions truth is empty/);
    // No files requested is not an empty truth, it is no question: it answers without throwing.
    expect(generateTruth(empty, []).files).toEqual([]);
  });

  test("a workflow outside .github/workflows is still a workflow, by its content", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-actions-template-"));
    temporaryDirs.push(dir);
    writeFileSync(path.join(dir, "template.yml"), "on: push\njobs:\n  build:\n    steps:\n      - run: true\n");
    writeFileSync(path.join(dir, "plain.yml"), "server:\n  port: 8080\n");
    expect(isActionsFile(dir, "template.yml")).toBe(true);
    expect(isActionsFile(dir, "plain.yml")).toBe(false);
    expect(flavourOf("template.yml", dir)).toBe("yaml-actions");
    expect(flavourOf("plain.yml", dir)).toBe("yaml-k8s");
    // Without a root the path rules are all the dispatcher has, which is the seam's contract.
    expect(flavourOf("template.yml")).toBe("yaml-k8s");
  });

  test("the yaml dispatcher routes the fixture's three files to this flavour and merges its answer", () => {
    expect(groupByFlavour(FILES, actionsRoot)).toEqual([["yaml-actions", FILES.slice().sort()]]);
    const merged = generateYamlTruth(actionsRoot, FILES);
    expect(merged.exports).toEqual(truth.exports);
    expect(generateYamlExtra(actionsRoot, FILES).nodes).toEqual(extra.nodes);
  });
});

// ---------------------------------------------------------------------------

describe("oracle independence", () => {
  test("the truth generator reads no greplost extractor, resolver or tree-sitter", () => {
    const source = readFileSync(path.join(repoRoot, "bench", "src", "truth", "yaml-actions.ts"), "utf8");
    // Prose is not a dependency, so the check reads the import specifiers rather than the text.
    const specifiers = [...source.matchAll(/^\s*(?:import|export)[^"']*from\s+["']([^"']+)["']/gmu)].map(
      (match) => match[1] as string,
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/tree-sitter|^@greplost\/core$|\/(?:extract|resolve|references|signals)\//u);
    }
    // The schema (ids and sorting) is the shared vocabulary, and is allowed.
    expect(specifiers).toContain("@greplost/core/schema");
    // js-yaml is the parser, and it is a different one from the grammar greplost reads with.
    expect(specifiers).toContain("js-yaml");
    // Nothing here ever builds a greplost snapshot.
    expect(source).not.toContain("buildSnapshot(");
  });

  test("the oracle's answer tracks the fixture: add a job, a step and a needs, move the truth", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-actions-copy-"));
    temporaryDirs.push(dir);
    cpSync(actionsRoot, dir, { recursive: true });

    const before = generateTruth(dir, FILES);
    expect(before.exports).toEqual(truth.exports);
    expect(generateExtra(dir, FILES, UNIVERSE).nodes).toEqual(extra.nodes);

    // One more workflow: two jobs, a `needs`, an external action and a local one. An oracle that
    // echoed greplost, or that cached its answer, would not move.
    const changed = mkdtempSync(path.join(tmpdir(), "greplost-actions-changed-"));
    temporaryDirs.push(changed);
    cpSync(actionsRoot, changed, { recursive: true });
    mkdirSync(path.join(changed, ".github", "workflows"), { recursive: true });
    writeFileSync(
      path.join(changed, ".github", "workflows", "nightly.yml"),
      [
        "name: Nightly",
        "on:",
        "  schedule:",
        "    - cron: '0 0 * * *'",
        "jobs:",
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "  report:",
        "    needs: lint",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: ./.github/actions/setup",
        "",
      ].join("\n"),
    );

    const nightly = ".github/workflows/nightly.yml";
    const files = [...FILES, nightly].sort();
    const after = generateTruth(changed, files);
    const afterExtra = generateExtra(changed, files, [...UNIVERSE, nightly].sort());

    expect(after.files).toEqual(files);
    expect(after.exports[nightly]).toEqual(["lint", "report"]);
    expect(afterExtra.nodes).toContain(`${nightly}#job.lint`);
    expect(afterExtra.nodes).toContain(`${nightly}#step.report.~0`);
    expect(afterExtra.nodes.length).toBe(extra.nodes.length + 4);
    expect(keys(afterExtra.references)).toContain(`${nightly}#job.report -> ${nightly}#job.lint`);
    expect(keys(afterExtra.references)).toContain(`${nightly}#step.report.~0 -> ${SETUP}`);
  });

  test("deleting a step moves the truth, so a stale answer cannot pass", () => {
    const changed = mkdtempSync(path.join(tmpdir(), "greplost-actions-shrunk-"));
    temporaryDirs.push(changed);
    cpSync(actionsRoot, changed, { recursive: true });
    const ci = readFileSync(path.join(changed, CI), "utf8");
    writeFileSync(
      path.join(changed, CI),
      ci.replace("      - uses: actions/checkout@v4\n", ""),
    );

    const shrunk = generateExtra(changed, FILES, UNIVERSE);
    expect(shrunk.nodes).not.toContain(`${CI}#step.build.~1`);
    expect(shrunk.nodes.length).toBe(extra.nodes.length - 1);
    expect(keys(shrunk.references)).toContain(`${CI}#step.build.~0 -> scripts/x.ts`);
  });
});
