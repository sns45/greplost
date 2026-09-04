# Gates: 2.3.2 signals-pulumi-go

Scope: the `pulumi-go` signal pass (resource nodes from `<pkg>.New<Type>(ctx, "<name>",
&<pkg>.<Type>Args{...})` calls whose package alias is a pinned Pulumi provider import, the
`meta.type` token, and `resource-input` reference edges between resources in one file), the
`fixtures/tiny-pulumi-go` fixture, and the independent `go/types` oracle that decides
resourceness with `types.Implements` against `pulumi.Resource`.
Spec: `docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 3.1, 3.6,
3.7, 3.8.

- [ ] G1: the Pulumi Go signal test file passes
  CHECK: bun test packages/core/test/signals-pulumi-go.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G2: a `NewX` call through a Pulumi provider import becomes a `resource.<varName>` node with the right type token, and a `NewX` from a non-Pulumi package does not; describe('pulumi go resources')
  CHECK: bun test packages/core/test/signals-pulumi-go.test.ts -t "pulumi go resources" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G3: an `Args` field reading another resource variable's field or method is a `resource-input` reference, and an ambiguous one is dropped; describe('resource inputs')
  CHECK: bun test packages/core/test/signals-pulumi-go.test.ts -t "resource inputs" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G4: the fixture yields the two resource nodes, the one `resource-input` edge and nothing for the decoy; describe('tiny-pulumi-go')
  CHECK: bun test packages/core/test/signals-pulumi-go.test.ts -t tiny-pulumi-go 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G5: the truth generator test file passes
  CHECK: bun test bench/test/signals-pulumi-go.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G6: the oracle finds resources by `types.Implements(t, pulumi.Resource)`, never by name, and attributes them per file through the `token.FileSet`; describe('go types oracle')
  CHECK: bun test bench/test/signals-pulumi-go.test.ts -t "go types oracle" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G7: the oracle imports nothing from greplost and its output changes when the fixture changes; describe('oracle independence')
  CHECK: bun test bench/test/signals-pulumi-go.test.ts -t "oracle independence" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G8: S5 and S6 pass on the fixture
  CHECK: bun run bench:structural --fixture tiny-pulumi-go --lang go --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] G9: S5 and S6 pass on the pinned corpus repo (pulumi-go, subset `*-go-*/`, 85 files)
  CHECK: bun bench/src/cli.ts corpus setup --repo pulumi-go >/dev/null && bun run bench:structural --repo pulumi-go --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] G10: the core and bench suites are green, and the existing Go language numbers are unchanged
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G11: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
