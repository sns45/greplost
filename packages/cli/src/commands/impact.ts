/**
 * `greplost impact <path|node-id>` (tech spec 9, plugin-cli spec "--json shapes").
 *
 * **The two radii are different questions and are counted differently.** A
 * *file*'s radius counts **files**, over import and re-export edges only, and is
 * read straight from the manifest. A *node*'s radius counts **nodes**, over
 * import, re-export **and reference** edges together (`impactPairs`), and is
 * computed here because a node has no manifest entry. A Terraform variable that
 * forty resources read has a large node radius and its file may still have a
 * file radius of zero; both numbers are right.
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
import { statusOf } from "./status.ts";
import type { QueryStatus } from "./status.ts";
import { importPairs, loadStructure, resolveFile, resolveNode, toRepoRelative } from "./structure.ts";
import { nearestIds } from "./suggest.ts";
import { dispatchWorkspace } from "./workspace.ts";

/**
 * A file target, unchanged since build 1: `files`, and never a `nodes` key, so
 * no existing JSON consumer breaks when a repo starts holding nodes.
 */
export interface ImpactFiles {
  path: string;
  /** Blast radius from the manifest: the full reverse closure, never truncated. */
  radius: number;
  /** How many entries the listing below actually holds (leaf 2.15). */
  returned: number;
  /** True when `--depth` kept entries out of the listing; `radius` still counts them. */
  truncated: boolean;
  files: Array<{ path: string; depth: number }>;
}

/**
 * A non-file node target (schema 2): the same two fields, and `nodes` in place
 * of `files`. `radius` is the reverse closure over `impactPairs`, import,
 * re-export and reference edges together, which is the figure the node card
 * prints, because a node has no manifest entry to read one from.
 */
export interface ImpactNodes {
  path: string;
  radius: number;
  returned: number;
  truncated: boolean;
  nodes: Array<{ id: string; depth: number }>;
}

/**
 * What `--json` prints when the target is not in the map (fix round 1): the
 * miss half of `query`'s envelope, so one parser reads both. There is no
 * `radius` and no listing, because there is no answer; `status` says why, in
 * the same four words `query` uses.
 */
export interface ImpactMiss {
  path: string;
  status: QueryStatus;
  message: string;
  suggestions: string[];
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
    // The same four statuses `query` reports, for the same reason: "run
    // `greplost update`" is the right advice for exactly one of them, and was
    // being given for all four (leaf 2.15).
    const verdict = statusOf(ctx.root, structure.manifest, operand.includes("#") ? "" : given, false, operand);
    const nearest = nearestIds(structure, operand);
    // `--json` answers in JSON even when it cannot answer (fix round 1): a
    // caller that asked for a document should not have to parse English off
    // stderr to learn whether the map is stale or the path was a typo.
    if (ctx.json) {
      const miss: ImpactMiss = {
        path: given,
        status: verdict.status,
        message: verdict.message ?? `${given} is not in the map`,
        suggestions: nearest,
      };
      printJson(miss);
      return 1;
    }
    const hint = nearest.length === 0 ? "" : `; did you mean: ${nearest.join(", ")}`;
    throw new Error(`${verdict.message ?? `${given} is not in the map`}${hint}`);
  }

  const depth = ctx.options.depth;
  const isNode = node !== undefined;
  // A node has no manifest entry to read a blast figure from, so its radius is
  // computed here, over the mixed graph, and never truncated by `--depth`.
  const reached = isNode ? impactOf(impactPairs(structure), node.id) : impactOf(importPairs(structure), target as string);
  const shown = depth === undefined ? reached : reached.filter((hit) => hit.depth <= depth);
  // `radius` counts the whole closure and `returned` counts the listing; the
  // evaluation read 16 listed entries beside a radius of 129 and could not tell
  // whether the radius was a second, larger listing it had not been shown.
  const radius = isNode ? reached.length : (entry?.blast ?? 0);
  const counts = { returned: shown.length, truncated: shown.length < reached.length };
  const result: ImpactResult = isNode
    ? {
        path: node.id,
        radius,
        ...counts,
        nodes: shown.map((hit) => ({ id: hit.path, depth: hit.depth })),
      }
    : { path: target as string, radius, ...counts, files: shown };

  if (ctx.json) {
    printJson(result);
    return 0;
  }

  const capped = counts.truncated ? `, showing depth <= ${depth}` : "";
  printLine(`${result.path}  blast radius ${result.radius}${capped}`);
  if (counts.truncated) {
    printLine(
      `${counts.returned} of ${reached.length} listed; --depth bounds the listing, never the radius`,
    );
  }
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
