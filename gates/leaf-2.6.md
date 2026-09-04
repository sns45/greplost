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

- [x] G1: the Kotlin extraction test file passes
  CHECK: bun test packages/core/test/extract-kotlin.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 65 expect() calls | Ran 43 tests across 1 file. [94.00ms]

- [x] G2: classes, data classes, objects, companions, suspend functions and properties, and the import rules; describe('declarations'), describe('imports')
  CHECK: bun test packages/core/test/extract-kotlin.test.ts -t "declarations|imports" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 39 expect() calls | Ran 21 tests across 1 file. [87.00ms] (21 pass, 22 filtered out)

- [x] G3: an extension function is named `<Receiver>.<name>` with the receiver as `parent`; describe('extensions')
  CHECK: bun test packages/core/test/extract-kotlin.test.ts -t extensions 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 6 expect() calls | Ran 5 tests across 1 file. [93.00ms]; fun String.shout() -> name String.shout, kind function, parent String

- [x] G4: call sites, `this.method`, an extension call resolving like a method; describe('calls')
  CHECK: bun test packages/core/test/extract-kotlin.test.ts -t calls 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 13 expect() calls | Ran 12 tests across 1 file. [124.00ms]

- [x] G5: the fixture builds with the expected declarations, imports and one import-qualified call; describe('tiny-kotlin')
  CHECK: bun test packages/core/test/extract-kotlin.test.ts -t tiny-kotlin 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 12 expect() calls | Ran 6 tests across 1 file. [192.00ms]; 3 files, 1 import edge, 7 call edges, 16 export names, 0 cycles

- [x] G6: the truth generator test file passes
  CHECK: bun test bench/test/truth-kotlin.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 50 expect() calls | Ran 14 tests across 1 file. [1.64s]

- [x] G7: the fixture oracle really compiles with kotlinc and reads classfiles back with `javap -v`, attributing each class to its `SourceFile`, and imports nothing from `packages/core`; describe('kotlin fixture oracle')
  CHECK: bun test bench/test/truth-kotlin.test.ts -t "kotlin fixture oracle" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 28 expect() calls | Ran 9 tests across 1 file. [1390.00ms]; kotlinc emits 10 classfiles for the 3 .kt files and javap -v attributes all 10 through SourceFile

- [x] G8: the module declares itself reported-only: `NOTES` contains `fixture-oracle-only` and `no-corpus-compiler-truth`; describe('reported only')
  CHECK: bun test bench/test/truth-kotlin.test.ts -t "reported only" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 22 expect() calls | Ran 5 tests across 1 file. [1407.00ms]; NOTES = fixture-oracle-only, no-corpus-compiler-truth, kotlinc-javap-classfiles, jvm-synthetics-dropped, property-access-not-a-call

- [x] G9: the machine has kotlinc and the exact version string is recorded as this gate's evidence (`brew install kotlin` first; the machine had none on 2026-09-04)
  CHECK: kotlinc -version 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /kotlinc-jvm \d+\.\d+\.\d+/
  EVIDENCE: info: kotlinc-jvm 2.4.10 (JRE 24.0.2+12) -- brew install kotlin on 2026-09-04; that version is the floor for CI

- [x] G10: S1 to S4 pass on the fixture, against the kotlinc plus `javap -v` oracle
  CHECK: bun run bench:structural --fixture tiny-kotlin --lang kotlin --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: tiny-kotlin (3 files) S1 1.000/1.000 (tp 1, fp 0, fn 0), S2 1.000/1.000 (tp 16, fp 0, fn 0), S3 precision 1.000 with recall 1.000 (tp 7, fp 0, fn 0), S4 1.000; S5/S6 n/a; structural: GATE PASS

- [x] G11: on the pinned corpus repo (coroutines, subset `kotlinx-coroutines-core/{common,jvm}/src/`, 163 files) the gate is a deterministic build (two builds byte-identical), parse health (fewer than 1% of `.kt` files carry a root-level ERROR node, and each is listed in the unparsable bucket) and non-empty extraction; S1 to S3 print `n/a` and are never a pass or a fail
  CHECK: bun bench/src/cli.ts corpus setup --repo coroutines >/dev/null && bun run bench:structural --repo coroutines --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: coroutines (163 files) S1-S6 n/a; deterministic build pass, parse error rate 0.0000 (no file carries a root-level ERROR), every non-empty file pass (0 silent); structural: GATE PASS

- [x] G12: the core and bench suites are green
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 5495 expect() calls | Ran 1388 tests across 40 files. [93.26s]; the whole suite after the merge of main is 1871 pass, 0 fail

- [x] G13: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: bun run typecheck green for every package after the merge of main (core, render, sync, cli, semantic, workspace, bench, scripts)
