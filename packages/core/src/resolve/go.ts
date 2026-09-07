/**
 * Go resolution and Go call linking (go sub-project spec).
 *
 * Two jobs, both Go-only, both kept out of the TypeScript paths they have
 * nothing in common with:
 *
 *  1. `createGoResolver` turns an import path into a **package directory id**.
 *     A Go import names a package, not a file (tech spec Appendix C), so the
 *     target of an import edge is the repo-relative directory holding that
 *     package - `"."` for the module root - whenever that directory holds at
 *     least one indexed `.go` file. Standard-library and other-module paths are
 *     `ext:<import path>`.
 *
 *  2. `buildGoCallIndex` / `resolveGoCall` implement the three call rules the go
 *     spec fixes, called from `graph/link.ts` for `lang === "go"` files:
 *       - `f()`        -> a package-scope `func f` in the same directory;
 *       - `pkg.F()`    -> a `func F` in the directory `pkg` was imported from;
 *       - `recv.m()`   -> `<Type>.m` in the same directory, when `recv` is the
 *                         receiver variable of the enclosing method **or a local
 *                         binding whose type the extractor could decide**, and
 *                         where `<Type>` may promote `m` from a field it embeds.
 *     Everything else is dropped. Only `function` and `method` declarations are
 *     ever targets: `Store(x)` is a conversion, not a call, and `Store` is a
 *     `struct` declaration, so it can never be one.
 *
 * Build 2.1 widened rule 3 twice, both times without widening the contract that
 * a `high` edge names the one declaration that can be the callee:
 *   - **promotion**: a Go method set includes the methods of every embedded
 *     field, so `c.ApplyStrategy()` on a `Consumer` that embeds
 *     `*core.BaseConsumer` calls `core.BaseConsumer.ApplyStrategy`. The embedded
 *     types are searched breadth first to depth 3, shallowest wins (Go's own
 *     rule), and a depth where two embedded types supply the member is ambiguous
 *     in Go too, so the edge is dropped rather than guessed.
 *   - **local receivers**: `d := &delivery{}` fixes the type of `d`, so
 *     `d.dispose()` is as certain as a call on the receiver. The extractor
 *     decides which locals qualify (`extract/go-types.ts`) and writes the type
 *     into `meta.locals`; nothing here infers a type.
 *
 * A name declared in more than one file of a directory (mutually exclusive
 * build tags, `//go:build ...`) is ambiguous: it resolves only for a caller in
 * one of those files, and is otherwise dropped rather than guessed.
 */

import type { CallSite, Confidence, FileRecord, ImportEdge } from "../schema.ts";
import { compareStrings, symbolId } from "../schema.ts";

/** The resolver's answer for one Go import path. Assignable to `ResolvedTarget`. */
export type GoTarget = { type: "file"; path: string } | { type: "external"; pkg: string };

/** What `createGoResolver` needs; a structural subset of `RepoContext`. */
export interface GoRepoContext {
  /** Indexed, repo-relative file paths (forward slashes). */
  files: ReadonlySet<string>;
  /** Repo-relative read; null when the file is absent. */
  readFile: (rel: string) => string | null;
}

/** The repo-root directory id. A Go import of the main module resolves here. */
const ROOT_DIR_ID = ".";

/** Directory of a repo-relative path; `"."` for a file at the repo root. */
export function goDirectoryOf(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index === -1 ? ROOT_DIR_ID : filePath.slice(0, index);
}

function stripGoComment(line: string): string {
  const index = line.indexOf("//");
  return index === -1 ? line : line.slice(0, index);
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

/** The `module <path>` directive of a go.mod, or "" when there is none. */
export function goModulePath(text: string | null): string {
  if (text === null) return "";
  for (const raw of text.split(/\r?\n/)) {
    const match = /^module\s+(.+)$/.exec(stripGoComment(raw).trim());
    if (match) return unquote(match[1] ?? "");
  }
  return "";
}

function parentDir(dir: string): string {
  const index = dir.lastIndexOf("/");
  return index === -1 ? "" : dir.slice(0, index);
}

function joinRelative(dir: string, rest: string): string {
  if (rest === "") return dir;
  return dir === "" ? rest : `${dir}/${rest}`;
}

/**
 * A Go import resolver over the indexed file set.
 *
 * Every module in the repo is found once, by probing `go.mod` in each ancestor
 * directory of an indexed `.go` file, so a `go.work` layout with several modules
 * resolves each of them. An import path is matched against the *longest* module
 * path that prefixes it, which is what the go command does when nested modules
 * share a prefix.
 */
export function createGoResolver(ctx: GoRepoContext): (fromDir: string, specifier: string) => GoTarget {
  /** Directories holding at least one indexed `.go` file. */
  let goDirs: Set<string> | null = null;
  /** `{ dir, path }` per module found in the repo, longest module path first. */
  let modules: Array<{ dir: string; path: string }> | null = null;

  function index(): { dirs: Set<string>; mods: Array<{ dir: string; path: string }> } {
    if (goDirs === null || modules === null) {
      const dirs = new Set<string>();
      const seen = new Set<string>();
      const found: Array<{ dir: string; path: string }> = [];
      for (const file of [...ctx.files].sort(compareStrings)) {
        if (!file.endsWith(".go")) continue;
        const dir = goDirectoryOf(file);
        dirs.add(dir === ROOT_DIR_ID ? "" : dir);
        // Probe every ancestor directory once for a module declaration.
        let current = dir === ROOT_DIR_ID ? "" : dir;
        for (;;) {
          if (!seen.has(current)) {
            seen.add(current);
            const modulePath = goModulePath(ctx.readFile(joinRelative(current, "go.mod")));
            if (modulePath !== "") found.push({ dir: current, path: modulePath });
          }
          if (current === "") break;
          current = parentDir(current);
        }
      }
      found.sort((a, b) => b.path.length - a.path.length || compareStrings(a.path, b.path));
      goDirs = dirs;
      modules = found;
    }
    return { dirs: goDirs, mods: modules };
  }

  return (_fromDir: string, specifier: string): GoTarget => {
    const external: GoTarget = { type: "external", pkg: specifier };
    if (specifier === "") return external;
    const { dirs, mods } = index();
    for (const module of mods) {
      let rest: string;
      if (specifier === module.path) rest = "";
      else if (specifier.startsWith(`${module.path}/`)) rest = specifier.slice(module.path.length + 1);
      else continue;
      const targetDir = joinRelative(module.dir, rest);
      // A directory of the module that holds no indexed .go file carries no
      // structure this map can point at; it is reported as external, not guessed.
      if (!dirs.has(targetDir)) return external;
      return { type: "file", path: targetDir === "" ? ROOT_DIR_ID : targetDir };
    }
    return external;
  };
}

// ---------------------------------------------------------------------------
// call linking
// ---------------------------------------------------------------------------

/** Declaring files for one name, in path order. More than one means build tags. */
type Declarers = Map<string, string[]>;

/** A named type, with the directory of the package that declares it. */
export interface GoTypeRef {
  dir: string;
  name: string;
}

/** How deep a promoted method is searched for through embedded fields. */
const MAX_EMBED_DEPTH = 3;

export interface GoCallIndex {
  /** directory id -> package-scope `func` name -> declaring files. */
  functions: Map<string, Declarers>;
  /** directory id -> `<Type>.<method>` -> declaring files. */
  methods: Map<string, Declarers>;
  /** file -> import local name -> directory id of the imported package. */
  aliases: Map<string, Map<string, string>>;
  /** file -> method symbol path -> receiver variable name (absent when unnamed). */
  receivers: Map<string, Map<string, string>>;
  /** directory id -> struct name -> the types it embeds, resolved. */
  embeds: Map<string, Map<string, GoTypeRef[]>>;
  /**
   * file -> caller symbol path -> local name -> the type it was bound to, or
   * null when that type names no package in this repo. The name is present
   * either way: a local shadows every package-scope name, so the entry is what
   * stops rule 2 from reading a local called `store` as the `store` import.
   */
  locals: Map<string, Map<string, Map<string, GoTypeRef | null>>>;
}

const EMPTY_INDEX: GoCallIndex = {
  functions: new Map(),
  methods: new Map(),
  aliases: new Map(),
  receivers: new Map(),
  embeds: new Map(),
  locals: new Map(),
};

/**
 * The receiver variable of a method, read back off its signature.
 *
 * `extractGo` writes the signature as `func (s *Store) Put(...)`, whitespace
 * collapsed, so the receiver name is the first token inside the parentheses and
 * survives the 200-character clip. `func (*Store) Put()` declares no receiver
 * variable and yields null, which is exactly right: there is no name for a call
 * to be written against.
 */
function receiverVariable(signature: string): string | null {
  const match = /^func\s*\(\s*([\p{L}_][\p{L}\p{N}_]*)\s+\*?\s*[\p{L}_]/u.exec(signature);
  return match === null ? null : (match[1] ?? null);
}

/**
 * Whether `local` is the name an import gets when nothing was written down: the
 * last segment of its path. `extractGo` produces exactly that default, so this
 * recovers "was there an explicit alias?" without widening `ImportRecord`.
 */
function isDefaultLocal(specifier: string, local: string): boolean {
  const segments = specifier.split("/");
  return (segments[segments.length - 1] ?? specifier) === local;
}

function addDeclarer(map: Map<string, Declarers>, dir: string, name: string, file: string): void {
  let byName = map.get(dir);
  if (byName === undefined) {
    byName = new Map<string, string[]>();
    map.set(dir, byName);
  }
  const files = byName.get(name);
  if (files === undefined) byName.set(name, [file]);
  else if (!files.includes(file)) files.push(file);
}

/**
 * Everything Go call resolution needs, gathered in one pass over the Go files
 * and one pass over the import edges. A repo with no Go files gets the shared
 * empty index and pays nothing.
 */
export function buildGoCallIndex(files: readonly FileRecord[], imports: readonly ImportEdge[]): GoCallIndex {
  const goFiles = files.filter((file) => file.lang === "go");
  if (goFiles.length === 0) return EMPTY_INDEX;

  const index: GoCallIndex = {
    functions: new Map(),
    methods: new Map(),
    aliases: new Map(),
    receivers: new Map(),
    embeds: new Map(),
    locals: new Map(),
  };
  const paths = new Set(goFiles.map((file) => file.path));
  /** dir -> declared name -> the result types written down, one per declarer. */
  const results = new Map<string, Map<string, Array<{ file: string; type: string }>>>();
  /** The `meta.embeds` of every struct, kept until the import aliases are known. */
  const embeds: Array<{ dir: string; file: string; name: string; raw: string }> = [];

  for (const file of goFiles) {
    const dir = goDirectoryOf(file.path);
    const receivers = new Map<string, string>();
    for (const decl of file.decls) {
      if (decl.kind === "function" && decl.parent === undefined) {
        addDeclarer(index.functions, dir, decl.name, file.path);
      } else if (decl.kind === "method") {
        addDeclarer(index.methods, dir, decl.name, file.path);
        const receiver = receiverVariable(decl.signature);
        if (receiver !== null) receivers.set(decl.name, receiver);
      }
      const raw = decl.meta?.["embeds"];
      if (raw !== undefined) embeds.push({ dir, file: file.path, name: decl.name, raw });
      const result = decl.meta?.["result"];
      if (result !== undefined) addResult(results, dir, decl.name, file.path, result);
    }
    if (receivers.size > 0) index.receivers.set(file.path, receivers);
  }

  // Import aliases, from the resolved edges: only a target that is a repo
  // directory can ever carry a call, so `ext:`/`unresolved:` targets are skipped.
  const targetsByFile = new Map<string, Map<string, string>>();
  for (const edge of imports) {
    if (!paths.has(edge.from)) continue;
    if (edge.to.startsWith("ext:") || edge.to.startsWith("unresolved:") || edge.to.includes("#")) continue;
    let specifiers = targetsByFile.get(edge.from);
    if (specifiers === undefined) {
      specifiers = new Map<string, string>();
      targetsByFile.set(edge.from, specifiers);
    }
    if (!specifiers.has(edge.specifier)) specifiers.set(edge.specifier, edge.to);
  }
  for (const file of goFiles) {
    const specifiers = targetsByFile.get(file.path);
    if (specifiers === undefined) continue;
    const aliases = new Map<string, string>();
    // Two passes, explicit aliases first. A default local is the last path
    // segment, which is only a guess at the package's declared name; an alias is
    // written down. So `import "y/bar"` must never take the name `bar` away from
    // `import bar "x/baz"`, whatever order they appear in.
    for (const explicit of [true, false]) {
      for (const record of file.imports) {
        const local = record.symbols[0]?.local;
        // `_` binds nothing (side-effect) and `.` merges the package into file
        // scope without a qualifier: neither can appear as `obj` in `obj.m()`.
        if (local === undefined || local === "." || local === "_") continue;
        if (isDefaultLocal(record.specifier, local) === explicit) continue;
        const target = specifiers.get(record.specifier);
        if (target === undefined || aliases.has(local)) continue;
        aliases.set(local, target);
      }
    }
    if (aliases.size > 0) index.aliases.set(file.path, aliases);
  }

  // Embedded fields and typed locals both name types the way the *declaring*
  // file wrote them, so they resolve only once the import aliases are known.
  for (const struct of embeds) {
    const refs: GoTypeRef[] = [];
    for (const raw of struct.raw.split(",")) {
      const ref = typeRef(index, raw, struct.file, struct.dir);
      if (ref !== null) refs.push(ref);
    }
    if (refs.length === 0) continue;
    let byName = index.embeds.get(struct.dir);
    if (byName === undefined) {
      byName = new Map<string, GoTypeRef[]>();
      index.embeds.set(struct.dir, byName);
    }
    byName.set(struct.name, [...(byName.get(struct.name) ?? []), ...refs]);
  }

  for (const file of goFiles) {
    const dir = goDirectoryOf(file.path);
    const byCaller = new Map<string, Map<string, GoTypeRef | null>>();
    for (const decl of file.decls) {
      const raw = decl.meta?.["locals"];
      if (raw === undefined) continue;
      const locals = new Map<string, GoTypeRef | null>();
      for (const entry of raw.split(",")) {
        const colon = entry.indexOf(":");
        if (colon === -1) continue;
        const value = entry.slice(colon + 1);
        locals.set(
          entry.slice(0, colon),
          value.startsWith("@")
            ? resultRef(index, results, value.slice(1), decl.name, file.path, dir)
            : typeRef(index, value, file.path, dir),
        );
      }
      if (locals.size > 0) byCaller.set(decl.name, locals);
    }
    if (byCaller.size > 0) index.locals.set(file.path, byCaller);
  }

  return index;
}

/** Record one declaration's result type; a second declarer of a name is ambiguous. */
function addResult(
  results: Map<string, Map<string, Array<{ file: string; type: string }>>>,
  dir: string,
  name: string,
  file: string,
  type: string,
): void {
  let byName = results.get(dir);
  if (byName === undefined) {
    byName = new Map<string, Array<{ file: string; type: string }>>();
    results.set(dir, byName);
  }
  byName.set(name, [...(byName.get(name) ?? []), { file, type }]);
}

/**
 * A type as one file wrote it, resolved to the package that declares it.
 *
 * A bare `Store` is this file's own package; `core.Base` is whatever `core` was
 * imported from, resolved exactly as a package-qualified call is (rule 1). A
 * qualifier that names no repo package - the standard library, another module -
 * gives null, and nothing is promoted through it.
 */
function typeRef(index: GoCallIndex, raw: string, file: string, dir: string): GoTypeRef | null {
  const dot = raw.indexOf(".");
  if (dot === -1) return raw === "" ? null : { dir, name: raw };
  const name = raw.slice(dot + 1);
  if (name === "" || name.includes(".")) return null;
  const target = index.aliases.get(file)?.get(raw.slice(0, dot));
  return target === undefined ? null : { dir: target, name };
}

/**
 * The type of `x` in `x, err := <callee>()`: the first result of the declaration
 * `callee` names, read off the `meta.result` the extractor wrote there.
 *
 * Only two callees are followed, and only one hop: a package-scope function of
 * the caller's own package, and a method on the enclosing method's receiver.
 * Nothing else is decidable without reading another package's source, and a
 * chain of locals would need the map this function is helping to build.
 */
function resultRef(
  index: GoCallIndex,
  results: Map<string, Map<string, Array<{ file: string; type: string }>>>,
  callee: string,
  caller: string,
  file: string,
  dir: string,
): GoTypeRef | null {
  const dot = callee.indexOf(".");
  let declared: string;
  if (dot === -1) {
    if (declaringFile(index.functions, dir, callee, file) === null) return null;
    declared = callee;
  } else {
    const dotInCaller = caller.indexOf(".");
    if (dotInCaller === -1) return null;
    if (index.receivers.get(file)?.get(caller) !== callee.slice(0, dot)) return null;
    declared = `${caller.slice(0, dotInCaller)}.${callee.slice(dot + 1)}`;
    if (declaringFile(index.methods, dir, declared, file) === null) return null;
  }
  const found = results.get(dir)?.get(declared);
  // Two declarers (build tags) make two possible result types: not a fact.
  if (found === undefined || found.length !== 1) return null;
  const only = found[0] as { file: string; type: string };
  return typeRef(index, only.type, only.file, dir);
}

/**
 * The single declaring file for `name` in `dir`, or null.
 *
 * More than one file declares the name only when mutually exclusive build tags
 * put two versions of a package in one directory. The caller's own file then
 * settles it (they are compiled together); from anywhere else it is a guess and
 * the edge is dropped.
 */
function declaringFile(map: Map<string, Declarers>, dir: string, name: string, preferFile: string | null): string | null {
  const files = map.get(dir)?.get(name);
  if (files === undefined || files.length === 0) return null;
  if (files.length === 1) return files[0] ?? null;
  if (preferFile !== null && files.includes(preferFile)) return preferFile;
  return null;
}

/**
 * One Go call site resolved to a declaration, or null when nothing is certain.
 * Every Go call edge is `high`: it names a declaration reached through Go's own
 * scope rules, never through a re-export chain.
 */
export function resolveGoCall(
  file: FileRecord,
  site: CallSite,
  index: GoCallIndex,
): { to: string; confidence: Confidence } | null {
  const callee = site.callee;
  if (callee === "") return null;
  const dir = goDirectoryOf(file.path);
  const dot = callee.indexOf(".");

  // 1. A package-scope function of this file's own package.
  if (dot === -1) {
    const target = declaringFile(index.functions, dir, callee, file.path);
    return target === null ? null : { to: symbolId(target, callee), confidence: "high" };
  }

  const object = callee.slice(0, dot);
  const member = callee.slice(dot + 1);
  if (object === "" || member === "" || member.includes(".")) return null;

  // A local binding shadows every package-scope name in Go, so a name the
  // extractor recorded as a local of this caller never reaches rule 2 - not even
  // when its own type turned out to name nothing in this repo.
  const locals = index.locals.get(file.path)?.get(site.caller);
  if (locals !== undefined && locals.has(object)) {
    return methodEdge(index, locals.get(object) ?? null, member, file.path, dir);
  }

  // 2. A qualified call through an import: the package's directory decides.
  const importedDir = index.aliases.get(file.path)?.get(object);
  if (importedDir !== undefined) {
    const target = declaringFile(index.functions, importedDir, member, null);
    return target === null ? null : { to: symbolId(target, member), confidence: "high" };
  }

  // 3. A method call on the enclosing method's receiver variable.
  const dotInCaller = site.caller.indexOf(".");
  if (dotInCaller === -1) return null;
  if (index.receivers.get(file.path)?.get(site.caller) !== object) return null;
  return methodEdge(index, { dir, name: site.caller.slice(0, dotInCaller) }, member, file.path, dir);
}

/**
 * The edge from a call on a value of `type`: the method the type declares
 * itself, else the one it promotes from an embedded field.
 */
function methodEdge(
  index: GoCallIndex,
  type: GoTypeRef | null,
  member: string,
  fromFile: string,
  fromDir: string,
): { to: string; confidence: Confidence } | null {
  if (type === null) return null;
  const target = methodOf(index, type, member, fromFile, fromDir) ?? promoted(index, type, member, fromFile, fromDir);
  return target === null ? null : { to: target, confidence: "high" };
}

/** `<type>.<member>` declared on the type itself, as a node id, or null. */
function methodOf(
  index: GoCallIndex,
  type: GoTypeRef,
  member: string,
  fromFile: string,
  fromDir: string,
): string | null {
  const method = `${type.name}.${member}`;
  const target = declaringFile(index.methods, type.dir, method, type.dir === fromDir ? fromFile : null);
  return target === null ? null : symbolId(target, method);
}

/**
 * `<type>.<member>` promoted from an embedded field, as a node id, or null.
 *
 * Go's rule: the member at the shallowest depth wins, and if two of them share
 * that depth the selector is illegal. So the embedded types are walked breadth
 * first, one depth at a time, and a depth that supplies the member twice is
 * dropped rather than guessed - the same answer the compiler gives.
 */
function promoted(
  index: GoCallIndex,
  start: GoTypeRef,
  member: string,
  fromFile: string,
  fromDir: string,
): string | null {
  const key = (type: GoTypeRef): string => `${type.dir}\u0000${type.name}`;
  const seen = new Set<string>([key(start)]);
  let frontier: GoTypeRef[] = [start];
  for (let depth = 0; depth < MAX_EMBED_DEPTH && frontier.length > 0; depth += 1) {
    const next: GoTypeRef[] = [];
    const found = new Set<string>();
    for (const type of frontier) {
      for (const embedded of index.embeds.get(type.dir)?.get(type.name) ?? []) {
        if (seen.has(key(embedded))) continue;
        seen.add(key(embedded));
        next.push(embedded);
        const target = methodOf(index, embedded, member, fromFile, fromDir);
        if (target !== null) found.add(target);
      }
    }
    if (found.size === 1) return [...found][0] ?? null;
    if (found.size > 1) return null;
    frontier = next;
  }
  return null;
}
