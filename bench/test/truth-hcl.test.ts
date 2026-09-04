/**
 * Terraform truth generator tests (leaf 2.2, gates G7 and G8).
 *
 * Everything in `fixture truth` is read off `fixtures/tiny-terraform` by hand and pinned: these
 * are the numbers the Terraform structure layer is scored against, so they are written out in
 * full rather than recomputed from the thing under test.
 *
 * `fixture truth` also carries the leaf's real **S5**. `bench/src/structural.ts` still hard-codes
 * `S5: null` — wiring `generateExtra` into `scoreAgainstTruth` is a change to a file leaf 2.0
 * owns and three wave-1 leaves share, so it is reported to the driver rather than made here —
 * and a metric nobody computes is a metric nobody can fail. Reference precision and recall are
 * therefore computed here, from this leaf's own oracle, with the same `scoreEdges` the harness
 * would use and against the same 0.95 threshold `gates/leaf-2.2.md` states.
 *
 * `oracle independence` is the integrity check of tech spec 10.1 principle 2: the oracle must
 * not be able to agree with greplost by construction.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, type GreplostConfig } from "@greplost/core/schema";
import { NOTES, generateExtra, generateTruth, tfinspectTool } from "../src/truth/hcl.ts";
import { edgeKey, exportKeys, scoreEdges, scoreSet } from "../src/score.ts";
import { loadTruth } from "../src/truth/registry.ts";
import { FIXTURES } from "../src/fixtures.ts";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const fixtureRoot = path.join(repoRoot, "fixtures", "tiny-terraform");

/** Every indexed `.tf` file of the fixture. */
const FIXTURE_FILES = [
  "main.tf",
  "modules/logs/main.tf",
  "modules/logs/outputs.tf",
  "outputs.tf",
  "variables.tf",
];

const HCL_CONFIG: GreplostConfig = { ...DEFAULT_CONFIG, languages: ["hcl"] };

const truth = generateTruth(fixtureRoot, FIXTURE_FILES);
const extra = generateExtra(fixtureRoot, FIXTURE_FILES);

const temporaryDirs: string[] = [];
afterAll(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

const keys = (edges: ReadonlyArray<{ from: string; to: string }>): string[] => edges.map(edgeKey);

// ---------------------------------------------------------------------------

describe("tf tool", () => {
  test("the inspector is built once and cached under bench/.corpus/.tools", () => {
    const binary = tfinspectTool();
    expect(existsSync(binary)).toBe(true);
    expect(path.dirname(binary)).toBe(path.join(repoRoot, "bench", ".corpus", ".tools"));
    // Content-addressed by its own sources, so a second call never rebuilds.
    expect(tfinspectTool()).toBe(binary);
    expect(path.basename(binary)).toMatch(/^tfinspect-[0-9a-f]{16}$/);
  });

  test("the helper module pins terraform-config-inspect and hcl/v2", () => {
    const dir = path.join(repoRoot, "bench", "truth", "tfinspect");
    const goMod = readFileSync(path.join(dir, "go.mod"), "utf8");
    expect(goMod).toMatch(/hashicorp\/terraform-config-inspect v\d[^\s]*/);
    expect(goMod).toMatch(/hashicorp\/hcl\/v2 v\d+\.\d+\.\d+/);
    expect(existsSync(path.join(dir, "go.sum"))).toBe(true);
  });

  test("the truth registry finds it by convention and it declares its oracle", async () => {
    const module = await loadTruth("hcl");
    expect(typeof module.generateTruth).toBe("function");
    expect(typeof module.generateExtra).toBe("function");
    expect(module.NOTES).toEqual(NOTES);
    expect(NOTES).toEqual(["terraform-config-inspect", "no-call-edges", "hclsyntax-traversals"]);
    expect(FIXTURES["tiny-terraform"]?.lang).toBe("hcl");
  });
});

// ---------------------------------------------------------------------------

describe("fixture truth", () => {
  test("truth covers exactly the indexed Terraform files", () => {
    expect(truth.files).toEqual(FIXTURE_FILES);
  });

  test("import edges target module directories, not files", () => {
    expect(keys(truth.imports)).toEqual(["main.tf -> modules/logs"]);
  });

  test("exports are the variables and outputs of each file, and every covered file is a key", () => {
    expect(truth.exports).toEqual({
      "main.tf": [],
      "modules/logs/main.tf": ["bucket"],
      "modules/logs/outputs.tf": ["arn"],
      "outputs.tf": ["logs_arn", "vpc_id"],
      "variables.tf": ["cidr", "region"],
    });
  });

  test("there are no calls and no cycles, and S3 is declared unmeasurable rather than zero", () => {
    expect(truth.calls).toEqual([]);
    expect(truth.cycles).toEqual([]);
    expect(truth.notes).toContain("unsupported:S3");
    expect(truth.notes).toContain("hclsyntax-traversals");
  });

  test("the node set is every declaration the fixture makes", () => {
    expect(extra.nodes).toEqual([
      "main.tf#local.name",
      "main.tf#local.tags",
      "main.tf#module.logs",
      "main.tf#provider.aws",
      "main.tf#resource.aws_subnet.a",
      "main.tf#resource.aws_vpc.main",
      "main.tf#terraform",
      "modules/logs/main.tf#resource.aws_s3_bucket.logs",
      "modules/logs/main.tf#variable.bucket",
      "modules/logs/outputs.tf#output.arn",
      "outputs.tf#output.logs_arn",
      "outputs.tf#output.vpc_id",
      "variables.tf#variable.cidr",
      "variables.tf#variable.region",
    ]);
  });

  test("the reference set carries the module hop at med and everything else at high", () => {
    expect(keys(extra.references)).toEqual([
      "main.tf#local.tags -> main.tf#local.name",
      "main.tf#module.logs -> main.tf#resource.aws_vpc.main",
      "main.tf#module.logs -> modules/logs",
      "main.tf#provider.aws -> variables.tf#variable.region",
      "main.tf#resource.aws_subnet.a -> main.tf#provider.aws",
      "main.tf#resource.aws_subnet.a -> main.tf#resource.aws_vpc.main",
      "main.tf#resource.aws_subnet.a -> variables.tf#variable.cidr",
      "main.tf#resource.aws_vpc.main -> main.tf#local.tags",
      "main.tf#resource.aws_vpc.main -> main.tf#provider.aws",
      "main.tf#resource.aws_vpc.main -> variables.tf#variable.cidr",
      "main.tf#terraform -> ext:provider/aws",
      "modules/logs/main.tf#resource.aws_s3_bucket.logs -> modules/logs/main.tf#variable.bucket",
      "modules/logs/outputs.tf#output.arn -> modules/logs/main.tf#resource.aws_s3_bucket.logs",
      "outputs.tf#output.logs_arn -> modules/logs/outputs.tf#output.arn",
      "outputs.tf#output.vpc_id -> main.tf#resource.aws_vpc.main",
    ]);
    const hop = extra.references.find((e) => e.to === "modules/logs/outputs.tf#output.arn");
    expect(hop?.confidence).toBe("med");
    expect(extra.references.filter((e) => e.confidence === "med")).toHaveLength(1);
  });

  test("an empty truth is an error, never a score", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "greplost-tf-empty-"));
    temporaryDirs.push(empty);
    expect(() => generateTruth(empty, ["main.tf"])).toThrow(/hcl truth is empty/);
  });

  test("greplost's Terraform imports and exports match the oracle (S1, S2)", async () => {
    const { buildSnapshot } = await import("@greplost/core");
    const snapshot = await buildSnapshot({ root: fixtureRoot, config: HCL_CONFIG });

    const S1 = scoreEdges(
      snapshot.imports.filter((e) => !e.to.startsWith("ext:") && !e.to.startsWith("unresolved:")),
      truth.imports,
    );
    expect(S1.precision).toBe(1);
    expect(S1.recall).toBe(1);

    const predicted: Record<string, string[]> = {};
    for (const file of truth.files) predicted[file] = snapshot.manifest.files[file]?.exports ?? [];
    const S2 = scoreSet(exportKeys(predicted), exportKeys(truth.exports));
    expect(S2.precision).toBe(1);
    expect(S2.recall).toBe(1);
  });

  test("greplost's reference edges score above the S5 gate against the oracle", async () => {
    const { buildSnapshot } = await import("@greplost/core");
    const snapshot = await buildSnapshot({ root: fixtureRoot, config: HCL_CONFIG });

    const S5 = scoreEdges(snapshot.references ?? [], extra.references);
    // The gate `gates/leaf-2.2.md` states: precision >= 0.95, recall reported.
    expect(S5.precision).toBeGreaterThanOrEqual(0.95);
    expect(S5.falsePositives).toEqual([]);
    expect(S5.recall).toBe(1);
    expect(S5.tp).toBe(extra.references.length);

    // The node set is scored the same way: every node the oracle found, and no invented one.
    const declared = snapshot.symbols.map((decl) => decl.id).sort();
    expect(declared).toEqual(extra.nodes);
  });
});

// ---------------------------------------------------------------------------

describe("oracle independence", () => {
  test("the Terraform truth generator never reads greplost's extractor or resolver", () => {
    const source = readFileSync(path.join(repoRoot, "bench", "src", "truth", "hcl.ts"), "utf8");
    // Every module the generator actually pulls in. Prose is not a dependency, so the check
    // reads the import specifiers rather than the file's text.
    const specifiers = [...source.matchAll(/^\s*(?:import|export)[^"']*from\s+["']([^"']+)["']/gmu)].map(
      (match) => match[1] as string,
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/tree-sitter|^@greplost\/core$|\/(?:extract|resolve|references|signals)\//u);
    }
    // The schema (ids and sorting) is the shared vocabulary, and is allowed.
    expect(specifiers).toContain("@greplost/core/schema");
    // Nothing here ever builds a greplost snapshot.
    expect(source).not.toContain("buildSnapshot(");
  });

  test("the helper program only reads HashiCorp's own parsers", () => {
    const source = readFileSync(path.join(repoRoot, "bench", "truth", "tfinspect", "main.go"), "utf8");
    const block = /import \(([\s\S]*?)\n\)/u.exec(source);
    const imports = (block?.[1] ?? "")
      .split("\n")
      .map((line) => /"([^"]+)"/u.exec(line)?.[1])
      .filter((value): value is string => value !== undefined);
    expect(imports).toContain("github.com/hashicorp/terraform-config-inspect/tfconfig");
    expect(imports).toContain("github.com/hashicorp/hcl/v2/hclsyntax");
    for (const specifier of imports) {
      expect(specifier).not.toMatch(/tree-sitter|greplost/u);
    }
  });

  test("the oracle's answer tracks the fixture: change the configuration, change the truth", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-tf-copy-"));
    temporaryDirs.push(dir);
    cpSync(fixtureRoot, dir, { recursive: true });

    const before = generateTruth(dir, FIXTURE_FILES);
    const beforeExtra = generateExtra(dir, FIXTURE_FILES);
    expect(beforeExtra.nodes).toEqual(extra.nodes);
    expect(before.exports).toEqual(truth.exports);

    // A second copy, with one more resource that references an existing one and one more
    // output. An oracle that echoed greplost, or that cached its answer, would not move.
    const changed = mkdtempSync(path.join(tmpdir(), "greplost-tf-changed-"));
    temporaryDirs.push(changed);
    cpSync(fixtureRoot, changed, { recursive: true });
    writeFileSync(
      path.join(changed, "extra.tf"),
      'resource "aws_igw" "gw" {\n  vpc_id = aws_vpc.main.id\n}\n\noutput "gw_id" {\n  value = aws_igw.gw.id\n}\n',
    );

    const files = [...FIXTURE_FILES, "extra.tf"].sort();
    const after = generateTruth(changed, files);
    const afterExtra = generateExtra(changed, files);

    expect(after.files).toEqual(files);
    expect(after.exports["extra.tf"]).toEqual(["gw_id"]);
    expect(afterExtra.nodes).toContain("extra.tf#resource.aws_igw.gw");
    expect(afterExtra.nodes.length).toBe(extra.nodes.length + 2);
    expect(keys(afterExtra.references)).toContain("extra.tf#resource.aws_igw.gw -> main.tf#resource.aws_vpc.main");
    expect(keys(afterExtra.references)).toContain("extra.tf#output.gw_id -> extra.tf#resource.aws_igw.gw");
  });
});
