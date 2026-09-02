/**
 * greplost:render `INDEX.md` (render spec "Documents" and "Token budget",
 * tech spec metric M1).
 *
 * The entry point an agent reads first, and the one artifact with a hard size
 * contract: `estimateTokens(text) <= INDEX_TOKEN_BUDGET` for *any* input.
 *
 * `buildIndex` renders the richest document that fits, trying candidates in the
 * spec's degradation order: (1) cut the package table to the top K packages by
 * LOC, K from all down to 10; (2) limit the tree; (3) drop the hotspot lists.
 * Step 2 is generalised past the spec's literal "depth 2", because a depth-2
 * tree still holds one line per package in the usual `packages/<name>` layout,
 * so a 500-package repo blows the budget with every documented step spent: the
 * tree is limited to depth 2, then depth 1, then truncated to a line count,
 * before the hotspot lists are touched. Two further backstops (a table floor
 * below 10, down to 0) make the postcondition hold for any input at all.
 */

import type { PackageInfo } from "@greplost/core/schema";
import { compareStrings } from "@greplost/core/schema";

import type { DocContext } from "../render.ts";
import { packageDir, relLink } from "../slug.ts";
import { INDEX_TOKEN_BUDGET, estimateTokens } from "../tokens.ts";
import { packageTree } from "./repo-map.ts";
import { topByBlast, topByFanIn } from "./hotspots.ts";

const INDEX_ARTIFACT = "INDEX.md";

/** Entries in each of the two INDEX hotspot bullets. */
const HOTSPOT_LIMIT = 5;

/** The floor the spec gives for the package table: "K from all down to 10". */
const TABLE_FLOOR = 10;

const AGENT_LINE =
  "> Read this file first. `greplost query <symbol|path> --json` and " +
  "`greplost impact <path> --json` answer structural questions in one call; " +
  "module cards under packages/<pkg>/modules/ are one per source file.";

interface IndexOptions {
  /** Packages listed in the table (the top K by LOC), the rest summarised in one line. */
  topK: number;
  /** Package-tree depth, in path segments. */
  treeDepth: number;
  /** Package-tree lines kept, the rest summarised in one line. */
  treeMaxLines: number;
  /** Whether the two hotspot rankings are listed. */
  hotspots: boolean;
}

const UNLIMITED = Number.POSITIVE_INFINITY;

export function buildIndex(ctx: DocContext): string {
  const total = ctx.packages.length;
  const full: IndexOptions = { topK: total, treeDepth: UNLIMITED, treeMaxLines: UNLIMITED, hotspots: true };
  const fits = (options: IndexOptions): boolean => estimateTokens(render(ctx, options)) <= INDEX_TOKEN_BUDGET;

  if (fits(full)) return render(ctx, full);

  // (1) Cut the package table to the top K packages by LOC, K from all down to
  // 10. `fits` is monotone in K (fewer rows is never longer), so the largest
  // surviving K is a binary search rather than a linear walk down from `total`.
  const floor = Math.min(total, TABLE_FLOOR);
  const byK = largestThatFits(floor, total - 1, (k) => fits({ ...full, topK: k }));
  if (byK !== undefined) return render(ctx, { ...full, topK: byK });

  // (2) Limit the tree: depth 2 as the spec says, then depth 1, then a line
  // count. Every one of these is still the tree step, so the hotspot lists are
  // only reached once the tree has nothing left to give.
  const cut: IndexOptions = { ...full, topK: floor };
  for (const treeDepth of [2, 1]) {
    if (fits({ ...cut, treeDepth })) return render(ctx, { ...cut, treeDepth });
  }
  const flat: IndexOptions = { ...cut, treeDepth: 1 };
  const byLines = largestThatFits(0, treeLineCount(ctx, flat), (l) => fits({ ...flat, treeMaxLines: l }));
  if (byLines !== undefined) return render(ctx, { ...flat, treeMaxLines: byLines });

  // (3) Drop the hotspot lists.
  const bare: IndexOptions = { ...flat, treeMaxLines: 0, hotspots: false };
  if (fits(bare)) return render(ctx, bare);

  // Backstop: the table below its documented floor of 10, down to nothing.
  const byFloor = largestThatFits(0, Math.max(0, floor - 1), (k) => fits({ ...bare, topK: k }));
  return render(ctx, { ...bare, topK: byFloor ?? 0 });
}

/** Largest value in [low, high] satisfying the monotone predicate, or undefined. */
function largestThatFits(low: number, high: number, ok: (value: number) => boolean): number | undefined {
  if (high < low || !ok(low)) return undefined;
  let best = low;
  let lo = low + 1;
  let hi = high;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function treeLineCount(ctx: DocContext, options: IndexOptions): number {
  const tree = packageTree(ctx.packages, options.treeDepth);
  return tree === "" ? 0 : tree.split("\n").length;
}

function render(ctx: DocContext, options: IndexOptions): string {
  const blocks: string[] = [`# ${ctx.rootName} map`, `${ctx.generatedLine}\n${AGENT_LINE}`];

  blocks.push(`## Packages (${ctx.packages.length})`, treeBlock(ctx, options));
  blocks.push(...tableBlocks(ctx, options));
  blocks.push("## Hotspots", hotspotList(ctx, options));
  blocks.push("## Navigation", navigation());

  return `${blocks.map((b) => b.replace(/\n+$/, "")).join("\n\n")}\n`;
}

function treeBlock(ctx: DocContext, options: IndexOptions): string {
  const tree = packageTree(ctx.packages, options.treeDepth);
  const lines = tree === "" ? [] : tree.split("\n");
  const kept = lines.slice(0, Math.max(0, Math.min(lines.length, options.treeMaxLines)));
  if (kept.length < lines.length) {
    kept.push(`… ${lines.length - kept.length} more directories, see repo/MAP.md`);
  }
  return kept.length === 0 ? "```text\n```" : `\`\`\`text\n${kept.join("\n")}\n\`\`\``;
}

function tableBlocks(ctx: DocContext, options: IndexOptions): string[] {
  const total = ctx.packages.length;
  const shown = topPackagesByLoc(ctx, options.topK);
  const lines = [
    "| Package | Path | Files | LOC | Deps | Fan-in | Fan-out | Map |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const pkg of shown) {
    const entry = ctx.packageEntry(pkg.name);
    const link = relLink(INDEX_ARTIFACT, `${packageDir(pkg.name)}/MAP.md`);
    lines.push(
      `| ${pkg.name} | ${pkg.path} | ${entry?.files ?? 0} | ${entry?.loc ?? 0} | ` +
        `${ctx.externalsOf.get(pkg.name)?.length ?? 0} | ${entry?.rdeps.length ?? 0} | ` +
        `${entry?.deps.length ?? 0} | [MAP](${link}) |`,
    );
  }
  const blocks = [lines.join("\n")];
  if (shown.length < total) {
    blocks.push(`… and ${total - shown.length} more packages, see repo/MAP.md`);
  }
  return blocks;
}

/** The `topK` packages by LOC (ties by path), listed back in path order. */
function topPackagesByLoc(ctx: DocContext, topK: number): PackageInfo[] {
  if (topK >= ctx.packages.length) return ctx.packages;
  const byLoc = [...ctx.packages].sort(
    (a, b) =>
      (ctx.packageEntry(b.name)?.loc ?? 0) - (ctx.packageEntry(a.name)?.loc ?? 0) ||
      compareStrings(a.path, b.path),
  );
  return byLoc.slice(0, Math.max(0, topK)).sort((a, b) => compareStrings(a.path, b.path));
}

function hotspotList(ctx: DocContext, options: IndexOptions): string {
  const lines: string[] = [];
  if (options.hotspots) {
    const imported = topByFanIn(ctx, HOTSPOT_LIMIT).map((r) => `\`${r.file}\` (fan-in ${r.entry.fanIn})`);
    const blast = topByBlast(ctx, HOTSPOT_LIMIT).map(
      (r) => `\`${r.file}\` (${r.entry.blast} file${r.entry.blast === 1 ? "" : "s"})`,
    );
    lines.push(`- Most imported: ${imported.length === 0 ? "None." : imported.join(", ")}`);
    lines.push(`- Largest blast radius: ${blast.length === 0 ? "None." : blast.join(", ")}`);
  }
  lines.push(
    `- Import cycles: ${ctx.snapshot.metrics.cycles.length}, see [repo/HOTSPOTS.md](repo/HOTSPOTS.md)`,
  );
  return lines.join("\n");
}

function navigation(): string {
  return [
    "- [repo/MAP.md](repo/MAP.md): package tree and dependency diagram",
    "- [repo/HOTSPOTS.md](repo/HOTSPOTS.md): god nodes, blast radii, cycles",
    "- Package maps: packages/<pkg>/MAP.md, APIs: packages/<pkg>/API.md, cards: packages/<pkg>/modules/<file>.md",
  ].join("\n");
}
