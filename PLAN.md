# Plan: greplost

Depth: tree 5   Mode: orchestrated
Budget note: a full product (tool + benchmark harness + plugin) built to the tech spec; a competent single pass is several days of engineering, so this runs as waves of fresh subagents with the driver verifying every returned leaf.

Authority: `docs/greplost-tech-spec.md` (binding), then the sub-project specs in `docs/superpowers/specs/`, then this plan.

## Contract

Decided before fan-out. Everything a leaf could get wrong about its neighbours:

- Interfaces: `packages/core/src/schema.ts` is the shared type contract (driver-owned; a leaf that needs a change reports it, never edits it). Each sub-project spec lists the exact exported function signatures its modules provide and consume.
- Data ownership: one owner per file, declared per leaf below. A leaf may create only the files it owns and may read anything.
- Runtime and tooling: Bun 1.2 for dev, tests (`bun test`), and scripts; code targets Node-compatible APIs (`node:fs`, `node:path`, `node:crypto`), no `Bun.*` globals outside `bench/`. TypeScript strict (see `tsconfig.base.json`); `verbatimModuleSyntax`, so `import type` for types and explicit `.ts` extensions on relative imports.
- Package imports: `@greplost/core`, `@greplost/core/schema`, `@greplost/render`, `@greplost/sync`, `@greplost/semantic`, `@greplost/workspace`, `greplost` (workspace links). Wave 1 leaves import only from `@greplost/core/schema` and their own files.
- Dependencies are pre-declared in the package manifests; leaves do not add packages. A needed dependency is reported.
- Determinism: `compareStrings`/`compareEdges`/`compareDeclarations` for every sort; `stableStringify` for every JSON; no `Date`, absolute paths, hostnames or env values in structure-layer output.
- Naming: kebab-case file names, camelCase functions, PascalCase types, `*.test.ts` under each package's `test/`. Errors are thrown as `Error` with a `greplost:` free message; CLI adds the prefix.
- Tests: TDD; every leaf's gate names the test file; golden files under `test/golden/`, updated only with `GREPLOST_UPDATE_GOLDEN=1`.
- Commits: each leaf commits on its own branch in its worktree with messages `feat(<leaf>): …`/`test(<leaf>): …`, no attribution trailers. The driver merges.

## Tree

- 1 greplost .......................... gates/root.md
  - 1.1 core-extract .................. gates/node-1.1.md
    - 1.1.1 ts-extract ................ gates/leaf-1.1.1.md   [wave 1]
      Files: packages/core/src/parser.ts, packages/core/src/extract/ts.ts, packages/core/src/extract/index.ts, packages/core/test/extract-ts.test.ts
    - 1.1.2 resolve ................... gates/leaf-1.1.2.md   [wave 1]
      Files: packages/core/src/resolve/packages.ts, packages/core/src/resolve/tsconfig.ts, packages/core/src/resolve/resolver.ts, packages/core/src/resolve/index.ts, packages/core/test/resolve.test.ts
    - 1.1.3 graph ..................... gates/leaf-1.1.3.md   [wave 1]
      Files: packages/core/src/graph/link.ts, packages/core/src/graph/tarjan.ts, packages/core/src/graph/blast.ts, packages/core/src/graph/metrics.ts, packages/core/src/graph/index.ts, packages/core/src/serialize/json.ts, packages/core/src/serialize/write.ts, packages/core/src/serialize/read.ts, packages/core/src/serialize/index.ts, packages/core/test/graph.test.ts, packages/core/test/serialize.test.ts
    - 1.1.4 discover .................. gates/leaf-1.1.4.md   [wave 1]
      Files: packages/core/src/config.ts, packages/core/src/discover.ts, packages/core/src/hash.ts, packages/core/test/discover.test.ts, packages/core/test/config.test.ts
    - 1.1.5 build ..................... gates/leaf-1.1.5.md   [wave 2]
      Files: packages/core/src/build.ts, packages/core/src/graph/query.ts, packages/core/src/index.ts, packages/core/test/build.test.ts, packages/core/test/query.test.ts, packages/core/test/golden/tiny-ts/manifest.json, packages/core/test/golden/tiny-ts/graph/imports.jsonl, packages/core/test/golden/tiny-ts/graph/calls.jsonl, packages/core/test/golden/tiny-ts/graph/symbols.jsonl
  - 1.2 render ........................ gates/node-1.2.md
    - 1.2.1 primitives ................ gates/leaf-1.2.1.md   [wave 1]
      Files: packages/render/src/mermaid.ts, packages/render/src/ascii.ts, packages/render/src/split.ts, packages/render/src/tokens.ts, packages/render/src/slug.ts, packages/render/test/primitives.test.ts
    - 1.2.2 docs ...................... gates/leaf-1.2.2.md   [wave 2]
      Files: packages/render/src/docs/index-doc.ts, packages/render/src/docs/repo-map.ts, packages/render/src/docs/hotspots.ts, packages/render/src/docs/package-map.ts, packages/render/src/docs/api.ts, packages/render/src/docs/card.ts, packages/render/src/render.ts, packages/render/src/index.ts, packages/render/test/docs.test.ts, packages/render/test/golden/tiny-ts
  - 1.3 sync .......................... gates/node-1.3.md
    - 1.3.1 build-verify .............. gates/leaf-1.3.1.md   [wave 3]
      Files: packages/sync/src/artifacts.ts, packages/sync/src/build.ts, packages/sync/src/write.ts, packages/sync/src/verify.ts, packages/sync/src/index.ts, packages/sync/test/build.test.ts, packages/sync/test/verify.test.ts
    - 1.3.2 incremental ............... gates/leaf-1.3.2.md   [wave 4]
      Files: packages/sync/src/incremental.ts, packages/sync/src/state.ts, packages/sync/src/lock.ts, packages/sync/src/dirty.ts, packages/sync/src/githooks.ts, packages/sync/src/parse-cache.ts, packages/sync/src/init.ts, packages/sync/test/incremental.test.ts, packages/sync/test/lock.test.ts, packages/sync/test/githooks.test.ts
  - 1.4 plugin-cli .................... gates/node-1.4.md
    - 1.4.1 cli ....................... gates/leaf-1.4.1.md   [wave 5]
      Files: packages/cli/src/main.ts, packages/cli/src/args.ts, packages/cli/src/output.ts, packages/cli/src/index.ts, packages/cli/src/commands, packages/cli/test
    - 1.4.2 plugin .................... gates/leaf-1.4.2.md   [wave 6]
      Files: greplost-plugin
  - 1.5 bench ......................... gates/node-1.5.md
    - 1.5.1 truth-ts .................. gates/leaf-1.5.1.md   [wave 1]
      Files: bench/src/truth/ts.ts, bench/src/score.ts, bench/src/structural.ts, bench/src/results-io.ts, bench/test/truth-ts.test.ts, bench/test/score.test.ts
    - 1.5.2 adapters .................. gates/leaf-1.5.2.md   [wave 1]
      Files: bench/src/adapters/types.ts, bench/src/adapters/graphify.ts, bench/src/adapters/ua.ts, bench/src/adapters/crg.ts, bench/src/adapters/index.ts, bench/competitors.json, bench/fixtures/competitors, bench/test/adapters.test.ts
    - 1.5.3 corpus .................... gates/leaf-1.5.3.md   [wave 1]
      Files: bench/src/corpus.ts, bench/corpus.json, bench/src/machine.ts, bench/test/corpus.test.ts
    - 1.5.4 mapquality ................ gates/leaf-1.5.4.md   [wave 3]
      Files: bench/src/mapquality.ts, bench/src/mermaid-check.ts, bench/test/mapquality.test.ts
    - 1.5.5 replay-perf ............... gates/leaf-1.5.5.md   [wave 5]
      Files: bench/src/replay.ts, bench/src/perf.ts, bench/test/replay.test.ts, bench/test/perf.test.ts
    - 1.5.6 agent ..................... gates/leaf-1.5.6.md   [wave 6]
      Files: bench/src/agent.ts, bench/src/tasks.ts, bench/tasks, bench/test/agent.test.ts
    - 1.5.7 headtohead-report ......... gates/leaf-1.5.7.md   [wave 6]
      Files: bench/src/headtohead.ts, bench/src/report.ts, bench/src/charts.ts, bench/src/results-md.ts, bench/src/screenshots.ts, docs/tapes, bench/test/report.test.ts
  - 1.6 semantic ...................... gates/leaf-1.6.md     [wave 6]
    Files: packages/semantic
  - 1.7 workspace ..................... gates/leaf-1.7.md     [wave 6]
    Files: packages/workspace, fixtures/two-repo-workspace
  - 1.8 go ............................ gates/leaf-1.8.md     [wave 6]
    Files: packages/core/src/extract/go.ts, packages/core/src/resolve/go.ts, packages/core/test/extract-go.test.ts, bench/src/truth/go.ts, bench/truth/gocallgraph, bench/test/truth-go.test.ts, fixtures/tiny-go
  - 1.9 results (driver integration) . gates/node-1.9.md

Wave 6 leaf 1.8 also edits `packages/core/src/extract/index.ts` and `packages/core/src/resolve/resolver.ts` (adding the `go` branch only); their wave-1 owners are finished by then, so ownership transfers explicitly at that point.

## Waves

- wave 1: 1.1.1, 1.1.2, 1.1.3, 1.1.4, 1.2.1, 1.5.1, 1.5.2, 1.5.3 — all code against schema.ts alone; disjoint files.
- wave 2: 1.1.5, 1.2.2 — need the wave-1 core modules (build composes them; docs need a Snapshot to render and the primitives).
- wave 3: 1.3.1, 1.5.4 — need buildSnapshot + renderArtifacts (build-verify) and the artifact shape (mapquality).
- wave 4: 1.3.2 — needs build-verify's write/verify.
- wave 5: 1.4.1, 1.5.5 — need the full sync API.
- wave 6: 1.4.2, 1.5.6, 1.5.7, 1.6, 1.7, 1.8 — need the CLI (plugin, agent runner), sync (semantic, workspace), or finished core modules (go).
- wave 7: 1.9 driver integration: corpus runs, X1/X2/X4/X5, RESULTS.md, README, dogfood, CI green.

## Status log

Append-only. One line per event.

- 2026-09-02 plan written, contract fixed (schema.ts, 8 sub-project specs)
- 2026-09-02 spec received from user; scaffold committed f941b3d; plan-check OK (21 leaves, 6 waves); 213 gates red
- 2026-09-02 wave 1 dispatched: 1.1.1, 1.1.2, 1.1.3, 1.1.4, 1.2.1, 1.5.1, 1.5.2, 1.5.3 (worktree subagents)
- 2026-09-02 leaf 1.1.4 discover merged (5215fd8), driver re-verified 9/9 gates PASS; Ruling (leaf): fast-glob ignore option dropped so picomatch is the sole exclude mechanism in both discovery modes; task review dispatched
- 2026-09-02 leaf 1.5.3 corpus merged (8a8a232), driver re-verified 6/6 gates PASS; corpus anyq+gin cloned; Rulings (leaf): --repo > --all > --tier precedence, unknown names throw; task review dispatched
- 2026-09-02 leaf 1.2.1 render-primitives merged (935c067), driver re-verified 9/9 gates PASS; Rulings (leaf): split direction LR, flat-group pagination, overview pagination, edge-count summing, self-edge dropping (see report); task review dispatched
- 2026-09-02 leaf 1.1.4 review: Approved; Important: glob-mode dot:false drops dotfiles before picomatch (git/non-git asymmetry) -> fix round 1/5 dispatched to the implementer; minors deferred: toPosix backslash replace, glob walk without ignore (perf), nested-merge semantics unspecified
