# Gates: 2.1.1 python

Scope: Python extraction (declarations, `__all__`, imports, exports, calls), Python resolution
(absolute, relative and namespace packages, the committed stdlib list), the `fixtures/tiny-python`
fixture, and the independent `ast`-based truth generator with a corpus gate on pydantic.
Spec: `docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 1.2, 1.6, 1.8.

- [x] G1: the Python extraction test file passes
  CHECK: bun test packages/core/test/extract-python.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 74 expect() calls | Ran 42 tests across 1 file. [81.00ms]

- [x] G2: declarations, `__all__` visibility and signatures; describe('declarations')
  CHECK: bun test packages/core/test/extract-python.test.ts -t declarations 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 15 expect() calls | Ran 10 tests across 1 file. [50.00ms]

- [x] G3: absolute, relative and star imports; describe('imports')
  CHECK: bun test packages/core/test/extract-python.test.ts -t imports 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 13 expect() calls | Ran 9 tests across 1 file. [73.00ms]

- [x] G4: `__all__` overrides the underscore rule in both directions; describe('__all__')
  CHECK: bun test packages/core/test/extract-python.test.ts -t __all__ 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 14 expect() calls | Ran 9 tests across 1 file. [74.00ms]

- [x] G5: call sites and the never-guess rule; describe('calls')
  CHECK: bun test packages/core/test/extract-python.test.ts -t calls 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 7 expect() calls | Ran 7 tests across 1 file. [51.00ms]

- [x] G6: the fixture builds with the expected import edges and the one cycle; describe('tiny-python')
  CHECK: bun test packages/core/test/extract-python.test.ts -t tiny-python 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 30 expect() calls | Ran 8 tests across 1 file. [76.00ms]

- [x] G7: the truth generator test file passes
  CHECK: bun test bench/test/truth-python.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 66 expect() calls | Ran 24 tests across 1 file. [522.00ms]

- [x] G8: the oracle never imports corpus code and never imports greplost's extractor; describe('oracle independence')
  CHECK: bun test bench/test/truth-python.test.ts -t "oracle independence" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 16 expect() calls | Ran 3 tests across 1 file. [208.00ms]

- [x] G9: S1 to S4 pass on the fixture
  CHECK: bun run bench:structural --fixture tiny-python --lang python --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: S6  signal node precision                  >=0.95           n/a            not measured by this oracle | structural: GATE PASS

- [x] G10: S1 to S4 pass on the pinned corpus repo (pydantic, subset pydantic/, 105 files)
  CHECK: bun bench/src/cli.ts corpus setup --repo pydantic >/dev/null && bun run bench:structural --repo pydantic --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: S6  signal node precision                  >=0.95           n/a            not measured by this oracle | structural: GATE PASS

- [x] G11: the core and bench suites are green
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 4530 expect() calls | Ran 932 tests across 26 files. [48.51s]

- [x] G12: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: (no output)
