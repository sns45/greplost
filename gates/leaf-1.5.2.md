# Gates: 1.5.2 bench adapters

Scope: competitor artifact adapters for Graphify, Understand-Anything, code-review-graph with pinned versions (spec: bench 1.5.2)

- [x] G1: adapters test file passes
  CHECK: bun test bench/test/adapters.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 437 expect() calls | Ran 40 tests across 1 file. [21.00ms]

- [x] G2: each adapter round-trips its fixture through stableStringify; describe('round-trip')
  CHECK: bun test bench/test/adapters.test.ts -t round-trip
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 74 expect() calls | Ran 9 tests across 1 file. [17.00ms]

- [x] G3: every emitted id is a valid greplost id; describe('valid ids')
  CHECK: bun test bench/test/adapters.test.ts -t "valid ids"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 253 expect() calls | Ran 7 tests across 1 file. [15.00ms]

- [x] G4: competitors.json pins version, commit, verbatim install and run commands, artifact paths and sync mechanism for all three tools
  CHECK: node -e "const c=JSON.parse(require('fs').readFileSync('bench/competitors.json','utf8')); const ok=c.tools.filter(t=>t.version&&t.commit&&t.install?.length&&t.run?.length&&t.artifactPaths?.length&&'syncMechanism' in t).map(t=>t.name).sort(); console.log(ok.join(' '))"
  EXPECT: crg graphify ua
  EVIDENCE: crg graphify ua

- [x] G5: each competitor fixture has a SOURCE.md provenance note
  CHECK: ls bench/fixtures/competitors/*/SOURCE.md | wc -l | tr -d ' '
  EXPECT: 3
  EVIDENCE: 3

- [x] G6: adapters roundtrip command prints per-tool counts
  CHECK: bun bench/src/cli.ts adapters roundtrip
  EXPECT: /graphify: \d+ imports, \d+ calls[\s\S]*ua: \d+ imports[\s\S]*crg: \d+ imports/
  EVIDENCE: ua: 6 imports, 4 calls | crg: 6 imports, 5 calls

- [x] G7: leaf files typecheck
  CHECK: bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: (no output)

