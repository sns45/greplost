/**
 * greplost:render `packages/<slug>/MAP.md` (render spec "Documents", tech spec 4.2).
 *
 * The component view of one package: its header stats, the module tree, the
 * per-module metric table, the intra-package import diagrams (auto-split at
 * `config.diagram.maxNodes`) and the external packages it pulls in.
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

export function buildPackageMap(ctx: DocContext, pkg: PackageInfo): string {
  const entry = ctx.packageEntry(pkg.name);
  const files = ctx.filesByPackage.get(pkg.name) ?? [];
  const self = `${packageDir(pkg.name)}/MAP.md`;

  const deps = entry?.deps ?? [];
  const rdeps = entry?.rdeps ?? [];
  const header =
    `Path: \`${pkg.path}\` · ${entry?.files ?? files.length} files · ${entry?.loc ?? 0} LOC · ` +
    `depends on: ${deps.length === 0 ? "none" : deps.join(", ")} · ` +
    `depended on by: ${rdeps.length === 0 ? "none" : rdeps.join(", ")}`;

  const blocks: string[] = [`# ${pkg.name}`, ctx.generatedLine, header];

  blocks.push("## Modules", files.length === 0 ? "None." : fence(moduleTree(pkg, files)));
  blocks.push("## Module table", moduleTable(ctx, pkg, files, self));
  blocks.push("## Components", ...componentDiagrams(ctx, pkg, files));
  blocks.push("## External dependencies", externalDependencies(ctx, pkg));

  return `${blocks.map((b) => b.replace(/\n+$/, "")).join("\n\n")}\n`;
}

function fence(body: string): string {
  return `\`\`\`text\n${body}\n\`\`\``;
}

/** A file's path relative to its package directory; the root package keeps the full path. */
export function relativeToPackage(pkg: PackageInfo, file: string): string {
  if (pkg.path === ".") return file;
  const prefix = `${pkg.path}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

function moduleTree(pkg: PackageInfo, files: readonly string[]): string {
  return renderTree(files.map((file) => relativeToPackage(pkg, file)));
}

function moduleTable(ctx: DocContext, pkg: PackageInfo, files: readonly string[], self: string): string {
  if (files.length === 0) return "None.";
  const lines = ["| File | LOC | Exports | Fan-in | Fan-out | Blast |", "|---|---|---|---|---|---|"];
  for (const file of files) {
    const entry = ctx.fileEntry(file);
    const rel = relativeToPackage(pkg, file);
    const card = ctx.cardPathOf(file);
    const label = card === undefined ? `\`${rel}\`` : `[\`${rel}\`](${relLink(self, card)})`;
    lines.push(
      `| ${label} | ${entry?.loc ?? 0} | ${entry?.exports.length ?? 0} | ` +
        `${entry?.fanIn ?? 0} | ${entry?.fanOut ?? 0} | ${entry?.blast ?? 0} |`,
    );
  }
  return lines.join("\n");
}

/**
 * One or more diagrams of the package's own modules and the import/re-export
 * edges between them. Node ids come from `mermaidId(<repo path>)` assigned in
 * sorted path order; labels are the file's basename, per the Mermaid rule.
 *
 * The diagram root is the package's path, except for the root package, whose
 * path is "." — a title of `.` says nothing, and every non-monorepo has exactly
 * one such package, so the root package titles its diagrams with its name. The
 * root only feeds titles and the synthetic overview node ids; grouping is
 * driven by each node's `dir`, so nothing else changes. Titles are only
 * rendered as headings once there is more than one diagram to tell apart.
 */
function componentDiagrams(ctx: DocContext, pkg: PackageInfo, files: readonly string[]): string[] {
  if (files.length === 0) return ["None."];

  const taken = new Set<string>();
  const ids = new Map<string, string>();
  for (const file of [...files].sort(compareStrings)) ids.set(file, mermaidId(file, taken));

  const nodes: SplitNode[] = files.map((file) => {
    const rel = relativeToPackage(pkg, file);
    const slash = rel.lastIndexOf("/");
    return {
      id: ids.get(file) ?? file,
      label: rel.slice(slash + 1),
      dir: slash === -1 ? "" : rel.slice(0, slash),
    };
  });

  const counts = new Map<string, Map<string, number>>();
  for (const file of files) {
    for (const edge of ctx.importsFrom.get(file) ?? []) {
      const from = ids.get(edge.from);
      const to = ids.get(edge.to);
      if (from === undefined || to === undefined || from === to) continue;
      let inner = counts.get(from);
      if (inner === undefined) {
        inner = new Map<string, number>();
        counts.set(from, inner);
      }
      inner.set(to, (inner.get(to) ?? 0) + 1);
    }
  }
  const edges: GraphEdge[] = [];
  for (const [from, inner] of counts) {
    for (const [to, count] of inner) {
      edges.push(count > 1 ? { from, to, label: String(count) } : { from, to });
    }
  }

  const root = pkg.path === "." ? pkg.name : pkg.path;
  const diagrams = splitDiagram(root, nodes, edges, ctx.config.diagram.maxNodes);
  // Headings only once auto-split produced several diagrams, matching
  // `## Package dependencies`: a sole title just restates the package path the
  // header line already gives.
  const blocks: string[] = [];
  for (const diagram of diagrams) {
    if (diagrams.length > 1) blocks.push(`### ${diagram.title}`);
    blocks.push(renderGraph(diagram.spec));
  }
  return blocks;
}

function externalDependencies(ctx: DocContext, pkg: PackageInfo): string {
  const externals = ctx.externalsOf.get(pkg.name) ?? [];
  if (externals.length === 0) return "None.";
  return externals.map((name) => `- \`${name}\``).join("\n");
}
