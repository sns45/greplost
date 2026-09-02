# Gates: 1.4 plugin-cli (integration)

Scope: CLI and plugin merged

- [x] N1: every child gates file is fully met
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status gates/leaf-1.4.1.md gates/leaf-1.4.2.md
  EXPECT: ALL MET
  EVIDENCE: gates/leaf-1.4.2.md: 7 gates | ALL MET (17 met)

- [x] N2: cli typechecks
  CHECK: bunx tsc -p packages/cli/tsconfig.json --noEmit
  EVIDENCE: (no output)

- [x] N3: cli tests green
  CHECK: bun test packages/cli
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 353 expect() calls | Ran 72 tests across 3 files. [597.00ms]

- [ ] N4: greplost verifies its own committed map (dogfood)
  CHECK: bun packages/cli/src/main.ts verify --diff
  EXPECT: /verify: ok/
  EVIDENCE: pending

