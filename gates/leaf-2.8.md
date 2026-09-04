# Gates: 2.2.2 k8s-helm

Scope: Kubernetes and Helm YAML extraction (one `resource` node per document with `apiVersion`
and `kind`, an `image` node per container, `Chart.yaml` as a `module` node, `values.yaml`
top-level keys as `variable` nodes), the documented template blanking pre-pass that makes a Helm
template parseable without running helm, the `selector`, `config-ref`, `helm-values` and
`from-image` reference rules, the `fixtures/tiny-k8s` and `fixtures/tiny-helm` fixtures, and the
two oracles: an independent `js-yaml` reader for plain manifests and `helm template` for charts,
the latter comparing only kinds, apiVersions and per-file node counts, never names.
Spec: `docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 2.1, 2.3, 2.6.

## Measured numbers (the fixtures and the two pinned corpora)

`bench:structural` prints these; S3 is `n/a` for every YAML target (a manifest has no calls) and
S6 is `n/a` for a chart (a template's node ids carry document-index fallback names, and
`helm template` cannot report the documents a `{{ if }}` decided not to render).

| target | files | S1 imports | S2 exports | S5 references | S6 nodes |
|---|---|---|---|---|---|
| tiny-k8s | 3 | 1.000 / 1.000 (tp 0) | 1.000 / 1.000 (tp 7) | 1.000 / 1.000 (tp 5) | 1.000 / 1.000 (tp 7) |
| tiny-helm | 4 | 1.000 / 1.000 (tp 0) | 1.000 / 1.000 (tp 4) | 1.000 / 1.000 (tp 4) | n/a |
| k8s-examples | 245 | 1.000 / 1.000 (tp 0) | 1.000 / 1.000 (tp 401) | 1.000 / 1.000 (tp 172) | 1.000 / 1.000 (tp 401) |
| bitnami-charts | 130 | 1.000 / 1.000 (tp 0) | 1.000 / 1.000 (tp 216) | 1.000 / 1.000 (tp 694) | n/a |

S1 is `tp 0` on both sides and not vacuous by accident: YAML has no import statements at all, and
both the extractor and the oracle say so rather than failing to find any. S5's `tp` counts
`(from, to, refKind)` keys over the universe `scoreAgainstTruth` scores: a source in a covered
file, and a target that is a covered file or an `ext:` id. Numbers measured after `git merge
main` at 028ad17, which brought the driver's Terraform-review change admitting `ext:` targets
into S5 (it is what takes k8s-examples from 43 keys to 172: the `ext:image/<ref>` edges).

Rulings this leaf made, in full, with reasons, are in the leaf report; the four that change what
another leaf can assume are:

1. **A document whose `kind` or `apiVersion` is templated makes no `resource` node.** Both are
   part of the node's identity (`<file>#resource.<Kind>.<name>`), and `resource.______.~0` would
   be a guess wearing an id. A templated *name* is the case spec 2.3's document-index fallback
   is for, and is handled: `<Kind>.~<index>`, `meta.templated = "1"`, `meta.nameTemplate`.
2. **`~` replaces `#` everywhere spec 0.2 wrote an index suffix**, not only for duplicates:
   `nodeId` refuses `#` in a name (driver ruling 2026-09-04), so the unnamed-document fallback is
   `<Kind>.~<docIndex>` and a repeated name is `<name>~<n>` with n from 2. Leaf 2.9's
   `<jobId>.#<stepIndex>` needs the same substitution.
3. **A Helm template exports nothing and draws only `helm-values`.** A chart's object names,
   labels and image references are values chosen when the chart is rendered; a `selector` built
   from the handful of labels a chart writes literally is a fragment of a graph that only exists
   after `helm template` has run, and no oracle can state it. `Chart.yaml` still exports the
   chart name and `values.yaml` its top-level keys, because those are real, unrendered files.
   `helm-values` is recorded at *file* level (`ref.from === ""`) for the same reason.
4. **A manifest's node names are in `FileRecord.exports`** while `Declaration.exported` stays
   `false` for every node, exactly as spec 2.3 says. `buildExportIndex` never takes a non-file
   node from the declaration side (`isNodeKind`), so the export record is the only route a node
   name can reach `FileEntry.exports` — the same route `extract/hcl.ts` takes for a Terraform
   `variable` — and a `ConfigMap` named `web-config` is precisely what another manifest reaches
   for by name.

Two files outside this leaf's ownership were edited and are reported to the driver:
`bench/src/truth/yaml.ts` gained a `generateExtra` that dispatches per flavour (without it
`structural.ts` asks the `yaml` target's module for one, finds none, and S5/S6 are `n/a` for
every YAML target); `packages/core/src/unparsable.ts` blanks a Helm template before asking
whether it parses (without it all 122 bitnami templates are reported as files nothing could be
read from, which is the opposite of true). Both are commented at the change.

- [x] G1: each document becomes `<Kind>.<metadata.name>` (or the 0-based index when unnamed), and each container becomes an `image` node; describe('documents'), describe('images')
  CHECK: bun test packages/core/test/extract-yaml-k8s.test.ts -t "documents|images" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 11 pass | 25 filtered out | 0 fail | Ran 11 tests across 1 file. [97.00ms]

- [x] G2: a selector matching exactly one workload is a high-confidence edge and a selector matching two is dropped; `configMapRef`, `secretRef`, key refs, PVC claims and volume configMaps resolve only when unique; describe('selectors'), describe('config refs')
  CHECK: bun test packages/core/test/extract-yaml-k8s.test.ts -t "selectors|config refs" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 9 pass | 27 filtered out | 0 fail | Ran 9 tests across 1 file. [180.00ms]

- [x] G3: the template blanking pre-pass replaces every `{{ … }}` span in place with an equal-length filler so the source length, every line and every column are preserved, and a templated name falls back to the document index with the raw template kept in `meta.nameTemplate`; describe('helm templates')
  CHECK: bun test packages/core/test/extract-yaml-k8s.test.ts -t "helm templates" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 7 pass | 29 filtered out | 0 fail | Ran 7 tests across 1 file. [80.00ms]

- [x] G4: `values.yaml` yields one `variable` node per top-level key only, and a `.Values.x` action links to it at `med` confidence; describe('values')
  CHECK: bun test packages/core/test/extract-yaml-k8s.test.ts -t values 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 7 pass | 29 filtered out | 0 fail | Ran 7 tests across 1 file. [150.00ms]

- [x] G5: both fixtures build with the expected node sets and reference edges; describe('tiny-k8s'), describe('tiny-helm')
  CHECK: bun test packages/core/test/extract-yaml-k8s.test.ts -t "tiny-k8s|tiny-helm" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 7 pass | 29 filtered out | 0 fail | Ran 7 tests across 1 file. [207.00ms]

- [x] G6: the truth generator test file passes
  CHECK: bun test bench/test/truth-yaml-k8s.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 18 pass | 0 fail | 84 expect() calls | Ran 18 tests across 1 file. [541.00ms]

- [x] G7: the `js-yaml` oracle and the `helm template` oracle share no code with `packages/core`, and their output changes when the fixture changes; describe('oracle independence')
  CHECK: bun test bench/test/truth-yaml-k8s.test.ts -t "oracle independence" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 3 pass | 15 filtered out | 0 fail | 30 expect() calls | Ran 3 tests across 1 file. [124.00ms]

- [x] G8: S1, S2, S4 and S5 pass on the Kubernetes fixture (S3 is `n/a`; a manifest has no calls)
  CHECK: bun run bench:structural --fixture tiny-k8s --lang yaml --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: tiny-k8s (3 files); S1 1.000/1.000, S2 1.000/1.000 (tp 7), S3 n/a, S4 1.000, S5 1.000 (tp 5), S6 1.000 (tp 7)

- [x] G9: the Helm fixture passes against `helm template`, on kinds, apiVersions and per-file node counts only
  CHECK: bun run bench:structural --fixture tiny-helm --lang yaml --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: tiny-helm (4 files); S2 1.000/1.000 (tp 4), S5 1.000 (tp 4), S6 n/a. The render
  comparison itself is `bench/test/truth-yaml-k8s.test.ts` describe('helm render'), which pins
  greplost's templated `resource` nodes against `helm template`'s per-source-file
  `(kind, apiVersion)` list: `templates/deployment.yaml -> [Deployment/apps/v1]`,
  `templates/service.yaml -> [Service/v1]`, both sides equal, and asserts every one of those
  nodes carries `meta.templated = "1"` and a `.~<index>` name, so no name is ever compared.

- [x] G10: the gate passes on the pinned plain-manifest corpus repo (k8s-examples, whole repo, 250 `.yaml`)
  CHECK: bun bench/src/cli.ts corpus setup --repo k8s-examples >/dev/null && bun run bench:structural --repo k8s-examples --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: k8s-examples (245 files covered of 250; js-yaml refuses 10 archived manifests for a
  duplicate mapping key or a complex key, and an uncovered file is scored on neither side);
  S1 1.000/1.000, S2 1.000/1.000 (tp 401), S3 n/a, S4 1.000, S5 1.000 (tp 172), S6 1.000 (tp 401)

- [x] G11: the gate passes on the pinned Helm corpus repo (bitnami-charts, subset `bitnami/{wordpress,kafka,postgresql,redis}/`, 130 `.yaml`)
  CHECK: bun bench/src/cli.ts corpus setup --repo bitnami-charts >/dev/null && bun run bench:structural --repo bitnami-charts --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: bitnami-charts (130 files); S1 1.000/1.000, S2 1.000/1.000 (tp 216), S3 n/a,
  S4 1.000, S5 1.000 (tp 694), S6 n/a. 4 unparsable files after the pre-pass, down from 122
  before it; the four charts each declare `common` from an OCI registry and ship no `charts/`,
  so `helm template` cannot render them offline and the oracle says so on stderr rather than
  scoring zero — nothing scored here comes from the render.

- [x] G12: the core and bench suites are green
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 1231 pass | 0 fail | 5188 expect() calls | Ran 1231 tests across 34 files. [54.65s] (after `git merge main` at 028ad17)

- [x] G13: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: (no output)
