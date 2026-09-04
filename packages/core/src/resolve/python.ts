/**
 * Python resolution and Python call linking (build 2, leaf 2.1; spec section 1.2).
 *
 * Two jobs, both Python-only:
 *
 *  1. `createPythonResolver` turns a dotted module path into a **file id**. Unlike Go, a
 *     Python package is a file: `import tiny` targets `tiny/__init__.py`, because that is
 *     the module the interpreter actually executes and the file a reader has to open.
 *     Relative specifiers (`.`, `..pkg.mod`) keep their dots and resolve against the
 *     importing file's own package directory, one level up per extra dot (PEP 328).
 *     Anything the indexed file set cannot answer is external — `ext:<name>` for a
 *     standard-library root, `ext:pypi/<name>` for a distribution — or, for a relative
 *     specifier that names nothing, `unresolved`.
 *
 *  2. `buildPythonCallIndex` / `resolvePythonCall` implement the five call rules the spec
 *     fixes: a same-file top-level name (`high`), a name bound by exactly one
 *     `from X import name` whose target declares it (`high`), `obj.method` where `obj` is a
 *     module alias from `import X as obj` (`high`), `this.method` inside a class (`high`),
 *     and a name re-exported through exactly one `__init__.py` (`med`). Everything else is
 *     dropped, never guessed.
 *
 * **Where the call rules actually run.** `graph/link.ts`'s shared resolver already
 * implements exactly those five, because `extract/python.ts` writes `self.m()` as
 * `this.m` and writes `import X as obj` as a namespace symbol — which is why the spec
 * asks for that normalisation. Python therefore needs no branch in `link.ts` and this
 * leaf edits no shared file. The two functions below are the contract's standalone form
 * of the same rules: they are tested directly, and a caller that wants Python call
 * resolution without the whole export index has it.
 *
 * The standard-library list is a committed literal generated once from
 * `sys.stdlib_module_names` on python3 3.14. It is never read from the host: a map must not
 * change because the machine that built it had a different interpreter on its PATH.
 */

import type { CallSite, Confidence, FileRecord, ImportEdge } from "../schema.ts";
import { compareStrings, symbolId } from "../schema.ts";
import type { RepoContext, ResolvedTarget } from "./resolver.ts";

/**
 * Standard-library top-level module names, python3 3.14 (`sorted(sys.stdlib_module_names)`),
 * committed as a literal. Regenerate with:
 *
 *     python3 -c "import sys; print(sorted(sys.stdlib_module_names))"
 *
 * Reading it from the host at runtime would make a repo's map depend on which interpreter
 * happened to be installed, which the determinism contract forbids.
 */
export const PY_STDLIB: ReadonlySet<string> = new Set([
  "__future__", "_abc", "_aix_support", "_android_support", "_apple_support", "_ast", "_ast_unparse",
  "_asyncio", "_bisect", "_blake2", "_bz2", "_codecs", "_codecs_cn", "_codecs_hk", "_codecs_iso2022",
  "_codecs_jp", "_codecs_kr", "_codecs_tw", "_collections", "_collections_abc", "_colorize", "_compat_pickle",
  "_contextvars", "_csv", "_ctypes", "_curses", "_curses_panel", "_datetime", "_dbm", "_decimal",
  "_elementtree", "_frozen_importlib", "_frozen_importlib_external", "_functools", "_gdbm", "_hashlib",
  "_heapq", "_hmac", "_imp", "_interpchannels", "_interpqueues", "_interpreters", "_io", "_ios_support",
  "_json", "_locale", "_lsprof", "_lzma", "_markupbase", "_md5", "_multibytecodec", "_multiprocessing",
  "_opcode", "_opcode_metadata", "_operator", "_osx_support", "_overlapped", "_pickle", "_posixshmem",
  "_posixsubprocess", "_py_abc", "_py_warnings", "_pydatetime", "_pydecimal", "_pyio", "_pylong", "_pyrepl",
  "_queue", "_random", "_remote_debugging", "_scproxy", "_sha1", "_sha2", "_sha3", "_signal", "_sitebuiltins",
  "_socket", "_sqlite3", "_sre", "_ssl", "_stat", "_statistics", "_string", "_strptime", "_struct",
  "_suggestions", "_symtable", "_sysconfig", "_thread", "_threading_local", "_tkinter", "_tokenize",
  "_tracemalloc", "_types", "_typing", "_uuid", "_warnings", "_weakref", "_weakrefset", "_winapi", "_wmi",
  "_zoneinfo", "_zstd", "abc", "annotationlib", "antigravity", "argparse", "array", "ast", "asyncio",
  "atexit", "base64", "bdb", "binascii", "bisect", "builtins", "bz2", "cProfile", "calendar", "cmath", "cmd",
  "code", "codecs", "codeop", "collections", "colorsys", "compileall", "compression", "concurrent",
  "configparser", "contextlib", "contextvars", "copy", "copyreg", "csv", "ctypes", "curses", "dataclasses",
  "datetime", "dbm", "decimal", "difflib", "dis", "doctest", "email", "encodings", "ensurepip", "enum",
  "errno", "faulthandler", "fcntl", "filecmp", "fileinput", "fnmatch", "fractions", "ftplib", "functools",
  "gc", "genericpath", "getopt", "getpass", "gettext", "glob", "graphlib", "grp", "gzip", "hashlib", "heapq",
  "hmac", "html", "http", "idlelib", "imaplib", "importlib", "inspect", "io", "ipaddress", "itertools",
  "json", "keyword", "linecache", "locale", "logging", "lzma", "mailbox", "marshal", "math", "mimetypes",
  "mmap", "modulefinder", "msvcrt", "multiprocessing", "netrc", "nt", "ntpath", "nturl2path", "numbers",
  "opcode", "operator", "optparse", "os", "pathlib", "pdb", "pickle", "pickletools", "pkgutil", "platform",
  "plistlib", "poplib", "posix", "posixpath", "pprint", "profile", "pstats", "pty", "pwd", "py_compile",
  "pyclbr", "pydoc", "pydoc_data", "pyexpat", "queue", "quopri", "random", "re", "readline", "reprlib",
  "resource", "rlcompleter", "runpy", "sched", "secrets", "select", "selectors", "shelve", "shlex", "shutil",
  "signal", "site", "smtplib", "socket", "socketserver", "sqlite3", "sre_compile", "sre_constants",
  "sre_parse", "ssl", "stat", "statistics", "string", "stringprep", "struct", "subprocess", "symtable", "sys",
  "sysconfig", "syslog", "tabnanny", "tarfile", "tempfile", "termios", "textwrap", "this", "threading",
  "time", "timeit", "tkinter", "token", "tokenize", "tomllib", "trace", "traceback", "tracemalloc", "tty",
  "turtle", "turtledemo", "types", "typing", "unicodedata", "unittest", "urllib", "uuid", "venv", "warnings",
  "wave", "weakref", "webbrowser", "winreg", "winsound", "wsgiref", "xml", "xmlrpc", "zipapp", "zipfile",
  "zipimport", "zlib", "zoneinfo",
]);

/** Extensions a Python module can be written with, in probe order. */
const MODULE_EXTENSIONS = [".py", ".pyi"] as const;

/** Files whose presence marks a directory as an import root. */
const PROJECT_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg"] as const;

const UNRESOLVED: ResolvedTarget = { type: "unresolved" };

/** The resolver's answer for one Python module path. Assignable to `ResolvedTarget`. */
export type PythonTarget = ResolvedTarget;

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

function parentDir(dir: string): string {
  const index = dir.lastIndexOf("/");
  return index === -1 ? "" : dir.slice(0, index);
}

function joinRelative(dir: string, rest: string): string {
  if (rest === "") return dir;
  return dir === "" ? rest : `${dir}/${rest}`;
}

/** Directory of a repo-relative path; "" for a file at the repo root. */
export function pythonPackageDir(filePath: string): string {
  return parentDir(filePath);
}

/** The leading `.` run of a relative specifier: `..pkg` -> 2, `pkg` -> 0. */
function relativeLevel(specifier: string): number {
  let level = 0;
  while (level < specifier.length && specifier[level] === ".") level += 1;
  return level;
}

/**
 * The `[tool.setuptools] package-dir` / `[tool.poetry] packages = [{ from = "src" }]` roots a
 * `pyproject.toml` declares, as repo-relative directories under `dir`.
 *
 * A deliberately small reader rather than a TOML parser: the only question asked is "which
 * directory does the import path start from", and the two spellings below are how every
 * src-layout project answers it. A file that says something this cannot read simply
 * contributes no root, and the marker directory and the repo root still apply.
 */
function declaredRoots(dir: string, text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  const add = (value: string): void => {
    const cleaned = value.trim().replace(/^["']|["']$/gu, "").replace(/^\.\//u, "").replace(/\/$/u, "");
    if (cleaned === "" || cleaned === "." || cleaned.includes("..")) return;
    const joined = joinRelative(dir, cleaned);
    if (!out.includes(joined)) out.push(joined);
  };
  // `package-dir = { "" = "src" }`, on one line or spread over several.
  for (const match of text.matchAll(/^\s*""\s*=\s*(["'][^"']*["'])/gmu)) add(match[1] ?? "");
  // `packages = [{ include = "pkg", from = "src" }]`
  for (const match of text.matchAll(/\bfrom\s*=\s*(["'][^"']*["'])/gu)) add(match[1] ?? "");
  return out;
}

// ---------------------------------------------------------------------------
// import resolution
// ---------------------------------------------------------------------------

/**
 * A Python import resolver over the indexed file set.
 *
 * Roots are found once, by probing every ancestor directory of an indexed `.py` file for a
 * project marker, exactly as the Go resolver probes for `go.mod`. They are ordered
 * most-specific-first (a declared `src` layout, then the marker directory, then the repo
 * root) so a nested project never has its modules resolved against the outer one.
 */
export function createPythonResolver(ctx: RepoContext): (fromFile: string, specifier: string) => ResolvedTarget {
  let roots: string[] | null = null;

  function importRoots(): string[] {
    if (roots !== null) return roots;
    const declared: string[] = [];
    const markers: string[] = [];
    const probed = new Set<string>();
    for (const file of [...ctx.files].sort(compareStrings)) {
      if (!file.endsWith(".py") && !file.endsWith(".pyi")) continue;
      let current = pythonPackageDir(file);
      for (;;) {
        if (!probed.has(current)) {
          probed.add(current);
          for (const marker of PROJECT_MARKERS) {
            const text = ctx.readFile(joinRelative(current, marker));
            if (text === null) continue;
            if (!markers.includes(current)) markers.push(current);
            for (const root of declaredRoots(current, marker === "pyproject.toml" ? text : null)) {
              if (!declared.includes(root)) declared.push(root);
            }
            // A conventional `src/` layout needs no declaration to be one.
            const src = joinRelative(current, "src");
            if (!declared.includes(src) && hasFilesUnder(src)) declared.push(src);
          }
        }
        if (current === "") break;
        current = parentDir(current);
      }
    }
    // Deepest first, so `a/b/src` outranks `a/src` outranks the repo root.
    const byDepth = (a: string, b: string): number => b.split("/").length - a.split("/").length || compareStrings(a, b);
    roots = [...declared.sort(byDepth), ...markers.sort(byDepth), ""];
    return roots;
  }

  function hasFilesUnder(dir: string): boolean {
    const prefix = `${dir}/`;
    for (const file of ctx.files) {
      if (file.startsWith(prefix)) return true;
    }
    return false;
  }

  /** The first indexed file a module directory-or-module candidate names, or null. */
  function probe(candidate: string): string | null {
    if (candidate === "") return null;
    for (const extension of MODULE_EXTENSIONS) {
      const file = `${candidate}${extension}`;
      if (ctx.files.has(file)) return file;
    }
    for (const extension of MODULE_EXTENSIONS) {
      // A package is a *file*: the `__init__` the interpreter runs, not the directory.
      const file = `${candidate}/__init__${extension}`;
      if (ctx.files.has(file)) return file;
    }
    return null;
  }

  return (fromFile: string, specifier: string): ResolvedTarget => {
    if (specifier === "") return UNRESOLVED;

    const level = relativeLevel(specifier);
    if (level > 0) {
      // PEP 328: one level is the file's own package, each further dot goes up one.
      let base = pythonPackageDir(fromFile);
      for (let step = 1; step < level; step += 1) {
        if (base === "") return UNRESOLVED; // the specifier climbs out of the repo
        base = parentDir(base);
      }
      const rest = specifier.slice(level).replace(/\./gu, "/");
      const hit = probe(joinRelative(base, rest));
      return hit === null ? UNRESOLVED : { type: "file", path: hit };
    }

    const relative = specifier.replace(/\./gu, "/");
    for (const root of importRoots()) {
      const hit = probe(joinRelative(root, relative));
      if (hit !== null) return { type: "file", path: hit };
    }

    const head = specifier.split(".")[0] ?? specifier;
    // The standard library is not a distribution, so it is not namespaced under `pypi/`.
    return { type: "external", pkg: PY_STDLIB.has(head) ? head : `pypi/${head}` };
  };
}

// ---------------------------------------------------------------------------
// call linking
// ---------------------------------------------------------------------------

/** What one file's imports bound: a local name -> the module and the name inside it. */
interface Binding {
  module: string;
  /** The exported name, or "*" for a whole-module binding (`import x as obj`). */
  name: string;
}

export interface PythonCallIndex {
  /** file -> the names its module scope declares, which are the callable targets there. */
  topLevel: Map<string, Set<string>>;
  /** file -> symbol path of every declaration, so `this.m` can be checked against one. */
  symbols: Map<string, Set<string>>;
  /** file -> local name -> what the import bound. */
  bindings: Map<string, Map<string, Binding>>;
  /** file -> exported name -> the declaring file and symbol, with the re-export hop count. */
  exports: Map<string, Map<string, { file: string; symbol: string; hops: number }>>;
}

const EMPTY_INDEX: PythonCallIndex = {
  topLevel: new Map(),
  symbols: new Map(),
  bindings: new Map(),
  exports: new Map(),
};

/** A `type` import binds nothing at runtime, and a side-effect import binds no name at all. */
function bindsValues(kind: string): boolean {
  return kind === "static" || kind === "dynamic";
}

/**
 * Everything Python call resolution needs, in one pass over the Python files and one pass
 * over the resolved import edges. A repo with no Python file gets the shared empty index
 * and pays nothing.
 *
 * The export map is followed exactly one hop, which is the only indirection the spec
 * sanctions (`med`): a name re-exported by an `__init__.py`. A chain of two `__init__.py`
 * files is ambiguous about which module a reader should open, so it is dropped.
 */
export function buildPythonCallIndex(
  files: readonly FileRecord[],
  imports: readonly ImportEdge[],
): PythonCallIndex {
  const pythonFiles = files.filter((file) => file.lang === "python");
  if (pythonFiles.length === 0) return EMPTY_INDEX;

  const index: PythonCallIndex = {
    topLevel: new Map(),
    symbols: new Map(),
    bindings: new Map(),
    exports: new Map(),
  };
  const paths = new Set(pythonFiles.map((file) => file.path));

  for (const file of pythonFiles) {
    const topLevel = new Set<string>();
    const symbols = new Set<string>();
    for (const decl of file.decls) {
      symbols.add(decl.name);
      if (decl.parent !== undefined || decl.kind === "method") continue;
      // A class is callable in Python: `Store()` constructs one. A `const`/`var` is a name
      // the module bound, and calling it is the module's own business, so it stays a target.
      topLevel.add(decl.name);
    }
    index.topLevel.set(file.path, topLevel);
    index.symbols.set(file.path, symbols);
  }

  // file -> specifier -> the in-repo file it resolved to.
  const specifiersByFile = new Map<string, Map<string, string>>();
  for (const edge of imports) {
    if (!paths.has(edge.from) || !paths.has(edge.to)) continue;
    let specifiers = specifiersByFile.get(edge.from);
    if (specifiers === undefined) {
      specifiers = new Map<string, string>();
      specifiersByFile.set(edge.from, specifiers);
    }
    if (!specifiers.has(edge.specifier)) specifiers.set(edge.specifier, edge.to);
  }

  for (const file of pythonFiles) {
    const specifiers = specifiersByFile.get(file.path);
    if (specifiers === undefined) continue;
    const bindings = new Map<string, Binding>();
    for (const record of file.imports) {
      if (!bindsValues(record.kind)) continue;
      const module = specifiers.get(record.specifier);
      if (module === undefined) continue;
      for (const symbol of record.symbols) {
        if (symbol.local === "*" || bindings.has(symbol.local)) continue;
        bindings.set(symbol.local, { module, name: symbol.name });
      }
    }
    if (bindings.size > 0) index.bindings.set(file.path, bindings);
  }

  // Exported name -> declaration, following at most one re-export hop.
  for (const file of pythonFiles) {
    const own = new Map<string, { file: string; symbol: string; hops: number }>();
    const topLevel = index.topLevel.get(file.path) ?? new Set<string>();
    const specifiers = specifiersByFile.get(file.path);
    for (const record of file.exports) {
      if (record.kind !== "named") continue;
      const local = record.local ?? record.name;
      if (topLevel.has(local)) {
        own.set(record.name, { file: file.path, symbol: local, hops: 0 });
        continue;
      }
      const module = record.from === undefined ? undefined : specifiers?.get(record.from);
      if (module === undefined) continue;
      const declared = index.topLevel.get(module)?.has(local) === true;
      if (declared) own.set(record.name, { file: module, symbol: local, hops: 1 });
    }
    index.exports.set(file.path, own);
  }

  return index;
}

/**
 * One Python call site resolved to a declaration, or null when nothing is certain.
 *
 * The five rules of spec 1.2, in order. Everything else — a deeper chain, a call on a local,
 * a name the file never bound — is dropped rather than guessed (tech spec 5.1).
 */
export function resolvePythonCall(
  file: FileRecord,
  site: CallSite,
  index: PythonCallIndex,
): { to: string; confidence: Confidence } | null {
  const callee = site.callee;
  if (callee === "") return null;
  const dot = callee.indexOf(".");

  if (dot === -1) {
    // 1. A top-level name of this file.
    if (index.topLevel.get(file.path)?.has(callee) === true) {
      return { to: symbolId(file.path, callee), confidence: "high" };
    }
    // 2 and 5. A name bound by one `from X import name`: direct, or one `__init__.py` hop.
    const binding = index.bindings.get(file.path)?.get(callee);
    if (binding === undefined || binding.name === "*") return null;
    return throughExports(index, binding.module, binding.name);
  }

  const object = callee.slice(0, dot);
  const member = callee.slice(dot + 1);
  if (object === "" || member === "" || member.includes(".")) return null;

  // 4. `this.method` inside a class: the enclosing declaration names the class.
  if (object === "this") {
    const dotInCaller = site.caller.indexOf(".");
    const className = dotInCaller === -1 ? site.caller : site.caller.slice(0, dotInCaller);
    if (className === "") return null;
    const symbol = `${className}.${member}`;
    return index.symbols.get(file.path)?.has(symbol) === true
      ? { to: symbolId(file.path, symbol), confidence: "high" }
      : null;
  }

  // A class declared in this file, called as `Class.method(...)`.
  if (index.topLevel.get(file.path)?.has(object) === true) {
    const symbol = `${object}.${member}`;
    return index.symbols.get(file.path)?.has(symbol) === true
      ? { to: symbolId(file.path, symbol), confidence: "high" }
      : null;
  }

  const binding = index.bindings.get(file.path)?.get(object);
  if (binding === undefined) return null;

  // 3. A module alias (`import X as obj`): the member is a declaration of the target file.
  if (binding.name === "*") return throughExports(index, binding.module, member);

  // An imported class used statically (`Store.make()`).
  const target = index.exports.get(binding.module)?.get(binding.name);
  if (target === undefined) return null;
  const symbol = `${target.symbol}.${member}`;
  return index.symbols.get(target.file)?.has(symbol) === true
    ? { to: symbolId(target.file, symbol), confidence: target.hops === 0 ? "high" : "med" }
    : null;
}

/** A name in a module: declared there (`high`), or re-exported through one hop (`med`). */
function throughExports(
  index: PythonCallIndex,
  module: string,
  name: string,
): { to: string; confidence: Confidence } | null {
  if (index.topLevel.get(module)?.has(name) === true) {
    return { to: symbolId(module, name), confidence: "high" };
  }
  const target = index.exports.get(module)?.get(name);
  if (target === undefined) return null;
  return { to: symbolId(target.file, target.symbol), confidence: target.hops === 0 ? "high" : "med" };
}
