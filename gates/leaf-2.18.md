# Gates: 2.18 perf-ratio

Scope: build 2.2, ruling 14 of 2026-09-10, closing sns45/greplost issue 14. P1 and P2 are wall
clock, so the perf gate used to be either a false failure on a shared runner or, since build 2.1,
a step marked `continue-on-error` off the nightly schedule. Every perf run now measures the
machine first, in the same process and before the timed scenarios: three builds of
`fixtures/tiny-ts` through the same child process the scenarios are measured in, median against
`RUNNER_REFERENCE_MS`, a constant recorded in `bench/src/perf.ts` from this machine on this day.
The absolute budgets are multiplied by `max(1, median / reference)`, the gate compares against the
scaled budget, and the printed report and the JSON payload both carry the raw budget, the factor,
the reference, the scaled budget and the measurement, so a slow runner is visible rather than
hidden. A factor above 4 fails the run as `GATE FAIL (runner)` on its own, dropping the target and
regression comparisons, because a machine that slow says nothing about greplost. Both CI perf
steps gate on every event again.

Two things go beyond the letter of ruling 14, both because the gate could not otherwise pass on a
machine that is doing anything else. The 15 percent regression rule now divides both p50s by the
runner factor of the run they came from: one CPU is not one speed, and the same laptop measured
beside an IDE holding twelve of its sixteen cores is nearly three times slower than itself, which
the rule read as a greplost regression. And the Bench 3 section of RESULTS.md merges every perf
payload the index pins, because one perf run measures one repo and two runs on one day at one
commit write the same file name, so anyq and gin arrive as two payloads and pinning both is the
only way to keep the ten scenario rows the document had.

Files: `bench/src/perf.ts`, `bench/test/perf.test.ts`, `bench/src/report-evals.ts` (the perf
section only), `bench/src/report.ts` (the perf payloads it hands that section),
`.github/workflows/ci.yml` (the two perf steps), `bench/RESULTS.md` and `README.md` (regenerated),
`bench/results/INDEX.json` and the two perf payloads it pins.

Spec: PLAN.md "Build 2.2", ruling 14 of 2026-09-10.

Recorded exceptions to the 500-line rule: `bench/src/perf.ts` is over 500 lines (866 before this
leaf, and the module documents the whole suite: the scenarios, which statistic gates what, the
regression rule and now the runner factor, none of which reads better split across files).

- [ ] G1: the perf suite's own tests pass
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n^ 0 fail$/m
  EVIDENCE: pending

- [ ] G2: the factor is 1 when the runner is at or faster than the reference, and the ratio when it is slower; -t "the factor is"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts -t "the factor is" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: pending

- [ ] G3: the budgets scale by the factor, and the scaled budget is what the absolute targets are gated against; -t "scaled budget"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts -t "scaled budget" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: pending

- [ ] G4: a factor above the cap fails on its own, whatever the scaled budgets and the regression rule say; -t "above the cap"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts -t "above the cap" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: pending

- [ ] G5: the printed report carries the raw budget, the factor, the reference, the scaled budget and the measurement; -t "the report prints"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts -t "the report prints" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: pending

- [ ] G6: the written payload carries the runner block, the raw targets and the scaled targets; -t "writes a result"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts -t "writes a result" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: pending

- [ ] G7: the factor a real fixture run measures is the factor its median and the reference produce; -t "reports p50, p95 and peak RSS"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts -t "reports p50, p95 and peak RSS" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: pending

- [ ] G8: RESULTS.md's perf section states the scaling rule, through its generator; -t "RESULTS.md states"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts -t "RESULTS.md states" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: pending

- [ ] G8b: the regression rule compares machine equivalent p50s, both sides divided by the factor of the run they came from; -t "machine equivalent"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts -t "machine equivalent" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: pending

- [ ] G8c: the Bench 3 section merges every pinned perf payload, newest first; -t "merges the payloads"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts -t "merges the payloads" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: pending

- [ ] G9: the whole bench suite is green
  CHECK: FORCE_COLOR=0 bun test bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n^ 0 fail$/m
  EVIDENCE: pending

- [ ] G10: every workspace typechecks
  CHECK: FORCE_COLOR=0 bun run typecheck 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^== scripts$/m
  EVIDENCE: pending

- [ ] G11: the anyq perf gate prints the factor, the reference and the scaled budget, and passes
  CHECK: FORCE_COLOR=0 bun run bench:perf --repo anyq --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -E "runner factor|raw 1000ms|GATE"
  EXPECT: /^perf: runner factor \d+\.\d\d \(median \d+ms over 3 builds of fixtures\/tiny-ts, reference \d+ms, budgets scale by max\(1, median \/ reference\), fail above 4\.00\)$\n.*raw 1000ms x \d+\.\d\d.*$\n^perf: GATE PASS$/m
  EVIDENCE: pending

- [ ] G12: the gin perf gate does the same
  CHECK: FORCE_COLOR=0 bun run bench:perf --repo gin --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -E "runner factor|raw 1000ms|GATE"
  EXPECT: /^perf: runner factor \d+\.\d\d \(median \d+ms over 3 builds of fixtures\/tiny-ts, reference \d+ms, budgets scale by max\(1, median \/ reference\), fail above 4\.00\)$\n.*raw 1000ms x \d+\.\d\d.*$\n^perf: GATE PASS$/m
  EVIDENCE: pending

- [ ] G13: both CI perf steps gate on every event, and the workflow still parses
  CHECK: python3 -c "import yaml; d = yaml.safe_load(open('.github/workflows/ci.yml')); s = [x for x in d['jobs']['test']['steps'] if 'performance gate' in x.get('name', '')]; print('perf steps', len(s), 'advisory', sum(1 for x in s if 'continue-on-error' in x))"
  EXPECT: /^perf steps 2 advisory 0$/m
  EVIDENCE: pending

- [ ] G14: RESULTS.md's perf section states the rule in one sentence
  CHECK: grep -c -F "multiplies the budgets in this table by" bench/RESULTS.md
  EXPECT: /^1$/m
  EVIDENCE: pending

- [ ] G15: regenerating the report twice leaves RESULTS.md, INDEX.json and README.md byte identical to what is committed
  CHECK: FORCE_COLOR=0 bun run bench:report >/dev/null 2>&1; FORCE_COLOR=0 bun run bench:report >/dev/null 2>&1; FORCE_COLOR=0 bun run readme:sync >/dev/null 2>&1; echo "dirty=$(git status --porcelain bench/RESULTS.md bench/results/INDEX.json README.md | wc -l | tr -d ' ')"
  EXPECT: /^dirty=0$/m
  EVIDENCE: pending

- [ ] G16: README's generated tables still match RESULTS.md
  CHECK: FORCE_COLOR=0 bun run readme:check 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^sync-readme: README.md up to date$/m
  EVIDENCE: pending

- [ ] G17: both perf payloads pinned in INDEX.json carry the runner block, the raw budgets and the scaled budgets
  CHECK: python3 -c "import json; i = json.load(open('bench/results/INDEX.json')); [print('pinned', f, 'factor', d['runner']['factor'], 'reference', d['runner']['referenceMs'], 'measured', round(d['runner']['measuredMs']), 'raw', sorted(d['targets']), 'scaled', sorted(d['scaledTargets']), 'cap', d['maxRunnerFactor']) for f in i['payloads']['perf'] for d in [json.load(open('bench/results/' + f))]]"
  EXPECT: /^pinned perf-\d{4}-\d{2}-\d{2}-[0-9a-f]{7}\.json factor \d+(\.\d+)? reference \d+ measured \d+ raw \['anyq'\] scaled \['anyq'\] cap 4$\n^pinned perf-\d{4}-\d{2}-\d{2}-[0-9a-f]{7}\.json factor \d+(\.\d+)? reference \d+ measured \d+ raw \['gin'\] scaled \['gin'\] cap 4$/m
  EVIDENCE: pending

- [ ] G18: the test file this leaf wrote is under 500 lines, `perf.ts` excepted above
  CHECK: wc -l < bench/test/perf.test.ts | awk '{print ($1 < 500) ? "under 500" : "OVER 500"}'
  EXPECT: /^under 500$/m
  EVIDENCE: pending

- [ ] G19: no NUL byte and no long dash reached any file this leaf wrote
  CHECK: perl -CSD -ne 'exit 1 if /[\x{0}\x{2013}\x{2014}]/' bench/src/perf.ts bench/test/perf.test.ts bench/src/report-evals.ts .github/workflows/ci.yml gates/leaf-2.18.md && echo "no NUL and no long dash in 5 files"
  EXPECT: /^no NUL and no long dash in 5 files$/m
  EVIDENCE: pending
