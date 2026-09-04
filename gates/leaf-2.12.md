# Gates: 2.5.1 coverage-docs

Scope: the per-language bench report (`perLang` payload, the "Languages, IaC and signals" section
of `bench/RESULTS.md`), the head-to-head scope statement, the README language list, the
`structural-langs` CI job, the Appendix C rulings, and this repo's own dogfood map after
`.greplost/config.json` gains `yaml` and `dockerfile`. Every measured number comes from a
committed payload; a measured number is never filled in by hand, which is the kickoff rule in
`docs/greplost-tech-spec.md`. Spec:
`docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 5.1 to 5.5.

- [ ] G1: the per-language structural test file passes
  CHECK: bun test bench/test/structural-langs.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G2: the payload carries one entry per language with its repos, truth source and gated flag; describe('per-lang targets')
  CHECK: bun test bench/test/structural-langs.test.ts -t "per-lang targets" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G3: an unsupported metric prints `n/a` and is neither a pass nor a fail; describe('n/a metrics')
  CHECK: bun test bench/test/structural-langs.test.ts -t "n/a metrics" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G4: reference and signal-node precision are scored and gated; describe('S5 and S6')
  CHECK: bun test bench/test/structural-langs.test.ts -t "S5 and S6" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G5: `--fixture` and `--fixture-go` keep their build-1 meaning; describe('build-1 flags still work')
  CHECK: bun test bench/test/structural-langs.test.ts -t "build-1 flags still work" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G6: RESULTS.md states the head-to-head scope in one sentence
  CHECK: grep -c 'X1 to X10 cover TypeScript and Go only' bench/RESULTS.md
  EXPECT: /^[1-9]/

- [ ] G7: RESULTS.md regenerates byte-identically from the committed payloads
  CHECK: bun run bench:report --dry-run >/dev/null 2>&1 && git diff --exit-code --quiet -- bench/RESULTS.md && echo "results: regenerates byte-identically"
  EXPECT: results: regenerates byte-identically

- [ ] G8: a dry run of every suite writes a RESULTS.md with every section present
  CHECK: bun run bench:all --dry-run 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -q 'report: wrote bench/RESULTS.md' && for s in "## Machine" "## Corpus" "## Versions" "## Head-to-head" "## Single-tool" "## Languages, IaC and signals" "## Map quality"; do grep -qF "$s" bench/RESULTS.md || { echo "MISSING $s"; exit 1; }; done; echo "sections: all present"
  EXPECT: sections: all present

- [ ] G9: the README is in step with RESULTS.md and every image it names exists
  CHECK: bun run readme:check 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: sync-readme: README.md up to date

- [ ] G10: Appendix C carries a row for each of the six build-2 rulings
  CHECK: f=$(mktemp) && sed -n '/^## Appendix C/,$p' docs/greplost-tech-spec.md > "$f" && for r in "SCHEMA_VERSION" "node id" "Helm template" "Kotlin" "Dockerfile corpus" "head-to-head"; do grep -qi "$r" "$f" || { echo "MISSING $r"; exit 1; }; done; echo "rulings: 6 of 6"
  EXPECT: rulings: 6 of 6

- [ ] G11: greplost verifies its own committed map after the config gained `yaml` and `dockerfile`
  CHECK: bun run build >/dev/null && bunx greplost verify --diff 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: map is in sync

- [ ] G12: the full suite is green from a frozen install
  CHECK: bun install --frozen-lockfile >/dev/null && bun test 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G13: every package typechecks
  CHECK: bun run typecheck
