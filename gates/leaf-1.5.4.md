# Gates: 1.5.4 bench mapquality

Scope: M1 token budget, M2 node cap, Mermaid parse check (spec: bench 1.5.4)

- [x] G1: mapquality test file passes
  CHECK: bun test bench/test/mapquality.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 69 expect() calls | Ran 30 tests across 1 file. [775.00ms]

- [x] G2: checkMermaid accepts every diagram shape greplost emits; describe('checkMermaid')
  CHECK: bun test bench/test/mapquality.test.ts -t checkMermaid
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 7 expect() calls | Ran 6 tests across 1 file. [417.00ms]

- [x] G3: checkMermaid rejects a malformed diagram; describe('rejects')
  CHECK: bun test bench/test/mapquality.test.ts -t rejects
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 16 expect() calls | Ran 8 tests across 1 file. [383.00ms]

- [x] G4: mapquality gate passes on the golden render of tiny-ts
  CHECK: bun run bench:mapquality --dir packages/render/test/golden/tiny-ts --gate
  EXPECT: mapquality: GATE PASS
  EVIDENCE: mapquality: GATE PASS | $ bun bench/src/cli.ts mapquality --dir packages/render/test/golden/tiny-ts --gate

- [x] G5: mapquality reports the checker used (mermaid or subset) in its output
  CHECK: bun run bench:mapquality --dir packages/render/test/golden/tiny-ts
  EXPECT: /checker: (mermaid|subset)/
  EVIDENCE: checker: mermaid | $ bun bench/src/cli.ts mapquality --dir packages/render/test/golden/tiny-ts

- [x] G6: leaf files typecheck
  CHECK: bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: (no output)

