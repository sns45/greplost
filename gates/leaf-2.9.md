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

- [x] G3: step nodes are named `<jobId>.~<index>` from a 0-based position (ruling 2026-09-04: `nodeId` refuses `#`), with `meta.uses` or `meta.run`; describe('steps')
  CHECK: bun test packages/core/test/extract-yaml-actions.test.ts -t steps 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 6 pass | 23 filtered out | 0 fail. The index suffix is spelled `~` and not `#`:
  `nodeId` throws on a `#` in a name and the driver's 2026-09-04 ruling replaced spec 0.2's
  `#<index>` sketch with `~<index>`, which is what leaf 2.8 already writes. So the names are
  `build.~0`, `build.~1`, `test.~0` and a composite action's are `runs.~0`, `runs.~1`; the
  0-based position, the `meta.uses`/`meta.run` rule and the 80-character clip are as the gate
  title states. A test asserts renaming one job does not renumber another's steps.
  Fix round 1: the *duplicate* suffix now lands in the id and nowhere else (`…#job.build~2`
  named `build`, `…#step.build.~0~2` named `build.~0`), `exports` publishes one record per name,
  and a `ReferenceRecord.from` is read back from the id through `splitNodeId`, the rule
  `extract/yaml-k8s.ts` and `extract/hcl.ts` follow.

- [x] G4: `needs` is a high-confidence edge to the named job's node; describe('needs')
  CHECK: bun test packages/core/test/extract-yaml-actions.test.ts -t needs 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 4 pass | 25 filtered out | 0 fail. Scalar and sequence forms both resolve, a `needs`
  naming a `task` job resolves to the task node, and `needs` never leaves its own file (a job id
  that exists only in a sibling workflow is dropped, because Actions would never run that edge).

- [x] G5: a step `uses` resolves to `ext:action/<owner>/<repo>[/<subpath>]` with the ref in `meta.usesRef` (ruling 2026-09-05), a local action file or a reusable workflow file; describe('uses')
  CHECK: bun test packages/core/test/extract-yaml-actions.test.ts -t uses 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 8 pass | 21 filtered out | 0 fail. The external id is `ext:action/<owner>/<repo>`
  with the `@ref` in `meta.usesRef` and in the edge's `symbols`, not in the id: the driver's
  2026-09-04 ruling ("external: `ext:action/<owner>/<repo>` with the ref in `meta`") supersedes
  the `@<ref>` spelling in this gate's title and in spec 0.2, for the Terraform-module reason;
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
  EVIDENCE: 18 pass | 0 fail | Ran 18 tests across 1 file. The oracle is `js-yaml`
  (`NOTES = ["js-yaml-oracle", "anchors-not-expanded", "config-precision-unmeasured"]`, plus
  `unsupported:S1`, `unsupported:S3` and `unsupported:S4`). `@actions/workflow-parser`
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
  EVIDENCE: tiny-actions (3 files); S1 n/a, S2 1.000/1.000 (tp 4), S3 n/a, S4 n/a,
  S5 1.000/1.000 (tp 6), S6 1.000/1.000 (tp 10). The two `config` edges are outside the scored
  universe on both sides (their targets are `.ts`/`.mjs` files, and a yaml target's file set is
  yaml), which is why S5 counts 6 of the fixture's 8 edges: the `config-precision-unmeasured`
  note says so. S1 and S4 read `n/a` from fix round 1: a workflow has no import statement and no
  import graph, so a measured 1.000 over an empty universe on both sides was a vacuous pass.

- [x] G11: S1 to S5 pass on the pinned corpus repo (starter-workflows, whole repo, 187 workflow `.yml`)
  CHECK: bun bench/src/cli.ts corpus setup --repo starter-workflows >/dev/null && bun run bench:structural --repo starter-workflows --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: starter-workflows @ e3c451d (187 files); S1 n/a, S2 1.000/1.000 (tp 211 job ids),
  S3 n/a, S4 n/a, S5 1.000/1.000 (tp 570), S6 1.000/1.000 (tp 1019), fp 0 and fn 0 on every
  measured metric. Unchanged by fix round 1, which is the point: the four defects it closed were
  each unreachable on this corpus (js-yaml refuses a duplicate job id, no file has two workflow
  documents, every `.github/workflows/` file has an `on:` key, and the 102 expression-interior
  tokens blanking removes named no indexed YAML file). 187 files is the whole pinned corpus, and getting there needed the
  classification ruling recorded below: 174 of this repo's 183 workflows live in `ci/`,
  `deployments/`, `code-scanning/`, `automation/` and `pages/`, not in `.github/workflows/`.

- [x] G12: the core and bench suites are green
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 1501 pass | 0 fail | 5826 expect() calls | Ran 1501 tests across 45 files (after the
  fix-round-1 merge of main at 49d106e)

- [x] G13: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: (no output); `bun run typecheck` is clean across all eight projects too

## Measured numbers

`bench:structural` prints these; S3 is `n/a` for every YAML target (a workflow has no calls).

| target | files | S1 imports | S2 exports | S5 references | S6 nodes |
|---|---|---|---|---|---|
| tiny-actions | 3 | n/a | 1.000 / 1.000 (tp 4) | 1.000 / 1.000 (tp 6) | 1.000 / 1.000 (tp 10) |
| starter-workflows | 187 | n/a | 1.000 / 1.000 (tp 211) | 1.000 / 1.000 (tp 570) | 1.000 / 1.000 (tp 1019) |

S1 and S4 are `n/a` since fix round 1, and that is the honest reading rather than a weakening: a
workflow has no import statement (`resolve/yaml.ts`, the seam, states the same rule for every
YAML flavour) and therefore no import graph to find a cycle in, so both sides were scoring an
empty universe as a perfect 1.000, the vacuous pass tech spec 10.1 principle 2 exists to stop.
S2, S5 and S6 stay measured and gated, so `--gate` still has three metrics that can fail and the
substitute checks never engage.

Regression check on the two YAML corpora this leaf's dispatcher edits could have moved:
`k8s-examples` 245 files, S2 tp 401, S5 tp 172, S6 tp 401, GATE PASS; `bitnami-charts` 130
files, S2 tp 216, S5 tp 694, S6 1.000 (tp 216), GATE PASS. Unchanged by this leaf; bitnami's S6
moved from `n/a` to measured with main's `nodeFiles`, which is leaf 2.8's fix round, not this
one.

## Rulings this leaf made

Full reasoning is in the leaf report; the five that change what another leaf can assume:

0. **The `~<n>` duplicate suffix lives in the id and nowhere else** (fix round 1, C1 and I1).
   `Declaration.name` stays as the file wrote it and `exports` publishes one record per name:
   `needs: build` names *both* of two jobs called `build`, so a suffixed name would make the
   second silently distinguishable and turn an ambiguous reference into a certain one. A
   `ReferenceRecord.from` is read back from the id through `splitNodeId`. One rule covers a step
   under a duplicated job, stated identically in the extractor and the oracle: the step's name
   is always `<jobId as written>.~<stepIndex>`, so the second `build`'s first step is named
   `build.~0` and its *id* takes the suffix (`…#step.build.~0~2`). Exports are collected as each
   job is walked rather than from a sweep of `state.decls`, so a second workflow document in one
   file does not re-publish the first document's jobs.

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
   flavours' kinds are already disjoint, that module's own docstring says so, and the path is
   no longer sufficient now that an Actions file can live anywhere.
5. **A workflow emits no `ImportRecord`.** Ruling 7's "follow the Terraform module precedent"
   is honoured on the reference side (`uses` resolves to the local directory's `action.yml` or
   the workflow file, exactly as a `module` block's `uses` resolves to the module directory) and
   not on the import side, because `resolve/yaml.ts`, a seam file, states that a YAML file has
   no import specifiers and that a stray one is an extractor bug. Spec 2.4 lists `uses` under
   References only, and the brief says `Truth.imports` is empty for workflows.

## Files this leaf changed outside its ownership

Reported to the driver rather than hidden. All three are seam files (leaf 2.0), and leaf 2.8 set
the precedent for the third:

- `packages/core/src/extract/yaml.ts`, two classification rules (ruling 3), 14 lines.
- `packages/core/src/references/yaml.ts`, dispatch on `refKind` (ruling 4), 12 lines.
- `bench/src/truth/yaml.ts`, the `yaml-actions` entry in `EXTRA_GENERATORS` (which the seam
  left `undefined` for this leaf to fill), an optional `root` on `flavourOf`/`groupByFlavour` so
  the content rule can run, and a third `universe` argument to `ExtraGenerator` so a workflow's
  `uses` and `run:` tokens resolve against the whole YAML file set rather than the flavour's own
  group. `flavourOf(file)` and `groupByFlavour(files)` keep their one-argument behaviour, so the
  seam's own `bench/test/registry.test.ts` is untouched.
- `packages/core/test/references.test.ts`, the two `yaml-actions` stub rows removed, the way
  every language leaf before this one removed its own.

## Fix round 1 (task review, 2026-09-05)

The review reproduced every number and did not approve. All four findings and all five minors
are addressed; the corpus numbers are unchanged, which is what a fix to unreachable-on-this-
corpus defects should look like.

- **C1 (Critical), the `~<n>` suffix reached `Declaration.name` and `exports`.** `uniqueName`
  is now `uniqueId`, mirroring what leaf 2.8's fix round did: the suffix is appended to the
  whole id, the name is the text as written, `exports` is deduped by name, and `ref.from` comes
  from `splitNodeId(decl.id)` through a `localPath` helper. Three tests on the reviewer's input
  (two jobs called `build` in one file) pin the ids, the names, the single export and the two
  reference sources.
- **I1, the exports sweep re-exported the first document's jobs, and the two sides disagreed on
  a duplicate job's step ids.** Exports are now pushed as each job is walked (`addExport`), and
  one rule is stated on both sides: a step is named `<jobId as written>.~<stepIndex>` and a
  collision is settled by the id suffix, so `…#step.build.~0~2` on both sides rather than
  `build.~0~2` against `build~2.~0`. Tested with a two-document file in both programs.
- **I2: the oracle classified by path where the extractor classifies by content.**
  `isActionsFile` now restates the extractor's *whole* rule, in order, on js-yaml
  (`classifyDocument`): a file under `.github/workflows/` with no `on:` key is not a workflow,
  a manifest stays a manifest, a chart stays a chart, and a file js-yaml cannot read falls back
  to the path rule (it is covered by no oracle either way). `flavourOf(file, root)` asks it
  before the path rules; `flavourOf(file)` is untouched. Three tests.
- **I3, `run:` bodies were tokenised before `${{ … }}` was blanked.** Both sides now blank
  every expression span in place with equal-length filler (leaf 2.8's Helm pre-pass trick)
  before splitting, so `echo ${{ hashFiles('scripts/x.ts') }}` offers no candidate while
  `node scripts/x.ts ${{ inputs.flag }}` still resolves. Measured on the pinned corpus: across
  266 `run:` bodies, blanking removes 102 of 239 candidate tokens. Four tests. The
  `config-precision-unmeasured` note is added for leaf 2.12.

Minors: the `on`+`jobs` and `action.yml`+`runs` rules moved below `apiVersion`+`kind` in
`packages/core/src/extract/yaml.ts`; `unsupported:S1` and `unsupported:S4` added to the actions
NOTES (the report says what the driver should decide for the k8s and Helm oracles); the fixture
config restored to `DEFAULT_CONFIG`'s full exclude list plus nothing, with only `languages`
narrowed; `isActionsFile` memoised per `(root, file)` in `bench/src/truth/yaml.ts` (nested maps,
so no separator has to be a character a path cannot contain); `anchors-not-expanded` added to
the NOTES. Gate titles G3 and G5 left verbatim for the driver to amend.

`ExtraTruth.nodeFiles` arrived on main in leaf 2.8's fix round and now sits beside this leaf's
`universe` parameter in `bench/src/truth/yaml.ts`; the Actions flavour states nodes for every
file it covers, so it names no `nodeFiles` and its whole group goes into the union, verified by
`bitnami-charts` S6 moving from `n/a` to 1.000 (tp 216) with the Actions corpus unmoved.
