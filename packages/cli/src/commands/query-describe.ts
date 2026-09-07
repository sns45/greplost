/**
 * Turning the map into the blocks `query` answers with (plugin-cli spec
 * "--json shapes").
 *
 * Every function here is pure: a `Structure`, a `Manifest` and a declaration in,
 * one JSON block out, no filesystem and no output. `query.ts` owns the ladder
 * that decides which block an argument deserves, `query-print.ts` owns how a
 * person reads it, and this file owns what is in it.
 */

import { callersOf, importersOf } from "@greplost/core";
import type { Structure } from "@greplost/core";
import { filesUnder, impactOf, impactPairs, importTargetsOf } from "@greplost/core/graph";
import type { Declaration, ImportEdge, Manifest, ReferenceEdge } from "@greplost/core/schema";
import { compareEdges, compareStrings, isNodeDeclaration } from "@greplost/core/schema";

import type {
  QueryDirectory,
  QueryFile,
  QueryMatch,
  QueryNode,
  ReferenceIn,
  ReferenceOut,
} from "./query.ts";
import { cardOf, importsOfFile, nodeCardOf } from "./structure.ts";

/** Reference edges bucketed by both endpoints, built once per `queryStructure`. */
export interface ReferenceIndex {
  from: Map<string, ReferenceEdge[]>;
  to: Map<string, ReferenceEdge[]>;
}

/** Every indexed file under a directory, with the four figures the table shows. */
export function describeDirectory(manifest: Manifest, directory: string): QueryDirectory {
  const files = filesUnder(Object.keys(manifest.files), directory).map((file) => {
    const entry = manifest.files[file];
    return {
      path: file,
      loc: entry?.loc ?? 0,
      exports: entry?.exports.length ?? 0,
      fanIn: entry?.fanIn ?? 0,
      fanOut: entry?.fanOut ?? 0,
    };
  });
  return { path: directory, files };
}

/**
 * Reference edges bucketed by both endpoints, each bucket sorted with
 * `compareEdges`, the same order `referencesOf`/`referencedBy` produce, which
 * is what keeps a `query` answer and a node card listing the same edges in the
 * same sequence.
 *
 * Built once per invocation. The two core helpers each scan the whole edge list,
 * so calling them per declaration made a query on a 400-resource Terraform file
 * 800 linear scans of `graph/references.jsonl`.
 */
export function indexReferences(references: readonly ReferenceEdge[]): ReferenceIndex {
  const from = new Map<string, ReferenceEdge[]>();
  const to = new Map<string, ReferenceEdge[]>();
  for (const edge of references) {
    const out = from.get(edge.from);
    if (out === undefined) from.set(edge.from, [edge]);
    else out.push(edge);
    const back = to.get(edge.to);
    if (back === undefined) to.set(edge.to, [edge]);
    else back.push(edge);
  }
  for (const bucket of from.values()) bucket.sort(compareEdges);
  for (const bucket of to.values()) bucket.sort(compareEdges);
  return { from, to };
}

/**
 * Import and re-export edges into each declaring file *or the package
 * directory it sits in*, indexed once by the id the edge actually targets.
 *
 * Both ids are collected because a Go import names a package rather than a
 * file, so the edge that makes `cmd/app/main.go` an importer of `Store` targets
 * `internal/store`, not `internal/store/store.go` (tech spec Appendix C).
 * `importTargetsOf` is core's shared expansion rule, and a target id is either
 * a file path or a directory path but never both, so the two buckets can never
 * fold two different modules together.
 */
export function importEdgesByTarget(structure: Structure, declarations: Declaration[]): Map<string, ImportEdge[]> {
  const wanted = new Set<string>();
  for (const decl of declarations) {
    for (const target of importTargetsOf(decl.file)) wanted.add(target);
  }
  const byTarget = new Map<string, ImportEdge[]>();
  if (wanted.size === 0) return byTarget;

  for (const edge of structure.imports) {
    if (edge.kind !== "import" && edge.kind !== "reexport") continue;
    if (!wanted.has(edge.to)) continue;
    const bucket = byTarget.get(edge.to);
    if (bucket === undefined) byTarget.set(edge.to, [edge]);
    else bucket.push(edge);
  }
  return byTarget;
}

export function describe(
  structure: Structure,
  manifest: Manifest,
  decl: Declaration,
  byTarget: Map<string, ImportEdge[]>,
  edges: ReferenceIndex,
): QueryMatch {
  const entry = manifest.files[decl.file];
  const node = isNodeDeclaration(decl);
  const match: QueryMatch = {
    id: decl.id,
    file: decl.file,
    name: decl.name,
    kind: decl.kind,
    signature: decl.signature,
    span: decl.span,
    exported: decl.exported,
    package: entry?.pkg ?? "",
    // A node's card is its own; everything else is documented by its file's.
    card: node ? nodeCardOf(manifest, decl.id) : cardOf(manifest, decl.file),
    importers: symbolImporters(byTarget, decl),
    // The sites, not the names (leaf 2.14): `{ from, line?, confidence }`, which
    // is what turns "something calls this" into a place to open.
    callers: callersOf(structure.calls, decl.id),
    references: outboundReferences(edges, decl.id),
    referencedBy: inboundReferences(edges, decl.id),
  };
  // Absent rather than guessed: a language with no accessibility keyword, and a
  // map written before leaf 2.14, both carry no visibility at all, and `public`
  // would be an invention in either case.
  if (decl.visibility !== undefined) match.visibility = decl.visibility;
  if (decl.meta !== undefined) match.meta = decl.meta;
  return match;
}

function outboundReferences(edges: ReferenceIndex, id: string): ReferenceOut[] {
  return (edges.from.get(id) ?? []).map((edge) => ({
    to: edge.to,
    refKind: edge.refKind,
    confidence: edge.confidence,
  }));
}

function inboundReferences(edges: ReferenceIndex, id: string): ReferenceIn[] {
  return (edges.to.get(id) ?? []).map((edge) => ({
    from: edge.from,
    refKind: edge.refKind,
    confidence: edge.confidence,
  }));
}

/**
 * The node block. `blast` is the reverse closure over `impactPairs`, the same
 * figure `greplost impact <node-id>` reports and the same one the node card
 * prints, so a reader never sees three numbers for one question.
 */
export function describeNode(
  structure: Structure,
  manifest: Manifest,
  decl: Declaration,
  edges: ReferenceIndex,
): QueryNode {
  const node: QueryNode = {
    id: decl.id,
    file: decl.file,
    kind: decl.kind,
    name: decl.name,
    package: manifest.files[decl.file]?.pkg ?? "",
    card: nodeCardOf(manifest, decl.id),
    references: outboundReferences(edges, decl.id),
    referencedBy: inboundReferences(edges, decl.id),
    blast: impactOf(impactPairs(structure), decl.id).length,
    span: decl.span,
  };
  if (decl.meta !== undefined) node.meta = decl.meta;
  return node;
}

/**
 * Files that import `decl`'s file *and name this symbol*: the exported name is
 * the root of the symbol path, so a caller of `Registry.register` is found
 * through an import of `Registry`. A namespace import (`*`) names everything,
 * so it counts; a side-effect import names nothing, so it does not.
 *
 * Plus, for a language whose imports target a package directory rather than a
 * file, every import of the package. A Go import statement names the package
 * and nothing finer, so it cannot be filtered by symbol at all, and importing
 * `internal/store` imports every exported declaration the package holds
 * (ruling, fix round 1). Unexported declarations are excluded, because no
 * importer can reach them however the package was imported.
 */
function symbolImporters(byTarget: Map<string, ImportEdge[]>, decl: Declaration): string[] {
  const [file, directory] = importTargetsOf(decl.file);
  const exportedName = decl.name.split(".")[0] as string;
  const importers = new Set<string>();

  for (const edge of byTarget.get(file) ?? []) {
    const symbols = edge.symbols ?? [];
    if (symbols.includes("*") || symbols.includes(exportedName)) importers.add(edge.from);
  }

  if (decl.exported) {
    for (const edge of byTarget.get(directory) ?? []) {
      if (edge.from !== decl.file) importers.add(edge.from);
    }
  }

  return [...importers].sort(compareStrings);
}

export function describeFile(structure: Structure, manifest: Manifest, file: string): QueryFile {
  const entry = manifest.files[file];
  return {
    path: file,
    package: entry?.pkg ?? "",
    card: cardOf(manifest, file),
    exports: entry?.exports ?? [],
    imports: importsOfFile(structure, file),
    importers: importersOf(structure.imports, file),
    fanIn: entry?.fanIn ?? 0,
    fanOut: entry?.fanOut ?? 0,
    blast: entry?.blast ?? 0,
    loc: entry?.loc ?? 0,
  };
}

