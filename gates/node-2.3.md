# Gates: 2.3 signals (integration)

Scope: leaves 2.3.1 signals-ts (React, TanStack Start, Next.js, Pulumi TypeScript) and 2.3.2
signals-pulumi-go merged into one framework signal layer. Spec sections 3.1 to 3.8. The layer's
defining property is that it adds nodes without changing a single byte the language extractor
produced, and N4 is the gate that proves it.

- [ ] N1: every child gates file is fully met
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status gates/leaf-2.3.md gates/leaf-2.7.md
  EXPECT: ALL MET

- [ ] N2: core typechecks as one package
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit

- [ ] N3: the core test suite is green with all five passes present
  CHECK: bun test packages/core 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] N4: the signal layer adds nodes and changes nothing else; describe('no nodes no change')
  CHECK: bun test packages/render/test/nodes.test.ts -t "no nodes no change" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] N5: passes run in id order and their output is order-independent; describe('pass ordering')
  CHECK: bun test packages/core/test/signals-ts.test.ts -t "pass ordering" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] N6: S6 (signal-node precision) holds on both fixtures
  CHECK: for f in tiny-signals-ts:tsx tiny-pulumi-go:go; do bun run bench:structural --fixture "${f%%:*}" --lang "${f##*:}" --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -q 'structural: GATE PASS' || { echo "FAIL ${f%%:*}"; exit 1; }; done; echo "fixtures: 2 of 2 PASS"
  EXPECT: fixtures: 2 of 2 PASS

- [ ] N7: S6 holds on every pinned signals corpus repo
  CHECK: for r in pulumi-ts pulumi-go tanstack-start next-app; do bun run bench:structural --repo "$r" --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -q 'structural: GATE PASS' || { echo "FAIL $r"; exit 1; }; done; echo "corpora: 4 of 4 PASS"
  EXPECT: corpora: 4 of 4 PASS

- [ ] N8: turning the layer off restores the build-1 output exactly
  CHECK: bun test packages/core/test/signals-ts.test.ts -t "signals disabled" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
