# Gates: 1.1.1 ts-extract

Scope: tree-sitter parser handle plus TS/TSX/JS extraction into FileRecord (spec: docs/superpowers/specs/2026-09-02-core-extract-design.md)

- [x] G1: extract-ts test file passes
  CHECK: bun test packages/core/test/extract-ts.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 198 expect() calls | Ran 96 tests across 1 file. [88.00ms]

- [x] G2: vendored grammars load (ts, tsx, go) and parse; describe('parser')
  CHECK: bun test packages/core/test/extract-ts.test.ts -t parser
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 44 expect() calls | Ran 14 tests across 1 file. [33.00ms]

- [x] G3: declarations: function, class+methods, interface, type, enum, const/let/var, namespace, export default forms; describe('declarations')
  CHECK: bun test packages/core/test/extract-ts.test.ts -t declarations
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 60 expect() calls | Ran 22 tests across 1 file. [34.00ms]

- [x] G4: imports: static, type, default, namespace, side-effect, dynamic with destructuring, require, import=require, export-from; describe('imports')
  CHECK: bun test packages/core/test/extract-ts.test.ts -t imports
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 17 expect() calls | Ran 13 tests across 1 file. [31.00ms]

- [x] G5: exports: named, renamed, default, star, star-as, export-from, export=, module.exports; describe('exports')
  CHECK: bun test packages/core/test/extract-ts.test.ts -t exports
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 17 expect() calls | Ran 9 tests across 1 file. [29.00ms]

- [x] G6: call sites: name, obj.m, this.m, new X, new ns.X, caller attribution, skip rules; describe('call sites')
  CHECK: bun test packages/core/test/extract-ts.test.ts -t "call sites"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 24 expect() calls | Ran 23 tests across 1 file. [42.00ms]

- [x] G7: signatures cut before bodies, whitespace collapsed, 200-char cap, spans 1-based inclusive; describe('signature')
  CHECK: bun test packages/core/test/extract-ts.test.ts -t signature
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 39 expect() calls | Ran 13 tests across 1 file. [32.00ms]

- [x] G8: all 12 fixtures/tiny-ts files extract with the pinned counts (decls, imports, exports, calls per file); describe('tiny-ts')
  CHECK: bun test packages/core/test/extract-ts.test.ts -t tiny-ts
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 13 expect() calls | Ran 7 tests across 1 file. [36.00ms]

- [x] G9: extracting the same source twice yields identical stableStringify output; describe('deterministic')
  CHECK: bun test packages/core/test/extract-ts.test.ts -t deterministic
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 4 expect() calls | Ran 3 tests across 1 file. [38.00ms]

- [x] G10: leaf files typecheck under the strict base config
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit
  EVIDENCE: (no output)

