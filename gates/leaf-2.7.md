# Gates: 2.3.2 signals-pulumi-go

Scope: the `pulumi-go` signal pass (resource nodes from `<pkg>.New<Type>(ctx, "<name>",
&<pkg>.<Type>Args{...})` calls whose package alias is a pinned Pulumi provider import, from the
`<pkg>.Get<Type>(ctx, "<name>", id, state)` adoption form beside them, and from
`pulumi.NewStackReference`; the `meta.type` token; and `resource-input` reference edges between
resources in one file, both from an `Args` field reading `<var>.<Field>` and from a
`pulumi.Parent`/`DependsOn`/`Provider`/`Providers` option naming `<var>` outright), the
`fixtures/tiny-pulumi-go` fixture, and the independent `go/types` oracle that decides
resourceness with `types.Implements` against `pulumi.Resource`.
An unbound resource is identified by its Pulumi logical name (`~site`) and only failing that by
its position among the remaining unbound ones (`~0`), so an insertion above it cannot move it.
Spec: `docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 3.1, 3.6,
3.7, 3.8.

- [x] G1: the Pulumi Go signal test file passes
  CHECK: bun test packages/core/test/signals-pulumi-go.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 56 expect() calls | Ran 38 tests across 1 file. [144.00ms] (fix round 1 + follow-ups)

- [x] G2: a `NewX` call through a Pulumi provider import becomes a `resource.<varName>` node with the right type token, and a `NewX` from a non-Pulumi package does not; describe('pulumi go resources')
  CHECK: bun test packages/core/test/signals-pulumi-go.test.ts -t "pulumi go resources" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 19 pass, 18 filtered out | 33 expect() calls; covers the `Get<Type>` adoption form, the data-source lookups it must not swallow, `pulumi.NewStackReference`, the `~<logicalName>` identity and the allocator seeded from the file's own declarations (fix round 1)
  Ran 19 tests; the collision case asserts `main.go#resource.bucket~2`.

- [x] G3: an `Args` field reading another resource variable's field or method is a `resource-input` reference, and an ambiguous one is dropped; describe('resource inputs')
  CHECK: bun test packages/core/test/signals-pulumi-go.test.ts -t "resource inputs" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 11 pass, 27 filtered out | 11 expect() calls; covers `pulumi.Parent`, `pulumi.DependsOn`, `pulumi.Provider` and `pulumi.Providers` naming a resource outright, and a bare identifier outside those four producing nothing (fix round 1 + follow-up ruling)

- [x] G4: the fixture yields the two resource nodes, the one `resource-input` edge and nothing for the decoy; describe('tiny-pulumi-go')
  CHECK: bun test packages/core/test/signals-pulumi-go.test.ts -t tiny-pulumi-go 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 8 pass, 29 filtered out | ids ["main.go#resource.bucket","main.go#resource.policy"], both reference forms (`bucket.ID` and the `pulumi.Parent(bucket)` option), decoy silent (fix round 1)

- [x] G5: the truth generator test file passes
  CHECK: bun test bench/test/signals-pulumi-go.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 36 expect() calls | Ran 18 tests across 1 file. [12.03s] (fix round 1 + follow-ups)

- [x] G6: the oracle finds resources by `types.Implements(t, pulumi.Resource)`, never by name, and attributes them per file through the `token.FileSet`; describe('go types oracle')
  CHECK: bun test bench/test/signals-pulumi-go.test.ts -t "go types oracle" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 11 pass, 5 filtered out | the only Pulumi path literal in main.go is "github.com/pulumi/pulumi/sdk/", the package that declares the interface; the oracle finds the adoption form, the stack reference and the provider-option edges by type alone, and seeds its own allocator from the file's declared methods so a type named `resource` diverges on neither side (fix round 1 + follow-ups); 13 pass, 5 filtered out

- [x] G7: the oracle imports nothing from greplost and its output changes when the fixture changes; describe('oracle independence')
  CHECK: bun test bench/test/signals-pulumi-go.test.ts -t "oracle independence" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 5 pass, 11 filtered out | added resource appears, removed resource disappears, a local ComponentResource is found by its method set (fix round 1); 5 pass, 13 filtered out

- [x] G8: S5 and S6 pass on the fixture
  CHECK: bun run bench:structural --fixture tiny-pulumi-go --lang go --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: S5 1.000 (tp 1, fp 0, fn 0) | S6 1.000 (tp 2, fp 0, fn 0) | S1-S4 all 1.000 | structural: GATE PASS. The fixture now carries both reference forms; S5 counts one because its key is (from, to, refKind) and both edges name the same pair (fix round 1)

- [x] G9: S5 and S6 pass on the pinned corpus repo (pulumi-go, subset `*-go-*/`, 85 files)
  CHECK: bun bench/src/cli.ts corpus setup --repo pulumi-go >/dev/null && bun run bench:structural --repo pulumi-go --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: 44 files scored | S5 1.000 (tp 225, fp 0, fn 1, recall 0.996) | S6 1.000 (tp 216, fp 0, fn 6, recall 0.973) | S1 1.000/1.000, S2 1.000/1.000, S3 1.000, S4 1.000 | structural: GATE PASS. Fix round 1 moved S5 tp 183 -> 208 (`Parent`/`DependsOn`) and S6 tp 215 -> 216 with fn 7 -> 6 (the `corev1.GetService` adoption); the follow-up ruling on `Provider`/`Providers` moved S5 tp 208 -> 225 and fn 18 -> 1. The five remaining S6 misses are local `NewX` component-resource constructors, which have no provider package to read, and the one S5 miss is the edge into one of them.

- [x] G10: the core and bench suites are green, and the existing Go language numbers are unchanged
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: `bun test packages/core bench` 1499 pass, 0 fail, 5797 expect() calls across 45 files; whole suite 2027 pass, 0 fail, 16961 expect() calls across 64 files. Go numbers unchanged: `--fixture-go --gate` S1 1.000/1.000, S2 1.000/1.000, S3 1.000 (recall 0.833), S4 1.000, GATE PASS; corpus `gin` S1 1.000/1.000, S2 1.000/1.000, S3 1.000 (recall 0.615), S4 1.000, GATE PASS (fix round 1 + follow-ups).

- [x] G11: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: both clean; `bun run typecheck` clean across all eight projects.
