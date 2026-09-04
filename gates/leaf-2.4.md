# Gates: 2.1.2 rust

Scope: Rust extraction (items, impl methods, visibility, use trees, `mod` items as import edges,
call sites), Rust resolution (crate roots found through `Cargo.toml` including `[[bin]]` and
`[[example]]` targets, the module tree walked to `<seg>.rs` or `<seg>/mod.rs`, `[workspace]
members`, `super::`/`self::`, everything else `ext:crate/<first segment>`), the drop rule for
trait-dispatched calls, the `fixtures/tiny-rust` fixture, and the independent `syn` plus
`cargo metadata` truth generator with a corpus gate on ripgrep.
Spec: `docs/superpowers/specs/2026-09-04-languages-iac-signals-design.md` sections 0, 1.1, 1.3,
1.6, 1.8, 5.1.

- [x] G1: the Rust extraction test file passes
  CHECK: bun test packages/core/test/extract-rust.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 54 expect() calls | Ran 40 tests across 1 file. [116.00ms]

- [x] G2: every item kind maps to its `DeclKind`, an `impl` method carries the impl's type as its parent and signatures keep generics to the 200-char cap; describe('declarations')
  CHECK: bun test packages/core/test/extract-rust.test.ts -t declarations 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 16 expect() calls | Ran 7 tests across 1 file. [53.00ms]

- [x] G3: one import record per leaf of a use tree, globs give `name: "*"`, `pub use` sets `reexport`, `extern crate` is a static import; describe('use trees')
  CHECK: bun test packages/core/test/extract-rust.test.ts -t "use trees" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 9 expect() calls | Ran 8 tests across 1 file. [53.00ms]

- [x] G4: a bodyless `mod` item is an import of the module's file, resolved through the crate root; describe('mod tree')
  CHECK: bun test packages/core/test/extract-rust.test.ts -t "mod tree" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 4 expect() calls | Ran 3 tests across 1 file. [50.00ms]

- [x] G5: call shapes resolve at the documented confidence, macro invocations are not calls, and a method on a generic or `dyn` receiver is dropped rather than guessed; describe('calls')
  CHECK: bun test packages/core/test/extract-rust.test.ts -t calls 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 13 expect() calls | Ran 13 tests across 1 file. [81.00ms]

- [x] G6: `pub`, `pub(crate)` and `pub(in …)` set `exported` and `meta.visibility`, a private item does neither; describe('visibility')
  CHECK: bun test packages/core/test/extract-rust.test.ts -t visibility 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 3 expect() calls | Ran 3 tests across 1 file. [53.00ms]

- [x] G7: the fixture builds with the expected module-tree imports, the `pub use` re-export and the resolved `Store::new`/`s.put` calls; describe('tiny-rust')
  CHECK: bun test packages/core/test/extract-rust.test.ts -t tiny-rust 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 9 expect() calls | Ran 6 tests across 1 file. [77.00ms]

- [x] G8: the truth generator test file passes
  CHECK: bun test bench/test/truth-rust.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 51 expect() calls | Ran 18 tests across 1 file. [330.00ms]

- [x] G9: the oracle imports nothing from `packages/core` and its output tracks the fixture; describe('oracle independence')
  CHECK: bun test bench/test/truth-rust.test.ts -t "oracle independence" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: 14 expect() calls | Ran 3 tests across 1 file. [157.00ms]

- [x] G10: S1 to S4 pass on the fixture
  CHECK: bun run bench:structural --fixture tiny-rust --lang rust --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: S6  signal node precision                  >=0.95           n/a            not measured by this oracle | structural: GATE PASS

- [x] G11: S1 to S4 pass on the pinned corpus repo (ripgrep, subset `crates/`, 95 `.rs`)
  CHECK: bun bench/src/cli.ts corpus setup --repo ripgrep >/dev/null && bun run bench:structural --repo ripgrep --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS
  EVIDENCE: S6  signal node precision                  >=0.95           n/a            not measured by this oracle | structural: GATE PASS

- [x] G12: the core and bench suites are green
  CHECK: bun test packages/core bench 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 4494 expect() calls | Ran 924 tests across 26 files. [50.19s]

- [x] G13: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: (no output)
