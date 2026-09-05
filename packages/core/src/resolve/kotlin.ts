/**
 * Kotlin resolution and Kotlin call linking (build 2, leaf 2.6; spec section 1.5 on top of 1.4).
 *
 * Two jobs, both Kotlin-only:
 *
 *  1. `createKotlinResolver` turns a fully qualified import into a **file id**. Kotlin's rule is
 *     not Java's: a `.kt` file may declare several top-level types and need not be named after
 *     any of them, so `import tiny.util.Retry` cannot be answered by looking for
 *     `tiny/util/Retry.kt`. The target package's directory is found by suffix (a source root is
 *     whatever prefix the layout puts in front of the package path), and the indexed files in it
 *     are searched for one that declares the name. Exactly one match resolves; two files
 *     declaring the same name is an ambiguity, and an ambiguity is dropped, never guessed
 *     (tech spec 5.1).
 *
 *  2. `buildKotlinCallIndex` / `resolveKotlinCall` implement the call rules: a top-level name of
 *     this file, a name a single import bound, a name a single same-package sibling declares
 *     (Kotlin needs no import inside a package), `this.m` inside a type, and `T.m` where `T` is a
 *     type, an object or a companion this file can see. A member name that collides inside one
 *     file resolves to **nothing** (driver ruling 2026-09-04), and so does everything else.
 *
 * The resolver may not parse - `RepoContext` hands it paths and a reader, not trees - so
 * "does this file declare `X` at the top level" is answered lexically, by reading declaration
 * lines that start at column 0. Kotlin never indents a top-level declaration, so the probe
 * cannot see a member of a class; and a probe that is wrong about a *candidate* costs a dropped
 * edge, never a wrong one, because the candidate set has to hold exactly one file.
 */

import type { CallSite, Confidence, DeclKind, FileRecord, ImportEdge } from "../schema.ts";
import { compareStrings, symbolId } from "../schema.ts";
import type { RepoContext, ResolvedTarget } from "./resolver.ts";

/** Extensions a Kotlin file can be written with. */
const KOTLIN_EXTENSIONS = [".kt", ".kts"] as const;

/** Package roots that always leave the repo, whatever the file set holds. */
const EXTERNAL_ROOTS: ReadonlySet<string> = new Set(["java", "javax", "kotlin", "jdk", "sun"]);

/**
 * Prefixes whose first segments name a Maven coordinate (spec 1.4). `com` and `org` only: the
 * list is Java's, and it has to stay Java's, because a repo holding both languages must give
 * one dependency one external node.
 */
const MAVEN_ROOTS: ReadonlySet<string> = new Set(["com", "org"]);

/** Keywords that open a Kotlin declaration, for the lexical top-level probe. */
const DECLARATION_KEYWORDS: ReadonlySet<string> = new Set([
  "class",
  "interface",
  "object",
  "fun",
  "val",
  "var",
  "typealias",
]);

const UNRESOLVED: ResolvedTarget = { type: "unresolved" };

function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function isKotlin(path: string): boolean {
  return KOTLIN_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/**
 * `com.google.gson.Gson` -> `maven/com.google:gson`; a shorter name keeps what it has.
 *
 * The shape is `resolve/java.ts`'s, written out rather than imported: the two leaves may not
 * depend on each other, and a Kotlin file and a Java file importing the same artifact have to
 * land on the same `ext:` node or the map shows one dependency twice (spec 0.2).
 */
function externalPackage(segments: readonly string[]): string {
  const head = segments[0] ?? "";
  if (!MAVEN_ROOTS.has(head) || segments.length < 2) return head;
  const group = `${head}.${segments[1] ?? ""}`;
  const artifact = segments[2];
  return artifact === undefined ? `maven/${head}:${segments[1] ?? ""}` : `maven/${group}:${artifact}`;
}

/**
 * One Kotlin source with every comment, string and character literal blanked out.
 *
 * The two probes below read *lines*, so without this a commented-out `// fun helper()` or a
 * `"""fun helper()"""` in a doc string would answer an import - and an import resolved to a file
 * that declares nothing is a wrong `high` edge, the one thing this layer must never emit.
 * Blanking preserves every offset and newline, so a line's column-0 test still means what it
 * meant. Kotlin block comments nest, and a raw string ends only at `"""`.
 */
export function kotlinStripped(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (two === "/*") {
      let depth = 1;
      let j = i + 2;
      while (j < source.length && depth > 0) {
        const pair = source.slice(j, j + 2);
        if (pair === "/*") {
          depth += 1;
          j += 2;
        } else if (pair === "*/") {
          depth -= 1;
          j += 2;
        } else j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      const stop = end === -1 ? source.length : end + 3;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i] as string;
      let j = i + 1;
      while (j < source.length && source[j] !== quote && source[j] !== "\n") {
        j += source[j] === "\\" ? 2 : 1;
      }
      const stop = Math.min(j + 1, source.length);
      blank(i, stop);
      i = stop;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/**
 * The package one Kotlin source declares, or "" for the default package.
 *
 * Kotlin does not tie a package to a directory - `kotlinx.coroutines` lives in
 * `kotlinx-coroutines-core/common/src/` in the pinned corpus, and more of the same package in
 * `jvm/src/` - so the package header is the only thing that says which package a file is in.
 */
export function kotlinPackageOf(source: string): string {
  for (const line of source.split("\n")) {
    const match = /^\s*package\s+([A-Za-z_][\w.`]*)/u.exec(line);
    if (match !== null) return (match[1] ?? "").replace(/`/gu, "");
    // A package header may only follow file annotations and comments, so the first line that
    // opens anything else settles it: this file is in the default package.
    if (/^(?:import|class|interface|object|fun|val|var|typealias|enum|sealed|data|annotation)\b/u.test(line)) {
      return "";
    }
  }
  return "";
}

/**
 * The names one Kotlin source declares at its top level, read lexically.
 *
 * A top-level declaration starts at column 0; every member is indented. A declaration line is
 * `<modifiers and annotations> <keyword> <name>`, and an extension contributes its bare name
 * (`fun Item.label()` declares `label`, which is what `import tiny.label` names) as well as its
 * receiver-qualified one.
 */
export function kotlinTopLevelNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const line of source.split("\n")) {
    if (line.length === 0 || /^[\s})\]]/u.test(line)) continue;
    const words = line.split(/\s+/u);
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index] ?? "";
      if (!DECLARATION_KEYWORDS.has(word)) continue;
      let rest = words.slice(index + 1).join(" ");
      // `fun <T> generic(x: T)`: the type parameters sit between the keyword and the name.
      const generics = /^<[^>]*>\s*/u.exec(rest);
      if (generics !== null) rest = rest.slice(generics[0].length);
      const token = /^[^\s({:=<@]+/u.exec(rest)?.[0] ?? "";
      if (token === "") break;
      names.add(token);
      const dot = token.lastIndexOf(".");
      if (dot !== -1) names.add(token.slice(dot + 1));
      break;
    }
  }
  return names;
}

/**
 * A Kotlin import resolver over the indexed file set.
 *
 * A file's package comes from its own `package` header, not from where it sits: Kotlin, unlike
 * Java, does not require the two to agree, and the pinned corpus proves it (every file of
 * `kotlinx.coroutines` lives in `kotlinx-coroutines-core/common/src/`, and more of the same
 * package in `jvm/src/`). Matching the package path against a directory tail is kept as the
 * fallback for a file with no header, where the directory is all there is.
 *
 * A specifier that names a package rather than a declaration (`import tiny.util.*`) resolves to
 * no single file and is left unresolved rather than turned into an external package, which
 * would claim the dependency leaves the repo when it does not. Naming *every* file of the
 * package instead would be a guess about which one the star meant, and this layer never guesses
 * (tech spec 5.1).
 */
export function createKotlinResolver(ctx: RepoContext): (fromFile: string, specifier: string) => ResolvedTarget {
  const filesByDir = new Map<string, string[]>();
  const filesByPackage = new Map<string, string[]>();
  const namesByFile = new Map<string, Set<string>>();
  const answers = new Map<string, ResolvedTarget>();
  let indexed = false;

  /** One read per indexed Kotlin file: its directory, its package header and its top-level names. */
  function index(): Map<string, string[]> {
    if (indexed) return filesByDir;
    indexed = true;
    for (const file of [...ctx.files].sort(compareStrings)) {
      if (!isKotlin(file)) continue;
      const dir = parentDir(file);
      const byDir = filesByDir.get(dir);
      if (byDir === undefined) filesByDir.set(dir, [file]);
      else byDir.push(file);

      const raw = ctx.readFile(file);
      if (raw === null) continue;
      // One strip per file, shared by both probes: neither may read a comment or a string.
      const source = kotlinStripped(raw);
      namesByFile.set(file, kotlinTopLevelNames(source));
      const declared = kotlinPackageOf(source);
      const byPackage = filesByPackage.get(declared);
      if (byPackage === undefined) filesByPackage.set(declared, [file]);
      else byPackage.push(file);
    }
    return filesByDir;
  }

  function topLevelNames(file: string): Set<string> {
    index();
    return namesByFile.get(file) ?? new Set<string>();
  }

  /** Indexed directories whose tail is the package path: the fallback for a file with no header. */
  function packageDirs(packagePath: string): string[] {
    const suffix = `/${packagePath}`;
    const out: string[] = [];
    for (const dir of index().keys()) {
      if (packagePath === "" ? dir === "" : dir === packagePath || dir.endsWith(suffix)) out.push(dir);
    }
    return out.sort(compareStrings);
  }

  /** Every indexed file that is in the named package: by its header, else by its directory. */
  function packageFiles(packageName: string): string[] {
    index();
    const declared = filesByPackage.get(packageName) ?? [];
    if (declared.length > 0) return declared;
    const out: string[] = [];
    for (const dir of packageDirs(packageName.replace(/\./gu, "/"))) {
      for (const file of filesByDir.get(dir) ?? []) out.push(file);
    }
    return out;
  }

  /** The one file in the target package that declares `name`, or null when it is not exactly one. */
  function probe(packageName: string, name: string): string | null {
    const hits: string[] = [];
    for (const file of packageFiles(packageName)) {
      if (topLevelNames(file).has(name)) hits.push(file);
    }
    return hits.length === 1 ? (hits[0] ?? null) : null;
  }

  function resolveUncached(specifier: string): ResolvedTarget {
    const segments = specifier.split(".").filter((segment) => segment !== "");
    if (segments.length === 0) return UNRESOLVED;

    // `a.b.C` names a declaration in package `a.b`; `a.b.C.member` (Java's `import static`)
    // names one inside the type `C`, so the type's own file is the target.
    for (let cut = segments.length - 1; cut >= 1 && cut >= segments.length - 2; cut -= 1) {
      const name = segments[cut] ?? "";
      const hit = probe(segments.slice(0, cut).join("."), name);
      if (hit !== null) return { type: "file", path: hit };
    }

    const head = segments[0] ?? specifier;
    // The standard library is external whatever the repo's own packages are called: a
    // `src/main/kotlin` source root must not make `kotlin.Unit` look like an in-repo package.
    if (EXTERNAL_ROOTS.has(head)) return { type: "external", pkg: head };

    // `import a.b.*` names a package, not a declaration, and so does an import this leaf could
    // not pin to exactly one file. Neither is an edge - but `ext:a` would claim the dependency
    // leaves a repo that holds it, so an in-repo package is left unresolved instead.
    for (const name of [specifier, segments.slice(0, -1).join(".")]) {
      if (name !== "" && packageFiles(name).length > 0) return UNRESOLVED;
    }

    return { type: "external", pkg: externalPackage(segments) };
  }

  return (fromFile: string, specifier: string): ResolvedTarget => {
    void fromFile;
    if (specifier === "") return UNRESOLVED;
    const cached = answers.get(specifier);
    if (cached !== undefined) return cached;
    const result = resolveUncached(specifier);
    answers.set(specifier, result);
    return result;
  };
}

// ---------------------------------------------------------------------------
// call linking
// ---------------------------------------------------------------------------

/** What one file's imports bound: a local name -> the file it came from and the name in it. */
interface Binding {
  module: string;
  /** The name in the target file, or "*" for a star import, which binds nothing callable. */
  name: string;
}

/** What one declared name resolves to inside one file, and how many declarations claim it. */
interface Member {
  /** The symbol part of the declaration's id: `Store.put`, or `Store.put~2` for a twin. */
  symbol: string;
  /** Declarations in this file carrying the name. More than one resolves to nothing (ruling). */
  count: number;
}

export interface KotlinCallIndex {
  /** file -> top-level names, with their kind (a class is callable: it is its constructor). */
  topLevel: Map<string, Map<string, DeclKind>>;
  /** file -> declared name -> the id it resolves to, and how many declarations carry it. */
  members: Map<string, Map<string, Member>>;
  /** file -> local name -> what the import bound. */
  bindings: Map<string, Map<string, Binding>>;
  /** package name -> the indexed files declaring it. Kotlin needs no import inside a package. */
  siblings: Map<string, string[]>;
  /** file -> the package it declared, so a sibling set can be found from a call site. */
  packageOf: Map<string, string>;
}

const EMPTY_INDEX: KotlinCallIndex = {
  topLevel: new Map(),
  members: new Map(),
  bindings: new Map(),
  siblings: new Map(),
  packageOf: new Map(),
};

/** The symbol part of a declaration id: `src/A.kt#Store.put~2` -> `Store.put~2`. */
function symbolOf(id: string): string {
  const hash = id.indexOf("#");
  return hash === -1 ? id : id.slice(hash + 1);
}

/**
 * Everything Kotlin call resolution needs, in one pass over the Kotlin files and one over the
 * resolved import edges. A repo with no Kotlin file gets the shared empty index and pays nothing.
 */
export function buildKotlinCallIndex(
  files: readonly FileRecord[],
  imports: readonly ImportEdge[],
): KotlinCallIndex {
  const kotlinFiles = files.filter((file) => file.lang === "kotlin");
  if (kotlinFiles.length === 0) return EMPTY_INDEX;

  const index: KotlinCallIndex = {
    topLevel: new Map(),
    members: new Map(),
    bindings: new Map(),
    siblings: new Map(),
    packageOf: new Map(),
  };
  const paths = new Set(kotlinFiles.map((file) => file.path));

  for (const file of kotlinFiles) {
    const topLevel = new Map<string, DeclKind>();
    const members = new Map<string, Member>();
    let declared: string | null = null;
    for (const decl of file.decls) {
      // The id is what is unique (a twin carries `~<n>`); the name is what the source wrote, so
      // a name two declarations share is counted twice and resolves to nothing.
      const existing = members.get(decl.name);
      if (existing === undefined) members.set(decl.name, { symbol: symbolOf(decl.id), count: 1 });
      else existing.count += 1;
      if (decl.parent === undefined && declared === null) declared = decl.meta?.["package"] ?? null;
      if (decl.parent !== undefined || decl.kind === "method") continue;
      if (!topLevel.has(decl.name)) topLevel.set(decl.name, decl.kind);
    }
    index.topLevel.set(file.path, topLevel);
    index.members.set(file.path, members);

    // A Kotlin package is not a directory (`extract/kotlin.ts` writes the header into
    // `meta.package`); the directory is the fallback for a file that declares none.
    const group = declared ?? `dir:${parentDir(file.path)}`;
    index.packageOf.set(file.path, group);
    const bucket = index.siblings.get(group);
    if (bucket === undefined) index.siblings.set(group, [file.path]);
    else bucket.push(file.path);
  }
  for (const bucket of index.siblings.values()) bucket.sort(compareStrings);

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

  for (const file of kotlinFiles) {
    const specifiers = specifiersByFile.get(file.path);
    if (specifiers === undefined) continue;
    const bindings = new Map<string, Binding>();
    for (const record of file.imports) {
      const module = specifiers.get(record.specifier);
      if (module === undefined) continue;
      for (const symbol of record.symbols) {
        if (symbol.local === "*" || bindings.has(symbol.local)) continue;
        bindings.set(symbol.local, { module, name: symbol.name });
      }
    }
    if (bindings.size > 0) index.bindings.set(file.path, bindings);
  }

  return index;
}

/**
 * The id `name` resolves to inside `file`, or null when the file does not declare it or two
 * declarations do. A name that collides inside one file resolves to nothing (driver ruling
 * 2026-09-04): the map would otherwise pick whichever overload came first.
 */
function declaredSymbol(index: KotlinCallIndex, file: string, name: string): string | null {
  const member = index.members.get(file)?.get(name);
  return member === undefined || member.count > 1 ? null : member.symbol;
}

/** The files of this file's own package: Kotlin needs no import inside one. */
function packageSiblings(index: KotlinCallIndex, file: string): string[] {
  return index.siblings.get(index.packageOf.get(file) ?? "") ?? [];
}

/** Files whose top-level declarations this file can name without qualifying them. */
function visibleFiles(index: KotlinCallIndex, file: FileRecord): string[] {
  const out = [file.path];
  for (const sibling of packageSiblings(index, file.path)) {
    if (sibling !== file.path) out.push(sibling);
  }
  for (const binding of index.bindings.get(file.path)?.values() ?? []) {
    if (!out.includes(binding.module)) out.push(binding.module);
  }
  return out;
}

/** The one visible file declaring `name`, with the id it resolves to, or null for anything else. */
function uniqueDeclarer(
  index: KotlinCallIndex,
  file: FileRecord,
  name: string,
): { file: string; symbol: string } | null {
  const hits: Array<{ file: string; symbol: string }> = [];
  for (const candidate of visibleFiles(index, file)) {
    const symbol = declaredSymbol(index, candidate, name);
    if (symbol !== null) hits.push({ file: candidate, symbol });
  }
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/**
 * One Kotlin call site resolved to a declaration, or null when nothing is certain.
 *
 * Kotlin has no `new`, so a constructor call is a call to the type's own name, and a companion
 * member reached through its class (`Box.of()`) falls back to `Box.Companion.of`, which is where
 * the declaration lives.
 */
export function resolveKotlinCall(
  file: FileRecord,
  site: CallSite,
  index: KotlinCallIndex,
): { to: string; confidence: Confidence } | null {
  const callee = site.callee;
  if (callee === "" || index.topLevel.size === 0) return null;
  const dot = callee.indexOf(".");

  if (dot === -1) {
    // A top-level name of this file, of a same-package sibling, or of one import's target.
    const own = index.topLevel.get(file.path);
    const here = own?.has(callee) === true ? declaredSymbol(index, file.path, callee) : null;
    if (here !== null) return { to: symbolId(file.path, here), confidence: "high" };

    const binding = index.bindings.get(file.path)?.get(callee);
    if (binding !== undefined && binding.name !== "*") {
      const target = binding.module;
      const imported =
        index.topLevel.get(target)?.has(binding.name) === true
          ? declaredSymbol(index, target, binding.name)
          : null;
      return imported === null ? null : { to: symbolId(target, imported), confidence: "high" };
    }

    const hits: Array<{ file: string; symbol: string }> = [];
    for (const sibling of packageSiblings(index, file.path)) {
      if (sibling === file.path) continue;
      if (index.topLevel.get(sibling)?.has(callee) !== true) continue;
      const symbol = declaredSymbol(index, sibling, callee);
      if (symbol !== null) hits.push({ file: sibling, symbol });
    }
    const only = hits.length === 1 ? hits[0] : undefined;
    return only === undefined ? null : { to: symbolId(only.file, only.symbol), confidence: "high" };
  }

  const object = callee.slice(0, dot);
  const member = callee.slice(dot + 1);
  if (object === "" || member === "" || member.includes(".")) return null;

  if (object === "this") {
    // The enclosing type is the caller's path without its last segment: `Store.put` is a member
    // of `Store`, and `Box.Companion.of` one of `Box.Companion`.
    const cut = site.caller.lastIndexOf(".");
    if (cut === -1) return null;
    const symbol = declaredSymbol(index, file.path, `${site.caller.slice(0, cut)}.${member}`);
    return symbol === null ? null : { to: symbolId(file.path, symbol), confidence: "high" };
  }

  // `T.m`: a member of a type, an object, or - reached through its class - a companion.
  for (const name of [`${object}.${member}`, `${object}.Companion.${member}`]) {
    const target = uniqueDeclarer(index, file, name);
    if (target !== null) return { to: symbolId(target.file, target.symbol), confidence: "high" };
  }
  return null;
}
