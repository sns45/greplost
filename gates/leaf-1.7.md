# Gates: 1.7 workspace

Scope: multi-repo mode: cross-repo edges, WORKSPACE.md, impact across repos (spec: workspace)

- [x] G1: workspace tests pass
  CHECK: bun test packages/workspace
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 96 expect() calls | Ran 37 tests across 1 file. [1107.00ms]

- [x] G2: one cross edge repo-b::src/main.ts -> repo-a::src/index.ts with symbols hello; describe('cross edge')
  CHECK: bun test packages/workspace -t "cross edge"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 27 expect() calls | Ran 8 tests across 1 file. [358.00ms]

- [x] G3: impactAcross reaches repo-b from repo-a's index; describe('impactAcross')
  CHECK: bun test packages/workspace -t impactAcross
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 7 expect() calls | Ran 5 tests across 1 file. [107.00ms]

- [x] G4: verifyWorkspace ok, fails after drift, ok after rebuild; describe('verifyWorkspace')
  CHECK: bun test packages/workspace -t verifyWorkspace
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 10 expect() calls | Ran 4 tests across 1 file. [401.00ms]

- [x] G5: WORKSPACE.md and graph/cross.jsonl byte-stable across builds; describe('byte-stable')
  CHECK: bun test packages/workspace -t byte-stable
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 10 expect() calls | Ran 3 tests across 1 file. [236.00ms]

- [x] G6: CLI impact across repos from the workspace root; describe('cli')
  CHECK: bun test packages/workspace -t cli
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 29 expect() calls | Ran 10 tests across 1 file. [443.00ms]

- [x] G7: workspace typechecks
  CHECK: bunx tsc -p packages/workspace/tsconfig.json --noEmit
  EVIDENCE: (no output)

