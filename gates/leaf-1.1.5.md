# Gates: 1.1.5 build

Scope: buildSnapshot composition, query helpers, public index, golden structure files for tiny-ts

- [x] G1: build test file passes
  CHECK: bun test packages/core/test/build.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 117 expect() calls | Ran 24 tests across 1 file. [803.00ms]

- [x] G2: query test file passes
  CHECK: bun test packages/core/test/query.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 35 expect() calls | Ran 16 tests across 1 file. [24.00ms]

- [x] G3: golden structure files byte-equal to the fixture build; describe('golden')
  CHECK: bun test packages/core/test/build.test.ts -t golden
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 30 expect() calls | Ran 9 tests across 1 file. [145.00ms]

- [x] G4: build twice yields identical bytes; describe('idempotent')
  CHECK: bun test packages/core/test/build.test.ts -t idempotent
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 10 expect() calls | Ran 2 tests across 1 file. [237.00ms]

- [x] G5: shuffled discovery order yields identical bytes; describe('order invariance')
  CHECK: bun test packages/core/test/build.test.ts -t "order invariance"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 23 expect() calls | Ran 3 tests across 1 file. [354.00ms]

- [x] G6: warm parse cache yields identical bytes and zero parses; describe('parse cache')
  CHECK: bun test packages/core/test/build.test.ts -t "parse cache"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 26 expect() calls | Ran 3 tests across 1 file. [290.00ms]

- [x] G7: summaryHash/staleSummary follow the semantic rules (fresh, stale by path, none); describe('summaries')
  CHECK: bun test packages/core/test/build.test.ts -t summaries
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 15 expect() calls | Ran 4 tests across 1 file. [323.00ms]

- [x] G8: findSymbols exact/suffix ordering, importersOf, callersOf on the fixture; describe('query')
  CHECK: bun test packages/core/test/query.test.ts -t query
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 35 expect() calls | Ran 16 tests across 1 file. [24.00ms]

- [x] G9: whole core package tests pass
  CHECK: bun test packages/core
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 823 expect() calls | Ran 296 tests across 8 files. [1.90s]

- [x] G10: core package typechecks
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit
  EVIDENCE: (no output)

