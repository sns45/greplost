# Gates: 1.5.5 bench replay-perf

Scope: commit replay with drift injection and equivalence checks; performance bench with regression gate (spec: bench 1.5.5)

- [x] G1: replay test file passes
  CHECK: bun test bench/test/replay.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 76 expect() calls | Ran 14 tests across 1 file. [4.55s]

- [x] G2: perf test file passes
  CHECK: bun test bench/test/perf.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 87 expect() calls | Ran 10 tests across 1 file. [2.61s]

- [x] G3: drift injection is caught at every synthetic commit; describe('drift injection')
  CHECK: bun test bench/test/replay.test.ts -t "drift injection"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 30 expect() calls | Ran 3 tests across 1 file. [1.83s]

- [x] G4: full and incremental trees match at equivalence checkpoints; describe('equivalence')
  CHECK: bun test bench/test/replay.test.ts -t equivalence
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 15 expect() calls | Ran 4 tests across 1 file. [1465.00ms]

- [x] G5: replay gate passes on a 5-commit synthetic history of the fixture
  CHECK: bun run bench:replay --fixture --commits 5 --gate
  EXPECT: replay: GATE PASS
  EVIDENCE: replay: GATE PASS | $ bun bench/src/cli.ts replay --fixture --commits "5" --gate

- [x] G6: perf gate passes on the fixture (absolute targets only, no prior result)
  CHECK: bun run bench:perf --fixture --gate
  EXPECT: perf: GATE PASS
  EVIDENCE: perf: GATE PASS | $ bun bench/src/cli.ts perf --fixture --gate

- [x] G7: perf reports p50, p95 and peak RSS per scenario; describe('perf report')
  CHECK: bun test bench/test/perf.test.ts -t "perf report"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 60 expect() calls | Ran 6 tests across 1 file. [1466.00ms]

- [x] G8: leaf files typecheck
  CHECK: bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: (no output)

