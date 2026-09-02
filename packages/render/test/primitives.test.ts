import { describe, expect, test } from "bun:test";
import type { PackageInfo } from "@greplost/core/schema";
import type { GraphEdge, GraphSpec } from "../src/mermaid.ts";
import { mermaidId, renderGraph } from "../src/mermaid.ts";
import { renderTree } from "../src/ascii.ts";
import type { Diagram, SplitNode } from "../src/split.ts";
import { splitDiagram } from "../src/split.ts";
import { estimateTokens, INDEX_TOKEN_BUDGET } from "../src/tokens.ts";
import { cardPath, packageDir, relLink } from "../src/slug.ts";

describe("mermaidId", () => {
  test("passes an already-valid id through unchanged", () => {
    expect(mermaidId("registry_ts")).toBe("registry_ts");
  });

  test("replaces any character outside [A-Za-z0-9_] with _", () => {
    expect(mermaidId("packages/core/src/registry.ts")).toBe("packages_core_src_registry_ts");
    expect(mermaidId("@scope/pkg-name")).toBe("_scope_pkg_name");
  });

  test("prefixes n_ when the sanitised id is empty", () => {
    expect(mermaidId("")).toBe("n_");
  });

  test("prefixes n_ when the sanitised id starts with a digit", () => {
    expect(mermaidId("123abc")).toBe("n_123abc");
    expect(mermaidId("0")).toBe("n_0");
  });

  test("without a taken set, repeated calls do not dedupe against each other", () => {
    expect(mermaidId("a.b")).toBe("a_b");
    expect(mermaidId("a-b")).toBe("a_b");
  });

  test("resolves collisions deterministically with _2, _3, ... in call order", () => {
    const taken = new Set<string>();
    expect(mermaidId("a.b", taken)).toBe("a_b");
    expect(mermaidId("a-b", taken)).toBe("a_b_2");
    expect(mermaidId("a_b", taken)).toBe("a_b_3");
    expect([...taken]).toEqual(["a_b", "a_b_2", "a_b_3"]);
  });

  test("two raw ids that sanitise identically both get distinct, stable ids", () => {
    const taken = new Set<string>();
    const first = mermaidId("packages/core/src/a.ts", taken);
    const second = mermaidId("packages_core_src_a_ts", taken); // sanitises to the exact same string
    expect(first).not.toBe(second);
    expect(second).toBe(`${first}_2`);
  });

  test("a synthetic n_ id can itself collide with a digit-prefixed raw id", () => {
    const taken = new Set<string>();
    expect(mermaidId("123", taken)).toBe("n_123");
    expect(mermaidId("n_123", taken)).toBe("n_123_2");
  });
});

describe("renderGraph", () => {
  test('renders a node as `  id["label"]`', () => {
    const out = renderGraph({ direction: "LR", nodes: [{ id: "registry_ts", label: "registry.ts" }], edges: [] });
    expect(out).toContain('  registry_ts["registry.ts"]');
  });

  test("wraps a fenced mermaid block with the given direction and a trailing blank line", () => {
    const out = renderGraph({ direction: "TD", nodes: [{ id: "a", label: "A" }], edges: [] });
    expect(out.startsWith("```mermaid\ngraph TD\n")).toBe(true);
    expect(out.endsWith("```\n\n")).toBe(true);
  });

  test("renders a valid fenced block for an empty node list", () => {
    const out = renderGraph({ direction: "LR", nodes: [], edges: [] });
    expect(out).toBe("```mermaid\ngraph LR\n```\n\n");
  });

  test("sorts nodes and edges into id order regardless of input order", () => {
    const spec: GraphSpec = {
      direction: "LR",
      nodes: [
        { id: "b", label: "B" },
        { id: "a", label: "A" },
      ],
      edges: [
        { from: "b", to: "a" },
        { from: "a", to: "b" },
      ],
    };
    const out = renderGraph(spec);
    const aNode = out.indexOf('a["A"]');
    const bNode = out.indexOf('b["B"]');
    expect(aNode).toBeGreaterThan(-1);
    expect(bNode).toBeGreaterThan(aNode);
    const edgeAB = out.indexOf("a --> b");
    const edgeBA = out.indexOf("b --> a");
    expect(edgeAB).toBeGreaterThan(-1);
    expect(edgeBA).toBeGreaterThan(edgeAB);
  });

  test("edges without a label render as a plain arrow; edges with a label carry a count", () => {
    const out = renderGraph({
      direction: "LR",
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
        { id: "d", label: "D" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "c", to: "d", label: "3" },
      ],
    });
    expect(out).toContain("  a --> b");
    expect(out).toContain("  c -->|3| d");
  });

  test('escapes " as #quot; and replaces bracket/paren/brace characters', () => {
    const out = renderGraph({
      direction: "LR",
      nodes: [{ id: "n", label: 'say "hi" [x](y) {z}' }],
      edges: [],
    });
    expect(out).not.toContain('"hi"');
    expect(out).not.toMatch(/\[x\]/);
    expect(out).not.toMatch(/\(y\)/);
    expect(out).not.toMatch(/\{z\}/);
    expect(out).toContain('  n["say #quot;hi#quot; #91;x#93;#40;y#41; #123;z#125;"]');
  });

  test("escapes | in edge labels", () => {
    const out = renderGraph({
      direction: "LR",
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      edges: [{ from: "a", to: "b", label: "3|4" }],
    });
    expect(out).toContain("  a -->|3#124;4| b");
  });
});

describe("renderTree", () => {
  test("draws a box-drawing tree with directories before files at each level", () => {
    const out = renderTree(["b.ts", "a/x.ts", "a/y.ts"]);
    expect(out.split("\n")).toEqual(["├── a", "│   ├── x.ts", "│   └── y.ts", "└── b.ts"]);
  });

  test("sorts by code-unit order, not locale order", () => {
    const out = renderTree(["z.ts", "A.ts", "a.ts"]);
    expect(out.split("\n")).toEqual(["├── A.ts", "├── a.ts", "└── z.ts"]);
  });

  test("appends an annotation after two spaces, and only to nodes the callback recognises", () => {
    const out = renderTree(["packages/core"], {
      annotate: (path) => (path === "packages/core" ? "@tiny/core" : ""),
    });
    expect(out).toBe("└── packages\n    └── core  @tiny/core");
  });

  test("skips the annotation entirely when the callback returns an empty string", () => {
    const out = renderTree(["a.ts"], { annotate: () => "" });
    expect(out).toBe("└── a.ts");
  });

  test("returns an empty string for an empty path list", () => {
    expect(renderTree([])).toBe("");
  });

  test("handles a directory named with a leading dot", () => {
    const out = renderTree([".github/workflows.yml", "src/index.ts"]);
    expect(out.split("\n")).toEqual(["├── .github", "│   └── workflows.yml", "└── src", "    └── index.ts"]);
  });

  test("a path that is both a leaf and a prefix of another path renders once, as a directory", () => {
    const out = renderTree(["packages/core", "packages/core/src/index.ts"]);
    expect(out.split("\n")).toEqual(["└── packages", "    └── core", "        └── src", "            └── index.ts"]);
  });
});

describe("splitDiagram", () => {
  test("returns a single diagram titled `root` when nodes.length <= maxNodes", () => {
    const nodes: SplitNode[] = [{ id: "a", label: "a.ts", dir: "" }];
    const diagrams = splitDiagram("packages/core", nodes, [], 25);
    expect(diagrams).toEqual([
      { title: "packages/core", spec: { direction: "LR", nodes: [{ id: "a", label: "a.ts" }], edges: [] } },
    ]);
  });

  test("handles an empty node list", () => {
    const diagrams = splitDiagram(".", [], [], 25);
    expect(diagrams).toEqual([{ title: ".", spec: { direction: "LR", nodes: [], edges: [] } }]);
  });

  test("preserves a genuine self-loop edge in the base (unsplit) case", () => {
    const nodes: SplitNode[] = [{ id: "a", label: "a.ts", dir: "" }];
    const diagrams = splitDiagram(".", nodes, [{ from: "a", to: "a" }], 25);
    expect(diagrams[0]?.spec.edges).toEqual([{ from: "a", to: "a" }]);
  });

  test("drops edges to nodes outside the diagram and aggregates duplicate edges by summing counts", () => {
    const nodes: SplitNode[] = [
      { id: "a", label: "a.ts", dir: "" },
      { id: "b", label: "b.ts", dir: "" },
    ];
    const edges: GraphEdge[] = [
      { from: "a", to: "b" },
      { from: "a", to: "b" },
      { from: "a", to: "ext:missing" },
    ];
    const diagrams = splitDiagram(".", nodes, edges, 25);
    expect(diagrams[0]?.spec.edges).toEqual([{ from: "a", to: "b", label: "2" }]);
  });

  test(
    "groups by first directory segment, aggregates cross-group edges with counts, " +
      "drops intra-group edges from the overview, and recurses per group",
    () => {
      const nodes: SplitNode[] = [
        { id: "core_a", label: "a.ts", dir: "core" },
        { id: "core_b", label: "b.ts", dir: "core" },
        { id: "render_a", label: "ra.ts", dir: "render" },
        { id: "root_file", label: "root.ts", dir: "" },
      ];
      const edges: GraphEdge[] = [
        { from: "core_a", to: "core_b" },
        { from: "core_a", to: "render_a" },
        { from: "core_b", to: "render_a" },
        { from: "root_file", to: "core_a" },
      ];
      const diagrams = splitDiagram(".", nodes, edges, 3);

      expect(diagrams).toHaveLength(3);
      expect(diagrams[0]).toEqual({
        title: ". (overview)",
        spec: {
          direction: "LR",
          nodes: [
            { id: "root_file", label: "root.ts" },
            { id: "core", label: "core/ (2 files)" },
            { id: "render", label: "render/ (1 files)" },
          ],
          edges: [
            { from: "core", to: "render", label: "2" },
            { from: "root_file", to: "core" },
          ],
        },
      });

      expect(diagrams.find((d) => d.title === "core")).toEqual({
        title: "core",
        spec: {
          direction: "LR",
          nodes: [
            { id: "core_a", label: "a.ts" },
            { id: "core_b", label: "b.ts" },
          ],
          edges: [{ from: "core_a", to: "core_b" }],
        },
      });

      expect(diagrams.find((d) => d.title === "render")).toEqual({
        title: "render",
        spec: { direction: "LR", nodes: [{ id: "render_a", label: "ra.ts" }], edges: [] },
      });
    },
  );

  test("keeps root-level ('.') files as individual nodes in the overview when that still fits the cap", () => {
    const nodes: SplitNode[] = [
      { id: "root1", label: "root1.ts", dir: "" },
      { id: "root2", label: "root2.ts", dir: "" },
      { id: "sub_a", label: "a.ts", dir: "sub" },
      { id: "sub_b", label: "b.ts", dir: "sub" },
    ];
    // 4 nodes > cap(3), but the overview (2 individual root files + 1 group node) fits in 3.
    const diagrams = splitDiagram(".", nodes, [], 3);
    expect(diagrams[0]).toEqual({
      title: ". (overview)",
      spec: {
        direction: "LR",
        nodes: [
          { id: "root1", label: "root1.ts" },
          { id: "root2", label: "root2.ts" },
          { id: "sub", label: "sub/ (2 files)" },
        ],
        edges: [],
      },
    });
    // no separate diagram for "." itself: its files are already shown individually above.
    expect(diagrams.find((d) => d.title === ".")).toBeUndefined();
    expect(diagrams).toHaveLength(2);
  });

  test("collapses the root ('.') group and paginates it separately when it does not fit the cap", () => {
    const nodes: SplitNode[] = [
      { id: "n1", label: "n1.ts", dir: "" },
      { id: "n2", label: "n2.ts", dir: "" },
      { id: "n3", label: "n3.ts", dir: "" },
      { id: "n4", label: "n4.ts", dir: "" },
      { id: "n5", label: "n5.ts", dir: "" },
      { id: "s1", label: "s1.ts", dir: "src" },
    ];
    const diagrams = splitDiagram(".", nodes, [], 2);

    expect(diagrams).toHaveLength(5); // overview + src detail + 3 paginated root pages
    expect(diagrams[0]).toEqual({
      title: ". (overview)",
      spec: {
        direction: "LR",
        nodes: [
          { id: "_", label: "./ (5 files)" },
          { id: "src", label: "src/ (1 files)" },
        ],
        edges: [],
      },
    });
    expect(diagrams[1]).toEqual({
      title: "src",
      spec: { direction: "LR", nodes: [{ id: "s1", label: "s1.ts" }], edges: [] },
    });
    expect(diagrams[2]).toEqual({
      title: ". (part 1 of 3)",
      spec: {
        direction: "LR",
        nodes: [
          { id: "n1", label: "n1.ts" },
          { id: "n2", label: "n2.ts" },
        ],
        edges: [],
      },
    });
    expect(diagrams[3]).toEqual({
      title: ". (part 2 of 3)",
      spec: {
        direction: "LR",
        nodes: [
          { id: "n3", label: "n3.ts" },
          { id: "n4", label: "n4.ts" },
        ],
        edges: [],
      },
    });
    expect(diagrams[4]).toEqual({
      title: ". (part 3 of 3)",
      spec: { direction: "LR", nodes: [{ id: "n5", label: "n5.ts" }], edges: [] },
    });
  });

  test("paginates a flat directory (all nodes directly under root) that alone exceeds the cap", () => {
    const nodes: SplitNode[] = [
      { id: "a", label: "a.ts", dir: "" },
      { id: "b", label: "b.ts", dir: "" },
      { id: "c", label: "c.ts", dir: "" },
    ];
    const diagrams = splitDiagram("packages/core", nodes, [], 2);
    expect(diagrams).toEqual([
      {
        title: "packages/core (part 1 of 2)",
        spec: {
          direction: "LR",
          nodes: [
            { id: "a", label: "a.ts" },
            { id: "b", label: "b.ts" },
          ],
          edges: [],
        },
      },
      {
        title: "packages/core (part 2 of 2)",
        spec: { direction: "LR", nodes: [{ id: "c", label: "c.ts" }], edges: [] },
      },
    ]);
  });

  test("recurses through multiple directory levels, walking a single branch down to its files", () => {
    const nodes: SplitNode[] = [
      { id: "deep1", label: "deep1.ts", dir: "a/b/c" },
      { id: "deep2", label: "deep2.ts", dir: "a/b/c" },
    ];
    const diagrams = splitDiagram(".", nodes, [], 1);
    const titles = diagrams.map((d) => d.title).sort();
    expect(titles).toEqual([". (overview)", "a (overview)", "a/b (overview)", "a/b/c (part 1 of 2)", "a/b/c (part 2 of 2)"]);
  });
});

describe("node cap", () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function assertNodeCap(diagrams: Diagram[], maxNodes: number): void {
    expect(diagrams.length).toBeGreaterThan(0);
    for (const diagram of diagrams) {
      expect(diagram.spec.nodes.length).toBeLessThanOrEqual(maxNodes);
      const ids = new Set(diagram.spec.nodes.map((n) => n.id));
      expect(ids.size).toBe(diagram.spec.nodes.length);
      for (const edge of diagram.spec.edges) {
        expect(ids.has(edge.from)).toBe(true);
        expect(ids.has(edge.to)).toBe(true);
      }
    }
  }

  function flatFiles(count: number, rng: () => number): { nodes: SplitNode[]; edges: GraphEdge[] } {
    const nodes: SplitNode[] = [];
    for (let i = 0; i < count; i++) nodes.push({ id: `f${i}`, label: `f${i}.ts`, dir: "" });
    const edges: GraphEdge[] = [];
    const edgeCount = Math.floor(rng() * count * 2);
    for (let i = 0; i < edgeCount; i++) {
      const from = `f${Math.floor(rng() * count)}`;
      const to = `f${Math.floor(rng() * count)}`;
      edges.push(rng() < 0.1 ? { from, to, label: String(1 + Math.floor(rng() * 5)) } : { from, to });
    }
    edges.push({ from: "f0", to: "ext:nonexistent" }); // must be dropped, not crash
    return { nodes, edges };
  }

  function nestedTree(rng: () => number, maxDepth: number): { nodes: SplitNode[]; edges: GraphEdge[] } {
    const nodes: SplitNode[] = [];
    function walk(depth: number, segments: string[]): void {
      const fileCount = Math.floor(rng() * 6);
      const dir = segments.join("/");
      for (let i = 0; i < fileCount; i++) {
        nodes.push({ id: `n${nodes.length}`, label: `file${nodes.length}.ts`, dir });
      }
      if (depth >= maxDepth) return;
      const branch = 1 + Math.floor(rng() * 4);
      for (let b = 0; b < branch; b++) walk(depth + 1, [...segments, `d${depth}_${b}`]);
    }
    walk(0, []);
    const edges: GraphEdge[] = [];
    for (let i = 0; i < nodes.length; i++) {
      if (rng() < 0.3) {
        const other = nodes[Math.floor(rng() * nodes.length)];
        const self = nodes[i];
        if (other && self) edges.push({ from: self.id, to: other.id });
      }
    }
    return { nodes, edges };
  }

  test("300 flat files: every diagram has at most maxNodes nodes", () => {
    const rng = mulberry32(0xc0ffee);
    const { nodes, edges } = flatFiles(300, rng);
    for (const maxNodes of [25, 7, 1]) {
      assertNodeCap(splitDiagram(".", nodes, edges, maxNodes), maxNodes);
    }
  });

  test("a 6-level nested tree: every diagram has at most maxNodes nodes", () => {
    for (const seed of [1, 2, 3, 42, 999, 123456]) {
      const rng = mulberry32(seed);
      const { nodes, edges } = nestedTree(rng, 6);
      for (const maxNodes of [25, 5]) {
        assertNodeCap(splitDiagram(".", nodes, edges, maxNodes), maxNodes);
      }
    }
  });

  test("more distinct top-level groups than fit in one overview still respects the cap", () => {
    const nodes: SplitNode[] = [];
    for (let i = 0; i < 40; i++) nodes.push({ id: `g${i}_f`, label: "f.ts", dir: `g${i}` });
    const diagrams = splitDiagram(".", nodes, [], 10);
    assertNodeCap(diagrams, 10);
    const overviewPages = diagrams.filter((d) => d.title.includes("(overview"));
    expect(overviewPages.length).toBeGreaterThan(1);
  });
});

describe("tokens", () => {
  test("INDEX_TOKEN_BUDGET is 3000", () => {
    expect(INDEX_TOKEN_BUDGET).toBe(3000);
  });

  test("estimateTokens is ceil(length / 3.5)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1); // ceil(3/3.5) = 1
    expect(estimateTokens("abcdefg")).toBe(2); // ceil(7/3.5) = 2
    expect(estimateTokens("a".repeat(35))).toBe(10); // exact multiple
    expect(estimateTokens("a".repeat(36))).toBe(11);
  });

  test("estimateTokens sits exactly at the budget boundary for 10500 characters", () => {
    expect(estimateTokens("a".repeat(10500))).toBe(INDEX_TOKEN_BUDGET);
    expect(estimateTokens("a".repeat(10501))).toBeGreaterThan(INDEX_TOKEN_BUDGET);
  });
});

describe("paths", () => {
  test("packageDir slugs a scoped package name", () => {
    expect(packageDir("@tiny/core")).toBe("packages/tiny__core");
  });

  test("packageDir leaves an already-safe unscoped name unchanged", () => {
    expect(packageDir("simple-pkg")).toBe("packages/simple-pkg");
  });

  test("cardPath uses the full repo-relative path for the root package ('.')", () => {
    const root: PackageInfo = { name: "root-pkg", path: ".", source: "root" };
    expect(cardPath(root, "src/index.ts")).toBe("packages/root-pkg/modules/src/index.ts.md");
  });

  test("cardPath strips the package's own directory prefix for a nested package", () => {
    const pkg: PackageInfo = { name: "@tiny/core", path: "packages/core", source: "package.json" };
    expect(cardPath(pkg, "packages/core/src/registry.ts")).toBe("packages/tiny__core/modules/src/registry.ts.md");
  });

  test("relLink: the spec's own worked example", () => {
    expect(relLink("packages/tiny__core/modules/src/registry.ts.md", "packages/tiny__core/MAP.md")).toBe(
      "../../MAP.md",
    );
  });

  test("relLink: two artifacts in the same directory need no ../", () => {
    expect(relLink("repo/MAP.md", "repo/HOTSPOTS.md")).toBe("HOTSPOTS.md");
  });

  test("relLink: from the artifact root down into a nested package", () => {
    expect(relLink("INDEX.md", "packages/tiny__core/MAP.md")).toBe("packages/tiny__core/MAP.md");
  });

  test("relLink: between two different packages' maps", () => {
    expect(relLink("packages/tiny__core/MAP.md", "packages/tiny__render/MAP.md")).toBe("../tiny__render/MAP.md");
  });
});
