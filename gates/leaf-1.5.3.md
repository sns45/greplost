# Gates: 1.5.3 bench corpus

Scope: pinned corpus definition and setup, machine profile (spec: bench 1.5.3)

- [x] G1: corpus test file passes
  CHECK: bun test bench/test/corpus.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 104 expect() calls | Ran 22 tests across 1 file. [296.00ms]

- [x] G2: corpus.json pins 7 repos with 40-hex SHAs, tiers and languages
  CHECK: node -e "const c=JSON.parse(require('fs').readFileSync('bench/corpus.json','utf8')); const n=c.repos.filter(r=>/^[0-9a-f]{40}$/.test(r.sha)&&r.tier&&r.lang&&r.url&&r.name).length; console.log(n+' ok')"
  EXPECT: 7 ok
  EVIDENCE: 7 ok

- [x] G3: setup clones anyq at its pinned SHA (network)
  CHECK: bun bench/src/cli.ts corpus setup --repo anyq
  EXPECT: /anyq: ready at [0-9a-f]{40}/
  EVIDENCE: anyq: ready at 657f41c2cbe06039c0d82cf81c17759d1149eda2

- [x] G4: setup of tier S is idempotent and includes gin
  CHECK: bun bench/src/cli.ts corpus setup --tier S && bun bench/src/cli.ts corpus setup --tier S
  EXPECT: /gin: ready at [0-9a-f]{40}/
  EVIDENCE: anyq: ready at 657f41c2cbe06039c0d82cf81c17759d1149eda2 | gin: ready at dcaa4296d111981ffb31ac3eba90bb63e1eb5ab9

- [x] G5: machine profile has cpu, cores, memoryGB, os, arch, bun, node, go and no hostname or username; describe('machine')
  CHECK: bun test bench/test/corpus.test.ts -t machine
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 16 expect() calls | Ran 2 tests across 1 file. [123.00ms]

- [x] G6: leaf files typecheck
  CHECK: bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: (no output)

