/**
 * Kubernetes manifest extraction (build 2, spec 2026-09-04 section 2.3).
 *
 * A manifest declares objects and points at other objects by *name*, so like Terraform it has
 * no calls and no imports at all: everything it says about its neighbours is a
 * `ReferenceRecord` that `references/yaml-k8s.ts` resolves. Reached through the flavour
 * dispatcher in `extract/yaml.ts`, never from `extractFile` directly.
 *
 * Three kinds of output, and the rules that decide each:
 *
 *  - **Declarations.** One `resource` node per document that has both `apiVersion` and `kind`,
 *    named `<kind>.<metadata.name>`, and one `image` node per container, named after the
 *    container. Both `apiVersion` and `kind` must be *literal*: a Helm template that writes
 *    `kind: {{ .Values.master.kind }}` is a document whose kind nobody can know without running
 *    helm, and a node called `resource.______.~0` would be a guess wearing an id (leaf 2.8
 *    ruling). A missing or templated **name** is different, and is what the spec's
 *    document-index fallback is for.
 *  - **Exports.** A manifest's `Declaration.exported` is `false` for every node, exactly as the
 *    spec says — and the *file record* still lists its node names in `exports`, because that is
 *    the channel `FileEntry.exports` reads and a `ConfigMap` named `web-config` is precisely
 *    what another manifest reaches for by name. The two statements do not collide:
 *    `buildExportIndex` never takes a non-file node from the declaration side (`isNodeKind`),
 *    so the export record is the only way a node name can appear there at all, and it is the
 *    same route `extract/hcl.ts` takes for a Terraform `variable`.
 *  - **References.** `selector` (a Service or NetworkPolicy selecting pods), `config-ref` (a
 *    ConfigMap, Secret or PVC named by a workload) and `from-image` (a container's image).
 *    Nothing is resolved here: `to` is language-native text and `references/yaml-k8s.ts` maps
 *    it onto the one node it can mean, or drops it.
 *
 * Nothing in this file reads the filesystem or knows about another file (tech spec 5.1). The
 * Helm flavour reuses every rule here through `extractK8sDocuments`; the differences it needs —
 * the template pre-pass, `Chart.yaml`, `values.yaml` and `.Values` references — live in
 * `extract/yaml-helm.ts`.
 */

import type { Node, Tree } from "web-tree-sitter";
import type {
  DeclKind,
  Declaration,
  ExportRecord,
  FileRecord,
  Lang,
  ReferenceRecord,
} from "../schema.ts";
import { compareStrings, nodeId, splitNodeId } from "../schema.ts";
import { clip, lineOf } from "./ts-signature.ts";
import type { YamlValue } from "./yaml-doc.ts";
import { documentValue, mapPath, scalarMap, seqItems, walk, yamlDocuments } from "./yaml-doc.ts";

/** Which YAML dialect produced a node; recorded on every declaration as `meta.flavour`. */
export type K8sFlavour = "k8s" | "helm";

/** Keys whose value is a list of containers, wherever in a document they appear. */
const CONTAINER_KEYS: ReadonlySet<string> = new Set(["containers", "initContainers", "ephemeralContainers"]);

/**
 * Config references, by the key that introduces them: the key holding the name, and the kind
 * of object the name belongs to (spec 2.3, "References").
 *
 * Exactly the six the spec lists. A seventh that looks just as reasonable — a volume's
 * `secret.secretName` — is deliberately absent: every rule here has to be restated by an
 * independent oracle, and a rule only one side implements is a false positive by construction.
 */
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

/**
 * Characters a label key or value may not contain if the pair is to survive the round trip
 * through `ReferenceRecord.to`, which spells a label set as `k=v,k=v`.
 *
 * Kubernetes label syntax allows neither, so this only ever rejects something that was never a
 * label; rejecting it is still better than emitting a reference the resolver would misread.
 */
const LABEL_SEPARATORS = /[,=]/u;

// ---------------------------------------------------------------------------
// accumulator
// ---------------------------------------------------------------------------

/**
 * What the Helm flavour hands in: the source to read spans and text from, and the byte ranges
 * the template pre-pass blanked.
 *
 * `source` is the *blanked* text the tree was parsed from and `raw` is the file as written;
 * they are the same length by construction, so a node's offsets index either one. `blanks` is
 * sorted and non-overlapping.
 */
export interface K8sInput {
  readonly path: string;
  readonly source: string;
  readonly raw: string;
  readonly tree: Tree;
  readonly flavour: K8sFlavour;
  readonly blanks: ReadonlyArray<readonly [number, number]>;
}

interface K8sState {
  readonly input: K8sInput;
  readonly decls: Declaration[];
  readonly exports: ExportRecord[];
  readonly refs: ReferenceRecord[];
  /** Declaration ids already used in this file, so a duplicate name can take a `~<n>` suffix. */
  readonly usedIds: Set<string>;
  /** Exported names already recorded, so two documents with one name are one export record. */
  readonly exportedNames: Set<string>;
}

/**
 * True for a manifest, false for a Helm template: whether this file's *names* are names.
 *
 * A chart template's object *names* are values chosen when the chart is rendered, not names
 * anything else in the repository can reach for — spec 2.3 says the same thing as "names are
 * not compared". So a template's record exports nothing, and neither `selector` nor
 * `config-ref` is drawn from one: both are lookups by name, and one built from the handful of
 * labels a chart happens to write literally would be a fragment of a graph that only exists
 * after `helm template` has run (leaf 2.8 ruling).
 *
 * It does **not** cover `from-image`. A literal `image: busybox:1.36` in a template is fully
 * rendered text that names the image which will run, so that edge is drawn in a chart exactly
 * as in a manifest; only an image built out of a template action is withheld, and that test is
 * `image.templated`, not this one (fix round 1).
 */
function namesAreNames(state: K8sState): boolean {
  return state.input.flavour === "k8s";
}

/**
 * A declaration id made unique within the file: `…#resource.ConfigMap.web`, then `…~2`.
 *
 * The suffix lives in the **id and nowhere else** (driver ruling 2026-09-04, the same rule
 * `extract/hcl.ts` follows): `name` stays as the file wrote it, because the name is what every
 * other manifest writes when it reaches for the object — `configMapRef: { name: web-config }`
 * names *both* of two same-named ConfigMaps, and a suffixed name would make the second one
 * silently distinguishable and turn an ambiguous reference into a certain one. It is also what
 * the export index publishes, and `ConfigMap.web-config~2` is a name nobody wrote.
 *
 * `~` rather than the `#<index>` spec 0.2 sketches, because a `#` in the name segment would
 * make the id unreadable by `splitNodeId`; `~` cannot occur in a Kubernetes name, so a suffixed
 * id can never collide with one somebody wrote. The same substitution turns the spec's
 * `<kind>.#<docIndex>` fallback into `<kind>.~<docIndex>`.
 */
function uniqueId(state: K8sState, kind: DeclKind, name: string): string {
  const base = nodeId(state.input.path, kind, name);
  if (!state.usedIds.has(base)) {
    state.usedIds.add(base);
    return base;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base}~${n}`;
    if (state.usedIds.has(candidate)) continue;
    state.usedIds.add(candidate);
    return candidate;
  }
}

/**
 * The part of a declaration's id after the `#`: what a `ReferenceRecord.from` must carry.
 *
 * Read back through `splitNodeId` rather than rebuilt from `kind` and `name`, so the suffix
 * that distinguishes two same-named documents reaches the reference and the bare name does not.
 */
function localPath(declaration: Declaration): string {
  const parts = splitNodeId(declaration.id);
  return parts === null ? declaration.name : `${parts.kind}.${parts.name}`;
}

/** `meta` with sorted keys, dropping every absent entry; undefined when nothing was recorded. */
function metaOf(entries: ReadonlyArray<readonly [string, string | null]>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of [...entries].sort((a, b) => compareStrings(a[0], b[0]))) {
    if (value !== null && value !== "") out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Add one node, and the export record that puts its name in `FileEntry.exports`.
 *
 * `exported` is `false` on every Kubernetes and Helm declaration (spec 2.3); see the module
 * docstring for why the export record is nonetheless the right thing to write.
 */
function addNode(
  state: K8sState,
  kind: DeclKind,
  name: string,
  signature: string,
  node: Node,
  meta: Record<string, string> | undefined,
): Declaration {
  const declaration: Declaration = {
    id: uniqueId(state, kind, name),
    file: state.input.path,
    name,
    kind,
    signature: clip(signature),
    exported: false,
    span: trimmedSpan(state, node),
    ...(meta === undefined ? {} : { meta }),
  };
  state.decls.push(declaration);
  // One record per exported *name*: two `ConfigMap`s called `web-config` are one export, not
  // two, and never a `web-config~2` nobody wrote.
  if (namesAreNames(state) && !state.exportedNames.has(name)) {
    state.exportedNames.add(name);
    state.exports.push({ name, kind: "named" });
  }
  return declaration;
}

function addReference(
  state: K8sState,
  from: string,
  to: string,
  refKind: ReferenceRecord["refKind"],
  line: number,
): void {
  state.refs.push({ from, to, refKind, line });
}

// ---------------------------------------------------------------------------
// templated scalars
// ---------------------------------------------------------------------------

/** True when a node's byte range overlaps a span the Helm pre-pass blanked. */
function isTemplated(state: K8sState, node: Node): boolean {
  for (const [start, end] of state.input.blanks) {
    if (node.startIndex < end && start < node.endIndex) return true;
  }
  return false;
}

/**
 * A scalar as it was *written*, before the pre-pass: the raw bytes under the node.
 *
 * The blanked text and the file are the same length, so the node's offsets index both.
 */
function rawTextOf(state: K8sState, node: Node): string {
  return state.input.raw.slice(node.startIndex, node.endIndex).trim();
}

/** A scalar value read at a path, with the template question answered alongside it. */
interface Reading {
  /** The scalar text, or null when the key is absent or its value is not a scalar. */
  readonly text: string | null;
  /** True when the scalar overlaps a blanked template span. */
  readonly templated: boolean;
  /** The raw text as written, for a templated scalar. */
  readonly raw: string | null;
}

const ABSENT: Reading = { text: null, templated: false, raw: null };

function read(state: K8sState, value: YamlValue | null, ...keys: readonly string[]): Reading {
  const found = mapPath(value, ...keys);
  if (found === null || found.shape !== "scalar") return ABSENT;
  const templated = isTemplated(state, found.node);
  return {
    text: found.text,
    templated,
    raw: templated ? rawTextOf(state, found.node) : null,
  };
}

/**
 * A node's line span, with trailing blank lines cut off.
 *
 * A YAML block node runs to the start of whatever comes next, so its `endPosition` is the line
 * *after* the document — one line past the last thing anybody wrote. Every other language's
 * span ends on a closing brace, so the difference would show up only here, as a card claiming a
 * line the node does not occupy.
 */
function trimmedSpan(state: K8sState, node: Node): [number, number] {
  const source = state.input.source;
  let end = node.endIndex;
  let rows = node.endPosition.row + 1;
  while (end > node.startIndex && /\s/u.test(source[end - 1] as string)) {
    if (source[end - 1] === "\n") rows -= 1;
    end -= 1;
  }
  const start = node.startPosition.row + 1;
  return [start, Math.max(start, rows)];
}

/** A name that `nodeId` will accept: no `#`, newline or NUL, and not empty. */
function usableName(text: string | null): text is string {
  return text !== null && text !== "" && !/[#\n\0]/u.test(text);
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

/** `app=web,tier=front`: a label set spelled so it survives a `ReferenceRecord.to`. */
export function labelKey(labels: ReadonlyMap<string, string>): string | null {
  const pairs: string[] = [];
  for (const [key, value] of labels) {
    if (LABEL_SEPARATORS.test(key) || LABEL_SEPARATORS.test(value)) return null;
    pairs.push(`${key}=${value}`);
  }
  if (pairs.length === 0) return null;
  return pairs.sort(compareStrings).join(",");
}

/**
 * The pod labels a workload stamps on the pods it creates.
 *
 * `spec.template.metadata.labels` for everything that has a pod template, at whatever depth the
 * template sits (a CronJob's is two levels down), and a bare `Pod`'s own `metadata.labels`.
 * Recorded on the node as `meta.podLabels` because the reference layer sees declarations and
 * not documents: without it a `Service` selector could never be matched against a workload
 * (leaf 2.8 ruling; `meta` is exactly the place spec 0.1 puts an attribute with no other home).
 */
function podLabelsOf(document: YamlValue, kind: string): Map<string, string> {
  let found: Map<string, string> | null = null;
  walk(document, (entry) => {
    if (found !== null || entry.key !== "template") return;
    const labels = scalarMap(mapPath(entry.value, "metadata", "labels"));
    if (labels.size > 0) found = labels;
  });
  if (found !== null) return found;
  if (kind === "Pod") return scalarMap(mapPath(document, "metadata", "labels"));
  return new Map<string, string>();
}

// ---------------------------------------------------------------------------
// one document
// ---------------------------------------------------------------------------

function collectDocument(state: K8sState, document: Node, index: number): void {
  const value = documentValue(document);
  if (value.shape !== "map") return;

  const apiVersion = read(state, value, "apiVersion");
  const kind = read(state, value, "kind");
  // Both halves of a resource's identity have to be literal. A templated one is not a name the
  // map could ever show, and `<kind>` is part of the node id itself.
  if (!usableName(kind.text) || kind.templated) return;
  if (apiVersion.text === null || apiVersion.templated) return;

  const name = read(state, value, "metadata", "name");
  const templated = name.templated || !usableName(name.text);
  const nodeName = templated ? `${kind.text}.~${index}` : `${kind.text}.${name.text as string}`;
  const namespace = read(state, value, "metadata", "namespace");
  const podLabels = podLabelsOf(value, kind.text);

  const resource = addNode(
    state,
    "resource",
    nodeName,
    `${kind.text} ${name.raw ?? name.text ?? ""}`,
    value.node,
    metaOf([
      ["apiVersion", apiVersion.text],
      ["flavour", state.input.flavour],
      ["kind", kind.text],
      ["nameTemplate", name.raw],
      ["namespace", namespace.templated ? null : namespace.text],
      ["podLabels", labelKey(podLabels)],
      ["templated", templated && name.raw !== null ? "1" : null],
    ]),
  );
  const owner = localPath(resource);

  collectImages(state, value, index);
  collectSelector(state, value, kind.text, owner);
  collectConfigRefs(state, value, owner);
}

/**
 * One `image` node per container, in the order the containers were written.
 *
 * Containers are found by key rather than by path: `spec.containers` in a Pod,
 * `spec.template.spec.containers` in a Deployment and `spec.jobTemplate.spec.template.spec.
 * containers` in a CronJob are the same list, and a kind nobody enumerated would otherwise
 * contribute nothing.
 */
function collectImages(state: K8sState, document: YamlValue, index: number): void {
  walk(document, (entry) => {
    if (!CONTAINER_KEYS.has(entry.key)) return;
    for (const container of seqItems(entry.value)) {
      if (container.shape !== "map") continue;
      const name = read(state, container, "name");
      const image = read(state, container, "image");
      const templated = name.templated || !usableName(name.text);
      const nodeName = templated ? `~${index}` : (name.text as string);
      const node = addNode(
        state,
        "image",
        nodeName,
        `${name.raw ?? name.text ?? ""}: ${image.raw ?? image.text ?? ""}`,
        container.node,
        metaOf([
          ["container", name.raw ?? name.text],
          ["flavour", state.input.flavour],
          ["image", image.templated ? null : image.text],
          ["imageTemplate", image.raw],
          ["nameTemplate", name.raw],
          ["templated", templated && name.raw !== null ? "1" : image.templated ? "1" : null],
        ]),
      );
      // An image reference built from a template action is not an image reference: greplost
      // never runs helm, so `ext:image/______:____` would be an invented external node. A
      // *literal* one is different, in a chart as much as in a manifest — `image: busybox:1.36`
      // is fully rendered text and names the image that will actually run — so this is the one
      // reference a template does draw besides `helm-values` (fix round 1).
      if (image.text !== null && !image.templated) {
        addReference(state, localPath(node), image.text, "from-image", lineOf(container.node));
      }
    }
  });
}

/** A `Service` or `NetworkPolicy` selector, recorded as the label set it asks for. */
function collectSelector(state: K8sState, document: YamlValue, kind: string, owner: string): void {
  if (!namesAreNames(state)) return;
  const path = SELECTOR_PATHS[kind];
  if (path === undefined) return;
  const selector = mapPath(document, ...path);
  if (selector === null) return;
  const labels = scalarMap(selector);
  // An empty selector selects everything in Kubernetes and nothing here: an edge to every
  // workload in the repo is not a dependency anybody can read.
  const key = labelKey(labels);
  if (key === null) return;
  for (const [, value] of labels) if (value === "") return;
  addReference(state, owner, key, "selector", lineOf(selector.node));
}

/** Every `ConfigMap`, `Secret` or `PVC` the document names, as `<Kind>/<name>`. */
function collectConfigRefs(state: K8sState, document: YamlValue, owner: string): void {
  if (!namesAreNames(state)) return;
  walk(document, (entry) => {
    const rule = CONFIG_REFS[entry.key];
    if (rule === undefined) return;
    const name = read(state, entry.value, rule.nameKey);
    if (name.templated || !usableName(name.text) || name.text.includes("/")) return;
    addReference(state, owner, `${rule.kind}/${name.text}`, "config-ref", lineOf(entry.keyNode));
  });
}

// ---------------------------------------------------------------------------
// entry points
// ---------------------------------------------------------------------------

/** What a flavour module gets back: everything but the file's own identity. */
export type YamlParts = Pick<FileRecord, "decls" | "imports" | "exports" | "calls" | "refs">;

/**
 * Every node and reference the documents of one file declare.
 *
 * Shared with `extract/yaml-helm.ts`, which hands in the blanked source and the spans it
 * blanked; the Kubernetes flavour hands in the file unchanged and no spans at all.
 */
export function extractK8sDocuments(input: K8sInput): YamlParts {
  const state: K8sState = {
    input,
    decls: [],
    exports: [],
    refs: [],
    usedIds: new Set<string>(),
    exportedNames: new Set<string>(),
  };

  const documents = yamlDocuments(input.tree.rootNode);
  for (let index = 0; index < documents.length; index += 1) {
    collectDocument(state, documents[index] as Node, index);
  }

  return {
    decls: state.decls,
    exports: state.exports,
    // A manifest has neither imports nor calls (spec 2.3): S3 is `n/a` for every YAML target.
    imports: [],
    calls: [],
    refs: state.refs,
  };
}

/**
 * Everything one Kubernetes `.yaml` file says about itself. `lang` is always `"yaml"`; it is
 * part of the signature so this module mirrors `extractHcl` and `extractGo`.
 */
export function extractYamlK8s(path: string, _lang: Lang, source: string, tree: Tree): YamlParts {
  return extractK8sDocuments({ path, source, raw: source, tree, flavour: "k8s", blanks: [] });
}

