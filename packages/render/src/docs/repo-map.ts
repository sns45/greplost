/**
 * greplost:render `repo/MAP.md` (render spec "Documents", tech spec 4.2).
 *
 * The container view: an ASCII tree of package directories, the package
 * dependency diagram (auto-split when the repo has more packages than the
 * node cap allows), and the package table.
 */

import type { PackageInfo } from "@greplost/core/schema";
import { compareStrings } from "@greplost/core/schema";

import { renderTree } from "../ascii.ts";
import type { GraphEdge } from "../mermaid.ts";
import { mermaidId, renderGraph } from "../mermaid.ts";
import type { DocContext } from "../render.ts";
import { packageDir, relLink } from "../slug.ts";
import type { SplitNode } from "../split.ts";
import { splitDiagram } from "../split.ts";

const REPO_MAP_ARTIFACT = "repo/MAP.md";

/**
 * Mermaid ids for package nodes, assigned in sorted `raw` order (the plain
 * package name) so adding a package never renumbers an existing node.
 */
export function packageNodeIds(packages: readonly PackageInfo[]): Map<string, string> {
  const taken = new Set<string>();
  const ids = new Map<string, string>();
  for (const name of packages.map((p) => p.name).sort(compareStrings)) {
    ids.set(name, mermaidId(name, taken));
  }
  return ids;
}

/** ASCII tree of package directories, each annotated with its package name. */
export function packageTree(packages: readonly PackageInfo[], depth = Number.POSITIVE_INFINITY): string {
  const nameByPath = new Map<string, string>();
  for (const pkg of packages) nameByPath.set(pkg.path, pkg.name);
  const paths = new Set<string>();
  for (const pkg of packages) {
    const segments = pkg.path.split("/");
    paths.add(segments.slice(0, Math.max(1, Math.min(segments.length, depth))).join("/"));
  }
  return renderTree([...paths].sort(compareStrings), { annotate: (path) => nameByPath.get(path) ?? "" });
}

export function buildRepoMap(ctx: DocContext): string {
  const blocks: string[] = [`# ${ctx.rootName}: package map`, ctx.generatedLine];

  blocks.push("## Package tree", fence(packageTree(ctx.packages)));

  blocks.push("## Package dependencies", ...dependencyDiagrams(ctx));

  blocks.push("## Packages", packagesTable(ctx));

  return `${blocks.map((b) => b.replace(/\n+$/, "")).join("\n\n")}\n`;
}

function fence(body: string): string {
  return `\`\`\`text\n${body}\n\`\`\``;
}

function dependencyDiagrams(ctx: DocContext): string[] {
  if (ctx.packages.length === 0) return ["None."];

  const ids = packageNodeIds(ctx.packages);
  const nodes: SplitNode[] = ctx.packages.map((pkg) => ({
    id: ids.get(pkg.name) ?? pkg.name,
    label: pkg.name,
    dir: pkg.path,
  }));
  const edges: GraphEdge[] = [];
  for (const edge of ctx.snapshot.metrics.packageEdges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    // A package never depends on itself; a self-edge would only ever be noise.
    if (from === undefined || to === undefined || from === to) continue;
    edges.push(edge.count > 1 ? { from, to, label: String(edge.count) } : { from, to });
  }

  const diagrams = splitDiagram(".", nodes, edges, ctx.config.diagram.maxNodes);
  // A single diagram's title is the repo root ("."), which says nothing; the
  // headings only earn their place once auto-split has produced several.
  const blocks: string[] = [];
  for (const diagram of diagrams) {
    if (diagrams.length > 1) blocks.push(`### ${diagram.title}`);
    blocks.push(renderGraph(diagram.spec));
  }
  return blocks;
}

function packagesTable(ctx: DocContext): string {
  const lines = ["| Package | Path | Files | LOC | Depends on | Map |", "|---|---|---|---|---|---|"];
  for (const pkg of ctx.packages) {
    const entry = ctx.packageEntry(pkg.name);
    const deps = entry?.deps ?? [];
    const link = relLink(REPO_MAP_ARTIFACT, `${packageDir(pkg.name)}/MAP.md`);
    lines.push(
      `| ${pkg.name} | ${pkg.path} | ${entry?.files ?? 0} | ${entry?.loc ?? 0} | ` +
        `${deps.length === 0 ? "none" : deps.join(", ")} | [MAP](${link}) |`,
    );
  }
  return lines.join("\n");
}
