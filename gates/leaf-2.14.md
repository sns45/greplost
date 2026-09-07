# Gates: 2.14 ts-resolution

Scope: the build 2.1 TypeScript resolution round. `graph/link.ts` walks a class's `extends`
chain for a `this.<member>` or `super.<member>` call the enclosing class does not answer;
`extract/ts.ts` records the accessibility of every class member, the base a class extends, and
every member name a class body writes; `CallEdge` carries the line of the site behind it and
`graph/query.ts` answers with `{ from, line, confidence }` callers. The precision contract is
unchanged: nothing is guessed, a base that does not pin to exactly one class declaration ends
the walk, a member the subclass shadows with something unresolvable drops the call, and
interface and virtual dispatch stay unresolved.
Spec: `PLAN.md` "Build 2.1" (evaluation source and rulings),
`docs/superpowers/specs/2026-09-02-core-extract-design.md` (declarations, linking rules).

Recorded deviations:
 - The brief spelled the walk's confidence "high in the same file or through exactly one
   import, med through a re-export hop". Every anyq base class is imported from `@anyq/core`
   and reached through two `export *` hops, so that spelling would have left S3 (scored at
   confidence=high) at recall 0.303 and made the leaf's own acceptance unreachable. The rule
   shipped is PLAN's ruling instead: an inherited member is high when the chain pins exactly
   one class, else the call is dropped. Measured: 59 new high edges on anyq, 1 on hono, no
   false positive on either, S3 precision 1.000 (G10, G11). Endorsed in review.
 - `Declaration.visibility` is a typed field, as the brief asked. Rust, Kotlin and Java write
   theirs into `meta.visibility` as free text; unifying the two is a driver call, not this
   leaf's.
 - `graph/link.ts` is 754 lines, over the 500-line guideline it was already over at 627.
 - Fix round 1 reaches two files outside the leaf's list, both minimally:
   `extract/index.ts` passes the new `classMembers` through to the `FileRecord` (one type
   argument and one conditional spread), and `workspace/src/query.ts` loses three em dashes
   from its prose (M1).

- [x] G1: the TypeScript extraction test file passes
  CHECK: bun test packages/core/test/extract-ts.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 224 expect() calls | Ran 109 tests across 1 file. [97.00ms]

- [x] G2: a class member carries the accessibility it is written with, public by default and private for a `#name`, and nothing outside a class body carries one; describe('visibility')
  CHECK: bun test packages/core/test/extract-ts.test.ts -t visibility 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 7 expect() calls | Ran 4 tests across 1 file. [49.00ms]

- [x] G3: a class records the base its `extends` clause names, without type arguments, and records nothing for an expression base; describe('heritage')
  CHECK: bun test packages/core/test/extract-ts.test.ts -t heritage 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 8 expect() calls | Ran 4 tests across 1 file. [49.00ms]

- [x] G4: the walk finds an inherited member up to five bases away in the file, through an import, through a barrel and through a namespace import; an override in a nearer class wins and `super` looks past it; an unpinnable base, a shadowing member the map cannot carry, a sixth level and a cycle drop the call; describe('linkCalls')
  CHECK: bun test packages/core/test/graph.test.ts -t linkCalls 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 35 expect() calls | Ran 28 tests across 1 file. [30.00ms]

- [x] G5: `callersOf` answers with `{ from, line, confidence }` whose lines are the fixture's own call sites, and `callerIds` keeps the bare id shape
  CHECK: bun test packages/core/test/query.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 42 expect() calls | Ran 19 tests across 1 file. [19.00ms]

- [x] G6: the tiny-ts golden is byte-equal to what this code path writes; describe('golden')
  CHECK: bun test packages/core/test/build.test.ts -t golden 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 30 expect() calls | Ran 9 tests across 1 file. [107.00ms]

- [x] G7: the tiny-ts golden moved only by the fields the schema gained: `line` on every call row, `visibility` on every class member row, nothing else
  CHECK: git show 79af592:packages/core/test/golden/tiny-ts/graph/calls.jsonl > /tmp/gl-calls.jsonl && git show 79af592:packages/core/test/golden/tiny-ts/graph/symbols.jsonl > /tmp/gl-symbols.jsonl && perl -pe 's/"line":\d+,//' packages/core/test/golden/tiny-ts/graph/calls.jsonl | diff -q - /tmp/gl-calls.jsonl && perl -pe 's/,"visibility":"(public|protected|private)"//' packages/core/test/golden/tiny-ts/graph/symbols.jsonl | diff -q - /tmp/gl-symbols.jsonl && echo "golden moved only by the new fields"
  EXPECT: golden moved only by the new fields
  EVIDENCE: golden moved only by the new fields

- [x] G8: the core, render and CLI suites are green
  CHECK: bun test packages/core packages/render packages/cli 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 12336 expect() calls | Ran 1231 tests across 33 files. [6.28s]

- [x] G9: every package typechecks
  CHECK: bun run typecheck 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EVIDENCE: == bench | == scripts

- [x] G10: anyq keeps S3 precision 1.000 and its recall rises from 0.303 to 0.382 (tp 224 to 283, no false positive)
  CHECK: bun bench/src/cli.ts corpus setup --repo anyq >/dev/null && bun run bench:structural --repo anyq --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /S3 +call edge precision \(confidence=high\) +>=0\.95 +1\.000 +recall 0\.382, tp 283, fp 0/
  EVIDENCE: S6  signal node precision                  >=0.95           n/a            not measured by this oracle | structural: GATE PASS

- [x] G11: hono keeps S3 precision 1.000, with recall 0.730 to 0.731 (tp 665 to 666, no false positive), and the repo gate passes
  CHECK: bun bench/src/cli.ts corpus setup --repo hono >/dev/null && bun run bench:structural --repo hono --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: /S3 +call edge precision \(confidence=high\) +>=0\.95 +1\.000 +recall 0\.731, tp 666, fp 0/
  EVIDENCE: structural: 5 unparsable files (tree-sitter root is ERROR or has an ERROR child): src/context.ts (error-child), src/helper/factory/index.ts (error-child), src/helper/ssg/middleware.ts (error-child), s

- [x] G12: the tiny-ts fixture gate passes
  CHECK: bun run bench:structural --fixture tiny-ts --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: S6  signal node precision                  >=0.95           n/a            not measured by this oracle | structural: GATE PASS

- [x] G13: on a base class and a subclass in two files, the subclass's `this.<inherited>()` is a caller of the base's method
  CHECK: d=$(mktemp -d) && mkdir -p $d/src && printf '%s\n' 'export class BaseConsumer {' '  protected async applyStrategy(): Promise<void> {' '    await this.parkMessage();' '  }' '  protected async parkMessage(): Promise<void> {}' '  public run(): void {}' '}' > $d/src/base.ts && printf '%s\n' 'import { BaseConsumer } from "./base.ts";' 'export class SQSConsumer extends BaseConsumer {' '  protected override async parkMessage(): Promise<void> {}' '  async handle(): Promise<void> {' '    await this.applyStrategy();' '    this.run();' '  }' '}' > $d/src/sqs.ts && printf '{ "name": "tsfix" }' > $d/package.json && bun packages/cli/src/main.ts init --no-hooks --root $d >/dev/null && bun packages/cli/src/main.ts query BaseConsumer.applyStrategy --json --root $d | tr -d ' \n'
  EXPECT: "callers":["src/sqs.ts#SQSConsumer.handle"]
  EVIDENCE: {"matches":[{"callers":["src/sqs.ts#SQSConsumer.handle"],"card":"packages/tsfix/modules/src/base.ts.md","exported":true,"file":"src/base.ts","id":"src/base.ts#BaseConsumer.applyStrategy","importers":[

- [x] G14: on a fresh map of the pinned anyq, `BaseConsumer.applyStrategy` has at least 18 callers (edges into it, not out of it) and the six `supportsNativeDelay` getters are protected
  CHECK: bun bench/src/cli.ts corpus setup --repo anyq >/dev/null && t=$(mktemp -d) && cp -R bench/.corpus/anyq $t/anyq && rm -rf $t/anyq/.greplost && bun packages/cli/src/main.ts init --no-hooks --root $t/anyq >/dev/null && echo "callers $(grep -c '"to":"packages/core/src/base/base-adapter.ts#BaseConsumer.applyStrategy"' $t/anyq/.greplost/graph/calls.jsonl) protected $(grep supportsNativeDelay $t/anyq/.greplost/graph/symbols.jsonl | grep -c 'visibility":"protected"')"
  EXPECT: /callers (1[89]|[2-9]\d+) protected 6/
  EVIDENCE: callers 19 protected 6

- [x] G15: no NUL byte and no em or en dash in the files this leaf touches (`perl -CSD`, or a UTF-8 dash never matches)
  CHECK: perl -CSD -ne 'print "$ARGV:$.\n" if /[\0\x{2014}\x{2013}]/; close ARGV if eof;' packages/core/src/schema.ts packages/core/src/graph/link.ts packages/core/src/graph/query.ts packages/core/src/extract/ts.ts packages/core/src/extract/ts-calls.ts packages/core/src/extract/index.ts packages/core/test/extract-ts.test.ts packages/core/test/graph.test.ts packages/core/test/query.test.ts packages/cli/src/commands/query.ts packages/workspace/src/query.ts gates/leaf-2.14.md | wc -l
  EXPECT: /^\s*0$/m
  EVIDENCE: 0

- [x] G16: a subclass member that shadows a base method drops the call, and `this` inside an object literal method, a nested class and a plain function is not the subclass's; only the arrow function keeps the chain
  CHECK: d=$(mktemp -d) && mkdir -p $d/src && printf '%s\n' 'export function external() {}' 'export class Base {' '  protected handle(): void {}' '  protected other(): void {}' '  protected helper(): void {}' '}' > $d/src/base.ts && printf '%s\n' 'import { Base, external } from "./base.ts";' 'export class Kid extends Base {' '  protected handle = external;' '  private other!: () => void;' '  go() { this.handle(); this.other(); }' '}' 'export class Host extends Base {' '  build() { return { m() { this.helper(); } }; }' '  nested() { class Inner { m() { this.helper(); } } return Inner; }' '  plain() { function inner() { this.helper(); } return inner; }' '  arrow() { return () => this.helper(); }' '}' > $d/src/kid.ts && printf '{ "name": "shadow" }' > $d/package.json && bun packages/cli/src/main.ts init --no-hooks --root $d >/dev/null && echo "edges $(wc -l < $d/.greplost/graph/calls.jsonl | tr -d ' ') arrow $(grep -c 'Host.arrow' $d/.greplost/graph/calls.jsonl)"
  EXPECT: /^edges 1 arrow 1$/m
  EVIDENCE: edges 1 arrow 1

- [x] G17: `super.<member>()` reaches the base's declaration even where the class overrides it, and drops when the base is not pinned
  CHECK: d=$(mktemp -d) && mkdir -p $d/src && printf '%s\n' 'export class Base {' '  protected overridden(): void {}' '}' > $d/src/base.ts && printf '%s\n' 'import { Base } from "./base.ts";' 'import { Other } from "express";' 'export class Kid extends Base {' '  protected override overridden(): void { super.overridden(); }' '}' 'export class Loose extends Other {' '  run(): void { super.overridden(); }' '}' > $d/src/kid.ts && printf '{ "name": "sup" }' > $d/package.json && bun packages/cli/src/main.ts init --no-hooks --root $d >/dev/null && cat $d/.greplost/graph/calls.jsonl
  EXPECT: /^\{"confidence":"high","from":"src\/kid\.ts#Kid\.overridden","kind":"call","line":4,"to":"src\/base\.ts#Base\.overridden"\}$/m
  EVIDENCE: {"confidence":"high","from":"src/kid.ts#Kid.overridden","kind":"call","line":4,"to":"src/base.ts#Base.overridden"}
