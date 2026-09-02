# Sub-project spec: bench

Implements tech spec sections 10 and 11 entirely. Package: `bench/` (`@greplost/bench`). Driver-owned dispatcher: `bench/src/cli.ts` (each suite module exports `run(args: string[]): Promise<number>`; do not edit the dispatcher).

Principles (10.1) are binding: deterministic scoring, compiler truth, pinned everything, real baselines, variance reported, losses published.

## Leaves and ownership

| Leaf | Files | Delivers |
|---|---|---|
| 1.5.1 truth-ts | `src/truth/ts.ts`, `src/score.ts`, `src/structural.ts`, `src/results-io.ts`, `test/truth-ts.test.ts`, `test/score.test.ts` | Eval 1 (S1 to S4) |
| 1.5.2 adapters | `src/adapters/{types,graphify,ua,crg,index}.ts`, `competitors.json`, `fixtures/competitors/**`, `test/adapters.test.ts` | competitor artifacts → Edge[] |
| 1.5.3 corpus | `src/corpus.ts`, `corpus.json`, `src/machine.ts`, `test/corpus.test.ts` | pinned corpus setup, machine profile |
| 1.5.4 mapquality | `src/mapquality.ts`, `src/mermaid-check.ts`, `test/mapquality.test.ts` | M1, M2, Mermaid parse gate |
| 1.5.5 replay-perf | `src/replay.ts`, `src/perf.ts`, `test/replay.test.ts`, `test/perf.test.ts` | Eval 2 (F1, F2), Bench 3 (P1 to P3) |
| 1.5.6 agent | `src/agent.ts`, `src/tasks.ts`, `tasks/*.json`, `test/agent.test.ts` | Eval 4 (A1 to A4), X7, X8 runner |
| 1.5.7 headtohead-report | `src/headtohead.ts`, `src/report.ts`, `src/charts.ts`, `src/results-md.ts`, `src/screenshots.ts`, `docs/tapes/*.tape`, `test/report.test.ts` | X1 to X10 orchestration, RESULTS.md, charts, screenshots |

## Shared conventions

- Results: `bench/results/<suite>-<YYYY-MM-DD>-<sha7>.json` written by every suite through `results-io.ts` (`writeResult(suite, payload)`, `latestResult(suite)`); payload always carries `{ suite, date, greplostSha, machine, corpus: [...pinned], ...data }`. `bench/results/` is committed.
- Common args: `--tier S|M|L|XL` (default S), `--repo <name>` (single corpus repo), `--fixture` (use `fixtures/tiny-ts`, hermetic; every suite supports it so tests need no network), `--gate` (exit 1 when a target in tech spec section 3 is missed), `--dry-run` (produce the output shape without running the expensive part; used by `bench all --dry-run`).
- Truth and predictions are compared with the same key: imports on `(from, to)` over repo files only (`ext:`/`unresolved:` targets excluded on both sides), calls on `(from, to)`, exports on `(file, name)`, cycles as sorted lists. A prediction whose `to` is a directory id (Go) is compared against directory-level truth.
- Never write to `bench/RESULTS.md` except from `report`.
- Output conventions (the gates match on these exact strings, printed as the last line on stdout): with `--gate`, `<suite>: GATE PASS` or `<suite>: GATE FAIL (<ids>)`; with `--dry-run`, `<suite>: dry-run ok`; `corpus setup` prints `<name>: ready at <sha>` per repo; `report` prints `report: wrote bench/RESULTS.md`; `headtohead` prints `headtohead: wrote bench/results/headtohead-<date>-<sha7>.json`; `screenshots --check` prints `screenshots: <n> available, <m> missing`; `adapters roundtrip` prints `<tool>: <n> imports, <m> calls` per tool; `mapquality` prints `checker: mermaid|subset` and, with `--gate`, the gate line. Every suite exports `run(args: string[]): Promise<number>` and returns the exit code instead of calling `process.exit`.
- Extra args: `structural` accepts `--fixture` (tiny-ts), `--fixture-go` (tiny-go, leaf 1.8) and `--repo <name>`; `mapquality` accepts `--dir <artifact dir>` (default: `.greplost` of the current repo); `replay` accepts `--fixture`, `--repo`, `--commits <n>`; `perf` accepts `--fixture`, `--tier`; `headtohead` accepts `--metrics X1,X2,...`, `--tier`, `--repo`, `--commits`, `--fixture`.

## 1.5.1 truth-ts and structural

```ts
export interface Truth { files: string[] /* the files the compiler loaded; both sides are scored over this set */; imports: Edge[]; exports: Record<string, string[]>; calls: Edge[]; cycles: string[][]; notes: string[] /* e.g. ["workspace-entry-mapping"], empty when the compiler needed no emulation; the Go truth generator must supply it too */; }
export function generateTsTruth(root: string, files: string[], options?: { diagnostics?: boolean }): Truth;   // semantic diagnostics are opt-in (--diagnostics / GREPLOST_BENCH_DIAGNOSTICS=1); workspace package names resolve through package manifests and tsconfig outDir/rootDir to their source entry (ruling 2026-09-02, documented in RESULTS.md)
export interface Score { precision: number; recall: number; f1: number; tp: number; fp: number; fn: number; falsePositives: string[]; falseNegatives: string[]; }
export function scoreSet(pred: string[], truth: string[]): Score;
export function scoreEdges(pred: Edge[], truth: Edge[]): Score;             // keys `${from} -> ${to}`
export function jaccardCycles(pred: string[][], truth: string[][]): number;
```

`generateTsTruth`: `ts.createProgram(files, compilerOptions)` with options from the repo's root `tsconfig.json` (`ts.parseJsonConfigFileContent`) falling back to `{ allowJs: true, moduleResolution: Bundler, target: ES2022 }`. Imports: every `ImportDeclaration`, `ExportDeclaration` with a module specifier, `ImportEqualsDeclaration` with `require`, dynamic `import("lit")` and `require("lit")` calls → `ts.resolveModuleName(spec, file, options, ts.sys)`; keep only targets inside the file list (map `.d.ts`/`.js` results back to a listed source file when the resolved path differs only by extension). Exports: `checker.getExportsOfModule(moduleSymbol)` names (`export *` followed by tsc naturally). Calls: for every `CallExpression`/`NewExpression`, `checker.getSymbolAtLocation(callee identifier or property name)` → resolve aliases (`getAliasedSymbol`) → declaration's source file + symbol path (`Class.member` for methods, name otherwise); keep only declarations in listed files; caller = enclosing function/method/variable initializer per the same rule as core's extractor; `from`/`to` in greplost id form. Cycles: Tarjan over the truth import graph (own small implementation; do not import core's).

`structural.ts` `run`: for each repo in the tier (or the fixture): `buildSnapshot`, `generateTsTruth`, score S1 (imports P/R), S2 (exports P/R), S3 (calls precision at confidence high, recall reported), S4 (cycles Jaccard); print a table; write results; `--gate` compares against `{ S1: [0.99, 0.97], S2: [0.99, 0.99], S3: 0.95, S4: 1.0 }` and prints the first 20 false positives as `file:line` (from the edge's `from` and the declaration span or import line). Exit 1 on miss.

Tests: fixture truth has the expected edge count, `retry` callers, the `bus ↔ events` cycle; `scoreEdges` on hand-built sets; `structural --fixture --gate` exits 0.

## 1.5.2 adapters

Research first (web access allowed): pin one version each of Graphify (graphify.net / its GitHub repo), Understand-Anything (`Lum1104/Understand-Anything`) and code-review-graph; record in `bench/competitors.json`: `{ name, repo, version, commit, install: [verbatim README commands], run: [verbatim commands], artifactPaths: [...], syncMechanism: string | null, notes }`. Capture a representative slice of each tool's real output format into `bench/fixtures/competitors/<tool>/` (hand-written to the documented schema when the tool cannot be run here; note the provenance in a `SOURCE.md` next to it).

```ts
export interface CompetitorArtifact { tool: "graphify" | "ua" | "crg"; version: string; imports: Edge[]; calls: Edge[]; nodes: string[]; raw: { files: string[]; bytes: number }; }
export interface Adapter { tool: CompetitorArtifact["tool"]; detect(dir: string): boolean; load(dir: string, repoRoot: string): CompetitorArtifact; }
export const adapters: Adapter[];
```

Each adapter maps the tool's node identity to greplost ids (repo-relative file paths; `file#symbol` for symbols) and its edge types to `import`/`call`, documenting every mapping line by line in comments. `run(["roundtrip"])` loads each fixture and prints counts; the round-trip test asserts that loading the fixture, serializing through `stableStringify`, and loading again yields identical edges, and that every emitted id is a valid greplost id.

## 1.5.3 corpus

`corpus.json`: `{ "repos": [ { "name": "anyq", "url": "https://github.com/sns45/anyq", "sha": "<40 hex>", "tier": "S", "lang": "ts" }, gin (S, go), hono (M, ts), bubbletea (M, go), vite (L, ts), grafana (L, go, subset: "pkg/"), TypeScript (XL, ts) ] }`. Pin SHAs with `gh api repos/<owner>/<repo>/commits/<default-branch>` at leaf time and record the date in a `pinnedAt` field. `run(["setup", "--tier", "S"])` clones into `bench/.corpus/<name>` (`git clone --filter=blob:none`, then `git checkout <sha>`; fetch enough history for 600 commits behind the SHA: `git fetch --deepen=600` when shallow). Idempotent. `machine.ts` returns `{ cpu, cores, memoryGB, os, arch, bun, node, go, greplostVersion, greplostSha }` with no hostname or username.

## 1.5.4 mapquality and mermaid-check

`checkMermaid(text): { ok: boolean; error?: string }` using `mermaid.parse` under jsdom (`mermaid` 11 + `jsdom`); if that combination cannot run headless, fall back to a strict validator of the subset greplost emits (`graph LR|TD`, `id["label"]`, `a --> b`, `a -->|n| b`) and record the fallback in the report and the results payload (`checker: "mermaid" | "subset"`). `mapquality.ts` `run`: over an artifact dir (`--dir`, default `.greplost` of the target repo or fixture): INDEX.md tokens via `js-tiktoken` `cl100k_base` (M1 ≤ 3000), max nodes per fence (count `id["…"]` lines; M2: none above `config.diagram.maxNodes`), every fence passes `checkMermaid`. `--gate` exits 1 on any miss.

## 1.5.5 replay and perf

`replay.ts` `run(["--commits", "500", "--repo", "hono", "--gate"])`: in a temp clone of the corpus repo, list `N` commits ending at the pinned SHA (oldest first). At the oldest: `init` (hooks off). For each following commit: `git checkout <sha>`; (a) drift injection: `verify` must fail (count toward F1 = caught / total); (b) `update incremental` timed; (c) `verify` must pass; every 50th commit (d) `update full` into a copy and byte-compare trees (F2 = mismatching commits / checks). Output per-commit rows and summary `{ f1CatchRate, f2Mismatch, updateP50, updateP95 }`; `--gate`: F1 = 1.0 and F2 = 0. Uses the sync API in-process (`update`, `verify`), not the CLI, so a broken CLI does not mask a sync bug. Tests replay 5 synthetic commits on a temp git repo made from the fixture.

`perf.ts` `run(["--tier", "S", "--gate"])`: per repo: full build 10× after 2 warmups (`buildArtifacts` in a child `bun` process so RSS is per run; `--expose-gc` unnecessary), incremental single-file edit 10× (append a comment to a random-but-seeded file), 10-file edit, package rename (rename one directory and back). Report p50/p95 ms and peak RSS (`resourceUsage().maxRSS` of the child), file counts, and the machine profile. Regression gate: compare to `latestResult("perf")` with the same `machine.cpu`: fail if p50 regressed by more than 15 %; absolute targets P1/P2 from section 3 are also gated for tiers S and M.

## 1.5.6 agent

`tasks.ts`: `generateStructuralTasks(repo, truth, n)` builds `definition`, `importers`, `callers`, `blast_radius` tasks from truth (seeded selection, stable ids like `hono-def-01`), plus hand-curated `flow` tasks read from `bench/tasks/<repo>-flow.json` (with `truth_source`). Prompts end with the exact answer instruction: ``Answer with a JSON block {"files": [...]} (and {"symbols": [...]} where asked).``

`agent.ts` `run(["--repo", "hono", "--condition", "gl", "--runs", "5"])`: conditions `base`, `gl`, `gl-strict`, `graphify`, `ua`, `crg` as tech spec 10.6; each run = `claude -p "<prompt>" --model <pinned> --output-format json --allowedTools <list per condition> [--disallowedTools Grep Glob for gl-strict]` in the repo copy prepared for the condition (`.greplost/` present for `gl*`, competitor artifacts per `competitors.json` otherwise). Parse the JSON envelope: usage tokens (input, output, cache read/write), `num_turns` and tool calls (from the result or `--output-format stream-json` transcript when needed), wall-clock, `total_cost_usd`. Score: parse the last fenced JSON in the answer; `definition` exact match, sets by F1, `flow` by LCS ratio. Output mean/median/std/min/max per category and condition; win/loss/tie vs `base`. Confirm CLI flag names against `claude --help` at run time and record `claude --version`. `--dry-run` produces the results shape with zero runs. Tests cover task generation on the fixture truth, answer parsing and scoring; the runner itself is exercised with a fake `claude` binary on PATH that echoes a canned envelope.

## 1.5.7 headtohead and report

`headtohead.ts` `run(["--tier", "S", "--metrics", "X1,X4,X5"])`: orchestrates X1 (structural on each tool's artifact via adapters, three-way table), X2 (replay per tool with its own sync mechanism from `competitors.json`, F1 every 25 commits), X3 (cost from the same replay: wall-clock and USD from each tool's logs or Claude usage envelopes, method recorded), X4 (build twice, diff bytes), X5 (one-line import added, artifact lines changed), X6 (cold start timing), X8 (orientation task through `agent.ts`), X10 (capability row). Any competitor step that cannot run (tool not installed, needs credentials) records `N/A` with the reason, never a zero. Writes `results/headtohead-*.json` with a `winLossTie` map and a `reason` string on every loss.

`report.ts` `run([])`: reads the latest result of each suite and writes `bench/RESULTS.md` in the tech spec 10.9 layout: machine profile, pinned corpus, versions (Claude CLI, model, competitors), then the X1 to X10 table (Target | Measured | vs graphify | vs ua | vs crg | Reason on loss), then one section per eval with the section 3 table (Target vs Measured), Mermaid `xychart-beta` charts inline, and links to PNGs. Missing suites render as `not run` rows; the measured column is never typed by hand. `charts.ts` renders SVG by hand (bar, line, box) and rasterises with `@resvg/resvg-js` into `docs/assets/<chart>.png`; deterministic (no random ids, fixed fonts from resvg's default). `screenshots.ts` runs the section 11 captures where the tools exist (`vhs`, `freeze`, `playwright`) and prints exact install instructions for missing ones without failing the other captures; tapes live in `docs/tapes/`.

Tests: `report --dry-run` on empty results produces a RESULTS.md containing every section header from 10.9; `charts` render a fixed dataset to an SVG that matches a golden string and a PNG of non-zero size.
