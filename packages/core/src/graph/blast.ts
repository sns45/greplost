/**
 * Blast radius: how many files a change to a file can reach, i.e. the size of
 * the reverse transitive closure of the import graph.
 *
 * The closure is computed once for every strongly connected component of the
 * reversed graph, as a bitset over node indices propagated in topological
 * order. That is O((V + E) * V / 32) words of work instead of a BFS per node,
 * at a cost of components * ceil(V / 32) words of memory (worst case V^2 / 8
 * bytes: ~50 MB for a 20k-file repo, which is the scale v1 targets).
 */

import { compareStrings } from "../schema.ts";
import type { GraphEdges } from "./tarjan.ts";
import { sccComponents } from "./tarjan.ts";

function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * Reverse transitive closure size per node, excluding the node itself. Edges
 * point importer -> imported, so the closure of a file is everything that
 * transitively imports it. Edges touching unknown nodes are ignored.
 */
export function blastRadius(nodes: string[], edges: GraphEdges): Map<string, number> {
  // Reversed: components come out in an order where every successor of a
  // component has already been finished.
  const scc = sccComponents(nodes, edges, true);
  const n = scc.nodes.length;
  const radius = new Map<string, number>();
  if (n === 0) return radius;

  const componentCount = scc.components.length;
  const words = (n + 31) >>> 5;
  const bits = new Uint32Array(componentCount * words);

  // Successors in the reversed graph, at component level. Deduped: many file
  // edges collapse onto the same component pair, and each union is O(words).
  const successors: Array<Set<number>> = [];
  for (let c = 0; c < componentCount; c++) successors.push(new Set<number>());
  for (const [from, to] of edges) {
    const a = scc.nodeIndex.get(from);
    const b = scc.nodeIndex.get(to);
    if (a === undefined || b === undefined) continue;
    const source = scc.componentOf[b] ?? -1;
    const target = scc.componentOf[a] ?? -1;
    if (source === -1 || target === -1 || source === target) continue;
    successors[source]?.add(target);
  }

  for (let c = 0; c < componentCount; c++) {
    const base = c * words;
    for (const member of scc.components[c] ?? []) {
      bits[base + (member >>> 5)] = (bits[base + (member >>> 5)] ?? 0) | (1 << (member & 31));
    }
    // Successors are finished components, so one union each is enough.
    for (const successor of successors[c] ?? []) {
      const other = successor * words;
      for (let w = 0; w < words; w++) bits[base + w] = (bits[base + w] ?? 0) | (bits[other + w] ?? 0);
    }
  }

  const sizes = new Int32Array(componentCount);
  for (let c = 0; c < componentCount; c++) {
    const base = c * words;
    let total = 0;
    for (let w = 0; w < words; w++) total += popcount32(bits[base + w] ?? 0);
    sizes[c] = total;
  }

  for (let i = 0; i < n; i++) {
    const component = scc.componentOf[i] ?? -1;
    const size = component === -1 ? 1 : (sizes[component] ?? 1);
    radius.set(scc.nodes[i] ?? "", size - 1);
  }
  return radius;
}

/**
 * Every file that transitively imports `target`, with the number of import hops
 * to reach it, sorted by (depth, path). The target itself is never listed.
 */
export function impactOf(edges: GraphEdges, target: string): Array<{ path: string; depth: number }> {
  const importers = new Map<string, string[]>();
  for (const [from, to] of edges) {
    const list = importers.get(to);
    if (list === undefined) importers.set(to, [from]);
    else list.push(from);
  }

  const seen = new Set<string>([target]);
  const out: Array<{ path: string; depth: number }> = [];
  let frontier = [target];
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];
    for (const node of frontier) {
      for (const importer of importers.get(node) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        out.push({ path: importer, depth });
        next.push(importer);
      }
    }
    frontier = next;
  }
  out.sort((a, b) => a.depth - b.depth || compareStrings(a.path, b.path));
  return out;
}
