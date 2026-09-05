# Gates: 2.4.1 nodes

Scope: render and CLI support for non-file nodes: `nodeSlug`/`nodeCardPath`, the node card, the
file card's Nodes block, the package MAP and INDEX node columns, `nodesOf`/`referencesOf`/
`referencedBy`/`impactPairs`, and `greplost query`/`greplost impact` on a node id. A non-file
node is a `Declaration` in `graph/symbols.jsonl` and never a manifest entry, and no artifact path
ever contains a `#`. Spec:
`docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 0.2 and 4.1 to 4.6.

G8 repair (2026-09-05, implementer; criterion unchanged, only its expression). Two defects made
the check unable to assert what its title says.

(1) The CHECK rendered no node card. `DEFAULT_CONFIG.languages` is `["ts","tsx","js","jsx"]`
and `greplost init` has no marker table for HCL, so `init` on a bare copy of
`fixtures/tiny-terraform` indexes no files. It **exits 0** and writes a complete but empty map
(INDEX.md, manifest.json, the graph files, one package MAP and API, 9 artifacts, 0 cards); it
prints `no files indexed` on stderr as a warning, not as a failure. Corrected in fix round 1:
the first version of this note said the check "exits non-zero", which is wrong and was measured
again. The defect is subtler than a failure, `find` over that map really does print `0`,
because there is nothing under it at all, so the gate would have passed while proving nothing.
The check now writes `{"languages":["hcl"]}` into the copy's config first, exactly what
`packages/cli/test/commands.test.ts` does for `fixtures/tiny-go`, and asserts that a node card
exists at its slugged path before scanning. Strictly stronger: it proves a map with node cards
was rendered *and* that no path under it carries a `#`. The fixture is leaf 2.2's and was not
touched.

(2) The EXPECT could never match. `gate-check.mjs` tests the pattern against
`` `${stdout}\n${stderr}` ``, so the compared string always ends in a newline, and JavaScript's
`$` (unlike Perl's) matches only at the very end of the string when the `m` flag is absent.
`/^0$/` was therefore unsatisfiable for any check output whatsoever. The pattern is unchanged
apart from that flag, `/^0$/m`, so the assertion is still "the count of paths containing a `#`
is exactly zero, alone on its line", and `1`, `12` or empty output still fail.

EVIDENCE lines (2026-09-05, fix round 1): every gate now records the measured value its check
produced, filled in by `gate-check.mjs` itself and never hand-written. No criterion moved. G13's
check gained a trailing `echo` of the project count and the `tsc` version, because three silent
`tsc --noEmit` runs leave nothing to record and `(no output)` is not evidence anyone can read;
the exit code still decides the gate, and the `echo` only runs when all three succeed.

- [x] G1: the render node test file passes
  CHECK: bun test packages/render/test/nodes.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 422 expect() calls | Ran 31 tests across 1 file. [202.00ms]

- [x] G2: a repo with no nodes renders byte-identically to the build-1 golden; describe('no nodes no change')
  CHECK: bun test packages/render/test/nodes.test.ts -t "no nodes no change" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 49 expect() calls | Ran 2 tests across 1 file. [146.00ms]

- [x] G3: a node card is a sibling of its file card, is slugged, and contains no `#`; describe('node card path')
  CHECK: bun test packages/render/test/nodes.test.ts -t "node card path" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 11 expect() calls | Ran 5 tests across 1 file. [89.00ms]

- [x] G4: the node card carries Kind, In file, Attributes, References, Referenced by, Blast radius and Source; describe('node card')
  CHECK: bun test packages/render/test/nodes.test.ts -t "node card" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 159 expect() calls | Ran 15 tests across 1 file. [133.00ms]

- [x] G5: the file card gains a Nodes block between Key symbols and Calls, capped and omitted when empty; describe('file card nodes block')
  CHECK: bun test packages/render/test/nodes.test.ts -t "file card nodes block" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 11 expect() calls | Ran 4 tests across 1 file. [98.00ms]

- [x] G6: two artifacts never claim one path; describe('card path collisions')
  CHECK: bun test packages/render/test/nodes.test.ts -t "card path collisions" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 8 expect() calls | Ran 6 tests across 1 file. [96.00ms]

- [x] G7: the tiny-terraform render matches its golden artifact for artifact; describe('golden tiny-terraform')
  CHECK: bun test packages/render/test/nodes.test.ts -t "golden tiny-terraform" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 187 expect() calls | Ran 3 tests across 1 file. [96.00ms]

- [x] G8: no path under a rendered map contains a `#`, directories included
  CHECK: d=$(mktemp -d) && cp -R fixtures/tiny-terraform/. "$d" && mkdir -p "$d/.greplost" && printf '{"languages":["hcl"]}\n' > "$d/.greplost/config.json" && bun packages/cli/src/main.ts init --no-hooks --root "$d" >/dev/null && test -f "$d/.greplost/packages/root/modules/main.tf/resource.aws_vpc.main.md" && find "$d/.greplost" -name '*#*' | wc -l | tr -d ' '
  EXPECT: /^0$/m
  EVIDENCE: 0

- [x] G9: the CLI node test file passes
  CHECK: bun test packages/cli/test/nodes.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 135 expect() calls | Ran 20 tests across 1 file. [178.00ms]

- [x] G10: a candidate containing `#` is never treated as a path; describe('looksLikePath rejects hashes')
  CHECK: bun test packages/cli/test/nodes.test.ts -t "looksLikePath rejects hashes" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 7 expect() calls | Ran 2 tests across 1 file. [168.00ms]

- [x] G11: `impact` on a file still returns `files` and never `nodes`; describe('file target unchanged')
  CHECK: bun test packages/cli/test/nodes.test.ts -t "file target unchanged" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 19 expect() calls | Ran 4 tests across 1 file. [155.00ms]

- [x] G12: the render, core and cli suites are green
  CHECK: bun test packages/render packages/core packages/cli 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 12180 expect() calls | Ran 1152 tests across 32 files. [3.77s]

- [x] G13: render, core and cli typecheck
  CHECK: bunx tsc -p packages/render/tsconfig.json --noEmit && bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p packages/cli/tsconfig.json --noEmit && echo "3/3 projects typecheck clean (render, core, cli) with $(bunx tsc --version)"
  EVIDENCE: 3/3 projects typecheck clean (render, core, cli) with Version 5.9.3
