/**
 * Understand-Anything -> greplost adapter (bench leaf 1.5.2).
 *
 * Pinned to Understand-Anything v2.9.0 (Egonex-AI/Understand-Anything @ f08763d;
 * the project moved there from Lum1104/Understand-Anything). Format sources are
 * listed in `bench/competitors.json` and in
 * `bench/fixtures/competitors/ua/SOURCE.md`.
 *
 * The shape being read, from `packages/core/src/types.ts` (`KnowledgeGraph`):
 *
 *   { version, kind?, project, nodes: [...], edges: [...], layers, tour }
 *
 * Node: { id, type, name, filePath?, lineRange?, summary, tags, complexity, ... }
 * Edge: { source, target, type, direction, description?, weight }
 *
 * Unlike graphify, ua ids are readable and carry the path themselves:
 * `file:<path>`, `function:<path>:<name>`, `class:<path>:<name>`
 * (`agents/file-analyzer.md`, "Node Types and ID Conventions"). Paths are
 * documented as project-relative, so the usual case needs no re-anchoring; the
 * relativizer still runs, because it is also what normalises separators and
 * rejects anything that escapes the root.
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

/** Must equal the `version` of the ua entry in bench/competitors.json. */
const PINNED_VERSION = "v2.9.0";

/**
 * `.ua/` is the current data directory; the README states that projects which
 * already have `.understand-anything/` keep using it, so the legacy path is
 * probed second.
 */
const ARTIFACTS = [".ua/knowledge-graph.json", ".understand-anything/knowledge-graph.json"] as const;

/**
 * Node types that have a greplost identity.
 *
 *  - `file`      -> a repo file id.
 *  - `function`  -> `<file>#<name>`.
 *  - `class`     -> `<file>#<Name>`.
 *
 * The other 24 types are dropped. `config`, `document`, `service`, `pipeline`,
 * `schema`, `resource`, `table`, `endpoint` are non-source files or synthesised
 * infrastructure nodes; `module`, `concept`, `domain`, `flow`, `step`,
 * `article`, `entity`, `topic`, `claim`, `source` and the six Figma design
 * types are abstractions with no file behind them at all. greplost's structure
 * layer models source files and the symbols declared in them, and nothing else.
 *
 * Note the granularity ceiling this implies: ua's file-analyzer creates one
 * `class:` node per class and never a node per method (its significance filter
 * only ever promotes functions, and a method is not one), so a call into
 * `Registry.register` can only ever be expressed as a call into `Registry`.
 * That is a property of the tool, not of this adapter, and it is exactly what
 * X1's call-edge comparison is meant to surface.
 */
const FILE_NODE_TYPE = "file";
const SYMBOL_NODE_TYPES = new Set(["function", "class"]);

/**
 * Edge types that carry a module dependency or a call.
 *
 *  - `imports` -> greplost `import`. `agents/file-analyzer.md` requires one
 *    `imports` edge per entry of `batchImportData[filePath]`, and that list is
 *    produced by the deterministic project-scanner with external packages
 *    already filtered out, so every `imports` edge is meant to be a resolved,
 *    project-internal file dependency.
 *  - `calls`   -> greplost `call`.
 *
 * Everything else is dropped. Three of the drops are judgement calls worth
 * naming, because a reviewer from the ua side might want them counted:
 *
 *  - `depends_on` is documented as "broader than imports -- includes dynamic
 *    requires, lazy loads", which greplost *does* model as an import edge. It
 *    is dropped anyway because the same type is also prescribed for "component
 *    calls useContext", "compose depends on Dockerfile" and "CI depends on
 *    Makefile targets". Counting it would add real dynamic imports and an
 *    unknown number of non-import relations at the same time, hurting ua's
 *    precision to buy recall. Flipping this is a one-line change and the
 *    decision is recorded here so it can be argued with.
 *  - `exports` and `contains` connect a file to its own symbols. greplost keeps
 *    that in `graph/symbols.jsonl`, not in the import or call graph, and the
 *    bench scores exports as a `(file, name)` set, not as edges.
 *  - `tested_by`, `inherits`, `implements`, `related`, `similar_to` and the
 *    infrastructure types have no import/call counterpart.
 */
const IMPORT_EDGE_TYPE = "imports";
const CALL_EDGE_TYPE = "calls";

/**
 * ua exposes no confidence at all. `weight` looks like one but is not: the
 * file-analyzer prescribes a fixed constant per edge type (imports 0.7, calls
 * 0.8, contains 1.0) and requires the emitted value to match, so it is an
 * importance weight, invariant per type, carrying no per-edge evidence.
 *
 * Per the leaf brief, an edge from a tool that exposes no confidence is mapped
 * to "high". That reads as "the tool asserts this outright", not as
 * "compiler-verified": ua's `imports` edges come from a deterministic scanner,
 * but its `calls` edges are LLM-inferred from imports plus function names
 * ("infer from imports + function names when confident"). Bucketing the
 * inferred calls as "med" instead would quietly exempt them from greplost's
 * precision-at-high comparison, which is the number X1 exists to publish.
 */
const CONFIDENCE: Confidence = "high";

interface UaNode {
  id: string;
  type: string;
  /** `filePath` when present, else parsed out of the id. */
  filePath: string | null;
  /** Symbol name for function/class nodes. */
  name: string | null;
}

/**
 * Split `function:<path>:<name>` / `class:<path>:<name>`.
 * The name is taken after the LAST colon: a path may contain a colon, a symbol
 * name may not.
 */
function splitPrefixed(id: string, prefix: string): { path: string; name: string } | null {
  const rest = id.slice(prefix.length);
  const cut = rest.lastIndexOf(":");
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { path: rest.slice(0, cut), name: rest.slice(cut + 1) };
}

export const uaAdapter: Adapter = {
  tool: "ua",

  detect(dir: string): boolean {
    return hasAny(dir, ARTIFACTS);
  },

  load(dir: string, repoRoot: string): CompetitorArtifact {
    const read = readFirstJson(dir, ARTIFACTS, "ua");
    const root = asRecord(read.data);
    if (root === null) throw new Error(`greplost: ua ${read.file} is not a JSON object`);

    // ---- nodes -------------------------------------------------------------
    const nodes = new Map<string, UaNode>();
    for (const raw of asArray(root["nodes"])) {
      const n = asRecord(raw);
      if (n === null) continue;
      const id = asString(n["id"]);
      const type = asString(n["type"]);
      if (id === null || id.length === 0 || type === null) continue;

      let filePath = asString(n["filePath"]);
      let name = asString(n["name"]);

      if (type === FILE_NODE_TYPE) {
        // `filePath` is REQUIRED for file-level nodes, but the id carries the
        // same path and the warning in file-analyzer.md is that ids are the
        // thing edges are keyed on, so the id wins when the two disagree.
        if (id.startsWith("file:")) filePath = id.slice("file:".length);
        name = null;
      } else if (SYMBOL_NODE_TYPES.has(type)) {
        const parsed = splitPrefixed(id, `${type}:`);
        if (parsed === null) continue; // malformed id: cannot place the symbol
        filePath = parsed.path;
        // The symbol name comes from the id, not from `name`: the id is what
        // edges reference, and ua auto-corrects invalid ids during assembly.
        name = parsed.name;
      }

      nodes.set(id, { id, type, filePath, name });
    }

    // ---- node id -> greplost id -------------------------------------------
    const resolved = new Map<string, string | null>();
    for (const node of nodes.values()) {
      let out: string | null = null;
      const rel = toRepoRelative(node.filePath, repoRoot);
      if (rel !== null) {
        if (node.type === FILE_NODE_TYPE) out = rel;
        else if (SYMBOL_NODE_TYPES.has(node.type) && node.name !== null) {
          out = toSymbolId(rel, node.name);
        }
      }
      resolved.set(node.id, out);
    }

    // ---- edges -------------------------------------------------------------
    const imports = new EdgeSet();
    const calls = new EdgeSet();

    for (const raw of asArray(root["edges"])) {
      const e = asRecord(raw);
      if (e === null) continue;
      const source = asString(e["source"]);
      const target = asString(e["target"]);
      const type = asString(e["type"]);
      if (source === null || target === null || type === null) continue;
      if (type !== IMPORT_EDGE_TYPE && type !== CALL_EDGE_TYPE) continue;

      const from = resolved.get(source) ?? null;
      const to = resolved.get(target) ?? null;
      // An endpoint the graph never declared (ua's merge script calls these
      // "orphan endpoints" and drops them itself) cannot be scored.
      if (from === null || to === null) continue;

      // `direction` reverses the relation rather than the drawing: the schema
      // defines `backward` and `bidirectional`, and only the file-analyzer
      // agent is documented to always emit `forward`, so the other two agents'
      // output has to be re-oriented before it means anything.
      const direction = asString(e["direction"]) ?? "forward";
      const oriented: [string, string][] =
        direction === "backward"
          ? [[to, from]]
          : direction === "bidirectional"
            ? [
                [from, to],
                [to, from],
              ]
            : [[from, to]];

      for (const [a, b] of oriented) {
        if (type === IMPORT_EDGE_TYPE) {
          // greplost import edges join two files. ua only ever emits `imports`
          // between `file:` nodes, so anything symbol-shaped here is a
          // malformed id; drop it rather than fold it onto its file, because
          // ua has no symbol-level import concept to fold.
          if (a.includes("#") || b.includes("#")) continue;
          imports.add(a, b, "import", CONFIDENCE);
        } else {
          // greplost call edges end at a symbol. A `calls` edge into a `file:`
          // node names no callee.
          if (!b.includes("#")) continue;
          calls.add(a, b, "call", CONFIDENCE);
        }
      }
    }

    const importEdges: Edge[] = imports.finish();
    const callEdges: Edge[] = calls.finish();
    const mapped = sortedIds([
      ...[...resolved.values()].filter((v): v is string => v !== null),
      ...importEdges.flatMap((e) => [e.from, e.to]),
      ...callEdges.flatMap((e) => [e.from, e.to]),
    ]);

    return {
      tool: "ua",
      version: PINNED_VERSION,
      imports: importEdges,
      calls: callEdges,
      nodes: mapped,
      raw: { files: [read.file], bytes: read.bytes },
    };
  },
};
