# Gates: 1.3.2 sync incremental

Scope: incremental update, state, lock, dirty file, parse cache, init, git hooks (spec: sync)

- [ ] G1: incremental test file passes
  CHECK: bun test packages/sync/test/incremental.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G2: lock test file passes
  CHECK: bun test packages/sync/test/lock.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G3: githooks test file passes
  CHECK: bun test packages/sync/test/githooks.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G4: incremental and full updates produce byte-identical .greplost trees; describe('equivalence')
  CHECK: bun test packages/sync/test/incremental.test.ts -t equivalence
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G5: clean repo second run reports skipped clean; dirty file consumed and cleared; reparsed/cached counts correct after one edit; describe('dirty')
  CHECK: bun test packages/sync/test/incremental.test.ts -t dirty
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G6: parse cache round-trips and prunes entries no longer in the manifest; describe('parse cache')
  CHECK: bun test packages/sync/test/incremental.test.ts -t "parse cache"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G7: init writes config, .gitignore, full map and records lastIndexedCommit; describe('init')
  CHECK: bun test packages/sync/test/incremental.test.ts -t init
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G8: live lock blocks, stale/dead-pid lock reclaimed, lock removed after throw; describe('lock')
  CHECK: bun test packages/sync/test/lock.test.ts -t lock
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G9: plain hooks installed executable with marker, idempotent, husky preferred, none outside git; describe('hooks')
  CHECK: bun test packages/sync/test/githooks.test.ts -t hooks
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G10: sync package tests green
  CHECK: bun test packages/sync
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G11: sync package typechecks
  CHECK: bunx tsc -p packages/sync/tsconfig.json --noEmit
  EVIDENCE: pending

