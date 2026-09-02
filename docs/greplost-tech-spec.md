# greplost: Technical Specification

| | |
|---|---|
| Status | Draft v1, ready for brainstorming phase |
| Owner | Shantanu (github.com/sns45) |
| Name | `greplost` (npm, PyPI, crates, GitHub, and web all clear as of Sep 2026) |
| Tagline | grep lost. Read the map. |
| Repo | github.com/sns45/greplost |

---

## 1. Goal

Improve the **speed and accuracy of navigating monorepos and multi-repo projects, for both humans and LLM coding agents**, by generating a committed, deterministic, always-fresh map of the codebase in plain markdown, ASCII, and Mermaid.

greplost is not a search tool. It is the map you read so you don't have to search.

### 1.1 Thesis

Both audiences waste the same resource in the same way. A human opening an unfamiliar repo greps, opens files, reads imports, greps again. An agent does exactly the same thing, except every hop costs tokens and context. Neither needs the code first; both need orientation first: what exists, what depends on what, what breaks if this changes, where a flow starts and ends. That orientation is structural, derivable from the AST without any LLM, and cheap to keep current. greplost makes it a build artifact.

### 1.2 What "better navigation" means, measurably

Every claim in this spec is tied to a number produced by the benchmark harness in section 10. The headline metrics:

| Audience | Speed | Accuracy |
|---|---|---|
| Agent | Tokens, tool calls, wall-clock per navigation task | Correctness of the answer vs ground truth |
| Human | Time to correct answer on the same tasks | Wrong-answer rate |
| Map itself | Full build time, incremental update latency | Precision/recall of extracted structure vs compiler truth; verify catch rate |

### 1.3 Non-goals (v1)

- Replacing grep, LSP, or type checkers. greplost reduces search cost; agents still read the code they edit.
- Runtime tracing, dynamic call resolution, cross-language edges (TS to Go) inferred from code.
- A dashboard, server, or UI. Rendering is GitHub's job (Markdown plus Mermaid).
- Being an LLM product. The structure layer contains zero LLM output.

---

## 2. Users and jobs

**Human engineer** (new to a repo, reviewing a PR, on-call at 2am): "Where does X live, who calls it, what breaks if I touch it, how does request A become DB write B?" Wants to answer without opening twelve files.

**Coding agent** (Claude Code, Codex, Cursor): same questions, phrased as tool calls. Every Grep/Glob/Read costs context. Wants a compact, trustworthy index to consult before touching the filesystem.

**Reviewer**: wants architectural changes (a new cross-package dependency) visible in the PR diff, not discovered a month later.

**CI**: wants a mechanical check that the committed map matches the code.

---

## 3. Success metrics and targets

Targets, not results. The harness (section 10) produces the measured column; nothing is claimed until it does. Targets are set from published numbers of adjacent tools (code-review-graph reports ~0.4s incremental updates; gitatlas MCP reports ~17.9x context reduction on its benchmark) and from what determinism makes possible.

| ID | Metric | Target | Gate? |
|---|---|---|---|
| S1 | Import edge precision / recall vs tsc | ≥ 0.99 / ≥ 0.97 | yes |
| S2 | Export precision / recall vs tsc | ≥ 0.99 / ≥ 0.99 | yes |
| S3 | Call edge precision at confidence=high | ≥ 0.95 (recall reported, not gated) | yes |
| S4 | Import cycle detection vs truth | exact set match | yes |
| F1 | `verify` catch rate on stale maps (commit replay) | 100% | yes |
| F2 | `verify` false-positive rate after `update` | 0% (byte-identical) | yes |
| P1 | Full build, 1k / 10k files | ≤ 1s / ≤ 10s | yes (regression ±15%) |
| P2 | Incremental update p95, 1k / 10k files | ≤ 500ms / ≤ 1s | yes (regression ±15%) |
| P3 | Peak RSS at 10k files | ≤ 500MB | reported |
| A1 | Agent tokens per task vs baseline (median) | ≤ 50% | reported |
| A2 | Agent tool calls per task vs baseline | ≤ 40% | reported |
| A3 | Agent answer accuracy vs baseline | non-inferior; +10pt on blast-radius tasks | yes (non-inferiority) |
| A4 | Agent wall-clock per task vs baseline | ≤ 60% | reported |
| H1 | Human time to correct answer, with vs without | ≤ 60% (median) | reported |
| H2 | Human wrong-answer rate, with vs without | lower | reported |
| M1 | INDEX.md token budget | ≤ 3,000 tokens at 10k files | yes |
| M2 | Diagrams exceeding node cap after auto-split | 0 | yes |

### 3.1 Head-to-head targets vs Graphify and Understand-Anything (priority)

These are the numbers the README leads with. Each corresponds to a suite in section 10.0 and to a structural property the competitors do not have: an LLM-free structure layer, byte-stable output, and a CI verify gate. Graphify's pipeline puts an LLM inside extraction and clustering; Understand-Anything is a multi-agent LLM pipeline end to end with no incremental mode. Everything below is a hypothesis until measured, and losses are published alongside wins.

| ID | Metric (head-to-head) | Target | Why we expect to win |
|---|---|---|---|
| X1 | Structural precision vs compiler truth, gap over best competitor | ≥ +10 points on call edges, ≥ +3 on imports | Conservative AST resolution vs LLM-inferred edges |
| X2 | Staleness after 500 replayed commits, each tool with its own README hooks | greplost F1 stays ≥ 0.99; competitors' decay curve published | Sub-second incremental plus verify vs full re-runs |
| X3 | Cost to stay fresh over 500 commits (USD, minutes) | ≤ 1% of Understand-Anything, ≤ 20% of Graphify | Zero LLM calls in the structure layer |
| X4 | Reproducibility: two builds of the same commit | 0 bytes differ; competitors' diff size published | Determinism contract, section 5.3 |
| X5 | Diff signal: artifact lines changed after a one-line code change | ≤ 10 lines; competitors published | Sorted, stable serialization |
| X6 | Cold start to first usable map (tier M) | ≤ 5s and $0; competitors published | No pipeline, no dashboard build |
| X7 | Agent structural tasks (definition, importers, callers, blast radius): accuracy and tool calls | accuracy ≥ best competitor; tool calls ≤ 50% of best competitor | `query --json` and `impact --json` answer in one call |
| X8 | Orientation cost: tokens to answer "what are the main components?" | ≤ 50% of best competitor | INDEX.md budget (M1) |
| X9 | Reviewer task: spot the new cross-package dependency in a PR, time and hit rate | greplost fastest; competitors have no artifact in the diff | Architecture edges appear in `repo/MAP.md` diffs |
| X10 | Cross-repo blast radius in workspace mode | works; competitors N/A (capability, not a score) | Section 4.4 |

**Where we do not expect to win, and will measure anyway:** conceptual and domain tasks ("where is the billing logic?", "what does this package do?") where Graphify's community summaries and Understand-Anything's domain view have an edge over a structure-only map; whole-system comprehension for non-experts, where Understand-Anything's guided dashboard is purpose-built; and multi-modal inputs (docs, papers, video), which Graphify supports and greplost does not target. These results go in `RESULTS.md` next to the wins. A benchmark that only reports wins is marketing.

---

## 4. Architecture

### 4.1 Two layers

```
                 ┌──────────────────────────────────────────────┐
  source files ─►│  STRUCTURE LAYER (tree-sitter, deterministic) │─► manifest.json, graph/*.jsonl,
                 │  regenerated on every edit, no LLM, < 1s      │   INDEX.md, MAP.md, API.md, module cards
                 └──────────────────────────────────────────────┘
                                        │ content hashes
                                        ▼
                 ┌──────────────────────────────────────────────┐
  stale hashes ─►│  SEMANTIC LAYER (LLM, cached by content hash) │─► summaries.json, FLOWS.md,
                 │  refreshed lazily, never blocks the fast path │   intent paragraphs on cards
                 └──────────────────────────────────────────────┘
```

Rule: nothing in the structure layer may depend on the semantic layer. A repo with the semantic layer never run is still fully navigable.

### 4.2 Artifact layout

Everything under `.greplost/`, everything committed.

```
.greplost/
├── INDEX.md                  # entry point, ≤ 3K tokens: repo tree (package level),
│                             # package table (purpose, LOC, fan-in/out), hotspots, links
├── manifest.json             # machine index: files, hashes, exports, packages, staleness
├── graph/
│   ├── imports.jsonl         # {from,to,symbols[],kind,confidence}, sorted
│   └── calls.jsonl
├── repo/
│   ├── MAP.md                # ASCII package tree + Mermaid container view (package edges only)
│   └── HOTSPOTS.md           # god nodes, cycles, largest blast radii (pure metrics)
├── packages/<name>/
│   ├── MAP.md                # module tree + Mermaid component view (≤ 25 nodes, auto-split)
│   ├── API.md                # exported symbols with signatures as written
│   ├── FLOWS.md              # semantic: 2 to 5 Mermaid sequence diagrams
│   └── modules/<slug>.md     # one card per source file
├── cache/summaries.json      # contentHash -> prose, committed
└── config.json
```

### 4.3 Module card (the unit both audiences consume)

```markdown
# packages/adapters/src/sqs.ts

> Intent paragraph (semantic layer, cached). Banner here if it lags the code.

**Exports:** `SqsAdapter (class)`, `createSqsAdapter(cfg: SqsConfig): SqsAdapter`
**Imports:** `@anyq/core` (Queue, retry), `@aws-sdk/client-sqs`
**Imported by:** `packages/core/src/registry.ts`, `apps/worker/src/main.ts`
**Blast radius:** 7 files (see `greplost impact`)
**Key symbols:**
- `SqsAdapter.publish(msg): Promise<Ack>`  L42-88
- `SqsAdapter.poll(opts): AsyncIterator<Msg>`  L90-140
```

### 4.4 Workspace mode (multi-repo)

A `greplost.workspace.json` at any directory lists sibling repos. Each repo keeps its own `.greplost/`; the workspace adds `WORKSPACE.md` (aggregated index) and cross-repo edges.

```json
{ "repos": ["./anyq", "./anyq-go", "./tickettok"], "name": "shantanu-workspace" }
```

Cross-repo edge sources, v1: an import specifier that matches a package name published by a sibling repo (npm name, Go module path). v2: declared contracts (OpenAPI, proto, queue/topic string literals). `greplost impact` and `query` operate across the workspace when run from the workspace root.

---

## 5. Structure layer specification

### 5.1 Extraction (tree-sitter, WASM grammars)

Per file: `path, lang, sha256, loc`, then:

| Kind | Extracted |
|---|---|
| Declarations | kind (function / class / interface / type / enum / const / struct / method), name, signature as written, exported flag, line span, parent (for methods) |
| Imports | raw specifier; resolved target (tsconfig `paths`, workspace protocol, package.json `exports`, Go module path); imported symbols; kind (static / dynamic / type-only / side-effect) |
| Exports | named, default, `export * from` (followed one level) |
| Call edges | callee resolved to a uniquely imported symbol or a same-file declaration → `high`; resolved through one level of re-export → `med`; anything else is dropped, never guessed |
| Signals (v1.5) | `process.env.*`, wrangler bindings, queue/topic string literals |

Languages: TypeScript/TSX/JavaScript (M1), Go (M5), Python (v2).

### 5.2 Derived metrics (deterministic)

- Fan-in / fan-out per module and package.
- Import cycles via Tarjan SCC, reported as sorted cycles.
- Blast radius: reverse transitive closure of the import graph per file; computed lazily and cached in manifest.
- Clustering: directory structure in v1. Leiden/Louvain is v2 and must be seeded to stay deterministic.

### 5.3 Node identity and ordering (the determinism contract)

- Node id = `<repo-relative-path>#<symbol-path>` (e.g. `packages/core/src/registry.ts#Registry.register`). Files are `<path>`; packages are `pkg:<name>`.
- All collections serialized sorted by id, then by line. JSON keys sorted. JSONL one edge per line, sorted by `(from, to, kind)`.
- Mermaid node order = sorted node ids; node labels are derived, never hand-edited.
- Timestamps never appear in structure-layer output (they would break byte stability). Dates live only in semantic banners and in `RESULTS.md`.
- Contract: `build(repo) == build(repo)` byte-for-byte on any machine, and `incremental(build(repo@A), diff(A,B)) == build(repo@B)` byte-for-byte. Both are tested (section 12.4).

### 5.4 Schemas (abridged)

```ts
// manifest.json
interface Manifest {
  version: string;               // greplost schema version
  packages: Record<string, { path: string; deps: string[]; rdeps: string[]; loc: number }>;
  files: Record<string, {
    sha256: string; pkg: string; lang: Lang; loc: number;
    exports: string[]; summaryHash?: string; staleSummary: boolean;
  }>;
}
// graph/*.jsonl line
interface Edge { from: string; to: string; kind: "import"|"reexport"|"call"; symbols?: string[]; confidence: "high"|"med"; }
```

---

## 6. Semantic layer specification

- Module summary: one paragraph of intent. Forbidden: restating signatures (the card already has them).
- Package overview plus `FLOWS.md`: 2 to 5 sequence diagrams for the flows a new engineer asks about. Flow selection heuristic: entry points (HTTP handlers, CLI mains, queue consumers) with the largest downstream reach.
- Trigger: `manifest.files[f].summaryHash != sha256` → `staleSummary = true`. Refresh only via `greplost refresh [pkg]` or `/greplost refresh`, which batches stale files through headless `claude -p`.
- Staleness is visible: stale cards render `> summary may lag code, last refreshed <date>`.
- Cache is committed so no teammate or CI job re-pays LLM cost for unchanged code.

---

## 7. Sync, hooks, and verification

### 7.1 Claude Code plugin

```
greplost-plugin/
├── .claude-plugin/plugin.json
├── skills/greplost/SKILL.md
├── hooks/hooks.json
├── agents/greplost-navigator.md     # optional read-only subagent that answers via the map
└── commands/  (init, update, query, impact, refresh, verify)
```

| Event | Matcher | Action |
|---|---|---|
| SessionStart | * | If `.greplost/` exists, inject a one-line pointer to INDEX.md |
| PreToolUse | Glob, Grep | Inject reminder: consult INDEX.md / `greplost query` first (Graphify-proven pattern) |
| PostToolUse | Edit, Write, MultiEdit | Append changed path to `.greplost/.dirty` (O(1)) |
| Stop | * | `greplost update --incremental` over `.dirty`, target ≤ 500ms |

### 7.2 Git side (covers edits Claude never sees)

`post-commit`, `post-merge`, `post-checkout` → `greplost update --incremental`, detached, lockfile-guarded. Installed by `greplost init`, chained through husky/lefthook if present.

### 7.3 CI backstop

`greplost verify` regenerates the structure layer in memory and diffs bytes against `.greplost/`. Non-zero exit on any difference, with a unified diff of the first divergent file. This is the merge gate that makes "always in sync" a guarantee.

### 7.4 Concurrency

Single `.greplost/.lock` (advisory, PID + timestamp). Hooks no-op when locked; the next trigger catches up. Stale locks (> 60s, dead PID) are reclaimed.

---

## 8. Incremental update algorithm

1. Dirty set = `.greplost/.dirty` ∪ `git diff --name-only <last-indexed-commit>` (mode-dependent).
2. Hash; drop unchanged.
3. Re-parse changed files only.
4. Graph patch: delete edges touching changed files; insert fresh ones. Resolve imports from the new file set.
5. Recompute derived metrics on the affected subgraph only; invalidate cached blast radii for affected nodes.
6. Regenerate only dependent artifacts: cards for changed files; package MAP/API when exports or deps changed; repo MAP/INDEX/HOTSPOTS when package-level edges or metrics changed.
7. Serialize under the section 5.3 contract.
8. Mark semantic entries stale where hashes moved. Clear `.dirty`. Record `last-indexed-commit`.

---

## 9. CLI and plugin surface

```
greplost init [--workspace]           # build + install git hooks + write config
greplost update [--incremental|--full] [--semantic]
greplost verify [--diff]              # CI gate, exit 1 on drift
greplost query <symbol|path> [--json] # definition, importers, callers, package, card path
greplost impact <path> [--json]       # blast radius, sorted, with depth
greplost flows <pkg>                  # print FLOWS.md
greplost refresh [pkg]                # semantic layer only
greplost bench <suite> [--gate]       # runs section 10 suites, writes bench/RESULTS.md
greplost screenshots                  # regenerates docs/assets/* (section 11)
```

`--json` output is stable and documented; agents use it via the skill instead of grepping.

Stack: Bun + TypeScript, `web-tree-sitter` (WASM) so installs never need a C++ toolchain, grammars vendored. Distribution: `bunx greplost` (unscoped npm) and `claude plugin add sns45/greplost`.

---

## 10. Evals and benchmarks

This section is a first-class deliverable, not a nice-to-have. The harness ships in the repo, runs in CI, and writes committed results with charts and screenshots. A greplost release without updated numbers is not a release.

Priority order: section 10.0 (head-to-head) ships first and leads the README; the single-tool suites in 10.3 to 10.8 feed it and gate regressions.

### 10.0 Priority suite: head-to-head vs Graphify and Understand-Anything

Competitor artifacts are produced by following each tool's README verbatim at a pinned version, then converted to greplost's edge schema (section 5.4) by adapters in `bench/adapters/{graphify,ua,crg}.ts` so every tool is scored by the same code against the same compiler truth. Adapters are documented line by line and the maintainers of each tool are invited to review them before results are published. Where a competitor has no equivalent capability, the table says N/A rather than 0.

**X1: Structural precision, three-way.** Run Eval 1 (section 10.3) on each tool's graph for tiers S and M. Report precision, recall, and F1 per edge kind (imports, exports, calls). The headline is precision on call edges: greplost never emits an unresolved edge; LLM-extracted graphs do. Chart: grouped bars per tool per edge kind.

**X2: Staleness decay under change.** Extend the commit replay (section 10.4): for each tool, install its own sync mechanism exactly as its README describes (git hook for Graphify if documented, none for Understand-Anything which has no incremental mode), then walk 500 commits without any manual intervention. At every 25th commit, score the tool's current artifact against truth at that commit. Plot F1 vs commit index. greplost's line should be flat; the others' lines are the finding. Also record, per tool, whether a mechanical staleness check exists at all (greplost `verify`: yes; others: N/A).

**X3: Cost to stay fresh.** From the same replay, sum wall-clock and USD (API usage captured from each tool's own logs or console deltas, method recorded) spent by each tool to reach its freshest state after every commit. For tools with no incremental mode, cost the full re-run their README prescribes. Report per 500 commits and per commit.

**X4: Reproducibility.** Build each tool's artifact twice on the same pinned commit on the same machine. Report bytes differing and files differing. greplost's contract is zero. For Graphify, note whether the AST-only mode and the LLM mode differ in stability. For Understand-Anything, report the diff of two full pipeline runs.

**X5: Diff signal-to-noise.** Apply a single one-line change (add one import) and rebuild each tool's artifact. Report lines changed in the committed artifact and whether a human can read the architectural change from the diff alone. Screenshot #3 (section 11) comes from this run.

**X6: Cold start.** Time and cost from a fresh clone to a usable map, tier M, each tool. "Usable" means the tool's own documented first query works.

**X7: Agent structural tasks.** Eval 4 (section 10.6) restricted to the four structural categories, with the `graphify` and `ua` conditions. Report accuracy, tool calls, tokens, wall-clock per tool. Publish the conceptual and flow categories in the same table even though greplost is not expected to lead there.

**X8: Orientation cost.** One task per corpus repo: "List the main components of this repo and what each is for." Score set overlap against a curated answer; report tokens consumed to first correct answer per tool. Measures the value of the ≤ 3K-token INDEX.md against a large report or a raw JSON graph.

**X9: Reviewer task.** In the human study (section 10.7), one task shows a fixture PR that adds a cross-package dependency. Participants answer "what architectural dependency does this PR add?" using only the PR diff view. With greplost, `repo/MAP.md` changes in the diff; with the other tools, nothing in the diff reflects it (their artifacts are either not committed or not regenerated in the PR). Report time and hit rate.

**X10: Cross-repo blast radius.** On the `two-repo-workspace` fixture and on anyq plus its Go port, run `greplost impact` across repos. Record the competitors' capability as N/A, with a sentence on what each would require to do it.

Publishing rule: X1 to X10 appear in `RESULTS.md` as one table with a win/loss/tie column per competitor, and every loss carries a one-line reason.

### 10.1 Principles

1. **Deterministic scoring, no LLM judge.** Every score is a set comparison, a byte comparison, or a timer. LLM-judged evals cannot gate regressions; these can.
2. **Ground truth from compilers, not from greplost.** The structure layer is scored against the TypeScript compiler API and the Go toolchain, never against itself.
3. **Pinned everything.** Corpus repos pinned to commit SHAs, model pinned by version string, harness version recorded. `RESULTS.md` carries all three.
4. **Baselines are real.** The agent baseline is a stock Claude Code session with Grep/Glob/Read. Competitor conditions use the competitors' own install instructions, unmodified.
5. **Report variance.** N ≥ 5 runs per agent task per condition; mean, median, std, and min/max. Small human study sizes are stated, not hidden.
6. **Publish failures.** Tasks where greplost loses go in the results table with a one-line diagnosis.

### 10.2 Corpus

| Tier | Files | Candidates (pinned SHA in `bench/corpus.json`) |
|---|---|---|
| S | ~100 | `sns45/anyq` (TS monorepo), `gin-gonic/gin` (Go) |
| M | ~1k | `honojs/hono` (TS), `charmbracelet/bubbletea` (Go) |
| L | ~5-10k | `vitejs/vite` (TS monorepo), `grafana/grafana` subset (Go) |
| XL (perf only) | ~20k+ | `microsoft/TypeScript` or `vercel/next.js` |

Corpus is cloned by `bench/setup.ts` into `bench/.corpus/` (gitignored) at the pinned SHAs.

### 10.3 Eval 1: Structural accuracy (S1 to S4)

- **Truth generation** (`bench/truth/ts.ts`): `ts.createProgram` over the repo; for every import declaration record `ts.resolveModuleName` result and imported symbols; for every call expression resolve the callee with `checker.getSymbolAtLocation` to its declaration file and name; compute exports from `checker.getExportsOfModule`. Go (`bench/truth/go.ts`): `go list -json -deps` for imports, `golang.org/x/tools/go/callgraph/cha` for static calls.
- **Scoring:** precision/recall/F1 per edge kind per repo, plus confidence-bucketed call-edge precision. Cycles: Jaccard over sorted cycle sets (gate requires 1.0).
- **Gate:** S1 to S4 thresholds from section 3, per repo in tiers S and M. Failures print the first 20 false positives with file:line so they're actionable.

### 10.4 Eval 2: Freshness and sync (F1, F2)

- **Commit replay** (`bench/replay.ts`): for each corpus repo, walk 500 consecutive commits from the pinned SHA backward. At each step: apply the commit, run `greplost update --incremental`, run `greplost verify`. Record pass/fail and update latency.
- **Drift injection:** separately, apply the commit but skip `update`; `verify` must fail (F1 = fraction caught, target 100%).
- **Equivalence:** at every 50th commit, run `--full` into a temp dir and byte-compare with the incremental result (F2).

### 10.5 Bench 3: Performance (P1 to P3)

- `bench/perf.ts` runs full builds and incremental updates (single-file edit, 10-file edit, package-rename) across all tiers, 10 iterations each after 2 warmups, on a documented machine profile (recorded in RESULTS.md: CPU, RAM, Bun version).
- Reports p50/p95, peak RSS (via `/usr/bin/time -l` or `process.resourceUsage`), and a line chart of build time vs file count.
- Regression gate: ±15% vs the last committed RESULTS on the same machine profile.

### 10.6 Eval 4: Agent navigation benchmark (A1 to A4)

**Task suite** (`bench/tasks/*.json`), 12 to 20 tasks per corpus repo, five categories:

| Category | Example | Ground truth | Score |
|---|---|---|---|
| definition | "Where is `Registry` defined?" | tsc symbol location | exact match |
| importers | "Which files import `packages/core/src/retry.ts`?" | truth import graph | set F1 |
| callers | "What calls `SqsAdapter.publish`?" | truth call graph (static subset) | set F1 |
| blast radius | "What breaks if I change `retry.ts`?" | reverse closure over truth graph | set F1 |
| flow | "Trace an HTTP POST /jobs to the queue publish" | hand-curated ordered file list (provenance recorded) | LCS ratio |

Answers are required in a fenced JSON block (`{"files": [...], "symbols": [...]}`) so scoring is parse-and-compare, not judgment.

**Conditions:**

| ID | Condition | Tools |
|---|---|---|
| base | Stock Claude Code | Read, Grep, Glob |
| gl | greplost | Read, Grep, Glob + `.greplost/` present + plugin hooks |
| gl-strict | greplost, map only | Read + `.greplost/`, Grep/Glob disallowed (measures map sufficiency) |
| graphify | Graphify installed per its README | its defaults |
| ua | Understand-Anything: `/understand` run once at the pinned commit, its committed `.ua/` graph and summaries present | Read, Grep, Glob (it has no query CLI; the agent reads its artifacts) |
| crg | code-review-graph installed per its README | its defaults |

**Runner** (`bench/agent.ts`): headless `claude -p "<task prompt>" --model <pinned> --allowedTools <per condition> --output-format json`, cwd = corpus repo. Parse usage (input/output/cache tokens), count tool calls from the transcript, wall-clock, cost. N = 5 runs per task per condition. Confirm flag names against the current Claude Code CLI reference before first run and record the CLI version.

**Reported:** per category and overall: accuracy (mean F1), tokens (median, p95), tool calls, wall-clock, cost, and a win/loss/tie table vs each condition. Non-inferiority gate on A3 (greplost accuracy ≥ baseline minus 2 points, overall).

### 10.7 Eval 5: Human navigation study (H1, H2)

- Within-subject, counterbalanced: each participant does 8 tasks, 4 with `.greplost/` open in the browser and 4 without, order alternated across participants. Tasks drawn from the same suite (definition, importers, blast radius, flow), plus the X9 reviewer task (section 10.0) which every participant does last, once per tool condition.
- n = 6 to 10 engineers (colleagues, recruited openly; consent for screen recording). Measure time to correct answer, wrong answers, and a 1 to 5 confidence rating.
- Report medians and per-task results; state n plainly. This is a small study and is labeled as such; it exists to show the human half of the thesis with real data, not to claim significance.
- Recordings feed the screenshots in section 11.

### 10.8 Map quality metrics (M1, M2)

- INDEX.md token count (tiktoken cl100k, reported alongside Claude's own count from the JSON output) at each corpus tier.
- Per-diagram node counts; any diagram over the cap after auto-split is a failure.
- Mermaid render check: every generated diagram parsed with `@mermaid-js/mermaid` in headless mode; parse errors fail the gate.

### 10.9 Reporting

- `greplost bench <suite>` writes `bench/results/<suite>-<date>-<sha>.json` and regenerates `bench/RESULTS.md`.
- `RESULTS.md` layout: machine profile, pinned corpus, model/CLI/competitor versions, then the X1 to X10 head-to-head table first (win/loss/tie per competitor, reason on every loss), then one section per eval with the section 3 table (target vs measured), Mermaid `xychart-beta` charts inline (plain-text philosophy: charts that render on GitHub with no image pipeline), and links to PNG versions.
- PNG charts generated by `bench/report.ts` (deterministic, seed-free) into `docs/assets/`: the X2 staleness decay curve (F1 vs commit index, one line per tool) is the hero chart; then grouped bars for X1 precision per tool, X3 cost per tool, X7 accuracy and tool calls by condition, a line chart for build time vs files, and a box plot for incremental latency.
- CI: `verify`, Eval 1, Eval 2 (100-commit variant), and Bench 3 run on every PR and post a summary table as a PR comment. Eval 4 and 5 run on demand and before releases (they cost money and people).

### 10.10 Results table (filled by the harness, never by hand)

| ID | Target | Measured | Corpus / condition | Date, SHA |
|---|---|---|---|---|
| X1 | ≥ +10pt calls, ≥ +3pt imports | | vs graphify / ua | |
| X2 | F1 ≥ 0.99 at commit 500 | | vs graphify / ua | |
| X3 | ≤ 1% ua, ≤ 20% graphify | | | |
| X4 | 0 bytes | | vs graphify / ua | |
| X5 | ≤ 10 lines | | vs graphify / ua | |
| X7 | acc ≥ best; calls ≤ 50% | | vs graphify / ua | |
| X8 | ≤ 50% tokens | | vs graphify / ua | |
| S1 | ≥ 0.99 / ≥ 0.97 | | | |
| S3 | ≥ 0.95 | | | |
| F1 | 100% | | | |
| F2 | 0% | | | |
| P1 | ≤ 1s / ≤ 10s | | | |
| P2 | ≤ 500ms / ≤ 1s | | | |
| A1 | ≤ 50% | | | |
| A3 | non-inferior | | | |
| H1 | ≤ 60% | | | |
| M1 | ≤ 3,000 | | | |

---

## 11. Screenshots and evidence

Every visual in the README is regenerated by `greplost screenshots` so it never drifts from the code. Tapes and scripts are committed; outputs land in `docs/assets/`.

| # | Capture | How |
|---|---|---|
| 1 | `greplost init` on hono with timing output | `vhs docs/tapes/init.tape` → GIF + final-frame PNG |
| 2 | Package MAP.md rendered on GitHub with Mermaid | Playwright script screenshots the rendered page at a pinned commit |
| 3 | PR diff showing a new architecture edge in `repo/MAP.md` | Playwright on a fixture PR in the demo repo |
| 4 | `greplost verify` failing in CI (red check) then passing | Playwright on the fixture PR's checks tab |
| 5 | Side-by-side: baseline session grepping vs greplost session answering | two `vhs` tapes composed into one image by `bench/report.ts` |
| 6 | `greplost impact` and `query --json` output | `freeze` (charmbracelet) code screenshots |
| 7 | Benchmark charts: tokens/accuracy by condition, build time vs files, latency box plot | `bench/report.ts` PNGs |
| 8 | Human study: time-to-answer per task, with vs without | `bench/report.ts` PNG from anonymized CSV |
| 9 | **Staleness decay curve** (X2): F1 vs commit index, one line per tool, greplost flat | `bench/report.ts` PNG, the hero chart |
| 10 | **Same one-line change, three artifacts** (X5): side-by-side diffs of `.greplost/`, Graphify's graph, Understand-Anything's graph | `bench/report.ts` composes three `freeze` captures |
| 11 | **Reproducibility** (X4): `diff -r` of two builds per tool, byte counts | `freeze` capture of the terminal output |
| 12 | **Head-to-head table** (X1 to X10) with win/loss/tie column | rendered straight from `RESULTS.md` |

README structure: hero chart (#9) with the one-line claim it supports, the one-paragraph "not a search tool" pitch, the head-to-head table (#12), then the init GIF (#1) and the single-tool numbers (#7) under the fold. Screenshots without numbers, or numbers without a link to `RESULTS.md`, are not allowed on the README, and the head-to-head table must show its losses.

---

## 12. Development workflow: superpowers + unlazy

The build is executed by Claude Code using two plugins. This section is written to be read by the agent.

### 12.1 Setup

```bash
claude plugin add obra/superpowers          # official marketplace
npx skills add Leonxlnx/unlazy              # installs to ~/.claude/skills/unlazy
node ~/.claude/skills/unlazy/scripts/install-hooks.mjs   # project-scoped Stop hook
echo -e ".unlazy/\n.unlazy-hook-state.json\n.claude/settings.local.json" >> .gitignore
```

### 12.2 Phases

1. **Brainstorm** (`superpowers:brainstorming`) with this spec as input. Output: one sub-project spec per subsystem, saved under `docs/superpowers/specs/`. Subsystems, in dependency order:
   - `core-extract`: tree-sitter pass, resolution, manifest and graph writers (section 5)
   - `render`: INDEX/MAP/API/cards/Mermaid with node caps and auto-split (section 4)
   - `sync`: incremental engine, `verify`, lock, git hooks (sections 7 and 8)
   - `plugin-cli`: CLI surface, `--json`, Claude Code plugin, hooks, skill, commands (sections 7.1 and 9)
   - `bench`: truth generators, replay, perf, agent runner, reporting, screenshots (sections 10 and 11)
   - `semantic`: summaries, FLOWS, cache (section 6)
   - `workspace`: multi-repo mode (section 4.4)
   - `go`: Go grammar and truth generator
2. **Plan** (`superpowers:writing-plans`), one plan per sub-project in `docs/superpowers/plans/`. Each task in a plan names its test file first.
3. **Execute** (`superpowers:subagent-driven-development`, required on Claude Code): fresh subagent per task, two-stage review (spec compliance, then code quality), continuous execution stopping only for blockers. Independent sub-projects run in parallel via `superpowers:dispatching-parallel-agents` in separate worktrees (`superpowers:using-git-worktrees`). The schemas in section 5.4 are the interface contracts that make parallel work safe: `core-extract`, `render`, and `bench/truth` can start simultaneously against the schema.
4. **Model selection** per the subagent-driven-development skill: mid-tier floor for reviewers and for implementers working from prose; cheapest tier when the plan text already contains the code; batch same-shape mechanical edits into one dispatch.
5. **Finish** (`superpowers:finishing-a-development-branch`): whole-branch review via `scripts/review-package`, one fix subagent for all findings, one scoped re-review.

### 12.3 unlazy: completion is proven, not declared

Invoke `/unlazy tree 5` at project start (subsystem-scale). The acceptance ledger lives in `.unlazy/`; every gate is a command. The Stop hook blocks ending the turn while gates are unmet, so "done" is mechanically checked. Gates per sub-project:

| Sub-project | Gates (all must exit 0) |
|---|---|
| core-extract | `bun test packages/core`; `bun run bench:structural --gate` (S1 to S4 on tier S) |
| render | `bun test packages/render`; `bun run bench:mapquality --gate` (M1, M2); mermaid parse check |
| sync | `bun test packages/sync`; `bun run bench:replay --commits 100 --gate` (F1, F2); `bun run bench:perf --tier S --gate` |
| plugin-cli | `bun test packages/cli`; plugin loads via `claude --plugin-dir ./greplost-plugin` with all three hooks firing in the debug log; `greplost --json` schema tests |
| bench | harness self-tests; `greplost bench all --dry-run` produces a RESULTS.md with every section present; `bench/adapters/*` convert pinned Graphify, Understand-Anything, and code-review-graph outputs on `tiny-ts` into the section 5.4 edge schema with a round-trip test |
| semantic | `bun test packages/semantic`; cache hit rate test (second run makes zero LLM calls) |
| workspace | cross-repo edge test on a two-repo fixture; `impact` across repos |
| go | S1 to S4 on `gin` |

Every gate command must already exist and fail red before implementation starts (TDD via `superpowers:test-driven-development`). `superpowers:verification-before-completion` runs before any subagent reports done.

### 12.4 Testing standard

- Unit tests per module (`bun test`).
- Golden snapshot tests for every generated artifact on fixture repos; snapshots are the determinism contract.
- Property tests: idempotence (`update` twice → identical bytes), build/incremental equivalence (section 5.3 contract), ordering invariance (input file order shuffled → identical output).
- Fixture repos under `fixtures/`: `tiny-ts` (12 files, one cycle, one re-export, one dynamic import), `tiny-go`, `two-repo-workspace`.
- Eval gates from section 12.3 are tests; they run in CI on tier S.

### 12.5 Kickoff prompt (paste into Claude Code at the repo root)

```
Read docs/greplost-tech-spec.md in full before doing anything else.

Use superpowers:brainstorming to turn the spec into one sub-project spec per
subsystem listed in section 12.2, in dependency order, and stop for my approval
after each spec. Then use superpowers:writing-plans for each approved spec, and
superpowers:subagent-driven-development to execute the plans. Run independent
sub-projects in parallel with superpowers:dispatching-parallel-agents in
separate worktrees; the schemas in section 5.4 are the interface contracts.

Before writing any implementation, invoke /unlazy tree 5 and record the gates
from section 12.3 in the ledger as runnable commands. Every gate must exist and
fail before its implementation begins. Do not report any task, sub-project, or
milestone as complete unless its gates pass; the Stop hook enforces this.

Section 10 (evals and benchmarks) and section 11 (screenshots) are deliverables
of equal priority to the tool itself. Within section 10, the head-to-head suite
in 10.0 (X1 to X10, targets in 3.1) is the priority: build the competitor
adapters early, run X1, X2, X4, and X5 as soon as M2 lands, and lead RESULTS.md
and the README with those results. Publish every loss with a reason.
bench/RESULTS.md with measured numbers and docs/assets/ with regenerated
screenshots are part of the definition of done for milestones M1 through M4.

Never fill the measured column of any results table by hand.
```

---

## 13. Milestones

| M | Scope | Exit gate |
|---|---|---|
| M0 | Scaffold, schemas, fixtures, CI skeleton, unlazy ledger, competitor adapters on `tiny-ts` | all gate commands exist and fail red; adapters round-trip |
| M1 | core-extract + render for TS on tier S and M; **X1** (structural precision, three-way) | S1 to S4 pass; M1, M2 pass; golden tests green; X1 table published |
| M2 | sync: incremental, verify, git hooks; perf; **X2, X3, X4, X5, X6** | F1, F2 pass on 500-commit replay; P1, P2 within targets; decay curve (#9), diff comparison (#10), reproducibility (#11) published |
| M3 | plugin-cli + bench agent runner; **X7, X8** with graphify and ua conditions; A1 to A4 on hono and anyq; screenshots #1 to #7, #12 | RESULTS.md leads with the X table; README updated |
| M4 | semantic layer; human study (H1, H2, **X9**); screenshot #8; conceptual-task results published even where greplost trails | study results in RESULTS.md with n stated |
| M5 | Go grammar and truth; tier L perf; X1 and X2 repeated on Go corpus | S1 to S4 on gin; P1, P2 on tier L |
| M6 | workspace mode; **X10**; crg condition added to Eval 4 | cross-repo impact works; capability matrix published |

Dogfood target throughout: `sns45/anyq` (TS monorepo) plus its Go port in workspace mode.

---

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Call edges in dynamic TS (DI, interface dispatch, emitters) unresolvable | Confidence buckets; precision is gated, recall is reported; never guess |
| Generated-file merge conflicts on shared packages | Documented resolution (`greplost update` after merge); `.gitattributes` merge driver in v2 |
| Agent benchmark variance across runs | N ≥ 5, medians, pinned model; publish spread |
| Competitor conditions installed incorrectly | Follow their README verbatim; record versions; invite maintainers to review the setup |
| Mermaid render limits on GitHub | 25-node cap, auto-split, headless parse check in CI |
| Human study too small to be meaningful | State n; present as evidence of direction, not significance |
| WASM tree-sitter slower than native | Incremental design makes per-edit cost small; benchmark it (P1, P2) rather than assume |

---

## Appendix A: Sample tasks (hono corpus)

```json
{ "id": "hono-def-01", "category": "definition",
  "prompt": "Where is the class HonoRequest defined? Answer with a JSON block {\"files\":[...]}.",
  "truth": { "files": ["src/request.ts"] } }

{ "id": "hono-blast-03", "category": "blast_radius",
  "prompt": "List every file that transitively imports src/utils/url.ts. Answer with a JSON block {\"files\":[...]}.",
  "truth": { "files": ["src/router/...", "..."] }, "truth_source": "tsc reverse closure @<sha>" }

{ "id": "hono-flow-02", "category": "flow",
  "prompt": "Trace, in order, the files involved from app.fetch() receiving a request to a matched handler executing. Answer with a JSON block {\"files\":[...]} in order.",
  "truth": { "files": ["src/hono-base.ts", "src/router/reg-exp-router/router.ts", "src/context.ts", "src/compose.ts"] },
  "truth_source": "hand-curated, reviewed by two engineers" }
```

## Appendix B: config.json

```json
{
  "include": ["packages/**", "apps/**"],
  "exclude": ["**/node_modules/**", "**/dist/**", "**/*.test.ts"],
  "languages": ["ts", "tsx", "js"],
  "diagram": { "maxNodes": 25, "splitBy": "directory" },
  "packages": { "roots": ["packages/*", "apps/*"] },
  "semantic": { "enabled": true, "model": "pinned-model-string" }
}
```

## Appendix C: Rulings made during implementation (2026-09-02)

Amendments to the body above, each recorded in `PLAN.md`'s status log with its reason. The body text is left as written; where the two disagree, this appendix wins.

| Section | Ruling | Why |
|---|---|---|
| 5.1 exports | `export *` chains are followed transitively when computing a file's export name set (fixpoint over the star graph, cycle-safe, order-independent). A local export shadows a star export; when two stars supply the same name from different declarations the name is ambiguous and never a call target, and when both arms reach the same declaration (a diamond) it resolves normally. | S2 recall is measured against `getExportsOfModule`, which is transitive; the "followed one level" wording lost recall on nested barrels. |
| 5.1 call edges | A call whose callee resolves through re-export chains of any depth to exactly one declaration is emitted at `med`; same-file or directly imported declarations stay `high`; ambiguous star names, external or unresolved hops, and cycles are dropped. | One-hop-only left S3 recall at 0.30 on anyq, where every cross-package call goes through two barrels; deeper exact resolution is not guessing. |
| 5.1 declarations | Class fields whose initializer is an arrow or function expression, abstract method signatures, and method signatures in `declare class` are `method` declarations; namespace members are tracked at any depth with dotted paths; calls in `static {}` blocks attribute to the class; type-position `import("x").T` is a type import with no call site; caller attribution is by node identity, so shadowing locals cannot hijack it. | Parity with the compiler oracle on the same constructs; each was a systematic FP+FN pair. |
| 5.1 imports | Import edges are deduplicated on (from, to, kind, symbols, importKind), so a static and a dynamic import of the same symbols stay distinct. | The dedupe would otherwise relabel an import's kind. |
| 5.1 resolution | A repo importing its own root package name resolves to that package; a `null` exports target blocks resolution; the tsconfig baseUrl probe runs only when baseUrl is declared; only the best-matching `paths` pattern is tried. | tsc parity; each was a precision leak. |
| 5.4, 8 | `ParseCache.get(sha256, lang)`; cached records are frozen and immutable. Incremental update renders the whole map in memory and writes only changed bytes, so full and incremental are byte-identical by construction; the parse cache lives at `.greplost/cache/parse.json`, gitignored. | Byte equality by construction beats selective regeneration. |
| 4.2 | Module cards mirror the source path: `packages/<slug>/modules/<path within package>.md`; package slugs strip `@` and replace `/` with `__`. | Browsable on GitHub for large packages. |
| 5.1 Go | Go import edges target directory ids (a Go import names a package, not a file). | Matches `go list` truth. |
| 10.3 | The TypeScript truth generator emulates the installed-and-built state for workspace packages (package manifests plus tsconfig `outDir`/`rootDir`), installed on the compiler host so calls resolve too; semantic diagnostics are opt-in. Recorded in `RESULTS.md` under the truth notes. | Corpus checkouts are neither installed nor built; without this the oracle scored 66 correct workspace imports on anyq as false positives. |
| 12.2 | The per-spec approval stops of the kickoff prompt were waived by the owner ("start coding without my assistance"); rulings are logged instead of asked. | Owner instruction on 2026-09-02. |
| 9 distribution | `claude plugin add sns45/greplost` is not a CLI form on Claude Code 2.1; the plugin is installed through a marketplace: `claude plugin marketplace add sns45/greplost` then `claude plugin install greplost@greplost`, served by `.claude-plugin/marketplace.json` at the repo root pointing at `./greplost-plugin`. | The plugin lives in a subdirectory of the monorepo. |
| 5.1 grammar | tree-sitter-typescript 0.23.2 is the newest grammar that exists (source unchanged since Nov 2024); hono's generic call signatures hit open upstream issue #335. The extractor recovers around ERROR nodes; root-level ERROR files are reported as unparsable in RESULTS.md. Ruling 2026-09-03. |
