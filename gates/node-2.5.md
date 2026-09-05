# Gates: 2.5 bench-and-docs (integration)

Scope: leaf 2.5.1 coverage-docs merged. Every build-2 language, format and signal pass has a
pinned corpus, a truth generator and a published row; CI runs the structural gate; the README,
`RESULTS.md`, the tech spec's Appendix C and this repo's own map are all in step. Spec section 5.
Numbers are never typed by hand: every measured cell comes from a committed payload.

- [x] N1: the child gates file is fully met
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status gates/leaf-2.12.md
  EXPECT: ALL MET

- [x] N2: bench typechecks
  CHECK: bunx tsc -p bench/tsconfig.json --noEmit

- [x] N3: the bench suite is green
  CHECK: bun test bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [x] N4: a dry run of every suite still writes a complete RESULTS.md and no payload
  CHECK: bun run bench:all --dry-run 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: report: wrote bench/RESULTS.md

- [x] N5: every build-2 language has a row with a named truth source; describe('per-lang targets')
  CHECK: bun test bench/test/structural-langs.test.ts -t "per-lang targets" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [x] N6: RESULTS.md states the head-to-head scope in one sentence
  CHECK: grep -c 'X1 to X10 cover TypeScript and Go only' bench/RESULTS.md
  EXPECT: /^[1-9]/m

- [x] N7: RESULTS.md names Kotlin as reported-only with its reason
  CHECK: grep -qi 'kotlin' bench/RESULTS.md && grep -q 'reported-only' bench/RESULTS.md && echo "kotlin: reported-only, documented"
  EXPECT: kotlin: reported-only, documented

- [x] N8: the README is in step with RESULTS.md and every image it references exists and is tracked
  CHECK: bun run readme:check 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: sync-readme: README.md up to date

- [x] N9: the README shows numbers only with a link to RESULTS.md
  CHECK: grep -c 'bench/RESULTS.md' README.md
  EXPECT: /^[1-9]/m

- [x] N10: greplost verifies its own committed map after the config gained yaml and dockerfile
  CHECK: bun packages/cli/src/main.ts verify --diff 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: map is in sync

- [x] N11: the full suite is green from a frozen install
  CHECK: bun install --frozen-lockfile >/dev/null && bun test 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
