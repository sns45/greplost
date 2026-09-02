# Gates: 1.2.2 render docs

Scope: INDEX, repo MAP, HOTSPOTS, package MAP/API, module cards, renderArtifacts, golden render of tiny-ts (spec: render, Documents)

- [x] G1: docs test file passes
  CHECK: bun test packages/render/test/docs.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 894 expect() calls | Ran 61 tests across 1 file. [162.00ms]

- [x] G2: golden render of tiny-ts byte-equal for every artifact; describe('golden')
  CHECK: bun test packages/render/test/docs.test.ts -t golden
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 282 expect() calls | Ran 4 tests across 1 file. [74.00ms]

- [x] G3: INDEX.md stays under the token budget for 5, 60 and 500 packages with the documented degradation; describe('INDEX budget')
  CHECK: bun test packages/render/test/docs.test.ts -t "INDEX budget"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 26 expect() calls | Ran 7 tests across 1 file. [105.00ms]

- [x] G4: no mermaid fence in any artifact exceeds config.diagram.maxNodes; describe('node cap')
  CHECK: bun test packages/render/test/docs.test.ts -t "node cap"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 191 expect() calls | Ran 5 tests across 1 file. [92.00ms]

- [x] G5: module cards match tech spec 4.3 line by line (exports formatting, imports grouping, importers links, blast, key symbols cap, calls); describe('card')
  CHECK: bun test packages/render/test/docs.test.ts -t card
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 114 expect() calls | Ran 15 tests across 1 file. [78.00ms]

- [x] G6: fresh summary, stale summary with banner and date, and no-summary placeholder render correctly; describe('stale banner')
  CHECK: bun test packages/render/test/docs.test.ts -t "stale banner"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 8 expect() calls | Ran 4 tests across 1 file. [75.00ms]

- [x] G7: no artifact contains an absolute path, a hostname, or a date outside the stale banner; describe('no leaks')
  CHECK: bun test packages/render/test/docs.test.ts -t "no leaks"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 207 expect() calls | Ran 4 tests across 1 file. [78.00ms]

- [x] G8: rendering the same input twice yields identical maps; describe('deterministic')
  CHECK: bun test packages/render/test/docs.test.ts -t deterministic
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 11 expect() calls | Ran 5 tests across 1 file. [109.00ms]

- [x] G9: HOTSPOTS lists the bus/events cycle and the god nodes in the fixture; describe('hotspots')
  CHECK: bun test packages/render/test/docs.test.ts -t hotspots
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 13 expect() calls | Ran 6 tests across 1 file. [79.00ms]

- [x] G10: render package typechecks
  CHECK: bunx tsc -p packages/render/tsconfig.json --noEmit
  EVIDENCE: (no output)

