# Gates: 1.2 render (integration)

Scope: children 1.2.1 and 1.2.2 merged; artifacts render on GitHub

- [x] N1: every child gates file is fully met
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status gates/leaf-1.2.1.md gates/leaf-1.2.2.md
  EXPECT: ALL MET
  EVIDENCE: gates/leaf-1.2.2.md: 10 gates | ALL MET (19 met)

- [x] N2: render typechecks
  CHECK: bunx tsc -p packages/render/tsconfig.json --noEmit
  EVIDENCE: (no output)

- [x] N3: render tests green
  CHECK: bun test packages/render
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 8798 expect() calls | Ran 100 tests across 2 files. [143.00ms]

- [x] N4: M1, M2 and the Mermaid parse check hold on the golden render
  CHECK: bun run bench:mapquality --dir packages/render/test/golden/tiny-ts --gate
  EXPECT: mapquality: GATE PASS
  EVIDENCE: mapquality: GATE PASS | $ bun bench/src/cli.ts mapquality --dir packages/render/test/golden/tiny-ts --gate

