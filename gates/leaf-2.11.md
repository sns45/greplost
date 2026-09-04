# Gates: 2.4.1 nodes

Scope: render and CLI support for non-file nodes: `nodeSlug`/`nodeCardPath`, the node card, the
file card's Nodes block, the package MAP and INDEX node columns, `nodesOf`/`referencesOf`/
`referencedBy`/`impactPairs`, and `greplost query`/`greplost impact` on a node id. A non-file
node is a `Declaration` in `graph/symbols.jsonl` and never a manifest entry, and no artifact path
ever contains a `#`. Spec:
`docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 0.2 and 4.1 to 4.6.

- [ ] G1: the render node test file passes
  CHECK: bun test packages/render/test/nodes.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G2: a repo with no nodes renders byte-identically to the build-1 golden; describe('no nodes no change')
  CHECK: bun test packages/render/test/nodes.test.ts -t "no nodes no change" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G3: a node card is a sibling of its file card, is slugged, and contains no `#`; describe('node card path')
  CHECK: bun test packages/render/test/nodes.test.ts -t "node card path" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G4: the node card carries Kind, In file, Attributes, References, Referenced by, Blast radius and Source; describe('node card')
  CHECK: bun test packages/render/test/nodes.test.ts -t "node card" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G5: the file card gains a Nodes block between Key symbols and Calls, capped and omitted when empty; describe('file card nodes block')
  CHECK: bun test packages/render/test/nodes.test.ts -t "file card nodes block" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G6: two artifacts never claim one path; describe('card path collisions')
  CHECK: bun test packages/render/test/nodes.test.ts -t "card path collisions" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G7: the tiny-terraform render matches its golden artifact for artifact; describe('golden tiny-terraform')
  CHECK: bun test packages/render/test/nodes.test.ts -t "golden tiny-terraform" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G8: no path under a rendered map contains a `#`, directories included
  CHECK: d=$(mktemp -d) && cp -R fixtures/tiny-terraform/. "$d" && bun packages/cli/src/main.ts init --no-hooks --root "$d" >/dev/null && find "$d/.greplost" -name '*#*' | wc -l | tr -d ' '
  EXPECT: /^0$/

- [ ] G9: the CLI node test file passes
  CHECK: bun test packages/cli/test/nodes.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G10: a candidate containing `#` is never treated as a path; describe('looksLikePath rejects hashes')
  CHECK: bun test packages/cli/test/nodes.test.ts -t "looksLikePath rejects hashes" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G11: `impact` on a file still returns `files` and never `nodes`; describe('file target unchanged')
  CHECK: bun test packages/cli/test/nodes.test.ts -t "file target unchanged" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] G12: the render, core and cli suites are green
  CHECK: bun test packages/render packages/core packages/cli 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] G13: render, core and cli typecheck
  CHECK: bunx tsc -p packages/render/tsconfig.json --noEmit && bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p packages/cli/tsconfig.json --noEmit
