# Gates: 1.1.2 resolve

Scope: package detection, tsconfig paths, specifier resolution (spec: core-extract, sections Resolution rules and Package detection)

- [x] G1: resolve test file passes
  CHECK: bun test packages/core/test/resolve.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 173 expect() calls | Ran 91 tests across 1 file. [35.00ms]

- [x] G2: relative specifiers: exact, .js->.ts mapping, extension probing, index files, excluded file is unresolved; describe('relative')
  CHECK: bun test packages/core/test/resolve.test.ts -t relative
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 24 expect() calls | Ran 14 tests across 1 file. [17.00ms]

- [x] G3: tsconfig paths with extends chain, baseUrl, wildcard keys, longest-prefix first; describe('tsconfig paths')
  CHECK: bun test packages/core/test/resolve.test.ts -t "tsconfig paths"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 26 expect() calls | Ran 22 tests across 1 file. [18.00ms]

- [x] G4: bare specifiers to workspace packages via exports (conditions, patterns), module, main, src/index fallback, subpaths; describe('workspace package')
  CHECK: bun test packages/core/test/resolve.test.ts -t "workspace package"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 35 expect() calls | Ran 26 tests across 1 file. [18.00ms]

- [x] G5: externals: scoped names, node: builtins, subpath keeps the package name; describe('external')
  CHECK: bun test packages/core/test/resolve.test.ts -t external
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 17 expect() calls | Ran 11 tests across 1 file. [18.00ms]

- [x] G6: detectPackages: root always present, config roots, package.json workspaces, pnpm-workspace.yaml, go.work, duplicate names, sorted; describe('detectPackages')
  CHECK: bun test packages/core/test/resolve.test.ts -t detectPackages
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 17 expect() calls | Ran 14 tests across 1 file. [33.00ms]

- [x] G7: packageOf picks the deepest prefix and falls back to root; describe('packageOf')
  CHECK: bun test packages/core/test/resolve.test.ts -t packageOf
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 9 expect() calls | Ran 4 tests across 1 file. [18.00ms]

- [x] G8: fixtures/tiny-ts resolves every import of the 12 files to the expected target kind (file/external/unresolved); describe('tiny-ts')
  CHECK: bun test packages/core/test/resolve.test.ts -t tiny-ts
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 53 expect() calls | Ran 6 tests across 1 file. [19.00ms]

- [x] G9: leaf files typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit
  EVIDENCE: (no output)

