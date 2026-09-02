# Gates: 1.5.3 bench corpus

Scope: pinned corpus definition and setup, machine profile (spec: bench 1.5.3)

- [ ] G1: corpus test file passes
  CHECK: bun test bench/test/corpus.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G2: corpus.json pins 7 repos with 40-hex SHAs, tiers and languages
  CHECK: node -e "const c=JSON.parse(require('fs').readFileSync('bench/corpus.json','utf8')); const n=c.repos.filter(r=>/^[0-9a-f]{40}$/.test(r.sha)&&r.tier&&r.lang&&r.url&&r.name).length; console.log(n+' ok')"
  EXPECT: 7 ok
  EVIDENCE: pending

- [ ] G3: setup clones anyq at its pinned SHA (network)
  CHECK: bun bench/src/cli.ts corpus setup --repo anyq
  EXPECT: /anyq: ready at [0-9a-f]{40}/
  EVIDENCE: pending

- [ ] G4: setup of tier S is idempotent and includes gin
  CHECK: bun bench/src/cli.ts corpus setup --tier S && bun bench/src/cli.ts corpus setup --tier S
  EXPECT: /gin: ready at [0-9a-f]{40}/
  EVIDENCE: pending

- [ ] G5: machine profile has cpu, cores, memoryGB, os, arch, bun, node, go and no hostname or username; describe('machine')
  CHECK: bun test bench/test/corpus.test.ts -t machine
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G6: leaf files typecheck
  CHECK: bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: pending

