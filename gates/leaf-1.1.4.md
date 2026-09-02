# Gates: 1.1.4 discover

Scope: config loading, file discovery, hashing and LOC (spec: core-extract, discover interfaces)

- [x] G1: discover test file passes
  CHECK: bun test packages/core/test/discover.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 42 expect() calls | Ran 16 tests across 1 file. [203.00ms]

- [x] G2: config test file passes
  CHECK: bun test packages/core/test/config.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 34 expect() calls | Ran 19 tests across 1 file. [15.00ms]

- [x] G3: discovery in a git repo honours .gitignore and includes untracked files (git ls-files --cached --others --exclude-standard); describe('gitignore')
  CHECK: bun test packages/core/test/discover.test.ts -t gitignore
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 10 expect() calls | Ran 2 tests across 1 file. [134.00ms]

- [x] G4: discovery outside git falls back to fast-glob; config include/exclude globs applied in both modes; describe('exclude')
  CHECK: bun test packages/core/test/discover.test.ts -t exclude
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 4 expect() calls | Ran 4 tests across 1 file. [53.00ms]

- [x] G5: only configured languages are returned, extension map matches LANG_BY_EXTENSION, results sorted with compareStrings; describe('languages')
  CHECK: bun test packages/core/test/discover.test.ts -t languages
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 5 expect() calls | Ran 4 tests across 1 file. [62.00ms]

- [x] G6: sha256Hex matches a known vector and countLoc matches the schema definition (empty, no trailing newline, CRLF); describe('hash')
  CHECK: bun test packages/core/test/discover.test.ts -t hash
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 10 expect() calls | Ran 6 tests across 1 file. [24.00ms]

- [x] G7: loadConfig merges .greplost/config.json over DEFAULT_CONFIG and rejects invalid shapes with a clear error; describe('loadConfig')
  CHECK: bun test packages/core/test/config.test.ts -t loadConfig
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 34 expect() calls | Ran 19 tests across 1 file. [15.00ms]

- [x] G8: fixtures/tiny-ts discovers exactly the 12 .ts files with the expected langs; describe('tiny-ts')
  CHECK: bun test packages/core/test/discover.test.ts -t tiny-ts
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 14 expect() calls | Ran 1 test across 1 file. [38.00ms]

- [x] G9: leaf files typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit
  EVIDENCE: (no output)

