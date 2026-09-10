# Gates: 2.17 go-field-receivers

Scope: build 2.2, ruling 13 of 2026-09-10, closing sns45/greplost issue 13. A Go call written
`x.f.m()` resolves at high when `x` is a value the existing rules already decide (the enclosing
receiver, a typed local, a typed parameter), `f` is a field the struct declares itself whose
written type names a type in an indexed package (same package, or through a resolvable import,
pointer or value), and exactly one declaration supplies `m` on that type once the promotion rules
of leaf 2.13 have run. Two hops at most: `x.f.g.m()` is never recorded. An interface-typed field
never resolves, a field whose type names an unindexed package resolves nothing, a field on the way
that shadows the method drops the edge, and two embedded types supplying the member drop it too.

The evaluator's miss this closes: `go/pubsub/batcher.go:99` calls `b.c.ApplyStrategy(...)` inside
`batcher.process`, where `b` is the `*batcher` receiver and `c` is a field written `*Consumer`,
and `Consumer` embeds `*core.BaseConsumer`, which declares `ApplyStrategy`.

How the fact travels: `extract/go-types.ts` writes the named type of every field into a new
sorted `meta.fieldTypes` on the struct declaration (`<field>:<type>` pairs, no absolute paths),
beside the `meta.fields` names leaf 2.13 already recorded, so the resolver never re-parses a file.
`meta.fields` keeps its meaning and its format: every field name, which is what shadows a promoted
method. A field whose written type is predeclared, a slice, map, channel, function, anonymous
struct or a type parameter of the declaration itself earns no entry, because none of them names a
declaration a call could land on. `extract/go.ts` records the one deeper callee shape, `x.f.m`,
and `resolve/go.ts` turns it into an edge through the same promotion, shadowing and ambiguity
rules a receiver call uses. Files: `packages/core/src/extract/go-types.ts`,
`packages/core/src/extract/go.ts`, `packages/core/src/resolve/go.ts`,
`packages/core/test/extract-go.test.ts`.

Decisions worth reading before changing this:

- The field has to be declared by the struct itself. A field reached through an embedded type is
  a promotion of its own and would need the shadowing rules run over field names as well as
  method names; getting that wrong emits a wrong `high` edge, so the walk stops at one struct.
- An interface-typed field is refused explicitly, through a new `interfaces` map on the call
  index, rather than left to fall through for want of a method declaration. The refusal is the
  contract, not an accident of what an interface declaration happens to carry.
- `pkg.Value.m()`, where `pkg` is an import alias, is dropped: the type of another package's
  package-level value is written in that package and not in the calling file.
- `fixtures/tiny-go` was not touched. Its two structs field types are `string`, a map and
  `time.Duration`, so the fixture exercised nothing new; the field rules are pinned on inline
  sources instead, as leaf 2.13 pinned promotion and local receivers.

Open item for the merge owner, deliberately not done here because leaf 2.16 owns `schema.ts`:
`CallSite.callee` still documents `a.b.c()` as dropped. That is now true of every language except
Go, and the Go exception is documented in `extract/go.ts`'s header. The shared doc wants one
sentence saying so.

Recorded exceptions to the 500-line rule: `packages/core/src/resolve/go.ts` is 681 lines (600
before this leaf; the module documents two jobs, import resolution and call linking, and splitting
it would need a re-export shim in `graph/link.ts`, which this leaf does not own), and
`packages/core/test/extract-go.test.ts` is 1469 lines (a test file, 1215 before this leaf).

- [x] G1: the Go extraction, resolution and call-linking test file passes
  CHECK: FORCE_COLOR=0 bun test packages/core/test/extract-go.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 142 expect() calls | Ran 103 tests across 1 file. [853.00ms]

- [x] G2: every field-hop rule resolves or refuses as the ruling fixes it, pointer and value
      fields, typed local and typed parameter objects, the interface field, the second hop, the
      shadowing field, the ambiguous embed, the unindexed package, the unknown field, the
      package-qualified object, the untyped local and the two build-tag variants; -t "field of a
      decidable receiver"
  CHECK: FORCE_COLOR=0 bun test packages/core/test/extract-go.test.ts -t "field of a decidable receiver" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 15 expect() calls | Ran 13 tests across 1 file. [197.00ms]

- [x] G3: a struct records the named type of every field that has one, sorted, with predeclared,
      slice, map, function and type-parameter fields left out; -t "named type of every field"
  CHECK: FORCE_COLOR=0 bun test packages/core/test/extract-go.test.ts -t "named type of every field" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 2 expect() calls | Ran 1 test across 1 file. [176.00ms]

- [x] G4: the extractor records one field hop and never a second one, nor a call on a call;
      -t "call through one field"
  CHECK: FORCE_COLOR=0 bun test packages/core/test/extract-go.test.ts -t "call through one field" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 1 expect() calls | Ran 1 test across 1 file. [286.00ms]

- [x] G5: the written fixture answers all six situations in one file, two resolutions and four
      refusals; -t "batcher fixture"
  CHECK: FORCE_COLOR=0 bun test packages/core/test/extract-go.test.ts -t "batcher fixture" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 1 expect() calls | Ran 1 test across 1 file. [188.00ms]

- [x] G6: the core suite is green
  CHECK: FORCE_COLOR=0 bun test packages/core 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 2388 expect() calls | Ran 1007 tests across 24 files. [20.43s]

- [x] G7: every package and the bench suite are green
  CHECK: FORCE_COLOR=0 bun test packages bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 17766 expect() calls | Ran 2273 tests across 69 files. [117.52s]

- [x] G8: every workspace typechecks
  CHECK: FORCE_COLOR=0 bun run typecheck 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /== scripts\s*$/
  EVIDENCE: == bench | == scripts

- [x] G9: gin keeps call-edge precision 1.000 with no false positive, and gains recall
  CHECK: FORCE_COLOR=0 bun run bench:structural --repo gin --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -E "S3|GATE"
  EXPECT: /call edge precision \(confidence=high\) +>=0\.95 +1\.000 +recall [\d.]+, tp \d+, fp 0/
  EVIDENCE: S3  call edge precision (confidence=high)  >=0.95           1.000          recall 0.704, tp 451, fp 0, fn 190 | structural: GATE PASS

- [x] G10: the same on pulumi-go
  CHECK: FORCE_COLOR=0 bun run bench:structural --repo pulumi-go --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -E "S3|GATE"
  EXPECT: /call edge precision \(confidence=high\) +>=0\.95 +1\.000 +recall [\d.]+, tp \d+, fp 0/
  EVIDENCE: S3  call edge precision (confidence=high)  >=0.95           1.000          recall 1.000, tp 24, fp 0, fn 0 | structural: GATE PASS

- [x] G11: the same on bubbletea, the third Go repo of the corpus
  CHECK: FORCE_COLOR=0 bun run bench:structural --repo bubbletea --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -E "S3|GATE"
  EXPECT: /call edge precision \(confidence=high\) +>=0\.95 +1\.000 +recall [\d.]+, tp \d+, fp 0/
  EVIDENCE: S3  call edge precision (confidence=high)  >=0.95           1.000          recall 0.461, tp 88, fp 0, fn 103 | structural: GATE PASS

- [x] G12: S1 to S4 pass on the pinned fixture
  CHECK: FORCE_COLOR=0 bun run bench:structural --fixture tiny-go --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: S6  signal node precision                  >=0.95           n/a            not measured by this oracle | structural: GATE PASS

- [x] G13: on a copy of the evaluator's repo, `query BaseConsumer.ApplyStrategy --json` lists the
      batcher among the callers, and the count rises from 16 to 17
  CHECK: S=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad; rm -rf $S/gate217-anyq && cp -R /Users/shantanu/.claude/jobs/36f19a14/tmp/anyq $S/gate217-anyq && rm -rf $S/gate217-anyq/.greplost && FORCE_COLOR=0 bun packages/cli/src/main.ts init --no-hooks --root $S/gate217-anyq >/dev/null && FORCE_COLOR=0 bun packages/cli/src/main.ts query BaseConsumer.ApplyStrategy --json --root $S/gate217-anyq > $S/gate217-anyq.json; echo "callers=$(grep -c '"from"' $S/gate217-anyq.json) batcher=$(grep -c 'go/pubsub/batcher.go#batcher.process' $S/gate217-anyq.json)"
  EXPECT: callers=17 batcher=1
  EVIDENCE: callers=17 batcher=1

- [x] G14: the edge that closes the issue is the one written at `go/pubsub/batcher.go:99`
  CHECK: S=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad; grep -o '"from":"go/pubsub/batcher.go#batcher.process","kind":"call","line":99,"to":"go/core/base.go#BaseConsumer.ApplyStrategy"' $S/gate217-anyq/.greplost/graph/calls.jsonl
  EXPECT: "from":"go/pubsub/batcher.go#batcher.process","kind":"call","line":99,"to":"go/core/base.go#BaseConsumer.ApplyStrategy"
  EVIDENCE: "from":"go/pubsub/batcher.go#batcher.process","kind":"call","line":99,"to":"go/core/base.go#BaseConsumer.ApplyStrategy"

- [x] G15: `batcher.process` gains that one edge and no other, so the two `b.c.Logger.Error(...)`
      calls at lines 101 and 112, which are a second field hop, resolved nothing
  CHECK: S=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad; echo "edges=$(grep -c '"from":"go/pubsub/batcher.go#batcher.process"' $S/gate217-anyq/.greplost/graph/calls.jsonl)"
  EXPECT: edges=1
  EVIDENCE: edges=1

- [x] G16: two builds of that repo produce byte-identical artifacts, `meta.fieldTypes` included
  CHECK: S=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad; rm -rf $S/det217-a $S/det217-b && cp -R /Users/shantanu/.claude/jobs/36f19a14/tmp/anyq $S/det217-a && cp -R /Users/shantanu/.claude/jobs/36f19a14/tmp/anyq $S/det217-b && rm -rf $S/det217-a/.greplost $S/det217-b/.greplost && FORCE_COLOR=0 bun packages/cli/src/main.ts init --no-hooks --root $S/det217-a >/dev/null && FORCE_COLOR=0 bun packages/cli/src/main.ts init --no-hooks --root $S/det217-b >/dev/null && diff -r --exclude=.state.json --exclude=cache $S/det217-a/.greplost $S/det217-b/.greplost && echo "byte identical"
  EXPECT: byte identical
  EVIDENCE: byte identical

- [x] G17: the source files this leaf owns are under 500 lines, `resolve/go.ts` excepted above
  CHECK: for f in packages/core/src/extract/go.ts packages/core/src/extract/go-types.ts; do wc -l < $f; done | awk '$1 >= 500 {bad = 1} END {print (bad ? "OVER 500" : "under 500")}'
  EXPECT: under 500
  EVIDENCE: under 500

- [x] G18: no NUL byte reached any file this leaf wrote
  CHECK: for f in packages/core/src/extract/go.ts packages/core/src/extract/go-types.ts packages/core/src/resolve/go.ts packages/core/test/extract-go.test.ts gates/leaf-2.17.md; do perl -0777 -ne 'exit(/\0/ ? 1 : 0)' $f || exit 1; done; echo "no NUL in 5 files"
  EXPECT: no NUL in 5 files
  EVIDENCE: no NUL in 5 files
