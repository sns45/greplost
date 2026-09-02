# Gates: 1.2 render (integration)

Scope: children 1.2.1 and 1.2.2 merged; artifacts render on GitHub

- [ ] N1: every child gates file is fully met
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status gates/leaf-1.2.1.md gates/leaf-1.2.2.md
  EXPECT: ALL MET
  EVIDENCE: pending

- [ ] N2: render typechecks
  CHECK: bunx tsc -p packages/render/tsconfig.json --noEmit
  EVIDENCE: pending

- [ ] N3: render tests green
  CHECK: bun test packages/render
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] N4: M1, M2 and the Mermaid parse check hold on the golden render
  CHECK: bun run bench:mapquality --dir packages/render/test/golden/tiny-ts --gate
  EXPECT: mapquality: GATE PASS
  EVIDENCE: pending

