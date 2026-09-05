/**
 * YAML flavour dispatch (build 2, spec 2026-09-04 section 2.1; owned by the seam, leaf 2.0).
 *
 * A `.yaml` file is not one language. The same grammar reads a Kubernetes manifest, a Helm
 * chart, a GitHub Actions workflow and a plain configuration file, and each of those wants a
 * different set of nodes. This module is the only place that decides which, so leaves 2.8 and
 * 2.9 each own one flavour module and neither edits a shared file.
 *
 * Classification is a pure function of the file path and the document's top-level keys, in
 * this order (first match wins; the flavour is recorded in `meta.flavour` by the flavour
 * module that produces the nodes):
 *
 *   1. the path is `.github/workflows/*.y?ml` and the document has an `on` (or `"on"`) key
 *      -> `actions`
 *   2. the file is a chart file (`Chart.yaml`, `values.yaml`) or lives under a chart's
 *      `templates/` directory -> `helm`
 *   3. the document has both `apiVersion` and `kind` -> `k8s`
 *   4. otherwise -> `plain`: the file contributes its file node (path, lang, loc) and nothing
 *      else, which is what a random `.yaml` config file should cost.
 *
 * Ruling (leaf 2.0, 2026-09-04): spec 2.1's helm rule reads "lives under a directory holding a
 * `Chart.yaml`", which only a filesystem probe can answer, and an extractor may not read the
 * filesystem (tech spec 5.1: a `FileRecord` is what one file can say about itself). The rule is
 * therefore evaluated from the path alone — the two well-known chart filenames, plus any path
 * with a `templates/` segment — and the difference is recorded here rather than hidden. Leaf
 * 2.8 may narrow it further from inside `extract/yaml-helm.ts` without touching this file.
 *
 * A file is classified as a whole: its flavour is that of its first non-`plain` document, so a
 * multi-document manifest goes to one module which walks every document itself. Mixing two
 * real flavours inside one file is not a thing any of the four formats does.
 */

import type { FileRecord, Lang } from "../schema.ts";
import type { Node, Tree } from "web-tree-sitter";
import { extractYamlActions, isActionDefinitionPath } from "./yaml-actions.ts";
import { extractYamlHelm } from "./yaml-helm.ts";
import { extractYamlK8s } from "./yaml-k8s.ts";

/** The four YAML dialects greplost tells apart. `plain` is "a YAML file, and nothing more". */
export type YamlFlavour = "actions" | "helm" | "k8s" | "plain";

/** Chart files that mark a directory as a Helm chart, whatever else is in it. */
const CHART_FILES: ReadonlySet<string> = new Set(["Chart.yaml", "Chart.yml", "values.yaml", "values.yml"]);

/**
 * Nothing at all: a `plain` YAML file's whole contribution beyond its manifest entry.
 *
 * Fresh arrays every call, never one shared constant: `buildSnapshot` freezes the arrays it
 * gets, and a frozen array shared by every plain YAML file in a repo is an alias nobody
 * downstream would expect.
 */
function nothing(): Pick<FileRecord, "decls" | "imports" | "exports" | "calls" | "refs"> {
  return { decls: [], imports: [], exports: [], calls: [], refs: [] };
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** True for `.github/workflows/<name>.yml` and `.yaml`, at any repo depth. */
export function isWorkflowPath(path: string): boolean {
  const index = path.indexOf(".github/workflows/");
  if (index === -1) return false;
  if (index !== 0 && path[index - 1] !== "/") return false;
  const rest = path.slice(index + ".github/workflows/".length);
  // Workflows are files directly in that directory, and only `.yml`/`.yaml` count.
  if (rest.includes("/") || rest === "") return false;
  return rest.endsWith(".yml") || rest.endsWith(".yaml");
}

/** True for a chart file or anything under a chart's `templates/` directory. */
export function isHelmPath(path: string): boolean {
  if (CHART_FILES.has(basenameOf(path))) return true;
  return path === "templates" || path.startsWith("templates/") || path.includes("/templates/");
}

/** A scalar key's text with any surrounding quotes removed. `"on"` and `on` are one key. */
function keyText(node: Node): string {
  const raw = node.text.trim();
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return raw.slice(1, -1);
  }
  return raw;
}

/**
 * The top-level mapping keys of one `document` node, in source order.
 *
 * Only a document whose root is a block or flow mapping has any: a document that is a
 * sequence, a scalar, or unparsable (a Helm template before its pre-pass) has none, which is
 * exactly what the "otherwise" branch of the classification wants.
 */
export function documentKeys(document: Node): string[] {
  const keys: string[] = [];
  const mapping = findMapping(document);
  if (mapping === null) return keys;
  for (const pair of mapping.namedChildren) {
    if (pair === null || !pair.type.endsWith("_pair")) continue;
    const key = pair.childForFieldName("key") ?? pair.namedChild(0);
    if (key !== null) keys.push(keyText(key));
  }
  return keys;
}

/** The mapping node under a document, through the `block_node`/`flow_node` wrappers. */
function findMapping(node: Node): Node | null {
  if (node.type === "block_mapping" || node.type === "flow_mapping") return node;
  for (const child of node.namedChildren) {
    if (child === null) continue;
    if (child.type === "block_node" || child.type === "flow_node" || child.type === "document") {
      const found = findMapping(child);
      if (found !== null) return found;
    }
    if (child.type === "block_mapping" || child.type === "flow_mapping") return child;
  }
  return null;
}

/**
 * Spec 2.1's four rules, for one document, with the two content rules leaf 2.9 added.
 *
 * Ruling (leaf 2.9, 2026-09-04): the path rule alone cannot see the two Actions files spec 2.4
 * requires. A composite action's `action.yml` is never under `.github/workflows/`, and a
 * workflow *template* is a workflow that has not been installed yet — the pinned corpus
 * (`actions/starter-workflows`) keeps 174 of its 183 workflows in `ci/`, `deployments/`,
 * `code-scanning/` and `pages/`, so a path-only rule would have scored nine files and reported
 * the result as a measurement of 187.
 *
 * Both additions are keyed on content, and both are narrower than they look: a document with
 * top-level `on` *and* `jobs` is a GitHub Actions workflow and nothing else writes that pair
 * (GitLab CI has no `on`, CircleCI no `on`, Azure Pipelines `trigger` rather than `on`), and
 * `runs` at the top level of a file literally named `action.yml` is the action definition
 * format. They sit *after* the Helm and Kubernetes rules, so neither a chart file nor a
 * manifest can change flavour: a content rule only ever claims a document nothing else wanted.
 */
export function classifyYamlDocument(path: string, keys: readonly string[]): YamlFlavour {
  if (isWorkflowPath(path) && keys.includes("on")) return "actions";
  if (isHelmPath(path)) return "helm";
  // The two content rules sit *below* `apiVersion`+`kind`, so a manifest is a manifest even if
  // some CRD one day spells a key `jobs` beside a key `on` (leaf 2.9 fix round 1): the older,
  // narrower rule keeps precedence, and the new one only ever claims a document nothing else
  // wanted.
  if (keys.includes("apiVersion") && keys.includes("kind")) return "k8s";
  if (keys.includes("on") && keys.includes("jobs")) return "actions";
  if (isActionDefinitionPath(path) && keys.includes("runs")) return "actions";
  return "plain";
}

/**
 * The flavour of a whole file: the first document that is not `plain` decides, because the
 * flavour modules each walk every document in the file themselves.
 */
export function classifyYamlFile(path: string, tree: Tree): YamlFlavour {
  const documents = tree.rootNode.namedChildren.filter((node): node is Node => node?.type === "document");
  // A file with no `document` node at all (empty, or shredded by template actions) still gets
  // the path-only rules, so `templates/deployment.yaml` is Helm before it is anything else.
  if (documents.length === 0) return classifyYamlDocument(path, []);
  for (const document of documents) {
    const flavour = classifyYamlDocument(path, documentKeys(document));
    if (flavour !== "plain") return flavour;
  }
  return "plain";
}

export function extractYaml(
  path: string,
  lang: Lang,
  source: string,
  tree: Tree,
): Pick<FileRecord, "decls" | "imports" | "exports" | "calls" | "refs"> {
  switch (classifyYamlFile(path, tree)) {
    case "actions":
      return extractYamlActions(path, lang, source, tree);
    case "helm":
      return extractYamlHelm(path, lang, source, tree);
    case "k8s":
      return extractYamlK8s(path, lang, source, tree);
    case "plain":
      return nothing();
  }
}
