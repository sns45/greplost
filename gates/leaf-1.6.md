# Gates: 1.6 semantic

Scope: LLM summaries cached by content hash, FLOWS.md, stale banners (spec: semantic)

- [x] G1: semantic tests pass
  CHECK: bun test packages/semantic
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 231 expect() calls | Ran 50 tests across 3 files. [3.90s]

- [x] G2: second refresh on an unchanged repo makes zero runner calls; describe('zero calls')
  CHECK: bun test packages/semantic -t "zero calls"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 32 expect() calls | Ran 2 tests across 3 files. [198.00ms]

- [x] G3: editing one file makes exactly one stale entry, banner shows refreshedAt, refresh makes one call; describe('stale')
  CHECK: bun test packages/semantic -t stale
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 65 expect() calls | Ran 12 tests across 3 files. [1109.00ms]

- [x] G4: FLOWS.md names the worker entry point and contains 2 to 5 sequence diagrams; describe('FLOWS')
  CHECK: bun test packages/semantic -t FLOWS
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 32 expect() calls | Ran 5 tests across 3 files. [329.00ms]

- [x] G5: dryRun makes no calls and writes nothing; invalid runner JSON leaves the cache untouched; describe('safety')
  CHECK: bun test packages/semantic -t safety
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 54 expect() calls | Ran 11 tests across 3 files. [1.83s]

- [x] G6: semantic typechecks
  CHECK: bunx tsc -p packages/semantic/tsconfig.json --noEmit
  EVIDENCE: (no output)

