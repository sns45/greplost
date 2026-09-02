/**
 * Linking: turn per-file extraction records into resolved graph edges.
 *
 * Every edge is either resolved from the records or not emitted; nothing is
 * guessed. See the core-extract spec, "Linking rules".
 */

import type {
  CallEdge,
  Confidence,
  DeclKind,
  FileRecord,
  ImportEdge,
  Lang,
} from "../schema.ts";
import { compareEdges, compareStrings, externalId, symbolId, unresolvedId } from "../schema.ts";

/**
 * Resolution result for one import specifier.
 *
 * Structurally identical to `ResolvedTarget` in `resolve/resolver.ts` (leaf
 * 1.1.2). It is declared here so the graph layer depends on nothing but the
 * schema; `createResolver`'s value satisfies this interface.
 */
export type ResolvedTarget =
  | { type: "file"; path: string }
  | { type: "external"; pkg: string }
  | { type: "unresolved" };

/** The one thing the graph layer needs from the resolver. */
export interface Resolver {
  resolve(fromFile: string, specifier: string, lang: Lang): ResolvedTarget;
}

/** Where an exported name actually lives. `hops` is 0 for a local declaration, 1 through one re-export. */
export interface ExportTarget {
  file: string;
  symbol: string;
  hops: 0 | 1;
}

/** file -> exported name -> target. */
export type ExportIndex = Map<string, Map<string, ExportTarget>>;

interface Binding {
  /** Repo file the local name is imported from. */
  module: string;
  /** Exported name in that module ("*" for a namespace binding). */
  name: string;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

/**
 * One `ImportEdge` per `ImportRecord`, sorted with `compareEdges` and deduped
 * on the comparator key (from, to, kind, symbols). The survivor of a tie is the
 * one with the smallest (specifier, importKind), which makes the result
 * independent of the order the records arrive in.
 */
export function linkImports(files: FileRecord[], resolver: Resolver): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const file of files) {
    for (const record of file.imports) {
      const target = resolver.resolve(file.path, record.specifier, file.lang);
      const to =
        target.type === "file"
          ? target.path
          : target.type === "external"
            ? externalId(target.pkg)
            : unresolvedId(record.specifier);
      edges.push({
        from: file.path,
        to,
        kind: record.reexport ? "reexport" : "import",
        symbols: sortedUnique(record.symbols.map((s) => s.name)),
        confidence: "high",
        specifier: record.specifier,
        importKind: record.kind,
      });
    }
  }
  edges.sort(
    (a, b) =>
      compareEdges(a, b) ||
      compareStrings(a.specifier, b.specifier) ||
      compareStrings(a.importKind, b.importKind),
  );
  const out: ImportEdge[] = [];
  for (const edge of edges) {
    const previous = out[out.length - 1];
    if (previous !== undefined && compareEdges(previous, edge) === 0) continue;
    out.push(edge);
  }
  return out;
}

/** file -> specifier -> repo file the specifier resolved to. */
function resolvedSpecifiers(files: FileRecord[], imports: ImportEdge[]): Map<string, Map<string, string>> {
  const known = new Set(files.map((f) => f.path));
  const byFile = new Map<string, Map<string, string>>();
  for (const edge of imports) {
    if (!known.has(edge.to)) continue;
    let specifiers = byFile.get(edge.from);
    if (specifiers === undefined) {
      specifiers = new Map<string, string>();
      byFile.set(edge.from, specifiers);
    }
    if (!specifiers.has(edge.specifier)) specifiers.set(edge.specifier, edge.to);
  }
  return byFile;
}

/**
 * Local name -> imported symbol, for value imports only. Re-exports bind no
 * local name; type-only and side-effect imports never carry a callable value.
 */
function importBindings(file: FileRecord, specifiers: Map<string, string> | undefined): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  if (specifiers === undefined) return bindings;
  for (const record of file.imports) {
    if (record.reexport) continue;
    if (record.kind !== "static" && record.kind !== "dynamic") continue;
    const module = specifiers.get(record.specifier);
    if (module === undefined) continue;
    for (const symbol of record.symbols) {
      if (!bindings.has(symbol.local)) bindings.set(symbol.local, { module, name: symbol.name });
    }
  }
  return bindings;
}

function setIfAbsent(map: Map<string, ExportTarget>, name: string, target: ExportTarget): void {
  if (!map.has(name)) map.set(name, target);
}

/** Names declared at the top level of a file (methods excluded), with their kind. */
function topLevelDeclarations(file: FileRecord): Map<string, DeclKind> {
  const names = new Map<string, DeclKind>();
  for (const decl of file.decls) {
    if (decl.parent !== undefined || decl.kind === "method") continue;
    if (!names.has(decl.name)) names.set(decl.name, decl.kind);
  }
  return names;
}

/**
 * Exported name -> declaration site, per file: direct declarations (hops 0) plus
 * one hop of re-exports (hops 1). Deeper chains are never followed.
 *
 * A name that is exported but cannot be pinned to a declaration (re-exported
 * from an external package, `export * as ns from`, a binding this leaf cannot
 * see) still gets an entry so `exportNames` reports it; `linkCalls` discards
 * targets that are not declared anywhere, so such entries never become edges.
 */
export function buildExportIndex(files: FileRecord[], imports: ImportEdge[]): ExportIndex {
  const specifiersByFile = resolvedSpecifiers(files, imports);

  // Pass 1: everything a file declares itself. This is the only thing a
  // re-export hop may read, which is what keeps chains one hop deep.
  const local: ExportIndex = new Map();
  const topLevelByFile = new Map<string, Map<string, DeclKind>>();
  for (const file of files) {
    const topLevel = topLevelDeclarations(file);
    topLevelByFile.set(file.path, topLevel);
    const map = new Map<string, ExportTarget>();
    for (const decl of file.decls) {
      if (decl.parent !== undefined || decl.kind === "method") continue;
      if (!decl.exported) continue;
      setIfAbsent(map, decl.name, { file: file.path, symbol: decl.name, hops: 0 });
    }
    for (const record of file.exports) {
      if (record.from !== undefined || record.kind === "star") continue;
      const localName = record.local ?? record.name;
      if (topLevel.has(localName)) {
        setIfAbsent(map, record.name, { file: file.path, symbol: localName, hops: 0 });
      }
    }
    local.set(file.path, map);
  }

  // Pass 2: re-exports, one hop, reading only pass 1.
  const index: ExportIndex = new Map();
  for (const file of files) index.set(file.path, new Map(local.get(file.path)));

  for (const file of files) {
    const specifiers = specifiersByFile.get(file.path);
    const map = index.get(file.path);
    const topLevel = topLevelByFile.get(file.path);
    if (map === undefined || topLevel === undefined) continue;
    const bindings = importBindings(file, specifiers);

    // `export { x }` / `export { x as y }` where x is an imported binding.
    for (const record of file.exports) {
      if (record.from !== undefined || record.kind === "star") continue;
      const localName = record.local ?? record.name;
      if (topLevel.has(localName)) continue;
      const binding = bindings.get(localName);
      const target = binding !== undefined && binding.name !== "*" ? local.get(binding.module)?.get(binding.name) : undefined;
      if (target !== undefined) setIfAbsent(map, record.name, { file: target.file, symbol: target.symbol, hops: 1 });
      else setIfAbsent(map, record.name, { file: file.path, symbol: localName, hops: 0 });
    }

    // `export { a as b } from "x"`, including `export { default as X } from "x"`.
    for (const record of file.exports) {
      if (record.from === undefined || record.kind === "star") continue;
      const localName = record.local ?? record.name;
      const module = specifiers?.get(record.from);
      const target = module !== undefined && localName !== "*" ? local.get(module)?.get(localName) : undefined;
      if (target !== undefined) setIfAbsent(map, record.name, { file: target.file, symbol: target.symbol, hops: 1 });
      else setIfAbsent(map, record.name, { file: file.path, symbol: record.name, hops: 0 });
    }

    // `export * from "x"`: every name x declares, except default. Names the file
    // exports itself win, and the first star wins a collision between stars.
    for (const record of file.exports) {
      if (record.kind !== "star" || record.from === undefined) continue;
      const module = specifiers?.get(record.from);
      if (module === undefined) continue;
      const source = local.get(module);
      if (source === undefined) continue;
      for (const name of [...source.keys()].sort(compareStrings)) {
        if (name === "default") continue;
        const target = source.get(name);
        if (target === undefined) continue;
        setIfAbsent(map, name, { file: target.file, symbol: target.symbol, hops: 1 });
      }
    }
  }

  return index;
}

/** Sorted exported names of a file, for `FileEntry.exports`. */
export function exportNames(index: ExportIndex, file: string): string[] {
  const map = index.get(file);
  return map === undefined ? [] : [...map.keys()].sort(compareStrings);
}

function targetOf(index: ExportIndex, module: string, name: string): { to: string; confidence: Confidence } | null {
  const target = index.get(module)?.get(name);
  if (target === undefined) return null;
  return { to: symbolId(target.file, target.symbol), confidence: target.hops === 0 ? "high" : "med" };
}

/**
 * Call edges. A callee is resolved to a same-file declaration or a uniquely
 * imported symbol (high), or through one re-export hop (med). Everything else
 * is dropped, and a target that is not a callable declaration is dropped too.
 */
export function linkCalls(files: FileRecord[], imports: ImportEdge[], index: ExportIndex): CallEdge[] {
  const declKinds = new Map<string, DeclKind>();
  const topLevelByFile = new Map<string, Map<string, DeclKind>>();
  for (const file of files) {
    for (const decl of file.decls) {
      const id = symbolId(file.path, decl.name);
      if (!declKinds.has(id)) declKinds.set(id, decl.kind);
    }
    topLevelByFile.set(file.path, topLevelDeclarations(file));
  }
  const specifiersByFile = resolvedSpecifiers(files, imports);

  const isCallable = (id: string): boolean => {
    const kind = declKinds.get(id);
    return kind !== undefined && kind !== "interface" && kind !== "type";
  };

  const edges = new Map<string, CallEdge>();
  for (const file of files) {
    const topLevel = topLevelByFile.get(file.path) ?? new Map<string, DeclKind>();
    const bindings = importBindings(file, specifiersByFile.get(file.path));

    for (const site of file.calls) {
      const callee = site.callee.startsWith("new ") ? site.callee.slice(4) : site.callee;
      const dot = callee.indexOf(".");
      const resolved =
        dot === -1
          ? resolveName(callee, file.path, topLevel, bindings, index)
          : resolveMember(
              callee.slice(0, dot),
              callee.slice(dot + 1),
              site.caller,
              file.path,
              topLevel,
              bindings,
              index,
              declKinds,
            );
      if (resolved === null || !isCallable(resolved.to)) continue;

      const from = site.caller === "" ? file.path : symbolId(file.path, site.caller);
      // NUL joins the pair: paths and symbol names may contain spaces.
      const key = `${from}\u0000${resolved.to}`;
      const existing = edges.get(key);
      if (existing === undefined) {
        edges.set(key, { from, to: resolved.to, kind: "call", confidence: resolved.confidence });
      } else if (existing.confidence === "med" && resolved.confidence === "high") {
        existing.confidence = "high";
      }
    }
  }
  return [...edges.values()].sort(compareEdges);
}

function resolveName(
  name: string,
  file: string,
  topLevel: Map<string, DeclKind>,
  bindings: Map<string, Binding>,
  index: ExportIndex,
): { to: string; confidence: Confidence } | null {
  if (name === "") return null;
  const kind = topLevel.get(name);
  if (kind !== undefined) return { to: symbolId(file, name), confidence: "high" };
  const binding = bindings.get(name);
  // A namespace binding is an object, never a bare callable name.
  if (binding === undefined || binding.name === "*") return null;
  return targetOf(index, binding.module, binding.name);
}

function resolveMember(
  object: string,
  member: string,
  caller: string,
  file: string,
  topLevel: Map<string, DeclKind>,
  bindings: Map<string, Binding>,
  index: ExportIndex,
  declKinds: Map<string, DeclKind>,
): { to: string; confidence: Confidence } | null {
  // Deeper chains are never recorded by the extractor; ignore them if seen.
  if (object === "" || member === "" || member.includes(".")) return null;

  if (object === "this") {
    const dot = caller.indexOf(".");
    const className = dot === -1 ? caller : caller.slice(0, dot);
    if (className === "") return null;
    const id = symbolId(file, `${className}.${member}`);
    return declKinds.has(id) ? { to: id, confidence: "high" } : null;
  }

  // A class declared in this file.
  if (topLevel.has(object)) {
    const id = symbolId(file, `${object}.${member}`);
    return declKinds.has(id) ? { to: id, confidence: "high" } : null;
  }

  const binding = bindings.get(object);
  if (binding === undefined) return null;

  // A namespace import: resolve the member as an export of that module.
  if (binding.name === "*") return targetOf(index, binding.module, member);

  // An imported class used statically. Only a direct (hops 0) import is
  // resolved: through a re-export the declaring file is not known here.
  const target = index.get(binding.module)?.get(binding.name);
  if (target === undefined || target.hops !== 0) return null;
  const id = symbolId(target.file, `${target.symbol}.${member}`);
  return declKinds.has(id) ? { to: id, confidence: "high" } : null;
}
