# Gates: 1.5 bench (integration)

Scope: harness complete: every suite runs, RESULTS.md generated end to end

- [ ] N1: every child gates file is fully met
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status gates/leaf-1.5.1.md gates/leaf-1.5.2.md gates/leaf-1.5.3.md gates/leaf-1.5.4.md gates/leaf-1.5.5.md gates/leaf-1.5.6.md gates/leaf-1.5.7.md
  EXPECT: ALL MET
  EVIDENCE: pending

- [ ] N2: bench typechecks
  CHECK: bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: pending

- [ ] N3: bench tests green
  CHECK: bun test bench
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] N4: bench all --dry-run runs every suite and regenerates RESULTS.md
  CHECK: bun run bench:all --dry-run
  EXPECT: report: wrote bench/RESULTS.md
  EVIDENCE: pending

