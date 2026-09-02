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
- Immutability: `FileRecord`s handed to or returned from a `ParseCache`, and every entry of `Snapshot.files`, are frozen and must never be mutated by any consumer (render, sync, semantic); copy before changing (ruling 2026-09-02).
- Identifiers: never name a function or variable `declare` (Bun's transpiler silently drops calls to a top-level `declare(...)`); prefer `declareX` names (ruling 2026-09-03).
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
- 2026-09-02 leaf 1.5.3 review: Approved; Important: shallow/deepen path untested, initial clone unbounded for L/XL -> fix round 1/5 dispatched; Ruling: clone via init+fetch --depth=600 --filter=blob:none of the SHA; minors deferred: git spawn error message, os.type alias, list output format undocumented
- 2026-09-02 leaf 1.1.2 resolve merged (95b88af), driver re-verified 9/9 gates PASS, core suite 120 pass; concerns logged: root package not name-resolvable (ruling pending review), detectPackages reads fs directly, ** roots cost a walk, workspace-glob source unused, go branch stubbed; task review dispatched
- 2026-09-02 leaf 1.5.1 truth-ts merged (751a2d2), driver re-verified 7/7 gates PASS; concerns: class-field-initializer calls attributed to the class (matches spec), export= reported as default, real S1-S4 path awaits buildSnapshot, results dir added by driver; task review dispatched
- 2026-09-02 leaf 1.1.4 fix round 1/5 merged (5fce6a8): dot:true in glob mode, 3 tests added, 9/9 gates re-verified; scoped re-review dispatched
- 2026-09-02 leaf 1.1.3 graph merged (e432982), driver re-verified 11/11 gates PASS; Ruling: packageEdges/deps use plain package names (manifest keys), not pkg: ids; concerns: bitset memory ~V^2/8 (fallback needed beyond ~50k files, deferred), one-hop import-then-export resolution and declared-target rule added (documented); task review dispatched
- 2026-09-02 leaf 1.2.1 review: Needs fixes; Critical: literal NUL bytes in split.ts (binary to git); Important: mermaid label escaping misses # ; < >; Minor: deep relLink/cardPath tests -> fix round 1/5 dispatched; Ruling: two-level Map instead of delimiter, escape set widened
- 2026-09-02 leaf 1.1.1 ts-extract merged (2634c09), driver re-verified 10/10 gates PASS; core suite 256 pass, typecheck OK; concerns: countLines duplicates countLoc (1.1.5 to unify), type-position import() labelled dynamic (to 1.1.1 fix round after review), destructured export const unsupported (v1); task review dispatched
- 2026-09-02 wave 2 dispatched: 1.1.5 core build (1.2.2 render docs waits for 1.1.5 and the 1.2.1 fix round)
- 2026-09-02 leaf 1.1.4: fix round 1/5 (1 addressed, 0 open; commits 705a4fa..795b558)
- 2026-09-02 leaf 1.1.4: complete (commits f941b3d..795b558, review clean); minor (deferred): unconditional .git/ prefix drop in fallback mode (currently relies on DEFAULT_CONFIG exclude), commit prefix fix(<leaf>) added to the convention
- 2026-09-02 leaf 1.1.2 review: Approved; Important x3: baseUrl fallback without declared baseUrl, null exports target not blocking, root self-name imports external -> fix round 1/5 dispatched; Ruling: root package name is resolvable (no schema change); minors folded: # fallthrough to paths, best-pattern-only paths matching, imports map escape guard, compareStrings; deferred: symlink literal-vs-glob stat inconsistency, nearest-tsconfig shadowing (spec rule), double manifest read
- 2026-09-02 leaf 1.5.1 review: Needs fixes; Critical: truth caller rule broader than core (non-function initializers) -> S3 false positives; Important: empty truth still prints GATE PASS, export* depth contradiction, structural --fixture --gate test missing; NUL bytes in truth/ts.ts -> fix round 1/5 dispatched
- 2026-09-02 Ruling: export * chains are followed transitively for the export name set in core (spec 5.1 said one level; S2 recall vs tsc is the binding number); call-edge re-export resolution stays one hop (med). Assigned to the 1.1.3 fix round. Truth stays transitive.
- 2026-09-02 leaf 1.1.3 review: Needs fixes; Important: unresolvable re-export pin can fabricate a high call edge (link.ts:212) -> fix round 1/5 dispatched with the export-star transitive ruling; Ruling: importKind joins the linkImports dedupe key; minors folded: med-then-high test, shared packageOf; deferred: bitset memory at 50k files
- 2026-09-02 leaf 1.5.2 adapters merged, driver re-verified 7/7 gates PASS; pinned graphify v0.9.53 (Graphify-Labs/graphify@33362d9), ua v2.9.0 (Egonex-AI/Understand-Anything@f08763d), crg v2.3.8 (tirth8205/code-review-graph@2c6dae3); concerns: fixtures hand-written (diff against one real run before X1), adapters do not filter by include/exclude (1.5.7 must intersect file sets), three mapping judgement calls for maintainers; task review dispatched
- 2026-09-02 leaf 1.1.1 review: Approved with fix round 1/5; Important: caller attribution by name (shadowing), non-null-asserted callees dropped, type-position import() edges, vacuous syntax-error test; Rulings (spec amendments): class-field arrows/abstract/declare methods are method declarations; namespace members tracked at any depth (N.f); static blocks attribute to the class; import("x").T is a type import on both sides; destructured export const stays unsupported in v1; ts.ts split into four files; countLines unification stays with 1.1.5
- 2026-09-02 leaf 1.2.1 fix round 1/5 merged: NUL delimiter removed (two-level Map), label escaping widened via single-pass replacer, 9/9 re-verified; scoped re-review dispatched
- 2026-09-02 leaf 1.1.2 fix round 1/5 merged (ac99cec): baseUrlDeclared gate, blocked exports subpaths, root self-name resolution, # fallthrough, best-pattern paths, imports escape guard; 9/9 re-verified, core 264 pass; scoped re-review dispatched
- 2026-09-02 leaf 1.5.3 fix round 1/5 merged (2d7a1a0): init+fetch --depth=600 --filter=blob:none, deepen tests on an 8-commit fixture, gin lands at 600 commits shallow; 6/6 re-verified on fresh clones; scoped re-review dispatched
- 2026-09-02 leaf 1.2.1: fix round 1/5 (3 addressed, 0 open; commits df4062a..dcb7f22)
- 2026-09-02 leaf 1.2.1: complete (commits f941b3d..dcb7f22, review clean)
- 2026-09-02 leaf 1.5.2 review: Approved, no fix round; leaf 1.5.2: complete (commits f941b3d..125fd16, review clean); forward items: (a) capture one real run per competitor and diff against the hand-written fixtures before publishing X1 (node-1.9 R4 precondition), (b) leaf 1.5.7 must intersect truth and every prediction with greplost's indexed file set, (c) minor: G1 evidence counts drifted (40 vs 44 tests)
- 2026-09-02 leaf 1.1.3 fix round 1/5 merged (1542c9b): unpinned export targets, transitive export * via star-graph condensation, importKind in dedupe key, shared packageOf; 11/11 re-verified, core 266 pass; scoped re-review dispatched
- 2026-09-02 leaf 1.1.2: fix round 1/5 (8 addressed, 0 open; commits bdd3dfd..ac99cec); complete (review clean); minors deferred: pattern tie-break ignores suffix specificity, less-specific exports pattern tried after a NO_MATCH on the best one
- 2026-09-02 leaf 1.5.3: fix round 1/5 (4 addressed, 0 open; commits 5ab3d8c..2d7a1a0); complete (review clean); minor deferred: partial init (git dir without origin remote) is not auto-repaired
- 2026-09-02 leaf 1.1.1 fix round 1/5 merged (266ad20): node-identity callers, non-null callees, method/namespace/static-block rulings, type-position imports, ts.ts split; 10/10 re-verified; scoped re-review dispatched
- 2026-09-02 leaf 1.5.1 fix round 1 committed on its branch (3d0af6a): caller rule matched to core, ImportTypeNode edges, namespace paths, truth-empty gate miss, gate lines on error paths, NUL-free EdgeSet; G1 red until 1.1.5 lands; Ruling: semantic diagnostics opt-in (--diagnostics), merge deferred until core build lands
- 2026-09-02 leaf 1.1.3: fix round 1/5 (5 addressed, 0 open; commits be1b1e1..1542c9b); complete (review clean); spec text updated for the dedupe key and transitive export *; deferred: ambiguous star names pinned to the first star (tsc excludes; watch S2/S3 on corpus), graph layer now imports the resolve barrel (fs deps), resolveMember unpinned guard lacks a biting test, PackageEdge.count counts type+value imports separately
- 2026-09-02 leaf 1.1.5 build merged, driver re-verified 10/10 gates PASS; goldens regenerated after both core fixes; fixture facts confirmed end to end; fixes: parse cache keyed by (lang, sha256), re-stamp of Declaration.file/id, countLines->countLoc; task review dispatched
- 2026-09-02 leaf 1.5.1 fix round 1/5 merged (3d0af6a, 6653c43): caller rule = core, ImportTypeNode edges, truth-empty gate miss, diagnostics opt-in, NUL-free; scoped re-review pending
- 2026-09-02 wave 2: 1.2.2 render docs dispatched (core build + primitives fix landed)
- 2026-09-02 node-1.1 integration: N1-N4 PASS; N5 FAIL: anyq S1 precision 0.805 (66 fp = workspace-name imports resolved to src/index.ts; tsc cannot resolve them in an uninstalled, unbuilt checkout), S2 1.0, S3 precision 0.973 (recall 0.816), S4 1.0. Ruling: truth emulates the installed+built state via workspace manifests + tsconfig outDir/rootDir mapping (documented in RESULTS.md); fix round 2/5 dispatched to 1.5.1; S3 fp/fn lists requested
- 2026-09-02 leaf 1.1.1: fix round 1/5 (12 addressed, 0 open; commits e7d457b..266ad20); complete (review clean); deferred deltas vs truth: (x as any).y() and (a)!.b() are truth edges the extractor drops (recall only), decorator calls on function-valued fields attribute to the field, declare-namespace members not marked exported, imports inside namespace bodies invisible, namespace/class merged-name id collision (both sides identical)
- 2026-09-02 leaf 1.1.5 review: Approved; Important x2 (handoff contract): ParseCache.get(sha256, lang) and frozen records -> rulings applied to specs and Contract, fix round 1/5 dispatched to 1.1.5; minors folded: findSymbols anchors on name, parse failures rethrown with path; deferred: batch read concurrency, second fixture for fix-round coverage, gate evidence drift
- 2026-09-02 leaf 1.5.1: fix round 1/5 re-review clean (all addressed); round 2/5 in flight (workspace entry mapping, verbose fp/fn, missing-tsconfig not an error, results-dir override documented); bench spec Truth interface updated
- 2026-09-02 leaf 1.1.5 fix round 1/5 merged (951bf56): ParseCache.get(sha256, lang), frozen records, findSymbols by name, parse errors carry the path; 10/10 re-verified, goldens unchanged, suite 526 pass; scoped re-review dispatched
- 2026-09-02 leaf 1.5.1 fix round 2/5 merged (519a72b): workspace entry mapping installed on the compiler host (resolveModuleNameLiterals), anyq S1 1.0/1.0 S2 1.0 S3 p1.0 r0.303 S4 1.0 GATE PASS; Ruling: host-level mapping ratified (documented in RESULTS.md); Ruling: call edges follow re-export chains to any depth at med, ambiguous star names dropped (spec 5.1 amendment) -> fix round 2/5 for 1.1.3; scoped re-review of 1.5.1 round 2 dispatched
- 2026-09-02 leaf 1.1.5: fix round 1/5 (5 addressed, 0 open; commits 20c2ec2..951bf56); complete (review clean); minors deferred: findSymbols anchoring test does not discriminate the old bug, parse rethrow lacks cause chaining
- 2026-09-02 leaf 1.5.1: fix round 2/5 re-review clean; complete (commits f941b3d..519a72b); minors deferred: --fp swallows the next arg, exports condition set lacks node/bun/browser, require-only maps yield an edge for ESM imports, legacy deep subpaths not resolved, pattern-key null does not block, shared base tsconfig relative outDir falls back silently, truth notes only in the JSON payload, coverage gaps for --fp output and RESULTS_DIR warning
- 2026-09-02 leaf 1.8 go pulled forward from wave 6 and dispatched (dependencies merged: extractor seam, resolver, structural --fixture-go/--repo gin, gin clone); files disjoint from in-flight leaves except a Go branch in link.ts (merge ordered after 1.1.3 round 2)
- 2026-09-02 leaf 1.1.3 fix round 2/5 merged (a632212): calls through re-export chains at med; anyq all-confidence call recall 0.342->0.468, fp 0; S3 (high-only) unchanged by design; residual misses need type inference (interface/overload targets 218, non-imported callers 155); Ruling: diamond re-exports (same declaration via two stars) are not ambiguous -> round 3/5; re-review after round 3
- 2026-09-02 leaf 1.2.2 render docs merged (1647715), driver re-verified 10/10 gates PASS, suite 589 pass; driver observation: card field lines separated by single newlines render as one paragraph on GitHub -> to the review/fix round; concerns: render imports the core barrel for stronglyConnected, packageSlug not injective; task review dispatched
- 2026-09-02 wave 3 dispatched: 1.3.1 sync build-verify, 1.5.4 mapquality
- 2026-09-02 leaf 1.1.3 fix round 3/5 merged (227eef4): diamond re-exports pinned by the shorter arm; 11/11 re-verified, goldens unchanged; scoped re-review of rounds 2+3 dispatched
- 2026-09-02 leaf 1.2.2 review: Needs fixes; Critical: card field lines collapse into one paragraph on GitHub and Calls is swallowed by the last bullet; Important: unbackticked <pkg>/<file> placeholders stripped, degradation ladder leaves 78 percent of the INDEX budget unspent -> fix round 1/5 dispatched; Rulings: blank lines between card fields, backticked templates, re-maximise K per ladder step, throw on slug collision, hide 0-file packages from tree/diagram, anonymous default export listed in API.md, core exposes ./graph so render stops importing the barrel
- 2026-09-02 host power outage: five agents (1.5.4, 1.3.1, 1.8, 1.2.2 fix, 1.1.3 re-review) terminated by API timeouts mid-work; worktrees intact with uncommitted files; all five resumed from their transcripts
- 2026-09-02 leaf 1.1.3: rounds 2+3 re-review clean (code); spec drift fixed (ExportTarget.hops number, chain semantics, diamond rule, Appendix C row); complete (commits f941b3d..227eef4); deferred: cyclic star arm poisons a name tsc would resolve (recall only), no test for the poisoned-arm diamond or deep DFS
- 2026-09-02 leaf 1.5.4 mapquality merged (9520b51), driver re-verified 6/6 gates PASS, checker: mermaid (headless under Bun); node-1.2 N4 checked; task review dispatched
- 2026-09-03 leaf 1.2.2 fix round 1/5 merged (1c95f3e): GitHub-safe cards, backticked templates, ladder re-maximisation, slug collision throw, 0-file packages hidden from tree/diagram, localNames fix for renamed/default exports; 10/10 re-verified; scoped re-review dispatched
- 2026-09-03 leaf 1.5.4 review: Approved; Important x2: gate line printed without --gate on error paths, corpus payload shape diverges -> fix round 1/5 dispatched; Ruling: corpus keeps the shared pinned shape (empty for arbitrary dirs), analysed dir goes in target.dir, --repo added; minors: config parse diagnostic, nested-fence assumption comment; deferred: jsdom shim global window during first import
- 2026-09-03 leaf 1.3.1 sync build-verify merged (321cd36), driver re-verified 8/8 gates PASS, suite green; Ruling: core golden stays bare and render golden stays seeded, the divergence is pinned by the golden-union test; task review dispatched; wave 4: 1.3.2 incremental dispatched
- 2026-09-03 leaf 1.5.4 fix round 1/5 merged (4d89168): gate line only with --gate, shared corpus shape + target.dir, --repo/--fixture; 6/6 re-verified; scoped re-review dispatched
- 2026-09-03 leaf 1.2.2: fix round 1/5 (9 addressed, 0 open; commits 1647715..1c95f3e); complete (review clean); deferred: ladder retries the full tree before dropping hotspots (unreachable at normal scale), renamed exports render under the local name (alias not shown), named-default export untested, slug-collision throw unhandled in sync build (surface as a clear CLI error)
- 2026-09-03 leaf 1.5.4: fix round 1/5 (4 addressed, 0 open; commits 9520b51..4d89168); complete (review clean); deferred: catch-all gate reason is always 'error'
- 2026-09-03 leaf 1.3.1 review: Needs fixes; Critical: symlinked intermediate dir lets writeArtifacts write/delete outside .greplost; Important: discard-before-retry on transient write errors, fixture lacks a committed summaries cache -> fix round 1/5 dispatched; Rulings: realpath containment + lstat walk, retry only on EACCES/EPERM/EISDIR/ENOTDIR, squatting dirs removed only when greplost-owned, fixture stays cache-free, 199+1 diff cap, extra exports documented
- 2026-09-03 leaf 1.8 go merged (343ba3e), driver re-verified 7/7 gates PASS; gin S1 1.0/1.0 S2 1.0/1.0 S3 p1.0 r0.616 S4 1.0; Ruling: structural.ts directory-target edit ratified; C2 (Go metrics/importers zero because directory targets are skipped) -> fix round after review with a shared expandDirectoryTargets helper; C7 -> contract line; C4 -> CI runs go mod download (no vendoring); task review dispatched
- 2026-09-03 leaf 1.3.1 fix round 1/5 merged (44054ec): lstat segment walk + realpath containment, guarded retry, owned-only deletes; Ruling: a regular file blocking a directory segment is refused (not deleted); 8/8 re-verified; scoped re-review dispatched
