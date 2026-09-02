/**
 * greplost:render Mermaid emitter (tech spec 4.2, 5.3; render spec "Mermaid").
 *
 * Pure string generation, no filesystem, no dates. Renders GitHub-flavoured
 * Mermaid `graph LR|TD` flowcharts only (v1). Node/edge order and id
 * assignment are the determinism contract: the same GraphSpec always renders
 * to the same bytes, and a new node id is assigned without renumbering any
 * existing one.
 */

import { compareStrings } from "@greplost/core/schema";

export interface GraphNode {
  id: string;
  label: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface GraphSpec {
  direction: "LR" | "TD";
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Sanitises `raw` into a valid, collision-free Mermaid node id.
 *
 * Any character outside `[A-Za-z0-9_]` becomes `_`. An empty result, or one
 * starting with a digit, is prefixed with `n_`. When `taken` is given, a
 * collision with an id already in the set is resolved with a `_2`, `_3`, …
 * suffix (lowest free integer, checked in that order); the winning id is
 * added to `taken` before returning, so repeated calls against the same set
 * dedupe deterministically in call order.
 */
export function mermaidId(raw: string, taken?: Set<string>): string {
  let id = raw.replace(/[^A-Za-z0-9_]/g, "_");
  if (id === "" || /^[0-9]/.test(id)) {
    id = `n_${id}`;
  }
  if (taken) {
    if (taken.has(id)) {
      let n = 2;
      while (taken.has(`${id}_${n}`)) n++;
      id = `${id}_${n}`;
    }
    taken.add(id);
  }
  return id;
}

/**
 * Renders a GitHub-renderable Mermaid flowchart fenced code block. Nodes and
 * edges are emitted in sorted order (by id; edges by from, then to, then
 * label) regardless of input order, so the same spec always renders
 * byte-identical output. Labels are quoted and escaped: `"` becomes
 * `#quot;`, and `[ ] ( ) { }` (which would otherwise break Mermaid's node
 * shape syntax) are replaced with their decimal HTML character references.
 * The result always ends with a blank line after the closing fence.
 */
export function renderGraph(spec: GraphSpec): string {
  const nodes = [...spec.nodes].sort((a, b) => compareStrings(a.id, b.id));
  const edges = [...spec.edges].sort(
    (a, b) =>
      compareStrings(a.from, b.from) ||
      compareStrings(a.to, b.to) ||
      compareStrings(a.label ?? "", b.label ?? ""),
  );

  const lines: string[] = ["```mermaid", `graph ${spec.direction}`];
  for (const node of nodes) {
    lines.push(`  ${node.id}["${escapeLabel(node.label)}"]`);
  }
  for (const edge of edges) {
    if (edge.label !== undefined && edge.label !== "") {
      lines.push(`  ${edge.from} -->|${escapeEdgeLabel(edge.label)}| ${edge.to}`);
    } else {
      lines.push(`  ${edge.from} --> ${edge.to}`);
    }
  }
  lines.push("```");

  return `${lines.join("\n")}\n\n`;
}

const LABEL_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/"/g, "#quot;"],
  [/\[/g, "#91;"],
  [/\]/g, "#93;"],
  [/\(/g, "#40;"],
  [/\)/g, "#41;"],
  [/\{/g, "#123;"],
  [/\}/g, "#125;"],
];

function escapeLabel(label: string): string {
  let out = label;
  for (const [pattern, replacement] of LABEL_ESCAPES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Edge labels sit between `|` delimiters, so `|` itself must also be escaped. */
function escapeEdgeLabel(label: string): string {
  return escapeLabel(label).replace(/\|/g, "#124;");
}
