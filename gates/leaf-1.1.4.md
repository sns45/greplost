# Gates: 1.1.4 discover

Scope: config loading, file discovery, hashing and LOC (spec: core-extract, discover interfaces)

- [ ] G1: discover test file passes
  CHECK: bun test packages/core/test/discover.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G2: config test file passes
  CHECK: bun test packages/core/test/config.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G3: discovery in a git repo honours .gitignore and includes untracked files (git ls-files --cached --others --exclude-standard); describe('gitignore')
  CHECK: bun test packages/core/test/discover.test.ts -t gitignore
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G4: discovery outside git falls back to fast-glob; config include/exclude globs applied in both modes; describe('exclude')
  CHECK: bun test packages/core/test/discover.test.ts -t exclude
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G5: only configured languages are returned, extension map matches LANG_BY_EXTENSION, results sorted with compareStrings; describe('languages')
  CHECK: bun test packages/core/test/discover.test.ts -t languages
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G6: sha256Hex matches a known vector and countLoc matches the schema definition (empty, no trailing newline, CRLF); describe('hash')
  CHECK: bun test packages/core/test/discover.test.ts -t hash
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G7: loadConfig merges .greplost/config.json over DEFAULT_CONFIG and rejects invalid shapes with a clear error; describe('loadConfig')
  CHECK: bun test packages/core/test/config.test.ts -t loadConfig
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G8: fixtures/tiny-ts discovers exactly the 12 .ts files with the expected langs; describe('tiny-ts')
  CHECK: bun test packages/core/test/discover.test.ts -t tiny-ts
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G9: leaf files typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit
  EVIDENCE: pending

