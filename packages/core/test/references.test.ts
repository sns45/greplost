import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ARTIFACT_PATHS, NODE_KINDS, isNodeKind, nodeId, splitNodeId } from "../src/schema.ts";
import type { DeclKind, FileRecord, ReferenceEdge, ReferenceRecord } from "../src/schema.ts";
import { buildSnapshot } from "../src/build.ts";
import { serializeSnapshot } from "../src/serialize/index.ts";
import { parseJsonl, readStructure } from "../src/serialize/index.ts";
import { compareReferenceEdges, linkReferences, referenceSource } from "../src/references/index.ts";
import { createResolver } from "../src/resolve/index.ts";
import { extractDockerfile } from "../src/extract/dockerfile.ts";
import { extractHcl } from "../src/extract/hcl.ts";
import { extractJava } from "../src/extract/java.ts";
import { extractKotlin } from "../src/extract/kotlin.ts";
import { extractPython } from "../src/extract/python.ts";
import { extractRust } from "../src/extract/rust.ts";
import { extractYamlActions } from "../src/extract/yaml-actions.ts";
import { extractYamlHelm } from "../src/extract/yaml-helm.ts";
import { extractYamlK8s } from "../src/extract/yaml-k8s.ts";
import { createDockerfileResolver } from "../src/resolve/dockerfile.ts";
import { createHclResolver } from "../src/resolve/hcl.ts";
import { createJavaResolver } from "../src/resolve/java.ts";
import { createKotlinResolver } from "../src/resolve/kotlin.ts";
import { createPythonResolver } from "../src/resolve/python.ts";
import { createRustResolver } from "../src/resolve/rust.ts";
import { createYamlResolver } from "../src/resolve/yaml.ts";
import { resolveDockerfileReferences } from "../src/references/dockerfile.ts";
import { resolveHclReferences } from "../src/references/hcl.ts";
import { resolveYamlActionsReferences } from "../src/references/yaml-actions.ts";
import { resolveYamlK8sReferences } from "../src/references/yaml-k8s.ts";
import { SIGNAL_PASSES, runSignals } from "../src/signals/index.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TINY_TS = path.join(REPO_ROOT, "fixtures", "tiny-ts");

const temporaryDirs: string[] = [];
afterAll(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

/** A `Tree` the stubs never touch: every one of them throws before looking at it. */
const NO_TREE = null as never;

function record(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    path: "infra/main.tf",
    lang: "hcl",
    sha256: "0".repeat(64),
    loc: 1,
    decls: [],
    imports: [],
    exports: [],
    calls: [],
    ...overrides,
  };
}

function ref(overrides: Partial<ReferenceRecord> = {}): ReferenceRecord {
  return { from: "", to: "aws_vpc.main", refKind: "hcl-ref", line: 1, ...overrides };
}

function emptyContext(files: readonly string[]) {
  const set = new Set(files);
  return {
    root: "/repo",
    files: set,
    packages: [],
    readFile: (): string | null => null,
  };
}

// ---------------------------------------------------------------------------

describe("node ids", () => {
  test("a node id round-trips through nodeId and splitNodeId", () => {
    const id = nodeId("infra/main.tf", "resource", "aws_s3_bucket.logs");
    expect(id).toBe("infra/main.tf#resource.aws_s3_bucket.logs");
    expect(splitNodeId(id)).toEqual({
      file: "infra/main.tf",
      kind: "resource",
      name: "aws_s3_bucket.logs",
    });
  });

  test("every NODE_KIND round-trips, including names full of punctuation", () => {
    for (const kind of [...NODE_KINDS].sort()) {
      const name = "a/b.[id]:$x";
      const id = nodeId("app/page.tsx", kind, name);
      expect(splitNodeId(id)).toEqual({ file: "app/page.tsx", kind, name });
      expect(isNodeKind(kind)).toBe(true);
    }
  });

  test("the spec's index-suffixed name is refused by the landed nodeId", () => {
    // Spec section 0.2 gives `deploy.yaml#resource.Deployment.#2` as the form an unnamed or
    // colliding document takes, and in the same paragraph forbids "#" in a name. The landed
    // `nodeId` enforces the second sentence, so the first is unreachable. Recorded here so
    // whoever needs the index form (leaves 2.8 and 2.9) meets the contradiction as a failing
    // expectation rather than as a mystery at runtime.
    expect(() => nodeId("deploy.yaml", "resource", "Deployment.#2")).toThrow(/may not contain/);
  });

  test("a name with #, a newline or NUL is refused", () => {
    expect(() => nodeId("a.tf", "resource", "bad#name")).toThrow(
      /greplost: node name "bad#name" may not contain "#", a newline or NUL/,
    );
    expect(() => nodeId("a.tf", "resource", "bad\nname")).toThrow(/may not contain/);
    expect(() => nodeId("a.tf", "resource", "bad\u0000name")).toThrow(/may not contain/);
    // A space, a slash, a colon, a dollar and brackets are all fine: routes and Pulumi
    // type tokens need them (spec section 0.2, "Name characters").
    expect(nodeId("a.tf", "resource", "bad name")).toBe("a.tf#resource.bad name");
    expect(nodeId("app/page.tsx", "route", "/users/[id]")).toBe("app/page.tsx#route./users/[id]");
    expect(nodeId("a.ts", "resource", "aws:s3/b:B$1")).toBe("a.ts#resource.aws:s3/b:B$1");
  });

  test("a plain symbol id is not a node id", () => {
    expect(splitNodeId("packages/core/src/registry.ts#Registry.register")).toBeNull();
    expect(splitNodeId("packages/core/src/registry.ts")).toBeNull();
    expect(splitNodeId("pkg:@greplost/core")).toBeNull();
    expect(splitNodeId("infra/main.tf#resource")).toBeNull();
    expect(splitNodeId("infra/main.tf#resource.")).toBeNull();
    expect(isNodeKind("function")).toBe(false);
    expect(isNodeKind("route")).toBe(true);
  });

  test("a symbol kind is never a node kind", () => {
    for (const kind of ["function", "class", "interface", "type", "enum", "const", "method"] as DeclKind[]) {
      expect(isNodeKind(kind)).toBe(false);
    }
  });

  test("referenceSource names the file for a file-level reference and the node otherwise", () => {
    expect(referenceSource("infra/main.tf", ref({ from: "" }))).toBe("infra/main.tf");
    expect(referenceSource("infra/main.tf", ref({ from: "resource.aws_vpc.main" }))).toBe(
      "infra/main.tf#resource.aws_vpc.main",
    );
  });
});

// ---------------------------------------------------------------------------

describe("absent references file", () => {
  test("a repo with no references produces no references.jsonl and an unchanged artifact set", async () => {
    const snapshot = await buildSnapshot({ root: TINY_TS });
    expect(snapshot.references).toEqual([]);

    const written = [...serializeSnapshot(snapshot).keys()].sort();
    expect(written).not.toContain(ARTIFACT_PATHS.references);
    expect(written).toEqual([
      ARTIFACT_PATHS.calls,
      ARTIFACT_PATHS.imports,
      ARTIFACT_PATHS.manifest,
      ARTIFACT_PATHS.symbols,
    ].sort());
  });

  test("readStructure reports [] when the artifact is absent", () => {
    const structure = readStructure(path.join(TINY_TS, "does-not-exist"));
    expect(structure).toBeNull();
  });

  test("linkReferences over records with no refs is empty and allocates no context", () => {
    const files = [record({ lang: "ts", path: "a.ts" }), record({ lang: "go", path: "b.go" })];
    const ctx = emptyContext(["a.ts", "b.go"]);
    expect(linkReferences(files, createResolver(ctx), ctx)).toEqual([]);
  });

  test("the signal layer is complete and only the implemented passes apply", () => {
    expect(SIGNAL_PASSES.map((pass) => pass.id)).toEqual(["next", "pulumi-go", "pulumi-ts", "react", "tanstack"]);
    // Leaf 2.3 landed the four TypeScript passes, so `react` now answers for a `.tsx` file;
    // `next`, `pulumi-ts`, `tanstack` want a path or text this source does not have, and
    // `pulumi-go` is still the inert stub leaf 2.7 owns.
    const applies = SIGNAL_PASSES.filter((pass) => pass.applies("a.tsx", 'import "react";')).map((pass) => pass.id);
    expect(applies).toEqual(["react"]);
  });

  test("a pass that does not apply is never given the tree", () => {
    const out = runSignals(
      {
        path: "a.tsx",
        lang: "tsx",
        source: "export const A = () => null;\n",
        tree: NO_TREE,
        base: { decls: [], imports: [], exports: [], calls: [] },
      },
      // Every pass turned off: `config.signals: []` is how a repo opts out (spec 3.1), and it
      // is the one setting under which no pass may touch the (here unusable) tree.
      [],
    );
    expect(out).toEqual({ decls: [], refs: [] });
  });
});

// ---------------------------------------------------------------------------

describe("references jsonl round trip", () => {
  const edges: ReferenceEdge[] = [
    {
      from: "infra/main.tf#resource.aws_subnet.a",
      to: "infra/main.tf#resource.aws_vpc.main",
      kind: "reference",
      refKind: "hcl-ref",
      symbols: ["aws_vpc.main.id"],
      confidence: "high",
    },
    {
      from: "Dockerfile",
      to: "ext:image/node:20",
      kind: "reference",
      refKind: "from-image",
      symbols: ["node:20"],
      confidence: "high",
    },
  ];

  test("serializeSnapshot writes the artifact once there is at least one edge", () => {
    const snapshot = {
      root: "/repo",
      config: { include: [], exclude: [], languages: [] },
      packages: [],
      files: [],
      manifest: { version: "2", packages: {}, files: {} },
      imports: [],
      calls: [],
      symbols: [],
      metrics: { cycles: [], packageEdges: [] },
      references: edges,
    } as unknown as Parameters<typeof serializeSnapshot>[0];

    const written = serializeSnapshot(snapshot);
    const text = written.get(ARTIFACT_PATHS.references);
    expect(text).toBeDefined();
    const parsed = parseJsonl<ReferenceEdge>(text as string);
    // Written in the sorted order the spec fixes: (from, to, refKind, symbols).
    expect(parsed.map((edge) => edge.from)).toEqual(["Dockerfile", "infra/main.tf#resource.aws_subnet.a"]);
    expect(parsed).toEqual([...edges].sort(compareReferenceEdges));
  });

  test("the sort is (from, to, refKind, symbols) and is stable under shuffling", () => {
    const a: ReferenceEdge = { ...(edges[0] as ReferenceEdge) };
    const b: ReferenceEdge = { ...(edges[0] as ReferenceEdge), refKind: "config" };
    const c: ReferenceEdge = { ...(edges[0] as ReferenceEdge), refKind: "config", symbols: ["z"] };
    expect([a, b, c].sort(compareReferenceEdges)).toEqual([b, c, a]);
    expect([c, a, b].sort(compareReferenceEdges)).toEqual([b, c, a]);
  });

  test("readStructure reads the artifact back and the sync layer owns its path", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-references-"));
    temporaryDirs.push(dir);
    const snapshot = {
      root: "/repo",
      config: { include: [], exclude: [], languages: [] },
      packages: [],
      files: [],
      manifest: { version: "2", packages: {}, files: {} },
      imports: [],
      calls: [],
      symbols: [],
      metrics: { cycles: [], packageEdges: [] },
      references: edges,
    } as unknown as Parameters<typeof serializeSnapshot>[0];

    for (const [relative, contents] of serializeSnapshot(snapshot)) {
      const file = path.join(dir, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents);
    }

    const structure = readStructure(dir);
    expect(structure?.references).toEqual([...edges].sort(compareReferenceEdges));
    // `sync/artifacts.ts` already matches `graph/*.jsonl`, so its writer owns and prunes the
    // new artifact with no change; asserting that from here would make a core test import the
    // sync package, so it stays a sync-side property and this test stops at the read back.
  });

  test("linkReferences refuses a reference from a language with no rules", () => {
    // `ts` gained rules with leaf 2.3 (`references/ts.ts`); Go still has none, so it is the
    // language that proves the guard is still armed.
    const files = [record({ lang: "go", path: "a.go", refs: [ref({ refKind: "resource-input" })] })];
    const ctx = emptyContext(["a.go"]);
    expect(() => linkReferences(files, createResolver(ctx), ctx)).toThrow(
      /greplost: a\.go produced 1 reference but there are no reference rules for "go"/,
    );
  });
});

// ---------------------------------------------------------------------------

describe("stubs", () => {
  test("every unimplemented extractor throws, naming the file and its leaf", () => {
    // `python` left this list when leaf 2.1 implemented it; each language leaf removes its
    // own row, and the list is empty when build 2 is done.
    const cases: ReadonlyArray<readonly [string, (path: string) => unknown, RegExp]> = [
      // python (leaf 2.1) and rust (leaf 2.4) are no longer stubs: their own test files
      // (extract-python.test.ts, extract-rust.test.ts) hold them to the contract now.
      ["A.java", (p) => extractJava(p, "java", "", NO_TREE), /java extractor .* build-2 leaf 2\.5/],
      ["A.kt", (p) => extractKotlin(p, "kotlin", "", NO_TREE), /kotlin extractor .* build-2 leaf 2\.6/],
      ["Dockerfile", (p) => extractDockerfile(p, "dockerfile", "", NO_TREE), /dockerfile extractor .* leaf 2\.10/],
      ["deploy.yaml", (p) => extractYamlK8s(p, "yaml", "", NO_TREE), /yaml-k8s extractor .* build-2 leaf 2\.8/],
      ["Chart.yaml", (p) => extractYamlHelm(p, "yaml", "", NO_TREE), /yaml-helm extractor .* build-2 leaf 2\.8/],
      ["ci.yml", (p) => extractYamlActions(p, "yaml", "", NO_TREE), /yaml-actions extractor .* build-2 leaf 2\.9/],
    ];
    for (const [file, call, pattern] of cases) {
      expect(() => call(file), file).toThrow(pattern);
      // Every message names the file it happened on, so a failing build is actionable.
      expect(() => call(file), file).toThrow(new RegExp(file.replace(".", "\\.")));
    }
  });

  test("every unimplemented resolver builds for free and throws on the first specifier", () => {
    const ctx = emptyContext([]);
    const cases: ReadonlyArray<readonly [ReturnType<typeof createJavaResolver>, RegExp]> = [
      [createJavaResolver(ctx), /java resolver .* build-2 leaf 2\.5/],
      [createKotlinResolver(ctx), /kotlin resolver .* build-2 leaf 2\.6/],
      [createDockerfileResolver(ctx), /dockerfile resolver .* build-2 leaf 2\.10/],
    ];
    for (const [resolve, pattern] of cases) {
      expect(() => resolve("a/b", "x")).toThrow(pattern);
    }
  });

  test("the Rust resolver is implemented: a `use` of an absent crate is external, not a throw", () => {
    // Leaf 2.4 landed, so this pair is the counterpart of the stub cases above: the module
    // exists, answers, and never throws.
    const resolve = createRustResolver(emptyContext(["src/lib.rs"]));
    expect(resolve("src/lib.rs", "serde::Serialize")).toEqual({ type: "external", pkg: "crate/serde" });
  });

  test("the YAML resolver is implemented: YAML has no imports, so nothing resolves", () => {
    const resolve = createYamlResolver(emptyContext(["deploy.yaml"]));
    expect(resolve("deploy.yaml", "./other.yaml")).toEqual({ type: "unresolved" });
  });

  test("every unimplemented reference rule throws, naming the file, the kind and its leaf", () => {
    const ctx = {
      recordByPath: new Map<string, FileRecord>(),
      declarationById: new Map(),
      nodesByKind: new Map(),
      resolver: createResolver(emptyContext([])),
      files: new Set<string>(),
    };
    // hcl landed with leaf 2.2: its rule resolves or returns null, and `extract-hcl.test.ts`
    // owns the assertions. An address that names nothing is dropped, never guessed, so the
    // one property this file still needs from it is that it never invents an edge.
    expect(resolveHclReferences(record(), ref(), ctx)).toBeNull();
    expect(() => resolveYamlK8sReferences(record({ lang: "yaml" }), ref({ refKind: "selector" }), ctx)).toThrow(
      /yaml-k8s reference resolution .* leaf 2\.8/,
    );
    expect(() =>
      resolveYamlActionsReferences(record({ lang: "yaml" }), ref({ refKind: "needs" }), ctx),
    ).toThrow(/yaml-actions reference resolution .* leaf 2\.9/);
    expect(() =>
      resolveDockerfileReferences(record({ lang: "dockerfile" }), ref({ refKind: "from-image" }), ctx),
    ).toThrow(/dockerfile reference resolution .* leaf 2\.10/);
  });

  test("a stub never returns: an empty answer would read as an empty file", () => {
    // The whole point of throwing. If any of these ever returns, a repo that configures the
    // language gets a map full of files with no declarations and no warning anywhere.
    let returned = false;
    try {
      extractYamlActions("ci.yml", "yaml", "", NO_TREE);
      returned = true;
    } catch {
      returned = false;
    }
    expect(returned).toBe(false);
  });
});
