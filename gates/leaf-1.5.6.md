# Gates: 1.5.6 bench agent

Scope: task generation, headless Claude Code runner, deterministic scoring (spec: bench 1.5.6)

- [x] G1: agent test file passes
  CHECK: bun test bench/test/agent.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 461 expect() calls | Ran 27 tests across 1 file. [2.69s]

- [x] G2: generateStructuralTasks builds stable ids and truths from fixture truth; describe('tasks')
  CHECK: bun test bench/test/agent.test.ts -t tasks
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 297 expect() calls | Ran 10 tests across 1 file. [468.00ms]

- [x] G3: answer parsing and scoring (exact, set F1, LCS ratio); describe('scoring')
  CHECK: bun test bench/test/agent.test.ts -t scoring
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 42 expect() calls | Ran 9 tests across 1 file. [483.00ms]

- [x] G4: runner parses a canned envelope from a fake claude binary; describe('fake claude')
  CHECK: bun test bench/test/agent.test.ts -t "fake claude"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 117 expect() calls | Ran 7 tests across 1 file. [2.43s]

- [x] G5: agent --fixture --dry-run produces the results shape with zero runs
  CHECK: bun run bench:agent --fixture --dry-run
  EXPECT: agent: dry-run ok
  EVIDENCE: $ bun bench/src/cli.ts agent --fixture --dry-run | truth-ts: 12 files, 0 tsconfig errors (semantic diagnostics off: --diagnostics or GREPLOST_BENCH_DIAGNOSTICS=1 to check them)

- [x] G6: curated flow tasks exist for hono and anyq with truth_source
  CHECK: node -e "for (const r of ['hono','anyq']) { const t=JSON.parse(require('fs').readFileSync('bench/tasks/'+r+'-flow.json','utf8')); if(!t.length||t.some(x=>!x.truth_source)) throw new Error(r) } console.log('flow tasks ok')"
  EXPECT: flow tasks ok
  EVIDENCE: flow tasks ok

- [x] G7: leaf files typecheck
  CHECK: bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: (no output)

