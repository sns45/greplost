/**
 * `greplost query` and `greplost impact` on a non-file node (leaf 2.11, spec 4.5).
 *
 * A node id (`main.tf#resource.aws_vpc.main`) is not a path and not a symbol
 * name, so it needs its own rung on the resolution ladder: `resolveFile` first
 * and still first, then an exact node id, then `findSymbols`. The two shapes an
 * agent parses are pinned here — `QueryResult.node` and `ImpactResult.nodes` —
 * together with the rule that keeps every existing consumer working: a *file*
 * target still answers with `files` and never grows a `nodes` key.
 *
 * Everything runs `main` in process against temp copies of the fixtures, the
 * same way `commands.test.ts` does.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { looksLikePath, resolveFile } from "../src/commands/structure.ts";
import { main } from "../src/main.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const TINY_TS = path.join(repoRoot, "fixtures", "tiny-ts");
const TINY_TERRAFORM = path.join(repoRoot, "fixtures", "tiny-terraform");

const VPC = "main.tf#resource.aws_vpc.main";
const BUCKET = "modules/logs/main.tf#resource.aws_s3_bucket.logs";

const temporaries: string[] = [];

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(...argv: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]): void => {
    out.push(args.map((a) => String(a)).join(" "));
  };
  console.error = (...args: unknown[]): void => {
    err.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const code = await main(argv);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function copyFixture(source: string, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-nodes-${label}-`));
  cpSync(source, dir, { recursive: true });
  temporaries.push(dir);
  return dir;
}

function onlyJson(run: Run): Record<string, unknown> {
  expect(run.stderr).toBe("");
  expect(run.stdout.trimStart().startsWith("{")).toBe(true);
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

let tf = "";
let ts = "";

beforeAll(async () => {
  tf = copyFixture(TINY_TERRAFORM, "tf");
  mkdirSync(path.join(tf, ".greplost"), { recursive: true });
  writeFileSync(path.join(tf, ".greplost", "config.json"), `${JSON.stringify({ languages: ["hcl"] }, null, 2)}\n`);
  expect((await cli("init", "--no-hooks", "--root", tf)).code).toBe(0);

  ts = copyFixture(TINY_TS, "ts");
  expect((await cli("init", "--no-hooks", "--root", ts)).code).toBe(0);
});

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

describe("query node", () => {
  test("a node id answers with its kind, card, attributes and both reference lists", async () => {
    const run = await cli("query", VPC, "--root", tf);
    expect(run.code).toBe(0);
    expect(run.stdout.split("\n")[0]).toBe(VPC);
    expect(run.stdout).toContain("kind");
    expect(run.stdout).toContain("resource");
    expect(run.stdout).toContain("packages/root/modules/main.tf/resource.aws_vpc.main.md");
    expect(run.stdout).toContain("provider: aws, type: aws_vpc");
    expect(run.stdout).toContain("main.tf#local.tags");
    expect(run.stdout).toContain("outputs.tf#output.vpc_id");
    for (const line of run.stdout.split("\n")) expect(line).not.toMatch(/\s$/);
  });

  test("a node id the map does not hold is no match, not a missing path", async () => {
    const run = await cli("query", "main.tf#resource.nope.nope", "--root", tf);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe('greplost: no match for "main.tf#resource.nope.nope"');
  });

  test("a path argument still wins over everything else", async () => {
    const run = await cli("query", "main.tf", "--json", "--root", tf);
    const result = onlyJson(run) as { file?: { path: string }; node?: unknown };
    expect(result.file?.path).toBe("main.tf");
    expect(result.node).toBeUndefined();
  });
});

describe("query node json", () => {
  test("the node block carries the documented keys", async () => {
    const result = onlyJson(await cli("query", VPC, "--json", "--root", tf));
    const node = result["node"] as Record<string, unknown>;
    expect(Object.keys(node).sort()).toEqual([
      "blast",
      "card",
      "file",
      "id",
      "kind",
      "meta",
      "name",
      "package",
      "referencedBy",
      "references",
      "span",
    ]);
    expect(node["id"]).toBe(VPC);
    expect(node["file"]).toBe("main.tf");
    expect(node["kind"]).toBe("resource");
    expect(node["name"]).toBe("aws_vpc.main");
    expect(node["package"]).toBe("root");
    expect(node["card"]).toBe("packages/root/modules/main.tf/resource.aws_vpc.main.md");
    expect(node["meta"]).toEqual({ provider: "aws", type: "aws_vpc" });
    expect(node["span"]).toEqual([21, 24]);
    expect(node["blast"]).toBe(3);
    expect(node["references"]).toEqual([
      { to: "main.tf#local.tags", refKind: "hcl-ref", confidence: "high" },
      { to: "main.tf#provider.aws", refKind: "hcl-ref", confidence: "high" },
      { to: "variables.tf#variable.cidr", refKind: "hcl-ref", confidence: "high" },
    ]);
    expect(node["referencedBy"]).toEqual([
      { from: "main.tf#module.logs", refKind: "hcl-ref", confidence: "high" },
      { from: "main.tf#resource.aws_subnet.a", refKind: "hcl-ref", confidence: "high" },
      { from: "outputs.tf#output.vpc_id", refKind: "hcl-ref", confidence: "high" },
    ]);
  });

  test("the match beside it points at the node card and carries meta and the edges", async () => {
    const result = onlyJson(await cli("query", VPC, "--json", "--root", tf));
    const matches = result["matches"] as Array<Record<string, unknown>>;
    expect(matches).toHaveLength(1);
    const match = matches[0] as Record<string, unknown>;
    expect(match["id"]).toBe(VPC);
    expect(match["card"]).toBe("packages/root/modules/main.tf/resource.aws_vpc.main.md");
    expect(match["meta"]).toEqual({ provider: "aws", type: "aws_vpc" });
    expect((match["references"] as unknown[]).length).toBe(3);
    expect((match["referencedBy"] as unknown[]).length).toBe(3);
  });

  test("a node with no meta and no outbound edges answers with neither", async () => {
    const result = onlyJson(await cli("query", "outputs.tf#output.vpc_id", "--json", "--root", tf));
    const node = result["node"] as Record<string, unknown>;
    expect(node["meta"]).toBeUndefined();
    expect(node["referencedBy"]).toEqual([]);
    expect(node["references"]).toEqual([
      { to: VPC, refKind: "hcl-ref", confidence: "high" },
    ]);
    expect(node["blast"]).toBe(0);
  });
});

describe("impact node", () => {
  test("a node id reports its radius and a depth table of nodes", async () => {
    const run = await cli("impact", VPC, "--root", tf);
    expect(run.code).toBe(0);
    const lines = run.stdout.split("\n");
    expect(lines[0]).toBe(`${VPC}  blast radius 3`);
    expect(run.stdout).toContain("DEPTH  NODE");
    expect(run.stdout).toContain("1      main.tf#module.logs");
    for (const line of lines) expect(line).not.toMatch(/\s$/);
  });

  test("--depth truncates the listing and never the radius", async () => {
    const run = await cli("impact", "main.tf#local.name", "--depth", "1", "--root", tf);
    expect(run.stdout.split("\n")[0]).toBe("main.tf#local.name  blast radius 5, showing depth <= 1");
    expect(run.stdout).toContain("1      main.tf#local.tags");
    expect(run.stdout).not.toContain("main.tf#module.logs");
  });

  test("a node nothing references says so", async () => {
    const run = await cli("impact", "main.tf#module.logs", "--root", tf);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("nothing references it");
  });

  test("exits 1 for a node id the map does not hold", async () => {
    const run = await cli("impact", "main.tf#resource.nope.nope", "--root", tf);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("is not in the map");
  });
});

describe("impact node json", () => {
  test("a node target answers with nodes and never with files", async () => {
    const result = onlyJson(await cli("impact", VPC, "--json", "--root", tf));
    expect(Object.keys(result).sort()).toEqual(["nodes", "path", "radius"]);
    expect(result["path"]).toBe(VPC);
    expect(result["radius"]).toBe(3);
    expect(result["nodes"]).toEqual([
      { id: "main.tf#module.logs", depth: 1 },
      { id: "main.tf#resource.aws_subnet.a", depth: 1 },
      { id: "outputs.tf#output.vpc_id", depth: 1 },
    ]);
  });

  test("the closure crosses files and counts hops", async () => {
    const result = onlyJson(await cli("impact", BUCKET, "--json", "--root", tf));
    expect(result["radius"]).toBe(2);
    expect(result["nodes"]).toEqual([
      { id: "modules/logs/outputs.tf#output.arn", depth: 1 },
      { id: "outputs.tf#output.logs_arn", depth: 2 },
    ]);
  });

  test("--depth filters the listing, leaving the radius alone", async () => {
    const result = onlyJson(await cli("impact", "main.tf#local.name", "--depth", "1", "--json", "--root", tf));
    expect(result["radius"]).toBe(5);
    expect(result["nodes"]).toEqual([{ id: "main.tf#local.tags", depth: 1 }]);
  });
});

describe("looksLikePath rejects hashes", () => {
  test("a candidate containing '#' is never treated as a path", () => {
    expect(looksLikePath(VPC)).toBe(false);
    expect(looksLikePath("packages/core/src/retry.ts#retry")).toBe(false);
    expect(looksLikePath("deploy.yaml#resource.Deployment~2")).toBe(false);
    // The rule it does not touch: a real path, with or without a slash.
    expect(looksLikePath("packages/core/src/retry.ts")).toBe(true);
    expect(looksLikePath("Dockerfile")).toBe(true);
  });

  test("resolveFile never resolves a node id, however suggestive its tail", () => {
    const manifest = {
      version: "2",
      packages: {},
      files: {
        "main.tf": {
          sha256: "0".repeat(64),
          pkg: "root",
          lang: "hcl" as const,
          loc: 1,
          exports: [],
          fanIn: 0,
          fanOut: 0,
          blast: 0,
          staleSummary: false,
        },
      },
    };
    expect(resolveFile(manifest, "main.tf")).toBe("main.tf");
    expect(resolveFile(manifest, VPC)).toBeUndefined();
  });
});

describe("file target unchanged", () => {
  test("impact on a file still returns files, not nodes", async () => {
    const result = onlyJson(await cli("impact", "packages/core/src/retry.ts", "--json", "--root", ts));
    expect(Object.keys(result).sort()).toEqual(["files", "path", "radius"]);
    expect(result).toHaveProperty("files");
    expect(result).not.toHaveProperty("nodes");
  });

  test("a file target in a repo that does have nodes answers the same way", async () => {
    const result = onlyJson(await cli("impact", "modules/logs/main.tf", "--json", "--root", tf));
    expect(Object.keys(result).sort()).toEqual(["files", "path", "radius"]);
    expect(result["files"]).toEqual([{ path: "main.tf", depth: 1 }]);
  });

  test("query on a plain symbol keeps the build-1 match shape, byte for byte", async () => {
    const result = onlyJson(await cli("query", "Registry", "--json", "--root", ts));
    const match = (result["matches"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(Object.keys(match).sort()).toEqual([
      "callers",
      "card",
      "exported",
      "file",
      "id",
      "importers",
      "kind",
      "name",
      "package",
      "signature",
      "span",
    ]);
    expect(result["node"]).toBeUndefined();
  });

  test("query on a file keeps its documented file block", async () => {
    const result = onlyJson(await cli("query", "packages/core/src/retry.ts", "--json", "--root", ts));
    const file = result["file"] as Record<string, unknown>;
    expect(Object.keys(file).sort()).toEqual([
      "blast",
      "card",
      "exports",
      "fanIn",
      "fanOut",
      "importers",
      "imports",
      "loc",
      "package",
      "path",
    ]);
  });
});
