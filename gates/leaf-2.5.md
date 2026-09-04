# Gates: 2.1.3 java

Scope: Java extraction (types, members, annotations, imports, exports, calls), Java resolution
(a fully qualified name to a file under a source root, same-package siblings, `ext:maven/` for
everything else), the `fixtures/tiny-java` fixture, and the independent javac Compiler Tree API
truth generator with a corpus gate on gson.
Spec: `docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 1.4, 1.6, 1.8.

- [ ] G1: the Java extraction test file passes
  CHECK: bun test packages/core/test/extract-java.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G2: classes, interfaces, enums, records, methods and fields with the `public` export rule; describe('declarations')
  CHECK: bun test packages/core/test/extract-java.test.ts -t declarations 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G3: plain, on-demand and static imports, and the fully qualified name to source-root file walk; describe('imports')
  CHECK: bun test packages/core/test/extract-java.test.ts -t imports 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G4: annotation names land in `meta.annotations`, sorted and comma-joined; describe('annotations')
  CHECK: bun test packages/core/test/extract-java.test.ts -t annotations 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G5: call sites, `new Type`, `this.method`, and the dropped interface dispatch; describe('calls')
  CHECK: bun test packages/core/test/extract-java.test.ts -t calls 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G6: the fixture builds with the expected import edges, the same-package call and the static import; describe('tiny-java')
  CHECK: bun test packages/core/test/extract-java.test.ts -t tiny-java 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G7: the truth generator test file passes
  CHECK: bun test bench/test/truth-java.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G8: the javac oracle imports nothing from greplost and its output changes when the fixture changes; describe('oracle independence')
  CHECK: bun test bench/test/truth-java.test.ts -t "oracle independence" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G9: S1 to S4 pass on the fixture
  CHECK: bun run bench:structural --fixture tiny-java --lang java --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] G10: S1 to S4 pass on the pinned corpus repo (gson, subset `**/src/main/`, 122 files)
  CHECK: bun bench/src/cli.ts corpus setup --repo gson >/dev/null && bun run bench:structural --repo gson --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] G11: the core and bench suites are green
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G12: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
