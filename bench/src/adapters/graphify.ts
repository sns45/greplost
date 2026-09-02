/**
 * graphify -> greplost adapter (bench leaf 1.5.2).
 *
 * Pinned to graphify v0.9.53 (Graphify-Labs/graphify @ 33362d9). Format sources
 * are listed in `bench/competitors.json` and in
 * `bench/fixtures/competitors/graphify/SOURCE.md`.
 *
 * The shape being read, from `docs/how-it-works.md` "The graph format" plus
 * `graphify/export.py:to_json`:
 *
 *   { directed, multigraph, graph, nodes: [...], links: [...], hyperedges,
 *     built_at_commit? }
 *
 * Node: { id, label, file_type, source_file, source_location, type?, metadata?,
 *         community?, community_name?, norm_label?, origin_file? }
 * Edge: { source, target, relation, confidence, confidence_score, source_file,
 *         source_location, weight, context?, type_only?, target_file? }
 *
 * The one thing that shapes this whole adapter: **a graphify node id is not a
 * path**. `graphify/ids.py:normalize_id` casefolds, NFKC-normalizes and
 * replaces every run of non-word characters with `_`, so
 * `packages/core/src/registry.ts` and `Packages.Core.Src.Registry_TS` collapse
 * to the same id and neither can be reversed. Identity therefore has to be
 * rebuilt from `source_file` (the path) plus `label` (the name) plus the
 * `contains` / `method` containment edges (the nesting).
 */
import path from "node:path";

import type { Confidence, Edge } from "@greplost/core/schema";

import type { Adapter, CompetitorArtifact } from "./types.ts";
import {
  EdgeSet,
  asArray,
  asRecord,
  asString,
  hasAny,
  readFirstJson,
  sortedIds,
  toRepoRelative,
  toSymbolId,
} from "./types.ts";

/** Must equal the `version` of the graphify entry in bench/competitors.json. */
const PINNED_VERSION = "v0.9.53";

/**
 * `graphify-out/` is the documented output directory; `GRAPHIFY_OUT` can move
 * it, but the adapter is pointed at a directory by the bench driver, so only
 * the default layout is probed.
 */
const ARTIFACTS = ["graphify-out/graph.json"] as const;

interface GraphifyNode {
  id: string;
  label: string;
  fileType: string;
  /** Raw `source_file`; "" for the sourceless cross-file stubs. */
  sourceFile: string;
}

interface GraphifyEdge {
  source: string;
  target: string;
  relation: string;
  confidence: string;
}

/**
 * Relations that carry a module dependency.
 *
 *  - `imports_from`  file -> file, written by `_import_js` for every
 *                    `import ... from "x"` and every `export ... from "x"`
 *                    (the re-export case is flagged only by `context`).
 *  - `imports`       file -> symbol, the named-binding edge emitted alongside
 *                    the file-level one for `import { a } from "x"`.
 *  - `re_exports`    file -> symbol, the same thing for `export { a } from "x"`.
 *
 * All three become greplost `import` edges. greplost's schema does have a
 * separate `reexport` kind, but the bench compares imports on `(from, to)` with
 * re-exports folded into the import set (leaf 1.5.1's truth builder counts
 * `ExportDeclaration` with a module specifier as an import), so splitting them
 * here would only lose graphify recall.
 */
const IMPORT_RELATIONS = new Set(["imports_from", "imports", "re_exports"]);

/**
 * Relations that carry a call.
 *
 *  - `calls`         the ordinary resolved call edge.
 *  - `indirect_call` a call graphify resolved through an indirection
 *                    (`engine.py`, ~line 4980). It is a call the tool asserts,
 *                    so it is counted; its own `confidence` field decides
 *                    whether it lands as high or med, which keeps it out of
 *                    greplost's precision-at-high comparison when graphify
 *                    itself is unsure.
 *
 * Everything else is dropped: `contains` and `method` are consumed as structure
 * (below), and `inherits`, `implements`, `references`, `bound_to`,
 * `uses_static_prop`, `references_constant`, `listened_by`, `defines`, `cites`
 * and `rationale_for` have no greplost import/call counterpart. Mapping
 * `references` onto calls in particular would manufacture false positives out
 * of type annotations.
 */
const CALL_RELATIONS = new Set(["calls", "indirect_call"]);

/** file -> class/function, and class -> method: the containment tree. */
const CONTAINMENT_RELATIONS = new Set(["contains", "method"]);

/**
 * `EXTRACTED` means graphify read the edge straight out of the source, which is
 * the same claim greplost's "high" makes. `INFERRED` and `AMBIGUOUS` are
 * graphify's own hedges (`docs/how-it-works.md` "Confidence tagging"), and
 * greplost has exactly one weaker bucket, so both land on "med". An unknown or
 * missing tag is treated as a hedge rather than as a certainty.
 */
function mapConfidence(tag: string | null): Confidence {
  return tag === "EXTRACTED" ? "high" : "med";
}

/**
 * Strip graphify's label decoration to get the bare symbol name.
 * `engine.py` labels a top-level function `name()`, a method `.name()`, and a
 * class or interface with its bare name.
 */
function symbolName(label: string): string {
  return label.replace(/^\./, "").replace(/\(\)$/, "").trim();
}

export const graphifyAdapter: Adapter = {
  tool: "graphify",

  detect(dir: string): boolean {
    return hasAny(dir, ARTIFACTS);
  },

  load(dir: string, repoRoot: string): CompetitorArtifact {
    const read = readFirstJson(dir, ARTIFACTS, "graphify");
    const root = asRecord(read.data);
    if (root === null) throw new Error(`greplost: graphify ${read.file} is not a JSON object`);

    // NetworkX node-link: `paths.py:load_node_link_graph` documents that the
    // clustered writer stores edges under `links` (networkx's default) while
    // the raw `--no-cluster` writer stores them under `edges`. Accept either;
    // prefer `links`, which is what `export.py:to_json` writes.
    const rawLinks = "links" in root ? root["links"] : root["edges"];

    // ---- nodes -------------------------------------------------------------
    const nodes = new Map<string, GraphifyNode>();
    for (const raw of asArray(root["nodes"])) {
      const n = asRecord(raw);
      if (n === null) continue;
      const id = asString(n["id"]);
      if (id === null || id.length === 0) continue;
      nodes.set(id, {
        id,
        label: asString(n["label"]) ?? "",
        // `file_type` defaults to "concept" downstream in build.py; treat a
        // missing one as non-code so it is dropped rather than mis-mapped.
        fileType: asString(n["file_type"]) ?? "",
        sourceFile: asString(n["source_file"]) ?? "",
      });
    }

    const edges: GraphifyEdge[] = [];
    for (const raw of asArray(rawLinks)) {
      const e = asRecord(raw);
      if (e === null) continue;
      const source = asString(e["source"]);
      const target = asString(e["target"]);
      const relation = asString(e["relation"]);
      if (source === null || target === null || relation === null) continue;
      edges.push({ source, target, relation, confidence: asString(e["confidence"]) ?? "" });
    }

    // ---- containment: child id -> parent id --------------------------------
    // `contains` runs file -> class / file -> function; `method` runs
    // class -> method. Both point parent -> child, so the map is inverted here.
    const parentOf = new Map<string, string>();
    for (const e of edges) {
      if (!CONTAINMENT_RELATIONS.has(e.relation)) continue;
      if (e.source === e.target) continue;
      // First writer wins: a node claimed by two parents (graphify's fuzzy dedup
      // can do this across same-named symbols) keeps the first, so the mapping
      // stays deterministic under the artifact's own ordering.
      if (!parentOf.has(e.target)) parentOf.set(e.target, e.source);
    }

    // ---- node id -> greplost id -------------------------------------------
    const resolved = new Map<string, string | null>();

    /** True when the node is the file node for its own `source_file`. */
    function isFileNode(node: GraphifyNode, rel: string): boolean {
      // `engine.py` creates the file node with `add_node(file_nid, path.name, 1)`,
      // so a file node's label is exactly the basename of its own source_file.
      return node.label === path.posix.basename(rel);
    }

    /**
     * The symbol path of a node relative to its file: [] for the file node
     * itself, ["Registry"] for a class, ["Registry", "register"] for a method.
     * Null when the chain does not terminate at a file node, which means
     * graphify has no placement for the symbol and greplost must not invent one.
     */
    function symbolParts(id: string, seen: Set<string>): string[] | null {
      const node = nodes.get(id);
      if (node === undefined) return null;
      const rel = toRepoRelative(node.sourceFile, repoRoot);
      if (rel === null) return null;
      if (isFileNode(node, rel)) return [];

      if (seen.has(id)) return null; // containment cycle; refuse to loop
      seen.add(id);
      const parent = parentOf.get(id);
      if (parent === undefined) return null; // orphan symbol: no file to hang it on
      const parentNode = nodes.get(parent);
      if (parentNode === undefined) return null;
      // A parent in a different file would mean the containment edge crossed
      // files, which graphify never emits for `contains`/`method`; refuse it.
      if (toRepoRelative(parentNode.sourceFile, repoRoot) !== rel) return null;

      const head = symbolParts(parent, seen);
      if (head === null) return null;
      const name = symbolName(node.label);
      if (name.length === 0) return null;
      return [...head, name];
    }

    function greplostId(id: string): string | null {
      const cached = resolved.get(id);
      if (cached !== undefined) return cached;

      let out: string | null = null;
      const node = nodes.get(id);
      if (node !== undefined) {
        // Only code nodes have structural identity. `document`, `paper`,
        // `image`, `rationale` and `concept` nodes describe prose, media or
        // comments and have no greplost counterpart.
        if (node.fileType === "code") {
          // Sourceless stubs (`engine.py:ensure_named_node`, `source_file: ""`)
          // are placeholders for a symbol defined in some other file that this
          // batch never saw. There is no file to build an id from.
          const rel = toRepoRelative(node.sourceFile, repoRoot);
          if (rel !== null) {
            const parts = symbolParts(id, new Set());
            if (parts !== null) out = parts.length === 0 ? rel : toSymbolId(rel, parts.join("."));
          }
        }
      }
      resolved.set(id, out);
      return out;
    }

    for (const id of nodes.keys()) greplostId(id);

    // ---- edges -------------------------------------------------------------
    const imports = new EdgeSet();
    const calls = new EdgeSet();

    for (const e of edges) {
      const isImport = IMPORT_RELATIONS.has(e.relation);
      const isCall = CALL_RELATIONS.has(e.relation);
      if (!isImport && !isCall) continue;

      const from = greplostId(e.source);
      // `build.py` deliberately keeps import-family edges whose target is not a
      // node at all — unresolved specifiers become `_make_id("ref", spec)` and
      // external packages never get a node. Those are outside the repo, so they
      // are dropped here exactly as the bench drops greplost's own `ext:` and
      // `unresolved:` targets before scoring.
      const to = greplostId(e.target);
      if (from === null || to === null) continue;

      const confidence = mapConfidence(e.confidence);

      if (isImport) {
        // `type_only` edges (`import type { X } from "y"`) are kept: greplost's
        // own ImportKind has a `type` member and leaf 1.5.1's compiler truth
        // counts every ImportDeclaration, erased or not.
        // greplost import edges join two files. A symbol-level `imports` or
        // `re_exports` edge names one binding inside the target file, so it is
        // folded onto the file-to-file edge with the binding recorded in
        // `symbols` — which is where greplost's own ImportEdge keeps it.
        const fromFile = from.includes("#") ? from.slice(0, from.indexOf("#")) : from;
        const toFile = to.includes("#") ? to.slice(0, to.indexOf("#")) : to;
        const symbols = to.includes("#") ? [to.slice(to.indexOf("#") + 1)] : [];
        imports.add(fromFile, toFile, "import", confidence, symbols);
        continue;
      }

      // greplost call edges end at a symbol; a call whose callee resolved only
      // to a file node carries no information greplost can score.
      if (!to.includes("#")) continue;
      // `from` may legitimately be a bare file id: greplost models top-level
      // code as the file itself.
      calls.add(from, to, "call", confidence);
    }

    const importEdges: Edge[] = imports.finish();
    const callEdges: Edge[] = calls.finish();
    // Every node the adapter could place, plus every endpoint it emitted (an
    // import edge is folded onto file ids, which need not have been resolved as
    // nodes in their own right).
    const mapped = sortedIds([
      ...[...resolved.values()].filter((v): v is string => v !== null),
      ...importEdges.flatMap((e) => [e.from, e.to]),
      ...callEdges.flatMap((e) => [e.from, e.to]),
    ]);

    return {
      tool: "graphify",
      version: PINNED_VERSION,
      imports: importEdges,
      calls: callEdges,
      nodes: mapped,
      raw: { files: [read.file], bytes: read.bytes },
    };
  },
};
