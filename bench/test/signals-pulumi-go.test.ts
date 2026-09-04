/**
 * The Pulumi Go signal oracle (build 2, leaf 2.7; spec 2026-09-04 sections 3.7 and 3.8).
 *
 * `describe` names are fixed by the spec and by `gates/leaf-2.7.md`.
 *
 * These tests build and run a real Go program against a real Go module, so they need the Go
 * toolchain and the pinned Pulumi SDKs in the module cache; the first run downloads them.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NOTES, generateExtra, generateTruth } from "../src/truth/signals-pulumi-go.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const FIXTURE = path.join(REPO_ROOT, "fixtures/tiny-pulumi-go");
const ORACLE = path.join(REPO_ROOT, "bench/src/truth/signals-pulumi-go.ts");
const TOOL = path.join(REPO_ROOT, "bench/truth/pulumigotruth/main.go");

/** Building a Go program and type-checking a provider SDK is slow the first time. */
const SLOW = 15 * 60 * 1000;

const temporaries: string[] = [];
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** Every Go source file of a fixture copy, repo-relative, as the harness would list them. */
function fixtureFiles(root: string = FIXTURE): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
        continue;
      }
      if (entry.name.endsWith(".go")) out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-pulumi-go-${label}-`));
  temporaries.push(dir);
  const root = path.join(dir, "repo");
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

describe("go types oracle", () => {
  test(
    "the fixture's resource nodes are exactly these",
    () => {
      const extra = generateExtra(FIXTURE, fixtureFiles());
      expect(extra.nodes).toEqual(["main.go#resource.bucket", "main.go#resource.policy"]);
    },
    SLOW,
  );

  test(
    "the decoy constructor is not a resource, because its result implements nothing",
    () => {
      const nodes = generateExtra(FIXTURE, fixtureFiles()).nodes;
      expect(nodes.filter((id) => id.startsWith("internal/thing/"))).toEqual([]);
      // The decoy is written in the fixture, so this is a real judgement, not a vacuous one.
      expect(readFileSync(path.join(FIXTURE, "main.go"), "utf8")).toContain("thing.NewThing(ctx");
    },
    SLOW,
  );

  test(
    "the resource-input edge carries both node ids and the address that produced it",
    () => {
      const extra = generateExtra(FIXTURE, fixtureFiles());
      expect(extra.references).toEqual([
        {
          from: "main.go#resource.policy",
          to: "main.go#resource.bucket",
          kind: "reference",
          refKind: "resource-input",
          symbols: ["bucket.ID"],
          confidence: "high",
        },
      ]);
    },
    SLOW,
  );

  test(
    "resourceness is decided by types.Implements, never by the constructor's name",
    () => {
      const source = readFileSync(TOOL, "utf8");
      expect(source).toContain("types.Implements(t, iface)");
      // The only Pulumi path the program knows is the SDK package that declares the
      // interface. No provider path, and no resource type name, is written down anywhere.
      const pulumiLiterals = [...source.matchAll(/"github\.com\/pulumi\/[^"]*"/gu)].map((m) => m[0]);
      expect(pulumiLiterals).toEqual(['"github.com/pulumi/pulumi/sdk/"']);
      expect(source).not.toContain('"New');
    },
    SLOW,
  );

  test(
    "the truth it returns declares S1 to S4 unsupported and covers the files it loaded",
    () => {
      expect(NOTES).toEqual(["go-types-oracle", "types-implements-pulumi-resource"]);
      const truth = generateTruth(FIXTURE, fixtureFiles());
      expect(truth.notes).toEqual([
        "go-types-oracle",
        "types-implements-pulumi-resource",
        "unsupported:S1",
        "unsupported:S2",
        "unsupported:S3",
        "unsupported:S4",
      ]);
      expect(truth.files).toEqual(["internal/thing/thing.go", "main.go"]);
      expect(truth.imports).toEqual([]);
      expect(truth.calls).toEqual([]);
      expect(truth.cycles).toEqual([]);
    },
    SLOW,
  );

  test(
    "it throws rather than returning an empty truth for files it could not load",
    () => {
      expect(() => generateExtra(FIXTURE, ["does/not/exist.go"])).toThrow(/loaded none of 1 file/);
    },
    SLOW,
  );

  test(
    "an empty file list is not an error",
    () => {
      expect(generateExtra(FIXTURE, [])).toEqual({ nodes: [], references: [] });
    },
    SLOW,
  );
});

describe("oracle independence", () => {
  test("the oracle imports nothing from packages/core beyond the shared schema", () => {
    const source = readFileSync(ORACLE, "utf8");
    const imports = [...source.matchAll(/^\s*import[^;]*?from\s+"([^"]+)"/gmu)].map((match) => match[1] as string);
    expect(imports.filter((specifier) => specifier.includes("signals"))).toEqual([]);
    expect(imports.filter((specifier) => specifier.includes("packages/core"))).toEqual([]);
    expect(imports.filter((specifier) => specifier.startsWith("@greplost/"))).toEqual(["@greplost/core/schema"]);
    expect(source).not.toContain("web-tree-sitter");
  });

  test("the Go program names neither greplost nor a resource type", () => {
    const source = readFileSync(TOOL, "utf8");
    expect(source).not.toContain("greplost/packages");
    const imports = [...source.matchAll(/^\t"?([a-z0-9/.]+)"?$/gmu)].map((match) => match[1] as string);
    expect(imports.filter((specifier) => specifier.includes("greplost"))).toEqual([]);
  });

  test(
    "its output tracks the fixture: a new resource appears",
    () => {
      const root = copyFixture("added");
      const before = generateExtra(root, fixtureFiles(root)).nodes;
      writeFileSync(
        path.join(root, "extra.go"),
        "package main\n\n" +
          'import (\n\t"github.com/pulumi/pulumi-aws/sdk/v6/go/aws/s3"\n\t"github.com/pulumi/pulumi/sdk/v3/go/pulumi"\n)\n\n' +
          "func extra(ctx *pulumi.Context) error {\n" +
          '\tlogs, err := s3.NewBucket(ctx, "logs", &s3.BucketArgs{})\n' +
          "\t_ = logs\n\treturn err\n}\n",
      );
      const after = generateExtra(root, fixtureFiles(root)).nodes;
      expect(before).not.toContain("extra.go#resource.logs");
      expect(after).toContain("extra.go#resource.logs");
    },
    SLOW,
  );

  test(
    "its output tracks the fixture: a removed resource disappears",
    () => {
      const root = copyFixture("removed");
      expect(generateExtra(root, fixtureFiles(root)).nodes).toContain("main.go#resource.policy");
      writeFileSync(
        path.join(root, "main.go"),
        "package main\n\n" +
          'import (\n\t"github.com/pulumi/pulumi-aws/sdk/v6/go/aws/s3"\n\t"github.com/pulumi/pulumi/sdk/v3/go/pulumi"\n)\n\n' +
          "func main() {\n\tpulumi.Run(func(ctx *pulumi.Context) error {\n" +
          '\t\tbucket, err := s3.NewBucket(ctx, "site", &s3.BucketArgs{})\n' +
          "\t\t_ = bucket\n\t\treturn err\n\t})\n}\n",
      );
      const after = generateExtra(root, fixtureFiles(root)).nodes;
      expect(after).toContain("main.go#resource.bucket");
      expect(after).not.toContain("main.go#resource.policy");
      expect(generateExtra(root, fixtureFiles(root)).references).toEqual([]);
    },
    SLOW,
  );

  test(
    "a local component resource is found by its type, with no import path to read",
    () => {
      // `*Folder` embeds `pulumi.ResourceState`, so it implements `pulumi.Resource` and the
      // oracle sees it. Nothing about `NewFolder` says Pulumi; only its method set does.
      const root = copyFixture("component");
      writeFileSync(
        path.join(root, "folder.go"),
        "package main\n\n" +
          'import "github.com/pulumi/pulumi/sdk/v3/go/pulumi"\n\n' +
          "type Folder struct {\n\tpulumi.ResourceState\n}\n\n" +
          "func NewFolder(ctx *pulumi.Context, name string) (*Folder, error) {\n" +
          "\tfolder := &Folder{}\n" +
          '\terr := ctx.RegisterComponentResource("pkg:index:Folder", name, folder)\n' +
          "\treturn folder, err\n}\n\n" +
          "func useFolder(ctx *pulumi.Context) error {\n" +
          '\tmade, err := NewFolder(ctx, "made")\n\t_ = made\n\treturn err\n}\n',
      );
      const nodes = generateExtra(root, fixtureFiles(root)).nodes;
      expect(nodes).toContain("folder.go#resource.made");
    },
    SLOW,
  );
});
