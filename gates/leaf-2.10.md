# Gates: 2.2.4 dockerfile

Scope: Dockerfile extraction (`stage` and `image` nodes, `ARG`/`ENV` constants, named and
unnamed stage ids), Dockerfile resolution and the three Dockerfile reference kinds
(`from-image`, `copy-from`, `config`), the `fixtures/tiny-docker` fixture, and the independent
`dockerfile-ast` oracle with corpus gates on `docker-python` and `docker-node`.
Spec: `docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 2.1, 2.5, 2.6
and 5.1.

- [ ] G1: the Dockerfile extraction test file passes
  CHECK: bun test packages/core/test/extract-dockerfile.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G2: named and unnamed stages both get stable ids with `meta.index`; describe('stages')
  CHECK: bun test packages/core/test/extract-dockerfile.test.ts -t stages 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G3: an external base image resolves to `ext:image/<ref>` and a sibling stage does not; describe('base images')
  CHECK: bun test packages/core/test/extract-dockerfile.test.ts -t "base images" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G4: `COPY --from=<stage>` is a high-confidence edge to the named stage node; describe('copy from')
  CHECK: bun test packages/core/test/extract-dockerfile.test.ts -t "copy from" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G5: top-level `ARG` and `ENV` become `arg.<N>` and `env.<N>` constants with literal defaults; describe('args')
  CHECK: bun test packages/core/test/extract-dockerfile.test.ts -t args 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G6: the fixture builds with the expected stages, the final image node and every refKind; describe('tiny-docker')
  CHECK: bun test packages/core/test/extract-dockerfile.test.ts -t tiny-docker 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G7: the Dockerfile truth generator test file passes
  CHECK: bun test bench/test/truth-dockerfile.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G8: the oracle shares no code with `packages/core` and its output tracks the fixture; describe('oracle independence')
  CHECK: bun test bench/test/truth-dockerfile.test.ts -t "oracle independence" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G9: S1 to S5 pass on the fixture
  CHECK: bun run bench:structural --fixture tiny-docker --lang dockerfile --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] G10: S1 to S5 pass on the first pinned corpus repo (docker-python, whole repo, 44 Dockerfiles)
  CHECK: bun bench/src/cli.ts corpus setup --repo docker-python >/dev/null && bun run bench:structural --repo docker-python --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] G11: S1 to S5 pass on the second pinned corpus repo (docker-node, whole repo, 21 Dockerfiles)
  CHECK: bun bench/src/cli.ts corpus setup --repo docker-node >/dev/null && bun run bench:structural --repo docker-node --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] G12: the core and bench suites are green
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G13: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
