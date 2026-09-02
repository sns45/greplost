/**
 * Tarjan strongly connected components, iterative (repo graphs get deep enough
 * to blow a recursive implementation's stack).
 */

import { compareStrings } from "../schema.ts";

export type GraphEdges = ReadonlyArray<readonly [string, string]>;

export interface SccResult {
  /** Deduped node ids, in the order they were given. */
  nodes: string[];
  /** node id -> index into `nodes`. */
  nodeIndex: Map<string, number>;
  /** Components as node indices, in reverse topological order of the graph they were computed on. */
  components: number[][];
  /** node index -> component index. */
  componentOf: Int32Array;
}

interface Adjacency {
  /** CSR row offsets, length n + 1. */
  start: Int32Array;
  /** CSR targets. */
  targets: Int32Array;
}

function at(array: Int32Array, i: number): number {
  return array[i] ?? 0;
}

function buildAdjacency(nodeIndex: Map<string, number>, edges: GraphEdges, reverse: boolean): Adjacency {
  const n = nodeIndex.size;
  const start = new Int32Array(n + 1);
  const froms: number[] = [];
  const tos: number[] = [];
  for (const [from, to] of edges) {
    const a = nodeIndex.get(from);
    const b = nodeIndex.get(to);
    if (a === undefined || b === undefined) continue;
    const u = reverse ? b : a;
    const v = reverse ? a : b;
    froms.push(u);
    tos.push(v);
    start[u + 1] = at(start, u + 1) + 1;
  }
  for (let i = 0; i < n; i++) start[i + 1] = at(start, i + 1) + at(start, i);
  const cursor = start.slice(0, n);
  const targets = new Int32Array(froms.length);
  for (let e = 0; e < froms.length; e++) {
    const u = froms[e] ?? 0;
    const pos = at(cursor, u);
    targets[pos] = tos[e] ?? 0;
    cursor[u] = pos + 1;
  }
  return { start, targets };
}

/**
 * Components of the graph over `nodes`. Edges touching unknown nodes are
 * ignored. `reverse` walks every edge backwards, which yields the same
 * components in the order the blast-radius propagation needs.
 */
export function sccComponents(nodes: readonly string[], edges: GraphEdges, reverse = false): SccResult {
  const unique: string[] = [];
  const nodeIndex = new Map<string, number>();
  for (const node of nodes) {
    if (nodeIndex.has(node)) continue;
    nodeIndex.set(node, unique.length);
    unique.push(node);
  }
  const n = unique.length;
  const { start, targets } = buildAdjacency(nodeIndex, edges, reverse);

  const num = new Int32Array(n).fill(-1);
  const low = new Int32Array(n).fill(-1);
  const onStack = new Uint8Array(n);
  const componentOf = new Int32Array(n).fill(-1);
  const components: number[][] = [];
  const stack: number[] = [];
  const frameNode: number[] = [];
  const frameEdge: number[] = [];
  let counter = 0;

  for (let root = 0; root < n; root++) {
    if (at(num, root) !== -1) continue;
    num[root] = counter;
    low[root] = counter;
    counter += 1;
    stack.push(root);
    onStack[root] = 1;
    frameNode.push(root);
    frameEdge.push(at(start, root));

    while (frameNode.length > 0) {
      const top = frameNode.length - 1;
      const v = frameNode[top] ?? 0;
      const edge = frameEdge[top] ?? 0;
      if (edge < at(start, v + 1)) {
        frameEdge[top] = edge + 1;
        const w = at(targets, edge);
        if (at(num, w) === -1) {
          num[w] = counter;
          low[w] = counter;
          counter += 1;
          stack.push(w);
          onStack[w] = 1;
          frameNode.push(w);
          frameEdge.push(at(start, w));
        } else if (onStack[w] === 1 && at(num, w) < at(low, v)) {
          low[v] = at(num, w);
        }
        continue;
      }
      frameNode.pop();
      frameEdge.pop();
      if (frameNode.length > 0) {
        const parent = frameNode[frameNode.length - 1] ?? 0;
        if (at(low, v) < at(low, parent)) low[parent] = at(low, v);
      }
      if (at(low, v) === at(num, v)) {
        const component: number[] = [];
        for (;;) {
          const w = stack.pop();
          if (w === undefined) break;
          onStack[w] = 0;
          componentOf[w] = components.length;
          component.push(w);
          if (w === v) break;
        }
        components.push(component);
      }
    }
  }

  return { nodes: unique, nodeIndex, components, componentOf };
}

/**
 * Cycles: components of more than one node, each sorted, the list sorted by
 * first id. A self-loop is not a cycle for this purpose.
 */
export function stronglyConnected(nodes: string[], edges: GraphEdges): string[][] {
  const { nodes: unique, components } = sccComponents(nodes, edges);
  const cycles: string[][] = [];
  for (const component of components) {
    if (component.length < 2) continue;
    cycles.push(component.map((i) => unique[i] ?? "").sort(compareStrings));
  }
  cycles.sort((a, b) => compareStrings(a[0] ?? "", b[0] ?? ""));
  return cycles;
}
