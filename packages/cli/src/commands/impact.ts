/**
 * `greplost impact <path>` (tech spec 9, plugin-cli spec "--json shapes").
 *
 * "If I change this file, what can break?" answered from the committed import
 * graph: every file that transitively imports the target, with the number of
 * hops it took to get there. `radius` is the manifest's blast figure for the
 * file, so the number a card shows and the number this command prints are the
 * same number by construction. `--depth` truncates the listing, never the
 * radius, because a truncated radius would silently understate the risk.
 *
 * Directory targets are expanded on the way in (a Go import names a package),
 * so a Go map answers this question as well as a TypeScript one.
 */

import { impactOf, impactPairs } from "@greplost/core/graph";

import type { CommandContext } from "../args.ts";
import { printJson, printLine, table } from "../output.ts";
import { importPairs, loadStructure, resolveFile, resolveNode, toRepoRelative } from "./structure.ts";
import { dispatchWorkspace } from "./workspace.ts";

/**
 * A file target, unchanged since build 1: `files`, and never a `nodes` key, so
 * no existing JSON consumer breaks when a repo starts holding nodes.
 */
export interface ImpactFiles {
  path: string;
  /** Blast radius from the manifest: the full reverse closure, never truncated. */
  radius: number;
  files: Array<{ path: string; depth: number }>;
}

/**
 * A non-file node target (schema 2): the same two fields, and `nodes` in place
 * of `files`. `radius` is the reverse closure over `impactPairs` — import,
 * re-export and reference edges together — which is the figure the node card
 * prints, because a node has no manifest entry to read one from.
 */
export interface ImpactNodes {
  path: string;
  radius: number;
  nodes: Array<{ id: string; depth: number }>;
}

export type ImpactResult = ImpactFiles | ImpactNodes;

export async function run(ctx: CommandContext): Promise<number> {
  const handled = await dispatchWorkspace("impact", ctx);
  if (handled !== undefined) return handled;

  const structure = loadStructure(ctx.root);
  const operand = ctx.operands[0] as string;
  const given = toRepoRelative(ctx.root, operand);
  // `resolveFile` first and still first; a node id is tried only when no file
  // answered, and it can never be mistaken for one (`looksLikePath` rejects a
  // candidate holding a `#`).
  const target = resolveFile(structure.manifest, given);
  const entry = target === undefined ? undefined : structure.manifest.files[target];
  const node = target === undefined ? resolveNode(structure, operand) : undefined;
  if ((target === undefined || entry === undefined) && node === undefined) {
    throw new Error(`${given} is not in the map; run \`greplost update\` or check the path`);
  }

  const depth = ctx.options.depth;
  const isNode = node !== undefined;
  // A node has no manifest entry to read a blast figure from, so its radius is
  // computed here, over the mixed graph, and never truncated by `--depth`.
  const reached = isNode ? impactOf(impactPairs(structure), node.id) : impactOf(importPairs(structure), target as string);
  const shown = depth === undefined ? reached : reached.filter((hit) => hit.depth <= depth);
  const result: ImpactResult = isNode
    ? {
        path: node.id,
        radius: reached.length,
        nodes: shown.map((hit) => ({ id: hit.path, depth: hit.depth })),
      }
    : { path: target as string, radius: entry?.blast ?? 0, files: shown };

  if (ctx.json) {
    printJson(result);
    return 0;
  }

  const capped = depth !== undefined && shown.length < reached.length ? `, showing depth <= ${depth}` : "";
  printLine(`${result.path}  blast radius ${result.radius}${capped}`);
  if (shown.length === 0) {
    printLine();
    printLine(isNode ? "nothing references it" : "nothing imports it");
    return 0;
  }

  printLine();
  const rows = shown.map((hit) => [String(hit.depth), hit.path]);
  for (const line of table(["DEPTH", isNode ? "NODE" : "FILE"], rows)) {
    printLine(line);
  }
  return 0;
}
