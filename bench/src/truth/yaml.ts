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
import { generateTruth as generateActionsTruth } from "./yaml-actions.ts";
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

/** The reference and node sets S5 and S6 read, per flavour (`TruthModule.generateExtra`). */
type ExtraGenerator = (root: string, files: string[]) => { references: Edge[]; nodes: string[] };

/**
 * Added by leaf 2.8, which needed S5 and S6 measured for `yaml` and found the dispatcher
 * offering `generateTruth` alone; `structural.ts` asks the *target's* truth module for
 * `generateExtra`, and for every YAML target that module is this one. Reported to the driver
 * as an edit to a seam file.
 *
 * `undefined` means "this flavour's oracle does not measure references and nodes yet", which is
 * where `yaml-actions` sits until leaf 2.9 lands: its group contributes nothing rather than
 * contributing an empty set, because an empty truth set would score every real edge greplost
 * found in a workflow as a false positive.
 */
const EXTRA_GENERATORS: Readonly<Record<YamlFlavour, ExtraGenerator | undefined>> = {
  "yaml-actions": undefined,
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
export function flavourOf(file: string): YamlFlavour {
  if (isWorkflowFile(file)) return "yaml-actions";
  if (isHelmFile(file)) return "yaml-helm";
  return "yaml-k8s";
}

/** Group the file list by flavour, dropping empty groups, in a fixed flavour order. */
export function groupByFlavour(files: readonly string[]): Array<[YamlFlavour, string[]]> {
  const groups = new Map<YamlFlavour, string[]>();
  for (const file of [...files].sort(compare)) {
    const flavour = flavourOf(file);
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
  const groups = groupByFlavour(files);
  if (groups.length === 0) {
    return { files: [], imports: [], exports: {}, calls: [], cycles: [], notes: [...NOTES] };
  }
  return merge(groups.map(([flavour, group]) => GENERATORS[flavour](root, group)));
}

/** The reference and node sets for a file list, merged across the flavours it holds. */
export function generateExtra(root: string, files: string[]): { references: Edge[]; nodes: string[] } {
  const references: Edge[] = [];
  const nodes: string[] = [];
  for (const [flavour, group] of groupByFlavour(files)) {
    const generate = EXTRA_GENERATORS[flavour];
    if (generate === undefined) continue;
    const extra = generate(root, group);
    references.push(...extra.references);
    nodes.push(...extra.nodes);
  }
  references.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));
  nodes.sort(compare);
  return { references, nodes };
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
