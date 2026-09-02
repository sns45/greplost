# Gates: 1.2.2 render docs

Scope: INDEX, repo MAP, HOTSPOTS, package MAP/API, module cards, renderArtifacts, golden render of tiny-ts (spec: render, Documents)

- [ ] G1: docs test file passes
  CHECK: bun test packages/render/test/docs.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G2: golden render of tiny-ts byte-equal for every artifact; describe('golden')
  CHECK: bun test packages/render/test/docs.test.ts -t golden
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G3: INDEX.md stays under the token budget for 5, 60 and 500 packages with the documented degradation; describe('INDEX budget')
  CHECK: bun test packages/render/test/docs.test.ts -t "INDEX budget"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G4: no mermaid fence in any artifact exceeds config.diagram.maxNodes; describe('node cap')
  CHECK: bun test packages/render/test/docs.test.ts -t "node cap"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G5: module cards match tech spec 4.3 line by line (exports formatting, imports grouping, importers links, blast, key symbols cap, calls); describe('card')
  CHECK: bun test packages/render/test/docs.test.ts -t card
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G6: fresh summary, stale summary with banner and date, and no-summary placeholder render correctly; describe('stale banner')
  CHECK: bun test packages/render/test/docs.test.ts -t "stale banner"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G7: no artifact contains an absolute path, a hostname, or a date outside the stale banner; describe('no leaks')
  CHECK: bun test packages/render/test/docs.test.ts -t "no leaks"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G8: rendering the same input twice yields identical maps; describe('deterministic')
  CHECK: bun test packages/render/test/docs.test.ts -t deterministic
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G9: HOTSPOTS lists the bus/events cycle and the god nodes in the fixture; describe('hotspots')
  CHECK: bun test packages/render/test/docs.test.ts -t hotspots
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G10: render package typechecks
  CHECK: bunx tsc -p packages/render/tsconfig.json --noEmit
  EVIDENCE: pending

