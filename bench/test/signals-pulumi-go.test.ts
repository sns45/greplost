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

import type { ReferenceEdge } from "@greplost/core/schema";
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
    "the resource-input edges carry both node ids and the address that produced each",
    () => {
      const extra = generateExtra(FIXTURE, fixtureFiles());
      const edge = (symbol: string): ReferenceEdge => ({
        from: "main.go#resource.policy",
        to: "main.go#resource.bucket",
        kind: "reference",
        refKind: "resource-input",
        symbols: [symbol],
        confidence: "high",
      });
      // The `Args` field read and the `pulumi.Parent` option: two forms, one dependency.
      expect(extra.references).toEqual([edge("bucket"), edge("bucket.ID")]);
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
      expect(NOTES).toEqual([
        "go-types-oracle",
        "types-implements-pulumi-resource",
        "helper-attribution-differs",
        "test-files-not-loaded",
      ]);
      const truth = generateTruth(FIXTURE, fixtureFiles());
      expect(truth.notes).toEqual([
        "go-types-oracle",
        "types-implements-pulumi-resource",
        "helper-attribution-differs",
        "test-files-not-loaded",
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
    "an adoption constructor is a resource, and a data source lookup is not",
    () => {
      // `s3.GetBucket(ctx, args)` returns a plain result struct that implements nothing;
      // `s3.GetBucketPolicy(ctx, "name", id, nil)` returns the resource itself. The oracle
      // never reads either name — the result type decides, and the two differ.
      const root = copyFixture("adoption");
      writeFileSync(
        path.join(root, "adopt.go"),
        "package main\n\n" +
          'import (\n\t"github.com/pulumi/pulumi-aws/sdk/v6/go/aws/s3"\n\t"github.com/pulumi/pulumi/sdk/v3/go/pulumi"\n)\n\n' +
          "func adopt(ctx *pulumi.Context) error {\n" +
          '\texisting, err := s3.GetBucketPolicy(ctx, "kept", pulumi.ID("kept"), nil)\n' +
          "\tif err != nil {\n\t\treturn err\n\t}\n" +
          '\tsource, err := s3.LookupBucket(ctx, &s3.LookupBucketArgs{Bucket: "kept"})\n' +
          "\t_, _ = existing, source\n\treturn err\n}\n",
      );
      const nodes = generateExtra(root, fixtureFiles(root)).nodes;
      expect(nodes).toContain("adopt.go#resource.existing");
      expect(nodes).not.toContain("adopt.go#resource.source");
    },
    SLOW,
  );

  test(
    "a stack reference from the core SDK is a resource; an asset is not",
    () => {
      const root = copyFixture("stackref");
      writeFileSync(
        path.join(root, "stackref.go"),
        "package main\n\n" +
          'import "github.com/pulumi/pulumi/sdk/v3/go/pulumi"\n\n' +
          "func stacks(ctx *pulumi.Context) error {\n" +
          '\tother, err := pulumi.NewStackReference(ctx, "acme/infra/prod", nil)\n' +
          '\tasset := pulumi.NewFileAsset("index.html")\n' +
          "\t_, _ = other, asset\n\treturn err\n}\n",
      );
      const nodes = generateExtra(root, fixtureFiles(root)).nodes.filter((id) =>
        id.startsWith("stackref.go"),
      );
      expect(nodes).toEqual(["stackref.go#resource.other"]);
    },
    SLOW,
  );

  test(
    "a resource option naming another resource is a resource-input edge",
    () => {
      const root = copyFixture("options");
      writeFileSync(
        path.join(root, "options.go"),
        "package main\n\n" +
          'import (\n\t"github.com/pulumi/pulumi-aws/sdk/v6/go/aws/s3"\n\t"github.com/pulumi/pulumi/sdk/v3/go/pulumi"\n)\n\n' +
          "func options(ctx *pulumi.Context) error {\n" +
          '\tparent, err := s3.NewBucket(ctx, "parent", &s3.BucketArgs{})\n' +
          "\tif err != nil {\n\t\treturn err\n\t}\n" +
          '\tpolicy, err := s3.NewBucketPolicy(ctx, "policy", &s3.BucketPolicyArgs{}, pulumi.Parent(parent))\n' +
          "\tif err != nil {\n\t\treturn err\n\t}\n" +
          '\tobj, err := s3.NewBucketObject(ctx, "obj", &s3.BucketObjectArgs{},\n' +
          "\t\tpulumi.DependsOn([]pulumi.Resource{parent, policy}))\n" +
          "\t_ = obj\n\treturn err\n}\n",
      );
      const edges = generateExtra(root, fixtureFiles(root))
        .references.filter((edge) => edge.from.startsWith("options.go"))
        .map((edge) => [edge.from, edge.to, (edge.symbols ?? []).join(",")]);
      expect(edges).toEqual([
        ["options.go#resource.obj", "options.go#resource.parent", "parent"],
        ["options.go#resource.obj", "options.go#resource.policy", "policy"],
        ["options.go#resource.policy", "options.go#resource.parent", "parent"],
      ]);
    },
    SLOW,
  );

  test(
    "an unbound resource is named by its logical name, so an insertion above it cannot move it",
    () => {
      // The reviewer's drift case: a local component resource, which the pass cannot see,
      // sitting above a provider resource both sides do see. Under a positional identity the
      // bucket's id would shift from `~0` to `~1` and the score would report one false
      // positive and one false negative for a file nothing changed in.
      const root = copyFixture("drift");
      const bucket =
        "func drift(ctx *pulumi.Context) error {\n" +
        '\t_, err := s3.NewBucket(ctx, "site", &s3.BucketArgs{})\n' +
        "\treturn err\n}\n";
      const header =
        "package main\n\n" +
        'import (\n\t"github.com/pulumi/pulumi-aws/sdk/v6/go/aws/s3"\n\t"github.com/pulumi/pulumi/sdk/v3/go/pulumi"\n)\n\n' +
        "type Group struct {\n\tpulumi.ResourceState\n}\n\n" +
        "func NewGroup(ctx *pulumi.Context, name string) (*Group, error) {\n" +
        "\tgroup := &Group{}\n" +
        '\treturn group, ctx.RegisterComponentResource("pkg:index:Group", name, group)\n}\n\n';
      writeFileSync(path.join(root, "drift.go"), header + bucket);
      const before = generateExtra(root, fixtureFiles(root)).nodes.filter((id) => id.startsWith("drift.go"));
      writeFileSync(
        path.join(root, "drift.go"),
        header +
          "func above(ctx *pulumi.Context) error {\n" +
          '\t_, err := NewGroup(ctx, "group")\n' +
          "\treturn err\n}\n\n" +
          bucket,
      );
      const after = generateExtra(root, fixtureFiles(root)).nodes.filter((id) => id.startsWith("drift.go"));
      expect(before).toEqual(["drift.go#resource.~site"]);
      // The inserted component takes its own logical name, and `~site` has not moved.
      expect(after).toEqual(["drift.go#resource.~group", "drift.go#resource.~site"]);
    },
    SLOW,
  );

  test(
    "a resource node never collides with a language declaration, on this side either",
    () => {
      // A Go method `bucket` on a lower-case type `resource` has the symbol path
      // `resource.bucket`, which is the id a `resource.bucket` node would claim. greplost
      // seeds its allocator from the records its extractor produced; this oracle seeds from
      // the same declarations in the syntax, so both move the node to `~2`.
      const root = copyFixture("collide");
      writeFileSync(
        path.join(root, "collide.go"),
        "package main\n\n" +
          'import (\n\t"github.com/pulumi/pulumi-aws/sdk/v6/go/aws/s3"\n\t"github.com/pulumi/pulumi/sdk/v3/go/pulumi"\n)\n\n' +
          "type resource struct{}\n\n" +
          'func (r resource) bucket() string { return "" }\n\n' +
          "func collide(ctx *pulumi.Context) error {\n" +
          '\tbucket, err := s3.NewBucket(ctx, "collide", &s3.BucketArgs{})\n' +
          "\t_ = bucket\n\treturn err\n}\n",
      );
      const nodes = generateExtra(root, fixtureFiles(root)).nodes.filter((id) =>
        id.startsWith("collide.go"),
      );
      expect(nodes).toEqual(["collide.go#resource.bucket~2"]);
    },
    SLOW,
  );

  test(
    "a provider option is a resource-input edge on this side too",
    () => {
      const root = copyFixture("providers");
      writeFileSync(
        path.join(root, "providers.go"),
        "package main\n\n" +
          'import (\n\t"github.com/pulumi/pulumi-aws/sdk/v6/go/aws"\n' +
          '\t"github.com/pulumi/pulumi-aws/sdk/v6/go/aws/s3"\n' +
          '\t"github.com/pulumi/pulumi/sdk/v3/go/pulumi"\n)\n\n' +
          "func providers(ctx *pulumi.Context) error {\n" +
          '\tp, err := aws.NewProvider(ctx, "p", &aws.ProviderArgs{})\n' +
          "\tif err != nil {\n\t\treturn err\n\t}\n" +
          '\tb, err := s3.NewBucket(ctx, "b", &s3.BucketArgs{}, pulumi.Provider(p))\n' +
          "\t_ = b\n\treturn err\n}\n",
      );
      const edges = generateExtra(root, fixtureFiles(root))
        .references.filter((edge) => edge.from.startsWith("providers.go"))
        .map((edge) => [edge.from, edge.to, (edge.symbols ?? []).join(",")]);
      expect(edges).toEqual([["providers.go#resource.b", "providers.go#resource.p", "p"]]);
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
