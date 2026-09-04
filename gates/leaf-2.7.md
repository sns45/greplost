# Gates: 2.3.2 signals-pulumi-go

Scope: the `pulumi-go` signal pass (resource nodes from `<pkg>.New<Type>(ctx, "<name>",
&<pkg>.<Type>Args{...})` calls whose package alias is a pinned Pulumi provider import, the
`meta.type` token, and `resource-input` reference edges between resources in one file), the
`fixtures/tiny-pulumi-go` fixture, and the independent `go/types` oracle that decides
resourceness with `types.Implements` against `pulumi.Resource`.
Spec: `docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 3.1, 3.6,
3.7, 3.8.

- [x] G1: the Pulumi Go signal test file passes
  CHECK: bun test packages/core/test/signals-pulumi-go.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 42 expect() calls | Ran 26 tests across 1 file. [111.00ms]

- [x] G2: a `NewX` call through a Pulumi provider import becomes a `resource.<varName>` node with the right type token, and a `NewX` from a non-Pulumi package does not; describe('pulumi go resources')
  CHECK: bun test packages/core/test/signals-pulumi-go.test.ts -t "pulumi go resources" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 12 pass, 14 filtered out | 24 expect() calls

- [x] G3: an `Args` field reading another resource variable's field or method is a `resource-input` reference, and an ambiguous one is dropped; describe('resource inputs')
  CHECK: bun test packages/core/test/signals-pulumi-go.test.ts -t "resource inputs" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 6 pass, 20 filtered out | 6 expect() calls

- [x] G4: the fixture yields the two resource nodes, the one `resource-input` edge and nothing for the decoy; describe('tiny-pulumi-go')
  CHECK: bun test packages/core/test/signals-pulumi-go.test.ts -t tiny-pulumi-go 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 8 pass, 18 filtered out | ids ["main.go#resource.bucket","main.go#resource.policy"], 1 reference, decoy silent

- [x] G5: the truth generator test file passes
  CHECK: bun test bench/test/signals-pulumi-go.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 28 expect() calls | Ran 12 tests across 1 file. [7.55s]

- [x] G6: the oracle finds resources by `types.Implements(t, pulumi.Resource)`, never by name, and attributes them per file through the `token.FileSet`; describe('go types oracle')
  CHECK: bun test bench/test/signals-pulumi-go.test.ts -t "go types oracle" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 7 pass, 5 filtered out | the only Pulumi path literal in main.go is "github.com/pulumi/pulumi/sdk/", the package that declares the interface

- [x] G7: the oracle imports nothing from greplost and its output changes when the fixture changes; describe('oracle independence')
  CHECK: bun test bench/test/signals-pulumi-go.test.ts -t "oracle independence" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 5 pass, 7 filtered out | added resource appears, removed resource disappears, a local ComponentResource is found by its method set

- [x] G8: S5 and S6 pass on the fixture
  CHECK: bun run bench:structural --fixture tiny-pulumi-go --lang go --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: S5 1.000 (tp 1, fp 0, fn 0) | S6 1.000 (tp 2, fp 0, fn 0) | S1-S4 all 1.000 | structural: GATE PASS

- [x] G9: S5 and S6 pass on the pinned corpus repo (pulumi-go, subset `*-go-*/`, 85 files)
  CHECK: bun bench/src/cli.ts corpus setup --repo pulumi-go >/dev/null && bun run bench:structural --repo pulumi-go --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: 44 files scored | S5 1.000 (tp 183, fp 0, fn 1) | S6 1.000 (tp 215, fp 0, fn 7, recall 0.968) | S1 1.000/1.000, S2 1.000/1.000, S3 1.000, S4 1.000 | structural: GATE PASS. Every S6 miss is a local `NewX` component-resource constructor, which has no provider package to read; every S5 miss follows from one of them.

- [x] G10: the core and bench suites are green, and the existing Go language numbers are unchanged
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: whole suite 1697 pass, 0 fail, 15783 expect() calls across 51 files. Go numbers unchanged: `--fixture-go --gate` S1 1.000/1.000, S2 1.000/1.000, S3 1.000 (recall 0.833), S4 1.000, GATE PASS; corpus `gin` S1 1.000/1.000, S2 1.000/1.000, S3 1.000 (recall 0.615), S4 1.000, GATE PASS.

- [x] G11: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: both clean; `bun run typecheck` clean across all eight projects.
