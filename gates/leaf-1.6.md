# Gates: 1.6 semantic

Scope: LLM summaries cached by content hash, FLOWS.md, stale banners (spec: semantic)

- [ ] G1: semantic tests pass
  CHECK: bun test packages/semantic
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G2: second refresh on an unchanged repo makes zero runner calls; describe('zero calls')
  CHECK: bun test packages/semantic -t "zero calls"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G3: editing one file makes exactly one stale entry, banner shows refreshedAt, refresh makes one call; describe('stale')
  CHECK: bun test packages/semantic -t stale
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G4: FLOWS.md names the worker entry point and contains 2 to 5 sequence diagrams; describe('FLOWS')
  CHECK: bun test packages/semantic -t FLOWS
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G5: dryRun makes no calls and writes nothing; invalid runner JSON leaves the cache untouched; describe('safety')
  CHECK: bun test packages/semantic -t safety
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G6: semantic typechecks
  CHECK: bunx tsc -p packages/semantic/tsconfig.json --noEmit
  EVIDENCE: pending

