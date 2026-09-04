# Gates: 2.1.4 kotlin

Scope: Kotlin extraction (declarations including data classes, objects, companions and suspend
functions, imports, exports, extension functions, calls), Kotlin resolution (as Java, with the
three Kotlin differences), the `fixtures/tiny-kotlin` fixture, and a real kotlinc plus
`javap -v` classfile oracle that covers the fixture only. Kotlin's gate is deliberately lower
than every other language's: spec section 1.7 rules that build 2 ships no corpus-scale Kotlin
compiler oracle, so S1 to S4 are gated on the fixture and merely reported on the corpus, where
the gate is determinism, parse health and non-empty extraction; the reason is published in
`bench/RESULTS.md` next to the losses table rather than hidden.
Spec: `docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 1.5, 1.7, 1.8.

- [ ] G1: the Kotlin extraction test file passes
  CHECK: bun test packages/core/test/extract-kotlin.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G2: classes, data classes, objects, companions, suspend functions and properties, and the import rules; describe('declarations'), describe('imports')
  CHECK: bun test packages/core/test/extract-kotlin.test.ts -t "declarations|imports" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G3: an extension function is named `<Receiver>.<name>` with the receiver as `parent`; describe('extensions')
  CHECK: bun test packages/core/test/extract-kotlin.test.ts -t extensions 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G4: call sites, `this.method`, an extension call resolving like a method; describe('calls')
  CHECK: bun test packages/core/test/extract-kotlin.test.ts -t calls 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G5: the fixture builds with the expected declarations, imports and one import-qualified call; describe('tiny-kotlin')
  CHECK: bun test packages/core/test/extract-kotlin.test.ts -t tiny-kotlin 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G6: the truth generator test file passes
  CHECK: bun test bench/test/truth-kotlin.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G7: the fixture oracle really compiles with kotlinc and reads classfiles back with `javap -v`, attributing each class to its `SourceFile`, and imports nothing from `packages/core`; describe('kotlin fixture oracle')
  CHECK: bun test bench/test/truth-kotlin.test.ts -t "kotlin fixture oracle" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G8: the module declares itself reported-only: `NOTES` contains `fixture-oracle-only` and `no-corpus-compiler-truth`; describe('reported only')
  CHECK: bun test bench/test/truth-kotlin.test.ts -t "reported only" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G9: the machine has kotlinc and the exact version string is recorded as this gate's evidence (`brew install kotlin` first; the machine had none on 2026-09-04)
  CHECK: kotlinc -version 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /kotlinc-jvm \d+\.\d+\.\d+/

- [ ] G10: S1 to S4 pass on the fixture, against the kotlinc plus `javap -v` oracle
  CHECK: bun run bench:structural --fixture tiny-kotlin --lang kotlin --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] G11: on the pinned corpus repo (coroutines, subset `kotlinx-coroutines-core/{common,jvm}/src/`, 163 files) the gate is a deterministic build (two builds byte-identical), parse health (fewer than 1% of `.kt` files carry a root-level ERROR node, and each is listed in the unparsable bucket) and non-empty extraction; S1 to S3 print `n/a` and are never a pass or a fail
  CHECK: bun bench/src/cli.ts corpus setup --repo coroutines >/dev/null && bun run bench:structural --repo coroutines --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] G12: the core and bench suites are green
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G13: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
