# Gates: 1.3 sync (integration)

Scope: children merged; freshness and performance targets hold

- [x] N1: every child gates file is fully met
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status gates/leaf-1.3.1.md gates/leaf-1.3.2.md
  EXPECT: ALL MET
  EVIDENCE: gates/leaf-1.3.2.md: 11 gates | ALL MET (19 met)

- [x] N2: sync typechecks
  CHECK: bunx tsc -p packages/sync/tsconfig.json --noEmit
  EVIDENCE: (no output)

- [x] N3: sync tests green
  CHECK: bun test packages/sync
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 690 expect() calls | Ran 137 tests across 5 files. [4.30s]

- [x] N4: F1 = 100 percent and F2 = 0 over a 100-commit replay of hono
  CHECK: bun run bench:replay --repo hono --commits 100 --gate
  EXPECT: replay: GATE PASS
  EVIDENCE: replay: GATE PASS | $ bun bench/src/cli.ts replay --repo hono --commits "100" --gate

- [x] N5: P1 and P2 within targets on tier S
  CHECK: bun run bench:perf --tier S --gate
  EXPECT: perf: GATE PASS
  EVIDENCE: perf: GATE PASS | $ bun bench/src/cli.ts perf --tier S --gate

