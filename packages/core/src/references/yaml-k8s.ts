/**
 * Kubernetes and Helm reference rules (build 2, spec 2026-09-04 sections 0.3 and 2.3).
 *
 * `extract/yaml-k8s.ts` records what a manifest *asks for*, a label set, a `<Kind>/<name>` pair,
 * an image reference, a `.Values` path, and this module decides which node that is, or drops
 * it. The rule is the one that governs call edges (tech spec 5.1): `high` when the request
 * lands on exactly one node, `med` for exactly one documented hop, **anything ambiguous
 * dropped, never guessed**.
 *
 * Four mechanisms, and the scope each searches:
 *
 *  - `selector`, a `Service` or `NetworkPolicy` label set against every workload's pod-template
 *    labels (`meta.podLabels`, recorded by the extractor because the reference layer sees
 *    declarations and not documents). Subset, not equality: a Service asking for `app=web` picks
 *    a workload labelled `app=web,tier=front`. Exactly one match is `high`; two are two
 *    plausible answers and the edge is dropped.
 *  - `config-ref`, `<Kind>/<name>` against the `resource` nodes named `<Kind>.<name>`. Exactly
 *    one is `high`. The scope is the whole indexed repo rather than a namespace, because a
 *    manifest's namespace is frequently set at apply time and a name that is ambiguous inside
 *    the repo is ambiguous, full stop.
 *  - `from-image`, always `ext:image/<ref>`, `high`. The reference is the image the container
 *    was written with; nothing has to be looked up for it to be true.
 *  - `helm-values`, `.Values.<path>` to the chart's `values.yaml` node for the path's **first**
 *    segment, `med`: one documented hop, from the template to the chart's values file. The chart
 *    root is the nearest ancestor directory of the template that holds an indexed `values.yaml`,
 *    which is exactly the rule `helm` itself applies.
 *
 * Nothing here ever returns an `unresolved:` target (spec 0.3): a reference the map cannot place
 * is not an edge at all.
 */

import type { Declaration, FileRecord, ReferenceEdge, ReferenceRecord } from "../schema.ts";
import { externalId, nodeId } from "../schema.ts";
import type { ReferenceContext } from "./link.ts";
import { referenceSource } from "./link.ts";

/** Chart values files, in the order `helm` itself would look for them. */
const VALUES_FILES: readonly string[] = ["values.yaml", "values.yml"];

/**
 * Per-build workload index, built on first use and thrown away with the context that owns it.
 *
 * `linkReferences` calls this module once per reference with the same `ReferenceContext`, so a
 * repo with 3,000 selectors walks the declaration set once rather than 3,000 times.
 */
const WORKLOADS_BY_CONTEXT = new WeakMap<ReferenceContext, readonly Workload[]>();
const RESOURCES_BY_CONTEXT = new WeakMap<ReferenceContext, ReadonlyMap<string, readonly Declaration[]>>();

interface Workload {
  readonly decl: Declaration;
  readonly labels: ReadonlyMap<string, string>;
}

/** `app=web,tier=front` -> the map it spells. Null when the text is not a label set. */
function parseLabels(text: string): Map<string, string> | null {
  const labels = new Map<string, string>();
  for (const pair of text.split(",")) {
    const equals = pair.indexOf("=");
    if (equals <= 0) return null;
    labels.set(pair.slice(0, equals), pair.slice(equals + 1));
  }
  return labels.size === 0 ? null : labels;
}

function workloadsFor(ctx: ReferenceContext): readonly Workload[] {
  const cached = WORKLOADS_BY_CONTEXT.get(ctx);
  if (cached !== undefined) return cached;

  const workloads: Workload[] = [];
  for (const decl of ctx.nodesByKind.get("resource") ?? []) {
    const podLabels = decl.meta?.["podLabels"];
    if (podLabels === undefined) continue;
    const labels = parseLabels(podLabels);
    if (labels !== null) workloads.push({ decl, labels });
  }
  WORKLOADS_BY_CONTEXT.set(ctx, workloads);
  return workloads;
}

/** `resource` nodes by name (`ConfigMap.web-config`), across the whole indexed repo. */
function resourcesFor(ctx: ReferenceContext): ReadonlyMap<string, readonly Declaration[]> {
  const cached = RESOURCES_BY_CONTEXT.get(ctx);
  if (cached !== undefined) return cached;

  const byName = new Map<string, Declaration[]>();
  for (const decl of ctx.nodesByKind.get("resource") ?? []) {
    const bucket = byName.get(decl.name);
    if (bucket === undefined) byName.set(decl.name, [decl]);
    else bucket.push(decl);
  }
  RESOURCES_BY_CONTEXT.set(ctx, byName);
  return byName;
}

function edge(
  file: FileRecord,
  ref: ReferenceRecord,
  to: string,
  confidence: ReferenceEdge["confidence"],
): ReferenceEdge {
  return {
    from: referenceSource(file.path, ref),
    to,
    kind: "reference",
    refKind: ref.refKind,
    // The language-native request that produced the edge, so a card can show *why* it exists.
    symbols: [ref.to],
    confidence,
  };
}

/** The one workload whose pod labels are a superset of `selector`, or null when not exactly one. */
function resolveSelector(file: FileRecord, ref: ReferenceRecord, ctx: ReferenceContext): ReferenceEdge | null {
  const wanted = parseLabels(ref.to);
  if (wanted === null) return null;

  let found: Declaration | null = null;
  for (const workload of workloadsFor(ctx)) {
    let matches = true;
    for (const [key, value] of wanted) {
      if (workload.labels.get(key) !== value) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    // Two workloads answer the selector: two plausible edges, so neither is drawn.
    if (found !== null) return null;
    found = workload.decl;
  }
  return found === null ? null : edge(file, ref, found.id, "high");
}

/** `<Kind>/<name>` -> the one `resource` node called `<Kind>.<name>`. */
function resolveConfigRef(file: FileRecord, ref: ReferenceRecord, ctx: ReferenceContext): ReferenceEdge | null {
  const slash = ref.to.indexOf("/");
  if (slash <= 0) return null;
  const name = `${ref.to.slice(0, slash)}.${ref.to.slice(slash + 1)}`;
  const found = resourcesFor(ctx).get(name);
  if (found === undefined || found.length !== 1) return null;
  return edge(file, ref, (found[0] as Declaration).id, "high");
}

/**
 * The chart's `values.yaml`: the nearest ancestor directory of `from` that holds one.
 *
 * A template lives at `<chart>/templates/…`, so the walk finds the chart root without the
 * extractor ever reading the filesystem, which it may not (tech spec 5.1).
 */
function chartValuesFile(from: string, ctx: ReferenceContext): string | null {
  let dir = from.slice(0, Math.max(from.lastIndexOf("/"), 0));
  for (;;) {
    for (const base of VALUES_FILES) {
      const candidate = dir === "" ? base : `${dir}/${base}`;
      if (candidate !== from && ctx.files.has(candidate)) return candidate;
    }
    if (dir === "") return null;
    dir = dir.slice(0, Math.max(dir.lastIndexOf("/"), 0));
  }
}

/** `.Values.<first>.<rest>` -> `<chart>/values.yaml#variable.<first>`, one documented hop. */
function resolveHelmValues(file: FileRecord, ref: ReferenceRecord, ctx: ReferenceContext): ReferenceEdge | null {
  const path = ref.to.startsWith(".Values.") ? ref.to.slice(".Values.".length) : null;
  if (path === null || path === "") return null;
  const first = path.split(".")[0] as string;
  if (first === "") return null;

  const values = chartValuesFile(file.path, ctx);
  if (values === null) return null;
  const id = nodeId(values, "variable", first);
  return ctx.declarationById.has(id) ? edge(file, ref, id, "med") : null;
}

/**
 * One Kubernetes or Helm reference, resolved to the node it names, or null when it names no
 * single one.
 */
export function resolveYamlK8sReferences(
  file: FileRecord,
  ref: ReferenceRecord,
  ctx: ReferenceContext,
): ReferenceEdge | null {
  switch (ref.refKind) {
    case "selector":
      return resolveSelector(file, ref, ctx);
    case "config-ref":
      return resolveConfigRef(file, ref, ctx);
    case "from-image":
      return ref.to === "" ? null : edge(file, ref, externalId(`image/${ref.to}`), "high");
    case "helm-values":
      return resolveHelmValues(file, ref, ctx);
    default:
      return null;
  }
}
