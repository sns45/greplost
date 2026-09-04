# Gates: 2.3.1 signals-ts

Scope: the four TypeScript signal passes that run after the language extractor over the same
parse tree, `react` (component nodes with hooks and props metadata), `tanstack` (file routes,
loaders, server routes), `next` (App Router route and handler nodes from the path rules), and
`pulumi-ts` (resource nodes found by a structural class check, plus `resource-input` reference
edges); the `fixtures/tiny-signals-ts` fixture; and the independent TypeScript-checker truth
generator with corpus gates on pulumi-ts, tanstack-start and next-app. S6 (signal-node
precision) is gated at 0.95 with recall reported, and `resource-input` edges fold into S5, also
gated at 0.95. A signal node never replaces a language declaration.
Spec: `docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 0, 3.1, 3.2,
3.3, 3.4, 3.5, 3.7, 3.8, 5.1.

- [x] G1: the signals extraction test file passes
  CHECK: bun test packages/core/test/signals-ts.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 72 expect() calls | Ran 64 tests across 1 file. [120.00ms]

- [x] G2: an upper-case function or class returning JSX, or one wrapped in `React.memo`/`forwardRef`, becomes a `component` node and nothing else does; describe('react components')
  CHECK: bun test packages/core/test/signals-ts.test.ts -t "react components" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 11 expect() calls | Ran 11 tests across 1 file. [57.00ms]

- [x] G3: `createFileRoute`/`createRootRoute` with a string-literal path give `route.<path>` nodes and a computed path emits nothing; describe('tanstack routes')
  CHECK: bun test packages/core/test/signals-ts.test.ts -t "tanstack routes" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 7 expect() calls | Ran 6 tests across 1 file. [56.00ms]

- [x] G4: the App Router path rules (groups dropped, dynamic segments kept verbatim, slots recorded in `meta.slot`); describe('next app routes')
  CHECK: bun test packages/core/test/signals-ts.test.ts -t "next app routes" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 18 expect() calls | Ran 16 tests across 1 file. [53.00ms]

- [x] G5: the Pulumi class check is structural, so a local class named `Bucket` is not a resource; describe('pulumi resources')
  CHECK: bun test packages/core/test/signals-ts.test.ts -t "pulumi resources" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 11 expect() calls | Ran 10 tests across 1 file. [56.00ms]

- [x] G6: the truth generator test file passes
  CHECK: bun test bench/test/signals-ts.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 26 expect() calls | Ran 12 tests across 1 file. [1058.00ms]

- [x] G7: the checker oracle imports nothing from `packages/core/src/signals` and its output tracks the fixture; describe('oracle independence')
  CHECK: bun test bench/test/signals-ts.test.ts -t "oracle independence" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 11 expect() calls | Ran 4 tests across 1 file. [632.00ms]

- [x] G8: S1 to S6 pass on the fixture
  CHECK: bun run bench:structural --fixture tiny-signals-ts --lang tsx --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: S6  signal node precision                  >=0.95           1.000          tp 16, fp 0, fn 0 | structural: GATE PASS

- [x] G9: the gate passes on the first pinned corpus repo (pulumi-ts, subset `aws-ts-*/`, 122 `.ts`)
  CHECK: bun bench/src/cli.ts corpus setup --repo pulumi-ts >/dev/null && bun run bench:structural --repo pulumi-ts --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: S6  signal node precision                  >=0.95           1.000          tp 661, fp 0, fn 25 | structural: GATE PASS

- [x] G10: the gate passes on the second pinned corpus repo (tanstack-start, subset `examples/react/start-*/`, 391 `.ts`/`.tsx`)
  CHECK: bun bench/src/cli.ts corpus setup --repo tanstack-start >/dev/null && bun run bench:structural --repo tanstack-start --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: S6  signal node precision                  >=0.95           1.000          tp 494, fp 0, fn 2 | structural: GATE PASS

- [x] G11: the gate passes on the third pinned corpus repo (next-app, subset `examples/*/app/**`, 338 `.ts`/`.tsx` across 82 App Router apps)
  CHECK: bun bench/src/cli.ts corpus setup --repo next-app >/dev/null && bun run bench:structural --repo next-app --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: structural: 2 unparsable files (tree-sitter root is ERROR or has an ERROR child): examples/with-next-translate/app/[lang]/page.js (error-root), examples/with-next-translate/app/layout.js (error-root) 

- [x] G12: the core and bench suites are green
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 4486 expect() calls | Ran 943 tests across 26 files. [49.76s]

- [x] G13: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: (no output)
