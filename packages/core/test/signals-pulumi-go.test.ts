/**
 * Pulumi Go signal pass (build 2, leaf 2.7; spec 2026-09-04 sections 3.1 and 3.6).
 *
 * The `describe` names are fixed by the spec (section 3.8) and by `gates/leaf-2.7.md`; do not
 * rename them.
 *
 * The fixture's `main.go` is read from disk rather than inlined, so a rule that only works on
 * a hand-written snippet cannot pass: the file the test asserts about is the same one the
 * structural gate and the `go/types` oracle read.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createParser } from "../src/parser.ts";
import type { ParserHandle } from "../src/parser.ts";
import { extractGo } from "../src/extract/go.ts";
import { buildSnapshot } from "../src/build.ts";
import { runSignals } from "../src/signals/index.ts";
import { pulumiGoPass } from "../src/signals/pulumi-go.ts";
import type { SignalOutput } from "../src/signals/index.ts";
import type { Declaration, GreplostConfig, ReferenceRecord, Snapshot } from "../src/schema.ts";
import { DEFAULT_CONFIG, stableStringify } from "../src/schema.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "fixtures/tiny-pulumi-go");
const FIXTURE_MAIN_GO = readFileSync(join(FIXTURE, "main.go"), "utf8");
const GO_CONFIG: GreplostConfig = { ...DEFAULT_CONFIG, languages: ["go"] };

let parser: ParserHandle;

beforeAll(async () => {
  parser = await createParser();
});

/** Everything the applicable passes produce for one Go file, exactly as `extractFile` runs them. */
function signals(path: string, source: string): SignalOutput {
  const tree = parser.parse(source, "go");
  try {
    const base = extractGo(path, "go", source, tree);
    return runSignals({
      path,
      lang: "go",
      source,
      tree,
      base: { decls: base.decls, imports: base.imports, exports: base.exports, calls: base.calls },
    });
  } finally {
    tree.delete();
  }
}

function ids(out: SignalOutput): string[] {
  return out.decls.map((d) => d.id);
}

function node(out: SignalOutput, id: string): Declaration {
  const found = out.decls.find((d) => d.id === id);
  if (!found) throw new Error(`no signal node ${id} in [${ids(out).join(", ")}]`);
  return found;
}

function refs(out: SignalOutput): ReferenceRecord[] {
  return out.refs;
}

/** A Pulumi Go program body, wrapped in the imports every rule in 3.6 keys on. */
function program(body: string, imports = '\t"github.com/pulumi/pulumi-aws/sdk/v6/go/aws/s3"\n'): string {
  return `package main\n\nimport (\n${imports})\n\nfunc main() {\n${body}}\n`;
}

// ------------------------------------------------------------ pulumi go resources

describe("pulumi go resources", () => {
  test("a NewX call through a pulumi provider import becomes a resource node", () => {
    const out = signals("main.go", FIXTURE_MAIN_GO);
    expect(out.decls.map((d) => [d.id, d.meta?.["type"]])).toEqual([
      ["main.go#resource.bucket", "aws:s3/bucket:Bucket"],
      ["main.go#resource.policy", "aws:s3/bucketPolicy:BucketPolicy"],
    ]);
  });

  test("a NewX call from a non-pulumi package is not a resource", () => {
    const out = signals(
      "main.go",
      'package main\n\nimport "example.com/x"\n\nfunc f() { _ = x.NewThing(nil, "y", nil) }\n',
    );
    expect(out.decls).toEqual([]);
    expect(out.refs).toEqual([]);
  });

  test("applies is true only for a go file importing a pulumi path", () => {
    expect(pulumiGoPass.applies("main.go", FIXTURE_MAIN_GO)).toBe(true);
    expect(
      pulumiGoPass.applies("main.go", 'package main\nimport "github.com/pulumi/pulumi/sdk/v3/go/pulumi"\n'),
    ).toBe(true);
    expect(pulumiGoPass.applies("main.go", 'package main\nimport "example.com/x"\n')).toBe(false);
    // The scope is `github.com/pulumi/pulumi-`, not every repository owned by Pulumi.
    expect(pulumiGoPass.applies("main.go", 'package main\nimport "github.com/pulumi/examples/misc"\n')).toBe(false);
    expect(pulumiGoPass.langs.has("go")).toBe(true);
    expect(pulumiGoPass.id).toBe("pulumi-go");
  });

  test("the node carries provider, resource name and the pass id", () => {
    const out = signals("main.go", FIXTURE_MAIN_GO);
    expect(node(out, "main.go#resource.bucket").meta).toEqual({
      provider: "aws",
      resourceName: "site",
      signal: "pulumi-go",
      type: "aws:s3/bucket:Bucket",
      typeSource: "import-path",
    });
    expect(node(out, "main.go#resource.bucket").kind).toBe("resource");
    expect(node(out, "main.go#resource.bucket").exported).toBe(false);
    expect(node(out, "main.go#resource.bucket").signature).toBe('s3.NewBucket("site")');
  });

  test("a resource whose result is not bound is named by its index among the unbound", () => {
    const out = signals(
      "main.go",
      program(
        '\t_, _ = s3.NewBucket(ctx, "a", &s3.BucketArgs{})\n' +
          '\tkeep, _ := s3.NewBucket(ctx, "b", &s3.BucketArgs{})\n' +
          '\ts3.NewBucket(ctx, "c", &s3.BucketArgs{})\n' +
          "\t_ = keep\n",
      ),
    );
    expect(ids(out)).toEqual(["main.go#resource.~0", "main.go#resource.keep", "main.go#resource.~1"]);
  });

  test("two resources bound to the same name inside one file take the ~<n> suffix", () => {
    const out = signals(
      "main.go",
      program(
        '\tbucket, _ := s3.NewBucket(ctx, "a", &s3.BucketArgs{})\n' +
          "\t_ = bucket\n" +
          '\tbucket, _ = s3.NewBucket(ctx, "b", &s3.BucketArgs{})\n' +
          "\t_ = bucket\n",
      ),
    );
    expect(ids(out)).toEqual(["main.go#resource.bucket", "main.go#resource.bucket~2"]);
  });

  test("the package alias, not the last path segment, is what the rule reads", () => {
    // A major-version suffix is not a package name: `.../resources/v3` is package `resources`.
    const out = signals(
      "main.go",
      program(
        '\tgroup, _ := resources.NewResourceGroup(ctx, "rg", &resources.ResourceGroupArgs{})\n\t_ = group\n',
        '\t"github.com/pulumi/pulumi-azure-native-sdk/resources/v3"\n',
      ),
    );
    expect(out.decls.map((d) => [d.id, d.meta?.["provider"], d.meta?.["type"]])).toEqual([
      [
        "main.go#resource.group",
        "azure-native-sdk",
        "azure-native-sdk:resources/resourceGroup:ResourceGroup",
      ],
    ]);
  });

  test("an explicit alias wins over the path", () => {
    const out = signals(
      "main.go",
      program(
        '\tsvc, _ := corev1.NewService(ctx, "svc", &corev1.ServiceArgs{})\n\t_ = svc\n',
        '\tcorev1 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/core/v1"\n',
      ),
    );
    expect(ids(out)).toEqual(["main.go#resource.svc"]);
    expect(node(out, "main.go#resource.svc").meta?.["provider"]).toBe("kubernetes");
  });

  test("the pulumi core SDK is a library, not a provider", () => {
    const out = signals(
      "main.go",
      program(
        '\tasset := pulumi.NewFileAsset("index.html")\n\t_ = asset\n',
        '\t"github.com/pulumi/pulumi/sdk/v3/go/pulumi"\n',
      ),
    );
    expect(out.decls).toEqual([]);
  });

  test("a lower-case New, or a call with fewer than two arguments, is not a resource", () => {
    const out = signals(
      "main.go",
      program('\ta := s3.newBucket(ctx, "x")\n\tb := s3.NewBucket()\n\t_, _ = a, b\n'),
    );
    expect(out.decls).toEqual([]);
  });

  test("the resource name is recorded only when the second argument is a string literal", () => {
    const out = signals(
      "main.go",
      program('\tb, _ := s3.NewBucket(ctx, name, &s3.BucketArgs{})\n\t_ = b\n'),
    );
    expect(node(out, "main.go#resource.b").meta?.["resourceName"]).toBeUndefined();
    expect(node(out, "main.go#resource.b").signature).toBe("s3.NewBucket(…)");
  });

  test("the pass is deterministic and sorted, and adds to the language declarations", () => {
    const first = signals("main.go", FIXTURE_MAIN_GO);
    const second = signals("main.go", FIXTURE_MAIN_GO);
    expect(ids(first)).toEqual(ids(second));
    const spans = first.decls.map((d) => d.span[0]);
    expect([...spans].sort((a, b) => a - b)).toEqual(spans);
  });
});

// ------------------------------------------------------------ resource inputs

describe("resource inputs", () => {
  test("an Args field reading another resource's method is a resource-input reference", () => {
    const out = signals("main.go", FIXTURE_MAIN_GO);
    expect(refs(out)).toEqual([
      {
        from: "resource.policy",
        to: "bucket.ID",
        refKind: "resource-input",
        line: FIXTURE_MAIN_GO.split("\n").findIndex((l) => l.includes("Bucket: bucket.ID()")) + 1,
      },
    ]);
  });

  test("an Args field reading another resource's field is a resource-input reference", () => {
    const out = signals(
      "main.go",
      program(
        '\tvpc, _ := ec2.NewVpc(ctx, "vpc", &ec2.VpcArgs{})\n' +
          '\tsg, _ := ec2.NewSecurityGroup(ctx, "sg", &ec2.SecurityGroupArgs{VpcId: vpc.ID(), Name: vpc.Arn})\n' +
          "\t_, _ = vpc, sg\n",
        '\t"github.com/pulumi/pulumi-aws/sdk/v6/go/aws/ec2"\n',
      ),
    );
    expect(refs(out).map((r) => [r.from, r.to, r.refKind])).toEqual([
      ["resource.sg", "vpc.Arn", "resource-input"],
      ["resource.sg", "vpc.ID", "resource-input"],
    ]);
  });

  test("a read of something that is not a resource in this file is dropped, never guessed", () => {
    const out = signals(
      "main.go",
      program(
        '\tb, _ := s3.NewBucket(ctx, "b", &s3.BucketArgs{Bucket: cfg.Name, Tags: other.Tags})\n\t_ = b\n',
      ),
    );
    expect(refs(out)).toEqual([]);
  });

  test("a resource that reads its own field produces no self edge", () => {
    const out = signals(
      "main.go",
      program('\tb, _ := s3.NewBucket(ctx, "b", &s3.BucketArgs{Bucket: b.ID()})\n\t_ = b\n'),
    );
    expect(refs(out)).toEqual([]);
  });

  test("the same address read twice in one Args literal gives one reference", () => {
    const out = signals(
      "main.go",
      program(
        '\tv, _ := ec2.NewVpc(ctx, "v", &ec2.VpcArgs{})\n' +
          '\ts, _ := ec2.NewSubnet(ctx, "s", &ec2.SubnetArgs{A: v.ID(), B: v.ID()})\n' +
          "\t_, _ = v, s\n",
        '\t"github.com/pulumi/pulumi-aws/sdk/v6/go/aws/ec2"\n',
      ),
    );
    expect(refs(out).length).toBe(1);
  });

  test("a resource declared below the one that reads it still resolves", () => {
    const out = signals(
      "main.go",
      program(
        '\tp, _ := s3.NewBucketPolicy(ctx, "p", &s3.BucketPolicyArgs{Bucket: later.ID()})\n' +
          '\tlater, _ := s3.NewBucket(ctx, "b", &s3.BucketArgs{})\n' +
          "\t_, _ = p, later\n",
      ),
    );
    expect(refs(out).map((r) => [r.from, r.to])).toEqual([["resource.p", "later.ID"]]);
  });
});

// ------------------------------------------------------------ tiny-pulumi-go

describe("tiny-pulumi-go", () => {
  test("the fixture yields two resource nodes, one reference and nothing for the decoy", () => {
    const out = signals("main.go", FIXTURE_MAIN_GO);
    expect(ids(out)).toEqual(["main.go#resource.bucket", "main.go#resource.policy"]);
    expect(out.refs.length).toBe(1);
    expect(FIXTURE_MAIN_GO).toContain("thing.NewThing(ctx");
  });

  test("the decoy package produces nothing at all", () => {
    const source = readFileSync(join(FIXTURE, "internal/thing/thing.go"), "utf8");
    expect(pulumiGoPass.applies("internal/thing/thing.go", source)).toBe(false);
    expect(signals("internal/thing/thing.go", source).decls).toEqual([]);
  });

  test("a signal node never replaces a language declaration", () => {
    const tree = parser.parse(FIXTURE_MAIN_GO, "go");
    try {
      const base = extractGo("main.go", "go", FIXTURE_MAIN_GO, tree);
      expect(base.decls.map((d) => d.id)).toContain("main.go#main");
    } finally {
      tree.delete();
    }
  });

  describe("the built snapshot", () => {
    let snapshot: Snapshot;

    beforeAll(async () => {
      snapshot = await buildSnapshot({ root: FIXTURE, config: GO_CONFIG, parser });
    });

    test("every fixture file is indexed", () => {
      expect(snapshot.files.map((f) => f.path)).toEqual(["internal/thing/thing.go", "main.go"]);
    });

    test("the signal nodes are exactly these", () => {
      const nodes = snapshot.symbols.filter((d) => d.meta?.["signal"] !== undefined).map((d) => d.id);
      expect(nodes).toEqual(["main.go#resource.bucket", "main.go#resource.policy"]);
    });

    test("the resource-input reference resolves to the bucket node", () => {
      expect((snapshot.references ?? []).map((e) => [e.from, e.to, e.refKind, e.confidence, e.symbols])).toEqual([
        [
          "main.go#resource.policy",
          "main.go#resource.bucket",
          "resource-input",
          "high",
          ["bucket.ID"],
        ],
      ]);
    });

    test("the go declarations survive beside the signal nodes", () => {
      const main = snapshot.files.find((f) => f.path === "main.go");
      expect(main?.decls.map((d) => d.id)).toEqual([
        "main.go#main",
        "main.go#resource.bucket",
        "main.go#resource.policy",
      ]);
    });

    test("the build is byte-identical when repeated", async () => {
      const again = await buildSnapshot({ root: FIXTURE, config: GO_CONFIG, parser });
      expect(stableStringify(again.symbols)).toBe(stableStringify(snapshot.symbols));
      expect(stableStringify(again.references ?? [])).toBe(stableStringify(snapshot.references ?? []));
    });
  });
});
