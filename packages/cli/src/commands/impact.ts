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

import { impactOf } from "@greplost/core/graph";

import type { CommandContext } from "../args.ts";
import { printJson, printLine, table } from "../output.ts";
import { importPairs, loadStructure, resolveFile, toRepoRelative } from "./structure.ts";
import { dispatchWorkspace } from "./workspace.ts";

export interface ImpactResult {
  path: string;
  /** Blast radius from the manifest: the full reverse closure, never truncated. */
  radius: number;
  files: Array<{ path: string; depth: number }>;
}

export async function run(ctx: CommandContext): Promise<number> {
  const handled = await dispatchWorkspace("impact", ctx);
  if (handled !== undefined) return handled;

  const structure = loadStructure(ctx.root);
  const given = toRepoRelative(ctx.root, ctx.operands[0] as string);
  const target = resolveFile(structure.manifest, given);
  const entry = target === undefined ? undefined : structure.manifest.files[target];
  if (target === undefined || entry === undefined) {
    throw new Error(`${given} is not in the map; run \`greplost update\` or check the path`);
  }

  const depth = ctx.options.depth;
  const reached = impactOf(importPairs(structure), target);
  const files = depth === undefined ? reached : reached.filter((file) => file.depth <= depth);
  const result: ImpactResult = { path: target, radius: entry.blast, files };

  if (ctx.json) {
    printJson(result);
    return 0;
  }

  const capped = depth !== undefined && files.length < reached.length ? `, showing depth <= ${depth}` : "";
  printLine(`${result.path}  blast radius ${result.radius}${capped}`);
  if (files.length === 0) {
    printLine();
    printLine("nothing imports it");
    return 0;
  }

  printLine();
  for (const line of table(["DEPTH", "FILE"], files.map((file) => [String(file.depth), file.path]))) {
    printLine(line);
  }
  return 0;
}
