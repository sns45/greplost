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

**Where S1 and S5 are actually measured (read this before trusting G9 to G11).** No gate below
was changed, but two of the numbers `bench:structural` prints for HCL are structurally vacuous
today, and both are `bench/src/structural.ts`, which leaf 2.0 owns and three wave-1 leaves
share, so this leaf reported them instead of editing it:

- **S1 prints `1.000` over `tp 0`.** `scoreAgainstTruth` keeps *directory* import targets in the
  scored universe only for `lang === "go"` (`const dirSet = lang === "go" ? … : new Set()`), and
  a Terraform module is a directory, so every HCL import edge is filtered off both sides. The
  fix is to widen that condition to any language whose imports name directories.
- **S5 prints `n/a`.** `scoreAgainstTruth` returns `S5: null` unconditionally and never calls
  `TruthModule.generateExtra`, which this leaf is the first oracle to implement (leaf 2.0's
  report, concern 10, hands that wiring to exactly this leaf).

Both are therefore measured here, from this leaf's own oracle, with the harness's own
`scoreEdges`/`scoreSet` and at the thresholds stated above. `bench/test/truth-hcl.test.ts`
(`fixture truth`) asserts them on the fixture and is enforced by G7 and G12; the pinned corpus
numbers, measured over the same covered universe `scoreAgainstTruth` uses, are:

| target | files | S1 imports | S2 exports | S5 references | node set |
|---|---|---|---|---|---|
| tiny-terraform | 5 | 1.000 / 1.000 (tp 1) | 1.000 / 1.000 (tp 6) | 1.000 / 1.000 (tp 15) | 1.000 / 1.000 (tp 14) |
| tf-aws-vpc | 77 | 1.000 / 1.000 (tp 18) | 1.000 / 1.000 (tp 1591) | 1.000 / 1.000 (tp 2497) | 1.000 / 1.000 (tp 1909) |
| tf-aws-eks | 87 | 1.000 / 1.000 (tp 20) | 1.000 / 1.000 (tp 759) | 1.000 / 1.000 (tp 1989) | 1.000 / 1.000 (tp 1265) |

- [x] G1: the HCL extraction test file passes
  CHECK: bun test packages/core/test/extract-hcl.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 142 expect() calls | Ran 43 tests across 1 file. [392.00ms]

- [x] G2: every top-level block becomes a node with the id `<file>#<kind>.<name>`, the header as its signature and the documented `meta`; describe('blocks')
  CHECK: bun test packages/core/test/extract-hcl.test.ts -t blocks 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 43 expect() calls | Ran 14 tests across 1 file. [60.00ms]

- [x] G3: only `module` blocks import, a local source targets a directory and a registry source becomes `ext:module/<source>`; describe('module imports')
  CHECK: bun test packages/core/test/extract-hcl.test.ts -t "module imports" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 16 expect() calls | Ran 6 tests across 1 file. [84.00ms]

- [x] G4: address chains become `hcl-ref` edges at the documented confidence, `each`/`count` are ignored and anything ambiguous is dropped; describe('references')
  CHECK: bun test packages/core/test/extract-hcl.test.ts -t references 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 71 expect() calls | Ran 17 tests across 1 file. [282.00ms]

- [x] G5: a `locals` block yields one `const` per attribute named `local.<name>`; describe('locals')
  CHECK: bun test packages/core/test/extract-hcl.test.ts -t locals 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 6 expect() calls | Ran 3 tests across 1 file. [54.00ms]

- [x] G6: the fixture builds with the expected nodes, the module import and the med-confidence module output reference; describe('tiny-terraform')
  CHECK: bun test packages/core/test/extract-hcl.test.ts -t tiny-terraform 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 7 expect() calls | Ran 4 tests across 1 file. [161.00ms]

- [x] G7: the truth generator test file passes
  CHECK: bun test bench/test/truth-hcl.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 64 expect() calls | Ran 15 tests across 1 file. [133.00ms]

- [x] G8: the oracle imports nothing from `packages/core` and its output tracks the fixture; describe('oracle independence')
  CHECK: bun test bench/test/truth-hcl.test.ts -t "oracle independence" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 31 expect() calls | Ran 3 tests across 1 file. [40.00ms]

- [x] G9: S1, S2, S4 and S5 pass on the fixture with S3 printed as `n/a`
  CHECK: bun run bench:structural --fixture tiny-terraform --lang hcl --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: S6  signal node precision                  >=0.95           n/a            not measured by this oracle | structural: GATE PASS

- [x] G10: the gate passes on the first pinned corpus repo (tf-aws-vpc, whole repo, 77 `.tf`)
  CHECK: bun bench/src/cli.ts corpus setup --repo tf-aws-vpc >/dev/null && bun run bench:structural --repo tf-aws-vpc --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: S6  signal node precision                  >=0.95           n/a            not measured by this oracle | structural: GATE PASS

- [x] G11: the gate passes on the second pinned corpus repo (tf-aws-eks, whole repo, 87 `.tf`)
  CHECK: bun bench/src/cli.ts corpus setup --repo tf-aws-eks >/dev/null && bun run bench:structural --repo tf-aws-eks --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: S6  signal node precision                  >=0.95           n/a            not measured by this oracle | structural: GATE PASS

- [x] G12: the core and bench suites are green
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 4594 expect() calls | Ran 923 tests across 26 files. [49.53s]

- [x] G13: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: (no output)
