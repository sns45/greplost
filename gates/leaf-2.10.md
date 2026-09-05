# Gates: 2.2.4 dockerfile

Scope: Dockerfile extraction (`stage` and `image` nodes, `ARG`/`ENV` constants, named and
unnamed stage ids), Dockerfile resolution and the three Dockerfile reference kinds
(`from-image`, `copy-from`, `config`), the `fixtures/tiny-docker` fixture, and the independent
`dockerfile-ast` oracle with corpus gates on `docker-python` and `docker-node`.
Spec: `docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 2.1, 2.5, 2.6
and 5.1.

## Measured numbers (the fixture and the two pinned corpora)

`bench:structural` prints these. S1, S3 and S4 are `n/a` for every Dockerfile target, because
the format has no import statement, no call site and therefore no import cycle: the oracle says
so with `unsupported:S1`, `unsupported:S3` and `unsupported:S4` rather than scoring a vacuous
1.000 for finding nothing (driver ruling 2026-09-05, fix round 1). S2, S5 and S6 are measured
and gated, and they are everything a Dockerfile says.

| target | files | S1 imports | S2 exports | S3 calls | S4 cycles | S5 references | S6 nodes |
|---|---|---|---|---|---|---|---|
| tiny-docker | 2 | n/a | 1.000 / 1.000 (tp 3) | n/a | n/a | 1.000 (tp 4, fp 0, fn 0) | 1.000 (tp 5, fp 0, fn 0) |
| docker-python | 42 | n/a | 1.000 / 1.000 (tp 42) | n/a | n/a | 1.000 (tp 42, fp 0, fn 0) | 1.000 (tp 84, fp 0, fn 0) |
| docker-node | 18 | n/a | 1.000 / 1.000 (tp 18) | n/a | n/a | 1.000 (tp 18, fp 0, fn 0) | 1.000 (tp 36, fp 0, fn 0) |

Read honestly, and `RESULTS.md` should say so:

- **The corpus is single-stage.** All 60 indexed Dockerfiles in the two repos carry exactly one
  `FROM`, none of them with an `AS` alias, so S2 measures one positional stage name per file and
  S5 measures 60 `from-image` edges to `ext:image/<ref>`, a real check that the tree-sitter
  extractor reads the same base reference dockerfile-ast reads, and no check at all of
  multi-stage naming, `copy-from` or `config`. Those three are covered by `fixtures/tiny-docker`
  and by `packages/core/test/extract-dockerfile.test.ts` only.
- **`config` resolves to nothing on either corpus.** A Dockerfile-only run indexes Dockerfiles,
  so the 18 `COPY docker-entrypoint.sh` sources name a file the map does not hold and are
  dropped on both sides. The refKind is real, and pays off exactly where it should, a repo
  whose config indexes both `dockerfile` and its application language.
- **Spec 5.1 counts 44 and 21; greplost indexes 42 and 18.** The five `Dockerfile-*.template`
  files are not Dockerfiles by `langOf`: `LANG_BY_BASENAME` matches `Dockerfile` exactly and
  `DOCKERFILE_PREFIX` matches `Dockerfile.`, and `Dockerfile-linux.template` is neither. Two of
  those five also carry the legacy `ENV NAME a b c` form that the vendored grammar cannot read
  (see ruling 6), so the counts in spec 5.1 are the `Dockerfile*` glob's, not the indexer's.
- Both corpora are **below the tier-S band** (roughly 100 files): 42 and 18, 60 together. No
  public repository carries 100 or more Dockerfiles, and spec 5.1 already says so; `RESULTS.md`
  labels both entries as below tier S rather than presenting them as full-size.

Rulings this leaf made, in full, with reasons, are in the leaf report; the five that change what
another leaf can assume are:

1. **An unnamed stage is named `~<index>`.** Spec 2.5 writes `#<index>` and `nodeId` refuses a
   `#` in a name, so the substitution leaf 2.8 already made (`gates/leaf-2.8.md`, ruling 2: "`~`
   replaces `#` everywhere spec 0.2 wrote an index suffix") is made here too. The index is a
   position, never a hash. This is *not* the `~<n>` duplicate suffix, which stays in the id
   alone: two stages written `AS x` are `#stage.x` and `#stage.x~2`, both named `x`.
2. **Every stage name is in `FileRecord.exports`; `Declaration.exported` is alias-only.** Spec
   2.5 fixes both halves, `Truth.exports` is "the file's sorted stage names", and `exported` is
   "true for a named stage, false otherwise", and they are different questions: `exported` says
   another Dockerfile can `COPY --from` this stage by name, while the export index is the
   surface the file declares, which `COPY --from=<index>` addresses positionally. It is also the
   only reading under which S2 is measurable on a corpus of single-stage Dockerfiles: with named
   stages only, `Truth.exports` is empty for all 60 files and `structural.ts` fails the gate
   with `truth-empty`.
3. **One `image` node, for the final stage only.** A build produces one image; every earlier
   stage is an intermediate it throws away. The name is the final stage's name, which matches
   `extract/yaml-k8s.ts`'s rule that an `image` node is named after the *local* thing (there,
   the container name), never after the image reference. The shared identity of an image across
   a Dockerfile and a manifest is the `ext:image/<ref>` target both leaves emit on a `from-image`
   edge, not a node name.
4. **A reference built from a build variable is dropped.** `FROM $BASE` names whatever the
   builder computes, so `ext:image/$BASE` would be an external node naming no image, the rule
   spec 2.3 already applies to a templated Kubernetes `image:`. `meta.base` still records the
   text as written.
5. **A `COPY`/`ADD` source resolves against two contexts and must agree.** Nothing greplost can
   read says which directory a build context is, so a source is probed against the Dockerfile's
   own directory and the repository root and resolves only when the two name **one** indexed
   file. A glob, an absolute path, a URL, `.` and anything holding `$` are refused before the
   probe. A source that names two different files is ambiguous and is dropped.
6. **The vendored grammar cannot read `ENV NAME a b c`** (a legacy value with spaces and no
   `=`): tree-sitter-dockerfile v0.2.0 wraps that instruction and every instruction after it in
   one `ERROR`. The extractor descends into `ERROR` nodes to recover what it can, the oracle
   (dockerfile-ast) reads the form correctly, and `bench/test/truth-dockerfile.test.ts` pins the
   difference as a measured miss rather than letting two parsers agree by construction. No file
   the two corpora index hits it.
7. **Nothing recovered from an `ERROR` region is published as if it had been read** (fix round
   1). The region begins at the instruction the grammar choked on and runs to the end of the
   file, so a declaration found inside it carries no `meta.default`, the value the parser
   managed to read is a prefix of the real one (`ENV NOTE a b c` gives `a`), and a file holding
   any `ERROR` gets **no `image` node at all**, because the final stage may be in the part that
   was lost (`FROM a AS one` / `ENV NOTE a b c` / `FROM a AS two` really builds `two`). Both are
   misses the oracle catches, never a wrong id.
8. **A stage cannot copy from itself** (fix round 1). `COPY --from=build` inside stage `build`
   names a stage, so it is not an image: `ext:image/build` would publish an external image
   nobody wrote. A `--from` text matching *any* stage name of the file, the owner included,
   resolves to that stage or is dropped; only a text naming no stage can become an image. The
   rule is implemented identically on both sides.
9. **The exec form of `COPY`/`ADD` contributes no source.** `COPY ["a", "b", "/d/"]` is a JSON
   array rather than a list of path arguments, and neither the extractor nor the oracle takes
   sources out of one, so it produces no `config` reference on either side. Stated in both
   module headers.

Three files outside this leaf's ownership were edited and are reported to the driver, each of
them a seam stub-test row that asserted this leaf was unimplemented:
`packages/core/test/references.test.ts` (the dockerfile extractor/resolver/reference stub rows,
replaced by the implemented-module assertions the other landed languages use),
`packages/core/test/extract-ts.test.ts` (the "extractor not implemented" example, now a dispatch
assertion, since no `Lang` is stubbed any more) and `bench/test/registry.test.ts` (the
"unimplemented oracle" example, moved on to `yaml-actions`, the last stub, which leaf 2.9 owns).

- [x] G1: the Dockerfile extraction test file passes
  CHECK: bun test packages/core/test/extract-dockerfile.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 80 expect() calls | Ran 33 tests across 1 file. [207.00ms]

- [x] G2: named and unnamed stages both get stable ids with `meta.index`; describe('stages')
  CHECK: bun test packages/core/test/extract-dockerfile.test.ts -t stages 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 30 expect() calls | Ran 9 tests across 1 file. [54.00ms]

- [x] G3: an external base image resolves to `ext:image/<ref>` and a sibling stage does not; describe('base images')
  CHECK: bun test packages/core/test/extract-dockerfile.test.ts -t "base images" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 7 expect() calls | Ran 5 tests across 1 file. [96.00ms]

- [x] G4: `COPY --from=<stage>` is a high-confidence edge to the named stage node; describe('copy from')
  CHECK: bun test packages/core/test/extract-dockerfile.test.ts -t "copy from" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 7 expect() calls | Ran 6 tests across 1 file. [129.00ms]

- [x] G5: top-level `ARG` and `ENV` become `arg.<N>` and `env.<N>` constants with literal defaults; describe('args')
  CHECK: bun test packages/core/test/extract-dockerfile.test.ts -t args 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 13 expect() calls | Ran 5 tests across 1 file. [56.00ms]

- [x] G6: the fixture builds with the expected stages, the final image node and every refKind; describe('tiny-docker')
  CHECK: bun test packages/core/test/extract-dockerfile.test.ts -t tiny-docker 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 23 expect() calls | Ran 8 tests across 1 file. [104.00ms]

- [x] G7: the Dockerfile truth generator test file passes
  CHECK: bun test bench/test/truth-dockerfile.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 56 expect() calls | Ran 14 tests across 1 file. [120.00ms]

- [x] G8: the oracle shares no code with `packages/core` and its output tracks the fixture; describe('oracle independence')
  CHECK: bun test bench/test/truth-dockerfile.test.ts -t "oracle independence" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 20 expect() calls | Ran 3 tests across 1 file. [87.00ms]

- [x] G9: S1 to S5 pass on the fixture
  CHECK: bun run bench:structural --fixture tiny-docker --lang dockerfile --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: S6  signal node precision                  >=0.95           1.000          tp 5, fp 0, fn 0 | structural: GATE PASS

- [x] G10: S1 to S5 pass on the first pinned corpus repo (docker-python, whole repo, 44 Dockerfiles)
  CHECK: bun bench/src/cli.ts corpus setup --repo docker-python >/dev/null && bun run bench:structural --repo docker-python --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: S6  signal node precision                  >=0.95           1.000          tp 84, fp 0, fn 0 | structural: GATE PASS

- [x] G11: S1 to S5 pass on the second pinned corpus repo (docker-node, whole repo, 21 Dockerfiles)
  CHECK: bun bench/src/cli.ts corpus setup --repo docker-node >/dev/null && bun run bench:structural --repo docker-node --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: S6  signal node precision                  >=0.95           1.000          tp 36, fp 0, fn 0 | structural: GATE PASS

- [x] G12: the core and bench suites are green
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 6006 expect() calls | Ran 1566 tests across 46 files. [75.44s]

- [x] G13: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: (no output)
