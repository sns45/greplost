# Gates: 1.8 go

Scope: Go extraction, resolution and truth generator; S1 to S4 on gin (spec: go)

- [ ] G1: extract-go test file passes
  CHECK: bun test packages/core/test/extract-go.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G2: truth-go test file passes
  CHECK: bun test bench/test/truth-go.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G3: tiny-go fixture extracts and resolves with the pinned counts (directory-id imports, method receivers, same-package calls); describe('tiny-go')
  CHECK: bun test packages/core/test/extract-go.test.ts -t tiny-go
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G4: structural gate passes on tiny-go against go truth
  CHECK: bun run bench:structural --fixture-go --gate
  EXPECT: structural: GATE PASS
  EVIDENCE: pending

- [ ] G5: structural gate passes on gin (tier S, go)
  CHECK: bun run bench:structural --repo gin --gate
  EXPECT: structural: GATE PASS
  EVIDENCE: pending

- [ ] G6: core and bench still green with go enabled
  CHECK: bun test packages/core bench
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G7: core and bench typecheck
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit && bunx tsc -p bench/tsconfig.json --noEmit
  EVIDENCE: pending

