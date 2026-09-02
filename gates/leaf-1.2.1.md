# Gates: 1.2.1 render primitives

Scope: Mermaid emitter, ASCII tree, auto-split, token estimate, slugs (spec: render, primitives)

- [ ] G1: primitives test file passes
  CHECK: bun test packages/render/test/primitives.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G2: mermaidId sanitises, prefixes digits, resolves collisions deterministically; describe('mermaidId')
  CHECK: bun test packages/render/test/primitives.test.ts -t mermaidId
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G3: renderGraph emits sorted nodes/edges, quoted escaped labels, count labels, fenced block; describe('renderGraph')
  CHECK: bun test packages/render/test/primitives.test.ts -t renderGraph
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G4: renderTree draws box-drawing trees with dirs first and annotations; describe('renderTree')
  CHECK: bun test packages/render/test/primitives.test.ts -t renderTree
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G5: splitDiagram groups by directory, aggregates edges with counts, recurses, paginates flat dirs; describe('splitDiagram')
  CHECK: bun test packages/render/test/primitives.test.ts -t splitDiagram
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G6: every diagram returned for 300 flat files and for a 6-level nested tree has <= maxNodes nodes (property test); describe('node cap')
  CHECK: bun test packages/render/test/primitives.test.ts -t "node cap"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G7: estimateTokens and INDEX_TOKEN_BUDGET behave as specified; describe('tokens')
  CHECK: bun test packages/render/test/primitives.test.ts -t tokens
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G8: cardPath, packageDir, relLink produce the documented paths for root and nested packages; describe('paths')
  CHECK: bun test packages/render/test/primitives.test.ts -t paths
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G9: leaf files typecheck
  CHECK: bunx tsc -p packages/render/tsconfig.json --noEmit
  EVIDENCE: pending

