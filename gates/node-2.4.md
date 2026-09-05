# Gates: 2.4 render-and-cli (integration)

Scope: leaf 2.4.1 nodes merged. A non-file node now gets its own card, appears on its file's
card, and answers `greplost query` and `greplost impact`. Spec section 4. The gate that matters
most is N5: a repo with no nodes must render byte-identically to build 1, so every existing user
sees no churn beyond the schema version.

- [x] N1: the child gates file is fully met
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status gates/leaf-2.11.md
  EXPECT: ALL MET
  EVIDENCE: gates/leaf-2.11.md: 13 gates | ALL MET (13 met)

- [x] N2: render, core and cli typecheck
  CHECK: bunx tsc -p packages/render/tsconfig.json --noEmit && bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p packages/cli/tsconfig.json --noEmit
  EVIDENCE: (no output)

- [x] N3: the render, core and cli suites are green
  CHECK: bun test packages/render packages/core packages/cli 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 12238 expect() calls | Ran 1186 tests across 32 files. [3.71s]

- [x] N4: no artifact path contains a "#"
  CHECK: bun test packages/render/test/nodes.test.ts -t "node card path" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 11 expect() calls | Ran 5 tests across 1 file. [84.00ms]

- [x] N5: a repo with no nodes renders byte-identically to the build-1 golden; describe('no nodes no change')
  CHECK: bun test packages/render/test/nodes.test.ts -t "no nodes no change" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 49 expect() calls | Ran 2 tests across 1 file. [141.00ms]

- [x] N6: query and impact answer for a node id and are unchanged for a file
  CHECK: bun test packages/cli/test/nodes.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 135 expect() calls | Ran 20 tests across 1 file. [156.00ms]

- [x] N7: the map-quality gates still hold with node cards present
  CHECK: bun run bench:mapquality --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: mapquality: GATE PASS
  EVIDENCE: checker: mermaid | mapquality: GATE PASS

- [x] N8: greplost still verifies its own committed map (dogfood)
  CHECK: bun packages/cli/src/main.ts verify --diff 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: map is in sync
  EVIDENCE: greplost: map is in sync
