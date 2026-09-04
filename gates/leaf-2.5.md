# Gates: 2.1.3 java

Scope: Java extraction (types, members, annotations, imports, exports, calls), Java resolution
(a fully qualified name to a file under a source root, same-package siblings, `ext:maven/` for
everything else), the `fixtures/tiny-java` fixture, and the independent javac Compiler Tree API
truth generator with a corpus gate on gson.
Spec: `docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 1.4, 1.6, 1.8.

- [x] G1: the Java extraction test file passes
  CHECK: bun test packages/core/test/extract-java.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 32 pass | 0 fail | 52 expect() calls | Ran 32 tests across 1 file. [111.00ms]

- [x] G2: classes, interfaces, enums, records, methods and fields with the `public` export rule; describe('declarations')
  CHECK: bun test packages/core/test/extract-java.test.ts -t declarations 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 8 pass | 24 filtered out | 0 fail | 15 expect() calls. Covers the five type kinds,
  `<Type>.<method>` names with `parent`, overloads sharing a name under `~<n>` ids, `const` vs
  `var` fields, implicitly public interface members and enum constants, the package-private
  enclosing-chain rule, the deduplicated export set, and signatures cut before the body.

- [x] G3: plain, on-demand and static imports, and the fully qualified name to source-root file walk; describe('imports')
  CHECK: bun test packages/core/test/extract-java.test.ts -t imports 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 5 pass | 27 filtered out | 0 fail | 11 expect() calls. Covers the three import
  forms, the source-root order (`src/main/java`, `src/test/java`, repo root), a nested type and
  a static member both falling back to the file that declares the outer type, `java.*`/`javax.*`
  as always external, and `ext:maven/<group>:<artifact>`.

- [x] G4: annotation names land in `meta.annotations`, sorted and comma-joined; describe('annotations')
  CHECK: bun test packages/core/test/extract-java.test.ts -t annotations 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 3 pass | 29 filtered out | 0 fail | 6 expect() calls. `@Deprecated @SafeVarargs` ->
  `{ annotations: "Deprecated,SafeVarargs" }`; a qualified `@com.foo.Bar` keeps its simple name;
  a declaration with no annotation carries no `meta` at all.

- [x] G5: call sites, `new Type`, `this.method`, and the dropped interface dispatch; describe('calls')
  CHECK: bun test packages/core/test/extract-java.test.ts -t calls 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 8 pass | 24 filtered out | 0 fail | 9 expect() calls. A receiver is written down as
  its declared type; a chained call, a field-access receiver, `super` and a generic witness are
  not recorded; same-file, `this.`, `new Type`, same-package sibling and static-import calls all
  resolve `high`; interface dispatch, an unqualified inherited call, an overloaded member, a
  `var` receiver and a name bound twice all resolve to nothing.

- [x] G6: the fixture builds with the expected import edges, the same-package call and the static import; describe('tiny-java')
  CHECK: bun test packages/core/test/extract-java.test.ts -t tiny-java 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 8 pass | 24 filtered out | 0 fail | 11 expect() calls. `tiny.Store` resolves to
  `src/main/java/tiny/Store.java`; the two in-repo import edges are the plain and the static
  import; 18 exported names; 10 call edges, all `high`; no cycle; two builds identical.

- [x] G7: the truth generator test file passes
  CHECK: bun test bench/test/truth-java.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 19 pass | 0 fail | 53 expect() calls | Ran 19 tests across 1 file. [1.80s]

- [x] G8: the javac oracle imports nothing from greplost and its output changes when the fixture changes; describe('oracle independence')
  CHECK: bun test bench/test/truth-java.test.ts -t "oracle independence" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 3 pass | 16 filtered out | 0 fail | 11 expect() calls. Every greplost import in
  `bench/src/truth/java.ts` is type-only; `Truth.java` names no tree-sitter, no `packages/core`
  and no `greplost`; adding a method to the fixture adds exactly one export and one call edge;
  removing `import tiny.Store;` removes the import edge and leaves the calls (a same-package
  sibling needs no import).

- [x] G9: S1 to S4 pass on the fixture
  CHECK: bun run bench:structural --fixture tiny-java --lang java --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: structural: tiny-java (4 files). S1 1.000/1.000 (tp 2, fp 0, fn 0), S2 1.000/1.000
  (tp 18, fp 0, fn 0), S3 1.000 with recall 1.000 (tp 10, fp 0, fn 0), S4 1.000.
  structural: GATE PASS

- [x] G10: S1 to S4 pass on the pinned corpus repo (gson, subset `**/src/main/`, 122 files)
  CHECK: bun bench/src/cli.ts corpus setup --repo gson >/dev/null && bun run bench:structural --repo gson --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: structural: gson (95 files). The 122 pinned files minus 2 `module-info.java` (a JPMS
  module declaration is not a type and is never compiled) and 25 files javac reported an
  unresolved third-party symbol in (errorprone annotations, guava, caliper, jackson,
  javax.annotation), which the oracle drops so neither side is scored on a file the compiler
  never fully saw. S1 1.000/0.993 (tp 271, fp 0, fn 2), S2 1.000/1.000 (tp 489, fp 0, fn 0),
  S3 1.000 with recall 0.855 (tp 721, fp 0, fn 122), S4 1.000. structural: GATE PASS

- [x] G11: the core and bench suites are green
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: after merging main: 1711 pass | 0 fail | 15816 expect() calls | Ran 1711 tests
  across 51 files (the whole repo; `bun test packages/core bench` is a subset of it).

- [x] G12: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: both clean, and the whole monorepo typechecks (`bun run typecheck`, 8 projects).
