# Gates: 1.5.7 bench headtohead-report

Scope: X1 to X10 orchestration, RESULTS.md generation, charts, screenshots (spec: bench 1.5.7)

- [x] G1: report test file passes
  CHECK: bun test bench/test/report.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 345 expect() calls | Ran 38 tests across 1 file. [1279.00ms]

- [x] G2: charts render a fixed dataset to a golden SVG and a non-empty PNG; describe('charts')
  CHECK: bun test bench/test/report.test.ts -t charts
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 46 expect() calls | Ran 11 tests across 1 file. [942.00ms]

- [x] G3: report --dry-run writes RESULTS.md
  CHECK: bun run bench:report --dry-run
  EXPECT: report: wrote bench/RESULTS.md
  EVIDENCE: report: wrote bench/RESULTS.md | $ bun bench/src/cli.ts report --dry-run

- [x] G4: RESULTS.md carries all ten head-to-head rows
  CHECK: grep -c -E '^\| X(10|[1-9]) ' bench/RESULTS.md
  EXPECT: 10
  EVIDENCE: 10

- [x] G5: RESULTS.md carries every 10.9 section
  CHECK: grep -c -E '^## (Machine|Corpus|Versions|Head-to-head|Eval 1|Eval 2|Bench 3|Eval 4|Eval 5|Map quality)' bench/RESULTS.md
  EXPECT: 10
  EVIDENCE: 10

- [x] G6: headtohead --fixture --dry-run produces the results shape
  CHECK: bun run bench:headtohead --fixture --dry-run
  EXPECT: headtohead: dry-run ok
  EVIDENCE: headtohead: dry-run ok | $ bun bench/src/cli.ts headtohead --fixture --dry-run

- [x] G7: screenshots --check reports tool availability without failing
  CHECK: bun bench/src/cli.ts screenshots --check
  EXPECT: /screenshots: \d+ available, \d+ missing/
  EVIDENCE: playwright (chromium): missing — install with `bunx playwright install chromium` [the playwright package is installed but its chromium build is not at /Users/shantanu/Library/Caches/ms-playwright/chro

- [x] G8: vhs tapes for captures 1 and 5 exist
  CHECK: ls docs/tapes | sort | tr '\n' ' '
  EXPECT: /init\.tape.*side-by-side/
  EVIDENCE: init.tape side-by-side-baseline.tape side-by-side-greplost.tape

- [x] G9: leaf files typecheck
  CHECK: bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: (no output)

- [x] G10: RESULTS.md carries the two sections scripts/sync-readme.ts copies, once each
  CHECK: grep -c -E '^## (Head-to-head|Single-tool)$' bench/RESULTS.md
  EXPECT: 2
  EVIDENCE: 2

- [x] G11: the hero chart is at the path the node gate checks
  CHECK: test -s docs/assets/x2-staleness.png && echo hero-ok
  EXPECT: hero-ok
  EVIDENCE: hero-ok

- [x] G12: the Single-tool table carries every section 3 id
  CHECK: sed -n '/^## Single-tool$/,/^## Eval 1$/p' bench/RESULTS.md | grep -c -E '^\| (S[1-4]|F[12]|P[1-3]|M[12]|A[1-4]|unparsable) '
  EXPECT: 16
  EVIDENCE: 16
