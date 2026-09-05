/**
 * Helm chart truth for Eval 1 (spec 2026-09-04 section 2.3, bench spec 5.2).
 *
 * This oracle is weaker than every other one in the harness and says so in its own `NOTES`.
 * The reason is not laziness, it is arithmetic: **a rendered name is a value and greplost's is
 * a template**. `helm template` turns `name: {{ include "common.names.fullname" . }}` into
 * `name: release-name-redis`, a string that depends on the release, the values file and the
 * chart's helper library — none of which is in the repository. Comparing greplost's
 * `Deployment.~0` against that would not be measuring greplost.
 *
 * So the oracle splits the chart into the parts a name means something in, and the parts it
 * does not:
 *
 *  - `Chart.yaml` and `values.yaml` are ordinary YAML and are read with **js-yaml**, the same
 *    independent parser the manifest oracle uses. A chart's exports are its name; a values
 *    file's are its top-level keys. Both are scored exactly (S2).
 *  - a **template** exports nothing, on both sides. That is not a gap the oracle is papering
 *    over: greplost's `extract/yaml-helm.ts` states the same rule, because the names a template
 *    produces do not exist until the chart is rendered.
 *  - the one reference a template really does make is `helm-values`: `.Values.<path>` names a
 *    key of the chart's own `values.yaml`, and both ends are real, unrendered files. This module
 *    finds them by reading the raw template text and the values file, with no code shared with
 *    `packages/core`, and that set is the S5 truth. **`same-regex-both-sides` publishes the
 *    limit of that**: greplost and this oracle recognise a `.Values` path with the same regular
 *    expression, written twice, so S5 witnesses that the two sides agree about which paths a
 *    chart mentions and not that either is right about what a `.Values` path *is*. Only S2 —
 *    the chart name and the values keys, read by js-yaml against greplost's tree-sitter walk —
 *    is independently witnessed for a chart.
 *  - a literal `image:` in a template is a second reference both sides state, found here by a
 *    line scan of the raw text (`literalImages`) rather than by repeating the pre-pass.
 *  - the **node set** (S6) is scored over `nodeFiles`: the chart's own files, never its
 *    templates, whose node ids carry document-index fallback names that nothing an oracle can
 *    see fixes once a `{{ if }}` decides whether a document renders at all.
 *
 * `helm template` still runs, and is what makes the note `helm-template-render` true: every
 * chart the oracle can render is rendered, and `helmRender` exposes the per-source-file
 * `(kind, apiVersion)` pairs and document counts that `bench/test/truth-yaml-k8s.test.ts`
 * checks greplost's templated nodes against. A chart whose dependencies are not vendored
 * (`bitnami/*` all declare `common` and ship no `charts/`) cannot be rendered offline; that is
 * recorded per chart and costs the render check, not the score, because nothing scored here
 * came from the render.
 *
 * `helm` missing from the PATH is a clear `greplost:` error rather than a silent zero.
 *
 * `if-else-arms-both-kept` publishes the one class of template greplost reads only partly: the
 * pre-pass blanks actions and keeps everything between them, so a `{{ if }} egress: … {{ else }}
 * egress: … {{ end }}` leaves one document with a duplicate key and the grammar recovers what it
 * can. Choosing an arm would mean evaluating the condition, which means running helm. It is 4
 * of the pinned corpus's 122 templates, and it costs recall, never precision: the file simply
 * contributes fewer nodes, and the oracle sees the same file the same way.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadAll } from "js-yaml";
import { compareEdges, compareStrings, type Edge } from "@greplost/core/schema";
import type { Truth } from "./ts.ts";
import type { ReferenceTruth } from "./yaml-k8s.ts";

/** Oracle choices this generator applies, for `RESULTS.md` to disclose. */
export const NOTES: readonly string[] = [
  "js-yaml-oracle",
  "helm-template-render",
  "names-not-compared-for-templates",
  "same-regex-both-sides",
  "if-else-arms-both-kept",
];

/**
 * Metrics no oracle can measure for a chart: YAML has no calls, so S3 is unmeasurable rather
 * than zero.
 *
 * S6 used to be here too, because a template's node ids are document-index fallbacks and
 * `helm template` cannot report the documents it decided not to render. It is not any more: a
 * note is published *target-wide*, so one chart in a repo full of manifests turned S6 off for
 * the manifests as well. `generateExtra` now returns `nodeFiles` — the chart's own files and
 * never its templates — and S6 scores exactly those (fix round 1).
 */
const UNSUPPORTED = ["unsupported:S3"] as const;

const CHART_FILES: ReadonlySet<string> = new Set(["Chart.yaml", "Chart.yml"]);
const VALUES_FILES: ReadonlySet<string> = new Set(["values.yaml", "values.yml"]);

/** `.Values.<path>`: dotted identifiers only, the same shape `extract/yaml-helm.ts` reads. */
const VALUES_PATH = /\.Values((?:\.[A-Za-z_][A-Za-z0-9_-]*)+)/gu;

const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER = 256 * 1024 * 1024;

function basename(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? file : file.slice(slash + 1);
}

function dirname(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? "" : file.slice(0, slash);
}

// ---------------------------------------------------------------------------
// helm
// ---------------------------------------------------------------------------

/** The `helm` binary, or a `greplost:` error naming what is missing. */
export function helmBinary(): string {
  try {
    execFileSync("helm", ["version", "--short"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
  } catch (cause) {
    throw new Error(
      "greplost: the Helm truth generator needs `helm` on the PATH (spec 2.3 names " +
        `\`helm template\` as the oracle): ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return "helm";
}

/** One rendered document: everything the oracle is willing to compare about a template. */
export interface RenderedDocument {
  /** The template file, relative to the chart directory (`templates/deployment.yaml`). */
  readonly source: string;
  readonly kind: string;
  readonly apiVersion: string;
}

/**
 * `helm template <chart>` for one chart directory, split by its `# Source:` markers.
 *
 * Returns null when the chart cannot be rendered — an unvendored dependency is the usual
 * reason, and it is a fact about the checkout rather than about greplost. `helm` itself missing
 * is a throw, because then the oracle is not the one the spec names.
 */
export function helmRender(chartDir: string): RenderedDocument[] | null {
  const binary = helmBinary();
  let stdout: string;
  try {
    stdout = execFileSync(binary, ["template", "."], {
      cwd: chartDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  } catch {
    return null;
  }

  const documents: RenderedDocument[] = [];
  // `helm template` prints `---`, then `# Source: <chart>/templates/...`, then the document.
  for (const chunk of stdout.split(/^---\s*$/mu)) {
    const marker = /^#\s*Source:\s*(\S+)\s*$/mu.exec(chunk);
    if (marker === null) continue;
    const full = marker[1] as string;
    const slash = full.indexOf("/");
    const source = slash === -1 ? full : full.slice(slash + 1);
    let parsed: unknown;
    try {
      parsed = loadAll(chunk).find((document) => document !== null && document !== undefined);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    const kind = record["kind"];
    const apiVersion = record["apiVersion"];
    if (typeof kind !== "string" || typeof apiVersion !== "string") continue;
    documents.push({ source, kind, apiVersion });
  }
  return documents;
}

// ---------------------------------------------------------------------------
// charts
// ---------------------------------------------------------------------------

interface Chart {
  /** Chart root, relative to the repo root ("" for a chart at the repo root). */
  readonly dir: string;
  readonly chartFile: string | null;
  readonly valuesFile: string | null;
  readonly templates: string[];
}

/**
 * Group the requested files into charts.
 *
 * A chart is the nearest ancestor directory of a file that holds a `Chart.yaml`; a file whose
 * chart is not in the requested set still belongs to the directory above its `templates/`
 * segment, which is what `helm` itself would call the chart.
 */
export function chartsOf(files: readonly string[]): Chart[] {
  const byDir = new Map<string, { chartFile: string | null; valuesFile: string | null; templates: string[] }>();
  const entry = (dir: string) => {
    const found = byDir.get(dir);
    if (found !== undefined) return found;
    const fresh = { chartFile: null as string | null, valuesFile: null as string | null, templates: [] as string[] };
    byDir.set(dir, fresh);
    return fresh;
  };

  for (const file of [...files].sort(compareStrings)) {
    const base = basename(file);
    if (CHART_FILES.has(base)) {
      entry(dirname(file)).chartFile = file;
      continue;
    }
    if (VALUES_FILES.has(base)) {
      entry(dirname(file)).valuesFile = file;
      continue;
    }
    const index = file.lastIndexOf("/templates/");
    const chartDir = index === -1 ? (file.startsWith("templates/") ? "" : dirname(file)) : file.slice(0, index);
    entry(chartDir).templates.push(file);
  }

  return [...byDir.entries()]
    .map(([dir, value]) => ({ dir, ...value }))
    .filter((chart) => chart.chartFile !== null || chart.valuesFile !== null || chart.templates.length > 0)
    .sort((a, b) => compareStrings(a.dir, b.dir));
}

/** The first YAML document of a file, or null when js-yaml cannot read it. */
function firstDocument(file: string): Record<string, unknown> | null {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let documents: unknown[];
  try {
    documents = loadAll(source);
  } catch {
    return null;
  }
  const first = documents.find((document) => document !== null && document !== undefined);
  return typeof first === "object" && first !== null && !Array.isArray(first)
    ? (first as Record<string, unknown>)
    : null;
}

/** Top-level keys of a values file, sorted; the node names greplost declares for it. */
function valuesKeys(file: string): string[] {
  const document = firstDocument(file);
  if (document === null) return [];
  return Object.keys(document)
    .filter((key) => key !== "" && !/[#\n\0]/u.test(key))
    .sort(compareStrings);
}

// ---------------------------------------------------------------------------
// literal images
// ---------------------------------------------------------------------------

/** Keys whose value is a list of containers. */
const CONTAINER_KEYS: ReadonlySet<string> = new Set(["containers", "initContainers", "ephemeralContainers"]);

/** A `key: value` line, with the indentation of the key and whether a `- ` opened the item. */
const LINE = /^(\s*)(-\s+)?([A-Za-z_][A-Za-z0-9_.\-\/]*):[ \t]*(.*?)[ \t]*$/u;

/** True for a scalar that came out of a template action rather than out of the file. */
function templated(value: string): boolean {
  return value === "" || value.includes("{{");
}

/**
 * Every literal `image:` a chart template writes, as `<file>#image.<container>` -> the reference.
 *
 * A *line* scan, deliberately: greplost reads a blanked parse tree, and an oracle that repeated
 * the pre-pass and the tree walk would be the same program twice. What is restated here is the
 * documented rule, not the implementation — a container is a sequence item under `containers:`,
 * `initContainers:` or `ephemeralContainers:` with a `name:` and an `image:`, inside a document
 * whose `apiVersion` and `kind` are both literal (spec 2.3, and the leaf's ruling that a
 * templated kind makes no node). Anything with a `{{` in it is a value helm decides and neither
 * side claims.
 */
export function literalImages(source: string, file: string): Array<{ from: string; image: string }> {
  const out: Array<{ from: string; image: string }> = [];
  const used = new Set<string>();
  for (const document of source.split(/^---[ \t]*$/mu)) {
    let apiVersion: string | null = null;
    let kind: string | null = null;
    for (const line of document.split("\n")) {
      const match = LINE.exec(line);
      if (match === null || (match[1] as string) !== "" || match[2] !== undefined) continue;
      if (match[3] === "apiVersion") apiVersion = match[4] as string;
      if (match[3] === "kind") kind = match[4] as string;
    }
    if (apiVersion === null || kind === null || templated(apiVersion) || templated(kind)) continue;

    // Indentation of the innermost container list, and of the item currently open under it.
    let listIndent: number | null = null;
    let itemIndent: number | null = null;
    let name: string | null = null;
    let image: string | null = null;
    const flush = (): void => {
      if (name === null || image === null || templated(name) || templated(image) || name.includes("#")) {
        name = null;
        image = null;
        return;
      }
      const base = `${file}#image.${name}`;
      let id = base;
      for (let n = 2; used.has(id); n += 1) id = `${base}~${n}`;
      used.add(id);
      out.push({ from: id, image });
      name = null;
      image = null;
    };

    for (const line of document.split("\n")) {
      const match = LINE.exec(line);
      if (match === null) continue;
      const indent = (match[1] as string).length;
      const dash = match[2] !== undefined;
      const key = match[3] as string;
      const value = match[4] as string;

      if (CONTAINER_KEYS.has(key) && !dash) {
        flush();
        listIndent = indent;
        itemIndent = null;
        continue;
      }
      if (listIndent === null) continue;
      // A line at or above the list's own indentation closes the list.
      if (indent <= listIndent && !dash) {
        flush();
        listIndent = null;
        itemIndent = null;
        continue;
      }
      if (dash) {
        flush();
        itemIndent = indent + (match[2] as string).length;
      }
      if (itemIndent === null || indent + (dash ? (match[2] as string).length : 0) !== itemIndent) continue;
      if (key === "name") name = value;
      if (key === "image") image = value;
    }
    flush();
  }
  return out;
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

interface Run {
  readonly covered: string[];
  readonly exports: Record<string, string[]>;
  readonly charts: Chart[];
  /** Charts `helm template` refused, so a report can say the render check did not run. */
  readonly unrendered: string[];
}

function coveredRun(root: string, files: string[], render: boolean): Run {
  const absRoot = path.resolve(root);
  const charts = chartsOf(files);
  const exports: Record<string, string[]> = {};
  const covered: string[] = [];
  const unrendered: string[] = [];
  let read = 0;

  for (const chart of charts) {
    if (chart.chartFile !== null) {
      const document = firstDocument(path.join(absRoot, chart.chartFile));
      const name = document === null ? null : document["name"];
      exports[chart.chartFile] =
        typeof name === "string" && name !== "" && !/[#\n\0]/u.test(name) ? [name] : [];
      covered.push(chart.chartFile);
      read += 1;
    }
    if (chart.valuesFile !== null) {
      exports[chart.valuesFile] = valuesKeys(path.join(absRoot, chart.valuesFile));
      covered.push(chart.valuesFile);
      read += 1;
    }
    // A template exports nothing, on both sides: its names do not exist until it is rendered.
    for (const template of chart.templates) {
      if (!existsSync(path.join(absRoot, template))) continue;
      exports[template] = [];
      covered.push(template);
      read += 1;
    }
    if (render && chart.chartFile !== null && helmRender(path.join(absRoot, chart.dir)) === null) {
      unrendered.push(chart.dir);
    }
  }

  if (files.length > 0 && read === 0) {
    throw new Error(
      `greplost: yaml-helm truth is empty for ${absRoot} (none of the ${files.length} requested chart files ` +
        "could be read)",
    );
  }
  return { covered: covered.sort(compareStrings), exports, charts, unrendered };
}

/**
 * Helm truth for `files` (repo-relative posix paths) under `root`.
 *
 * `helm` is required — it is the oracle spec 2.3 names — and every chart that can be rendered
 * is, so a chart that stopped rendering is visible. A chart that cannot be rendered offline
 * (unvendored dependencies) is reported on stderr, not thrown: nothing scored here comes from
 * the render.
 */
export function generateTruth(root: string, files: string[]): Truth {
  const { covered, exports, unrendered } = coveredRun(root, files, true);
  if (unrendered.length > 0) {
    console.error(
      `truth-yaml-helm: ${unrendered.length} chart(s) under ${root} could not be rendered offline ` +
        `(first: ${unrendered[0] as string}); the render cross-check did not run for them`,
    );
  }
  return {
    files: covered,
    imports: [],
    exports,
    calls: [],
    cycles: [],
    notes: [...NOTES, ...UNSUPPORTED],
  };
}

/**
 * The reference and node sets S5 and S6 are scored on.
 *
 * References are two rules, both read off the raw template text and neither needing a render:
 *
 *  - `helm-values`, one per distinct `.Values.<path>` in a template, to the `values.yaml` node
 *    for the path's first segment. `Chart.yaml` is **not** scanned — greplost's extractor
 *    returns a chart's `module` node and looks at nothing else in that file — so an
 *    `annotations:` block mentioning `.Values` there cannot become an edge only one side has.
 *  - `from-image`, one per literal `image:` in a template. A literal image in a chart is fully
 *    rendered text and names the image that will run, so both sides claim it (fix round 1).
 *
 * `nodeFiles` is the chart's own files and never its `templates/**` (bench seam, `nodeFiles` on
 * the `generateExtra` result): a chart file's node names — the chart's name, a values key — are
 * written down and can be compared, and a template's are document-index fallbacks that only
 * exist after helm has decided which documents render. Restricting S6 rather than declaring it
 * `unsupported` is what lets a repo holding manifests *and* a chart still score its manifests.
 */
export function generateExtra(
  root: string,
  files: string[],
): { references: Edge[]; nodes: string[]; nodeFiles: string[] } {
  const absRoot = path.resolve(root);
  const { charts } = coveredRun(absRoot, files, false);

  const references: ReferenceTruth[] = [];
  const nodes: string[] = [];
  const nodeFiles: string[] = [];

  for (const chart of charts) {
    if (chart.chartFile !== null) {
      nodeFiles.push(chart.chartFile);
      const document = firstDocument(path.join(absRoot, chart.chartFile));
      const name = document === null ? null : document["name"];
      if (typeof name === "string" && name !== "" && !/[#\n\0]/u.test(name)) {
        nodes.push(`${chart.chartFile}#module.${name}`);
      }
    }

    const keys = chart.valuesFile === null ? [] : valuesKeys(path.join(absRoot, chart.valuesFile));
    if (chart.valuesFile !== null) {
      nodeFiles.push(chart.valuesFile);
      for (const key of keys) nodes.push(`${chart.valuesFile}#variable.${key}`);
    }
    const keySet = new Set(keys);

    for (const file of [...chart.templates].sort(compareStrings)) {
      let source: string;
      try {
        source = readFileSync(path.join(absRoot, file), "utf8");
      } catch {
        continue;
      }

      if (chart.valuesFile !== null && keySet.size > 0) {
        const seen = new Set<string>();
        for (const match of source.matchAll(VALUES_PATH)) {
          const address = `.Values${match[1] as string}`;
          if (seen.has(address)) continue;
          seen.add(address);
          const first = (match[1] as string).slice(1).split(".")[0] as string;
          if (!keySet.has(first)) continue;
          references.push({
            from: file,
            to: `${chart.valuesFile}#variable.${first}`,
            kind: "reference",
            refKind: "helm-values",
            symbols: [address],
            confidence: "med",
          });
        }
      }

      for (const image of literalImages(source, file)) {
        references.push({
          from: image.from,
          to: `ext:image/${image.image}`,
          kind: "reference",
          refKind: "from-image",
          symbols: [image.image],
          confidence: "high",
        });
      }
    }
  }

  references.sort(compareEdges);
  const out: ReferenceTruth[] = [];
  for (const candidate of references) {
    const previous = out[out.length - 1];
    if (previous !== undefined && compareEdges(previous, candidate) === 0) continue;
    out.push(candidate);
  }
  return { references: out, nodes: nodes.sort(compareStrings), nodeFiles: nodeFiles.sort(compareStrings) };
}
