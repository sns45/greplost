# Gates: 1.2.1 render primitives

Scope: Mermaid emitter, ASCII tree, auto-split, token estimate, slugs (spec: render, primitives)

- [x] G1: primitives test file passes
  CHECK: bun test packages/render/test/primitives.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 8039 expect() calls | Ran 45 tests across 1 file. [24.00ms]

- [x] G2: mermaidId sanitises, prefixes digits, resolves collisions deterministically; describe('mermaidId')
  CHECK: bun test packages/render/test/primitives.test.ts -t mermaidId
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 16 expect() calls | Ran 8 tests across 1 file. [7.00ms]

- [x] G3: renderGraph emits sorted nodes/edges, quoted escaped labels, count labels, fenced block; describe('renderGraph')
  CHECK: bun test packages/render/test/primitives.test.ts -t renderGraph
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 16 expect() calls | Ran 7 tests across 1 file. [6.00ms]

- [x] G4: renderTree draws box-drawing trees with dirs first and annotations; describe('renderTree')
  CHECK: bun test packages/render/test/primitives.test.ts -t renderTree
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 7 expect() calls | Ran 7 tests across 1 file. [7.00ms]

- [x] G5: splitDiagram groups by directory, aggregates edges with counts, recurses, paginates flat dirs; describe('splitDiagram')
  CHECK: bun test packages/render/test/primitives.test.ts -t splitDiagram
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 19 expect() calls | Ran 9 tests across 1 file. [7.00ms]

- [x] G6: every diagram returned for 300 flat files and for a 6-level nested tree has <= maxNodes nodes (property test); describe('node cap')
  CHECK: bun test packages/render/test/primitives.test.ts -t "node cap"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 7965 expect() calls | Ran 3 tests across 1 file. [23.00ms]

- [x] G7: estimateTokens and INDEX_TOKEN_BUDGET behave as specified; describe('tokens')
  CHECK: bun test packages/render/test/primitives.test.ts -t tokens
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 8 expect() calls | Ran 3 tests across 1 file. [7.00ms]

- [x] G8: cardPath, packageDir, relLink produce the documented paths for root and nested packages; describe('paths')
  CHECK: bun test packages/render/test/primitives.test.ts -t paths
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 8 expect() calls | Ran 8 tests across 1 file. [6.00ms]

- [x] G9: leaf files typecheck
  CHECK: bunx tsc -p packages/render/tsconfig.json --noEmit
  EVIDENCE: (no output)

