# Gates: 2.1 languages (integration)

Scope: leaves 2.1.1 python, 2.1.2 rust, 2.1.3 java and 2.1.4 kotlin merged into one working
structure layer. Kotlin is reported-only by the ruling in spec 1.7; its numbers are published
with their reason and are never part of a gated S1 to S3 claim here.

- [ ] N1: every child gates file is fully met
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status gates/leaf-2.1.md gates/leaf-2.4.md gates/leaf-2.5.md gates/leaf-2.6.md
  EXPECT: ALL MET

- [ ] N2: core typechecks as one package
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit

- [ ] N3: the core test suite is green with all four languages present
  CHECK: bun test packages/core 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] N4: S1 to S4 hold on every language fixture
  CHECK: for f in tiny-python:python tiny-rust:rust tiny-java:java tiny-kotlin:kotlin; do bun run bench:structural --fixture "${f%%:*}" --lang "${f##*:}" --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -q 'structural: GATE PASS' || { echo "FAIL ${f%%:*}"; exit 1; }; done; echo "fixtures: 4 of 4 PASS"
  EXPECT: fixtures: 4 of 4 PASS

- [ ] N5: S1 to S4 hold on the gated tier-S corpora (python, rust, java)
  CHECK: for r in pydantic ripgrep gson; do bun run bench:structural --repo "$r" --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -q 'structural: GATE PASS' || { echo "FAIL $r"; exit 1; }; done; echo "corpora: 3 of 3 PASS"
  EXPECT: corpora: 3 of 3 PASS

- [ ] N6: the Kotlin corpus run is deterministic and parse-healthy, and reports rather than gates S1 to S3
  CHECK: bun run bench:structural --repo coroutines --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] N7: a build of a repo in one of the four languages is byte-identical twice
  CHECK: bun test packages/core -t "order invariance" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] N8: no language changed the TypeScript or Go numbers
  CHECK: bun run bench:structural --fixture --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -q 'structural: GATE PASS' && bun run bench:structural --fixture-go --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -q 'structural: GATE PASS' && echo "ts and go: PASS"
  EXPECT: ts and go: PASS
