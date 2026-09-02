# Gates: 1.1.5 build

Scope: buildSnapshot composition, query helpers, public index, golden structure files for tiny-ts

- [ ] G1: build test file passes
  CHECK: bun test packages/core/test/build.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G2: query test file passes
  CHECK: bun test packages/core/test/query.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G3: golden structure files byte-equal to the fixture build; describe('golden')
  CHECK: bun test packages/core/test/build.test.ts -t golden
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G4: build twice yields identical bytes; describe('idempotent')
  CHECK: bun test packages/core/test/build.test.ts -t idempotent
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G5: shuffled discovery order yields identical bytes; describe('order invariance')
  CHECK: bun test packages/core/test/build.test.ts -t "order invariance"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G6: warm parse cache yields identical bytes and zero parses; describe('parse cache')
  CHECK: bun test packages/core/test/build.test.ts -t "parse cache"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G7: summaryHash/staleSummary follow the semantic rules (fresh, stale by path, none); describe('summaries')
  CHECK: bun test packages/core/test/build.test.ts -t summaries
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G8: findSymbols exact/suffix ordering, importersOf, callersOf on the fixture; describe('query')
  CHECK: bun test packages/core/test/query.test.ts -t query
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G9: whole core package tests pass
  CHECK: bun test packages/core
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G10: core package typechecks
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit
  EVIDENCE: pending

