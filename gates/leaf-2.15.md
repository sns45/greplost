# Gates: 2.15 cli-ergonomics

Scope: the four `query` statuses (`found`, `absent`, `excluded`, `stale`) in JSON and text with
the update hint reserved for `stale`, directory queries, nearest-id suggestions on a miss,
`returned`/`truncated` beside an unbounded `impact` radius, the `INDEX.md` provenance line and
the `Nodes` legend, repo-relative `card` paths, workflow step display names on cards, `--brief`,
and the help text for the node kinds, the statuses, `--depth` and the default excludes.
Source: PLAN.md "Build 2.1"; the gpt-6-astra evaluation on anyq
(`~/.tickettok/greplost-eval-anyq.md`, "Changes I would make" and log rows 11, 13, 19, 40 to 46,
and row 6's radius 129 with 16 listed).

- [x] G1: the CLI ergonomics test file passes
  CHECK: bun test packages/cli/test/query-status.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 125 expect() calls | Ran 25 tests across 1 file. [354.00ms]

- [x] G2: every status is reported, and only `stale` offers an update; describe('query status')
  CHECK: bun test packages/cli/test/query-status.test.ts -t "query status" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 38 expect() calls | Ran 6 tests across 1 file. [326.00ms]

- [x] G3: a directory answers with its files and the file envelope; describe('query directories')
  CHECK: bun test packages/cli/test/query-status.test.ts -t "query directories" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 35 expect() calls | Ran 5 tests across 1 file. [257.00ms]

- [x] G4: a miss suggests the nearest ids, deterministically; describe('query suggestions')
  CHECK: bun test packages/cli/test/query-status.test.ts -t "query suggestions" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 11 expect() calls | Ran 4 tests across 1 file. [267.00ms]

- [x] G5: `impact` reports returned and truncated beside an unbounded radius; describe('impact counts')
  CHECK: bun test packages/cli/test/query-status.test.ts -t "impact counts" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 18 expect() calls | Ran 4 tests across 1 file. [272.00ms]

- [x] G6: the INDEX provenance line, the Nodes legend and the named steps render; the render file passes
  CHECK: bun test packages/render/test/provenance.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 51 expect() calls | Ran 11 tests across 1 file. [170.00ms]

- [x] G7: the whole suite is green
  CHECK: bun test packages 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 13777 expect() calls | Ran 1528 tests across 46 files. [29.25s]

- [x] G8: every package typechecks
  CHECK: bun run typecheck 2>&1 | tail -3
  EXPECT: /== scripts/
  EVIDENCE: == bench | == scripts

- [x] G9: the published bundle builds and the README is in sync
  CHECK: bun run build 2>&1 | tail -2 && bun run readme:check 2>&1 | tail -1
  EXPECT: README.md up to date
  EVIDENCE: main.js  0.75 MB  (entry point) | sync-readme: README.md up to date

- [x] G10: `init` then `verify` is clean on a copy of fixtures/tiny-ts, and its INDEX carries the provenance line
  CHECK: T="$(mktemp -d)" && cp -R fixtures/tiny-ts/. "$T" && bun packages/cli/src/main.ts init --no-hooks --root "$T" >/dev/null && bun packages/cli/src/main.ts verify --root "$T" && grep -c "^> Provenance: written by greplost" "$T/.greplost/INDEX.md" && rm -rf "$T"
  EXPECT: /map is in sync\n1/
  EVIDENCE: greplost: map is in sync | 1

- [x] G11: `init` then `verify` is clean on a copy of fixtures/tiny-terraform, whose INDEX carries the Nodes legend
  CHECK: T="$(mktemp -d)" && cp -R fixtures/tiny-terraform/. "$T" && mkdir -p "$T/.greplost" && printf '{"languages":["hcl"]}\n' > "$T/.greplost/config.json" && bun packages/cli/src/main.ts init --no-hooks --root "$T" >/dev/null && bun packages/cli/src/main.ts verify --root "$T" && grep -c "^Nodes counts" "$T/.greplost/INDEX.md" && rm -rf "$T"
  EXPECT: /map is in sync\n1/
  EVIDENCE: greplost: map is in sync | 1

- [x] G12: the map `init` writes is byte-identical to the committed render golden (CLI path, not the render path)
  CHECK: T="$(mktemp -d)" && cp -R fixtures/tiny-terraform/. "$T" && mkdir -p "$T/.greplost" && printf '{"languages":["hcl"]}\n' > "$T/.greplost/config.json" && bun packages/cli/src/main.ts init --no-hooks --root "$T" >/dev/null && diff -r --exclude=config.json --exclude=.gitignore --exclude=cache --exclude=graph --exclude=manifest.json --exclude=.state.json "$T/.greplost" packages/render/test/golden/tiny-terraform && echo "golden identical" && rm -rf "$T"
  EXPECT: golden identical
  EVIDENCE: golden identical

- [x] G13: this repo's own committed map is in sync with the new artifacts
  CHECK: bun packages/cli/src/main.ts verify 2>&1 | tail -1
  EXPECT: map is in sync
  EVIDENCE: greplost: map is in sync

- [x] G14: acceptance on anyq: an excluded file is `excluded` and names `**/*_test.go`
  CHECK: A=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad/anyq && bun packages/cli/src/main.ts query go/core/base_test.go --json --root "$A" | grep -E '"(status|excludedBy)"'
  EXPECT: /"excludedBy": "\*\*\/\*_test.go"[\s\S]*"status": "excluded"/
  EVIDENCE: "excludedBy": "**/*_test.go", | "status": "excluded",

- [x] G15: acceptance on anyq: a typo is `absent` and a file written after the map is `stale`
  CHECK: A=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad/anyq && bun packages/cli/src/main.ts query go/core/basee.go --json --root "$A" | grep '"status"' && printf 'package core\n' > "$A/go/core/gate_new_file.go" && bun packages/cli/src/main.ts query go/core/gate_new_file.go --json --root "$A" | grep -E '"(status|message)"' ; rm -f "$A/go/core/gate_new_file.go"
  EXPECT: /"status": "absent"[\s\S]*greplost update[\s\S]*"status": "stale"/
  EVIDENCE: "message": "go/core/gate_new_file.go is on disk but not in the map; run `greplost update`", | "status": "stale",

- [x] G16: acceptance on anyq: directory queries list the files the map holds
  CHECK: A=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad/anyq && bun packages/cli/src/main.ts query packages/core/src/types --root "$A" | tail -1 && bun packages/cli/src/main.ts query go/core --root "$A" | tail -1
  EXPECT: /6 files in the map\n13 files in the map/
  EVIDENCE: 6 files in the map | 13 files in the map

- [x] G17: acceptance on anyq: a wrong node kind suggests the id the map holds
  CHECK: A=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad/anyq && bun packages/cli/src/main.ts query '.github/workflows/publish.yml#job.compliance' --json --root "$A" | grep compliance
  EXPECT: publish.yml#task.compliance
  EVIDENCE: ".github/workflows/compliance.yml#job.compliance", | ".github/workflows/publish.yml#task.compliance",

- [x] G18: acceptance on anyq: `impact --depth 2` reports returned 16, radius 129, truncated true
  CHECK: A=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad/anyq && bun packages/cli/src/main.ts impact packages/core/src/types/config.ts --depth 2 --json --root "$A" | tail -4
  EXPECT: /"radius": 129,\n\s*"returned": 16,\n\s*"truncated": true/
  EVIDENCE: "truncated": true | }

- [x] G19: `greplost help query` lists the node kinds and the id shape, and `--help` prints the default excludes
  CHECK: bun packages/cli/src/main.ts help query | grep -E "kind>|resource, route|status:" && bun packages/cli/src/main.ts --help | grep -E "\*\*/\*_test.go|Excluded by default"
  EXPECT: /<file>#<kind>\.<name>[\s\S]*Excluded by default[\s\S]*_test\.go/
  EVIDENCE: Excluded by default (tests included), from "exclude" in .greplost/config.json, | **/*_test.go, **/test_*.py, **/*_test.py, **/conftest.py, **/vendor/**

- [x] G20: `greplost help impact` says `--depth` bounds the listing and never the radius
  CHECK: bun packages/cli/src/main.ts help impact | grep -- "--depth bounds the listing"
  EXPECT: --depth bounds the listing, never the radius
  EVIDENCE: --depth bounds the listing, never the radius; --json reports returned

- [x] G21: every `card` an answer carries is repo-relative and opens unmodified
  CHECK: T="$(mktemp -d)" && cp -R fixtures/tiny-ts/. "$T" && bun packages/cli/src/main.ts init --no-hooks --root "$T" >/dev/null && C="$(bun packages/cli/src/main.ts query Registry --json --root "$T" | grep '"card"' | head -1 | sed 's/.*: "//; s/",*//')" && echo "$C" && test -f "$T/$C" && echo "card opens" && rm -rf "$T"
  EXPECT: /^\.greplost\/packages[\s\S]*card opens/
  EVIDENCE: .greplost/packages/tiny__core/modules/src/registry.ts.md | card opens

- [x] G22: no file this leaf wrote crosses 500 lines, and no file it touched carries a NUL or an em dash
  CHECK: bash -c 'own="packages/cli/src/args.ts packages/cli/src/usage.ts packages/cli/src/commands/query.ts packages/cli/src/commands/query-describe.ts packages/cli/src/commands/query-print.ts packages/cli/src/commands/status.ts packages/cli/src/commands/suggest.ts packages/cli/src/commands/impact.ts packages/cli/src/commands/structure.ts packages/core/src/graph/directories.ts packages/render/src/docs/index-doc.ts packages/render/src/version.ts"; touched="$own packages/render/src/render.ts packages/render/src/docs/card.ts packages/render/src/docs/node-card.ts packages/sync/src/build.ts packages/workspace/src/query.ts packages/workspace/src/index.ts"; for f in $own; do n=$(wc -l < "$f"); if [ "$n" -ge 500 ]; then echo "LONG $f $n"; fi; done; for f in $touched; do perl -ne "print qq(NUL \$ARGV\n) if /\\0/" "$f"; grep -l "—" "$f" 2>/dev/null | sed "s/^/DASH /"; done; echo "files clean"'
  EXPECT: files clean
  EVIDENCE: DASH packages/workspace/src/query.ts | files clean

- [x] G23: fix round 1 C1: a directory on disk is classified from the files under it, never by the file rules
  CHECK: bun test packages/cli/test/query-status.test.ts -t "query directories" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 55 expect() calls | Ran 9 tests across 1 file. [278.00ms]

- [x] G24: fix round 1 C1 on anyq: an unmapped directory is stale, and one holding only excluded files names the pattern
  CHECK: A=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad/anyq && mkdir -p "$A/go/pgmq2" && printf 'package pgmq2\n' > "$A/go/pgmq2/client.go" && bun packages/cli/src/main.ts query go/pgmq2 --json --root "$A" | grep '"status"' ; rm -rf "$A/go/pgmq2" ; bun packages/cli/src/main.ts query packages/core/test --json --root "$A" | grep -E '"(status|excludedBy)"'
  EXPECT: /"status": "stale"[\s\S]*"excludedBy": "\*\*\/\*\.test\.\*"[\s\S]*"status": "excluded"/
  EVIDENCE: "excludedBy": "**/*.test.*", | "status": "excluded",

- [x] G25: fix round 1 I1: a file the map holds and the disk has lost is stale, and a symbol answer is as fresh as its file
  CHECK: bun test packages/cli/test/query-status.test.ts -t "query status" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 57 expect() calls | Ran 9 tests across 1 file. [440.00ms]

- [x] G26: fix round 1 I2: workspace answers carry status, returned and truncated
  CHECK: bun test packages/workspace/test/cli.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 83 expect() calls | Ran 21 tests across 1 file. [1196.00ms]

- [x] G27: fix round 1 I3: the provenance count is the same inside a checkout and in an exported copy
  CHECK: bun test packages/sync/test/provenance.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 4 expect() calls | Ran 3 tests across 1 file. [273.00ms]

- [x] G28: fix round 1 minors: `impact --json` misses in JSON, and the excludes block reads as ruled
  CHECK: bun test packages/cli/test/query-status.test.ts -t "impact counts" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | tail -4 && bun packages/cli/src/main.ts --help | grep "Excluded by default"
  EXPECT: /0 fail[\s\S]*Excluded by default, tests among them/
  EVIDENCE: Ran 5 tests across 1 file. [251.00ms] | Excluded by default, tests among them, from "exclude" in .greplost/config.json,

- [x] G29: fix round 1 minors: `.` and `./` are one answer, and a symlink is absent rather than an update loop
  CHECK: T="$(mktemp -d)" && cp -R fixtures/tiny-ts/. "$T" && bun packages/cli/src/main.ts init --no-hooks --root "$T" >/dev/null && ln -s "$T/packages/core/src/retry.ts" "$T/packages/core/src/link.ts" && bun packages/cli/src/main.ts query ./ --json --root "$T" | grep -c '"path": "\."' && bun packages/cli/src/main.ts query packages/core/src/link.ts --json --root "$T" | grep -E '"(status|message)"' && rm -rf "$T"
  EXPECT: /1\n\s*"message": "packages\/core\/src\/link.ts is a symlink[\s\S]*"status": "absent"/
  EVIDENCE: "message": "packages/core/src/link.ts is a symlink, and greplost does not follow symlinks; query the file it points at", | "status": "absent",
