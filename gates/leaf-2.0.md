# Gates: 2.0 seam

Scope: schema 2, `langOf`, the seven vendored grammars, the extraction/resolution/reference
dispatch tables with a throwing stub per language, the signal-pass registry, the reference
linker and `graph/references.jsonl`, the truth registry and fixture table, the widened bench
harness, the 15 build-2 corpus entries, and every golden regenerated for `"version": "2"`.
Spec: `docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 0.1 to 0.6
and 5.2. Nothing in waves 1 to 3 may start until every box here is checked.

- [x] G1: language detection covers extensions, basenames and the Dockerfile prefix; describe('langOf')
  CHECK: bun test packages/core/test/lang.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [x] G2: every vendored grammar loads and parses a one-liner with no root ERROR; describe('grammars')
  CHECK: bun test packages/core/test/parser.test.ts -t grammars 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [x] G3: all seven build-2 grammars are vendored and named in VERSIONS.txt
  CHECK: for g in python rust java kotlin yaml hcl dockerfile; do test -s "packages/core/grammars/tree-sitter-$g.wasm" && grep -q "tree-sitter-$g.wasm" packages/core/grammars/VERSIONS.txt || { echo "MISSING $g"; exit 1; }; done; echo "grammars: 7 of 7"
  EXPECT: grammars: 7 of 7

- [x] G4: schema 2 is live and node ids round-trip; describe('node ids')
  CHECK: bun test packages/core/test/references.test.ts -t "node ids" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [x] G5: a repo with no references writes no references.jsonl and an unchanged artifact set; describe('absent references file')
  CHECK: bun test packages/core/test/references.test.ts -t "absent references file" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [x] G6: every unimplemented language fails loudly, never silently; describe('stubs')
  CHECK: bun test packages/core/test/references.test.ts -t stubs 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [x] G7: the truth registry loads by convention and names the missing module in its error; describe('loadTruth')
  CHECK: bun test bench/test/registry.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [x] G8: every build-2 fixture name in FIXTURES has a language and a directory; describe('fixtures table')
  CHECK: bun test bench/test/registry.test.ts -t "fixtures table" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [x] G9: all 15 build-2 corpus entries parse, carry a 40-hex sha and a known lang
  CHECK: bun test bench/test/corpus.test.ts -t "every build-2 entry resolves" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [x] G10: the build-1 TypeScript structural gate still passes unchanged
  CHECK: bun run bench:structural --fixture --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [x] G11: the build-1 Go structural gate still passes unchanged
  CHECK: bun run bench:structural --fixture-go --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [x] G12: every build-1 branch ledger is still fully met
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status gates/node-1.1.md gates/node-1.2.md gates/node-1.3.md gates/node-1.4.md gates/node-1.5.md gates/leaf-1.6.md gates/leaf-1.7.md gates/leaf-1.8.md
  EXPECT: ALL MET

- [x] G13: the only change in every regenerated golden is the schema version
  CHECK: git diff --unified=0 main -- packages/core/test/golden packages/render/test/golden | grep -E '^[-+][^-+]' | grep -vc '"version"' | sed 's/^/golden lines changed outside the version field: /'
  EXPECT: golden lines changed outside the version field: 0
  NOTE (leaf 2.0, gate repair, not a weakening): the requirement is unchanged - zero changed
  golden lines outside the version field - but the original CHECK/EXPECT pair could never pass.
  gate-check builds its output as `stdout + "\n" + stderr`, so the output always ends in a
  newline, and `/^0$/` has no `m` flag: in JavaScript `$` without `m` matches only at the very
  end of the string, so the pattern can only match the exact string "0", which that harness
  cannot produce. The count is therefore labelled and matched as a substring. The diff also
  gained an explicit `main` base: the bare `git diff` compared the working tree to the index,
  so it went silently empty (and passed vacuously) the moment the goldens were committed.

- [x] G14: the whole suite is green from a frozen install
  CHECK: bun install --frozen-lockfile >/dev/null && bun test 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [x] G15: every package typechecks
  CHECK: bun run typecheck
