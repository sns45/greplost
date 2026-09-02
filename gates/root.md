# Gates: greplost (root)

Scope: the complete deliverable: tool, plugin, benchmark harness with measured results, screenshots

- [ ] T1: every branch gates file is fully met
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status gates/node-1.1.md gates/node-1.2.md gates/node-1.3.md gates/node-1.4.md gates/node-1.5.md gates/leaf-1.6.md gates/leaf-1.7.md gates/leaf-1.8.md gates/node-1.9.md
  EXPECT: ALL MET
  EVIDENCE: pending

- [ ] T2: full suite green from a clean install
  CHECK: bun install --frozen-lockfile >/dev/null && bun test
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] T3: README shows numbers only with a link to RESULTS.md
  CHECK: grep -c 'bench/RESULTS.md' README.md
  EXPECT: /^[1-9]/
  EVIDENCE: pending

- [ ] T4: final report re-measures every number it states and pastes this ledger with N of N
  EVIDENCE: pending

