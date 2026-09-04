# Gates: 2.2.3 actions

Scope: GitHub Actions extraction (`job`, `step` and `task` nodes with index-suffixed step names),
the three Actions reference kinds (`needs`, `uses`, `config`), the `fixtures/tiny-actions`
fixture, and the independent workflow oracle with a corpus gate on `starter-workflows`.
Spec: `docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 2.1, 2.4, 2.6
and 5.1.

- [ ] G1: the Actions extraction test file passes
  CHECK: bun test packages/core/test/extract-yaml-actions.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G2: every `jobs.<id>` becomes a `job` node in document order; describe('jobs')
  CHECK: bun test packages/core/test/extract-yaml-actions.test.ts -t jobs 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G3: step nodes are named `<jobId>.#<index>` from a 0-based position, with `meta.uses` or `meta.run`; describe('steps')
  CHECK: bun test packages/core/test/extract-yaml-actions.test.ts -t steps 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G4: `needs` is a high-confidence edge to the named job's node; describe('needs')
  CHECK: bun test packages/core/test/extract-yaml-actions.test.ts -t needs 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G5: a step `uses` resolves to `ext:action/<owner>/<repo>@<ref>`, a local action file or a reusable workflow file; describe('uses')
  CHECK: bun test packages/core/test/extract-yaml-actions.test.ts -t uses 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G6: a `run` body naming exactly one repo path links to it, and an ambiguous token is dropped; describe('run scripts')
  CHECK: bun test packages/core/test/extract-yaml-actions.test.ts -t "run scripts" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G7: the fixture builds with the expected node set and all three refKinds; describe('tiny-actions')
  CHECK: bun test packages/core/test/extract-yaml-actions.test.ts -t tiny-actions 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G8: the Actions truth generator test file passes
  CHECK: bun test bench/test/truth-yaml-actions.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G9: the oracle shares no code with `packages/core` and its output tracks the fixture; describe('oracle independence')
  CHECK: bun test bench/test/truth-yaml-actions.test.ts -t "oracle independence" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G10: S1 to S5 pass on the fixture
  CHECK: bun run bench:structural --fixture tiny-actions --lang yaml --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] G11: S1 to S5 pass on the pinned corpus repo (starter-workflows, whole repo, 187 workflow `.yml`)
  CHECK: bun bench/src/cli.ts corpus setup --repo starter-workflows >/dev/null && bun run bench:structural --repo starter-workflows --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] G12: the core and bench suites are green
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G13: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
