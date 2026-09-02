# Gates: 1.1 core-extract (integration)

Scope: children 1.1.1 to 1.1.5 merged into a working structure layer

- [x] N1: every child gates file is fully met
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status gates/leaf-1.1.1.md gates/leaf-1.1.2.md gates/leaf-1.1.3.md gates/leaf-1.1.4.md gates/leaf-1.1.5.md
  EXPECT: ALL MET
  EVIDENCE: gates/leaf-1.1.5.md: 10 gates | ALL MET (49 met)

- [x] N2: core typechecks as one package
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit
  EVIDENCE: (no output)

- [x] N3: core test suite green
  CHECK: bun test packages/core
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 910 expect() calls | Ran 330 tests across 8 files. [932.00ms]

- [x] N4: S1 to S4 hold on fixtures/tiny-ts against tsc truth
  CHECK: bun run bench:structural --fixture --gate
  EXPECT: structural: GATE PASS
  EVIDENCE: $ bun bench/src/cli.ts structural --fixture --gate | truth-ts: 12 files, 0 tsconfig errors (semantic diagnostics off: --diagnostics or GREPLOST_BENCH_DIAGNOSTICS=1 to check them)

- [x] N5: S1 to S4 hold on tier S (anyq) against tsc truth
  CHECK: bun run bench:structural --repo anyq --gate
  EXPECT: structural: GATE PASS
  EVIDENCE: $ bun bench/src/cli.ts structural --repo anyq --gate | truth-ts: 148 files, 0 tsconfig errors (semantic diagnostics off: --diagnostics or GREPLOST_BENCH_DIAGNOSTICS=1 to check them)

