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
  Declaration,
  FileRecord,
  ImportEdge,
  Lang,
} from "../schema.ts";
import { compareEdges, compareStrings, externalId, isNodeDeclaration as isNodeDeclarationOf, symbolId, unresolvedId } from "../schema.ts";
import { buildGoCallIndex, resolveGoCall } from "../resolve/go.ts";
import { buildJavaCallIndex, resolveJavaCall } from "../resolve/java.ts";
import { buildKotlinCallIndex, resolveKotlinCall } from "../resolve/kotlin.ts";
import { buildPythonCallIndex, resolvePythonCall } from "../resolve/python.ts";
import { buildRustCallIndex, resolveRustCall } from "../resolve/rust.ts";
import { sccComponents } from "./tarjan.ts";

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

/** Where an exported name actually lives. */
export interface ExportTarget {
  file: string;
  symbol: string;
  /**
   * Re-export hops between the exporting file and the declaration: 0 for a
   * declaration in the file itself, 1 for one `export … from` / `export *`,
   * and so on through a barrel chain of any depth.
   */
  hops: number;
  /**
   * The name is exported but this leaf cannot say which declaration it names:
   * the chain leaves the repo, ends at a namespace object or an expression,
   * dead-ends on a missing name, runs into a cycle, or two `export *` sources
   * supply two different declarations. Such an entry exists only so
   * `exportNames` reports the name; it is never a call target, whatever happens
   * to be declared under `file`/`symbol`.
   */
  unpinned?: true;
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
 * on (from, to, kind, symbols, importKind): a static and a dynamic import of the
 * same names are two different facts about the file. The survivor of a tie is
 * the one with the smallest specifier, which makes the result independent of
 * the order the records arrive in.
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
      // A file importing itself (`iam.ts` writing `import * as iam from "./iam"`, which the
      // pinned pulumi corpus really does) is not a dependency between files. Kept, it would
      // add the file to its own fan-in, fan-out and blast radius, and put a self-loop in the
      // import graph. The compiler agrees: `tsc` reports no such edge (build 2, leaf 2.3).
      if (to === file.path) continue;
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
      compareStrings(a.importKind, b.importKind) ||
      compareStrings(a.specifier, b.specifier),
  );
  const out: ImportEdge[] = [];
  for (const edge of edges) {
    const previous = out[out.length - 1];
    if (previous !== undefined && compareEdges(previous, edge) === 0 && previous.importKind === edge.importKind) {
      continue;
    }
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

/**
 * True when this declaration is a schema-2 node (a route, a resource, a component) rather than
 * a symbol the language binds.
 *
 * The id decides, never the kind and never the name: `Declaration.name` is the bare node name
 * (`/x`, `bucket`, `Button`), so a `component.Button` node and the `function Button` beside it
 * share a name and differ only in their id (driver ruling 2026-09-04). Every symbol-name index
 * below skips these, so a node can never shadow, collide with, or stand in for the symbol.
 */
function isNodeDeclaration(decl: Declaration): boolean {
  // The kind is authoritative: a method on a lowercase Go type named `step` has the id
  // `pipeline.go#step.Run`, which parses like a node id but is a plain symbol.
  return isNodeDeclarationOf(decl);
}

/** Names declared at the top level of a file (methods and schema-2 nodes excluded), with their kind. */
function topLevelDeclarations(file: FileRecord): Map<string, DeclKind> {
  const names = new Map<string, DeclKind>();
  for (const decl of file.decls) {
    if (decl.parent !== undefined || decl.kind === "method") continue;
    if (isNodeDeclaration(decl)) continue;
    if (!names.has(decl.name)) names.set(decl.name, decl.kind);
  }
  return names;
}

/**
 * How one exported name gets its value: it is declared here, it comes from
 * exactly one other (module, name), or it cannot be pinned at all.
 */
type Sourcing =
  | { kind: "declared"; symbol: string }
  | { kind: "chain"; module: string; name: string }
  | { kind: "stars"; modules: string[] }
  | { kind: "unpinnable" };

/**
 * Exported name -> declaration site, per file.
 *
 * Two jobs, deliberately kept apart:
 *
 *  - The *name set* (`exportNames`, `FileEntry.exports`) matches what a
 *    compiler would report: declarations, named re-exports, and `export *`
 *    followed transitively through nested barrels.
 *  - The *target* is the one declaration the name resolves to, with the number
 *    of re-export hops it took to get there. A chain is followed to any depth
 *    but must be exact: it stops, and the name is marked `unpinned`, when a hop
 *    leaves the repo, names something that is not a single symbol, dead-ends on
 *    a missing name, runs into a cycle, or when the paths into it disagree
 *    about which declaration the name means.
 */
/**
 * True when the only export record naming this declaration is `export default`.
 *
 * `export function Page() {}` plus `export default Page` exports both names and is not this
 * case; `export default function Page() {}` exports only `default`.
 */
function exportedOnlyAsDefault(file: FileRecord, name: string): boolean {
  let asDefault = false;
  for (const record of file.exports) {
    if (record.kind === "default") {
      if (record.local === name) asDefault = true;
      continue;
    }
    if (record.name === name) return false;
  }
  return asDefault;
}

export function buildExportIndex(files: FileRecord[], imports: ImportEdge[]): ExportIndex {
  const specifiersByFile = resolvedSpecifiers(files, imports);

  // Pass 1: what each file says about its own exported names, before any chain
  // is followed. Declarations first, then export records in source order.
  const explicit = new Map<string, Map<string, Sourcing>>();
  for (const file of files) {
    const topLevel = topLevelDeclarations(file);
    const specifiers = specifiersByFile.get(file.path);
    const bindings = importBindings(file, specifiers);
    const map = new Map<string, Sourcing>();

    for (const decl of file.decls) {
      if (decl.parent !== undefined || decl.kind === "method") continue;
      if (!decl.exported) continue;
      // A non-file node (schema 2: a route, a resource, a component) lives *inside* a module
      // and is never one of the names the module exports. The id says so, not the kind: a
      // language declaration may legitimately carry a node kind's name.
      if (isNodeDeclaration(decl)) continue;
      // `export default function Page() {}` marks the declaration exported, because it is —
      // but the name it is exported under is `default`, not `Page`. The compiler reports one
      // export here and greplost used to report two, which cost S2 precision on every App
      // Router page in the corpus. The export record is the only thing that knows the
      // difference, so it decides (build 2, leaf 2.3).
      if (exportedOnlyAsDefault(file, decl.name)) continue;
      if (!map.has(decl.name)) map.set(decl.name, { kind: "declared", symbol: decl.name });
    }
    for (const record of file.exports) {
      // `export * from "x"` exports no name of its own; pass 2 expands it.
      if (record.kind === "star") continue;
      if (map.has(record.name)) continue;
      const localName = record.local ?? record.name;
      if (record.from !== undefined) {
        const module = specifiers?.get(record.from);
        // A namespace object (`export * as ns from "x"`) is not one symbol.
        map.set(
          record.name,
          module === undefined || localName === "*"
            ? { kind: "unpinnable" }
            : { kind: "chain", module, name: localName },
        );
        continue;
      }
      if (topLevel.has(localName)) {
        map.set(record.name, { kind: "declared", symbol: localName });
        continue;
      }
      const binding = bindings.get(localName);
      map.set(
        record.name,
        binding === undefined || binding.name === "*"
          ? { kind: "unpinnable" }
          : { kind: "chain", module: binding.module, name: binding.name },
      );
    }
    explicit.set(file.path, map);
  }

  // Pass 2: `export * from "x"` name sets, transitively. The star graph is
  // condensed with Tarjan and walked in the order the components come out
  // (every starred module finished before the file that stars it), so a barrel
  // over barrels reports the leaf's names and a star cycle terminates.
  const starTargets = new Map<string, string[]>();
  const starEdges: Array<[string, string]> = [];
  for (const file of files) {
    const specifiers = specifiersByFile.get(file.path);
    const targets: string[] = [];
    for (const record of file.exports) {
      if (record.kind !== "star" || record.from === undefined) continue;
      const module = specifiers?.get(record.from);
      if (module === undefined || module === file.path || targets.includes(module)) continue;
      targets.push(module);
      starEdges.push([file.path, module]);
    }
    starTargets.set(file.path, targets);
  }

  const closure = new Map<string, Set<string>>();
  for (const file of files) closure.set(file.path, new Set(explicit.get(file.path)?.keys()));

  const stars = sccComponents(
    files.map((f) => f.path),
    starEdges,
  );
  for (const component of stars.components) {
    const members = component.map((i) => stars.nodes[i] ?? "");
    const memberSet = new Set(members);
    // Names every member of the component ends up exporting. A star never
    // carries a `default`, not even between two files that star each other.
    const shared = new Set<string>();
    for (const member of members) {
      if (members.length > 1) {
        for (const name of closure.get(member) ?? []) {
          if (name !== "default") shared.add(name);
        }
      }
      for (const module of starTargets.get(member) ?? []) {
        if (memberSet.has(module)) continue;
        for (const name of closure.get(module) ?? []) {
          if (name !== "default") shared.add(name);
        }
      }
    }
    for (const member of members) {
      const names = closure.get(member);
      if (names === undefined) continue;
      for (const name of shared) names.add(name);
    }
  }

  // Pass 3: one node per (file, exported name), carrying where the name can
  // come from: a declaration here, nothing pinnable, or one or more
  // (module, name) pairs to follow. Several `export *` sources for one name are
  // fine as long as they all land on the same declaration; two different
  // declarations are the ambiguity a compiler would reject.
  const nodeIds = new Map<string, Map<string, number>>();
  const nodeFile: string[] = [];
  const nodeName: string[] = [];
  const nodeSourcing: Sourcing[] = [];
  for (const file of files) {
    const ids = new Map<string, number>();
    nodeIds.set(file.path, ids);
    const own = explicit.get(file.path);
    for (const name of [...(closure.get(file.path) ?? [])].sort(compareStrings)) {
      const sourcing: Sourcing = own?.get(name) ?? {
        kind: "stars",
        modules: (starTargets.get(file.path) ?? []).filter((m) => closure.get(m)?.has(name) === true),
      };
      ids.set(name, nodeFile.length);
      nodeFile.push(file.path);
      nodeName.push(name);
      nodeSourcing.push(sourcing);
    }
  }

  const count = nodeFile.length;
  const unpinnedAt = (node: number): ExportTarget => ({
    file: nodeFile[node] ?? "",
    symbol: nodeName[node] ?? "",
    hops: 0,
    unpinned: true,
  });

  // The source nodes to follow, and whether the name already dead-ends here:
  // the module it names does not export it, or nothing supplies it at all.
  const nodeSources: number[][] = [];
  const deadEnd = new Uint8Array(count);
  for (let node = 0; node < count; node++) {
    const sourcing = nodeSourcing[node] ?? { kind: "unpinnable" };
    const sources: number[] = [];
    if (sourcing.kind === "chain") {
      const id = nodeIds.get(sourcing.module)?.get(sourcing.name);
      if (id === undefined) deadEnd[node] = 1;
      else sources.push(id);
    } else if (sourcing.kind === "stars") {
      if (sourcing.modules.length === 0) deadEnd[node] = 1;
      for (const module of sourcing.modules) {
        const id = nodeIds.get(module)?.get(nodeName[node] ?? "");
        if (id === undefined) deadEnd[node] = 1;
        else sources.push(id);
      }
    }
    nodeSources.push(sources);
  }

  const values: Array<ExportTarget | undefined> = new Array<ExportTarget | undefined>(count);

  /**
   * One node's target, once its sources are resolved. Every source has to agree
   * on the declaration; a source that is itself unpinned, a dead end, or a
   * cycle leaves the name exported but unpinnable.
   */
  const resolveNode = (node: number, blocked: boolean): ExportTarget => {
    const sourcing = nodeSourcing[node];
    if (sourcing !== undefined && sourcing.kind === "declared") {
      return { file: nodeFile[node] ?? "", symbol: sourcing.symbol, hops: 0 };
    }
    if (blocked || deadEnd[node] === 1) return unpinnedAt(node);
    const sources = nodeSources[node] ?? [];
    if (sources.length === 0) return unpinnedAt(node);
    let best: ExportTarget | undefined;
    for (const source of sources) {
      const value = values[source];
      if (value === undefined || value.unpinned === true) return unpinnedAt(node);
      if (best === undefined) {
        best = { file: value.file, symbol: value.symbol, hops: value.hops + 1 };
        continue;
      }
      if (best.file !== value.file || best.symbol !== value.symbol) return unpinnedAt(node);
      // The same declaration down two paths: keep the shorter one.
      if (value.hops + 1 < best.hops) best = { file: value.file, symbol: value.symbol, hops: value.hops + 1 };
    }
    return best ?? unpinnedAt(node);
  };

  // Depth first, iteratively: a node is resolved after its sources, and a node
  // still on the stack when it is reached again is a re-export cycle.
  const state = new Uint8Array(count);
  const stack: Array<{ node: number; index: number; blocked: boolean }> = [];
  for (let start = 0; start < count; start++) {
    if (state[start] === 2) continue;
    state[start] = 1;
    stack.push({ node: start, index: 0, blocked: false });
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      const sources = nodeSources[frame.node] ?? [];
      if (frame.index < sources.length) {
        const child = sources[frame.index] ?? 0;
        frame.index += 1;
        if (state[child] === 0) {
          state[child] = 1;
          stack.push({ node: child, index: 0, blocked: false });
        } else if (state[child] === 1) {
          frame.blocked = true;
        }
        continue;
      }
      stack.pop();
      state[frame.node] = 2;
      values[frame.node] = resolveNode(frame.node, frame.blocked);
    }
  }

  const index: ExportIndex = new Map();
  for (const file of files) {
    const map = new Map<string, ExportTarget>();
    for (const [name, node] of nodeIds.get(file.path) ?? []) {
      map.set(name, values[node] ?? unpinnedAt(node));
    }
    index.set(file.path, map);
  }
  return index;
}

/** Sorted exported names of a file, for `FileEntry.exports`. */
export function exportNames(index: ExportIndex, file: string): string[] {
  const map = index.get(file);
  return map === undefined ? [] : [...map.keys()].sort(compareStrings);
}

/** A resolved export as a call target: no hop is high, any chain is med. */
function targetOf(index: ExportIndex, module: string, name: string): { to: string; confidence: Confidence } | null {
  const target = index.get(module)?.get(name);
  if (target === undefined || target.unpinned === true) return null;
  return { to: symbolId(target.file, target.symbol), confidence: target.hops === 0 ? "high" : "med" };
}

/**
 * Call edges. A callee is resolved to a same-file declaration or a directly
 * imported symbol (high), or through a chain of re-exports of any depth (med).
 * Everything else is dropped, and a target that is not a callable declaration
 * is dropped too.
 */
export function linkCalls(files: FileRecord[], imports: ImportEdge[], index: ExportIndex): CallEdge[] {
  const declKinds = new Map<string, DeclKind>();
  const topLevelByFile = new Map<string, Map<string, DeclKind>>();
  for (const file of files) {
    for (const decl of file.decls) {
      // A node is not a call target and must not claim the symbol id its bare name would make:
      // `component.Button` would otherwise register `<file>#Button` as kind `component` and
      // shadow the `function Button` a call actually lands on.
      if (isNodeDeclaration(decl)) continue;
      const id = symbolId(file.path, decl.name);
      if (!declKinds.has(id)) declKinds.set(id, decl.kind);
    }
    topLevelByFile.set(file.path, topLevelDeclarations(file));
  }
  const specifiersByFile = resolvedSpecifiers(files, imports);
  // Go resolves calls through its own scope rules (leaf 1.8); the index is the
  // shared empty one, at no cost, when the repo holds no Go file.
  const goCalls = buildGoCallIndex(files, imports);
  // Build 2: each language with its own scoping rules resolves its own calls (leaves 2.1.1,
  // 2.1.2, 2.1.3, 2.1.4). Every index is the shared empty one, at no cost, when the repo holds
  // no file of that language.
  const rustCalls = buildRustCallIndex(files, imports);
  const pythonCalls = buildPythonCallIndex(files, imports);
  const javaCalls = buildJavaCallIndex(files, imports);
  const kotlinCalls = buildKotlinCallIndex(files, imports);

  const isCallable = (id: string): boolean => {
    const kind = declKinds.get(id);
    return kind !== undefined && kind !== "interface" && kind !== "type";
  };

  // from -> to -> edge, so no separator can collide with a path or symbol name.
  const edges = new Map<string, Map<string, CallEdge>>();
  for (const file of files) {
    const topLevel = topLevelByFile.get(file.path) ?? new Map<string, DeclKind>();
    const bindings = importBindings(file, specifiersByFile.get(file.path));

    for (const site of file.calls) {
      const callee = site.callee.startsWith("new ") ? site.callee.slice(4) : site.callee;
      const dot = callee.indexOf(".");
      const resolved = file.lang === "go"
        ? // Package scope, import aliases and method receivers: none of the
          // TypeScript rules below apply to a Go file. See resolve/go.ts.
          resolveGoCall(file, site, goCalls)
        : file.lang === "rust"
          ? resolveRustCall(file, site, rustCalls)
          : file.lang === "python"
            ? resolvePythonCall(file, site, pythonCalls)
            : file.lang === "java"
              ? resolveJavaCall(file, site, javaCalls)
              : file.lang === "kotlin"
                ? resolveKotlinCall(file, site, kotlinCalls)
                : dot === -1
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
      let targets = edges.get(from);
      if (targets === undefined) {
        targets = new Map<string, CallEdge>();
        edges.set(from, targets);
      }
      const existing = targets.get(resolved.to);
      if (existing === undefined) {
        targets.set(resolved.to, { from, to: resolved.to, kind: "call", confidence: resolved.confidence });
      } else if (existing.confidence === "med" && resolved.confidence === "high") {
        existing.confidence = "high";
      }
    }
  }

  const out: CallEdge[] = [];
  for (const targets of edges.values()) out.push(...targets.values());
  return out.sort(compareEdges);
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

  // An imported class used statically, through however many re-export hops.
  const target = index.get(binding.module)?.get(binding.name);
  if (target === undefined || target.unpinned === true) return null;
  const id = symbolId(target.file, `${target.symbol}.${member}`);
  if (!declKinds.has(id)) return null;
  return { to: id, confidence: target.hops === 0 ? "high" : "med" };
}
