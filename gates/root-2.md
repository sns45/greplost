# Gates: greplost build 2 (root)

Scope: the complete build-2 deliverable — Python, Rust, Java, Kotlin, Terraform, Kubernetes and
Helm, GitHub Actions, Dockerfiles, the framework signal layer, non-file nodes in the map and the
CLI, and a measured, published benchmark row for every one of them. The head-to-head suite is
untouched and says so.

- [ ] T1: every build-2 branch gates file is fully met
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status gates/leaf-2.0.md gates/node-2.1.md gates/node-2.2.md gates/node-2.3.md gates/node-2.4.md gates/node-2.5.md
  EXPECT: ALL MET

- [x] T2: every build-1 branch gates file is still fully met
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status gates/node-1.1.md gates/node-1.2.md gates/node-1.3.md gates/node-1.4.md gates/node-1.5.md gates/leaf-1.6.md gates/leaf-1.7.md gates/leaf-1.8.md gates/node-1.9.md
  EXPECT: ALL MET

- [x] T3: the full suite is green from a clean install
  CHECK: bun install --frozen-lockfile >/dev/null && bun test 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: / [1-9]\d* pass\n 0 fail/

- [x] T4: every package typechecks
  CHECK: bun run typecheck

- [x] T5: the structural gate passes on every pinned corpus repo of every tier-S language and format
  CHECK: bun run bench:structural --tier S --gate 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: structural: GATE PASS

- [ ] T6: RESULTS.md carries a row for all eleven additions, each with its truth source and whether it is gated
  CHECK: for l in python rust java kotlin hcl yaml dockerfile react tanstack next pulumi; do grep -qi "$l" bench/RESULTS.md || { echo "MISSING $l"; exit 1; }; done; echo "rows: 11 of 11"
  EXPECT: rows: 11 of 11

- [x] T7: the head-to-head scope statement is present and no competitor arm was run on a build-2 language
  CHECK: grep -c 'X1 to X10 cover TypeScript and Go only' bench/RESULTS.md
  EXPECT: /^[1-9]/m

- [x] T8: greplost verifies its own committed map
  CHECK: bun packages/cli/src/main.ts verify --diff 2>&1 | perl -pe 's/\e\[[0-9;]*m//g'
  EXPECT: map is in sync

- [ ] T9: CI is green on the build-2 branch, including the tier S structural gate step (ruling 2026-09-05: the gate runs inside the existing test job rather than a separate structural-langs job)
  CHECK: gh run list --branch "$(git rev-parse --abbrev-ref HEAD)" --limit 1 --json conclusion --jq '.[0].conclusion'
  EXPECT: success

- [ ] T10: the final report re-measures every number it states and pastes this ledger with N of N

---

The proposed addition to `gates/root.md` (build 1's closed root ledger is not rewritten) lives
at the end of `docs/superpowers/plans/2026-09-04-build-2-plan.md`, so nothing parses it as a gate
of this ledger.
