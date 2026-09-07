# Gates: 2.13 go-resolution

Scope: build 2.1 hardening of Go call resolution after the gpt-6-astra evaluation on anyq.
Embedded-field promotion (`recv.m()` reaching a method the receiver's type promotes from a field
it embeds, same package or imported, breadth first to depth 3, dropped when two embedded types
supply the member), local and closure receivers (`x := &T{}`, `x := T{}`, `var x T`, `var x *T`,
`x, err := f()` for a same-package function or a method on the receiver, and parameters typed `T`
or `*T`), and the blank identifier that used to declare a colliding `<file>#_` node.
Fix round 1 (review of 2026-09-07): a named field of a struct shadows every promoted method of the
same name and is never a call target, so `meta.fields` is recorded beside `meta.embeds` and the
promotion walk stops at the first depth that declares the field; and a typed local counts only
inside a named declaration, because package-level code has nowhere to carry `meta.locals`. Files:
`packages/core/src/extract/go.ts`, `packages/core/src/extract/go-types.ts` (new),
`packages/core/src/resolve/go.ts`, `packages/core/test/extract-go.test.ts`.
Spec: PLAN.md "Build 2.1", rulings of 2026-09-07.

Recorded exceptions to the 500-line rule: `packages/core/src/resolve/go.ts` is 600 lines (the
module documents two jobs, import resolution and call linking, and splitting it would need a
re-export shim in a file leaf 2.15 may be editing), and `packages/core/test/extract-go.test.ts`
is 1215 lines (a test file, 810 before this leaf).

- [x] G1: the Go extraction, resolution and call-linking test file passes
  CHECK: FORCE_COLOR=0 bun test packages/core/test/extract-go.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 124 expect() calls | Ran 88 tests across 1 file. [133.00ms]

- [x] G2: promotion through embedded fields resolves in the same package and through an import, walks embedded embeds to depth 3, and drops rather than guesses when two embedded types supply the member; -t embedded
  CHECK: FORCE_COLOR=0 bun test packages/core/test/extract-go.test.ts -t embedded 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 13 expect() calls | Ran 9 tests across 1 file. [60.00ms]

- [x] G3: a local, a var, a parameter, a constructor result and a receiver method's result are all receivers, a rebound name is not, and a call in a func literal belongs to the enclosing declaration; -t receiver
  CHECK: FORCE_COLOR=0 bun test packages/core/test/extract-go.test.ts -t receiver 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 25 expect() calls | Ran 20 tests across 1 file. [91.00ms]

- [x] G4: `_` declares nothing, so two interface assertions in one file no longer collide on `<file>#_`; -t blank
  CHECK: FORCE_COLOR=0 bun test packages/core/test/extract-go.test.ts -t blank 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 4 expect() calls | Ran 3 tests across 1 file. [54.00ms]

- [x] G5: the six call shapes of the evaluator's probe repo resolve as one control plus four fixes, with nothing guessed; -t "six probe shapes"
  CHECK: FORCE_COLOR=0 bun test packages/core/test/extract-go.test.ts -t "six probe shapes" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 1 expect() calls | Ran 1 test across 1 file. [60.00ms]

- [x] G6: the pinned fixture still builds to the same declarations, call sites and call edges; -t tiny-go
  CHECK: FORCE_COLOR=0 bun test packages/core/test/extract-go.test.ts -t tiny-go 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 18 expect() calls | Ran 10 tests across 1 file. [113.00ms]

- [x] G7: the core suite is green
  CHECK: FORCE_COLOR=0 bun test packages/core 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 2326 expect() calls | Ran 964 tests across 24 files. [4.60s]

- [x] G8: every package and the bench suite are green
  CHECK: FORCE_COLOR=0 bun test packages bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 17419 expect() calls | Ran 2174 tests across 66 files. [122.17s]

- [x] G9: every workspace typechecks
  CHECK: FORCE_COLOR=0 bun run typecheck 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /== scripts\s*$/
  EVIDENCE: == bench | == scripts

- [x] G10: build 1's Go corpus gate keeps call-edge precision 1.000 with no false positive on gin
  CHECK: FORCE_COLOR=0 bun run bench:structural --repo gin --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -E "S3|GATE"
  EXPECT: /call edge precision \(confidence=high\) +>=0\.95 +1\.000 +recall [\d.]+, tp \d+, fp 0/
  EVIDENCE: S3  call edge precision (confidence=high)  >=0.95           1.000          recall 0.677, tp 434, fp 0, fn 207 | structural: GATE PASS

- [x] G11: the same on pulumi-go
  CHECK: FORCE_COLOR=0 bun run bench:structural --repo pulumi-go --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -E "S3|GATE"
  EXPECT: /call edge precision \(confidence=high\) +>=0\.95 +1\.000 +recall [\d.]+, tp \d+, fp 0/
  EVIDENCE: S3  call edge precision (confidence=high)  >=0.95           1.000          recall 1.000, tp 24, fp 0, fn 0 | structural: GATE PASS

- [x] G12: S1 to S4 pass on the fixture
  CHECK: FORCE_COLOR=0 bun run bench:structural --fixture tiny-go --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: S6  signal node precision                  >=0.95           n/a            not measured by this oracle | structural: GATE PASS

- [x] G13: on a copy of the evaluator's probe repo, `query BaseConsumer.ApplyStrategy --json` lists the cross-package promoted caller
  CHECK: S=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad; rm -rf $S/gate-gofix && cp -R /Users/shantanu/.claude/jobs/36f19a14/tmp/gofix $S/gate-gofix && rm -rf $S/gate-gofix/.greplost && FORCE_COLOR=0 bun packages/cli/src/main.ts init --no-hooks --root $S/gate-gofix >/dev/null && FORCE_COLOR=0 bun packages/cli/src/main.ts query BaseConsumer.ApplyStrategy --json --root $S/gate-gofix | grep -o "sqs/consumer.go#Consumer.handleOne"
  EXPECT: sqs/consumer.go#Consumer.handleOne
  EVIDENCE: sqs/consumer.go#Consumer.handleOne

- [x] G14: the same copy answers `query Inner.SamePkgPromoted --json` with the same-package promoted caller
  CHECK: S=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad; rm -rf $S/gate-gofix && cp -R /Users/shantanu/.claude/jobs/36f19a14/tmp/gofix $S/gate-gofix && rm -rf $S/gate-gofix/.greplost && FORCE_COLOR=0 bun packages/cli/src/main.ts init --no-hooks --root $S/gate-gofix >/dev/null && FORCE_COLOR=0 bun packages/cli/src/main.ts query Inner.SamePkgPromoted --json --root $S/gate-gofix | grep -o "sqs/consumer.go#Consumer.handleTwo"
  EXPECT: sqs/consumer.go#Consumer.handleTwo
  EVIDENCE: sqs/consumer.go#Consumer.handleTwo

- [x] G15: the same copy answers `query delivery.dispose --json` with both the local receiver and the closure receiver
  CHECK: S=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad; rm -rf $S/gate-gofix && cp -R /Users/shantanu/.claude/jobs/36f19a14/tmp/gofix $S/gate-gofix && rm -rf $S/gate-gofix/.greplost && FORCE_COLOR=0 bun packages/cli/src/main.ts init --no-hooks --root $S/gate-gofix >/dev/null && FORCE_COLOR=0 bun packages/cli/src/main.ts query delivery.dispose --json --root $S/gate-gofix | grep -oE "Consumer\.(Park|Wrap)" | sort | tr '\n' ' '
  EXPECT: Consumer.Park Consumer.Wrap
  EVIDENCE: Consumer.Park Consumer.Wrap

- [x] G16: on a copy of anyq, `go/core/base.go#BaseConsumer.ApplyStrategy` gains 16 callers, 4 of them from go/sqs and go/redis (0 before)
  CHECK: S=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad; rm -rf $S/gate-anyq && cp -R /Users/shantanu/.claude/jobs/36f19a14/tmp/anyq $S/gate-anyq && FORCE_COLOR=0 bun packages/cli/src/main.ts init --no-hooks --root $S/gate-anyq >/dev/null && FORCE_COLOR=0 bun packages/cli/src/main.ts query "go/core/base.go#BaseConsumer.ApplyStrategy" --json --root $S/gate-anyq > $S/gate-anyq.json; echo "callers=$(grep -c 'consumer.go#Consumer\.' $S/gate-anyq.json) sqsredis=$(grep -cE 'go/(sqs|redis)/consumer.go#Consumer\.' $S/gate-anyq.json)"
  EXPECT: callers=16 sqsredis=4
  EVIDENCE: callers=16 sqsredis=4

- [x] G17: on the same copy, `go/pgmq/consumer.go#delivery.dispose` lists `Consumer.ParkMessage`, the local bound to a receiver method's first result
  CHECK: S=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad; FORCE_COLOR=0 bun packages/cli/src/main.ts init --no-hooks --root $S/gate-anyq >/dev/null && FORCE_COLOR=0 bun packages/cli/src/main.ts query "go/pgmq/consumer.go#delivery.dispose" --json --root $S/gate-anyq | grep -o "go/pgmq/consumer.go#Consumer.ParkMessage"
  EXPECT: go/pgmq/consumer.go#Consumer.ParkMessage
  EVIDENCE: go/pgmq/consumer.go#Consumer.ParkMessage

- [x] G18: no blank identifier survives as a declaration on either probe repo
  CHECK: S=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad; echo "blank=$(grep -c '#_\"' $S/gate-anyq/.greplost/graph/symbols.jsonl) $(grep -c '#_\"' $S/gate-gofix/.greplost/graph/symbols.jsonl)"
  EXPECT: blank=0 0
  EVIDENCE: blank=0 0

- [x] G21: a named field shadows the promoted method it collides with, at its own depth and one level down, and a field of another name leaves promotion alone; -t shadow
  CHECK: FORCE_COLOR=0 bun test packages/core/test/extract-go.test.ts -t shadow 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 8 expect() calls | Ran 8 tests across 1 file. [63.00ms]

- [x] G22: a typed local is honoured only inside a named declaration, so a package-level func literal never reaches the import rule; -t "func literal"
  CHECK: FORCE_COLOR=0 bun test packages/core/test/extract-go.test.ts -t "func literal" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 2 expect() calls | Ran 2 tests across 1 file. [57.00ms]

- [x] G23: two build-tag variants of one struct never merge their embedded types; -t "build-tag variants"
  CHECK: FORCE_COLOR=0 bun test packages/core/test/extract-go.test.ts -t "build-tag variants" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 2 expect() calls | Ran 1 test across 1 file. [58.00ms]

- [x] G24: two builds of the same repo produce byte-identical artifacts
  CHECK: S=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad; rm -rf $S/det-a $S/det-b && cp -R /Users/shantanu/.claude/jobs/36f19a14/tmp/anyq $S/det-a && cp -R /Users/shantanu/.claude/jobs/36f19a14/tmp/anyq $S/det-b && FORCE_COLOR=0 bun packages/cli/src/main.ts init --no-hooks --root $S/det-a >/dev/null && FORCE_COLOR=0 bun packages/cli/src/main.ts init --no-hooks --root $S/det-b >/dev/null && diff -r --exclude=.state.json --exclude=cache $S/det-a/.greplost $S/det-b/.greplost && echo "byte identical"
  EXPECT: byte identical
  EVIDENCE: byte identical

- [x] G19: the source files this leaf owns are under 500 lines, `resolve/go.ts` excepted above
  CHECK: for f in packages/core/src/extract/go.ts packages/core/src/extract/go-types.ts; do wc -l < $f; done | awk '$1 >= 500 {bad = 1} END {print (bad ? "OVER 500" : "under 500")}'
  EXPECT: under 500
  EVIDENCE: under 500

- [x] G20: no NUL byte reached any file this leaf wrote
  CHECK: perl -ne 'exit 1 if /\0/' packages/core/src/extract/go.ts packages/core/src/extract/go-types.ts packages/core/src/resolve/go.ts packages/core/test/extract-go.test.ts gates/leaf-2.13.md && echo "no NUL in 5 files"
  EXPECT: no NUL in 5 files
  EVIDENCE: no NUL in 5 files
