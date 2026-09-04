# Gates: 2.2.1 terraform

Scope: Terraform (HCL) extraction (top-level blocks as non-file nodes, `locals`, the `terraform`
block, module imports), HCL references (`hcl-ref` for `var`/`local`/`module`/`data`/managed
resource addresses and `depends_on`, `uses` for a registry module source), HCL resolution (a
local module source targets a directory, a registry or git source becomes `ext:module/<source>`,
`required_providers` entries become `ext:provider/<name>`), the `fixtures/tiny-terraform`
fixture, and the independent `terraform-config-inspect` truth generator with corpus gates on
tf-aws-vpc and tf-aws-eks. HCL has no call edges, so S3 prints `n/a` and is never a pass or a
fail; S5 (reference precision) is gated at 0.95 with recall reported.
Spec: `docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 0, 2.1, 2.2,
2.6, 5.1.

- [ ] G1: the HCL extraction test file passes
  CHECK: bun test packages/core/test/extract-hcl.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G2: every top-level block becomes a node with the id `<file>#<kind>.<name>`, the header as its signature and the documented `meta`; describe('blocks')
  CHECK: bun test packages/core/test/extract-hcl.test.ts -t blocks 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G3: only `module` blocks import, a local source targets a directory and a registry source becomes `ext:module/<source>`; describe('module imports')
  CHECK: bun test packages/core/test/extract-hcl.test.ts -t "module imports" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G4: address chains become `hcl-ref` edges at the documented confidence, `each`/`count` are ignored and anything ambiguous is dropped; describe('references')
  CHECK: bun test packages/core/test/extract-hcl.test.ts -t references 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G5: a `locals` block yields one `const` per attribute named `local.<name>`; describe('locals')
  CHECK: bun test packages/core/test/extract-hcl.test.ts -t locals 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G6: the fixture builds with the expected nodes, the module import and the med-confidence module output reference; describe('tiny-terraform')
  CHECK: bun test packages/core/test/extract-hcl.test.ts -t tiny-terraform 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G7: the truth generator test file passes
  CHECK: bun test bench/test/truth-hcl.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G8: the oracle imports nothing from `packages/core` and its output tracks the fixture; describe('oracle independence')
  CHECK: bun test bench/test/truth-hcl.test.ts -t "oracle independence" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G9: S1, S2, S4 and S5 pass on the fixture with S3 printed as `n/a`
  CHECK: bun run bench:structural --fixture tiny-terraform --lang hcl --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] G10: the gate passes on the first pinned corpus repo (tf-aws-vpc, whole repo, 77 `.tf`)
  CHECK: bun bench/src/cli.ts corpus setup --repo tf-aws-vpc >/dev/null && bun run bench:structural --repo tf-aws-vpc --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] G11: the gate passes on the second pinned corpus repo (tf-aws-eks, whole repo, 87 `.tf`)
  CHECK: bun bench/src/cli.ts corpus setup --repo tf-aws-eks >/dev/null && bun run bench:structural --repo tf-aws-eks --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] G12: the core and bench suites are green
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G13: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
