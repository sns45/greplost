/**
 * greplost:render support for non-file nodes (leaf 2.11, spec sections 0.2 and 4).
 *
 * A non-file node — a Terraform resource, a workflow job, a Dockerfile stage, a
 * Kubernetes document, a route, a Pulumi resource — is a `Declaration` whose
 * `kind` is in `NODE_KINDS` and never a manifest entry. This file holds the
 * render half of that contract: the card path (slugged, never carrying a `#`),
 * the card itself, the file card's Nodes block, the caps, the collision guard,
 * and the two goldens — `tiny-terraform` for what nodes look like, `tiny-ts`
 * for the regression that says a repo without them does not move one byte.
 *
 * `GREPLOST_UPDATE_GOLDEN=1 bun test packages/render/test/nodes.test.ts`
 * rewrites `test/golden/tiny-terraform` and nothing else.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildSnapshot, sha256Hex } from "@greplost/core";
import { impactOf, impactPairs } from "@greplost/core/graph";
import type {
  CallEdge,
  DeclKind,
  Declaration,
  FileRecord,
  Manifest,
  PackageInfo,
  ReferenceEdge,
  Snapshot,
  SummaryCache,
} from "@greplost/core/schema";
import { DEFAULT_CONFIG, SCHEMA_VERSION, compareStrings, isNodeKind } from "@greplost/core/schema";

import { buildNodeCard, createContext, nodeCardPath, nodeSlug, renderArtifacts } from "../src/index.ts";
import type { RenderInput } from "../src/index.ts";

const FIXTURES = path.resolve(import.meta.dir, "../../../fixtures");
const TINY_TS = path.join(FIXTURES, "tiny-ts");
const TINY_TERRAFORM = path.join(FIXTURES, "tiny-terraform");
const TS_GOLDEN = path.resolve(import.meta.dir, "golden/tiny-ts");
const TF_GOLDEN = path.resolve(import.meta.dir, "golden/tiny-terraform");
const UPDATE = process.env["GREPLOST_UPDATE_GOLDEN"] === "1";

const VPC = "main.tf#resource.aws_vpc.main";
const BUCKET = "modules/logs/main.tf#resource.aws_s3_bucket.logs";

let tf: RenderInput;
let tfArtifacts: Map<string, string>;

beforeAll(async () => {
  const snapshot = await buildSnapshot({
    root: TINY_TERRAFORM,
    config: { ...DEFAULT_CONFIG, languages: ["hcl"] },
  });
  tf = { snapshot, summaries: {} };
  tfArtifacts = renderArtifacts(tf);
});

/** The seed `test/golden/tiny-ts` was rendered with; copied from `docs.test.ts`. */
function goldenSummaries(): SummaryCache {
  const retryHash = sha256Hex(readFileSync(path.join(TINY_TS, "packages/core/src/retry.ts")));
  return {
    [retryHash]: {
      path: "packages/core/src/retry.ts",
      text: "Retries an async operation a fixed number of times before rethrowing the last error.",
      refreshedAt: "2026-09-01",
      model: "test",
    },
    "0000000000000000000000000000000000000000000000000000000000000000": {
      path: "packages/core/src/bus.ts",
      text: "Fan-out event bus used by the registry.",
      refreshedAt: "2026-08-15",
      model: "test",
    },
  };
}

/** Artifact-relative paths under a golden tree, sorted, posix-separated. */
function listGolden(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort(compareStrings)) {
      const full = path.join(dir, entry);
      const rel = prefix === "" ? entry : `${prefix}/${entry}`;
      if (statSync(full).isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  };
  if (existsSync(root)) walk(root, "");
  return out.sort(compareStrings);
}

/** The `**<label>:**` block of a card, without its trailing newline. */
function block(card: string, label: string): string | undefined {
  return card
    .split("\n\n")
    .find((b) => b.startsWith(`**${label}:**`))
    ?.replace(/\n+$/, "");
}

// ---------------------------------------------------------------------------
// Synthetic snapshots: hand-built, never a repo on disk, so the caps and the
// collision guard are exercised without inventing a 60-resource fixture.
// ---------------------------------------------------------------------------

interface SynthFile {
  path: string;
  decls: Declaration[];
  calls?: CallEdge[];
}

function decl(file: string, kind: DeclKind, name: string, line: number, meta?: Record<string, string>): Declaration {
  const base: Declaration = {
    id: `${file}#${kind}.${name}`,
    file,
    name,
    kind,
    signature: `${kind} "${name}"`,
    exported: false,
    span: [line, line + 1],
  };
  return meta === undefined ? base : { ...base, meta };
}

function synth(files: SynthFile[], references: ReferenceEdge[] = []): Snapshot {
  const pkg: PackageInfo = { name: "root", path: ".", source: "root" };
  const manifest: Manifest = {
    version: SCHEMA_VERSION,
    packages: { root: { path: ".", deps: [], rdeps: [], loc: files.length, files: files.length } },
    files: {},
  };
  const records: FileRecord[] = [];
  const calls: CallEdge[] = [];
  for (const file of files) {
    manifest.files[file.path] = {
      sha256: "0".repeat(64),
      pkg: "root",
      lang: "hcl",
      loc: 1,
      exports: [],
      fanIn: 0,
      fanOut: 0,
      blast: 0,
      staleSummary: false,
    };
    records.push({
      path: file.path,
      lang: "hcl",
      sha256: "0".repeat(64),
      loc: 1,
      decls: file.decls,
      imports: [],
      exports: [],
      calls: [],
    });
    for (const call of file.calls ?? []) calls.push(call);
  }
  return {
    root: "/repo",
    config: DEFAULT_CONFIG,
    packages: [pkg],
    files: records,
    manifest,
    imports: [],
    calls,
    symbols: records.flatMap((r) => r.decls),
    references,
    metrics: { cycles: [], packageEdges: [] },
  };
}

function reference(from: string, to: string): ReferenceEdge {
  return { from, to, kind: "reference", refKind: "hcl-ref", confidence: "high" };
}

function resources(count: number): Declaration[] {
  return Array.from({ length: count }, (_, i) => decl("main.tf", "resource", `r${i}`, 1 + i * 2));
}

/** One file, `count` resources, `resource.r0` referencing and referenced by all the rest. */
function hubSnapshot(count: number): Snapshot {
  const references: ReferenceEdge[] = [];
  for (let i = 1; i < count; i++) {
    references.push(reference("main.tf#resource.r0", `main.tf#resource.r${i}`));
    references.push(reference(`main.tf#resource.r${i}`, "main.tf#resource.r0"));
  }
  return synth([{ path: "main.tf", decls: resources(count) }], references);
}

// ---------------------------------------------------------------------------

describe("node card path", () => {
  test("a node card is a sibling of its file card and contains no '#'", () => {
    const pkg: PackageInfo = { name: "infra", path: "infra", source: "root" };
    const cardPath = nodeCardPath(pkg, "infra/main.tf#resource.aws_s3_bucket.logs");
    expect(cardPath).toBe("packages/infra/modules/main.tf/resource.aws_s3_bucket.logs.md");
    expect(cardPath).not.toContain("#");
  });

  test("characters that are illegal in a path are slugged, the id is not", () => {
    expect(nodeSlug("route", "/users/[id]")).toBe("route.__users__-id-");
    expect(
      nodeCardPath({ name: "web", path: ".", source: "root" }, "app/users/[id]/page.tsx#route./users/[id]"),
    ).toBe("packages/web/modules/app/users/[id]/page.tsx/route.__users__-id-.md");
  });

  test("the duplicate suffix lives in the id, so two collided nodes still get two cards", () => {
    const pkg: PackageInfo = { name: "root", path: ".", source: "root" };
    expect(nodeCardPath(pkg, "deploy.yaml#resource.Deployment")).toBe(
      "packages/root/modules/deploy.yaml/resource.Deployment.md",
    );
    expect(nodeCardPath(pkg, "deploy.yaml#resource.Deployment~2")).toBe(
      "packages/root/modules/deploy.yaml/resource.Deployment-2.md",
    );
  });

  test("an id that is not a node id is a programming error, not a card", () => {
    const pkg: PackageInfo = { name: "root", path: ".", source: "root" };
    expect(() => nodeCardPath(pkg, "src/a.ts#retry")).toThrow(/not a node id/);
    expect(() => nodeCardPath(pkg, "src/a.ts")).toThrow(/not a node id/);
  });

  test("no rendered artifact path carries a '#', directories included", () => {
    expect([...tfArtifacts.keys()].filter((p) => p.includes("#"))).toEqual([]);
    expect(tfArtifacts.has("packages/root/modules/main.tf/resource.aws_vpc.main.md")).toBe(true);
    expect(tfArtifacts.has("packages/root/modules/modules/logs/main.tf/resource.aws_s3_bucket.logs.md")).toBe(true);
  });
});

describe("node card", () => {
  test("carries kind, file, package, attributes, both reference lists, blast and source", () => {
    const card = tfArtifacts.get("packages/root/modules/main.tf/resource.aws_vpc.main.md") as string;
    const head = card.split("\n\n");
    expect(head[0]).toBe(`# ${VPC}`);
    expect(head[1]).toBe("> Generated by greplost. Do not edit by hand; run `greplost update`.");
    expect(block(card, "Kind")).toBe("**Kind:** `resource`  **In file:** [`main.tf`](../main.tf.md)");
    expect(block(card, "Package")).toBe("**Package:** `root` ([map](../../MAP.md))");
    expect(block(card, "Attributes")).toBe("**Attributes:** `provider: aws`, `type: aws_vpc`");
    expect(block(card, "References")).toBe(
      "**References:** [`tags`](local.tags.md) (hcl-ref), [`aws`](provider.aws.md) (hcl-ref), " +
        "[`variables.tf#variable.cidr`](../variables.tf/variable.cidr.md) (hcl-ref)",
    );
    expect(block(card, "Referenced by")).toBe(
      "**Referenced by:** [`logs`](module.logs.md) (hcl-ref), " +
        "[`aws_subnet.a`](resource.aws_subnet.a.md) (hcl-ref), " +
        "[`outputs.tf#output.vpc_id`](../outputs.tf/output.vpc_id.md) (hcl-ref)",
    );
    expect(block(card, "Blast radius")).toBe(`**Blast radius:** 3 node(s) (\`greplost impact ${VPC}\`)`);
    expect(block(card, "Source")).toBe("**Source:** L21-24");
    expect(card.endsWith("\n")).toBe(true);
    expect(card.endsWith("\n\n")).toBe(false);
  });

  test("the blast figure is the reverse closure over impactPairs, so card and CLI agree", () => {
    const radius = impactOf(
      impactPairs({
        manifest: tf.snapshot.manifest,
        imports: tf.snapshot.imports,
        calls: tf.snapshot.calls,
        symbols: tf.snapshot.symbols,
        references: tf.snapshot.references ?? [],
      }),
      BUCKET,
    ).length;
    expect(radius).toBe(2);
    const card = tfArtifacts.get(
      "packages/root/modules/modules/logs/main.tf/resource.aws_s3_bucket.logs.md",
    ) as string;
    expect(block(card, "Blast radius")).toBe(`**Blast radius:** ${radius} node(s) (\`greplost impact ${BUCKET}\`)`);
  });

  test("attributes are omitted when the node has no meta, and an empty list says None", () => {
    const card = tfArtifacts.get("packages/root/modules/main.tf/local.name.md") as string;
    expect(block(card, "Attributes")).toBeUndefined();
    expect(block(card, "References")).toBe("**References:** None.");
    expect(block(card, "Referenced by")).toBe("**Referenced by:** [`tags`](local.tags.md) (hcl-ref)");
    expect(block(card, "Blast radius")).toBe("**Blast radius:** 5 node(s) (`greplost impact main.tf#local.name`)");
  });

  test("a reference target with no card of its own is named, never linked", () => {
    const card = tfArtifacts.get("packages/root/modules/main.tf/module.logs.md") as string;
    expect(block(card, "References")).toBe(
      "**References:** [`aws_vpc.main`](resource.aws_vpc.main.md) (hcl-ref), `modules/logs` (uses)",
    );
    expect(block(card, "Referenced by")).toBe("**Referenced by:** None.");
  });

  test("buildNodeCard refuses an id the snapshot does not declare as a node", () => {
    const ctx = createContext(tf);
    expect(() => buildNodeCard(ctx, "main.tf#resource.nope.nope")).toThrow(/no node card/);
    expect(() => buildNodeCard(ctx, "main.tf#terraform")).toThrow(/no node card/);
  });

  test("every link in every rendered artifact resolves to another artifact", () => {
    for (const [rel, text] of tfArtifacts) {
      for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1] ?? "";
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target));
        expect({ rel, target, known: tfArtifacts.has(resolved) }).toEqual({ rel, target, known: true });
      }
    }
  });
});

describe("file card nodes block", () => {
  test("the file card lists its nodes, linked and span-annotated", () => {
    const card = tfArtifacts.get("packages/root/modules/main.tf.md") as string;
    expect(block(card, "Nodes")).toBe(
      [
        "**Nodes:**",
        "- [`provider.aws`](main.tf/provider.aws.md)  L12-14",
        "- [`local.name`](main.tf/local.name.md)  L17-17",
        "- [`local.tags`](main.tf/local.tags.md)  L18-18",
        "- [`resource.aws_vpc.main`](main.tf/resource.aws_vpc.main.md)  L21-24",
        "- [`resource.aws_subnet.a`](main.tf/resource.aws_subnet.a.md)  L26-29",
        "- [`module.logs`](main.tf/module.logs.md)  L31-34",
      ].join("\n"),
    );
  });

  test("key symbols lists only non-node declarations, so a resource appears once", () => {
    const card = tfArtifacts.get("packages/root/modules/main.tf.md") as string;
    const keySymbols = block(card, "Key symbols") as string;
    expect(keySymbols).toBe("**Key symbols:**\n- `terraform`  L1-10");
    expect(keySymbols).not.toContain("aws_vpc");
  });

  test("the block sits between Key symbols and Calls and is omitted when a file has no nodes", () => {
    const snapshot = synth([
      {
        path: "main.tf",
        decls: [decl("main.tf", "resource", "aws_vpc.main", 1), decl("main.tf", "function", "helper", 9)],
        calls: [
          { from: "main.tf#function.helper", to: "other.tf#other", kind: "call", confidence: "high" },
        ],
      },
      { path: "other.tf", decls: [decl("other.tf", "function", "other", 1)] },
    ]);
    const artifacts = renderArtifacts({ snapshot, summaries: {} });
    const card = artifacts.get("packages/root/modules/main.tf.md") as string;
    const labels = card.split("\n\n").map((b) => (b.split(":**")[0] ?? "").trim());
    expect(labels.indexOf("**Key symbols")).toBeLessThan(labels.indexOf("**Nodes"));
    expect(labels.indexOf("**Nodes")).toBeLessThan(labels.indexOf("**Calls"));
    expect(block(artifacts.get("packages/root/modules/other.tf.md") as string, "Nodes")).toBeUndefined();
  });

  test("the package map gains a Nodes section and INDEX a nodes column, only when there are nodes", () => {
    const map = tfArtifacts.get("packages/root/MAP.md") as string;
    expect(map).toContain("## Nodes");
    expect(map).toContain("| [`main.tf`](modules/main.tf.md) | 6 |");
    expect(map).not.toContain("variables.tf`](modules/variables.tf.md) | 0 |");
    const index = tfArtifacts.get("INDEX.md") as string;
    expect(index).toContain("| Package | Path | Files | LOC | Nodes | Deps | Fan-in | Fan-out | Map |");
    expect(index).toContain("| root | . | 5 | 59 | 13 |");
  });
});

describe("reference caps", () => {
  test("both reference lists stop at 50 and say how many were dropped", () => {
    const artifacts = renderArtifacts({ snapshot: hubSnapshot(61), summaries: {} });
    const card = artifacts.get("packages/root/modules/main.tf/resource.r0.md") as string;
    const references = block(card, "References") as string;
    expect((references.match(/\(hcl-ref\)/g) ?? []).length).toBe(50);
    expect(references.endsWith(", … 10 more")).toBe(true);
    const referencedBy = block(card, "Referenced by") as string;
    expect((referencedBy.match(/\(hcl-ref\)/g) ?? []).length).toBe(50);
    expect(referencedBy.endsWith(", … 10 more")).toBe(true);
  });

  test("the file card's Nodes block stops at 50 with the same tail", () => {
    const artifacts = renderArtifacts({ snapshot: hubSnapshot(61), summaries: {} });
    const nodes = block(artifacts.get("packages/root/modules/main.tf.md") as string, "Nodes") as string;
    const lines = nodes.split("\n");
    expect(lines).toHaveLength(52);
    expect(lines[51]).toBe("- … 11 more");
  });

  test("a list exactly at the cap carries no tail", () => {
    const hub = renderArtifacts({ snapshot: hubSnapshot(51), summaries: {} });
    const card = hub.get("packages/root/modules/main.tf/resource.r0.md") as string;
    expect(block(card, "References")).not.toContain("more");
    expect(block(card, "Referenced by")).not.toContain("more");

    const fifty = renderArtifacts({
      snapshot: synth([{ path: "main.tf", decls: resources(50) }]),
      summaries: {},
    });
    const nodes = block(fifty.get("packages/root/modules/main.tf.md") as string, "Nodes") as string;
    expect(nodes.split("\n")).toHaveLength(51);
    expect(nodes).not.toContain("more");
  });
});

describe("card path collisions", () => {
  test("two nodes whose names slug the same are a loud failure, not a lost card", () => {
    const snapshot = synth([
      { path: "main.tf", decls: [decl("main.tf", "resource", "a/b", 1), decl("main.tf", "resource", "a__b", 3)] },
    ]);
    expect(() => renderArtifacts({ snapshot, summaries: {} })).toThrow(/card path collision/);
  });

  test("a node card that would overwrite a file card is caught too", () => {
    const snapshot = synth([
      { path: "main.tf", decls: [decl("main.tf", "resource", "x", 1)] },
      { path: "main.tf/resource.x", decls: [] },
    ]);
    expect(() => renderArtifacts({ snapshot, summaries: {} })).toThrow(/card path collision/);
  });

  test("the real render claims every path exactly once", () => {
    const paths = [...tfArtifacts.keys()];
    const nodes = tf.snapshot.symbols.filter((d) => isNodeKind(d.kind));
    expect(new Set(paths).size).toBe(paths.length);
    // INDEX, repo/MAP, repo/HOTSPOTS, the package's MAP and API, then one card per file and node.
    expect(paths).toHaveLength(5 + tf.snapshot.files.length + nodes.length);
  });
});

describe("no nodes no change", () => {
  test("a repo with no nodes renders byte-identically to the build-1 golden", async () => {
    const summaries = goldenSummaries();
    const snapshot = await buildSnapshot({ root: TINY_TS, summaries });
    const artifacts = renderArtifacts({ snapshot, summaries });
    const expected = listGolden(TS_GOLDEN);
    expect(expected.length).toBeGreaterThan(0);
    expect([...artifacts.keys()].sort(compareStrings)).toEqual(expected);
    for (const rel of expected) {
      expect(`${rel}\n${artifacts.get(rel)}`).toBe(`${rel}\n${readFileSync(path.join(TS_GOLDEN, rel), "utf8")}`);
    }
  });

  test("no artifact of a nodeless repo mentions nodes at all", async () => {
    const summaries = goldenSummaries();
    const snapshot = await buildSnapshot({ root: TINY_TS, summaries });
    const artifacts = renderArtifacts({ snapshot, summaries });
    for (const [rel, text] of artifacts) {
      expect({ rel, nodes: text.includes("**Nodes:**") || text.includes("## Nodes") }).toEqual({
        rel,
        nodes: false,
      });
    }
    expect(artifacts.get("INDEX.md")).toContain("| Package | Path | Files | LOC | Deps | Fan-in | Fan-out | Map |");
  });
});

describe("golden tiny-terraform", () => {
  test("every artifact matches the committed golden byte for byte", () => {
    if (UPDATE) {
      rmSync(TF_GOLDEN, { recursive: true, force: true });
      for (const [rel, text] of tfArtifacts) {
        const full = path.join(TF_GOLDEN, rel);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, text);
      }
    }
    const expected = listGolden(TF_GOLDEN);
    expect(expected.length).toBeGreaterThan(0);
    expect([...tfArtifacts.keys()].sort(compareStrings)).toEqual(expected);
    for (const rel of expected) {
      expect(`${rel}\n${tfArtifacts.get(rel)}`).toBe(`${rel}\n${readFileSync(path.join(TF_GOLDEN, rel), "utf8")}`);
    }
  });

  test("the render is deterministic and leaks no date, absolute path or host", () => {
    const again = renderArtifacts(tf);
    expect([...again.entries()]).toEqual([...tfArtifacts.entries()]);
    for (const [rel, text] of tfArtifacts) {
      expect({ rel, leak: /\d{4}-\d{2}-\d{2}/.test(text) || text.includes(FIXTURES) }).toEqual({ rel, leak: false });
    }
  });

  test("every artifact carries the generated-by header under a level-1 title", () => {
    for (const [rel, text] of tfArtifacts) {
      const lines = text.split("\n");
      expect(lines[0]?.startsWith("# ")).toBe(true);
      expect(lines[1]).toBe("");
      expect(lines[2]).toBe("> Generated by greplost. Do not edit by hand; run `greplost update`.");
      expect(text.endsWith("\n")).toBe(true);
      expect(text.endsWith("\n\n")).toBe(false);
      expect(rel.endsWith(".md")).toBe(true);
    }
  });
});
