# Gates: 1.4.1 cli

Scope: greplost command surface with stable --json output and the hook transport (spec: plugin-cli)

- [ ] G1: args test file passes
  CHECK: bun test packages/cli/test/args.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G2: commands test file passes
  CHECK: bun test packages/cli/test/commands.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G3: hook test file passes
  CHECK: bun test packages/cli/test/hook.test.ts
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: pending

- [ ] G4: query --json shape and content on tiny-ts (symbol and file forms); describe('query')
  CHECK: bun test packages/cli/test/commands.test.ts -t query
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G5: impact --json radius equals manifest blast and lists depth-2 dependents; describe('impact')
  CHECK: bun test packages/cli/test/commands.test.ts -t impact
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G6: verify exit codes and --diff text after drift, update restores; describe('verify')
  CHECK: bun test packages/cli/test/commands.test.ts -t verify
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
  EVIDENCE: pending

- [ ] G7: version prints the package version
  CHECK: bun packages/cli/src/main.ts --version
  EXPECT: greplost 0.0.1
  EVIDENCE: pending

- [ ] G8: node bundle builds and runs
  CHECK: bun run --cwd packages/cli build >/dev/null && node packages/cli/bin/greplost.js --version
  EXPECT: greplost 0.0.1
  EVIDENCE: pending

- [ ] G9: bundled binary inits and verifies a fixture copy with vendored grammars
  CHECK: d=$(mktemp -d) && cp -R fixtures/tiny-ts/. "$d" && node packages/cli/bin/greplost.js init --no-hooks --root "$d" >/dev/null && node packages/cli/bin/greplost.js verify --root "$d" && echo BUNDLE OK
  EXPECT: BUNDLE OK
  EVIDENCE: pending

- [ ] G10: cli package typechecks
  CHECK: bunx tsc -p packages/cli/tsconfig.json --noEmit
  EVIDENCE: pending

