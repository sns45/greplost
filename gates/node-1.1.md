# Gates: 1.1 core-extract (integration)

Scope: children 1.1.1 to 1.1.5 merged into a working structure layer

- [ ] N1: every child gates file is fully met
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status gates/leaf-1.1.1.md gates/leaf-1.1.2.md gates/leaf-1.1.3.md gates/leaf-1.1.4.md gates/leaf-1.1.5.md
  EXPECT: ALL MET
  EVIDENCE: pending

- [ ] N2: core typechecks as one package
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit
  EVIDENCE: pending

- [ ] N3: core test suite green
  CHECK: bun test packages/core
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] N4: S1 to S4 hold on fixtures/tiny-ts against tsc truth
  CHECK: bun run bench:structural --fixture --gate
  EXPECT: structural: GATE PASS
  EVIDENCE: pending

- [ ] N5: S1 to S4 hold on tier S (anyq) against tsc truth
  CHECK: bun run bench:structural --repo anyq --gate
  EXPECT: structural: GATE PASS
  EVIDENCE: pending

