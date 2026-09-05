/**
 * YAML truth flavour dispatcher (build 2; owned by the seam, leaf 2.0).
 *
 * The oracle-side mirror of `packages/core/src/extract/yaml.ts`: `loadTruth("yaml")` lands
 * here, this module splits the file list into workflows, charts and manifests, asks each
 * flavour's oracle for its share and merges the answers. Leaves 2.8 and 2.9 replace those
 * flavour modules and never touch this file.
 *
 * Oracle independence (bench spec 1.6): nothing here imports `packages/core` or tree-sitter,
 * so the path rules `extract/yaml.ts` applies are restated rather than shared. That is the
 * point of an oracle: one that reused greplost's own classifier could not disagree with it,
 * and a scorer that cannot disagree measures nothing.
 */

import type { Edge } from "@greplost/core/schema";
import type { Truth } from "./ts.ts";
import {
  generateExtra as generateActionsExtra,
  generateTruth as generateActionsTruth,
  isActionsFile,
} from "./yaml-actions.ts";
import { generateExtra as generateHelmExtra, generateTruth as generateHelmTruth } from "./yaml-helm.ts";
import { generateExtra as generateK8sExtra, generateTruth as generateK8sTruth } from "./yaml-k8s.ts";

export const NOTES: readonly string[] = ["yaml-flavour-dispatch"];

/** Chart files that mark a directory as a Helm chart, whatever else is in it. */
const CHART_FILES: ReadonlySet<string> = new Set(["Chart.yaml", "Chart.yml", "values.yaml", "values.yml"]);

export type YamlFlavour = "yaml-actions" | "yaml-helm" | "yaml-k8s";

/** Flavour order, so a merged truth does not depend on which files happened to come first. */
const FLAVOURS: readonly YamlFlavour[] = ["yaml-actions", "yaml-helm", "yaml-k8s"];

const GENERATORS: Readonly<Record<YamlFlavour, (root: string, files: string[]) => Truth>> = {
  "yaml-actions": generateActionsTruth,
  "yaml-helm": generateHelmTruth,
  "yaml-k8s": generateK8sTruth,
};

/**
 * The reference and node sets S5 and S6 read, per flavour (`TruthModule.generateExtra`).
 *
 * The third parameter is the *whole* YAML file set the target was indexed with, not just the
 * flavour's group: a workflow's `uses` and `run:` tokens can name a file of another flavour, so
 * a generator that resolved against its own group alone would report an edge greplost drew as a
 * false positive (leaf 2.9). A generator that does not need it simply declares two parameters.
 *
 * `nodeFiles` is optional and names the files whose nodes that flavour is willing to have S6
 * scored over; a flavour that omits it stands behind every file it was given (leaf 2.8).
 */
type ExtraGenerator = (
  root: string,
  files: string[],
  universe: string[],
) => { references: Edge[]; nodes: string[]; nodeFiles?: string[] };

/**
 * Added by leaf 2.8, which needed S5 and S6 measured for `yaml` and found the dispatcher
 * offering `generateTruth` alone; `structural.ts` asks the *target's* truth module for
 * `generateExtra`, and for every YAML target that module is this one. Reported to the driver
 * as an edit to a seam file.
 *
 * `undefined` would mean "this flavour's oracle does not measure references and nodes yet": its
 * group would contribute nothing rather than an empty set, because an empty truth set scores
 * every real edge greplost found as a false positive. All three flavours measure them now.
 */
const EXTRA_GENERATORS: Readonly<Record<YamlFlavour, ExtraGenerator | undefined>> = {
  "yaml-actions": generateActionsExtra,
  "yaml-helm": generateHelmExtra,
  "yaml-k8s": generateK8sExtra,
};

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function basename(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? file : file.slice(slash + 1);
}

/** True for `.github/workflows/<name>.yml` and `.yaml`, at any repo depth. */
export function isWorkflowFile(file: string): boolean {
  const index = file.indexOf(".github/workflows/");
  if (index === -1) return false;
  if (index !== 0 && file[index - 1] !== "/") return false;
  const rest = file.slice(index + ".github/workflows/".length);
  if (rest.includes("/") || rest === "") return false;
  return rest.endsWith(".yml") || rest.endsWith(".yaml");
}

/** True for a chart file or anything under a chart's `templates/` directory. */
export function isHelmFile(file: string): boolean {
  if (CHART_FILES.has(basename(file))) return true;
  return file.startsWith("templates/") || file.includes("/templates/");
}

/**
 * The flavour oracle that owns one file.
 *
 * Everything that is neither a workflow nor a chart is a manifest, which is also where a plain
 * configuration file lands: the Kubernetes oracle is the one that knows an `apiVersion`/`kind`
 * document from an ordinary YAML file, so it is the one that has to see both.
 */
export function flavourOf(file: string, root?: string): YamlFlavour {
  // Without a root, the path rules are all there is: the seam's original contract, and what its
  // own `flavourOf(file)` callers expect.
  if (root === undefined) {
    if (isWorkflowFile(file)) return "yaml-actions";
    if (isHelmFile(file)) return "yaml-helm";
    return "yaml-k8s";
  }
  // Leaf 2.9: the path is neither the whole rule nor a sufficient one, in both directions. A
  // composite action's `action.yml` and a workflow *template* outside `.github/workflows/` are
  // Actions files at other paths (the pinned corpus is 174 of the latter); and a file *under*
  // `.github/workflows/` with no `on:` key is not a workflow at all — GitHub will not run it and
  // `extract/yaml.ts` classifies it `plain`, so an oracle claiming it would demand nodes and
  // exports greplost is right not to have produced (leaf 2.9 fix round 1). `isActionsFile`
  // restates the extractor's whole rule, in order, on js-yaml.
  if (cachedIsActionsFile(root, file)) return "yaml-actions";
  if (isHelmFile(file)) return "yaml-helm";
  return "yaml-k8s";
}

/**
 * `isActionsFile` memoised per `(root, file)`.
 *
 * `generateTruth` and `generateExtra` each call `groupByFlavour`, and `structural.ts` calls both
 * for one target, so a 187-file corpus would otherwise read and parse every file four times
 * before any truth is computed. Nested maps rather than a joined key, so no separator has to be
 * a character a path cannot contain.
 */
const ACTIONS_FILE_CACHE = new Map<string, Map<string, boolean>>();

function cachedIsActionsFile(root: string, file: string): boolean {
  let byFile = ACTIONS_FILE_CACHE.get(root);
  if (byFile === undefined) {
    byFile = new Map<string, boolean>();
    ACTIONS_FILE_CACHE.set(root, byFile);
  }
  const cached = byFile.get(file);
  if (cached !== undefined) return cached;
  const answer = isActionsFile(root, file);
  byFile.set(file, answer);
  return answer;
}

/** Group the file list by flavour, dropping empty groups, in a fixed flavour order. */
export function groupByFlavour(files: readonly string[], root?: string): Array<[YamlFlavour, string[]]> {
  const groups = new Map<YamlFlavour, string[]>();
  for (const file of [...files].sort(compare)) {
    const flavour = flavourOf(file, root);
    const bucket = groups.get(flavour);
    if (bucket === undefined) groups.set(flavour, [file]);
    else bucket.push(file);
  }
  return FLAVOURS.filter((flavour) => groups.has(flavour)).map((flavour) => [
    flavour,
    groups.get(flavour) as string[],
  ]);
}

export function generateTruth(root: string, files: string[]): Truth {
  const groups = groupByFlavour(files, root);
  if (groups.length === 0) {
    return { files: [], imports: [], exports: {}, calls: [], cycles: [], notes: [...NOTES] };
  }
  return merge(groups.map(([flavour, group]) => GENERATORS[flavour](root, group)));
}

/** The reference and node sets for a file list, merged across the flavours it holds. */
export function generateExtra(
  root: string,
  files: string[],
): { references: Edge[]; nodes: string[]; nodeFiles: string[] } {
  const references: Edge[] = [];
  const nodes: string[] = [];
  // The union of what each flavour is willing to have S6 scored over. A flavour that names no
  // `nodeFiles` states nodes for every file it was given, so its whole group goes in: otherwise
  // one chart's restriction would silently turn S6 off for a repo's manifests as well, which is
  // exactly the bug `nodeFiles` replaced `unsupported:S6` to fix (leaf 2.8, fix round 1).
  const nodeFiles: string[] = [];
  for (const [flavour, group] of groupByFlavour(files, root)) {
    const generate = EXTRA_GENERATORS[flavour];
    if (generate === undefined) continue;
    const extra = generate(root, group, files);
    references.push(...extra.references);
    nodes.push(...extra.nodes);
    nodeFiles.push(...(extra.nodeFiles ?? group));
  }
  references.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));
  nodes.sort(compare);
  nodeFiles.sort(compare);
  return { references, nodes, nodeFiles };
}

/**
 * Merge per-flavour truths. The groups are disjoint file sets, so this is a concatenation
 * everywhere except `notes`, which is a set.
 */
function merge(truths: readonly Truth[]): Truth {
  const first = truths[0] as Truth;
  if (truths.length === 1) return first;

  const exports: Record<string, string[]> = {};
  const imports: Edge[] = [];
  const calls: Edge[] = [];
  const cycles: string[][] = [];
  const files: string[] = [];
  const notes = new Set<string>();

  for (const truth of truths) {
    files.push(...truth.files);
    imports.push(...truth.imports);
    calls.push(...truth.calls);
    cycles.push(...truth.cycles);
    for (const [file, names] of Object.entries(truth.exports)) exports[file] = names;
    for (const note of truth.notes) notes.add(note);
  }

  files.sort(compare);
  imports.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));
  calls.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));
  cycles.sort((a, b) => compare(a.join(","), b.join(",")));

  return { files, imports, exports, calls, cycles, notes: [...notes].sort(compare) };
}
