/**
 * Kubernetes manifest truth for Eval 1 (spec 2026-09-04 section 2.3, bench spec 5.2).
 *
 * The structure layer is never scored against itself (tech spec 10.1, principle 2), so nothing
 * here imports greplost's extractor, resolver or tree-sitter. The oracle is **js-yaml 4**, a
 * different YAML implementation with a different parser, reading the same bytes: `loadAll`
 * gives the document list and everything below is computed from the plain JavaScript objects
 * it hands back.
 *
 * That makes it an *independent implementation of the same documented rules*, which is the most
 * an oracle can be for a format whose semantics are "what the file says". Where it can disagree
 * with greplost, and does:
 *
 *  - js-yaml resolves anchors, aliases and merge keys (`<<:`); greplost reads the text as
 *    written and never expands one. A manifest that uses them is a real difference and is
 *    scored as one.
 *  - js-yaml types scalars (`1.10` is a number, `yes` is a boolean, `null` is null); this
 *    module turns every scalar back into the text a name would have had, so a name is compared
 *    as a name.
 *  - js-yaml refuses a document greplost's error-recovering parser reads part of (a duplicate
 *    key, a tab in indentation). Such a file is **not covered**, so neither side is scored on
 *    a document only one of them could see.
 *
 * What it produces, in greplost's id vocabulary:
 *
 *   files       the `.yaml` files it could read; the harness intersects both sides with this;
 *   imports     always empty: a manifest has no import statements at all;
 *   exports     each file's sorted node names — a manifest's public surface is the objects it
 *               declares, which is exactly what another manifest reaches for by name;
 *   calls       always empty, which is why S3 is `n/a` for YAML and never 0;
 *   references  the S5 truth: selector, config and image edges resolved the same way;
 *   nodes       every node id, so the node set is scored alongside the edges (S6).
 *
 * An empty result is an error, never a score: a run where the reader loaded nothing would
 * otherwise report vacuous 1.000s and pass the gate.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { loadAll } from "js-yaml";
import { compareEdges, compareStrings, type Edge } from "@greplost/core/schema";
import type { Truth } from "./ts.ts";

/** Oracle choices this generator applies, for `RESULTS.md` to disclose. */
export const NOTES: readonly string[] = ["js-yaml-oracle"];

/**
 * S3 is not a miss for a manifest, it is unmeasurable: YAML has no call edges at all, so there
 * is nothing for an oracle to be right or wrong about. `structural.ts` reads this spelling out
 * of the notes and prints `n/a` (leaf 2.0 ruling R10); nothing is inferred.
 */
const UNSUPPORTED = ["unsupported:S3"] as const;

/** Keys whose value is a list of containers, wherever in a document they appear. */
const CONTAINER_KEYS: ReadonlySet<string> = new Set(["containers", "initContainers", "ephemeralContainers"]);

/** Config references, by the key that introduces them (spec 2.3, "References"). */
const CONFIG_REFS: Readonly<Record<string, { readonly nameKey: string; readonly kind: string }>> = {
  configMap: { nameKey: "name", kind: "ConfigMap" },
  configMapKeyRef: { nameKey: "name", kind: "ConfigMap" },
  configMapRef: { nameKey: "name", kind: "ConfigMap" },
  persistentVolumeClaim: { nameKey: "claimName", kind: "PersistentVolumeClaim" },
  secretKeyRef: { nameKey: "name", kind: "Secret" },
  secretRef: { nameKey: "name", kind: "Secret" },
};

/** Kinds whose `spec` carries a pod selector, and the path the selector sits at. */
const SELECTOR_PATHS: Readonly<Record<string, readonly string[]>> = {
  NetworkPolicy: ["spec", "podSelector", "matchLabels"],
  Service: ["spec", "selector"],
};

const LABEL_SEPARATORS = /[,=]/u;

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A scalar as the text a name would have been written with.
 *
 * js-yaml has already typed the value; a Kubernetes name, a label value and an image reference
 * are all strings, so anything that is not a string is not one of them and is refused rather
 * than stringified into something that only looks like a name.
 */
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function get(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isPlain(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Depth-first walk over every mapping entry under `value`, in source (insertion) order. */
function walk(value: unknown, visit: (key: string, entry: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!isPlain(value)) return;
  for (const key of Object.keys(value)) {
    visit(key, value[key]);
    walk(value[key], visit);
  }
}

/** `app=web,tier=front`, or null when the mapping is empty or not a label set. */
function labelKey(value: unknown): string | null {
  if (!isPlain(value)) return null;
  const pairs: string[] = [];
  for (const key of Object.keys(value)) {
    const label = text(value[key]);
    if (label === null) continue;
    if (LABEL_SEPARATORS.test(key) || LABEL_SEPARATORS.test(label)) return null;
    pairs.push(`${key}=${label}`);
  }
  if (pairs.length === 0) return null;
  return pairs.sort(compareStrings).join(",");
}

function labelMap(value: unknown): Map<string, string> | null {
  const key = labelKey(value);
  if (key === null) return null;
  const labels = new Map<string, string>();
  for (const pair of key.split(",")) {
    const equals = pair.indexOf("=");
    labels.set(pair.slice(0, equals), pair.slice(equals + 1));
  }
  return labels;
}

/** The pod labels a workload stamps on its pods; see the same rule in `extract/yaml-k8s.ts`. */
function podLabelsOf(document: unknown, kind: string): Map<string, string> | null {
  let found: Map<string, string> | null = null;
  walk(document, (key, entry) => {
    if (found !== null || key !== "template") return;
    const labels = labelMap(get(entry, "metadata", "labels"));
    if (labels !== null) found = labels;
  });
  if (found !== null) return found;
  if (kind === "Pod") return labelMap(get(document, "metadata", "labels"));
  return null;
}

/** A name `nodeId` would accept. */
function usableName(value: string | null): value is string {
  return value !== null && value !== "" && !/[#\n\0]/u.test(value);
}

// ---------------------------------------------------------------------------
// the node and edge sets
// ---------------------------------------------------------------------------

interface OracleNode {
  readonly id: string;
  readonly name: string;
  readonly file: string;
}

interface FileReading {
  readonly nodes: OracleNode[];
  /** Resource nodes by name (`ConfigMap.web-config`), for the config-ref lookup. */
  readonly resources: Array<{ readonly id: string; readonly name: string }>;
  /** Workloads with pod labels, for the selector lookup. */
  readonly workloads: Array<{ readonly id: string; readonly labels: ReadonlyMap<string, string> }>;
  /** Requests, before resolution: the from-node id and what it asked for. */
  readonly selectors: Array<{ readonly from: string; readonly labels: ReadonlyMap<string, string>; readonly key: string }>;
  readonly configRefs: Array<{ readonly from: string; readonly name: string; readonly key: string }>;
  readonly images: Array<{ readonly from: string; readonly image: string }>;
}

function emptyReading(): FileReading {
  return { nodes: [], resources: [], workloads: [], selectors: [], configRefs: [], images: [] };
}

/** One file's documents, or null when js-yaml could not read it at all. */
function documentsOf(root: string, file: string): unknown[] | null {
  let source: string;
  try {
    source = readFileSync(path.join(root, file), "utf8");
  } catch {
    return null;
  }
  const documents: unknown[] = [];
  try {
    loadAll(source, (document) => {
      documents.push(document);
    });
  } catch {
    return null;
  }
  return documents;
}

/** Everything one manifest declares and asks for, by the rules of spec 2.3. */
function readFile(root: string, file: string): FileReading | null {
  const documents = documentsOf(root, file);
  if (documents === null) return null;

  const reading = emptyReading();
  const used = new Set<string>();
  /**
   * The uniqueness suffix rule, restated: the **id** takes `~2`, the name never does (driver
   * ruling 2026-09-04). Two `ConfigMap`s called `web-config` are two nodes and one name, so a
   * `configMapRef` naming it finds two candidates and resolves to nothing.
   */
  const uniqueId = (kind: string, name: string): string => {
    const base = `${file}#${kind}.${name}`;
    let candidate = base;
    for (let n = 2; used.has(candidate); n += 1) candidate = `${base}~${n}`;
    used.add(candidate);
    return candidate;
  };
  const add = (kind: string, name: string): OracleNode => {
    const node: OracleNode = { id: uniqueId(kind, name), name, file };
    reading.nodes.push(node);
    return node;
  };

  for (let index = 0; index < documents.length; index += 1) {
    const document = documents[index];
    if (!isPlain(document)) continue;
    const kind = text(document["kind"]);
    const apiVersion = text(document["apiVersion"]);
    if (!usableName(kind) || apiVersion === null) continue;

    const name = text(get(document, "metadata", "name"));
    const nodeName = usableName(name) ? `${kind}.${name}` : `${kind}.~${index}`;
    const resource = add("resource", nodeName);
    reading.resources.push({ id: resource.id, name: resource.name });

    const podLabels = podLabelsOf(document, kind);
    if (podLabels !== null) reading.workloads.push({ id: resource.id, labels: podLabels });

    // Images, in the order the containers were written.
    walk(document, (key, entry) => {
      if (!CONTAINER_KEYS.has(key) || !Array.isArray(entry)) return;
      for (const container of entry) {
        if (!isPlain(container)) continue;
        const containerName = text(container["name"]);
        const image = text(container["image"]);
        const node = add("image", usableName(containerName) ? containerName : `~${index}`);
        if (image !== null && image !== "") reading.images.push({ from: node.id, image });
      }
    });

    // A Service or NetworkPolicy selector.
    const selectorPath = SELECTOR_PATHS[kind];
    if (selectorPath !== undefined) {
      const selector = get(document, ...selectorPath);
      const labels = labelMap(selector);
      const key = labelKey(selector);
      if (labels !== null && key !== null && [...labels.values()].every((value) => value !== "")) {
        reading.selectors.push({ from: resource.id, labels, key });
      }
    }

    // Every ConfigMap, Secret or PVC the document names.
    walk(document, (key, entry) => {
      const rule = CONFIG_REFS[key];
      if (rule === undefined) return;
      const named = text(get(entry, rule.nameKey));
      if (!usableName(named) || named.includes("/")) return;
      reading.configRefs.push({ from: resource.id, name: `${rule.kind}.${named}`, key: `${rule.kind}/${named}` });
    });
  }
  return reading;
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

interface Run {
  readonly covered: string[];
  readonly readings: Map<string, FileReading>;
}

/**
 * Read every requested file, with the integrity guard that stops an empty truth from scoring as
 * a perfect one (tech spec 10.1, principle 2).
 */
function coveredRun(root: string, files: string[]): Run {
  const absRoot = path.resolve(root);
  const readings = new Map<string, FileReading>();
  for (const file of [...files].sort(compareStrings)) {
    const reading = readFile(absRoot, file);
    if (reading === null) continue;
    readings.set(file, reading);
  }
  if (files.length > 0 && readings.size === 0) {
    throw new Error(
      `greplost: yaml-k8s truth is empty for ${absRoot} (js-yaml read none of the ${files.length} requested files)`,
    );
  }
  return { covered: [...readings.keys()].sort(compareStrings), readings };
}

/**
 * A reference edge as the S5 scorer wants it: an `Edge` plus the `refKind` that makes its
 * identity `(from, to, refKind)` rather than `(from, to)` (driver ruling 2026-09-04).
 */
export type ReferenceTruth = Edge & { readonly refKind: string };

function edge(from: string, to: string, refKind: string, symbol: string, confidence: "high" | "med"): ReferenceTruth {
  return { from, to, kind: "reference", refKind, symbols: [symbol], confidence };
}

/**
 * Manifest truth for `files` (repo-relative posix paths) under `root`.
 *
 * `exports` is each covered file's sorted node names; `imports`, `calls` and `cycles` are all
 * empty, because a manifest has none of them and saying so is not the same as failing to find
 * any.
 */
export function generateTruth(root: string, files: string[]): Truth {
  const { covered, readings } = coveredRun(root, files);
  const exports: Record<string, string[]> = {};
  for (const file of covered) {
    // Sorted node *names*, deduplicated: two documents with one name are one export record,
    // exactly as `extract/yaml-k8s.ts` writes it.
    const names = new Set((readings.get(file) as FileReading).nodes.map((node) => node.name));
    exports[file] = [...names].sort(compareStrings);
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
 * The reference and node sets S5 and S6 are scored on (`TruthModule.generateExtra`).
 *
 * Resolution is repo-wide and unique, exactly as spec 2.3 states it: a selector whose labels are
 * a subset of exactly one workload's pod labels, a `<Kind>/<name>` matching exactly one resource
 * node **by written name**, so two same-named `ConfigMap`s are two candidates and neither side
 * draws an edge. Anything ambiguous produces no edge here either, so an oracle can never demand
 * a guess.
 */
export function generateExtra(
  root: string,
  files: string[],
): { references: Edge[]; nodes: string[]; nodeFiles: string[] } {
  const { covered, readings } = coveredRun(root, files);

  const workloads: Array<{ id: string; labels: ReadonlyMap<string, string> }> = [];
  const resourcesByName = new Map<string, string[]>();
  const nodes: string[] = [];
  for (const file of covered) {
    const reading = readings.get(file) as FileReading;
    for (const node of reading.nodes) nodes.push(node.id);
    for (const workload of reading.workloads) workloads.push(workload);
    for (const resource of reading.resources) {
      const bucket = resourcesByName.get(resource.name);
      if (bucket === undefined) resourcesByName.set(resource.name, [resource.id]);
      else bucket.push(resource.id);
    }
  }

  const references: ReferenceTruth[] = [];
  for (const file of covered) {
    const reading = readings.get(file) as FileReading;

    for (const selector of reading.selectors) {
      let found: string | null = null;
      let ambiguous = false;
      for (const workload of workloads) {
        let matches = true;
        for (const [key, value] of selector.labels) {
          if (workload.labels.get(key) !== value) {
            matches = false;
            break;
          }
        }
        if (!matches) continue;
        if (found !== null) {
          ambiguous = true;
          break;
        }
        found = workload.id;
      }
      if (found !== null && !ambiguous) references.push(edge(selector.from, found, "selector", selector.key, "high"));
    }

    for (const config of reading.configRefs) {
      const found = resourcesByName.get(config.name);
      if (found === undefined || found.length !== 1) continue;
      references.push(edge(config.from, found[0] as string, "config-ref", config.key, "high"));
    }

    for (const image of reading.images) {
      references.push(edge(image.from, `ext:image/${image.image}`, "from-image", image.image, "high"));
    }
  }

  references.sort(compareEdges);
  // Every covered manifest states its own nodes, so S6 scores all of them. The field exists for
  // the flavour that cannot say that of every file it covers (`truth/yaml-helm.ts`), and naming
  // the files here is what keeps a merged YAML truth from inheriting that restriction.
  return { references: dedupe(references), nodes: nodes.sort(compareStrings), nodeFiles: [...covered] };
}

/** Adjacent duplicates only: the list is already sorted by every field that identifies an edge. */
function dedupe(edges: readonly ReferenceTruth[]): ReferenceTruth[] {
  const out: ReferenceTruth[] = [];
  for (const candidate of edges) {
    const previous = out[out.length - 1];
    if (previous !== undefined && compareEdges(previous, candidate) === 0) continue;
    out.push(candidate);
  }
  return out;
}
