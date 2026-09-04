# Gates: 2.2.2 k8s-helm

Scope: Kubernetes and Helm YAML extraction (one `resource` node per document with `apiVersion`
and `kind`, an `image` node per container, `Chart.yaml` as a `module` node, `values.yaml`
top-level keys as `variable` nodes), the documented template blanking pre-pass that makes a Helm
template parseable without running helm, the `selector`, `config-ref`, `helm-values` and
`from-image` reference rules, the `fixtures/tiny-k8s` and `fixtures/tiny-helm` fixtures, and the
two oracles: an independent `js-yaml` reader for plain manifests and `helm template` for charts,
the latter comparing only kinds, apiVersions and per-file node counts, never names.
Spec: `docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 2.1, 2.3, 2.6.

- [ ] G1: each document becomes `<Kind>.<metadata.name>` (or the 0-based index when unnamed), and each container becomes an `image` node; describe('documents'), describe('images')
  CHECK: bun test packages/core/test/extract-yaml-k8s.test.ts -t "documents|images" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G2: a selector matching exactly one workload is a high-confidence edge and a selector matching two is dropped; `configMapRef`, `secretRef`, key refs, PVC claims and volume configMaps resolve only when unique; describe('selectors'), describe('config refs')
  CHECK: bun test packages/core/test/extract-yaml-k8s.test.ts -t "selectors|config refs" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G3: the template blanking pre-pass replaces every `{{ … }}` span in place with an equal-length filler so the source length, every line and every column are preserved, and a templated name falls back to the document index with the raw template kept in `meta.nameTemplate`; describe('helm templates')
  CHECK: bun test packages/core/test/extract-yaml-k8s.test.ts -t "helm templates" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G4: `values.yaml` yields one `variable` node per top-level key only, and a `.Values.x` action links to it at `med` confidence; describe('values')
  CHECK: bun test packages/core/test/extract-yaml-k8s.test.ts -t values 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G5: both fixtures build with the expected node sets and reference edges; describe('tiny-k8s'), describe('tiny-helm')
  CHECK: bun test packages/core/test/extract-yaml-k8s.test.ts -t "tiny-k8s|tiny-helm" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G6: the truth generator test file passes
  CHECK: bun test bench/test/truth-yaml-k8s.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G7: the `js-yaml` oracle and the `helm template` oracle share no code with `packages/core`, and their output changes when the fixture changes; describe('oracle independence')
  CHECK: bun test bench/test/truth-yaml-k8s.test.ts -t "oracle independence" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G8: S1, S2, S4 and S5 pass on the Kubernetes fixture (S3 is `n/a`; a manifest has no calls)
  CHECK: bun run bench:structural --fixture tiny-k8s --lang yaml --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] G9: the Helm fixture passes against `helm template`, on kinds, apiVersions and per-file node counts only
  CHECK: bun run bench:structural --fixture tiny-helm --lang yaml --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] G10: the gate passes on the pinned plain-manifest corpus repo (k8s-examples, whole repo, 250 `.yaml`)
  CHECK: bun bench/src/cli.ts corpus setup --repo k8s-examples >/dev/null && bun run bench:structural --repo k8s-examples --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] G11: the gate passes on the pinned Helm corpus repo (bitnami-charts, subset `bitnami/{wordpress,kafka,postgresql,redis}/`, 130 `.yaml`)
  CHECK: bun bench/src/cli.ts corpus setup --repo bitnami-charts >/dev/null && bun run bench:structural --repo bitnami-charts --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] G12: the core and bench suites are green
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G13: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
