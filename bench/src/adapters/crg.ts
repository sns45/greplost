/**
 * code-review-graph -> greplost adapter (bench leaf 1.5.2).
 *
 * Pinned to code-review-graph v2.3.8 (tirth8205/code-review-graph @ 2c6dae3).
 * Format sources are listed in `bench/competitors.json` and in
 * `bench/fixtures/competitors/crg/SOURCE.md`.
 *
 * crg's graph lives in SQLite (`.code-review-graph/graph.db`). This adapter
 * reads the documented JSON export instead — `code-review-graph visualize
 * --format json`, which writes `.code-review-graph/graph.json` via
 * `exports.py:export_json` -> `visualization.py:export_graph_data`. Reading the
 * export rather than the database keeps the bench free of a SQLite dependency
 * and, more importantly, uses the tool's own resolution pass: export_graph_data
 * resolves short/unqualified edge targets to full qualified names and drops the
 * ones it still cannot resolve, which is crg's own idea of what its graph says.
 *
 * The shape being read:
 *
 *   { nodes: [...], edges: [...], stats, flows, communities }
 *
 * Node: { id, kind, name, qualified_name, file_path, line_start, line_end,
 *         language, parent_name, is_test, params, return_type, community_id }
 * Edge: { id, kind, source, target, file_path, line, confidence,
 *         confidence_tier, ambiguous_targets?, unresolved_targets?, ... }
 *
 * Identity is the `qualified_name`, and `docs/schema.md` "Qualified Name Format"
 * spells it out:
 *
 *   /absolute/path/to/file.py                          File
 *   /absolute/path/to/file.py::function_name           top-level function
 *   /absolute/path/to/file.py::ClassName.method_name   method
 *   /absolute/path/to/file.py::Outer.Inner.method_name nested class method
 *
 * That maps onto greplost almost exactly — `::` becomes `#` and the symbol path
 * is already dot-joined — with one thing to fix: the paths are ABSOLUTE, from
 * whichever checkout built the graph. The README says so too ("JSON exports ...
 * can contain absolute paths"). Every path therefore goes through
 * `toRepoRelative` against the root the artifact was built at.
 */
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

/** Must equal the `version` of the crg entry in bench/competitors.json. */
const PINNED_VERSION = "v2.3.8";

/**
 * The JSON export path (`cli.py`: `data_dir / "graph.json"`). The legacy
 * single-file database `.code-review-graph.db` has no JSON sibling, so only the
 * current layout is probed.
 */
const ARTIFACTS = [".code-review-graph/graph.json"] as const;

/**
 * Node kinds with a greplost identity.
 *
 *  - `File`                       -> a repo file id.
 *  - `Class`, `Function`, `Test`,
 *    `Type`                       -> `<file>#<symbol path>`.
 *
 * `Test` is a `Function` with `is_test`, and `Type` covers type aliases,
 * interfaces and enums; greplost declares all of those in `symbols.jsonl`, so
 * they keep their identity here. The Spring-enrichment kinds `Endpoint`,
 * `Scheduler` and `ConfigProperty` are synthesised nodes for routes, schedules
 * and configuration keys — they are not declarations in a source file, so they
 * have no greplost id and every edge touching one is dropped. `Community` (the
 * super-node kind `_aggregate_community` synthesises for the clustered view)
 * likewise never appears in a real export of the full graph, and is not mapped.
 */
const FILE_KIND = "File";
const SYMBOL_KINDS = new Set(["Class", "Function", "Test", "Type"]);

/**
 * Edge kinds that carry a module dependency or a call.
 *
 *  - `IMPORTS_FROM` -> greplost `import`, between two File nodes.
 *  - `CALLS`        -> greplost `call`.
 *
 * Everything else is dropped. The ones worth naming:
 *
 *  - `CONTAINS` is structural (file contains class, class contains method).
 *    greplost keeps that in `symbols.jsonl`, and `constants.py` notes crg does
 *    not even traverse it for impact.
 *  - `DEPENDS_ON` is documented as "general dependency relationship (used for
 *    non-specific dependencies)" — too unspecific to claim as an import without
 *    inventing precision crg never claimed.
 *  - `INHERITS`, `IMPLEMENTS`, `REFERENCES`, `TESTED_BY`, `INJECTS`,
 *    `CONSUMES`, `PRODUCES`, `TEMPORAL_STUB`, `DEPENDS_ON_CONFIG`, `HANDLES`,
 *    `TRIGGERS` and `PUBLISHES` have no greplost import/call counterpart.
 *    `REFERENCES` in particular is "a value-level reference ... such as
 *    callback maps, arrays, or assignment", which is a reference and not a
 *    call; mapping it would hand crg false positives.
 *  - `OVERRIDES` is scored in `constants.py` but, per `docs/schema.md`, never
 *    emitted by any parser.
 */
const IMPORT_EDGE_KIND = "IMPORTS_FROM";
const CALL_EDGE_KIND = "CALLS";

/**
 * crg exposes both a numeric `confidence` and a `confidence_tier`. The tier is
 * the meaningful one: `EXTRACTED` (the schema default, the parser read it out
 * of the AST) or `INFERRED` (`scoped_resolver.py` rewrote the endpoint), which
 * lines up with greplost's high/med split.
 *
 * When the tier is missing — an export from a database written before the
 * column existed, which `graph.py` handles by defaulting to `EXTRACTED` on read
 * — fall back to the float, treating anything below full confidence as med.
 */
function mapConfidence(tier: string | null, score: unknown): Confidence {
  if (tier !== null && tier.length > 0) return tier === "EXTRACTED" ? "high" : "med";
  return typeof score === "number" && score >= 1 ? "high" : "med";
}

interface CrgNode {
  qualifiedName: string;
  kind: string;
}

export const crgAdapter: Adapter = {
  tool: "crg",

  detect(dir: string): boolean {
    return hasAny(dir, ARTIFACTS);
  },

  load(dir: string, repoRoot: string): CompetitorArtifact {
    const read = readFirstJson(dir, ARTIFACTS, "crg");
    const root = asRecord(read.data);
    if (root === null) throw new Error(`greplost: crg ${read.file} is not a JSON object`);

    // ---- nodes -------------------------------------------------------------
    const nodes = new Map<string, CrgNode>();
    for (const raw of asArray(root["nodes"])) {
      const n = asRecord(raw);
      if (n === null) continue;
      const qualifiedName = asString(n["qualified_name"]);
      const kind = asString(n["kind"]);
      if (qualifiedName === null || qualifiedName.length === 0 || kind === null) continue;
      // `qualified_name` is UNIQUE in the nodes table, so last-writer-wins here
      // can only ever happen on a malformed export; keep the first.
      if (!nodes.has(qualifiedName)) nodes.set(qualifiedName, { qualifiedName, kind });
    }

    // ---- qualified name -> greplost id ------------------------------------
    const resolved = new Map<string, string | null>();
    for (const node of nodes.values()) {
      let out: string | null = null;

      if (node.kind === FILE_KIND) {
        // A File node's qualified_name is just the path.
        out = toRepoRelative(node.qualifiedName, repoRoot);
      } else if (SYMBOL_KINDS.has(node.kind)) {
        // "Qualified names embed the file path before the FIRST `::`"
        // (`graph.py:_bridge_qualified_name`). Split there and nowhere else:
        // the symbol half may legitimately contain `::` (PHP fully-qualified
        // names) and backslashes, and it is kept verbatim.
        const cut = node.qualifiedName.indexOf("::");
        if (cut > 0) {
          const file = toRepoRelative(node.qualifiedName.slice(0, cut), repoRoot);
          out = toSymbolId(file, node.qualifiedName.slice(cut + 2));
        }
      }
      resolved.set(node.qualifiedName, out);
    }

    // ---- edges -------------------------------------------------------------
    const imports = new EdgeSet();
    const calls = new EdgeSet();

    for (const raw of asArray(root["edges"])) {
      const e = asRecord(raw);
      if (e === null) continue;
      const kind = asString(e["kind"]);
      const source = asString(e["source"]);
      const target = asString(e["target"]);
      if (kind === null || source === null || target === null) continue;
      if (kind !== IMPORT_EDGE_KIND && kind !== CALL_EDGE_KIND) continue;

      // Endpoints are resolved through the node index rather than parsed
      // directly, so an edge naming a qualified name the export never declared
      // — an unresolved external module on an IMPORTS_FROM row, a callee crg
      // could not bind — is dropped instead of being invented as a repo file.
      const from = resolved.get(source) ?? null;
      const to = resolved.get(target) ?? null;
      if (from === null || to === null) continue;

      const confidence = mapConfidence(asString(e["confidence_tier"]), e["confidence"]);

      if (kind === IMPORT_EDGE_KIND) {
        // greplost import edges join two files, and crg stores IMPORTS_FROM
        // between File nodes ("source: importing file path, target: imported
        // module/path"). A symbol-shaped endpoint here would be a malformed
        // row, not a symbol-level import crg models.
        if (from.includes("#") || to.includes("#")) continue;
        imports.add(from, to, "import", confidence);
        continue;
      }

      // greplost call edges end at a symbol; `from` may be a bare file id,
      // which is how greplost models a call made from top-level code.
      if (!to.includes("#")) continue;
      calls.add(from, to, "call", confidence);
    }

    const importEdges: Edge[] = imports.finish();
    const callEdges: Edge[] = calls.finish();
    const mapped = sortedIds([
      ...[...resolved.values()].filter((v): v is string => v !== null),
      ...importEdges.flatMap((e) => [e.from, e.to]),
      ...callEdges.flatMap((e) => [e.from, e.to]),
    ]);

    return {
      tool: "crg",
      version: PINNED_VERSION,
      imports: importEdges,
      calls: callEdges,
      nodes: mapped,
      raw: { files: [read.file], bytes: read.bytes },
    };
  },
};
