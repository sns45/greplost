# Gates: 1.3.1 sync build-verify

Scope: buildArtifacts, writeArtifacts with pruning, verify with unified diff (spec: sync)

- [x] G1: build test file passes
  CHECK: bun test packages/sync/test/build.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 271 expect() calls | Ran 48 tests across 1 file. [219.00ms]

- [x] G2: verify test file passes
  CHECK: bun test packages/sync/test/verify.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 81 expect() calls | Ran 21 tests across 1 file. [575.00ms]

- [x] G3: isStructurePath table test; describe('isStructurePath')
  CHECK: bun test packages/sync/test/build.test.ts -t isStructurePath
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 40 expect() calls | Ran 26 tests across 1 file. [30.00ms]

- [x] G4: buildArtifacts equals core golden + render golden for tiny-ts; describe('golden union')
  CHECK: bun test packages/sync/test/build.test.ts -t "golden union"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 62 expect() calls | Ran 6 tests across 1 file. [118.00ms]

- [x] G5: writeArtifacts writes only changed bytes, keeps mtime of unchanged files, prunes stale structure files, never touches config/cache/FLOWS; describe('write')
  CHECK: bun test packages/sync/test/build.test.ts -t write
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 163 expect() calls | Ran 13 tests across 1 file. [139.00ms]

- [x] G6: verify ok on a fresh map, fails after a source edit naming the card, diff starts with --- a/.greplost/, extra and missing detected; describe('verify')
  CHECK: bun test packages/sync/test/verify.test.ts -t verify
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 58 expect() calls | Ran 12 tests across 1 file. [471.00ms]

- [x] G7: diff is capped at 200 lines with a truncation marker; describe('diff cap')
  CHECK: bun test packages/sync/test/verify.test.ts -t "diff cap"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 16 expect() calls | Ran 4 tests across 1 file. [169.00ms]

- [x] G8: leaf files typecheck
  CHECK: bunx tsc -p packages/sync/tsconfig.json --noEmit
  EVIDENCE: (no output)

