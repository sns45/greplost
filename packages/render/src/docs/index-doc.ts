/**
 * greplost:render `INDEX.md` (render spec "Documents" and "Token budget",
 * tech spec metric M1).
 *
 * The entry point an agent reads first, and the one artifact with a hard size
 * contract: `estimateTokens(text) <= INDEX_TOKEN_BUDGET` for *any* input.
 *
 * `buildIndex` renders the richest document that fits. The degradation order is
 * the spec's: (1) cut the package table to the top K packages by LOC, K from
 * all down to 10; (2) limit the tree to depth 2, then depth 1, then drop it;
 * (3) drop the hotspot lists. Each step re-maximises K against the smaller
 * document, so the largest K that fits is always the one used (ruling
 * 2026-09-02), pinning K at the floor of 10 once the tree was cut left a
 * 501-package INDEX using 652 of its 3000 tokens. A final backstop takes the
 * table below its floor of 10, down to 0, so the postcondition holds for any
 * input at all.
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

/**
 * Every path template is inside backticks: repository Markdown runs bare
 * `<pkg>` through the HTML sanitizer, which strips it as an unknown tag
 * (render spec, GitHub rendering rule).
 */
const AGENT_LINE =
  "> Read this file first. `greplost query <symbol|path> --json` and " +
  "`greplost impact <path> --json` answer structural questions in one call; " +
  "module cards under `packages/<pkg>/modules/` are one per source file.";

interface IndexOptions {
  /** Packages listed in the table (the top K by LOC), the rest summarised in one line. */
  topK: number;
  /** Package-tree depth in path segments; `NO_TREE` drops the tree entirely. */
  treeDepth: number;
  /** Whether the two hotspot rankings are listed. */
  hotspots: boolean;
}

const UNLIMITED = Number.POSITIVE_INFINITY;

/** `treeDepth` value that omits the package tree altogether. */
const NO_TREE = 0;

/** Degradation states, richest first. Within each, K is maximised separately. */
const TREE_STEPS: readonly number[] = [UNLIMITED, 2, 1, NO_TREE];

export function buildIndex(ctx: DocContext): string {
  const total = ctx.packages.length;
  const fits = (options: IndexOptions): boolean => estimateTokens(render(ctx, options)) <= INDEX_TOKEN_BUDGET;
  // `fits` is monotone in K (fewer rows is never longer text), so the largest
  // surviving K is a binary search rather than a linear walk down from `total`.
  const floor = Math.min(total, TABLE_FLOOR);
  const maximiseK = (state: Omit<IndexOptions, "topK">, low: number, high: number): IndexOptions | undefined => {
    const topK = largestThatFits(low, high, (k) => fits({ ...state, topK: k }));
    return topK === undefined ? undefined : { ...state, topK };
  };

  // (1) and (2): the table down to its floor of 10, then the tree to depth 2,
  // depth 1 and gone, re-maximising K against each smaller tree. (3) The
  // hotspot lists go last, and K is re-maximised once more without them.
  for (const hotspots of [true, false]) {
    for (const treeDepth of TREE_STEPS) {
      const options = maximiseK({ treeDepth, hotspots }, floor, total);
      if (options !== undefined) return render(ctx, options);
    }
  }

  // Backstop: the table below its documented floor of 10, down to nothing.
  const bare = { treeDepth: NO_TREE, hotspots: false };
  const options = maximiseK(bare, 0, Math.max(0, floor - 1));
  return render(ctx, options ?? { ...bare, topK: 0 });
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

function render(ctx: DocContext, options: IndexOptions): string {
  const blocks: string[] = [`# ${ctx.rootName} map`, `${ctx.generatedLine}\n${AGENT_LINE}`];

  blocks.push(`## Packages (${ctx.packages.length})`);
  const tree = treeBlock(ctx, options);
  if (tree !== undefined) blocks.push(tree);
  blocks.push(...tableBlocks(ctx, options));
  blocks.push("## Hotspots", hotspotList(ctx, options));
  blocks.push("## Navigation", navigation());

  return `${blocks.map((b) => b.replace(/\n+$/, "")).join("\n\n")}\n`;
}

/** The package tree, or undefined once the budget has spent the whole tree step. */
function treeBlock(ctx: DocContext, options: IndexOptions): string | undefined {
  if (options.treeDepth === NO_TREE) return undefined;
  const tree = packageTree(ctx.indexedPackages, options.treeDepth);
  return tree === "" ? undefined : `\`\`\`text\n${tree}\n\`\`\``;
}

function tableBlocks(ctx: DocContext, options: IndexOptions): string[] {
  const total = ctx.packages.length;
  const shown = topPackagesByLoc(ctx, options.topK);
  // Schema 2: one extra column, and only for a repo that actually has non-file
  // nodes. A repo with none renders the table build 1 rendered, byte for byte,
  // so the M1 token budget is unaffected for every existing user (spec 4.4).
  const withNodes = ctx.nodesOf.size > 0;
  const lines = withNodes
    ? [
        "| Package | Path | Files | LOC | Nodes | Deps | Fan-in | Fan-out | Map |",
        "|---|---|---|---|---|---|---|---|---|",
      ]
    : [
        "| Package | Path | Files | LOC | Deps | Fan-in | Fan-out | Map |",
        "|---|---|---|---|---|---|---|---|",
      ];
  for (const pkg of shown) {
    const entry = ctx.packageEntry(pkg.name);
    const link = relLink(INDEX_ARTIFACT, `${packageDir(pkg.name)}/MAP.md`);
    const nodes = withNodes ? `${nodeCount(ctx, pkg.name)} | ` : "";
    lines.push(
      `| ${pkg.name} | ${pkg.path} | ${entry?.files ?? 0} | ${entry?.loc ?? 0} | ${nodes}` +
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

/** Non-file nodes declared across one package's files. */
function nodeCount(ctx: DocContext, pkgName: string): number {
  let total = 0;
  for (const file of ctx.filesByPackage.get(pkgName) ?? []) total += (ctx.nodesOf.get(file) ?? []).length;
  return total;
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
    "- Package maps: `packages/<pkg>/MAP.md`, APIs: `packages/<pkg>/API.md`, " +
      "cards: `packages/<pkg>/modules/<file>.md`",
  ].join("\n");
}
