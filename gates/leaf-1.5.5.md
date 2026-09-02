# Gates: 1.5.5 bench replay-perf

Scope: commit replay with drift injection and equivalence checks; performance bench with regression gate (spec: bench 1.5.5)

- [ ] G1: replay test file passes
  CHECK: bun test bench/test/replay.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G2: perf test file passes
  CHECK: bun test bench/test/perf.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G3: drift injection is caught at every synthetic commit; describe('drift injection')
  CHECK: bun test bench/test/replay.test.ts -t "drift injection"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G4: full and incremental trees match at equivalence checkpoints; describe('equivalence')
  CHECK: bun test bench/test/replay.test.ts -t equivalence
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G5: replay gate passes on a 5-commit synthetic history of the fixture
  CHECK: bun run bench:replay --fixture --commits 5 --gate
  EXPECT: replay: GATE PASS
  EVIDENCE: pending

- [ ] G6: perf gate passes on the fixture (absolute targets only, no prior result)
  CHECK: bun run bench:perf --fixture --gate
  EXPECT: perf: GATE PASS
  EVIDENCE: pending

- [ ] G7: perf reports p50, p95 and peak RSS per scenario; describe('perf report')
  CHECK: bun test bench/test/perf.test.ts -t "perf report"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G8: leaf files typecheck
  CHECK: bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: pending

