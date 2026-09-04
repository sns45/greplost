/**
 * Leaf 2.2: Terraform (HCL) extraction, resolution and reference linking.
 *
 * Three layers, each tested on inline sources first and then pinned against
 * `fixtures/tiny-terraform` end to end:
 *   - `extractHcl`            — what one `.tf` file says about itself (spec 2.2, "Declarations");
 *   - `createHclResolver`     — a `module` source resolved to a *directory* id for a local
 *                               path and to `ext:module/<source>` for a registry or git source;
 *   - `resolveHclReferences`  — an address chain resolved to the node it names, at the
 *                               confidence spec 0.3 fixes, or dropped rather than guessed.
 *
 * The `describe` names are fixed by spec section 2.6: `blocks`, `module imports`,
 * `references`, `locals`, `tiny-terraform`.
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
import { createHclResolver } from "../src/resolve/hcl.ts";
import type { ResolvedTarget } from "../src/resolve/resolver.ts";
import { compareReferenceEdges } from "../src/references/index.ts";
import { parseJsonl, serializeSnapshot } from "../src/serialize/index.ts";
import type { Confidence, Declaration, FileRecord, GreplostConfig, ReferenceEdge, Snapshot } from "../src/schema.ts";
import { ARTIFACT_PATHS, DEFAULT_CONFIG } from "../src/schema.ts";

const ZERO_SHA = "0".repeat(64);
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TINY_TERRAFORM = path.join(REPO_ROOT, "fixtures", "tiny-terraform");
const HCL_CONFIG: GreplostConfig = { ...DEFAULT_CONFIG, languages: ["hcl"] };

let parser: ParserHandle;

beforeAll(async () => {
  parser = await createParser();
});

function run(file: string, source: string): FileRecord {
  return extractFile({ path: file, lang: "hcl", source, sha256: ZERO_SHA }, parser);
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
  const dir = mkdtempSync(path.join(tmpdir(), "greplost-hcl-"));
  temporaryDirs.push(dir);
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(dir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
  }
  return buildSnapshot({ root: dir, config: HCL_CONFIG });
}

/** `[to, symbol, confidence]` for every reference leaving `from`, in artifact order. */
function edgesFrom(snapshot: Snapshot, from: string): Array<[string, string, Confidence]> {
  return (snapshot.references ?? [])
    .filter((edge) => edge.from === from)
    .map((edge) => [edge.to, (edge.symbols ?? [])[0] ?? "", edge.confidence] as [string, string, Confidence]);
}

// ---------------------------------------------------------------------------

describe("blocks", () => {
  test("blocks become nodes with the id <file>#<kind>.<name>", () => {
    const out = run("main.tf", 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n');
    expect(out.decls).toHaveLength(1);
    const only = out.decls[0] as Declaration;
    expect(only.id).toBe("main.tf#resource.aws_vpc.main");
    expect(only.kind).toBe("resource");
    expect(only.name).toBe("aws_vpc.main");
    expect(only.signature).toBe('resource "aws_vpc" "main"');
    expect(only.meta).toEqual({ provider: "aws", type: "aws_vpc" });
    expect(only.exported).toBe(false);
    expect(only.span).toEqual([1, 3]);
  });

  test("a data source is its own kind and keeps the resource naming rule", () => {
    const out = run("main.tf", 'data "aws_ami" "ubuntu" {\n  most_recent = true\n}\n');
    const only = out.decls[0] as Declaration;
    expect(only.id).toBe("main.tf#data.aws_ami.ubuntu");
    expect(only.kind).toBe("data");
    expect(only.name).toBe("aws_ami.ubuntu");
    expect(only.meta).toEqual({ provider: "aws", type: "aws_ami" });
  });

  test("a variable is exported and carries its type, default and sensitivity", () => {
    const out = run(
      "variables.tf",
      'variable "region" {\n  type      = string\n  default   = "us-east-1"\n  sensitive = false\n}\n',
    );
    const only = decl(out, "region");
    expect(only.id).toBe("variables.tf#variable.region");
    expect(only.kind).toBe("variable");
    expect(only.exported).toBe(true);
    expect(only.signature).toBe('variable "region"');
    expect(only.meta).toEqual({ default: "us-east-1", sensitive: "false", type: "string" });
  });

  test("a non-literal default is not recorded, and a type expression always is", () => {
    const out = run("variables.tf", 'variable "tags" {\n  type    = map(string)\n  default = var.other\n}\n');
    expect(decl(out, "tags").meta).toEqual({ type: "map(string)" });
  });

  test("an output is exported and carries sensitivity", () => {
    const out = run("outputs.tf", 'output "vpc_id" {\n  value     = aws_vpc.main.id\n  sensitive = true\n}\n');
    const only = decl(out, "vpc_id");
    expect(only.id).toBe("outputs.tf#output.vpc_id");
    expect(only.kind).toBe("output");
    expect(only.exported).toBe(true);
    expect(only.meta).toEqual({ sensitive: "true" });
  });

  test("a provider carries its alias only when it has one", () => {
    const out = run(
      "main.tf",
      'provider "aws" {\n  region = "us-east-1"\n}\n\nprovider "aws" {\n  alias  = "west"\n  region = "us-west-2"\n}\n',
    );
    expect(out.decls.map((d) => d.id)).toEqual(["main.tf#provider.aws", "main.tf#provider.aws~2"]);
    expect(decl(out, "aws").meta).toBeUndefined();
    expect(decl(out, "aws~2").meta).toEqual({ alias: "west" });
  });

  test("a module carries its source and version", () => {
    const out = run(
      "main.tf",
      'module "vpc" {\n  source  = "terraform-aws-modules/vpc/aws"\n  version = "5.0.0"\n}\n',
    );
    const only = decl(out, "vpc");
    expect(only.id).toBe("main.tf#module.vpc");
    expect(only.kind).toBe("module");
    expect(only.exported).toBe(false);
    expect(only.meta).toEqual({ source: "terraform-aws-modules/vpc/aws", version: "5.0.0" });
  });

  test("the terraform block is one const named terraform", () => {
    const out = run(
      "main.tf",
      'terraform {\n  required_version = ">= 1.0"\n\n  required_providers {\n    aws = {\n      source = "hashicorp/aws"\n    }\n  }\n}\n',
    );
    expect(out.decls).toHaveLength(1);
    const only = out.decls[0] as Declaration;
    expect(only.id).toBe("main.tf#terraform");
    expect(only.name).toBe("terraform");
    expect(only.kind).toBe("const");
    expect(only.signature).toBe("terraform");
    expect(only.meta).toEqual({ required_version: ">= 1.0" });
  });

  test("a block with the wrong number of labels is not a node", () => {
    // `resource`/`data` need exactly two labels; every other block exactly one.
    const out = run(
      "main.tf",
      'resource "aws_vpc" {\n}\n\nresource "aws_vpc" "a" "b" {\n}\n\nvariable {\n}\n\nvariable "a" "b" {\n}\n\nmodule {\n}\n',
    );
    expect(out.decls).toEqual([]);
  });

  test("a nested block is never a node and never shadows its parent", () => {
    const out = run(
      "main.tf",
      'resource "aws_instance" "web" {\n  lifecycle {\n    prevent_destroy = true\n  }\n\n  provisioner "local-exec" {\n    command = "echo"\n  }\n}\n',
    );
    expect(out.decls.map((d) => d.id)).toEqual(["main.tf#resource.aws_instance.web"]);
  });

  test("a duplicate node name in one file takes a ~<n> suffix, never a #<n> one", () => {
    const out = run(
      "main.tf",
      'variable "a" {}\nvariable "a" {}\nvariable "a" {}\noutput "a" {}\n',
    );
    expect(out.decls.map((d) => d.id)).toEqual([
      "main.tf#variable.a",
      "main.tf#variable.a~2",
      "main.tf#variable.a~3",
      // A different kind is a different id already, so it is never suffixed.
      "main.tf#output.a",
    ]);
  });

  test("exports are the variables and outputs, and nothing else", () => {
    const out = run(
      "main.tf",
      'variable "a" {}\noutput "b" {}\nresource "aws_vpc" "main" {}\nmodule "m" { source = "./m" }\nlocals {\n  c = 1\n}\n',
    );
    expect(out.exports).toEqual([
      { name: "a", kind: "named" },
      { name: "b", kind: "named" },
    ]);
    // HCL has no call edges at all (spec 2.2): S3 is `n/a`, never 0.
    expect(out.calls).toEqual([]);
  });

  test("a block with an unknown type contributes nothing", () => {
    const out = run("main.tf", 'check "health" {\n  assert {\n    condition = true\n  }\n}\n');
    expect(out.decls).toEqual([]);
    expect(out.imports).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("locals", () => {
  test("a locals block yields one const per attribute, named local.<name>", () => {
    const out = run("main.tf", 'locals {\n  name = "demo"\n  tags = { Env = "dev" }\n}\n');
    expect(out.decls.map((d) => [d.id, d.kind, d.exported])).toEqual([
      ["main.tf#local.name", "const", false],
      ["main.tf#local.tags", "const", false],
    ]);
    expect(decl(out, "local.name").signature).toBe('name = "demo"');
    expect(decl(out, "local.name").span).toEqual([2, 2]);
  });

  test("two locals blocks merge, and a repeated attribute name takes the ~<n> suffix", () => {
    const out = run("main.tf", 'locals {\n  a = 1\n}\n\nlocals {\n  a = 2\n  b = 3\n}\n');
    expect(out.decls.map((d) => d.id)).toEqual([
      "main.tf#local.a",
      "main.tf#local.a~2",
      "main.tf#local.b",
    ]);
  });

  test("a locals block exports nothing and takes no labels", () => {
    const out = run("main.tf", 'locals {\n  a = 1\n}\n\nlocals "bad" {\n  b = 2\n}\n');
    expect(out.exports).toEqual([]);
    // `locals` takes no label at all, so a labelled one is not a locals block.
    expect(out.decls.map((d) => d.id)).toEqual(["main.tf#local.a"]);
  });
});

// ---------------------------------------------------------------------------

describe("module imports", () => {
  const FILES = [
    "main.tf",
    "variables.tf",
    "modules/logs/main.tf",
    "modules/logs/outputs.tf",
    "envs/prod/main.tf",
  ];

  function resolver(files: readonly string[] = FILES): (from: string, specifier: string) => ResolvedTarget {
    return createHclResolver({
      root: "/repo",
      files: new Set(files),
      packages: [],
      readFile: (): string | null => null,
    });
  }

  test("only a module block produces an import, and its specifier is the source as written", () => {
    const out = run(
      "main.tf",
      [
        'variable "a" {}',
        'output "b" { value = 1 }',
        'resource "aws_vpc" "main" { cidr_block = "10.0.0.0/16" }',
        'provider "aws" { region = "us-east-1" }',
        'module "logs" {',
        '  source = "./modules/logs"',
        "}",
        'module "vpc" {',
        '  source  = "terraform-aws-modules/vpc/aws"',
        '  version = "5.0.0"',
        "}",
      ].join("\n"),
    );
    expect(out.imports).toEqual([
      { specifier: "./modules/logs", kind: "static", symbols: [], reexport: false, line: 6 },
      { specifier: "terraform-aws-modules/vpc/aws", kind: "static", symbols: [], reexport: false, line: 9 },
    ]);
  });

  test("a module block with no source, or a computed one, imports nothing", () => {
    const out = run("main.tf", 'module "a" {\n  count = 1\n}\n\nmodule "b" {\n  source = "./${var.dir}"\n}\n');
    expect(out.imports).toEqual([]);
  });

  test("a local source targets the directory, because Terraform loads a directory as one module", () => {
    const resolve = resolver();
    expect(resolve("main.tf", "./modules/logs")).toEqual({ type: "file", path: "modules/logs" });
    expect(resolve("envs/prod/main.tf", "../../modules/logs")).toEqual({ type: "file", path: "modules/logs" });
    // The repo root is `.`, exactly as a Go package directory is.
    expect(resolve("modules/logs/main.tf", "../..")).toEqual({ type: "file", path: "." });
    expect(resolve("modules/logs/main.tf", "/main.tf")).toEqual({ type: "unresolved" });
  });

  test("a local source naming a directory with no indexed .tf file does not resolve", () => {
    const resolve = resolver();
    expect(resolve("main.tf", "./modules/missing")).toEqual({ type: "unresolved" });
    // A path that climbs out of the repo is never a repo directory.
    expect(resolve("main.tf", "../outside")).toEqual({ type: "unresolved" });
  });

  test("a registry or git source becomes ext:module/<source>", () => {
    const resolve = resolver();
    expect(resolve("main.tf", "terraform-aws-modules/vpc/aws")).toEqual({
      type: "external",
      pkg: "module/terraform-aws-modules/vpc/aws",
    });
    expect(resolve("main.tf", "app.terraform.io/example/vpc/aws")).toEqual({
      type: "external",
      pkg: "module/app.terraform.io/example/vpc/aws",
    });
    expect(resolve("main.tf", "git::https://example.com/vpc.git//modules/a?ref=v1")).toEqual({
      type: "external",
      pkg: "module/git::https://example.com/vpc.git//modules/a?ref=v1",
    });
    expect(resolve("main.tf", "")).toEqual({ type: "unresolved" });
  });

  test("the module import edge lands on the directory end to end", async () => {
    const snapshot = await buildSnapshot({ root: TINY_TERRAFORM, config: HCL_CONFIG });
    const edge = snapshot.imports.find((e) => e.specifier === "./modules/logs");
    expect(edge).toBeDefined();
    expect(edge?.from).toBe("main.tf");
    expect(edge?.to).toBe("modules/logs");
    expect(edge?.importKind).toBe("static");
  });
});

// ---------------------------------------------------------------------------

describe("references", () => {
  test("an expression naming another resource becomes a high-confidence hcl-ref", async () => {
    const snapshot = await buildSnapshot({ root: TINY_TERRAFORM, config: HCL_CONFIG });
    const edge = snapshot.references?.find(
      (r) => r.from === "main.tf#resource.aws_subnet.a" && r.to.startsWith("main.tf#resource"),
    );
    expect(edge).toEqual({
      from: "main.tf#resource.aws_subnet.a",
      to: "main.tf#resource.aws_vpc.main",
      kind: "reference",
      refKind: "hcl-ref",
      symbols: ["aws_vpc.main.id"],
      confidence: "high",
    });
  });

  test("a local module output reference resolves at med confidence, the one documented hop", async () => {
    const snapshot = await buildSnapshot({ root: TINY_TERRAFORM, config: HCL_CONFIG });
    const edge = snapshot.references?.find((r) => r.refKind === "hcl-ref" && r.to.endsWith("#output.arn"));
    expect(edge).toEqual({
      from: "outputs.tf#output.logs_arn",
      to: "modules/logs/outputs.tf#output.arn",
      kind: "reference",
      refKind: "hcl-ref",
      symbols: ["module.logs.arn"],
      confidence: "med",
    });
  });

  test("var, local, data and module addresses all land on their node", async () => {
    const snapshot = await snapshotOf({
      "main.tf": [
        'variable "cidr" { type = string }',
        "locals {",
        "  block = var.cidr",
        "}",
        'data "aws_ami" "ubuntu" { most_recent = true }',
        'resource "aws_instance" "web" {',
        "  ami        = data.aws_ami.ubuntu.id",
        "  cidr_block = local.block",
        '  depends_on = [module.net]',
        "}",
        'module "net" { source = "./net" }',
      ].join("\n"),
      "net/main.tf": 'output "id" { value = 1 }\n',
    });
    expect(edgesFrom(snapshot, "main.tf#local.block")).toEqual([["main.tf#variable.cidr", "var.cidr", "high"]]);
    expect(edgesFrom(snapshot, "main.tf#resource.aws_instance.web")).toEqual([
      ["main.tf#data.aws_ami.ubuntu", "data.aws_ami.ubuntu.id", "high"],
      ["main.tf#local.block", "local.block", "high"],
      ["main.tf#module.net", "module.net", "high"],
    ]);
  });

  test("each, count, self, path and terraform addresses are ignored", async () => {
    const snapshot = await snapshotOf({
      "main.tf": [
        'resource "aws_instance" "web" {',
        "  for_each = toset([])",
        "  name     = each.key",
        "  n        = count.index",
        "  ip       = self.private_ip",
        "  root     = path.module",
        "  ws       = terraform.workspace",
        "}",
      ].join("\n"),
    });
    expect(snapshot.references).toEqual([]);
  });

  test("a for binding and a dynamic block label never masquerade as a resource address", async () => {
    const snapshot = await snapshotOf({
      "main.tf": [
        'resource "aws_lb" "value" {}',
        'resource "aws_security_group" "sg" {',
        "  names = [for aws_lb in var.list : aws_lb.value]",
        '  dynamic "aws_lb" {',
        "    for_each = var.rules",
        "    content {",
        "      port = aws_lb.value",
        "    }",
        "  }",
        "}",
      ].join("\n"),
    });
    // `aws_lb.value` is a real resource in this file, and it is *still* not the target: both
    // writings of it are bound names, so neither is emitted at all.
    expect(edgesFrom(snapshot, "main.tf#resource.aws_security_group.sg")).toEqual([]);
  });

  test("an operand of an operator is an address like any other", async () => {
    // `local.a && local.b` puts both chains directly under one `binary_operation`, with no
    // `expression` wrapper around either. Reading only `expression` nodes missed every operand
    // of every operator: 221 real references on terraform-aws-vpc alone.
    const snapshot = await snapshotOf({
      "main.tf": [
        'variable "flag" { type = bool }',
        "locals {",
        "  base    = 1",
        "  guarded = local.base > 0 && var.flag",
        "  ternary = var.flag ? local.base : -local.base",
        "  compare = local.base == var.flag",
        "}",
      ].join("\n"),
    });
    expect(edgesFrom(snapshot, "main.tf#local.guarded")).toEqual([
      ["main.tf#local.base", "local.base", "high"],
      ["main.tf#variable.flag", "var.flag", "high"],
    ]);
    expect(edgesFrom(snapshot, "main.tf#local.ternary")).toEqual([
      ["main.tf#local.base", "local.base", "high"],
      ["main.tf#variable.flag", "var.flag", "high"],
    ]);
    expect(edgesFrom(snapshot, "main.tf#local.compare")).toEqual([
      ["main.tf#local.base", "local.base", "high"],
      ["main.tf#variable.flag", "var.flag", "high"],
    ]);
  });

  test("an interpolated object key references what it names; a bare one names nothing", async () => {
    const snapshot = await snapshotOf({
      "main.tf": [
        "locals {",
        '  region = "us-east-1"',
        '  tags   = { Environment = "dev" }',
        '  perAz  = { "${local.region}a" = 1 }',
        "}",
      ].join("\n"),
    });
    // A bare identifier key is a literal name in HCL, so `Environment` is not a reference.
    expect(edgesFrom(snapshot, "main.tf#local.tags")).toEqual([]);
    expect(edgesFrom(snapshot, "main.tf#local.perAz")).toEqual([
      ["main.tf#local.region", "local.region", "high"],
    ]);
  });

  test("byte-identical files keep their own node ids", async () => {
    // Two files with the same bytes are parsed once and the record is re-addressed onto the
    // second path. Re-addressing used to rebuild every id as `<file>#<name>`, which silently
    // dropped the kind from every node id: 727 of terraform-aws-vpc's 1,909 declarations.
    const body = 'resource "aws_vpc" "main" {}\noutput "vpc_id" { value = aws_vpc.main.id }\n';
    const snapshot = await snapshotOf({ "a/main.tf": body, "b/main.tf": body });
    expect(snapshot.symbols.map((d) => d.id)).toEqual([
      "a/main.tf#resource.aws_vpc.main",
      "a/main.tf#output.vpc_id",
      "b/main.tf#resource.aws_vpc.main",
      "b/main.tf#output.vpc_id",
    ]);
    expect(edgesFrom(snapshot, "b/main.tf#output.vpc_id")).toEqual([
      ["b/main.tf#resource.aws_vpc.main", "aws_vpc.main.id", "high"],
    ]);
  });

  test("an address that names nothing is dropped, and never becomes an unresolved: target", async () => {
    const snapshot = await snapshotOf({
      "main.tf": [
        'resource "aws_instance" "web" {',
        "  vpc  = aws_vpc.absent.id",
        "  who  = var.absent",
        "  what = local.absent",
        "  mod  = module.absent.out",
        "  data = data.aws_ami.absent.id",
        "}",
      ].join("\n"),
    });
    expect(snapshot.references).toEqual([]);
  });

  test("references never cross a module boundary: a directory is the whole lookup scope", async () => {
    const snapshot = await snapshotOf({
      "a/main.tf": 'resource "aws_vpc" "main" {}\nresource "aws_subnet" "s" { vpc_id = aws_vpc.main.id }\n',
      "b/main.tf": 'resource "aws_vpc" "main" {}\n',
    });
    expect(edgesFrom(snapshot, "a/main.tf#resource.aws_subnet.s")).toEqual([
      ["a/main.tf#resource.aws_vpc.main", "aws_vpc.main.id", "high"],
    ]);
  });

  test("a module source is a uses edge: a directory for a local path, ext:module for a registry", async () => {
    const snapshot = await snapshotOf({
      "main.tf": [
        'module "logs" { source = "./modules/logs" }',
        'module "vpc" { source = "terraform-aws-modules/vpc/aws" }',
        'module "gone" { source = "./nowhere" }',
      ].join("\n"),
      "modules/logs/main.tf": 'variable "b" {}\n',
    });
    expect((snapshot.references ?? []).filter((r) => r.refKind === "uses")).toEqual([
      {
        from: "main.tf#module.logs",
        to: "modules/logs",
        kind: "reference",
        refKind: "uses",
        symbols: ["./modules/logs"],
        confidence: "high",
      },
      {
        from: "main.tf#module.vpc",
        to: "ext:module/terraform-aws-modules/vpc/aws",
        kind: "reference",
        refKind: "uses",
        symbols: ["terraform-aws-modules/vpc/aws"],
        confidence: "high",
      },
    ]);
  });

  test("a required_providers entry becomes ext:provider/<name>", async () => {
    const snapshot = await snapshotOf({
      "main.tf": [
        "terraform {",
        "  required_providers {",
        '    aws    = { source = "hashicorp/aws" }',
        '    random = { source = "hashicorp/random" }',
        "  }",
        "}",
      ].join("\n"),
    });
    expect(edgesFrom(snapshot, "main.tf#terraform")).toEqual([
      ["ext:provider/aws", "provider/aws", "high"],
      ["ext:provider/random", "provider/random", "high"],
    ]);
  });

  test("an implicit provider resolves only when exactly one unaliased provider block declares it", async () => {
    const one = await snapshotOf({
      "main.tf": 'provider "aws" { region = "us-east-1" }\nresource "aws_vpc" "main" {}\n',
    });
    expect(edgesFrom(one, "main.tf#resource.aws_vpc.main")).toEqual([
      ["main.tf#provider.aws", "aws", "high"],
    ]);

    const two = await snapshotOf({
      "main.tf": 'provider "aws" {}\nprovider "aws" {}\nresource "aws_vpc" "main" {}\n',
    });
    expect(edgesFrom(two, "main.tf#resource.aws_vpc.main")).toEqual([]);

    const aliased = await snapshotOf({
      "main.tf": 'provider "aws" { alias = "west" }\nresource "aws_vpc" "main" {}\n',
    });
    expect(edgesFrom(aliased, "main.tf#resource.aws_vpc.main")).toEqual([]);
  });

  test("an explicit provider meta-argument names the aliased configuration", async () => {
    const snapshot = await snapshotOf({
      "main.tf": [
        'provider "aws" {}',
        'provider "aws" { alias = "west" }',
        'resource "aws_vpc" "main" { provider = aws.west }',
        'resource "aws_vpc" "other" { provider = aws }',
      ].join("\n"),
    });
    expect(edgesFrom(snapshot, "main.tf#resource.aws_vpc.main")).toEqual([
      ["main.tf#provider.aws~2", "aws.west", "high"],
    ]);
    expect(edgesFrom(snapshot, "main.tf#resource.aws_vpc.other")).toEqual([
      ["main.tf#provider.aws", "aws", "high"],
    ]);
  });

  test("references.jsonl is written and sorted once a repo has edges", async () => {
    const snapshot = await buildSnapshot({ root: TINY_TERRAFORM, config: HCL_CONFIG });
    const written = serializeSnapshot(snapshot);
    const text = written.get(ARTIFACT_PATHS.references);
    expect(text).toBeDefined();
    const parsed = parseJsonl<ReferenceEdge>(text as string);
    expect(parsed).toEqual([...parsed].sort(compareReferenceEdges));
    for (const edge of parsed) {
      expect(edge.kind).toBe("reference");
      expect(edge.to.startsWith("unresolved:")).toBe(false);
      expect(edge.symbols?.length).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------

describe("tiny-terraform", () => {
  test("every block in the fixture becomes the node the spec fixes", async () => {
    const snapshot = await buildSnapshot({ root: TINY_TERRAFORM, config: HCL_CONFIG });
    expect(snapshot.files.map((f) => f.path)).toEqual([
      "main.tf",
      "modules/logs/main.tf",
      "modules/logs/outputs.tf",
      "outputs.tf",
      "variables.tf",
    ]);
    expect(snapshot.symbols.map((d) => [d.id, d.kind, d.exported])).toEqual([
      ["main.tf#terraform", "const", false],
      ["main.tf#provider.aws", "provider", false],
      ["main.tf#local.name", "const", false],
      ["main.tf#local.tags", "const", false],
      ["main.tf#resource.aws_vpc.main", "resource", false],
      ["main.tf#resource.aws_subnet.a", "resource", false],
      ["main.tf#module.logs", "module", false],
      ["modules/logs/main.tf#variable.bucket", "variable", true],
      ["modules/logs/main.tf#resource.aws_s3_bucket.logs", "resource", false],
      ["modules/logs/outputs.tf#output.arn", "output", true],
      ["outputs.tf#output.vpc_id", "output", true],
      ["outputs.tf#output.logs_arn", "output", true],
      ["variables.tf#variable.region", "variable", true],
      ["variables.tf#variable.cidr", "variable", true],
    ]);
    // Only variables and outputs are a Terraform module's public surface.
    expect(Object.fromEntries(Object.entries(snapshot.manifest.files).map(([f, e]) => [f, e.exports]))).toEqual({
      "main.tf": [],
      "modules/logs/main.tf": ["bucket"],
      "modules/logs/outputs.tf": ["arn"],
      "outputs.tf": ["logs_arn", "vpc_id"],
      "variables.tf": ["cidr", "region"],
    });
    // HCL has no calls anywhere, ever.
    expect(snapshot.calls).toEqual([]);
  });

  test("the fixture's one module import lands on the module directory", async () => {
    const snapshot = await buildSnapshot({ root: TINY_TERRAFORM, config: HCL_CONFIG });
    expect(snapshot.imports.map((e) => [e.from, e.to, e.specifier, e.confidence])).toEqual([
      ["main.tf", "modules/logs", "./modules/logs", "high"],
    ]);
  });

  test("the fixture's reference set is exactly these edges, sorted", async () => {
    const snapshot = await buildSnapshot({ root: TINY_TERRAFORM, config: HCL_CONFIG });
    expect(
      (snapshot.references ?? []).map((e) => [e.from, e.to, e.refKind, (e.symbols ?? [])[0], e.confidence]),
    ).toEqual([
      ["main.tf#local.tags", "main.tf#local.name", "hcl-ref", "local.name", "high"],
      ["main.tf#module.logs", "main.tf#resource.aws_vpc.main", "hcl-ref", "aws_vpc.main.id", "high"],
      ["main.tf#module.logs", "modules/logs", "uses", "./modules/logs", "high"],
      ["main.tf#provider.aws", "variables.tf#variable.region", "hcl-ref", "var.region", "high"],
      ["main.tf#resource.aws_subnet.a", "main.tf#provider.aws", "hcl-ref", "aws", "high"],
      ["main.tf#resource.aws_subnet.a", "main.tf#resource.aws_vpc.main", "hcl-ref", "aws_vpc.main.id", "high"],
      ["main.tf#resource.aws_subnet.a", "variables.tf#variable.cidr", "hcl-ref", "var.cidr", "high"],
      ["main.tf#resource.aws_vpc.main", "main.tf#local.tags", "hcl-ref", "local.tags", "high"],
      ["main.tf#resource.aws_vpc.main", "main.tf#provider.aws", "hcl-ref", "aws", "high"],
      ["main.tf#resource.aws_vpc.main", "variables.tf#variable.cidr", "hcl-ref", "var.cidr", "high"],
      ["main.tf#terraform", "ext:provider/aws", "hcl-ref", "provider/aws", "high"],
      [
        "modules/logs/main.tf#resource.aws_s3_bucket.logs",
        "modules/logs/main.tf#variable.bucket",
        "hcl-ref",
        "var.bucket",
        "high",
      ],
      [
        "modules/logs/outputs.tf#output.arn",
        "modules/logs/main.tf#resource.aws_s3_bucket.logs",
        "hcl-ref",
        "aws_s3_bucket.logs.arn",
        "high",
      ],
      ["outputs.tf#output.logs_arn", "modules/logs/outputs.tf#output.arn", "hcl-ref", "module.logs.arn", "med"],
      ["outputs.tf#output.vpc_id", "main.tf#resource.aws_vpc.main", "hcl-ref", "aws_vpc.main.id", "high"],
    ]);
  });

  test("the fixture builds byte-identically twice", async () => {
    const first = await buildSnapshot({ root: TINY_TERRAFORM, config: HCL_CONFIG });
    const second = await buildSnapshot({ root: TINY_TERRAFORM, config: HCL_CONFIG });
    const serialize = (snapshot: Snapshot): string =>
      [...serializeSnapshot(snapshot)].map(([name, text]) => `${name}\n${text}`).join("\n");
    expect(serialize(first)).toBe(serialize(second));
  });
});

// ---------------------------------------------------------------------------

export { TINY_TERRAFORM, HCL_CONFIG };
