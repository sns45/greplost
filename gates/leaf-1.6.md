# Gates: 1.6 semantic

Scope: LLM summaries cached by content hash, FLOWS.md, stale banners (spec: semantic)

- [x] G1: semantic tests pass
  CHECK: bun test packages/semantic
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 163 expect() calls | Ran 39 tests across 3 files. [3.18s]

- [x] G2: second refresh on an unchanged repo makes zero runner calls; describe('zero calls')
  CHECK: bun test packages/semantic -t "zero calls"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 31 expect() calls | Ran 2 tests across 3 files. [198.00ms]

- [x] G3: editing one file makes exactly one stale entry, banner shows refreshedAt, refresh makes one call; describe('stale')
  CHECK: bun test packages/semantic -t stale
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 36 expect() calls | Ran 6 tests across 3 files. [507.00ms]

- [x] G4: FLOWS.md names the worker entry point and contains 2 to 5 sequence diagrams; describe('FLOWS')
  CHECK: bun test packages/semantic -t FLOWS
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 22 expect() calls | Ran 4 tests across 3 files. [288.00ms]

- [x] G5: dryRun makes no calls and writes nothing; invalid runner JSON leaves the cache untouched; describe('safety')
  CHECK: bun test packages/semantic -t safety
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 26 expect() calls | Ran 7 tests across 3 files. [676.00ms]

- [x] G6: semantic typechecks
  CHECK: bunx tsc -p packages/semantic/tsconfig.json --noEmit
  EVIDENCE: (no output)

