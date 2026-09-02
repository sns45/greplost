# Gates: 1.5.7 bench headtohead-report

Scope: X1 to X10 orchestration, RESULTS.md generation, charts, screenshots (spec: bench 1.5.7)

- [ ] G1: report test file passes
  CHECK: bun test bench/test/report.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G2: charts render a fixed dataset to a golden SVG and a non-empty PNG; describe('charts')
  CHECK: bun test bench/test/report.test.ts -t charts
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G3: report --dry-run writes RESULTS.md
  CHECK: bun run bench:report --dry-run
  EXPECT: report: wrote bench/RESULTS.md
  EVIDENCE: pending

- [ ] G4: RESULTS.md carries all ten head-to-head rows
  CHECK: grep -c -E '^\| X(10|[1-9]) ' bench/RESULTS.md
  EXPECT: 10
  EVIDENCE: pending

- [ ] G5: RESULTS.md carries every 10.9 section
  CHECK: grep -c -E '^## (Machine|Corpus|Versions|Head-to-head|Eval 1|Eval 2|Bench 3|Eval 4|Eval 5|Map quality)' bench/RESULTS.md
  EXPECT: 10
  EVIDENCE: pending

- [ ] G6: headtohead --fixture --dry-run produces the results shape
  CHECK: bun run bench:headtohead --fixture --dry-run
  EXPECT: headtohead: dry-run ok
  EVIDENCE: pending

- [ ] G7: screenshots --check reports tool availability without failing
  CHECK: bun bench/src/cli.ts screenshots --check
  EXPECT: /screenshots: \d+ available, \d+ missing/
  EVIDENCE: pending

- [ ] G8: vhs tapes for captures 1 and 5 exist
  CHECK: ls docs/tapes | sort | tr '\n' ' '
  EXPECT: /init\.tape.*side-by-side/
  EVIDENCE: pending

- [ ] G9: leaf files typecheck
  CHECK: bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: pending

