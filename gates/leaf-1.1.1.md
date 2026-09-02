# Gates: 1.1.1 ts-extract

Scope: tree-sitter parser handle plus TS/TSX/JS extraction into FileRecord (spec: docs/superpowers/specs/2026-09-02-core-extract-design.md)

- [ ] G1: extract-ts test file passes
  CHECK: bun test packages/core/test/extract-ts.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G2: vendored grammars load (ts, tsx, go) and parse; describe('parser')
  CHECK: bun test packages/core/test/extract-ts.test.ts -t parser
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G3: declarations: function, class+methods, interface, type, enum, const/let/var, namespace, export default forms; describe('declarations')
  CHECK: bun test packages/core/test/extract-ts.test.ts -t declarations
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G4: imports: static, type, default, namespace, side-effect, dynamic with destructuring, require, import=require, export-from; describe('imports')
  CHECK: bun test packages/core/test/extract-ts.test.ts -t imports
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G5: exports: named, renamed, default, star, star-as, export-from, export=, module.exports; describe('exports')
  CHECK: bun test packages/core/test/extract-ts.test.ts -t exports
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G6: call sites: name, obj.m, this.m, new X, new ns.X, caller attribution, skip rules; describe('call sites')
  CHECK: bun test packages/core/test/extract-ts.test.ts -t "call sites"
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G7: signatures cut before bodies, whitespace collapsed, 200-char cap, spans 1-based inclusive; describe('signature')
  CHECK: bun test packages/core/test/extract-ts.test.ts -t signature
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G8: all 12 fixtures/tiny-ts files extract with the pinned counts (decls, imports, exports, calls per file); describe('tiny-ts')
  CHECK: bun test packages/core/test/extract-ts.test.ts -t tiny-ts
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G9: extracting the same source twice yields identical stableStringify output; describe('deterministic')
  CHECK: bun test packages/core/test/extract-ts.test.ts -t deterministic
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G10: leaf files typecheck under the strict base config
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit
  EVIDENCE: pending

