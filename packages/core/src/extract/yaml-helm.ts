/**
 * Helm chart extraction (build 2, spec 2026-09-04 section 2.3; driver ruling 2026-09-04).
 *
 * A file under `templates/` is not YAML. It is a Go template that *produces* YAML, and greplost
 * never runs `helm`: a map that needed a release name, a values file and a Kubernetes version
 * to be built would not be a map of the repository. So this module applies one documented,
 * deterministic pre-pass and then reads the result with the ordinary Kubernetes rules.
 *
 * **The pre-pass.** Every `{{ … }}` span is replaced *in place* by filler of the same byte
 * length, so the file's length, every line number and every column survive:
 *
 *  - an action that begins its line (nothing but whitespace before it) becomes spaces, so the
 *    line vanishes from the document instead of turning into a stray scalar — that is what
 *    keeps `{{- if … }}`, `{{- range … }}` and `{{- end }}` from wrecking the block structure;
 *  - any other action becomes `_` characters, so `name: {{ .Release.Name }}` stays a `name:`
 *    key with a value, and the value is visibly a placeholder;
 *  - a newline inside an action is kept as a newline, and the action's continuation lines are
 *    filled with spaces: a multi-line action must not move the lines below it, and its tail
 *    carries no value that could belong to the key on its first line.
 *
 * A node whose name or image came out of a replaced span is marked `meta.templated = "1"`, falls
 * back to the document-index form (`<kind>.~<index>`), and keeps the text as written in
 * `meta.nameTemplate` / `meta.imageTemplate`. A document whose *kind* is templated makes no node
 * at all: see `extract/yaml-k8s.ts`.
 *
 * **The chart files.** `Chart.yaml` is one `module` node named after the chart; `values.yaml` is
 * one `variable` node per **top-level** key, a deliberate cap that keeps a thousand-key values
 * file from producing a thousand nodes.
 *
 * **`.Values` references.** Every `.Values.<path>` written anywhere in a chart file becomes a
 * `helm-values` reference to the chart's `values.yaml` node for the path's first segment. It is
 * recorded at *file* level rather than against the document that contains it, because an action
 * is as likely to sit in a `define` block or between two documents as inside one, and because
 * the truth oracle — which renders the chart and never sees the template's document structure —
 * has to be able to state the same edge (leaf 2.8 ruling).
 */

import type { Tree } from "web-tree-sitter";
import type { Lang } from "../schema.ts";
import { reparse } from "../parser.ts";
import { clip } from "./ts-signature.ts";
import { documentValue, mapEntries, scalarAt, yamlDocuments } from "./yaml-doc.ts";
import type { K8sInput, YamlParts } from "./yaml-k8s.ts";
import { extractK8sDocuments } from "./yaml-k8s.ts";

/** Chart metadata files, by basename. */
const CHART_FILES: ReadonlySet<string> = new Set(["Chart.yaml", "Chart.yml"]);
const VALUES_FILES: ReadonlySet<string> = new Set(["values.yaml", "values.yml"]);

/**
 * `.Values.<path>`: the one template expression greplost resolves.
 *
 * The path is dotted identifiers only. `index .Values "a" "b"` and `.Values` followed by
 * anything else are left alone rather than half-read: a reference greplost cannot spell is not
 * a reference it should invent.
 */
const VALUES_PATH = /\.Values((?:\.[A-Za-z_][A-Za-z0-9_-]*)+)/gu;

function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

// ---------------------------------------------------------------------------
// the template pre-pass
// ---------------------------------------------------------------------------

/**
 * The byte ranges every `{{ … }}` action occupies, in source order, non-overlapping.
 *
 * A Go template comment (a `{{` immediately followed by a slash-star opener) may contain `}}`
 * of its own, so it is closed on its star-slash terminator
 * first; every other action ends at the first `}}`. An action that is never closed ends the
 * scan: the rest of the file is left exactly as written, which is the honest answer for a file
 * that is not a template at all.
 */
export function templateSpans(source: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let at = 0;
  for (;;) {
    const open = source.indexOf("{{", at);
    if (open === -1) return spans;
    let from = open + 2;
    // `{{/*`, and `{{- /*` with any whitespace between: a comment closes on `*/` first.
    const head = source.slice(from, from + 8);
    const comment = /^-?\s*\/\*/u.exec(head);
    if (comment !== null) {
      const closeComment = source.indexOf("*/", from + comment[0].length);
      if (closeComment === -1) return spans;
      from = closeComment + 2;
    }
    const close = source.indexOf("}}", from);
    if (close === -1) return spans;
    spans.push([open, close + 2]);
    at = close + 2;
  }
}

/**
 * The source with every template action blanked in place: same byte length, same line count,
 * same column for every character that survives.
 */
export function blankTemplates(source: string): string {
  const spans = templateSpans(source);
  if (spans.length === 0) return source;

  const fills = spans.map(([start]) => (opensLine(source, start) ? " " : "_"));
  const once = apply(source, spans, fills);

  // Second pass, for the one idiom the first rule gets wrong. `labels: {{- include … | nindent
  // 4 }}` is an action that *is* a key's whole value and renders a nested mapping, so the lines
  // below it are more indented than the key — and `labels: ______` followed by an indented
  // `a: b` is not YAML at all (a plain scalar may not contain ": "). Filling those with spaces
  // instead leaves `labels:` with the block that follows as its value, which is what helm would
  // have produced. Whether the lines below are deeper is read off the *blanked* text, because a
  // line holding nothing but `{{- if … }}` is already gone by then.
  let changed = false;
  for (let index = 0; index < spans.length; index += 1) {
    if (fills[index] === " ") continue;
    const span = spans[index] as [number, number];
    const column = wholeValueColumn(source, span);
    if (column === null) continue;
    if (nextIndent(once, span[1]) > column) {
      fills[index] = " ";
      changed = true;
    }
  }
  return changed ? apply(source, spans, fills) : once;
}

/** True when nothing but whitespace precedes `start` on its line. */
function opensLine(source: string, start: number): boolean {
  return source.slice(source.lastIndexOf("\n", start - 1) + 1, start).trim() === "";
}

function apply(source: string, spans: ReadonlyArray<[number, number]>, fills: readonly string[]): string {
  const out: string[] = [];
  let at = 0;
  for (let index = 0; index < spans.length; index += 1) {
    const [start, end] = spans[index] as [number, number];
    out.push(source.slice(at, start));
    out.push(blankSpan(source, start, end, fills[index] as string));
    at = end;
  }
  out.push(source.slice(at));
  return out.join("");
}

/** One action's replacement text: see the module docstring for the three rules. */
function blankSpan(source: string, start: number, end: number, fill: string): string {
  let out = "";
  let onFirstLine = true;
  for (let i = start; i < end; i += 1) {
    if (source[i] === "\n") {
      out += "\n";
      onFirstLine = false;
      continue;
    }
    // The tail of a multi-line action carries no value for the key on its first line, and a run
    // of `_` at column 0 would be read as a document of its own.
    out += onFirstLine ? fill : " ";
  }
  return out;
}

/**
 * The column of the key an action is the whole value of, or null when it is not one.
 *
 * `  labels: {{ … }}` (and `    - name: {{ … }}`) qualify; `name: {{ … }}-web` does not,
 * because the action is only part of the value.
 */
function wholeValueColumn(source: string, [start, end]: readonly [number, number]): number | null {
  const before = source.slice(source.lastIndexOf("\n", start - 1) + 1, start);
  const key = /^(\s*(?:-\s+)*)[^\s#][^:]*:[ \t]*$/u.exec(before);
  if (key === null) return null;
  const lineEnd = source.indexOf("\n", end);
  const after = source.slice(end, lineEnd === -1 ? source.length : lineEnd);
  if (after.trim() !== "") return null;
  return (key[1] as string).length;
}

/** The indentation of the first non-blank line after the one `offset` sits on; -1 at the end. */
function nextIndent(source: string, offset: number): number {
  let at = source.indexOf("\n", offset);
  while (at !== -1) {
    const start = at + 1;
    const end = source.indexOf("\n", start);
    const line = source.slice(start, end === -1 ? source.length : end);
    if (line.trim() !== "") return line.length - line.trimStart().length;
    if (end === -1) return -1;
    at = end;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// chart files
// ---------------------------------------------------------------------------

function nothing(): YamlParts {
  return { decls: [], imports: [], exports: [], calls: [], refs: [] };
}

/** `Chart.yaml` -> one `module` node named after the chart. */
function extractChart(path: string, tree: Tree): YamlParts {
  const parts = nothing();
  const first = yamlDocuments(tree.rootNode)[0];
  if (first === undefined) return parts;
  const document = documentValue(first);
  const name = scalarAt(document, "name");
  if (name === null || name === "" || /[#\n\0]/u.test(name)) return parts;

  const version = scalarAt(document, "version");
  const appVersion = scalarAt(document, "appVersion");
  const meta: Record<string, string> = { flavour: "helm" };
  if (appVersion !== null && appVersion !== "") meta["appVersion"] = appVersion;
  if (version !== null && version !== "") meta["version"] = version;

  parts.decls.push({
    id: `${path}#module.${name}`,
    file: path,
    name,
    kind: "module",
    signature: clip(`chart ${name}${version === null ? "" : ` ${version}`}`),
    exported: false,
    span: [first.startPosition.row + 1, first.endPosition.row + 1],
    meta: sortedMeta(meta),
  });
  parts.exports.push({ name, kind: "named" });
  return parts;
}

/**
 * `values.yaml` -> one `variable` node per **top-level** key.
 *
 * The cap is the spec's, and it is the difference between a chart contributing five nodes and a
 * chart contributing nine hundred: `bitnami/kafka`'s values file has 2,600 keys and nothing
 * below the first level names something another file can reach for.
 */
function extractValues(path: string, tree: Tree): YamlParts {
  const parts = nothing();
  const first = yamlDocuments(tree.rootNode)[0];
  if (first === undefined) return parts;
  const seen = new Set<string>();
  for (const entry of mapEntries(documentValue(first))) {
    if (entry.key === "" || /[#\n\0]/u.test(entry.key) || seen.has(entry.key)) continue;
    seen.add(entry.key);
    parts.decls.push({
      id: `${path}#variable.${entry.key}`,
      file: path,
      name: entry.key,
      kind: "variable",
      signature: clip(entry.key),
      exported: false,
      span: [entry.keyNode.startPosition.row + 1, entry.value.node.endPosition.row + 1],
      meta: sortedMeta({ flavour: "helm", path: entry.key }),
    });
    parts.exports.push({ name: entry.key, kind: "named" });
  }
  return parts;
}

function sortedMeta(meta: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(meta).sort()) out[key] = meta[key] as string;
  return out;
}

// ---------------------------------------------------------------------------
// `.Values` references
// ---------------------------------------------------------------------------

/** The 1-based line an offset falls on. */
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

/**
 * One `helm-values` reference per distinct `.Values.<path>` in the file, at the line of its
 * first occurrence. `from` is `""`, the file itself.
 */
function valuesReferences(source: string, parts: YamlParts): void {
  const seen = new Set<string>();
  for (const match of source.matchAll(VALUES_PATH)) {
    const address = `.Values${match[1] as string}`;
    if (seen.has(address)) continue;
    seen.add(address);
    (parts.refs as NonNullable<YamlParts["refs"]>).push({
      from: "",
      to: address,
      refKind: "helm-values",
      line: lineAt(source, match.index),
    });
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Everything one Helm chart file says about itself.
 *
 * A template is blanked and **re-parsed** before anything is read off it: `extractFile` parses
 * the file as written, which for a template is a tree full of ERROR nodes, and a span read off
 * that tree would be a span of the wrong thing. `reparse` is the seam's own synchronous
 * re-parse (`parser.ts`), and the tree it hands back is deleted here rather than left to a
 * finalizer.
 */
export function extractYamlHelm(path: string, _lang: Lang, source: string, tree: Tree): YamlParts {
  const base = basenameOf(path);
  if (CHART_FILES.has(base)) return extractChart(path, tree);
  if (VALUES_FILES.has(base)) return extractValues(path, tree);

  const blanks = templateSpans(source);
  const input = (blanked: string, parsed: Tree): K8sInput => ({
    path,
    source: blanked,
    raw: source,
    tree: parsed,
    flavour: "helm",
    blanks,
  });

  let parts: YamlParts;
  if (blanks.length === 0) {
    parts = extractK8sDocuments(input(source, tree));
  } else {
    const blanked = blankTemplates(source);
    const reparsed = reparse(tree.language, blanked);
    if (reparsed === null) return nothing();
    try {
      parts = extractK8sDocuments(input(blanked, reparsed));
    } finally {
      reparsed.delete();
    }
  }

  valuesReferences(source, parts);
  return parts;
}
