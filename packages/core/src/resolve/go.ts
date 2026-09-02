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
 *                         receiver variable of the enclosing method.
 *     Everything else is dropped. Only `function` and `method` declarations are
 *     ever targets: `Store(x)` is a conversion, not a call, and `Store` is a
 *     `struct` declaration, so it can never be one.
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

export interface GoCallIndex {
  /** directory id -> package-scope `func` name -> declaring files. */
  functions: Map<string, Declarers>;
  /** directory id -> `<Type>.<method>` -> declaring files. */
  methods: Map<string, Declarers>;
  /** file -> import local name -> directory id of the imported package. */
  aliases: Map<string, Map<string, string>>;
  /** file -> method symbol path -> receiver variable name (absent when unnamed). */
  receivers: Map<string, Map<string, string>>;
}

const EMPTY_INDEX: GoCallIndex = {
  functions: new Map(),
  methods: new Map(),
  aliases: new Map(),
  receivers: new Map(),
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
  };
  const paths = new Set(goFiles.map((file) => file.path));

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
    for (const record of file.imports) {
      const local = record.symbols[0]?.local;
      // `_` binds nothing (side-effect) and `.` merges the package into file
      // scope without a qualifier: neither can appear as `obj` in `obj.m()`.
      if (local === undefined || local === "." || local === "_") continue;
      const target = specifiers.get(record.specifier);
      if (target === undefined || aliases.has(local)) continue;
      aliases.set(local, target);
    }
    if (aliases.size > 0) index.aliases.set(file.path, aliases);
  }

  return index;
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
  const method = `${site.caller.slice(0, dotInCaller)}.${member}`;
  const target = declaringFile(index.methods, dir, method, file.path);
  return target === null ? null : { to: symbolId(target, method), confidence: "high" };
}
