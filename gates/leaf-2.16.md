# Gates: 2.16 go-packages

Scope: issue 12. Before this leaf a manifest only became a package when its directory matched a
workspace glob, so a Go monorepo whose modules sit outside `packages/*` and `apps/*` folded its
whole source tree into the root package (the evaluator saw 76 Go files under `anyq-monorepo`).
Build 2.2 ruling 12: every `go.mod` in the indexed tree is a package rooted at its own directory,
named from the module path's last segment with a major version suffix like `/v2` dropped and a
module path of one segment falling back to the directory basename, `source: "go.mod"`, nested
modules nesting so the deepest one owns the file and nothing under a module falling to the root.
`packages.roots` still gates `package.json`, and a directory matched by both a glob and a `go.mod`
is one package, not two, with `package.json` keeping the name.
Files: `packages/core/src/resolve/packages.ts`, `packages/core/test/resolve.test.ts`, `README.md`,
and greplost's own committed map under `.greplost/` (rebuilt, see C1 below).
Spec: PLAN.md "Build 2.2", ruling 12 of 2026-09-10.

Decisions recorded here:

- `PackageInfo.source` already carried `"go.mod"` in `packages/core/src/schema.ts`; the type needed
  no change, only the code that reaches the value.
- The root package keeps `source: "root"`. It is found because it is the root, not because a
  manifest named it, and giving it `"go.mod"` would move `manifest.packages` on every Go repo for
  nothing. A root module path of one segment keeps the segment instead of falling back to the
  directory the way a nested `go.mod` does, because at `.` the directory is the checkout and the
  checkout has no name the repository owns (tech spec 5.3 determinism).
- The root package name now drops a major version suffix too, so a repository whose root module is
  `github.com/you/thing/v2` renames its root package from `v2` to `thing` and sees `verify` report
  drift exactly once, on the update that rebuilds the map. The README upgrade note says so.
- `fixtures/tiny-go` is root only (`module example.com/tiny`), so its map does not move: one
  package named `tiny` at `.`, before and after, and no `/vN` to drop. Proved by diffing its whole
  `.greplost/` tree built by the code at `HEAD~1` against this leaf's (G12). No render golden moved
  and none was regenerated: the goldens under `packages/render/test/golden/` are `tiny-ts` and
  `tiny-terraform`, neither of which has a `go.mod`.
- No config knob was added. Go module detection needs none.

Fix round 1 (review of 2026-09-10):

- C1: greplost's own committed map went stale under the new rule, because
  `bench/truth/gocallgraph`, `bench/truth/pulumigotruth` and `bench/truth/tfinspect` each hold a
  `go.mod` beside an indexed `main.go`. They are real Go modules and stay packages, so the map was
  rebuilt with `update --full` and committed rather than the directories being excluded. The repo
  now maps 11 packages instead of 8. G27 runs `verify --diff` on the repo itself so this class of
  drift cannot pass unnoticed again.
  The map commit had to use `git commit --no-verify`, and this matters after the merge. The
  pre-commit hook installed here has two blocks: the first prefers
  `node_modules/.bin/greplost`, which in a checkout points at `packages/cli` but needs a `dist/`
  build that a source checkout does not have, so it fails silently; the second falls back to the
  globally installed `greplost`, which is the published 0.1.0 and predates this rule. That
  fallback rewrote the map back to 8 packages and staged it over the correct one. Until 0.1.1 is
  published and installed, a commit in this repo made by someone with the old global binary will
  revert `.greplost/` the same way, and CI's self-verify will catch it. Building `packages/cli`
  into `dist/`, or reinstalling the global binary from this branch, removes the hazard.
- I1: the repo wide sweep for `go.mod` is what a repo with no indexed Go file skips, not the read
  itself. A directory a workspace glob names is read either way, so a `packages/svc/go.mod` whose
  own Go files are all `_test.go` (or whose repo leaves `go` out of `languages`) is still the
  package it was before this leaf. G28.
- The major version suffix is `v2` and up, never `v0` or `v1`, and Go writes multi digit majors, so
  the test is `v[2-9]` or `v[1-9][0-9]+`: `module github.com/acme/v1` names its package `v1`, and
  `module github.com/acme/ten/v10` names its package `ten`. G29.

Recorded exception to the 500-line rule: `packages/core/test/resolve.test.ts` is 1427 lines
(a test file, 1224 before this leaf). `packages/core/src/resolve/packages.ts` is 480 lines.

- [ ] G1: the package detection and resolution test file passes
  CHECK: FORCE_COLOR=0 bun test packages/core/test/resolve.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G2: the go module group passes as a whole; -t "go modules"
  CHECK: FORCE_COLOR=0 bun test packages/core/test/resolve.test.ts -t "go modules" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G3: a go.mod outside every workspace glob is still a package; -t "outside every workspace glob"
  CHECK: FORCE_COLOR=0 bun test packages/core/test/resolve.test.ts -t "outside every workspace glob" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G4: the name is the module path's last segment, a major version suffix names the segment before it, and a module path of one segment falls back to the directory basename; -t "segment"
  CHECK: FORCE_COLOR=0 bun test packages/core/test/resolve.test.ts -t "segment" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G5: nested modules nest, the deepest wins, and no file under a module falls to the root package; -t "nested modules nest"
  CHECK: FORCE_COLOR=0 bun test packages/core/test/resolve.test.ts -t "nested modules nest" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G6: a directory matched by a glob and holding a go.mod is one package, and package.json still wins the name inside a glob; -t "one package, not two"
  CHECK: FORCE_COLOR=0 bun test packages/core/test/resolve.test.ts -t "one package, not two" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G7: packages.roots still gates package.json, so a manifest outside every glob is not a package; -t "packages.roots still gates"
  CHECK: FORCE_COLOR=0 bun test packages/core/test/resolve.test.ts -t "packages.roots still gates" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G8: results stay sorted by path with the root first, whatever the file order; -t "sorted by path whatever the file order"
  CHECK: FORCE_COLOR=0 bun test packages/core/test/resolve.test.ts -t "sorted by path whatever the file order" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G9: a repo whose indexed files hold no go file is never swept, and fixtures/tiny-go stays one package named from its module path; -t "never probed for go.mod"
  CHECK: FORCE_COLOR=0 bun test packages/core/test/resolve.test.ts -t "never probed for go.mod" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G10: the core suite is green
  CHECK: FORCE_COLOR=0 bun test packages/core 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G11: every package is green, render goldens included
  CHECK: FORCE_COLOR=0 bun test packages 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G12: fixtures/tiny-go builds the same artifacts as the code at HEAD before this leaf
  CHECK: S=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad; rm -rf $S/work/tiny-go && cp -R fixtures/tiny-go $S/work/tiny-go && FORCE_COLOR=0 bun packages/cli/src/main.ts init --no-hooks --root $S/work/tiny-go >/dev/null && diff -r $S/work/tiny-go-base/.greplost $S/work/tiny-go/.greplost && echo "tiny-go artifacts identical"
  EXPECT: tiny-go artifacts identical
  EVIDENCE: pending

- [ ] G13: every workspace typechecks
  CHECK: FORCE_COLOR=0 bun run typecheck 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^== scripts\s*$/m
  EVIDENCE: pending

- [ ] G14: the README is in sync with its generated sections
  CHECK: FORCE_COLOR=0 bun run readme:check 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: README.md up to date
  EVIDENCE: pending

- [ ] G15: the README says how packages are detected, and names the one condition on a go.mod
  CHECK: grep -c 'every `go.mod` in the indexed tree is a package rooted at its own directory' README.md; grep -c 'In the indexed tree is the one condition' README.md
  EXPECT: /^1\n1$/m
  EVIDENCE: pending

- [ ] G16: on a fresh copy of anyq, every go.mod directory the tree declares appears as a package path in INDEX.md
  CHECK: S=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad; A=$S/gate216-anyq; rm -rf $A && cp -R /Users/shantanu/.claude/jobs/36f19a14/tmp/anyq $A && rm -rf $A/.greplost && FORCE_COLOR=0 bun packages/cli/src/main.ts init --no-hooks --root $A >/dev/null && cd $A && missing=0; for m in $(find . -name go.mod | sed 's|^\./||'); do d=$(dirname $m); if [ "$d" != "." ]; then grep -qE "^\| [^|]+ \| $d \|" .greplost/INDEX.md || missing=$((missing+1)); fi; done; echo "gomods=$(find . -name go.mod | wc -l | tr -d ' ') missing=$missing"
  EXPECT: /^gomods=1 missing=0$/m
  EVIDENCE: pending

- [ ] G17: the anyq map lists the go module as its own package and the root package no longer holds the Go tree
  CHECK: S=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad; A=$S/gate216-anyq; if [ ! -f $A/.greplost/INDEX.md ]; then rm -rf $A && cp -R /Users/shantanu/.claude/jobs/36f19a14/tmp/anyq $A && rm -rf $A/.greplost && FORCE_COLOR=0 bun packages/cli/src/main.ts init --no-hooks --root $A >/dev/null; fi; grep -E '^\| (go|anyq-monorepo) \|' $A/.greplost/INDEX.md | awk -F' *\\| *' '{print $2 " " $3 " " $4}'
  EXPECT: /^anyq-monorepo \. 6\ngo go 70$/m
  EVIDENCE: pending

- [ ] G18: `query go/core --json` still lists the same 13 files it listed before the regrouping
  CHECK: S=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad; A=$S/gate216-anyq; if [ ! -f $A/.greplost/INDEX.md ]; then rm -rf $A && cp -R /Users/shantanu/.claude/jobs/36f19a14/tmp/anyq $A && rm -rf $A/.greplost && FORCE_COLOR=0 bun packages/cli/src/main.ts init --no-hooks --root $A >/dev/null; fi; out=$(FORCE_COLOR=0 bun packages/cli/src/main.ts query go/core --json --root $A | grep -oE 'go/core/[a-z]+\.go' | sort -u | sed 's|go/core/||' | tr '\n' ' '); echo "go/core: $out"
  EXPECT: go/core: backoff.go base.go circuitbreaker.go config.go consumer.go errors.go id.go logger.go message.go producer.go serialization.go strategies.go version.go
  EVIDENCE: pending

- [ ] G19: the anyq map verifies in sync
  CHECK: S=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad; A=$S/gate216-anyq; if [ ! -f $A/.greplost/INDEX.md ]; then rm -rf $A && cp -R /Users/shantanu/.claude/jobs/36f19a14/tmp/anyq $A && rm -rf $A/.greplost && FORCE_COLOR=0 bun packages/cli/src/main.ts init --no-hooks --root $A >/dev/null; fi; FORCE_COLOR=0 bun packages/cli/src/main.ts verify --root $A
  EXPECT: map is in sync
  EVIDENCE: pending

- [ ] G20: a second `update --full` on anyq rewrites nothing, byte for byte
  CHECK: S=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad; A=$S/gate216-anyq; if [ ! -f $A/.greplost/INDEX.md ]; then rm -rf $A && cp -R /Users/shantanu/.claude/jobs/36f19a14/tmp/anyq $A && rm -rf $A/.greplost && FORCE_COLOR=0 bun packages/cli/src/main.ts init --no-hooks --root $A >/dev/null; fi; rm -rf $S/gate216-snap && cp -R $A/.greplost $S/gate216-snap && FORCE_COLOR=0 bun packages/cli/src/main.ts update --full --root $A >/dev/null && diff -r $S/gate216-snap $A/.greplost && echo "byte identical"
  EXPECT: byte identical
  EVIDENCE: pending

- [ ] G21: S1 does not move on gin, because a Go import resolves by directory
  CHECK: FORCE_COLOR=0 bun run bench:structural --repo gin --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -E "S1|GATE"
  EXPECT: /^ +S1 +import edge precision \/ recall +>=0\.99 \/ >=0\.97 +1\.000 \/ 1\.000 +tp 20, fp 0, fn 0$/m
  EVIDENCE: pending

- [ ] G22: S1 does not move on pulumi-go either, and its gate passes
  CHECK: FORCE_COLOR=0 bun run bench:structural --repo pulumi-go --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -E "S1|GATE"
  EXPECT: /^ +S1 +import edge precision \/ recall +>=0\.99 \/ >=0\.97 +1\.000 \/ 1\.000 +tp 0, fp 0, fn 0\n^structural: GATE PASS$/m
  EVIDENCE: pending

- [ ] G23: the tiny-go fixture gate still passes
  CHECK: FORCE_COLOR=0 bun run bench:structural --fixture tiny-go --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /^structural: GATE PASS$/m
  EVIDENCE: pending

- [ ] G24: init then verify on temp copies of fixtures/tiny-ts and fixtures/tiny-terraform are unchanged
  CHECK: S=/private/tmp/claude-501/-Users-shantanu-dev-greplost/36f19a14-277a-4aa9-91cc-30733a56ea7b/scratchpad; for f in tiny-ts tiny-terraform; do rm -rf $S/gate216-$f && cp -R fixtures/$f $S/gate216-$f && FORCE_COLOR=0 bun packages/cli/src/main.ts init --no-hooks --root $S/gate216-$f >/dev/null && FORCE_COLOR=0 bun packages/cli/src/main.ts verify --root $S/gate216-$f | sed "s|^|$f |"; done
  EXPECT: /^tiny-ts greplost: map is in sync\ntiny-terraform greplost: map is in sync$/m
  EVIDENCE: pending

- [ ] G25: the source file this leaf owns is under 500 lines
  CHECK: wc -l < packages/core/src/resolve/packages.ts | awk '{print ($1 < 500 ? "under 500" : "OVER 500")}'
  EXPECT: under 500
  EVIDENCE: pending

- [ ] G26: no NUL byte reached any file this leaf wrote
  CHECK: perl -ne 'exit 1 if /\0/' packages/core/src/resolve/packages.ts packages/core/test/resolve.test.ts README.md gates/leaf-2.16.md && echo "no NUL in 4 files"
  EXPECT: no NUL in 4 files
  EVIDENCE: pending

- [ ] G27: greplost's own committed map is in sync with this branch's rules, and the three bench Go helpers are packages in it
  CHECK: FORCE_COLOR=0 bun packages/cli/src/main.ts verify --diff 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'; grep -cE '^\| (gocallgraph|pulumigotruth|tfinspect) \| bench/truth/' .greplost/INDEX.md
  EXPECT: /^greplost: map is in sync\n3$/m
  EVIDENCE: pending

- [ ] G28: inside a workspace glob a go.mod is a package even when the repo indexes no go file; -t "even when no go file is indexed"
  CHECK: FORCE_COLOR=0 bun test packages/core/test/resolve.test.ts -t "even when no go file is indexed" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G29: only v2 and above is a major version suffix, v0 and v1 are ordinary segments, and v10 is a suffix; -t "only v2 and above"
  CHECK: FORCE_COLOR=0 bun test packages/core/test/resolve.test.ts -t "only v2 and above" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending
