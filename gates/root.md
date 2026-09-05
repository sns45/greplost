# Gates: greplost (root)

Scope: the complete deliverable: tool, plugin, benchmark harness with measured results, screenshots

- [x] T1: every branch gates file is fully met
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status gates/node-1.1.md gates/node-1.2.md gates/node-1.3.md gates/node-1.4.md gates/node-1.5.md gates/leaf-1.6.md gates/leaf-1.7.md gates/leaf-1.8.md gates/node-1.9.md
  EXPECT: ALL MET
  EVIDENCE: gates/node-1.9.md: 13 gates | ALL MET (55 met)

- [x] T2: full suite green from a clean install
  CHECK: bun install --frozen-lockfile >/dev/null && bun test 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 14058 expect() calls | Ran 1238 tests across 36 files. [56.99s]

- [x] T3: README shows numbers only with a link to RESULTS.md
  CHECK: grep -c 'bench/RESULTS.md' README.md
  EXPECT: /^[1-9]/m
  EVIDENCE: 4

- [x] T4: final report re-measures every number it states and pastes this ledger with N of N
  EVIDENCE: final report written 2026-09-04 at HEAD 0d7b22b (scratchpad reports/final-report-2026-09-04.md and the closing chat message): re-measured tests 1296 pass  0 fail; typecheck errors 0; own map in sync; ledger 216 of 216 boxes checked with this one

