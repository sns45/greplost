# Gates: 1.1.3 graph

Scope: import/call linking, export index, Tarjan, blast radius, metrics, serialization (spec: core-extract, sections Linking rules, Metrics, Serialization)

- [ ] G1: graph test file passes
  CHECK: bun test packages/core/test/graph.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G2: serialize test file passes
  CHECK: bun test packages/core/test/serialize.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G3: linkImports: file/ext/unresolved targets, reexport kind, sorted+deduped; describe('linkImports')
  CHECK: bun test packages/core/test/graph.test.ts -t linkImports
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G4: buildExportIndex: hops 0 decls, one hop of named and star re-exports, default mapping, exportNames; describe('export index')
  CHECK: bun test packages/core/test/graph.test.ts -t "export index"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G5: linkCalls: same-file high, imported high, one-hop re-export med, this.m, namespace obj.m, static Class.m, new X, drop rules, from ids; describe('linkCalls')
  CHECK: bun test packages/core/test/graph.test.ts -t linkCalls
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G6: stronglyConnected returns sorted SCCs of size > 1 only; describe('tarjan')
  CHECK: bun test packages/core/test/graph.test.ts -t tarjan
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G7: blastRadius equals brute-force reverse closure on seeded random DAGs and cyclic graphs, impactOf sorted by depth then path; describe('blast')
  CHECK: bun test packages/core/test/graph.test.ts -t blast
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G8: computeMetrics: fanIn/fanOut/blast per file, package deps/rdeps/loc/files, packageEdges counts, cycles; describe('metrics')
  CHECK: bun test packages/core/test/graph.test.ts -t metrics
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G9: serializeSnapshot -> readStructure round-trips edges, symbols and manifest exactly; describe('round-trip')
  CHECK: bun test packages/core/test/serialize.test.ts -t round-trip
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G10: serialized output has sorted keys, contract ordering, trailing newline, no timestamps or absolute paths; describe('ordering')
  CHECK: bun test packages/core/test/serialize.test.ts -t ordering
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G11: leaf files typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit
  EVIDENCE: pending

