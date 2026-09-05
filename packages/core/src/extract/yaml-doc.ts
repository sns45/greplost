/**
 * Reading a tree-sitter YAML tree as plain values (build 2, leaf 2.8).
 *
 * Every YAML flavour greplost knows, Kubernetes manifests, Helm charts, GitHub Actions
 * workflows, walks the same shapes: a stream of documents, each a mapping of scalars,
 * sequences and nested mappings. This module is that walk, and nothing above it: it knows no
 * `apiVersion`, no `jobs`, no `Chart.yaml`. Leaf 2.8 owns it and **leaf 2.9 imports it** rather
 * than writing a second one, which is the whole reason it is a file of its own (driver ruling
 * 2026-09-04).
 *
 * Two properties the callers depend on:
 *
 *  - **Every value keeps its node.** A declaration needs a span and a reference needs a line,
 *    so a value is never reduced to a bare string; `YamlValue.node` is the tree-sitter node the
 *    value was read from, and `lineOf`/`spanOf` work on it unchanged.
 *  - **Order is source order.** `entries` and `items` come back in the order they were written,
 *    so a node index (`#0`, `#1`) means the same thing on every run.
 *
 * What it deliberately does *not* do: resolve anchors, aliases or merge keys (`<<:`). A YAML
 * parser that resolves them has to build a value graph, and greplost's extractors want the text
 * as written: an alias is recorded as the alias it is, and the flavour module decides. That is
 * a documented difference from `js-yaml`, which the truth generators use.
 */

import type { Node } from "web-tree-sitter";

/** One value in a YAML document, tagged by shape and carrying the node it was read from. */
export type YamlValue =
  | { readonly shape: "map"; readonly node: Node; readonly entries: readonly YamlEntry[] }
  | { readonly shape: "seq"; readonly node: Node; readonly items: readonly YamlValue[] }
  | { readonly shape: "scalar"; readonly node: Node; readonly text: string }
  | { readonly shape: "empty"; readonly node: Node };

/** One `key: value` pair of a mapping, in source order. */
export interface YamlEntry {
  readonly key: string;
  readonly keyNode: Node;
  readonly value: YamlValue;
}

/** Node types that wrap a value without being one. */
const WRAPPERS: ReadonlySet<string> = new Set(["block_node", "flow_node"]);

/** Scalar node types the grammar produces, plain and quoted. */
const SCALARS: ReadonlySet<string> = new Set([
  "plain_scalar",
  "single_quote_scalar",
  "double_quote_scalar",
  "block_scalar",
]);

/**
 * The `document` nodes of a parsed stream, in source order.
 *
 * Every document is returned, including one that holds nothing at all (`---` on its own): a
 * document's index is its position in the file, and skipping the empty ones would renumber the
 * documents after it.
 */
export function yamlDocuments(root: Node): Node[] {
  return root.namedChildren.filter((child): child is Node => child !== null && child.type === "document");
}

/** The value of one document: its root mapping, sequence or scalar. */
export function documentValue(document: Node): YamlValue {
  for (const child of document.namedChildren) {
    if (child === null) continue;
    if (WRAPPERS.has(child.type) || isValueType(child.type)) return readValue(child);
  }
  return { shape: "empty", node: document };
}

function isValueType(type: string): boolean {
  return (
    type === "block_mapping" ||
    type === "flow_mapping" ||
    type === "block_sequence" ||
    type === "flow_sequence" ||
    SCALARS.has(type)
  );
}

/**
 * One value, through any number of wrappers.
 *
 * A `flow_node` may carry an anchor or a tag before its value (`&x val`, `!!str 5`); those are
 * skipped and the value behind them is read. A node that is only an alias (`*x`) has no value
 * of its own here and reads as `empty`.
 */
export function readValue(node: Node): YamlValue {
  if (WRAPPERS.has(node.type)) {
    for (const child of node.namedChildren) {
      if (child === null || child.type === "anchor" || child.type === "tag" || child.type === "comment") continue;
      if (child.type === "alias") return { shape: "empty", node };
      return readValue(child);
    }
    return { shape: "empty", node };
  }
  if (node.type === "block_mapping" || node.type === "flow_mapping") {
    return { shape: "map", node, entries: readEntries(node) };
  }
  if (node.type === "block_sequence" || node.type === "flow_sequence") {
    return { shape: "seq", node, items: readItems(node) };
  }
  if (SCALARS.has(node.type)) return { shape: "scalar", node, text: scalarText(node) };
  return { shape: "empty", node };
}

function readEntries(mapping: Node): YamlEntry[] {
  const entries: YamlEntry[] = [];
  for (const pair of mapping.namedChildren) {
    if (pair === null || !pair.type.endsWith("_pair")) continue;
    const keyNode = pair.childForFieldName("key");
    if (keyNode === null) continue;
    const key = readValue(keyNode);
    if (key.shape !== "scalar") continue;
    const valueNode = pair.childForFieldName("value");
    entries.push({
      key: key.text,
      keyNode,
      value: valueNode === null ? { shape: "empty", node: pair } : readValue(valueNode),
    });
  }
  return entries;
}

function readItems(sequence: Node): YamlValue[] {
  const items: YamlValue[] = [];
  for (const item of sequence.namedChildren) {
    if (item === null) continue;
    if (item.type === "block_sequence_item") {
      const inner = item.namedChildren.find((child) => child !== null && child.type !== "comment");
      items.push(inner === undefined || inner === null ? { shape: "empty", node: item } : readValue(inner));
      continue;
    }
    if (item.type === "comment") continue;
    items.push(readValue(item));
  }
  return items;
}

/**
 * A scalar's value as text.
 *
 * Quotes are removed and the two escapes that can hide a character a name is allowed to contain
 * are undone (`\\` and `\"` inside a double-quoted scalar, `''` inside a single-quoted one).
 * Nothing else is interpreted: `1.10` stays `1.10` and `yes` stays `yes`, because a Kubernetes
 * name, a label value and an image reference are all strings and YAML's scalar typing would
 * only lose information here.
 */
export function scalarText(node: Node): string {
  const raw = node.text;
  if (node.type === "single_quote_scalar") {
    return raw.length >= 2 ? raw.slice(1, -1).replace(/''/gu, "'") : raw;
  }
  if (node.type === "double_quote_scalar") {
    return raw.length >= 2 ? raw.slice(1, -1).replace(/\\(["\\/])/gu, "$1") : raw;
  }
  if (node.type === "block_scalar") return blockScalarText(raw);
  return raw.trim();
}

/**
 * A literal or folded block scalar's content, with its indicator line and common indentation
 * removed. Line breaks are kept as written; folding is not applied, because the callers use a
 * block scalar's text as evidence (a `run:` body, an embedded document) and never as a name.
 */
function blockScalarText(raw: string): string {
  const newline = raw.indexOf("\n");
  if (newline === -1) return "";
  const lines = raw.slice(newline + 1).split("\n");
  let indent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim() === "") continue;
    indent = Math.min(indent, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(indent)) return "";
  return lines.map((line) => line.slice(indent)).join("\n").replace(/\n+$/u, "");
}

// ---------------------------------------------------------------------------
// lookups
// ---------------------------------------------------------------------------

/** The value stored under `key`, or null when `value` is not a mapping that has it. */
export function mapGet(value: YamlValue | null, key: string): YamlValue | null {
  if (value === null || value.shape !== "map") return null;
  for (const entry of value.entries) if (entry.key === key) return entry.value;
  return null;
}

/** `mapGet` applied along a path: `mapPath(doc, "spec", "template", "metadata")`. */
export function mapPath(value: YamlValue | null, ...keys: readonly string[]): YamlValue | null {
  let current = value;
  for (const key of keys) current = mapGet(current, key);
  return current;
}

/** The scalar text at `keys`, or null when the value is missing or is not a scalar. */
export function scalarAt(value: YamlValue | null, ...keys: readonly string[]): string | null {
  const found = mapPath(value, ...keys);
  return found !== null && found.shape === "scalar" ? found.text : null;
}

/** The items of a sequence value, or an empty list for anything else. */
export function seqItems(value: YamlValue | null): readonly YamlValue[] {
  return value !== null && value.shape === "seq" ? value.items : [];
}

/** The entries of a mapping value, or an empty list for anything else. */
export function mapEntries(value: YamlValue | null): readonly YamlEntry[] {
  return value !== null && value.shape === "map" ? value.entries : [];
}

/**
 * A mapping read as `key -> scalar text`, skipping every entry whose value is not a scalar.
 *
 * This is what a Kubernetes label set and a label selector both are, and reading them the same
 * way is what lets one be tested for being a subset of the other.
 */
export function scalarMap(value: YamlValue | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of mapEntries(value)) {
    if (entry.value.shape === "scalar") out.set(entry.key, entry.value.text);
  }
  return out;
}

/**
 * Every value under `value` whose key is `key`, at any depth, in source order.
 *
 * A container list lives at `spec.containers` in a Pod, `spec.template.spec.containers` in a
 * Deployment and `spec.jobTemplate.spec.template.spec.containers` in a CronJob; a `configMapRef`
 * can sit under `envFrom`, under `volumes` or inside a list of projected sources. Enumerating
 * the paths means a kind nobody thought of contributes nothing, so both greplost and the oracle
 * search by key instead, the same rule, stated once, applied to whatever the document holds.
 */
export function findByKey(value: YamlValue, key: string): YamlValue[] {
  const found: YamlValue[] = [];
  walk(value, (entry) => {
    if (entry.key === key) found.push(entry.value);
  });
  return found;
}

/** Depth-first walk over every mapping entry under `value`, in source order. */
export function walk(value: YamlValue, visit: (entry: YamlEntry) => void): void {
  if (value.shape === "map") {
    for (const entry of value.entries) {
      visit(entry);
      walk(entry.value, visit);
    }
    return;
  }
  if (value.shape === "seq") {
    for (const item of value.items) walk(item, visit);
  }
}
