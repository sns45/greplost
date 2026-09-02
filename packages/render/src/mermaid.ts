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
 * `#quot;`; `[ ] ( ) { }` (which would otherwise break Mermaid's node shape
 * syntax), `#` and `;` (which could otherwise be misread as introducing or
 * closing one of Mermaid's own `#NN;` character references), and `< >`
 * (which could otherwise be misread as embedded HTML) are all replaced with
 * their decimal HTML character references. The result always ends with a
 * blank line after the closing fence.
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

/**
 * Every replacement is Mermaid's own `#NN;` decimal character reference
 * shape (`#quot;` included), so a raw `#` must itself be escaped: otherwise
 * a label containing `#` followed later by digits and a `;` could decode as
 * an unintended character, and Mermaid could misparse an unescaped `<`/`>`
 * as embedded HTML. Because *every* entry's replacement text contains both
 * `#` and `;`, chaining separate `.replace()` calls for `#` and `;` cannot
 * be made safe in either order: whichever rule runs first inserts text the
 * other rule's pattern also matches, corrupting it. `escapeLabel` avoids
 * that by scanning the original string once (a single regex, single
 * replacer function) rather than chaining passes, so no already-inserted
 * entity is ever rescanned.
 */
const LABEL_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['"', "#quot;"],
  ["[", "#91;"],
  ["]", "#93;"],
  ["(", "#40;"],
  [")", "#41;"],
  ["{", "#123;"],
  ["}", "#125;"],
  ["#", "#35;"],
  [";", "#59;"],
  ["<", "#60;"],
  [">", "#62;"],
]);

const LABEL_ESCAPE_PATTERN = /["[\](){}#;<>]/g;

function escapeLabel(label: string): string {
  return label.replace(LABEL_ESCAPE_PATTERN, (ch) => LABEL_ESCAPES.get(ch) ?? ch);
}

/** Edge labels sit between `|` delimiters, so `|` must also be escaped here, alongside everything `escapeLabel` covers. */
const EDGE_LABEL_ESCAPES: ReadonlyMap<string, string> = new Map([...LABEL_ESCAPES, ["|", "#124;"]]);

const EDGE_LABEL_ESCAPE_PATTERN = /["[\](){}#;<>|]/g;

function escapeEdgeLabel(label: string): string {
  return label.replace(EDGE_LABEL_ESCAPE_PATTERN, (ch) => EDGE_LABEL_ESCAPES.get(ch) ?? ch);
}
