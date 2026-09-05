/**
 * Java resolution and Java call linking (spec 2026-09-04 section 1.4).
 *
 * Two jobs, both Java-only:
 *
 *  1. `createJavaResolver` turns a fully qualified name into a **file**. A Java import names a
 *     type and a type lives in a file, so `tiny.Store` is `<source root>/tiny/Store.java`.
 *     Source roots are tried in order: every `src/main/java`, every `src/test/java`, then the
 *     repo root. The name is walked from its longest prefix down, because the tail of a
 *     qualified name may be a member (`tiny.Retry.attempts`, an `import static`) or a nested
 *     type (`a.b.Outer.Inner`), and only the file system can say where the type name stops.
 *     `java.*` and `javax.*` are always external, whatever the tree looks like; every other
 *     miss is `ext:maven/<group>:<artifact>` under a `com.`/`org.` prefix and `ext:<head>`
 *     otherwise.
 *
 *  2. `buildJavaCallIndex` / `resolveJavaCall` implement spec 1.4's call rules. Everything
 *     ambiguous is dropped, never guessed; a receiver whose type this file does not write down
 *     never reaches here at all, because `extract/java.ts` refuses to record such a callee.
 *
 * The one rule with no import behind it is the same-package one: two files in the same
 * directory are two types of the same package, and Java lets either name the other with no
 * import statement at all. That is why the index carries a per-directory type table next to
 * the per-file and per-import ones.
 *
 * Three things are dropped on purpose, each because keeping it would emit an edge that is
 * *wrong* rather than merely missing:
 *
 *  - **interface dispatch.** A call whose receiver type is an `interface` resolves, for a
 *    compiler, to the interface method; for a reader it means whichever implementation is
 *    wired in. Spec 1.4 drops it, and so does this.
 *  - **an inherited member.** Nothing here walks a superclass: if the type the call is written
 *    against does not declare the member itself, there is no edge. An `extends` chain that
 *    leaves the repo cannot be walked at all, and one that does not would still need overload
 *    resolution to be right.
 *  - **an overloaded member.** Two declarations in one file with one name have ids
 *    `<file>#Store.put` and `<file>#Store.put~2` (driver ruling 2026-09-04), and picking
 *    between them needs the argument types, which is type inference. A name declared twice in
 *    its file therefore resolves to nothing; the javac oracle applies the same rule, so
 *    neither side scores a call it could only get right by guessing.
 */

import type { CallSite, Confidence, DeclKind, FileRecord, ImportEdge } from "../schema.ts";
import { compareStrings, symbolId } from "../schema.ts";
import type { RepoContext, ResolvedTarget } from "./resolver.ts";

const UNRESOLVED: ResolvedTarget = { type: "unresolved" };
const JAVA_EXTENSION = ".java";
/** Package prefixes the JDK owns: never a repo file, whatever the tree happens to hold. */
const JDK_ROOTS: ReadonlySet<string> = new Set(["java", "javax"]);
/** Prefixes whose first segments name a Maven coordinate (spec 1.4). */
const MAVEN_ROOTS: ReadonlySet<string> = new Set(["com", "org"]);
/** Source-root suffixes, in the order spec 1.4 fixes. */
const SOURCE_ROOT_SUFFIXES = ["src/main/java", "src/test/java"] as const;

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function join(dir: string, rest: string): string {
  if (dir === "") return rest;
  return rest === "" ? dir : `${dir}/${rest}`;
}

/**
 * The external id an unresolved Java name publishes.
 *
 * `com.google.gson.Gson` -> `ext:maven/com.google:gson`, from the first two segments as the
 * group and the third as the artifact (spec 1.4). The artifact is only ever a **package**
 * segment: a fully qualified Java name ends in the *type*, so `org.junit.Test` has to take
 * `junit` and not `Test`, publishing a type as an artifact would make one external node per
 * class of a dependency instead of one per dependency. Anything that is not a `com.`/`org.`
 * name keeps its first segment, which is what spec 1.4 says.
 */
function externalPackage(segments: readonly string[]): string {
  const head = segments[0] ?? "";
  if (!MAVEN_ROOTS.has(head) || segments.length < 2) return head;
  const group = `${head}.${segments[1] ?? ""}`;
  // With four or more segments the third is a package segment; with three it is the type, so
  // the group's own last segment is the deepest package name available.
  const artifact = segments.length >= 4 ? segments[2] : segments[1];
  return `maven/${group}:${artifact ?? ""}`;
}

// ---------------------------------------------------------------------------
// the source-root resolver
// ---------------------------------------------------------------------------

export function createJavaResolver(ctx: RepoContext): (fromFile: string, specifier: string) => ResolvedTarget {
  let roots: string[] | null = null;

  /**
   * Every source root in the repo, in the order spec 1.4 fixes: `src/main/java` first (sorted,
   * so a multi-module build is deterministic), then `src/test/java`, then the repo root.
   *
   * They are read off the indexed file set rather than off the file system, so a directory the
   * config excluded is not a source root and cannot become an import target.
   */
  function sourceRoots(): string[] {
    if (roots !== null) return roots;
    const found: string[][] = SOURCE_ROOT_SUFFIXES.map(() => []);
    const seen = new Set<string>();
    for (const file of ctx.files) {
      if (!file.endsWith(JAVA_EXTENSION)) continue;
      for (const [index, suffix] of SOURCE_ROOT_SUFFIXES.entries()) {
        const marker = `${suffix}/`;
        const at = file.startsWith(marker) ? 0 : file.indexOf(`/${marker}`) + 1;
        if (at <= 0 && !file.startsWith(marker)) continue;
        const root = file.slice(0, at + suffix.length);
        if (seen.has(root)) break;
        seen.add(root);
        found[index]?.push(root);
        break;
      }
    }
    roots = [...found.map((group) => group.sort(compareStrings)).flat(), ""];
    return roots;
  }

  return (fromFile: string, specifier: string): ResolvedTarget => {
    void fromFile;
    const segments = specifier.split(".").filter((segment) => segment !== "");
    const head = segments[0];
    if (head === undefined) return UNRESOLVED;
    if (JDK_ROOTS.has(head)) return { type: "external", pkg: head };

    // The longest prefix first: `a.b.Outer.Inner` is `a/b/Outer.java`, and
    // `tiny.Retry.attempts` is `tiny/Retry.java`, so the walk stops at the first file that
    // exists rather than assuming where the type name ends.
    for (let length = segments.length; length >= 2; length--) {
      const relative = `${segments.slice(0, length).join("/")}${JAVA_EXTENSION}`;
      for (const root of sourceRoots()) {
        const candidate = join(root, relative);
        if (ctx.files.has(candidate)) return { type: "file", path: candidate };
      }
    }

    return { type: "external", pkg: externalPackage(segments) };
  };
}

// ---------------------------------------------------------------------------
// the call index
// ---------------------------------------------------------------------------

/** One type declaration, wherever it was found. */
interface TypeRef {
  /** The file declaring it. */
  file: string;
  /** Dotted path inside that file: `Store`, or `Store.Entry` for a nested type. */
  dotted: string;
  kind: DeclKind;
}

/**
 * What one declaration name means inside one file.
 *
 * `count` is how many declarations of the file carry the name: more than one is an overload
 * (or a type and a member colliding), which resolves to nothing. `kind` is the *first* one's
 * kind, which is all that is ever read, because a name with `count > 1` is dropped before the
 * kind is consulted. It exists so a call can never land on something that is not callable:
 * `class Sub extends Base { int size = 7; int total() { return size(); } }` declares a field
 * named `Sub.size` and calls an inherited `Base.size`, and without the kind the field is a
 * perfectly unique, and completely wrong, `high` answer.
 */
interface MemberEntry {
  count: number;
  kind: DeclKind;
}

export interface JavaCallIndex {
  /** file -> declaration name -> how many declarations carry it, and what the first one is. */
  members: Map<string, Map<string, MemberEntry>>;
  /** file -> simple member name -> the declaration names ending in it. */
  bySimpleName: Map<string, Map<string, string[]>>;
  /** file -> simple type name -> the type it names, or null when the file declares two. */
  typesInFile: Map<string, Map<string, TypeRef | null>>;
  /** directory -> simple type name -> the sibling top-level type, or null when two match. */
  typesInDir: Map<string, Map<string, TypeRef | null>>;
  /** file -> dotted paths of the types it declares, so a caller can be told from a member. */
  dottedTypes: Map<string, Set<string>>;
  /** file -> imported local name -> the in-repo files that import resolved to. */
  bindings: Map<string, Map<string, string[]>>;
}

const EMPTY_INDEX: JavaCallIndex = {
  members: new Map(),
  bySimpleName: new Map(),
  typesInFile: new Map(),
  typesInDir: new Map(),
  dottedTypes: new Map(),
  bindings: new Map(),
};

/** Declaration kinds that declare a type rather than a member of one. */
const TYPE_KINDS: ReadonlySet<DeclKind> = new Set<DeclKind>(["class", "enum", "interface", "record"]);

function nest<V>(map: Map<string, Map<string, V>>, key: string): Map<string, V> {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = new Map<string, V>();
  map.set(key, created);
  return created;
}

/** Record a type under its simple name, collapsing to null the moment two answers appear. */
function offer(table: Map<string, TypeRef | null>, simple: string, ref: TypeRef): void {
  const existing = table.get(simple);
  if (existing === undefined) {
    table.set(simple, ref);
    return;
  }
  if (existing === null) return;
  if (existing.file === ref.file && existing.dotted === ref.dotted) return;
  table.set(simple, null);
}

function simpleNameOf(dotted: string): string {
  return dotted.slice(dotted.lastIndexOf(".") + 1);
}

/**
 * Everything Java call resolution needs, gathered in one pass over the Java files and one pass
 * over the resolved import edges. A repo with no Java file gets the shared empty index.
 */
export function buildJavaCallIndex(files: readonly FileRecord[], imports: readonly ImportEdge[]): JavaCallIndex {
  const javaFiles = files.filter((file) => file.lang === "java");
  if (javaFiles.length === 0) return EMPTY_INDEX;

  const index: JavaCallIndex = {
    members: new Map(),
    bySimpleName: new Map(),
    typesInFile: new Map(),
    typesInDir: new Map(),
    dottedTypes: new Map(),
    bindings: new Map(),
  };
  const paths = new Set(javaFiles.map((file) => file.path));

  for (const file of javaFiles) {
    const members = nest(index.members, file.path);
    const bySimple = nest(index.bySimpleName, file.path);
    const inFile = nest(index.typesInFile, file.path);
    const inDir = nest(index.typesInDir, parentDir(file.path));
    const dotted = new Set<string>();
    index.dottedTypes.set(file.path, dotted);

    for (const decl of file.decls) {
      const seen = members.get(decl.name);
      if (seen === undefined) members.set(decl.name, { count: 1, kind: decl.kind });
      else seen.count += 1;
      const simple = simpleNameOf(decl.name);
      const names = bySimple.get(simple);
      if (names === undefined) bySimple.set(simple, [decl.name]);
      else if (!names.includes(decl.name)) names.push(decl.name);

      if (!TYPE_KINDS.has(decl.kind)) continue;
      dotted.add(decl.name);
      const ref: TypeRef = { file: file.path, dotted: decl.name, kind: decl.kind };
      offer(inFile, simple, ref);
      // Only a top-level type is reachable from a sibling file by its simple name; a nested one
      // needs an import or a qualifier this layer does not track.
      if (!decl.name.includes(".")) offer(inDir, simple, ref);
    }
  }

  for (const edge of imports) {
    if (!paths.has(edge.from) || !paths.has(edge.to)) continue;
    const bySpecifier = nest(index.bindings, edge.from);
    const local = simpleNameOf(edge.specifier);
    if (local === "" || local === "*") continue;
    const targets = bySpecifier.get(local);
    if (targets === undefined) bySpecifier.set(local, [edge.to]);
    else if (!targets.includes(edge.to)) targets.push(edge.to);
  }

  return index;
}

// ---------------------------------------------------------------------------
// call resolution
// ---------------------------------------------------------------------------

/** The one answer every candidate agrees on, or null when they disagree or none resolves. */
function agreed(
  candidates: ReadonlyArray<{ to: string; confidence: Confidence } | null>,
): { to: string; confidence: Confidence } | null {
  let answer: { to: string; confidence: Confidence } | null = null;
  for (const candidate of candidates) {
    if (candidate === null) continue;
    if (answer === null) {
      answer = candidate;
      continue;
    }
    if (answer.to !== candidate.to) return null;
  }
  return answer;
}

/**
 * A declaration named exactly once in `file` and of a kind a call can land on.
 *
 * `wanted` is `"method"` everywhere a call names a member, and the type kinds only for the
 * `new` fallback, where the target is the class itself because javac generated the constructor.
 * A field, a constant or an enum constant is never a call target however unique its name is.
 */
function declared(
  index: JavaCallIndex,
  file: string,
  name: string,
  wanted: ReadonlySet<DeclKind>,
): { to: string; confidence: Confidence } | null {
  const entry = index.members.get(file)?.get(name);
  if (entry === undefined || entry.count !== 1 || !wanted.has(entry.kind)) return null;
  return { to: symbolId(file, name), confidence: "high" };
}

/** A call on a member can only land on a method: a constructor is one, a field is not. */
const CALLABLE: ReadonlySet<DeclKind> = new Set<DeclKind>(["method"]);

/** The type a simple name means, seen from `file`: this file, then its imports, then its package. */
function typeNamed(index: JavaCallIndex, file: string, simple: string): TypeRef | null {
  const own = index.typesInFile.get(file)?.get(simple);
  if (own !== undefined) return own;

  const targets = index.bindings.get(file)?.get(simple) ?? [];
  let imported: TypeRef | null = null;
  for (const target of targets) {
    const ref = index.typesInFile.get(target)?.get(simple);
    if (ref === undefined || ref === null) continue;
    if (imported === null) imported = ref;
    else if (imported.file !== ref.file || imported.dotted !== ref.dotted) return null;
  }
  if (imported !== null) return imported;

  return index.typesInDir.get(parentDir(file))?.get(simple) ?? null;
}

/** The type that owns a caller's symbol path: the caller itself when it names a type. */
function ownerOf(index: JavaCallIndex, file: string, caller: string): string {
  if (caller === "") return "";
  if (index.dottedTypes.get(file)?.has(caller) === true) return caller;
  return caller.slice(0, Math.max(caller.lastIndexOf("."), 0));
}

/**
 * One Java call site resolved to a declaration, or null when nothing is certain (spec 1.4).
 *
 * Every answer is `high`: Java has no re-export, so there is no "exactly one documented hop"
 * for `med` to describe. Either the name resolves to one declaration of one indexed file or it
 * is dropped.
 */
export function resolveJavaCall(
  file: FileRecord,
  site: CallSite,
  index: JavaCallIndex,
): { to: string; confidence: Confidence } | null {
  const callee = site.callee;
  if (callee === "") return null;

  // 1. `new Type`: the type's constructor, or the type itself when it declares none.
  //
  //    The order matters. A type that writes *several* constructors is overloaded, and picking
  //    between them needs the argument types, so the call is dropped, exactly as an overloaded
  //    method call is. Falling back to the type declaration there would be a different edge
  //    from the one a compiler resolves, which is a false positive rather than a missing edge:
  //    `new JsonIOException(cause)` names a constructor, not a class.
  if (callee.startsWith("new ")) {
    const ref = typeNamed(index, file.path, callee.slice(4));
    if (ref === null) return null;
    const constructor = `${ref.dotted}.${simpleNameOf(ref.dotted)}`;
    const written = index.members.get(ref.file)?.get(constructor);
    if (written !== undefined && written.kind === "method") {
      return written.count === 1 ? { to: symbolId(ref.file, constructor), confidence: "high" } : null;
    }
    return declared(index, ref.file, ref.dotted, TYPE_KINDS);
  }

  const dot = callee.indexOf(".");

  if (dot === -1) {
    // 2. An unqualified call: a method of the enclosing type, or of a type enclosing that one.
    for (let owner = ownerOf(index, file.path, site.caller); owner !== ""; owner = parentOf(owner)) {
      const hit = declared(index, file.path, `${owner}.${callee}`, CALLABLE);
      if (hit !== null) return hit;
      if (!owner.includes(".")) break;
    }
    // 3. A static import naming exactly one declaration of the file it resolved to.
    const targets = index.bindings.get(file.path)?.get(callee) ?? [];
    return agreed(targets.map((target) => staticMember(index, target, callee)));
  }

  const object = callee.slice(0, dot);
  const member = callee.slice(dot + 1);
  if (object === "" || member === "" || member.includes(".")) return null;

  // 4. `this.method`: the enclosing type owns it.
  if (object === "this") {
    const owner = ownerOf(index, file.path, site.caller);
    return owner === "" ? null : declared(index, file.path, `${owner}.${member}`, CALLABLE);
  }

  // 5. `<Type>.method`: a static call, or a receiver whose declared type the extractor wrote
  //    down. Interface dispatch is dropped rather than pinned to the interface's declaration.
  const ref = typeNamed(index, file.path, object);
  if (ref === null || ref.kind === "interface") return null;
  return declared(index, ref.file, `${ref.dotted}.${member}`, CALLABLE);
}

/** `Store.Entry` -> `Store`; `Store` -> `""`. */
function parentOf(dotted: string): string {
  const at = dotted.lastIndexOf(".");
  return at === -1 ? "" : dotted.slice(0, at);
}

/**
 * The single declaration a static import names in the file it resolved to.
 *
 * The import specifier says `tiny.Retry.attempts`, and the resolver already turned it into
 * `Retry.java`; which *type* in that file declares `attempts` is a question only the file can
 * answer, so the member is looked up by its simple name and dropped unless exactly one
 * declaration carries it.
 */
function staticMember(
  index: JavaCallIndex,
  target: string,
  name: string,
): { to: string; confidence: Confidence } | null {
  const candidates = (index.bySimpleName.get(target)?.get(name) ?? []).filter((full) => full.includes("."));
  if (candidates.length !== 1) return null;
  return declared(index, target, candidates[0] ?? "", CALLABLE);
}
