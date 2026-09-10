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
hidden. A factor above `MAX_RUNNER_FACTOR` fails the run as `GATE FAIL (runner)` on its own, and
that run says nothing else at all: no target verdict, no p50 comparison, no baseline written,
because a machine that slow says nothing about greplost. Both CI perf steps gate on every event
again.

Three things go beyond the letter of ruling 14, which wrote the cap at 4.

1. **The cap is 8** (ruling of 2026-09-10, on review of this leaf). The reference is measured on
   an idle machine's performance cores, the same machine's efficiency cores read 5.12, and
   `ubuntu-latest` is a four vCPU virtual machine, so 4 would fail honest runners for being
   ordinary rather than for being unmeasurable. The first factor CI prints decides whether it
   moves again, and every run prints it.
2. **The regression rule is measured in machine equivalents, per repo.** Both p50s are divided by
   the runner factor of the run they came from, because one CPU is not one speed: the same laptop
   measured beside an IDE holding twelve of its sixteen cores is nearly three times slower than
   itself, which the rule read as a greplost regression. And each repo takes its baseline from the
   newest payload `INDEX.json` pins that measured *that repo*, because one perf run measures one
   repo, so the single newest result is usually the other repo's and comparing against it wrote an
   empty regression list that read like a clean verdict. A repo nothing has measured now reports
   `compared: false` and prints `no prior measurement for <repo>`. Pinned rather than newest on
   disk, so re-pinning is the deliberate act that re-baselines.
3. **The Bench 3 section merges every pinned perf payload**, because one run measures one repo and
   two runs on one day at one commit write the same file name, so anyq and gin arrive as two
   payloads and pinning both is the only way to keep the ten scenario rows the document had.

The scaling rule is stated in the single-tool notes, which is the table `readme:sync` copies into
README.md, so the rule travels with the P1 and P2 rows a reader actually sees.

Files: `bench/src/perf.ts`, `bench/test/perf.test.ts` and `bench/test/perf-report.test.ts`, `bench/src/report-evals.ts` and
`bench/src/report-sections.ts` (the perf section and the perf note only), `bench/src/report.ts`
(the perf payloads it hands that section), `.github/workflows/ci.yml` (the two perf steps),
`bench/RESULTS.md` and `README.md` (regenerated), `bench/results/INDEX.json` and the two perf
payloads it pins.

Spec: PLAN.md "Build 2.2", ruling 14 of 2026-09-10, and the cap ruling of 2026-09-10 on review.

Recorded exceptions to the 500-line rule: `bench/src/perf.ts` is over 500 lines (866 before this
leaf, and the module documents the whole suite: the scenarios, which statistic gates what, the
regression rule and now the runner factor, none of which reads better split across files).

- [x] G1: both perf test files pass
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts bench/test/perf-report.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n^ 0 fail$/m
  EVIDENCE: 200 expect() calls | Ran 27 tests across 2 files. [9.94s]

- [x] G2: the factor is 1 when the runner is at or faster than the reference, and the ratio when it is slower; -t "the factor is"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts -t "the factor is" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: 10 expect() calls | Ran 2 tests across 1 file. [40.00ms]

- [x] G3: the budgets scale by the factor, and the scaled budget is what the absolute targets are gated against; -t "scaled budget"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts -t "scaled budget" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: 13 expect() calls | Ran 2 tests across 1 file. [39.00ms]

- [x] G4: a factor above the cap fails on its own, whatever the scaled budgets and the regression rule say; -t "above the cap"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts -t "above the cap" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: 7 expect() calls | Ran 1 test across 1 file. [36.00ms]

- [x] G5: the printed report carries the raw budget, the factor, the reference, the scaled budget and the measurement; -t "the report prints"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf-report.test.ts -t "the report prints" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: 12 expect() calls | Ran 1 test across 1 file. [38.00ms]

- [x] G6: the written payload carries the runner block, the raw targets and the scaled targets; -t "writes a result"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts -t "writes a result" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: 30 expect() calls | Ran 1 test across 1 file. [3.02s]

- [x] G7: the factor a real fixture run measures is the factor its median and the reference produce; -t "reports p50, p95 and peak RSS"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts -t "reports p50, p95 and peak RSS" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: 43 expect() calls | Ran 1 test across 1 file. [2.88s]

- [x] G8: the generator states the scaling rule beside the P1 and P2 rows README carries, and not twice; -t "RESULTS.md states"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf-report.test.ts -t "RESULTS.md states" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: 4 expect() calls | Ran 1 test across 1 file. [47.00ms]

- [x] G8b: the regression rule compares machine equivalent p50s, both sides divided by the factor of the run they came from; -t "machine equivalent"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts -t "machine equivalent" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: 6 expect() calls | Ran 1 test across 1 file. [36.00ms]

- [x] G8c: the Bench 3 section merges every pinned perf payload, newest first; -t "merges the payloads"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf-report.test.ts -t "merges the payloads" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: 9 expect() calls | Ran 1 test across 1 file. [40.00ms]

- [x] G8d: each repo's baseline is the newest pinned payload that measured that repo, and a repo nothing measured says so; -t "baseline is the newest"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts -t "baseline is the newest" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: 12 expect() calls | Ran 1 test across 1 file. [37.00ms]

- [x] G8e: past the cap there is no baseline comparison at all, so no regression line and no `baseline` in the payload; -t "past the cap"
  CHECK: FORCE_COLOR=0 bun test bench/test/perf.test.ts -t "past the cap" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n(?:^ \d+ filtered out$\n)?^ 0 fail$/m
  EVIDENCE: 8 expect() calls | Ran 2 tests across 1 file. [1486.00ms]

- [x] G9: the whole bench suite is green
  CHECK: FORCE_COLOR=0 bun test bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^ [1-9]\d* pass$\n^ 0 fail$/m
  EVIDENCE: 3879 expect() calls | Ran 667 tests across 23 files. [82.49s]

- [x] G10: every workspace typechecks
  CHECK: FORCE_COLOR=0 bun run typecheck 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^== scripts$/m
  EVIDENCE: == bench | == scripts

- [x] G11: the anyq perf gate prints the factor, the reference and the scaled budget, and passes
  CHECK: FORCE_COLOR=0 bun run bench:perf --repo anyq --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -E "runner factor|raw 1000ms|GATE"
  EXPECT: /^perf: runner factor \d+\.\d\d \(median \d+ms over 3 builds of fixtures\/tiny-ts, reference \d+ms, budgets scale by max\(1, median \/ reference\), fail above 8\.00\)$\n.*raw 1000ms x \d+\.\d\d.*$\n^perf: GATE PASS$/m
  EVIDENCE: P1  full build (p50)          <=1000ms (raw 1000ms x 1.00)  447ms | perf: GATE PASS

- [x] G12: the gin perf gate does the same
  CHECK: FORCE_COLOR=0 bun run bench:perf --repo gin --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -E "runner factor|raw 1000ms|GATE"
  EXPECT: /^perf: runner factor \d+\.\d\d \(median \d+ms over 3 builds of fixtures\/tiny-ts, reference \d+ms, budgets scale by max\(1, median \/ reference\), fail above 8\.00\)$\n.*raw 1000ms x \d+\.\d\d.*$\n^perf: GATE PASS$/m
  EVIDENCE: P1  full build (p50)          <=1000ms (raw 1000ms x 1.00)  216ms | perf: GATE PASS

- [x] G13: both CI perf steps gate on every event, and the workflow still parses
  CHECK: python3 -c "import yaml; d = yaml.safe_load(open('.github/workflows/ci.yml')); s = [x for x in d['jobs']['test']['steps'] if 'performance gate' in x.get('name', '')]; print('perf steps', len(s), 'advisory', sum(1 for x in s if 'continue-on-error' in x))"
  EXPECT: /^perf steps 2 advisory 0$/m
  EVIDENCE: perf steps 2 advisory 0

- [x] G14: the rule is stated once beside the P1 and P2 rows, in RESULTS.md and in the README those rows are synced into
  CHECK: grep -c -F "multiplies the budgets in this table by" README.md bench/RESULTS.md
  EXPECT: /^README.md:1$\n^bench\/RESULTS.md:1$/m
  EVIDENCE: README.md:1 | bench/RESULTS.md:1

- [x] G15: regenerating the report twice leaves RESULTS.md, INDEX.json and README.md byte identical to what is committed
  CHECK: FORCE_COLOR=0 bun run bench:report >/dev/null 2>&1; FORCE_COLOR=0 bun run bench:report >/dev/null 2>&1; FORCE_COLOR=0 bun run readme:sync >/dev/null 2>&1; echo "dirty=$(git status --porcelain bench/RESULTS.md bench/results/INDEX.json README.md | wc -l | tr -d ' ')"
  EXPECT: /^dirty=0$/m
  EVIDENCE: dirty=0

- [x] G16: README's generated tables still match RESULTS.md
  CHECK: FORCE_COLOR=0 bun run readme:check 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^sync-readme: README.md up to date$/m
  EVIDENCE: $ bun scripts/sync-readme.ts --check | sync-readme: README.md up to date

- [x] G17: both perf payloads pinned in INDEX.json carry the runner block, the raw budgets and the scaled budgets
  CHECK: python3 -c "import json; i = json.load(open('bench/results/INDEX.json')); [print('pinned', f, 'factor', d['runner']['factor'], 'reference', d['runner']['referenceMs'], 'measured', round(d['runner']['measuredMs']), 'raw', sorted(d['targets']), 'scaled', sorted(d['scaledTargets']), 'cap', d['maxRunnerFactor']) for f in i['payloads']['perf'] for d in [json.load(open('bench/results/' + f))]]"
  EXPECT: /^pinned perf-\d{4}-\d{2}-\d{2}-[0-9a-f]{7}\.json factor \d+(\.\d+)? reference \d+ measured \d+ raw \['anyq'\] scaled \['anyq'\] cap 8$\n^pinned perf-\d{4}-\d{2}-\d{2}-[0-9a-f]{7}\.json factor \d+(\.\d+)? reference \d+ measured \d+ raw \['gin'\] scaled \['gin'\] cap 8$/m
  EVIDENCE: pinned perf-2026-09-10-756639e.json factor 1.052 reference 135 measured 142 raw ['anyq'] scaled ['anyq'] cap 8 | pinned perf-2026-09-10-505d348.json factor 1 reference 135 measured 133 raw ['gin'] sca

- [x] G17b: every pinned payload names a baseline it was really compared against, and that file is on disk
  CHECK: python3 -c "import json, os; [print(r['repo'], 'compared', r['compared'], 'baseline', r['file'], 'onDisk', os.path.exists('bench/results/' + r['file'])) for f in json.load(open('bench/results/INDEX.json'))['payloads']['perf'] for r in json.load(open('bench/results/' + f))['baseline']['repos']]"
  EXPECT: /^anyq compared True baseline perf-\d{4}-\d{2}-\d{2}-[0-9a-f]{7}\.json onDisk True$\n^gin compared True baseline perf-\d{4}-\d{2}-\d{2}-[0-9a-f]{7}\.json onDisk True$/m
  EVIDENCE: anyq compared True baseline perf-2026-09-10-c3a74fc.json onDisk True | gin compared True baseline perf-2026-09-10-310089d.json onDisk True

- [x] G18: both test files this leaf wrote are under 500 lines, `perf.ts` excepted above
  CHECK: wc -l bench/test/perf.test.ts bench/test/perf-report.test.ts | awk '/test.ts$/ {if ($1 >= 500) bad = 1} END {print (bad ? "OVER 500" : "both under 500")}'
  EXPECT: /^both under 500$/m
  EVIDENCE: both under 500

- [x] G19: no NUL byte reached any file this leaf touched, and no long dash reached the prose it wrote
  CHECK: perl -ne 'exit 1 if /\0/' bench/src/perf.ts bench/test/perf.test.ts bench/test/perf-report.test.ts bench/src/report-evals.ts bench/src/report-sections.ts bench/src/report.ts .github/workflows/ci.yml bench/RESULTS.md README.md bench/results/INDEX.json gates/leaf-2.18.md && perl -CSD -ne 'exit 1 if /[\x{2013}\x{2014}]/' bench/src/perf.ts bench/test/perf.test.ts bench/test/perf-report.test.ts bench/src/report-evals.ts bench/src/report-sections.ts bench/src/report.ts gates/leaf-2.18.md && echo "no NUL in 11 files, no long dash in the 7 this leaf wrote"
  EXPECT: /^no NUL in 11 files, no long dash in the 7 this leaf wrote$/m
  EVIDENCE: no NUL in 11 files, no long dash in the 7 this leaf wrote
