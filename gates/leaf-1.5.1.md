# Gates: 1.5.1 bench truth-ts

Scope: TypeScript compiler truth generator, deterministic scoring, Eval 1 runner (spec: bench 1.5.1)

- [x] G1: truth-ts test file passes
  CHECK: bun test bench/test/truth-ts.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 91 expect() calls | Ran 26 tests across 1 file. [2.12s]

- [x] G2: score test file passes
  CHECK: bun test bench/test/score.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 83 expect() calls | Ran 36 tests across 1 file. [129.00ms]

- [x] G3: fixture truth pins the expected import edges, exports, retry callers and the bus/events cycle; describe('fixture truth')
  CHECK: bun test bench/test/truth-ts.test.ts -t "fixture truth"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 76 expect() calls | Ran 18 tests across 1 file. [654.00ms]

- [x] G4: scoreSet/scoreEdges/jaccardCycles on hand-built sets, including empty sets; describe('scoring')
  CHECK: bun test bench/test/score.test.ts -t scoring
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 32 expect() calls | Ran 15 tests across 1 file. [86.00ms]

- [x] G5: structural --fixture --dry-run prints the S1 to S4 table shape
  CHECK: bun run bench:structural --fixture --dry-run
  EXPECT: /S1[\s\S]*S2[\s\S]*S3[\s\S]*S4/
  EVIDENCE: structural: dry-run ok | $ bun bench/src/cli.ts structural --fixture --dry-run

- [x] G6: results-io writes and reads results/<suite>-<date>-<sha>.json; describe('results-io')
  CHECK: bun test bench/test/score.test.ts -t results-io
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 18 expect() calls | Ran 9 tests across 1 file. [135.00ms]

- [x] G7: leaf files typecheck
  CHECK: bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: (no output)

