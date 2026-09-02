# Gates: 1.5.6 bench agent

Scope: task generation, headless Claude Code runner, deterministic scoring (spec: bench 1.5.6)

- [ ] G1: agent test file passes
  CHECK: bun test bench/test/agent.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G2: generateStructuralTasks builds stable ids and truths from fixture truth; describe('tasks')
  CHECK: bun test bench/test/agent.test.ts -t tasks
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G3: answer parsing and scoring (exact, set F1, LCS ratio); describe('scoring')
  CHECK: bun test bench/test/agent.test.ts -t scoring
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G4: runner parses a canned envelope from a fake claude binary; describe('fake claude')
  CHECK: bun test bench/test/agent.test.ts -t "fake claude"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G5: agent --fixture --dry-run produces the results shape with zero runs
  CHECK: bun run bench:agent --fixture --dry-run
  EXPECT: agent: dry-run ok
  EVIDENCE: pending

- [ ] G6: curated flow tasks exist for hono and anyq with truth_source
  CHECK: node -e "for (const r of ['hono','anyq']) { const t=JSON.parse(require('fs').readFileSync('bench/tasks/'+r+'-flow.json','utf8')); if(!t.length||t.some(x=>!x.truth_source)) throw new Error(r) } console.log('flow tasks ok')"
  EXPECT: flow tasks ok
  EVIDENCE: pending

- [ ] G7: leaf files typecheck
  CHECK: bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: pending

