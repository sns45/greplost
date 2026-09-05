# Gates: 2.5.1 coverage-docs

Scope: the per-language bench report (`perLang` payload, the "Languages, IaC and signals" section
of `bench/RESULTS.md`), the head-to-head scope statement, the README language list, the
`structural-langs` CI job, the Appendix C rulings, and this repo's own dogfood map after
`.greplost/config.json` gains `yaml` and `dockerfile`. Every measured number comes from a
committed payload; a measured number is never filled in by hand, which is the kickoff rule in
`docs/greplost-tech-spec.md`. Spec:
`docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 5.1 to 5.5.

## Measured numbers (tier S, every pinned corpus, at the merge commit)

`bun run bench:structural --tier S --gate` over all 17 tier-S repos: **GATE PASS**, nothing
missed. The payload behind the published table is committed as
`bench/results/structural-<date>-<sha>.json`; the table below is what `langRows` reads out of
it, precision per metric, worst repo per language. `n/a` is a metric the language's oracle
declared unsupported or produced no number for.

| lang | corpus | files | S1 | S2 | S3 | S4 | S5 | S6 | scored |
|---|---|---|---|---|---|---|---|---|---|
| dockerfile | docker-node, docker-python | 60 | n/a | 1.000 | n/a | n/a | 1.000 | 1.000 | gated |
| go | gin, pulumi-go | 97 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 (n/a for gin) | 1.000 (n/a for gin) | gated |
| hcl | tf-aws-eks, tf-aws-vpc | 164 | 1.000 | 1.000 | n/a | 1.000 | 1.000 | 1.000 | gated |
| java | gson | 95 | 1.000 | 1.000 | 1.000 | 1.000 | n/a | n/a | gated |
| kotlin | coroutines | 163 | n/a | n/a | n/a | n/a | n/a | n/a | reported |
| python | pydantic | 105 | 1.000 | 1.000 | 1.000 | 1.000 | n/a | n/a | gated |
| rust | ripgrep | 95 | 1.000 | 1.000 | 1.000 | 1.000 | n/a | n/a | gated |
| ts | anyq, pulumi-ts | 268 | 1.000 | 0.996 | 1.000 | 1.000 | 1.000 (n/a for anyq) | 1.000 (n/a for anyq) | gated |
| tsx | next-app, tanstack-start | 730 | 0.998 | 1.000 | 1.000 | 1.000 | 0.992 | 1.000 | gated |
| yaml | bitnami-charts, k8s-examples, starter-workflows | 562 | n/a | 1.000 | n/a | n/a | 1.000 | 1.000 | gated |

Kotlin has no accuracy gate at all, so its gate is the three substitute checks, and the run
prints them: deterministic rebuild pass, parse error rate 0.0000, silent files 0.

Read honestly, and `RESULTS.md` says so under the table:

- **A language's cell is the worst of its repos**, never an average: the minimum is a number the
  payload carries and is what the gate decided on, and an average would hide the weaker half.
- **A metric a repo declared unsupported contributes nothing to it**, not even a number sitting
  in its block. The Helm oracle declares `unsupported:S6` on the chart corpus while recording an
  S6 precision of 0; letting that into the yaml row would publish, as a score, a number the
  oracle itself says is meaningless.
- **The precision column is not the whole gate.** S1 and S2 gate on recall as well, and the
  per-repo recall and tp/fp/fn counts stay in Eval 1, where there is room for them.
- **No competitor arm exists for any of these languages.** The sentence saying so sits directly
  under the X table.

## Ruling: the `m` flag sweep (driver ruling 2026-09-05)

`gate-check.mjs` matches `EXPECT` against stdout **plus** stderr, so an anchored regex needs the
`m` flag. G6 here was `/^[1-9]/` and now reads `/^[1-9]/m`. The sweep of `gates/*.md` reported
four more, in ledgers this leaf does not own and must not commit: `gates/root-2.md` T7,
`gates/node-2.5.md` N6 and N9, and `gates/root.md` T3. **The driver applied all four in 5e39ca0**,
and a re-sweep at this commit finds no start-anchored `EXPECT` left without the flag. Nothing is
outstanding; the entry stays because the ruling asked for the sweep to be recorded.

- [x] G1: the per-language structural test file passes
  CHECK: bun test bench/test/structural-langs.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 85 expect() calls | Ran 24 tests across 1 file. [126.00ms]

- [x] G2: the payload carries one entry per language with its repos, truth source and gated flag; describe('per-lang targets')
  CHECK: bun test bench/test/structural-langs.test.ts -t "per-lang targets" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 34 expect() calls | Ran 6 tests across 1 file. [110.00ms]

- [x] G3: an unsupported metric prints `n/a` and is neither a pass nor a fail; describe('n/a metrics')
  CHECK: bun test bench/test/structural-langs.test.ts -t "n/a metrics" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 17 expect() calls | Ran 6 tests across 1 file. [109.00ms]

- [x] G4: reference and signal-node precision are scored and gated; describe('S5 and S6')
  CHECK: bun test bench/test/structural-langs.test.ts -t "S5 and S6" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 13 expect() calls | Ran 4 tests across 1 file. [108.00ms]

- [x] G5: `--fixture` and `--fixture-go` keep their build-1 meaning; describe('build-1 flags still work')
  CHECK: bun test bench/test/structural-langs.test.ts -t "build-1 flags still work" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 13 expect() calls | Ran 4 tests across 1 file. [106.00ms]

- [x] G6: RESULTS.md states the head-to-head scope in one sentence
  CHECK: grep -c 'X1 to X10 cover TypeScript and Go only' bench/RESULTS.md
  EXPECT: /^[1-9]/m
  EVIDENCE: 1

- [x] G7: RESULTS.md regenerates byte-identically from the committed payloads
  CHECK: bun run bench:report --dry-run >/dev/null 2>&1 && git diff --exit-code --quiet -- bench/RESULTS.md && echo "results: regenerates byte-identically"
  EXPECT: results: regenerates byte-identically
  EVIDENCE: results: regenerates byte-identically

- [x] G8: a dry run of every suite writes a RESULTS.md with every section present
  CHECK: bun run bench:all --dry-run 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -q 'report: wrote bench/RESULTS.md' && for s in "## Machine" "## Corpus" "## Versions" "## Head-to-head" "## Single-tool" "## Languages, IaC and signals" "## Map quality"; do grep -qF "$s" bench/RESULTS.md || { echo "MISSING $s"; exit 1; }; done; echo "sections: all present"
  EXPECT: sections: all present
  EVIDENCE: sections: all present

- [x] G9: the README is in step with RESULTS.md and every image it names exists
  CHECK: bun run readme:check 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: sync-readme: README.md up to date
  EVIDENCE: $ bun scripts/sync-readme.ts --check | sync-readme: README.md up to date

- [x] G10: Appendix C carries a row for each of the six build-2 rulings
  CHECK: f=$(mktemp) && sed -n '/^## Appendix C/,$p' docs/greplost-tech-spec.md > "$f" && for r in "SCHEMA_VERSION" "node id" "Helm template" "Kotlin" "Dockerfile corpus" "head-to-head"; do grep -qi "$r" "$f" || { echo "MISSING $r"; exit 1; }; done; echo "rulings: 6 of 6"
  EXPECT: rulings: 6 of 6
  EVIDENCE: rulings: 6 of 6

- [x] G11: greplost verifies its own committed map after the config gained `yaml` and `dockerfile`
  CHECK: bun run build >/dev/null && bunx greplost verify --diff 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: map is in sync
  EVIDENCE: greplost: map is in sync

- [x] G12: the full suite is green from a frozen install
  CHECK: bun install --frozen-lockfile >/dev/null && bun test 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 17272 expect() calls | Ran 2116 tests across 66 files. [89.45s]

- [x] G13: every package typechecks
  CHECK: bun run typecheck
  EVIDENCE: == packages/core == packages/render == packages/sync == packages/cli == packages/semantic == packages/workspace == bench == scripts (tsc --noEmit, 0 errors)
