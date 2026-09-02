# Gates: 1.1.3 graph

Scope: import/call linking, export index, Tarjan, blast radius, metrics, serialization (spec: core-extract, sections Linking rules, Metrics, Serialization)

- [x] G1: graph test file passes
  CHECK: bun test packages/core/test/graph.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 216 expect() calls | Ran 66 tests across 1 file. [33.00ms]

- [x] G2: serialize test file passes
  CHECK: bun test packages/core/test/serialize.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 101 expect() calls | Ran 13 tests across 1 file. [14.00ms]

- [x] G3: linkImports: file/ext/unresolved targets, reexport kind, sorted+deduped; describe('linkImports')
  CHECK: bun test packages/core/test/graph.test.ts -t linkImports
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 32 expect() calls | Ran 9 tests across 1 file. [16.00ms]

- [x] G4: buildExportIndex: hops 0 decls, one hop of named and star re-exports, default mapping, exportNames; describe('export index')
  CHECK: bun test packages/core/test/graph.test.ts -t "export index"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 46 expect() calls | Ran 15 tests across 1 file. [15.00ms]

- [x] G5: linkCalls: same-file high, imported high, one-hop re-export med, this.m, namespace obj.m, static Class.m, new X, drop rules, from ids; describe('linkCalls')
  CHECK: bun test packages/core/test/graph.test.ts -t linkCalls
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 21 expect() calls | Ran 18 tests across 1 file. [15.00ms]

- [x] G6: stronglyConnected returns sorted SCCs of size > 1 only; describe('tarjan')
  CHECK: bun test packages/core/test/graph.test.ts -t tarjan
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 8 expect() calls | Ran 6 tests across 1 file. [21.00ms]

- [x] G7: blastRadius equals brute-force reverse closure on seeded random DAGs and cyclic graphs, impactOf sorted by depth then path; describe('blast')
  CHECK: bun test packages/core/test/graph.test.ts -t blast
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 86 expect() calls | Ran 11 tests across 1 file. [21.00ms]

- [x] G8: computeMetrics: fanIn/fanOut/blast per file, package deps/rdeps/loc/files, packageEdges counts, cycles; describe('metrics')
  CHECK: bun test packages/core/test/graph.test.ts -t metrics
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 28 expect() calls | Ran 8 tests across 1 file. [17.00ms]

- [x] G9: serializeSnapshot -> readStructure round-trips edges, symbols and manifest exactly; describe('round-trip')
  CHECK: bun test packages/core/test/serialize.test.ts -t round-trip
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 24 expect() calls | Ran 8 tests across 1 file. [13.00ms]

- [x] G10: serialized output has sorted keys, contract ordering, trailing newline, no timestamps or absolute paths; describe('ordering')
  CHECK: bun test packages/core/test/serialize.test.ts -t ordering
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 77 expect() calls | Ran 5 tests across 1 file. [11.00ms]

- [x] G11: leaf files typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit
  EVIDENCE: (no output)

