# Gates: 2.2.3 actions

Scope: GitHub Actions extraction (`job`, `step` and `task` nodes with index-suffixed step names),
the three Actions reference kinds (`needs`, `uses`, `config`), the `fixtures/tiny-actions`
fixture, and the independent workflow oracle with a corpus gate on `starter-workflows`.
Spec: `docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 2.1, 2.4, 2.6
and 5.1.

- [x] G1: the Actions extraction test file passes
  CHECK: bun test packages/core/test/extract-yaml-actions.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 29 pass | 0 fail | 54 expect() calls | Ran 29 tests across 1 file.

- [x] G2: every `jobs.<id>` becomes a `job` node in document order; describe('jobs')
  CHECK: bun test packages/core/test/extract-yaml-actions.test.ts -t jobs 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 6 pass | 23 filtered out | 0 fail. `jobs.<id>` in document order; a job whose body
  is a reusable-workflow call is a `task` node named after the job, and the file's `exports` are
  its job ids, which is what `Truth.exports` is scored against.

- [x] G3: step nodes are named `<jobId>.#<index>` from a 0-based position, with `meta.uses` or `meta.run`; describe('steps')
  CHECK: bun test packages/core/test/extract-yaml-actions.test.ts -t steps 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 6 pass | 23 filtered out | 0 fail. The index suffix is spelled `~` and not `#`:
  `nodeId` throws on a `#` in a name and the driver's 2026-09-04 ruling replaced spec 0.2's
  `#<index>` sketch with `~<index>`, which is what leaf 2.8 already writes. So the names are
  `build.~0`, `build.~1`, `test.~0` and a composite action's are `runs.~0`, `runs.~1`; the
  0-based position, the `meta.uses`/`meta.run` rule and the 80-character clip are as the gate
  title states. A test asserts renaming one job does not renumber another's steps.

- [x] G4: `needs` is a high-confidence edge to the named job's node; describe('needs')
  CHECK: bun test packages/core/test/extract-yaml-actions.test.ts -t needs 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 4 pass | 25 filtered out | 0 fail. Scalar and sequence forms both resolve, a `needs`
  naming a `task` job resolves to the task node, and `needs` never leaves its own file (a job id
  that exists only in a sibling workflow is dropped, because Actions would never run that edge).

- [x] G5: a step `uses` resolves to `ext:action/<owner>/<repo>@<ref>`, a local action file or a reusable workflow file; describe('uses')
  CHECK: bun test packages/core/test/extract-yaml-actions.test.ts -t uses 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 8 pass | 21 filtered out | 0 fail. The external id is `ext:action/<owner>/<repo>`
  with the `@ref` in `meta.usesRef` and in the edge's `symbols`, not in the id: the driver's
  2026-09-04 ruling ("external: `ext:action/<owner>/<repo>` with the ref in `meta`") supersedes
  the `@<ref>` spelling in this gate's title and in spec 0.2, for the Terraform-module reason —
  a ref is a version, and `terraform`'s `version` is not part of a module's `source` either. A
  subpath is kept (`ext:action/github/codeql-action/init`), because `init` and `analyze` are two
  different actions in one repository and collapsing them would merge two unrelated steps.
  Local `./…` resolves to the reusable workflow file or to the directory's `action.yml`; a
  directory with no `action.yml`, a `docker://` reference and a `${{ }}` expression are dropped.

- [x] G6: a `run` body naming exactly one repo path links to it, and an ambiguous token is dropped; describe('run scripts')
  CHECK: bun test packages/core/test/extract-yaml-actions.test.ts -t "run scripts" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 4 pass | 25 filtered out | 0 fail. The extractor offers every path-shaped token of a
  `run:` body and the reference layer keeps the ones naming exactly one indexed path (matching a
  whole path or a suffix at a segment boundary). `node build.js` with `a/build.js` and
  `b/build.js` in the repo is dropped; a token holding `${{ }}`, a glob or `..` is never a
  candidate; a bare command with neither a separator nor an extension (`make release`) is not a
  path at all.

- [x] G7: the fixture builds with the expected node set and all three refKinds; describe('tiny-actions')
  CHECK: bun test packages/core/test/extract-yaml-actions.test.ts -t tiny-actions 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 3 pass | 26 filtered out | 0 fail. 10 nodes (2 step in the composite action,
  2 job + 3 step in `ci.yml`, 1 task + 1 job + 1 step in `release.yml`) and exactly 8 edges,
  covering all three refKinds: 3 `uses` (one external, one local action, one reusable workflow),
  2 `needs` (one onto a `task`), 2 `config` (`scripts/x.ts`, `scripts/announce.mjs`), plus the
  composite action's external `uses`. No node name contains `#`.

- [x] G8: the Actions truth generator test file passes
  CHECK: bun test bench/test/truth-yaml-actions.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 12 pass | 0 fail | 49 expect() calls | Ran 12 tests across 1 file. The oracle is
  `js-yaml` (`NOTES = ["js-yaml-oracle"]`, plus `unsupported:S3`). `@actions/workflow-parser`
  publishes (0.3.61) but adding it is an edit to `bench/package.json`, which the build-2
  contract forbids a leaf; it is also not much more of an oracle, since its public entry point
  parses with a YAML reader and then validates GitHub's schema. Reported to the driver.

- [x] G9: the oracle shares no code with `packages/core` and its output tracks the fixture; describe('oracle independence')
  CHECK: bun test bench/test/truth-yaml-actions.test.ts -t "oracle independence" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 3 pass | 9 filtered out | 0 fail. The import specifiers of
  `bench/src/truth/yaml-actions.ts` carry no tree-sitter, no `@greplost/core` and nothing under
  `extract/`, `resolve/`, `references/` or `signals/` (only `@greplost/core/schema`, the shared
  id and sorting vocabulary, as leaf 2.8's oracles do), and the source never calls
  `buildSnapshot(`. The answer tracks the fixture in both directions: adding a workflow with two
  jobs, a `needs` and a local `uses` adds 4 nodes and both edges; deleting a step removes a node
  and renumbers the one after it.

- [x] G10: S1 to S5 pass on the fixture
  CHECK: bun run bench:structural --fixture tiny-actions --lang yaml --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: tiny-actions (3 files); S1 1.000/1.000 (tp 0), S2 1.000/1.000 (tp 4), S3 n/a,
  S4 1.000, S5 1.000/1.000 (tp 6), S6 1.000/1.000 (tp 10). The two `config` edges are outside
  the scored universe on both sides (their targets are `.ts`/`.mjs` files, and a yaml target's
  file set is yaml), which is why S5 counts 6 of the fixture's 8 edges.

- [x] G11: S1 to S5 pass on the pinned corpus repo (starter-workflows, whole repo, 187 workflow `.yml`)
  CHECK: bun bench/src/cli.ts corpus setup --repo starter-workflows >/dev/null && bun run bench:structural --repo starter-workflows --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: starter-workflows @ e3c451d (187 files); S1 1.000/1.000 (tp 0), S2 1.000/1.000
  (tp 211 job ids), S3 n/a, S4 1.000, S5 1.000/1.000 (tp 570), S6 1.000/1.000 (tp 1019), fp 0
  and fn 0 on every metric. 187 files is the whole pinned corpus, and getting there needed the
  classification ruling recorded below: 174 of this repo's 183 workflows live in `ci/`,
  `deployments/`, `code-scanning/`, `automation/` and `pages/`, not in `.github/workflows/`.

- [x] G12: the core and bench suites are green
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 1440 pass | 0 fail (after `git merge main`; whole-repo `bun test` is 1915 pass, 0 fail)

- [x] G13: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: (no output); `bun run typecheck` is clean across all eight projects too

## Measured numbers

`bench:structural` prints these; S3 is `n/a` for every YAML target (a workflow has no calls).

| target | files | S1 imports | S2 exports | S5 references | S6 nodes |
|---|---|---|---|---|---|
| tiny-actions | 3 | 1.000 / 1.000 (tp 0) | 1.000 / 1.000 (tp 4) | 1.000 / 1.000 (tp 6) | 1.000 / 1.000 (tp 10) |
| starter-workflows | 187 | 1.000 / 1.000 (tp 0) | 1.000 / 1.000 (tp 211) | 1.000 / 1.000 (tp 570) | 1.000 / 1.000 (tp 1019) |

S1 is `tp 0` on both sides and not vacuous by accident: a workflow has no import statement, and
both `extract/yaml-actions.ts` and the oracle say so rather than failing to find any —
`resolve/yaml.ts` (the seam) states the same rule for every YAML flavour.

Regression check on the two YAML corpora this leaf's dispatcher edits could have moved:
`k8s-examples` 245 files, S2 tp 401, S5 tp 172, S6 tp 401, GATE PASS; `bitnami-charts` 130
files, S2 tp 216, S5 tp 694, S6 n/a, GATE PASS. Both unchanged.

## Rulings this leaf made

Full reasoning is in the leaf report; the five that change what another leaf can assume:

1. **The step index suffix is `~<index>`, not `#<index>`.** `nodeId` throws on a `#` in a name,
   and the driver's 2026-09-04 ruling already replaced spec 0.2's sketch for duplicates. Spec
   2.4's `<jobId>.#<stepIndex>` is the same sketch, so it takes the same substitution, which is
   what leaf 2.8 writes for its document-index fallback. Step names are `build.~0`, `build.~1`.
2. **An external action is `ext:action/<owner>/<repo>[/<subpath>]`, with the `@ref` in `meta`.**
   The driver's 2026-09-04 ruling ("external: `ext:action/<owner>/<repo>` with the ref in
   `meta`") supersedes the `@<ref>` spelling in spec 0.2 and 2.4: a ref is a version, and the
   Terraform precedent it names keeps a module's `version` out of its `source`. The subpath is
   kept because `github/codeql-action/init` and `github/codeql-action/analyze` are two actions.
   The full text as written stays on the step (`meta.uses`) and on the edge (`symbols`).
3. **Classification is content-aware for two shapes the path rule cannot see.** Added to
   `extract/yaml.ts` *after* the Helm rule, so no chart file changes flavour: a document with
   top-level `on` **and** `jobs` is a workflow wherever it lives, and a top-level `runs` in a
   file named `action.yml`/`action.yaml` is an action definition. Without the first, the pinned
   corpus would have scored 9 files of 187 and published the result as a measurement of the
   whole repo; without the second, spec 2.4's composite-action clause is unreachable, because
   `.github/actions/x/action.yml` is not under `.github/workflows/`. Restated independently on
   `js-yaml` in `bench/src/truth/yaml-actions.ts` (`isActionsFile`), so a flavour disagreement
   between the two programs shows up as a score rather than as silence.
4. **`references/yaml.ts` dispatches on `refKind`, with the path as the fallback.** The two YAML
   flavours' kinds are already disjoint — that module's own docstring says so — and the path is
   no longer sufficient now that an Actions file can live anywhere.
5. **A workflow emits no `ImportRecord`.** Ruling 7's "follow the Terraform module precedent"
   is honoured on the reference side (`uses` resolves to the local directory's `action.yml` or
   the workflow file, exactly as a `module` block's `uses` resolves to the module directory) and
   not on the import side, because `resolve/yaml.ts` — a seam file — states that a YAML file has
   no import specifiers and that a stray one is an extractor bug. Spec 2.4 lists `uses` under
   References only, and the brief says `Truth.imports` is empty for workflows.

## Files this leaf changed outside its ownership

Reported to the driver rather than hidden. All three are seam files (leaf 2.0), and leaf 2.8 set
the precedent for the third:

- `packages/core/src/extract/yaml.ts` — two classification rules (ruling 3), 14 lines.
- `packages/core/src/references/yaml.ts` — dispatch on `refKind` (ruling 4), 12 lines.
- `bench/src/truth/yaml.ts` — the `yaml-actions` entry in `EXTRA_GENERATORS` (which the seam
  left `undefined` for this leaf to fill), an optional `root` on `flavourOf`/`groupByFlavour` so
  the content rule can run, and a third `universe` argument to `ExtraGenerator` so a workflow's
  `uses` and `run:` tokens resolve against the whole YAML file set rather than the flavour's own
  group. `flavourOf(file)` and `groupByFlavour(files)` keep their one-argument behaviour, so the
  seam's own `bench/test/registry.test.ts` is untouched.
- `packages/core/test/references.test.ts` — the two `yaml-actions` stub rows removed, the way
  every language leaf before this one removed its own.
