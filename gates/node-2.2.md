# Gates: 2.2 iac (integration)

Scope: leaves 2.2.1 terraform, 2.2.2 k8s-helm, 2.2.3 actions and 2.2.4 dockerfile merged. These
are the four formats that produce non-file nodes and reference edges, so this node is also where
`graph/references.jsonl` is proven end to end. Spec sections 2.1 to 2.6.

- [ ] N1: every child gates file is fully met
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status gates/leaf-2.2.md gates/leaf-2.8.md gates/leaf-2.9.md gates/leaf-2.10.md
  EXPECT: ALL MET

- [ ] N2: core typechecks as one package
  CHECK: bunx tsc -p packages/core/tsconfig.json --noEmit

- [ ] N3: the core test suite is green with all four formats present
  CHECK: bun test packages/core 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] N4: S1 to S5 hold on every IaC fixture
  CHECK: for f in tiny-terraform:hcl tiny-k8s:yaml tiny-helm:yaml tiny-actions:yaml tiny-docker:dockerfile; do bun run bench:structural --fixture "${f%%:*}" --lang "${f##*:}" --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -q 'structural: GATE PASS' || { echo "FAIL ${f%%:*}"; exit 1; }; done; echo "fixtures: 5 of 5 PASS"
  EXPECT: fixtures: 5 of 5 PASS

- [ ] N5: S1 to S5 hold on every pinned IaC corpus repo
  CHECK: for r in tf-aws-vpc tf-aws-eks k8s-examples bitnami-charts starter-workflows docker-python docker-node; do bun run bench:structural --repo "$r" --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g' | grep -q 'structural: GATE PASS' || { echo "FAIL $r"; exit 1; }; done; echo "corpora: 7 of 7 PASS"
  EXPECT: corpora: 7 of 7 PASS

- [ ] N6: every node id is unique within its file and every reference edge resolves to a real node
  CHECK: bun test packages/core/test/references.test.ts 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [ ] N7: no reference edge targets an unresolved id; describe('references jsonl round trip')
  CHECK: bun test packages/core/test/references.test.ts -t "references jsonl round trip" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/

- [ ] N8: a repo with no IaC files still writes no references.jsonl
  CHECK: bun test packages/core/test/references.test.ts -t "absent references file" 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n(?: \d+ filtered out\n)? 0 fail/
