/**
 * greplost:render `repo/HOTSPOTS.md` (render spec "Documents", tech spec 5.2).
 *
 * Pure metrics: god nodes by fan-in, the largest blast radii, and the import
 * and package cycles. Also exports the two rankings so `INDEX.md` shows the
 * same top files as this document rather than computing its own.
 */

import type { FileEntry } from "@greplost/core/schema";
import { compareStrings } from "@greplost/core/schema";
import { stronglyConnected } from "@greplost/core/graph";

import type { DocContext } from "../render.ts";
import { relLink } from "../slug.ts";

/** Rows shown in each ranking table. */
const TABLE_LIMIT = 20;

const HOTSPOTS_ARTIFACT = "repo/HOTSPOTS.md";

export interface RankedFile {
  file: string;
  entry: FileEntry;
}

function ranked(ctx: DocContext, key: "fanIn" | "blast", limit: number): RankedFile[] {
  const rows: RankedFile[] = [];
  for (const file of ctx.files) {
    const entry = ctx.fileEntry(file);
    if (entry !== undefined) rows.push({ file, entry });
  }
  // Ties break by path, so the ranking is a total order on any snapshot.
  rows.sort((a, b) => b.entry[key] - a.entry[key] || compareStrings(a.file, b.file));
  return rows.slice(0, limit);
}

/** Top `limit` files by fan-in, ties broken by path. */
export function topByFanIn(ctx: DocContext, limit: number): RankedFile[] {
  return ranked(ctx, "fanIn", limit);
}

/** Top `limit` files by blast radius, ties broken by path. */
export function topByBlast(ctx: DocContext, limit: number): RankedFile[] {
  return ranked(ctx, "blast", limit);
}

/** `- a → b → a`: the cycle's members in order with the first repeated at the end. */
export function cycleLine(members: readonly string[]): string {
  const first = members[0] ?? "";
  return `- ${[...members, first].join(" → ")}`;
}

export function buildHotspots(ctx: DocContext): string {
  const blocks: string[] = [`# ${ctx.rootName}: hotspots`, ctx.generatedLine];

  blocks.push("## God nodes", rankingTable(ctx, topByFanIn(ctx, TABLE_LIMIT)));
  blocks.push("## Largest blast radius", rankingTable(ctx, topByBlast(ctx, TABLE_LIMIT)));

  blocks.push("## Import cycles", ...cycleBlocks(ctx.snapshot.metrics.cycles));
  blocks.push("## Package cycles", ...cycleBlocks(packageCycles(ctx)));

  return `${blocks.map((b) => b.replace(/\n+$/, "")).join("\n\n")}\n`;
}

function rankingTable(ctx: DocContext, rows: RankedFile[]): string {
  if (rows.length === 0) return "None.";
  const lines = ["| File | Fan-in | Fan-out | Blast |", "|---|---|---|---|"];
  for (const { file, entry } of rows) {
    const card = ctx.cardPathOf(file);
    const label = card === undefined ? `\`${file}\`` : `[\`${file}\`](${relLink(HOTSPOTS_ARTIFACT, card)})`;
    lines.push(`| ${label} | ${entry.fanIn} | ${entry.fanOut} | ${entry.blast} |`);
  }
  return lines.join("\n");
}

function cycleBlocks(cycles: readonly (readonly string[])[]): string[] {
  if (cycles.length === 0) return ["None."];
  const count = `${cycles.length} ${cycles.length === 1 ? "cycle" : "cycles"}`;
  return [count, cycles.map(cycleLine).join("\n")];
}

/**
 * Strongly connected components of the package graph, over the same plain
 * package names `Metrics.packageEdges` carries (never the `pkg:` node ids).
 */
function packageCycles(ctx: DocContext): string[][] {
  const names = [...ctx.packages].map((p) => p.name).sort(compareStrings);
  const edges = ctx.snapshot.metrics.packageEdges.map((e) => [e.from, e.to] as const);
  return stronglyConnected(names, edges);
}
