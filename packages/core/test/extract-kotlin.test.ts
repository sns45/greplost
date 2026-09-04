/**
 * Leaf 2.6: Kotlin extraction, resolution and linking (spec 2026-09-04 section 1.5, on top of
 * the Java rules in 1.4).
 *
 * Three layers, each tested on inline sources first and then pinned against
 * `fixtures/tiny-kotlin` end to end:
 *   - `extractKotlin`       - what one `.kt` file says about itself;
 *   - `createKotlinResolver` - a fully qualified import resolved by searching the target
 *                             package's directory, because a Kotlin file need not be named
 *                             after any type it declares;
 *   - `resolveKotlinCall`   - the call rules, with every ambiguity dropped.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createParser } from "../src/parser.ts";
import type { ParserHandle } from "../src/parser.ts";
import { extractFile } from "../src/extract/index.ts";
import { buildSnapshot } from "../src/build.ts";
import { buildKotlinCallIndex, createKotlinResolver, resolveKotlinCall } from "../src/resolve/kotlin.ts";
import type { RepoContext, ResolvedTarget } from "../src/resolve/resolver.ts";
import type { CallSite, Declaration, FileRecord, GreplostConfig, ImportEdge, Snapshot } from "../src/schema.ts";
import { DEFAULT_CONFIG } from "../src/schema.ts";

const KOTLIN_CONFIG: GreplostConfig = { ...DEFAULT_CONFIG, languages: ["kotlin"] };

const ZERO_SHA = "0".repeat(64);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TINY_KOTLIN = join(REPO_ROOT, "fixtures/tiny-kotlin");

let parser: ParserHandle;

beforeAll(async () => {
  parser = await createParser();
});

function extract(source: string, path = "src/tiny/A.kt"): FileRecord {
  return extractFile({ path, lang: "kotlin", source, sha256: ZERO_SHA }, parser);
}

function shape(record: FileRecord): Array<[string, string, boolean]> {
  return record.decls.map((d) => [d.name, d.kind, d.exported]);
}

function decl(record: FileRecord, name: string): Declaration {
  const found = record.decls.find((d) => d.name === name);
  if (!found) throw new Error(`no declaration named ${name} in [${record.decls.map((d) => d.name).join(", ")}]`);
  return found;
}

/** A `RepoContext` over an in-memory tree: `.kt` files are indexed, everything is readable. */
function context(sources: Readonly<Record<string, string>>): RepoContext {
  return {
    root: "/repo",
    files: new Set(Object.keys(sources).filter((path) => path.endsWith(".kt"))),
    packages: [],
    readFile: (rel: string): string | null => sources[rel] ?? null,
  };
}

function resolver(sources: Readonly<Record<string, string>>): (from: string, specifier: string) => ResolvedTarget {
  return createKotlinResolver(context(sources));
}

/** Extract every source, resolve its imports, and hand back what call resolution needs. */
function repo(sources: Readonly<Record<string, string>>): {
  files: FileRecord[];
  index: ReturnType<typeof buildKotlinCallIndex>;
  file: (path: string) => FileRecord;
} {
  const resolve = resolver(sources);
  const files = Object.entries(sources)
    .filter(([path]) => path.endsWith(".kt"))
    .map(([path, source]) => extract(source, path));
  const imports: ImportEdge[] = [];
  for (const record of files) {
    for (const entry of record.imports) {
      const target = resolve(record.path, entry.specifier);
      if (target.type !== "file") continue;
      imports.push({
        from: record.path,
        to: target.path,
        kind: "import",
        symbols: entry.symbols.map((s) => s.name),
        confidence: "high",
        specifier: entry.specifier,
        importKind: entry.kind,
      });
    }
  }
  const index = buildKotlinCallIndex(files, imports);
  return {
    files,
    index,
    file: (path: string): FileRecord => {
      const found = files.find((record) => record.path === path);
      if (!found) throw new Error(`no file ${path}`);
      return found;
    },
  };
}

/** Resolve one call of `path`, by its callee text. */
function callTo(
  sources: Readonly<Record<string, string>>,
  path: string,
  callee: string,
): { to: string; confidence: string } | null {
  const { index, file } = repo(sources);
  const record = file(path);
  const site: CallSite | undefined = record.calls.find((c) => c.callee === callee);
  if (site === undefined) {
    throw new Error(`no call to ${callee} in [${record.calls.map((c) => c.callee).join(", ")}]`);
  }
  return resolveKotlinCall(record, site, index);
}

// ---------------------------------------------------------------------------
// declarations
// ---------------------------------------------------------------------------

describe("declarations", () => {
  test("every Kotlin declaration maps to its DeclKind", () => {
    const record = extract(`package tiny

class Plain
interface Sink
data class Item(val id: String)
enum class Color { RED }
annotation class Marker
object Registry
typealias Items = List<Item>
val TOP: Int = 1
var mutable: Int = 2
fun run() {}
`);
    expect(shape(record)).toEqual([
      ["Plain", "class", true],
      ["Sink", "interface", true],
      ["Item", "record", true],
      ["Item.id", "const", true],
      ["Color", "enum", true],
      ["Color.RED", "const", true],
      ["Marker", "interface", true],
      ["Registry", "class", true],
      ["Items", "type", true],
      ["TOP", "const", true],
      ["mutable", "var", true],
      ["run", "function", true],
    ]);
    expect(decl(record, "Registry").meta).toEqual({ object: "1" });
    expect(decl(record, "Marker").meta).toEqual({ annotation: "1" });
  });

  test("a function inside a class or an object is a method, and a top-level one is a function", () => {
    const record = extract(`class Box {
    fun value(): Int = 1
}
object Store {
    fun put() {}
}
fun free() {}
`);
    expect(record.decls.map((d) => [d.name, d.kind, d.parent])).toEqual([
      ["Box", "class", undefined],
      ["Box.value", "method", "Box"],
      ["Store", "class", undefined],
      ["Store.put", "method", "Store"],
      ["free", "function", undefined],
    ]);
  });

  test("a companion object's members take parent <Outer>.Companion, whatever it was named", () => {
    const record = extract(`class Box {
    companion object Names {
        const val LABEL = "box"
        fun of(): Box = Box()
    }
}
`);
    expect(record.decls.map((d) => [d.name, d.kind, d.parent])).toEqual([
      ["Box", "class", undefined],
      ["Box.Companion", "class", "Box"],
      ["Box.Companion.LABEL", "const", "Box.Companion"],
      ["Box.Companion.of", "method", "Box.Companion"],
    ]);
    // The name written in source is a fact about the file, kept in meta and never in the path.
    expect(decl(record, "Box.Companion").meta).toEqual({ companionName: "Names", object: "1" });
  });

  test("exported is the absence of private/internal, which is the inverse of Java's rule", () => {
    const record = extract(`fun open() {}
public fun stated() {}
protected fun guarded() {}
internal fun hidden() {}
private fun secret() {}
`);
    expect(shape(record)).toEqual([
      ["open", "function", true],
      ["stated", "function", true],
      ["guarded", "function", true],
      ["hidden", "function", false],
      ["secret", "function", false],
    ]);
    expect(record.exports.map((e) => e.name)).toEqual(["open", "stated", "guarded"]);
  });

  test("a member of an unexported type is not an export of the file", () => {
    const record = extract(`private class Hidden {
    fun run() {}
}
class Shown {
    fun run() {}
}
`);
    expect(record.exports.map((e) => e.name)).toEqual(["Shown", "Shown.run"]);
    // The member's own modifier is still what `exported` reports.
    expect(decl(record, "Hidden.run").exported).toBe(true);
  });

  test("suspend, annotations and visibility land in meta", () => {
    const record = extract(`@Deprecated("x")
@JvmStatic
internal suspend fun retry(): Int = 1
`);
    expect(decl(record, "retry").meta).toEqual({
      annotations: "Deprecated,JvmStatic",
      suspend: "1",
      visibility: "internal",
    });
  });

  test("a primary constructor val or var is a property; a plain parameter is not", () => {
    const record = extract(`class Box(val item: String, var count: Int, size: Int)\n`);
    expect(record.decls.map((d) => [d.name, d.kind])).toEqual([
      ["Box", "class"],
      ["Box.item", "const"],
      ["Box.count", "var"],
    ]);
  });

  test("@file:JvmName is recorded in meta on the file's top-level members", () => {
    const record = extract(`@file:JvmName("AppMain")

package tiny

class Kept
fun main() {}
`);
    expect(decl(record, "main").meta).toEqual({ jvmName: "AppMain" });
    expect(decl(record, "Kept").meta).toEqual({ jvmName: "AppMain" });
  });

  test("a name declared twice in one file takes a ~<n> suffix in source order", () => {
    const record = extract(`class Store {
    fun put(a: Int) {}
    fun put(a: Int, b: Int) {}
    fun put(a: String) {}
}
`);
    expect(record.decls.map((d) => d.name)).toEqual(["Store", "Store.put", "Store.put~2", "Store.put~3"]);
    expect(record.decls.map((d) => d.id)).toEqual([
      "src/tiny/A.kt#Store",
      "src/tiny/A.kt#Store.put",
      "src/tiny/A.kt#Store.put~2",
      "src/tiny/A.kt#Store.put~3",
    ]);
    // An overloaded name is one exported name, not three.
    expect(record.exports.map((e) => e.name)).toEqual(["Store", "Store.put"]);
  });

  test("a signature is the header without the body, and a span covers the declaration", () => {
    const record = extract(`class Box {
    fun value(): Int {
        return 1
    }
}
`);
    expect(decl(record, "Box.value").signature).toBe("fun value(): Int");
    expect(decl(record, "Box.value").span).toEqual([2, 4]);
    expect(decl(record, "Box").signature).toBe("class Box");
  });

  test("a local declaration inside a function body is not a declaration of the file", () => {
    const record = extract(`fun outer() {
    fun inner() {}
    val local = 1
    inner()
}
`);
    expect(record.decls.map((d) => d.name)).toEqual(["outer"]);
  });
});

// ---------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------

describe("imports", () => {
  test("plain, aliased and star imports keep the name as written", () => {
    const record = extract(`package tiny

import tiny.util.Retry
import tiny.util.shout as yell
import tiny.other.*
`);
    expect(record.imports).toEqual([
      {
        specifier: "tiny.util.Retry",
        kind: "static",
        symbols: [{ name: "Retry", local: "Retry" }],
        reexport: false,
        line: 3,
      },
      {
        specifier: "tiny.util.shout",
        kind: "static",
        symbols: [{ name: "shout", local: "yell" }],
        reexport: false,
        line: 4,
      },
      {
        specifier: "tiny.other",
        kind: "static",
        symbols: [{ name: "*", local: "*" }],
        reexport: false,
        line: 5,
      },
    ]);
  });

  test("a fully qualified import resolves by searching the package directory, not by file name", () => {
    // `Retry` lives in a file named after nothing in particular: Kotlin allows several
    // top-level types per file, so Java's "the type names the file" rule cannot be used.
    const sources = {
      "src/tiny/App.kt": "package tiny\nimport tiny.util.Retry\n",
      "src/tiny/util/helpers.kt": "package tiny.util\n\nclass Retry\n",
      "src/tiny/util/other.kt": "package tiny.util\n\nclass Other\n",
    };
    expect(resolver(sources)("src/tiny/App.kt", "tiny.util.Retry")).toEqual({
      type: "file",
      path: "src/tiny/util/helpers.kt",
    });
  });

  test("a source root is whatever prefix the layout puts before the package path", () => {
    const sources = {
      "core/src/main/kotlin/tiny/util/pool.kt": "package tiny.util\n\nfun retry() {}\n",
    };
    expect(resolver(sources)("app/Main.kt", "tiny.util.retry")).toEqual({
      type: "file",
      path: "core/src/main/kotlin/tiny/util/pool.kt",
    });
  });

  test("two files declaring the same name is an ambiguity, and an ambiguity is dropped", () => {
    const sources = {
      "src/tiny/util/a.kt": "package tiny.util\n\nclass Retry\n",
      "src/tiny/util/b.kt": "package tiny.util\n\nclass Retry\n",
    };
    expect(resolver(sources)("src/tiny/App.kt", "tiny.util.Retry")).toEqual({ type: "unresolved" });
  });

  test("an import of a member names the type's file", () => {
    const sources = { "src/tiny/store.kt": "package tiny\n\nobject Store { fun put() {} }\n" };
    expect(resolver(sources)("src/tiny/App.kt", "tiny.Store.put")).toEqual({
      type: "file",
      path: "src/tiny/store.kt",
    });
  });

  test("a star import of an in-repo package is unresolved, never an external package", () => {
    const sources = { "src/tiny/util/pool.kt": "package tiny.util\n\nfun retry() {}\n" };
    expect(resolver(sources)("src/tiny/App.kt", "tiny.util")).toEqual({ type: "unresolved" });
  });

  test("the standard library and a Maven coordinate are external", () => {
    const resolve = resolver({ "src/tiny/App.kt": "package tiny\n" });
    expect(resolve("src/tiny/App.kt", "kotlin.math.max")).toEqual({ type: "external", pkg: "kotlin" });
    expect(resolve("src/tiny/App.kt", "java.util.List")).toEqual({ type: "external", pkg: "java" });
    expect(resolve("src/tiny/App.kt", "com.squareup.okhttp3.Call")).toEqual({
      type: "external",
      pkg: "maven/com.squareup",
    });
  });

  test("a member declared inside a class never answers a package-level import", () => {
    // The top-level probe reads column-0 declarations only, so `Retry`'s *member* `run` cannot
    // be mistaken for a top-level `run` in the same package.
    const sources = {
      "src/tiny/util/a.kt": "package tiny.util\n\nclass Retry {\n    fun run() {}\n}\n",
      "src/tiny/util/b.kt": "package tiny.util\n\nfun run() {}\n",
    };
    expect(resolver(sources)("src/tiny/App.kt", "tiny.util.run")).toEqual({
      type: "file",
      path: "src/tiny/util/b.kt",
    });
  });
});

// ---------------------------------------------------------------------------
// extensions
// ---------------------------------------------------------------------------

describe("extensions", () => {
  test("an extension function is named <Receiver>.<name> with the receiver as parent", () => {
    const out = extract("fun String.shout(): String = this.uppercase()\n");
    expect(out.decls.map((d) => [d.name, d.kind, d.parent])).toEqual([["String.shout", "function", "String"]]);
  });

  test("an extension property is named the same way", () => {
    const out = extract("val String.length2: Int get() = 2\n");
    expect(out.decls.map((d) => [d.name, d.kind, d.parent])).toEqual([["String.length2", "const", "String"]]);
  });

  test("a generic or dotted receiver is read at its head", () => {
    const out = extract("fun List<Item>.first2(): Int = 2\nfun tiny.Item.tag(): String = \"t\"\n");
    expect(out.decls.map((d) => d.name)).toEqual(["List.first2", "Item.tag"]);
  });

  test("an extension declared inside a type keeps the member's path and records the receiver", () => {
    const out = extract("class Fmt {\n    fun String.pad(): String = this\n}\n");
    expect(out.decls.map((d) => [d.name, d.parent])).toEqual([
      ["Fmt", undefined],
      ["Fmt.pad", "Fmt"],
    ]);
    expect(decl(out, "Fmt.pad").meta).toEqual({ receiver: "String" });
  });

  test("an extension call on a typed receiver resolves exactly the way a method call does", () => {
    const sources = {
      "src/tiny/Store.kt": "package tiny\n\nclass Item(val id: String)\n\nfun Item.label(): String = this.id\n",
      "src/tiny/App.kt": "package tiny\n\nfun run(item: Item) {\n    item.label()\n}\n",
    };
    expect(callTo(sources, "src/tiny/App.kt", "Item.label")).toEqual({
      to: "src/tiny/Store.kt#Item.label",
      confidence: "high",
    });
  });
});

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

describe("calls", () => {
  test("a call site keeps the caller's symbol path and the normalised callee", () => {
    const record = extract(`package tiny

object Store {
    fun accept() {}
    fun put() {
        this.accept()
    }
}

fun main() {
    Store.put()
}
`);
    expect(record.calls).toEqual([
      { caller: "Store.put", callee: "this.accept", line: 6 },
      { caller: "main", callee: "Store.put", line: 11 },
    ]);
  });

  test("a receiver this file can type becomes <Type>.method", () => {
    const record = extract(`fun run(item: Item) {
    val other: Item = Item("b")
    val made = Item("c")
    item.label()
    other.label()
    made.label()
}
`);
    expect(record.calls.map((c) => c.callee)).toEqual(["Item", "Item", "Item.label", "Item.label", "Item.label"]);
  });

  test("a receiver this file cannot type is dropped, never guessed", () => {
    const record = extract(`fun run(anything: Any) {
    val untyped = compute()
    anything.hashCode()
    untyped.hashCode()
}
`);
    // `untyped` is bound to a lowercase call, which names no type, so its call is not recorded
    // at all. `anything` has a declared type, so the call is recorded as written and left for
    // the resolver, which finds no indexed `Any` and drops the edge.
    expect(record.calls.map((c) => c.callee)).toEqual(["compute", "Any.hashCode"]);
  });

  test("a name bound twice in one body is a shadow, and its calls are dropped", () => {
    const record = extract(`fun run(item: Item) {
    val item: Other = Other()
    item.label()
}
`);
    expect(record.calls.map((c) => c.callee)).toEqual(["Other"]);
  });

  test("this.method resolves against the enclosing type", () => {
    const sources = {
      "src/tiny/Store.kt": "package tiny\n\nobject Store {\n    fun accept() {}\n    fun put() { this.accept() }\n}\n",
    };
    expect(callTo(sources, "src/tiny/Store.kt", "this.accept")).toEqual({
      to: "src/tiny/Store.kt#Store.accept",
      confidence: "high",
    });
  });

  test("Kotlin has no new, so a constructor call resolves to the type itself", () => {
    const sources = {
      "src/tiny/Store.kt": "package tiny\n\nclass Item(val id: String)\n",
      "src/tiny/App.kt": 'package tiny\n\nfun main() {\n    Item("a")\n}\n',
    };
    expect(callTo(sources, "src/tiny/App.kt", "Item")).toEqual({
      to: "src/tiny/Store.kt#Item",
      confidence: "high",
    });
  });

  test("a companion member reached through its class resolves to the companion's declaration", () => {
    const sources = {
      "src/tiny/Store.kt": "package tiny\n\nclass Box {\n    companion object {\n        fun of(): Box = Box()\n    }\n}\n",
      "src/tiny/App.kt": "package tiny\n\nfun main() {\n    Box.of()\n}\n",
    };
    expect(callTo(sources, "src/tiny/App.kt", "Box.of")).toEqual({
      to: "src/tiny/Store.kt#Box.Companion.of",
      confidence: "high",
    });
  });

  test("a same-package sibling needs no import, and an import binds a name from another package", () => {
    const sources = {
      "src/tiny/Store.kt": "package tiny\n\nfun store() {}\n",
      "src/tiny/util/Retry.kt": "package tiny.util\n\nfun retry() {}\n",
      "src/tiny/App.kt": "package tiny\n\nimport tiny.util.retry\n\nfun main() {\n    store()\n    retry()\n}\n",
    };
    expect(callTo(sources, "src/tiny/App.kt", "store")).toEqual({
      to: "src/tiny/Store.kt#store",
      confidence: "high",
    });
    expect(callTo(sources, "src/tiny/App.kt", "retry")).toEqual({
      to: "src/tiny/util/Retry.kt#retry",
      confidence: "high",
    });
  });

  test("two same-package siblings declaring one name is an ambiguity, and it is dropped", () => {
    const sources = {
      "src/tiny/a.kt": "package tiny\n\nfun store() {}\n",
      "src/tiny/b.kt": "package tiny\n\nfun store() {}\n",
      "src/tiny/App.kt": "package tiny\n\nfun main() {\n    store()\n}\n",
    };
    expect(callTo(sources, "src/tiny/App.kt", "store")).toBeNull();
  });

  test("a member name that collides inside one file resolves to nothing", () => {
    const sources = {
      "src/tiny/Store.kt": "package tiny\n\nobject Store {\n    fun put(a: Int) {}\n    fun put(a: String) {}\n}\n",
      "src/tiny/App.kt": "package tiny\n\nfun main() {\n    Store.put(1)\n}\n",
    };
    expect(callTo(sources, "src/tiny/App.kt", "Store.put")).toBeNull();
  });

  test("a call to a name nothing visible declares is dropped", () => {
    const sources = { "src/tiny/App.kt": "package tiny\n\nfun main() {\n    println(1)\n}\n" };
    expect(callTo(sources, "src/tiny/App.kt", "println")).toBeNull();
  });

  test("a repo with no Kotlin file gets the shared empty index and resolves nothing", () => {
    const record = extract("fun main() { run() }\n");
    const index = buildKotlinCallIndex([], []);
    expect(resolveKotlinCall(record, { caller: "main", callee: "run", line: 1 }, index)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tiny-kotlin
// ---------------------------------------------------------------------------

describe("tiny-kotlin", () => {
  let snapshot: Snapshot;

  beforeAll(async () => {
    snapshot = await buildSnapshot({ root: TINY_KOTLIN, config: KOTLIN_CONFIG });
  });

  test("every Kotlin file is indexed", () => {
    expect(snapshot.files.map((f) => f.path)).toEqual([
      "src/tiny/App.kt",
      "src/tiny/Store.kt",
      "src/tiny/util/Retry.kt",
    ]);
  });

  test("the one import-qualified dependency is the one import edge", () => {
    expect(snapshot.imports.map((e) => `${e.from} -> ${e.to}`)).toEqual([
      "src/tiny/App.kt -> src/tiny/util/Retry.kt",
    ]);
    expect(snapshot.imports[0]?.specifier).toBe("tiny.util.retry");
  });

  test("the exported surface of each file", () => {
    const exports = Object.fromEntries(
      Object.entries(snapshot.manifest.files).map(([path, entry]) => [path, entry.exports]),
    );
    expect(exports).toEqual({
      "src/tiny/App.kt": ["main"],
      "src/tiny/Store.kt": [
        "Box",
        "Box.Companion",
        "Box.Companion.of",
        "Box.item",
        "Item",
        "Item.id",
        "Item.label",
        "Item.size",
        "Sink",
        "Sink.accept",
        "Store",
        "Store.accept",
        "Store.put",
      ],
      "src/tiny/util/Retry.kt": ["String.shout", "retry"],
    });
  });

  test("every call the fixture makes resolves at high confidence", () => {
    expect(snapshot.calls.map((e) => `${e.from} -> ${e.to}`)).toEqual([
      "src/tiny/App.kt#main -> src/tiny/Store.kt#Box.Companion.of",
      "src/tiny/App.kt#main -> src/tiny/Store.kt#Item",
      "src/tiny/App.kt#main -> src/tiny/Store.kt#Item.label",
      "src/tiny/App.kt#main -> src/tiny/Store.kt#Store.put",
      "src/tiny/App.kt#main -> src/tiny/util/Retry.kt#retry",
      "src/tiny/Store.kt#Box.Companion.of -> src/tiny/Store.kt#Box",
      "src/tiny/Store.kt#Store.put -> src/tiny/Store.kt#Store.accept",
    ]);
    expect(snapshot.calls.every((e) => e.confidence === "high")).toBe(true);
  });

  test("the fixture's declarations carry the meta the spec asks for", () => {
    const symbols = new Map(snapshot.symbols.map((d) => [d.id, d]));
    expect(symbols.get("src/tiny/Store.kt#Store.put")?.meta).toEqual({ suspend: "1" });
    expect(symbols.get("src/tiny/Store.kt#Store")?.meta).toEqual({ object: "1" });
    expect(symbols.get("src/tiny/App.kt#main")?.meta).toEqual({ jvmName: "AppMain", suspend: "1" });
    expect(symbols.get("src/tiny/Store.kt#Item")?.kind).toBe("record");
    expect(symbols.get("src/tiny/util/Retry.kt#String.shout")?.parent).toBe("String");
  });

  test("the fixture has no import cycle", () => {
    expect(snapshot.metrics.cycles).toEqual([]);
  });
});
