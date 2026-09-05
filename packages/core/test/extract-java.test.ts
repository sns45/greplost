/**
 * Leaf 2.5: Java extraction, resolution and linking (spec 2026-09-04 section 1.4).
 *
 * Three layers, each tested on inline sources first and then pinned against
 * `fixtures/tiny-java` end to end:
 *   - `extractJava`         - what one `.java` file says about itself;
 *   - `createJavaResolver`  - a fully qualified name resolved to a file under a source root;
 *   - `resolveJavaCall`     - the call rules spec 1.4 fixes, with interface dispatch dropped.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createParser } from "../src/parser.ts";
import type { ParserHandle } from "../src/parser.ts";
import { extractFile } from "../src/extract/index.ts";
import { buildSnapshot } from "../src/build.ts";
import { buildJavaCallIndex, createJavaResolver, resolveJavaCall } from "../src/resolve/java.ts";
import type { RepoContext, ResolvedTarget } from "../src/resolve/resolver.ts";
import type { Declaration, FileRecord, GreplostConfig, ImportEdge, Snapshot } from "../src/schema.ts";
import { DEFAULT_CONFIG } from "../src/schema.ts";

const JAVA_CONFIG: GreplostConfig = { ...DEFAULT_CONFIG, languages: ["java"] };

const ZERO_SHA = "0".repeat(64);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TINY_JAVA = join(REPO_ROOT, "fixtures/tiny-java");
const SRC = "src/main/java/tiny";

let parser: ParserHandle;

beforeAll(async () => {
  parser = await createParser();
});

function extract(source: string, path = "src/main/java/tiny/A.java"): FileRecord {
  return extractFile({ path, lang: "java", source, sha256: ZERO_SHA }, parser);
}

function shape(record: FileRecord): Array<[string, string, boolean]> {
  return record.decls.map((d) => [d.name, d.kind, d.exported]);
}

function decl(record: FileRecord, name: string): Declaration {
  const found = record.decls.find((d) => d.name === name);
  if (!found) throw new Error(`no declaration named ${name} in [${record.decls.map((d) => d.name).join(", ")}]`);
  return found;
}

/** A `RepoContext` over an in-memory tree: `.java` files are indexed, everything else readable. */
function context(sources: Readonly<Record<string, string>>): RepoContext {
  return {
    root: "/repo",
    files: new Set(Object.keys(sources).filter((path) => path.endsWith(".java"))),
    packages: [],
    readFile: (rel: string): string | null => sources[rel] ?? null,
  };
}

function resolver(sources: Readonly<Record<string, string>>): (from: string, specifier: string) => ResolvedTarget {
  return createJavaResolver(context(sources));
}

/** Extract every source, then resolve calls the way `linkCalls` does. */
function callEdges(sources: Readonly<Record<string, string>>): string[] {
  const files = Object.entries(sources)
    .filter(([path]) => path.endsWith(".java"))
    .map(([path, source]) => extract(source, path));
  const resolve = createJavaResolver(context(sources));
  const imports: ImportEdge[] = [];
  for (const file of files) {
    for (const record of file.imports) {
      const target = resolve(file.path, record.specifier);
      if (target.type !== "file") continue;
      imports.push({
        from: file.path,
        to: target.path,
        kind: "import",
        specifier: record.specifier,
        importKind: record.kind,
        confidence: "high",
      });
    }
  }
  const index = buildJavaCallIndex(files, imports);
  const out: string[] = [];
  for (const file of files) {
    for (const site of file.calls) {
      const hit = resolveJavaCall(file, site, index);
      if (hit === null) continue;
      const from = site.caller === "" ? file.path : `${file.path}#${site.caller}`;
      out.push(`${from} -> ${hit.to} (${hit.confidence})`);
    }
  }
  return [...new Set(out)].sort();
}

let snapshot: Snapshot;

beforeAll(async () => {
  snapshot = await buildSnapshot({ root: TINY_JAVA, config: JAVA_CONFIG });
});

// ---------------------------------------------------------------------------
// declarations
// ---------------------------------------------------------------------------

describe("declarations", () => {
  test("every type declaration kind maps to its DeclKind", () => {
    const record = extract(`package tiny;
public class C {}
interface I {}
enum E { A }
record R(int a) {}
@interface Ann {}
`);
    expect(shape(record)).toEqual([
      ["C", "class", true],
      ["I", "interface", false],
      ["E", "enum", false],
      ["E.A", "const", false],
      ["R", "record", false],
      ["Ann", "interface", false],
    ]);
    expect(decl(record, "Ann").meta).toEqual({ annotation: "1" });
  });

  test("a method's name is <Type>.<method> and its parent is the enclosing type", () => {
    const record = extract(`package tiny;
public class C {
  public C() {}
  public void go() {}
  static class Inner { void deep() {} }
}
`);
    expect(shape(record)).toEqual([
      ["C", "class", true],
      ["C.C", "method", true],
      ["C.go", "method", true],
      ["C.Inner", "class", false],
      ["C.Inner.deep", "method", false],
    ]);
    expect(decl(record, "C.go").parent).toBe("C");
    expect(decl(record, "C.Inner.deep").parent).toBe("C.Inner");
  });

  test("overloads share a name and are disambiguated by span and by a ~<n> id", () => {
    const record = extract(`package tiny;
public class C {
  public void go(int a) {}
  public void go(String a) {}
}
`);
    const gos = record.decls.filter((d) => d.name === "C.go");
    expect(gos.length).toBe(2);
    expect(gos.map((d) => d.id)).toEqual([
      "src/main/java/tiny/A.java#C.go",
      "src/main/java/tiny/A.java#C.go~2",
    ]);
    expect(gos[0]?.span[0]).toBeLessThan(gos[1]?.span[0] ?? 0);
  });

  test("a field is const when static final and var otherwise", () => {
    const record = extract(`package tiny;
public class C {
  public static final int LIMIT = 3;
  private static int seen = 0;
  int count;
}
`);
    expect(shape(record)).toEqual([
      ["C", "class", true],
      ["C.LIMIT", "const", true],
      ["C.seen", "var", false],
      ["C.count", "var", false],
    ]);
  });

  test("an interface member is implicitly public, and so is an enum constant", () => {
    const record = extract(`package tiny;
public interface I {
  int LIMIT = 3;
  void run();
  enum Colour { RED, GREEN }
}
`);
    expect(shape(record)).toEqual([
      ["I", "interface", true],
      ["I.LIMIT", "const", true],
      ["I.run", "method", true],
      ["I.Colour", "enum", true],
      ["I.Colour.RED", "const", true],
      ["I.Colour.GREEN", "const", true],
    ]);
  });

  test("a public member of a package-private type is not exported", () => {
    const record = extract(`package tiny;
class Hidden {
  public void visible() {}
  public static class Nested { public void deep() {} }
}
`);
    expect(record.decls.every((d) => !d.exported)).toBe(true);
    expect(record.exports).toEqual([]);
  });

  test("exports are the public types and the public members of public types, deduplicated", () => {
    const record = extract(`package tiny;
public class C {
  public static final int LIMIT = 3;
  public void go(int a) {}
  public void go(String a) {}
  private void hide() {}
  public static class Inner {}
}
`);
    expect(record.exports).toEqual([
      { name: "C", kind: "named" },
      { name: "C.LIMIT", kind: "named" },
      { name: "C.go", kind: "named" },
      { name: "C.Inner", kind: "named" },
    ]);
  });

  test("a signature stops before the body and keeps the header as written", () => {
    const record = extract(`package tiny;
public class C implements I {
  public <T> T map(T value) { return value; }
}
`);
    expect(decl(record, "C").signature).toBe("public class C implements I");
    expect(decl(record, "C.map").signature).toBe("public <T> T map(T value)");
  });
});

// ---------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------

describe("imports", () => {
  test("plain, on-demand and static imports each carry their own symbols", () => {
    const record = extract(`package tiny;
import java.util.List;
import java.util.*;
import static tiny.Retry.attempts;
`);
    expect(record.imports).toEqual([
      { specifier: "java.util.List", kind: "static", symbols: [{ name: "List", local: "List" }], reexport: false, line: 2 },
      { specifier: "java.util", kind: "static", symbols: [{ name: "*", local: "*" }], reexport: false, line: 3 },
      {
        specifier: "tiny.Retry.attempts",
        kind: "static",
        symbols: [{ name: "attempts", local: "attempts" }],
        reexport: false,
        line: 4,
      },
    ]);
  });

  test("a fully qualified name walks the source roots in order", () => {
    const resolve = resolver({
      "src/main/java/tiny/Store.java": "package tiny;\npublic class Store {}\n",
      "src/main/java/tiny/deep/Outer.java": "package tiny.deep;\npublic class Outer { public static class Inner {} }\n",
      "src/test/java/tiny/Helper.java": "package tiny;\npublic class Helper {}\n",
    });
    expect(resolve("src/main/java/tiny/App.java", "tiny.Store")).toEqual({
      type: "file",
      path: "src/main/java/tiny/Store.java",
    });
    // A nested type: the walk falls back to the file that declares the outer type.
    expect(resolve("src/main/java/tiny/App.java", "tiny.deep.Outer.Inner")).toEqual({
      type: "file",
      path: "src/main/java/tiny/deep/Outer.java",
    });
    // A static import names a member of a type.
    expect(resolve("src/main/java/tiny/App.java", "tiny.Store.LIMIT")).toEqual({
      type: "file",
      path: "src/main/java/tiny/Store.java",
    });
    expect(resolve("src/main/java/tiny/App.java", "tiny.Helper")).toEqual({
      type: "file",
      path: "src/test/java/tiny/Helper.java",
    });
  });

  test("an on-demand import whose prefix names a type resolves to that type's file", () => {
    const resolve = resolver({
      "src/main/java/tiny/Consts.java": "package tiny;\npublic final class Consts { public static final int MAX = 1; }\n",
      "src/main/java/tiny/App.java": "package tiny;\n",
    });
    // `import static tiny.Consts.*` reaches a type, so it is an edge to that type's file;
    // `import tiny.*` reaches a package, which is not a file and never an edge.
    expect(resolve("src/main/java/tiny/App.java", "tiny.Consts")).toEqual({
      type: "file",
      path: "src/main/java/tiny/Consts.java",
    });
    expect(resolve("src/main/java/tiny/App.java", "tiny")).toEqual({ type: "external", pkg: "tiny" });
  });

  test("a file outside any src/main/java resolves against the repo root", () => {
    const resolve = resolver({ "tiny/Store.java": "package tiny;\npublic class Store {}\n" });
    expect(resolve("tiny/App.java", "tiny.Store")).toEqual({ type: "file", path: "tiny/Store.java" });
  });

  test("java.* and javax.* are always external, even when a file would match", () => {
    const resolve = resolver({
      "src/main/java/java/util/List.java": "package java.util;\npublic class List {}\n",
      "src/main/java/tiny/App.java": "package tiny;\n",
    });
    expect(resolve("src/main/java/tiny/App.java", "java.util.List")).toEqual({ type: "external", pkg: "java" });
    expect(resolve("src/main/java/tiny/App.java", "javax.inject.Inject")).toEqual({ type: "external", pkg: "javax" });
  });

  test("an unresolved com.* or org.* name becomes ext:maven/<group>:<artifact>", () => {
    const resolve = resolver({ "src/main/java/tiny/App.java": "package tiny;\n" });
    expect(resolve("src/main/java/tiny/App.java", "com.google.gson.Gson")).toEqual({
      type: "external",
      pkg: "maven/com.google:gson",
    });
    expect(resolve("src/main/java/tiny/App.java", "org.junit.jupiter.api.Test")).toEqual({
      type: "external",
      pkg: "maven/org.junit:jupiter",
    });
    // The artifact is never the last segment, which is the *type*: `org.junit.Test` publishes
    // the JUnit 4 artifact, not one external node per test class.
    expect(resolve("src/main/java/tiny/App.java", "org.junit.Test")).toEqual({
      type: "external",
      pkg: "maven/org.junit:junit",
    });
    // Anything else falls back to its first segment.
    expect(resolve("src/main/java/tiny/App.java", "io.netty.buffer.ByteBuf")).toEqual({ type: "external", pkg: "io" });
  });
});

// ---------------------------------------------------------------------------
// annotations
// ---------------------------------------------------------------------------

describe("annotations", () => {
  test("annotations land in meta, sorted and comma-joined", () => {
    const out = extract("@Deprecated @SafeVarargs public class A {}\n");
    expect(out.decls[0]?.meta).toEqual({ annotations: "Deprecated,SafeVarargs" });
  });

  test("an annotation with arguments and a qualified one keep their simple names", () => {
    const record = extract(`package tiny;
@com.foo.Bar
@SuppressWarnings("unchecked")
public class A {
  @Override
  public String toString() { return ""; }
  @Inject private int seen;
}
`);
    expect(decl(record, "A").meta).toEqual({ annotations: "Bar,SuppressWarnings" });
    expect(decl(record, "A.toString").meta).toEqual({ annotations: "Override" });
    expect(decl(record, "A.seen").meta).toEqual({ annotations: "Inject" });
  });

  test("a declaration with no annotation carries no meta at all", () => {
    const record = extract("package tiny;\npublic class A { void go() {} }\n");
    expect(decl(record, "A").meta).toBeUndefined();
    expect(decl(record, "A.go").meta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

describe("calls", () => {
  const STORE = `package tiny;
public class Store {
  public Store(String label) {}
  public void put(String value) { this.record(value); }
  private void record(String value) {}
  public static void reset() {}
}
`;

  test("a receiver is written down as its declared type, and the rest is dropped", () => {
    const record = extract(`package tiny;
public class A {
  private Store store;
  void go(Store param) {
    Store local = new Store("x");
    local.put("a");
    param.get("b");
    store.reset();
    this.helper();
    helper();
    Store.staticThing();
    a.b.dropped();
    local.put("a").dropped();
    super.dropped();
    A.<String>dropped(null);
  }
  void helper() {}
}
`);
    expect(record.calls.map((c) => `${c.caller}|${c.callee}`)).toEqual([
      "A.go|new Store",
      "A.go|Store.put",
      "A.go|Store.get",
      "A.go|Store.reset",
      "A.go|this.helper",
      "A.go|helper",
      "A.go|Store.staticThing",
      // `a.b.dropped()`, `super.dropped()` and the generic witness are not recorded at all;
      // the chained `local.put("a").dropped()` records only its inner receiver call.
      "A.go|Store.put",
    ]);
  });

  test("a same-file method, this.method and new Type all resolve high", () => {
    expect(callEdges({ "src/main/java/tiny/Store.java": STORE })).toEqual([
      "src/main/java/tiny/Store.java#Store.put -> src/main/java/tiny/Store.java#Store.record (high)",
    ]);
  });

  test("a same-package reference with no import resolves to the sibling file", () => {
    const edges = callEdges({
      "src/main/java/tiny/Store.java": STORE,
      "src/main/java/tiny/Retry.java": `package tiny;
public final class Retry {
  public static void warm(Store store) {
    store.put("warm");
    Store other = new Store("o");
    Store.reset();
  }
}
`,
    });
    expect(edges).toEqual([
      "src/main/java/tiny/Retry.java#Retry.warm -> src/main/java/tiny/Store.java#Store.Store (high)",
      "src/main/java/tiny/Retry.java#Retry.warm -> src/main/java/tiny/Store.java#Store.put (high)",
      "src/main/java/tiny/Retry.java#Retry.warm -> src/main/java/tiny/Store.java#Store.reset (high)",
      "src/main/java/tiny/Store.java#Store.put -> src/main/java/tiny/Store.java#Store.record (high)",
    ]);
  });

  test("a static import naming exactly one declaration resolves high", () => {
    const edges = callEdges({
      "src/main/java/tiny/Retry.java": `package tiny;
public final class Retry { public static int attempts() { return 3; } }
`,
      "src/main/java/tiny/App.java": `package tiny;
import static tiny.Retry.attempts;
public class App { void go() { int n = attempts(); } }
`,
    });
    expect(edges).toEqual([
      "src/main/java/tiny/App.java#App.go -> src/main/java/tiny/Retry.java#Retry.attempts (high)",
    ]);
  });

  test("interface dispatch and an unqualified inherited call are dropped", () => {
    const edges = callEdges({
      "src/main/java/tiny/Marker.java": "package tiny;\npublic interface Marker { void mark(); }\n",
      "src/main/java/tiny/Base.java": "package tiny;\npublic class Base { protected void shared() {} }\n",
      "src/main/java/tiny/Child.java": `package tiny;
public class Child extends Base {
  void go(Marker m) {
    m.mark();
    shared();
  }
}
`,
    });
    expect(edges).toEqual([]);
  });

  test("a call never resolves to a field that happens to share the method's name", () => {
    const edges = callEdges({
      "src/main/java/tiny/Base.java": `package tiny;
public class Base { public int size() { return 0; } }
`,
      "src/main/java/tiny/Sub.java": `package tiny;
public class Sub extends Base {
  private final int size = 7;
  public int total() { return size() + size; }
}
`,
    });
    // javac resolves `size()` to the inherited `Base.size`, which spec 1.4 drops. The field
    // `Sub.size` is not callable and must never stand in for it: only a `method` — or, for a
    // `new`, a type — is a call target.
    expect(edges).toEqual([]);
  });

  test("a call written outside a collected method body still reads its own locals", () => {
    const edges = callEdges({
      "src/main/java/tiny/Store.java": STORE,
      "src/main/java/tiny/Holder.java": `package tiny;
public class Holder {
  static {
    Store booted = new Store("boot");
    booted.put("a");
  }
  private final Runnable task = new Runnable() {
    public void run() {
      Store inner = new Store("inner");
      inner.put("b");
    }
  };
  enum Mode {
    ONE {
      void go() {
        Store each = new Store("each");
        each.put("c");
      }
    };
    void go() {}
  }
}
`,
    });
    // A static block, a field initializer's anonymous class and an enum constant's body each
    // bind their own locals; the caller stays the nearest *named* declaration, which is where
    // javac attributes them too.
    expect(edges).toEqual([
      "src/main/java/tiny/Holder.java#Holder -> src/main/java/tiny/Store.java#Store.Store (high)",
      "src/main/java/tiny/Holder.java#Holder -> src/main/java/tiny/Store.java#Store.put (high)",
      "src/main/java/tiny/Holder.java#Holder.Mode -> src/main/java/tiny/Store.java#Store.Store (high)",
      "src/main/java/tiny/Holder.java#Holder.Mode -> src/main/java/tiny/Store.java#Store.put (high)",
      "src/main/java/tiny/Store.java#Store.put -> src/main/java/tiny/Store.java#Store.record (high)",
    ]);
  });

  test("an ambiguous member name inside one file resolves to nothing", () => {
    const edges = callEdges({
      "src/main/java/tiny/Store.java": `package tiny;
public class Store {
  public void put(String a) {}
  public void put(int a) {}
}
`,
      "src/main/java/tiny/App.java": `package tiny;
public class App { void go(Store s) { s.put("a"); } }
`,
    });
    expect(edges).toEqual([]);
  });

  test("a receiver with no written type, and a name bound twice, are both dropped", () => {
    const edges = callEdges({
      "src/main/java/tiny/Store.java": STORE,
      "src/main/java/tiny/App.java": `package tiny;
public class App {
  void go(boolean flag) {
    var s = new Store("a");
    s.put("x");
    if (flag) { Store s2 = new Store("b"); s2.put("y"); } else { String s2 = ""; }
  }
}
`,
    });
    // Only the constructor calls survive; `s` is a `var` and `s2` is bound twice.
    expect(edges).toEqual([
      "src/main/java/tiny/App.java#App.go -> src/main/java/tiny/Store.java#Store.Store (high)",
      "src/main/java/tiny/Store.java#Store.put -> src/main/java/tiny/Store.java#Store.record (high)",
    ]);
  });

  test("a call in an initializer belongs to the enclosing type, not to a method", () => {
    const record = extract(`package tiny;
public class A {
  private int seen = count();
  static { count(); }
  static int count() { return 0; }
  static class Inner { int n = count(); }
}
`);
    expect(record.calls.map((c) => `${c.caller}|${c.callee}`)).toEqual([
      "A|count",
      "A|count",
      "A.Inner|count",
    ]);
    // And it still resolves: the enclosing type owns the name.
    expect(callEdges({ "src/main/java/tiny/A.java": `package tiny;
public class A {
  private int seen = count();
  static int count() { return 0; }
}
` })).toEqual(["src/main/java/tiny/A.java#A -> src/main/java/tiny/A.java#A.count (high)"]);
  });
});

// ---------------------------------------------------------------------------
// tiny-java
// ---------------------------------------------------------------------------

describe("tiny-java", () => {
  test("the fixture indexes exactly its four files", () => {
    expect(snapshot.files.map((f) => f.path)).toEqual([
      `${SRC}/App.java`,
      `${SRC}/Marker.java`,
      `${SRC}/Retry.java`,
      `${SRC}/Store.java`,
    ]);
  });

  test("a fully qualified import resolves to the type's file under a source root", () => {
    const edge = snapshot.imports.find((e) => e.from === `${SRC}/App.java` && e.specifier === "tiny.Store");
    expect(edge?.to).toBe(`${SRC}/Store.java`);
  });

  test("both static import forms and the plain one are the only in-repo edges", () => {
    expect(
      snapshot.imports
        .filter((e) => e.to.endsWith(".java"))
        .map((e) => `${e.from} -> ${e.to} (${e.specifier})`),
    ).toEqual([
      `${SRC}/App.java -> ${SRC}/Retry.java (tiny.Retry.attempts)`,
      `${SRC}/App.java -> ${SRC}/Store.java (tiny.Store)`,
      // `import static tiny.Retry.*` names a *type*, so it is a dependency on that type's file
      // exactly as the named form is. Only a package on-demand import points at nothing.
      `${SRC}/Store.java -> ${SRC}/Retry.java (tiny.Retry)`,
    ]);
  });

  test("the exported name set is the public types and their public members", () => {
    const exports = Object.fromEntries(
      Object.entries(snapshot.manifest.files).map(([file, entry]) => [file, entry.exports]),
    );
    expect(exports).toEqual({
      [`${SRC}/App.java`]: ["App", "App.App", "App.Colour", "App.Colour.GREEN", "App.Colour.RED", "App.run"],
      [`${SRC}/Marker.java`]: ["Marker", "Marker.name"],
      [`${SRC}/Retry.java`]: ["Retry", "Retry.ATTEMPTS", "Retry.attempts", "Retry.warm"],
      [`${SRC}/Store.java`]: ["Store", "Store.Entry", "Store.LIMIT", "Store.Store", "Store.name", "Store.put"],
    });
  });

  test("the annotation type is an interface flagged in meta, and is not exported", () => {
    const tag = snapshot.symbols.find((d) => d.name === "Tag");
    expect(tag?.kind).toBe("interface");
    expect(tag?.meta).toEqual({ annotation: "1" });
    expect(tag?.exported).toBe(false);
  });

  test("the same-package call, the new call and the static import all land", () => {
    expect(snapshot.calls.map((e) => `${e.from} -> ${e.to} (${e.confidence})`)).toEqual([
      `${SRC}/App.java#App.App -> ${SRC}/Store.java#Store.Store (high)`,
      `${SRC}/App.java#App.run -> ${SRC}/App.java#App.warm (high)`,
      `${SRC}/App.java#App.run -> ${SRC}/Retry.java#Retry.attempts (high)`,
      `${SRC}/App.java#App.run -> ${SRC}/Retry.java#Retry.warm (high)`,
      `${SRC}/App.java#App.run -> ${SRC}/Store.java#Store.Store (high)`,
      `${SRC}/App.java#App.run -> ${SRC}/Store.java#Store.put (high)`,
      `${SRC}/App.java#App.warm -> ${SRC}/Retry.java#Retry.warm (high)`,
      `${SRC}/Retry.java#Retry.warm -> ${SRC}/Retry.java#Retry.attempts (high)`,
      `${SRC}/Retry.java#Retry.warm -> ${SRC}/Store.java#Store.put (high)`,
      `${SRC}/Store.java#Store.put -> ${SRC}/Store.java#Store.record (high)`,
    ]);
  });

  test("the fixture has no import cycle", () => {
    expect(snapshot.metrics.cycles).toEqual([]);
  });

  test("the build is deterministic", async () => {
    const again = await buildSnapshot({ root: TINY_JAVA, config: JAVA_CONFIG });
    expect(again.symbols.map((d) => d.id)).toEqual(snapshot.symbols.map((d) => d.id));
    expect(again.calls).toEqual(snapshot.calls);
  });
});
