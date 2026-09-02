# greplost

> grep lost. Read the map.

greplost is not a search tool. It is the map you read so you do not have to search. It generates a committed, deterministic, always-fresh map of a codebase under `.greplost/`: Markdown you can read on GitHub, ASCII trees, Mermaid diagrams, and JSONL graphs that coding agents query instead of grepping. The structure layer is built from the AST with tree-sitter and contains no LLM output, so two builds of the same commit are byte-identical and `greplost verify` fails CI the moment the map lags the code.

![Quadrant scatter: minutes of machine time to stay fresh over 100 commits on the x axis against import edge F1 at the last commit on the y axis, one labelled dot per tool, with greplost alone in the shaded low cost and high freshness corner and Understand-Anything marked n/a](docs/assets/x-quadrant-freshness.png)

*What staying fresh costs, against how fresh it stays: hono, tier M (248 files), 100 replayed commits, documented-sync arm (each tool's own hook installed exactly as its README describes, then left alone). Every number, and every loss, is in [bench/RESULTS.md](bench/RESULTS.md).*

![Quadrant scatter: seconds from a fresh checkout to a first usable map on the x axis against call edge F1 versus compiler truth on the y axis, one labelled dot per tool, greplost in the shaded fast and accurate corner](docs/assets/x-quadrant-accuracy.png)

*What a first map costs, against how right it is: anyq, tier S (148 files), no commit walk; the cold start is the median of the timed runs and the F1 is computed from the precision and recall of every call edge the tool emits. Method and losses in [bench/RESULTS.md](bench/RESULTS.md).*

![Grouped bar chart of X1 structural precision against compiler truth, one bar per tool for call edges and for import edges, with the value printed inside each bar and a dashed stub where a tool could not be run](docs/assets/x1-precision.png)

*Precision against compiler truth, by edge kind: anyq, tier S (148 files), every confidence, no commit walk. Precision is the half where three tools agree; recall is where they part, and both are in [bench/RESULTS.md](bench/RESULTS.md).*

![Freshness under each tool's own sync mechanism: F1 against compiler truth per commit on hono over 100 replayed commits; each tool runs only what its own README installs, and the note states each tool's commit-0 F1 so coverage is not read as staleness](docs/assets/x2-staleness.png)

*On this corpus no tool decays once its own hook is installed: greplost stays at 1.000, graphify and code-review-graph hold their (lower) starting accuracy. The gap is coverage, not staleness; the decay that appears when no sync is installed is the companion chart in [bench/RESULTS.md](bench/RESULTS.md). Every number behind both charts is there, with the losses.*

Status: pre-release 0.0.1. Design: [docs/greplost-tech-spec.md](docs/greplost-tech-spec.md).

## What you get

```
.greplost/
  INDEX.md                 start here: packages, hotspots, how to navigate
  repo/MAP.md              package graph (Mermaid + ASCII), cycles, blast radius
  repo/HOTSPOTS.md         highest fan-in and blast-radius files
  packages/<slug>/MAP.md   module graph of one package, split by directory when large
  packages/<slug>/API.md   every exported symbol with its signature
  packages/<slug>/modules/**.md   one card per file: exports, importers, callers, summary
  packages/<slug>/FLOWS.md semantic layer (optional, LLM-written, clearly banner-dated)
  graph/{imports,calls,symbols}.jsonl   the graph, one sorted line per edge or declaration
  manifest.json            per-file sha256, fan-in, fan-out, blast radius
  config.json              include/exclude, languages, diagram limits
```

Languages: TypeScript, TSX, JavaScript, JSX and Go. Imports resolve through tsconfig `paths`, workspace packages, `package.json` `exports` and Go module paths. Call edges are only recorded when the callee resolves to one declaration (`high`) or through a re-export chain (`med`); nothing is guessed.

`greplost init` writes `config.json` once and never rewrites it. Its `languages` start as the TypeScript family (`ts`, `tsx`, `js`, `jsx`), plus `go` when the repository has a `go.mod` anywhere in the indexed file set — both, in a repo that has both. Edit the file to change it; a build that indexes nothing says so on stderr rather than writing an empty map in silence.

## Install

```bash
bun add -g greplost        # or: npm i -g greplost
greplost --version
```

Requires Bun 1.2 or Node 20. Grammars ship inside the package; nothing is downloaded at runtime.

## Quick start

```bash
cd your-repo
greplost init              # builds .greplost/, installs git hooks, writes config.json
git add .greplost && git commit -m "greplost: add the map"

greplost query Registry    # definition, importers, callers, package, card
greplost impact src/core/retry.ts --depth 2
greplost verify --diff     # exit 1 with a unified diff when the map is stale
greplost update            # incremental: only files changed since the last index
```

The git hooks installed by `init` (post-commit, post-checkout, post-merge) run an incremental update, so the committed map follows the code without anyone remembering to regenerate it. Every command accepts `--root <dir>` and `--json`; the JSON shapes are stable and documented in the plugin skill.

## Keep it honest in CI

```yaml
- run: bun add -g greplost
- run: greplost verify --diff
```

`verify` rebuilds the map in memory and compares it byte for byte with the committed one. Drift is a red check with the diff in the log.

## Claude Code plugin

```bash
claude plugin marketplace add sns45/greplost
claude plugin install greplost@greplost
```

The plugin adds a `SessionStart` hint that the repo has a map, a `PreToolUse` nudge before `Glob` and `Grep` to consult `.greplost/INDEX.md` or `greplost query --json` first, a `PostToolUse` hook that records edited files, and a `Stop` hook that runs an incremental update. It never blocks a tool call and never changes permission decisions. It also ships `/greplost:query`, `/greplost:impact`, `/greplost:verify`, `/greplost:update`, `/greplost:init`, `/greplost:refresh` and a read-only `greplost-navigator` subagent.

## Workspace mode

A `greplost.workspace.json` next to sibling repos adds cross-repo edges and a `WORKSPACE.md`:

```json
{ "name": "my-workspace", "repos": ["./api", "./web", "./shared"] }
```

Run `greplost impact <repo>::<file>` from the workspace root to see dependents in every repo. Cross-repo edges come from import specifiers that match a package a sibling repo publishes (npm name or Go module path).

## Semantic layer (optional)

```bash
greplost refresh [pkg] [--model <m>] [--dry-run]
```

Writes one-paragraph module summaries and per-package `FLOWS.md` using the `claude` CLI, cached by content hash in `.greplost/cache/summaries.json`. Summaries never touch the structure layer's bytes. A card whose summary is older than its code shows the banner `summary may lag code, last refreshed <date>` until the next refresh.

## Determinism contract

- Node ids are `<path>`, `<path>#Symbol.path`, `pkg:<name>`, `ext:<name>`.
- Every collection is sorted in code-unit order; JSON keys are sorted; JSONL is one compact line per edge.
- No timestamps, absolute paths or machine names in the structure layer.
- Mermaid node order is the sorted id order; labels are derived, never hand-edited.

## Benchmarks

Everything below is measured by `bun run bench:*` and written to [bench/RESULTS.md](bench/RESULTS.md); the tables in this README are generated from that file and are never edited by hand. Competitors run at pinned versions per their own READMEs and are scored by the same adapters against the same compiler truth. Losses are published with a reason.

## Head-to-head

<!-- headtohead:start (generated from bench/RESULTS.md by `bun run bench:report`; do not edit) -->
greplost against Graphify, Understand-Anything and code-review-graph (tech spec 3.1, 10.0). The `vs` columns are greplost's verdict against that tool: `win` means greplost came out ahead by the metric's margin, `tie` inside it, `loss` behind it, `n/a` when the tool could not be run at all. Every loss and every `n/a` carries its reason.

- X1, X4, X5, X6: Measured 2026-09-02 at 173a463 on anyq, tier S (148 files).
- X2, X3: Measured 2026-09-02 at b908e0f on hono, tier M (248 files, 100 commits).
- X10: Measured 2026-09-02 at 7e04594.

| ID | Target | Measured | vs graphify | vs ua | vs crg | Reason on loss |
|---|---|---|---|---|---|---|
| X1 | >= +10pt calls, >= +3pt imports | calls 1 P / 0.468 R, imports 1 P / 1 R | win (calls 0.877 P / 0.096 R, imports 1 P / 0.088 R) | n/a | win (calls 0.361 P / 0.28 R, imports 1 P / 0.684 R) | greplost: gap over the best competitor is 0.123 on calls and 0 on imports; the target is +0.10 and +0.03 |
| X2 | greplost F1 >= 0.99 after 100 commits | 1 | tie (decay +0.0052 (0.131 to 0.125)) | n/a | tie (decay -0.0028 (0.894 to 0.897)) | greplost: greplost started the walk at 1 import F1 and ended at 1, a fall of 0.000. The level is coverage (X1's subject); only the fall is staleness |
| X3 | <= 1% of ua, <= 20% of graphify over 100 commits | $0, 0.299 min | win ($0, 2.365 min) | n/a | win ($0, 0.858 min) | greplost: evaluated on the graphify arm of the target only: 12.6% of graphify's wall-clock (target <= 20%). The ua arm cannot be evaluated — Understand-Anything has no headless entry point here, so no cost exists to take 1% of. |
| X4 | 0 bytes differ | 0 bytes | tie (0 bytes) | n/a | win (5160286 bytes) |  |
| X5 | <= 10 artifact lines | 54 of 10511 lines | loss (24 of 99031 lines) | n/a | win (60 of 88119 lines) | greplost: 54 artifact lines of 10511 changed across 12 files for a one-line source change; the target is 10 lines. Where: `manifest.json` 20 lines, `packages/anyq__kafka/MAP.md` 8 lines, `packages/anyq__example-retry-strategies/MAP.md` 7 lines, `packages/anyq__example-retry-strategies/modules/src/adapters/kafka.ts.md` 4 lines, and 8 more files; graphify: 24 of 99031 artifact lines changed against greplost's 54 of 10511, a quieter diff than greplost's. Where: `graphify-out/graph.json` 12 lines, `graphify-out/GRAPH_REPORT.md` 6 lines, `graphify-out/manifest.json` 6 lines |
| X6 | <= 5s and $0 (measured on anyq, tier S, not tier M) | 0.283 s ($0) | win (2.159 s) | n/a | win (1.207 s) |  |
| X7 | accuracy >= best, tool calls <= 50% of best | n/a | n/a | n/a | n/a |  |
| X8 | <= 50% of best competitor tokens | n/a | n/a | n/a | n/a |  |
| X9 | fastest, highest hit rate | n/a | n/a | n/a | n/a |  |
| X10 | works (capability, not a score) | works | n/a | n/a | n/a |  |

> Reading the X1 row: each `vs <tool>` column is greplost against that tool on **call edge precision**, the headline tech spec 10.0 names. greplost's own `Measured` verdict is against **both halves** of the 3.1 target at once (+0.10 on calls and +0.03 on imports), so it can be a `tie` in the same row where every competitor column is a `win`.

- **X1** Structural precision vs compiler truth: greplost calls 1 P / 0.468 R, imports 1 P / 1 R, graphify calls 0.877 P / 0.096 R, imports 1 P / 0.088 R, ua n/a, crg calls 0.361 P / 0.28 R, imports 1 P / 0.684 R
- **X2** Staleness after 100 replayed commits: greplost 1, graphify decay +0.0052 (0.131 to 0.125), ua n/a, crg decay -0.0028 (0.894 to 0.897)
- **X3** Cost to stay fresh over 100 replayed commits: greplost $0, 0.299 min, graphify $0, 2.365 min, ua n/a, crg $0, 0.858 min
- **X4** Reproducibility: two builds of one commit: greplost 0 bytes, graphify 0 bytes, ua n/a, crg 5160286 bytes
- **X5** Diff signal after a one-line change: greplost 54 of 10511 lines, graphify 24 of 99031 lines, ua n/a, crg 60 of 88119 lines
- **X6** Cold start to first usable map: greplost 0.283 s ($0), graphify 2.159 s, ua n/a, crg 1.207 s
- **X7** Agent structural tasks: greplost n/a, graphify n/a, ua n/a, crg n/a
- **X8** Orientation cost: greplost n/a, graphify n/a, ua n/a, crg n/a
- **X9** Reviewer task: spot the new cross-package dependency: greplost n/a, graphify n/a, ua n/a, crg n/a
- **X10** Cross-repo blast radius in workspace mode: greplost works, graphify n/a, ua n/a, crg n/a

**Why a cell is n/a**

- X1, X2, X3, X4, X5, X6 (ua): distributed only as a Claude Code plugin, and `/understand` is a multi-agent LLM pipeline: there is no headless CLI, so the only way to drive it is `claude --plugin-dir <clone>/understand-anything-plugin -p "/understand"` against a clone pinned at v2.9.0, inside the scratch HOME. That spends model tokens on every commit of every metric, so this harness does not run it and never installs the plugin into the machine’s real Claude Code configuration
- X7, X8, X9 (greplost, graphify, ua, crg): not selected by --metrics
- X10 (graphify): no cross-repo blast radius: `graphify merge-graphs` can union two graph.json files after the fact, but nothing resolves an import from one repo to a definition in another, so a merged graph has two disconnected components
- X10 (ua): no cross-repo mode: `/understand` analyses one project directory and writes one `.ua/knowledge-graph.json` anchored at it; a second repo would need a second run and there is no edge type joining them
- X10 (crg): `crg-daemon` watches several repositories, but each keeps its own SQLite graph and the resolver never crosses a repository boundary, so `code-review-graph` can answer 'who calls this' only within one repo

> X10 (greplost): `greplost init --workspace --no-hooks` then `greplost impact repo-a/src/greet.ts --json` on a copy of `fixtures/two-repo-workspace` returned 3 affected files, 2 of them in `repo-b` — the blast radius crossed the repository boundary, which is the capability tech spec 3.1 X10 asks for. It is not a score: no competitor has an equivalent to compare it against.
> X10: a capability row, not a score (tech spec 3.1). Each competitor's cell says what it would need to do this.
> graphify sync mechanism (X2, from bench/competitors.json): git hooks.
> ua sync mechanism (X2, from bench/competitors.json): git post-commit hook, opt-in.
> crg sync mechanism (X2, from bench/competitors.json): platform hooks plus a watcher.
> X2: the commit walk is **synthetic**. It is generated over the corpus repo's pinned checkout rather than replayed from its real history: each commit appends exactly one resolvable import line to one file, so truth moves by exactly one edge per commit, and the walk contains no deletions, no renames and no new files — the easy direction for an incremental updater. Tech spec 10.0 X2 asks for 500 real commits of a corpus checkout; that is not what was run.
> Mechanical staleness check (tech spec 10.0 X2): greplost has `verify` (byte comparison against a rebuild, exit 1 on drift). None of the three competitors ships an equivalent: their artifacts are refreshed, never checked.
> graphify: run through `graphify update .` (the documented no-LLM rebuild) rather than the `/graphify .` slash command, which needs a model; graph.html is excluded from the byte comparison because it is a viewer, not the graph. `graphify hook install` is run in X2's documented-sync arm, where the hooks it writes go into the repo copy's own .git/hooks; `graphify install`, which writes a global CLAUDE.md section and a Claude Code PreToolUse hook, is not run.
> graphify: every command ran with HOME=bench/.competitors/home (XDG and CLAUDE_CONFIG_DIR pointed inside it), so nothing it writes outside the repo copy reaches the machine's real configuration.
> ua: N/A — distributed only as a Claude Code plugin, and `/understand` is a multi-agent LLM pipeline: there is no headless CLI, so the only way to drive it is `claude --plugin-dir <clone>/understand-anything-plugin -p "/understand"` against a clone pinned at v2.9.0, inside the scratch HOME. That spends model tokens on every commit of every metric, so this harness does not run it and never installs the plugin into the machine’s real Claude Code configuration.
> crg: `build` + `visualize --format json` produce the artifact; `graph.db` is excluded from the byte comparison because a SQLite page layout is not the tool's output contract. `code-review-graph install` runs only in X2's documented-sync arm and only with HOME, XDG_* and CLAUDE_CONFIG_DIR pointed inside bench/.competitors/home.
> crg: every command ran with HOME=bench/.competitors/home (XDG and CLAUDE_CONFIG_DIR pointed inside it), so nothing it writes outside the repo copy reaches the machine's real configuration.
> X2: the walk is 100 synthetic commits over hono, each adding one resolvable import line, scored every 12 commits against compiler truth at that commit.
> X2: the plotted number is import edge F1 against compiler truth at that commit, and the curve starts at commit 0 with each tool's freshly built artifact. The **level** of a line is that tool's import coverage, not its freshness: the four tools do not model imports alike, and X1 measures how far apart they start (on this corpus graphify recalls a small fraction of the import edges the compiler sees). The **fall** of a line between commit 0 and the last commit is the staleness this metric is about, and it is reported as `decay` in every cell. A reader comparing two end-points is comparing coverage plus decay; only the decay belongs to X2. Call F1 is in each cell's detail.
> X2 arm `documented-sync` (`syncF1@<commit>` in each cell's detail): each tool's own sync mechanism was installed exactly as its README describes and then left alone: the harness commits, and nothing else.
> X2 arm `staleF1@<commit>`: each tool's commit-0 artifact scored against truth at that commit — the curve a reader gets when a sync mechanism is absent or does not fire. greplost is the only one of the four whose `verify` reports that state at all; the others refresh without ever checking.
> X2 sync (greplost): installed with `greplost init`; hook at `.git/hooks/post-commit`; observed to run on 100 of 100 commits (17.92 s of child-process wall-clock in total). the hook resolves `greplost` through PATH and backgrounds `greplost update --incremental --quiet`; a PATH shim in front of it writes a start and an end line per invocation, so a commit's rebuild is waited for rather than slept on, and its wall-clock is the child process's own.
> X2 sync (graphify): installed with `graphify update .` + `graphify hook install`; hook at `.git/hooks/post-commit`; observed to run on 100 of 100 commits (141.89 s of child-process wall-clock in total). `graphify hook install` writes a post-commit hook that launches a detached python rebuild without going through the `graphify` launcher, so a PATH shim cannot see it: the rebuild is observed instead through the hook's own log under the sandbox HOME (`.cache/graphify-rebuild.log`, one line per rebuild) and waited for until the detached process is gone, which is what its wall-clock is measured over. That window starts when the commit returns rather than when the hook launched the child, so graphify's number is a slight under-count — the direction that flatters graphify, not greplost.
> X2 sync (crg): installed with `code-review-graph install` + `code-review-graph build` + `code-review-graph visualize --format json`; hook at `.git/hooks/pre-commit`; observed to run on 100 of 100 commits (51.45 s of child-process wall-clock in total). `code-review-graph install` writes a pre-commit hook that runs `code-review-graph update` synchronously and resolves the binary through PATH, so a PATH shim in front of it records a start and an end line per commit; the hook runs `update` and then `detect-changes --brief`, and both are counted because both are what a commit costs a crg user; it does not run `visualize`, so no export is inside its timing.
> X2: how much of the gap is coverage and how much is staleness — graphify: end-point gap 0.875, of which 0.869 was already there at commit 0 (coverage) and 0.005 is the difference in decay; crg: end-point gap 0.103, of which 0.106 was already there at commit 0 (coverage) and -0.003 is the difference in decay. X1 is where a coverage difference belongs; X2 is only the fall.
> X3: every tool's wall-clock is the run time of the child processes its own commit-time mechanism started, interpreter startup included, measured the same way for greplost as for the competitors. crg's `visualize --format json` export is outside that number: its hook does not run it, and it is invoked by this suite only at scoring checkpoints, because greplost has no export step to charge against it.
> X3: every tool that ran here ran its no-LLM path, so USD is 0 for all of them and the verdict falls to wall-clock. That is not the tech spec's comparison, which costs each tool's *documented* refresh: graphify's `/graphify` first pass and Understand-Anything's `/understand` are LLM pipelines whose USD this harness cannot measure without model credentials. The zero is what was measured, not a claim that their documented path is free.
> X1: both sides restricted to the 148 files the TypeScript compiler loaded, and both scored over every edge each tool emits at any confidence. The confidence=high arm (greplost's S3 gate, graphify's and crg's `EXTRACTED` tier) is reported beside it in each cell's detail; scoring greplost at high while scoring a competitor at every confidence would flatter greplost on precision by construction.
> X4: every tool is built twice on the same tree, each build in its own process, and the differing bytes of its documented artifact files are counted after trimming the common prefix and suffix (an upper bound on the edit distance, exact for a single contiguous change). greplost is compared over the structure artifacts `listStructurePaths` enumerates; viewer and database files are excluded per competitor, and each cell's `caveat` says which.
> X5: the one-line change is `import "./kafka.js";` appended to `apps/examples/retry-strategies/src/adapters/nats.ts`, adding the edge apps/examples/retry-strategies/src/adapters/nats.ts -> apps/examples/retry-strategies/src/adapters/kafka.ts.
> X5: lines changed is added plus removed lines from a line-level longest-common-subsequence per artifact file (multiset difference above 4000 lines).
> X5 readability (tech spec 10.0's "can a human read the architectural change from the diff alone"): greplost added a line naming both the importer and the imported module; graphify, crg did not, so the new edge is not legible in the diff at any length.
> X6: timed from a fresh copy of the repo (no cache, no artifact) to the tool's own first usable output, 3 runs each, median reported and the spread in each cell's detail, every tool in its own child process so interpreter startup is counted for all of them. greplost's command is `greplost init --no-hooks` and its USD is 0; a competitor's documented first pass may cost model tokens, and where the no-LLM path was used instead the cell's caveat says so.

**X2 (hero chart): freshness under each tool's own sync mechanism over a synthetic commit walk, F1 vs commit**

```mermaid
%%{init: {"theme": "dark", "themeVariables": {"xyChart": {"backgroundColor": "#000000", "titleColor": "#ffffff", "xAxisLabelColor": "#c3c2b7", "yAxisLabelColor": "#c3c2b7", "xAxisTitleColor": "#ffffff", "yAxisTitleColor": "#ffffff", "plotColorPalette": "#0fa976,#e0561c,#2f86ef"}}}}%%
xychart-beta
    title "Freshness under each tool's own sync mechanism: F1 vs commit"
    x-axis "commit index" ["0", "12", "24", "36", "48", "60", "72", "84", "96", "100"]
    y-axis "F1 vs compiler truth" 0 --> 1
    line [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    line [0.131, 0.131, 0.129, 0.126, 0.124, 0.127, 0.128, 0.126, 0.126, 0.125]
    line [0.894, 0.896, 0.898, 0.9, 0.902, 0.904, 0.906, 0.908, 0.9, 0.897]
    %% series, in order: greplost, graphify, crg
    %% Arm: documented-sync; corpus hono, tier M (248 files); 100 replayed commits; the walk is synthetic (one added import line per commit). Read the fall of a line, not its height.
    %% Arm: documented-sync — each tool's sync mechanism was installed exactly as its README describes and then left alone; the harness only commits, except that crg's `visualize --format json` export is run at each scoring checkpoint because nothing else writes the JSON its artifact is read from (it is outside every timing and does not rebuild). This is the arm tech spec 10.0 X2 words. Read the FALL of each line, not its height: the height is that tool's import coverage (X1's subject) and only the fall is staleness. At commit 0 the freshly built artifacts scored greplost 1.000, graphify 0.131, crg 0.894; over the walk their decay (F1 at commit 0 minus F1 at the last commit) was greplost 0.000, graphify +0.005, crg -0.003, a negative decay being ground gained. The distance between the lines is mostly that starting difference, which is coverage and belongs to X1; the staleness X2 measures is the movement. Omitted (not run here): ua. Measured on corpus hono, tier M (248 files); 100 replayed commits. The walk is synthetic: each commit appends exactly one resolvable import line to one file, so truth moves by exactly one edge per commit, and the walk contains no deletions, no renames and no new files.
```


**X2 companion: the same artifacts, never updated**

```mermaid
%%{init: {"theme": "dark", "themeVariables": {"xyChart": {"backgroundColor": "#000000", "titleColor": "#ffffff", "xAxisLabelColor": "#c3c2b7", "yAxisLabelColor": "#c3c2b7", "xAxisTitleColor": "#ffffff", "yAxisTitleColor": "#ffffff", "plotColorPalette": "#0fa976,#e0561c,#2f86ef"}}}}%%
xychart-beta
    title "X2 staleness with no refresh"
    x-axis "commit index" ["0", "12", "24", "36", "48", "60", "72", "84", "96", "100"]
    y-axis "F1 vs compiler truth" 0 --> 1
    line [1, 0.99, 0.979, 0.969, 0.96, 0.95, 0.941, 0.931, 0.922, 0.919]
    line [0.131, 0.128, 0.126, 0.123, 0.121, 0.119, 0.117, 0.115, 0.113, 0.112]
    line [0.894, 0.884, 0.874, 0.864, 0.855, 0.845, 0.836, 0.827, 0.818, 0.816]
    %% series, in order: greplost, graphify, crg
    %% Arm: no-refresh; corpus hono, tier M (248 files); 100 replayed commits; the walk is synthetic (one added import line per commit). Read the fall of a line, not its height.
    %% Arm: no-refresh — each tool's commit-0 artifact scored against truth at that commit, which is what a reader gets when a sync mechanism is absent or silently does not fire. greplost is the only one of the four that can report this state mechanically, through `verify`. Omitted (not run here): ua. Measured on corpus hono, tier M (248 files); 100 replayed commits. The walk is synthetic: each commit appends exactly one resolvable import line to one file, so truth moves by exactly one edge per commit, and the walk contains no deletions, no renames and no new files.
```


**Cost to stay fresh against freshness, one dot per tool**

_Mermaid's `xychart-beta` has no scatter form, so this quadrant has no inline fence: the numbers behind it are the X2 and X3 rows of the table above._


**Cold start against call graph accuracy, one dot per tool**

_Mermaid's `xychart-beta` has no scatter form, so this quadrant has no inline fence: the numbers behind it are the X1 and X6 rows of the table above._


**X1 precision per tool per edge kind**

```mermaid
%%{init: {"theme": "dark", "themeVariables": {"xyChart": {"backgroundColor": "#000000", "titleColor": "#ffffff", "xAxisLabelColor": "#c3c2b7", "yAxisLabelColor": "#c3c2b7", "xAxisTitleColor": "#ffffff", "yAxisTitleColor": "#ffffff", "plotColorPalette": "#0fa976,#e0561c,#2f86ef"}}}}%%
xychart-beta
    title "X1 structural precision vs compiler truth"
    x-axis ["call edges", "import edges"]
    y-axis "precision vs compiler truth" 0 --> 1
    bar [1, 1]
    bar [0.877, 1]
    bar [0.361, 1]
    %% series, in order: greplost, graphify, crg
    %% omitted (no data, or a gap Mermaid cannot draw): ua
    %% Precision by edge kind, every confidence; higher is better. Corpus anyq, tier S (148 files).
    %% A dashed stub is a tool that could not be run; see the reason column. Measured on corpus anyq, tier S (148 files).
```


**X3 cost per tool**

```mermaid
%%{init: {"theme": "dark", "themeVariables": {"xyChart": {"backgroundColor": "#000000", "titleColor": "#ffffff", "xAxisLabelColor": "#c3c2b7", "yAxisLabelColor": "#c3c2b7", "xAxisTitleColor": "#ffffff", "yAxisTitleColor": "#ffffff", "plotColorPalette": "#0fa976,#e0561c,#2f86ef"}}}}%%
xychart-beta
    title "X3 cost to stay fresh"
    x-axis ["greplost", "graphify", "crg"]
    y-axis "USD over 100 commits" 0 --> 1
    bar [0, 0, 0]
    %% series, in order: USD
    %% not measured, omitted from the x axis: ua
    %% USD spent keeping the artifact fresh; lower is better. Corpus hono, tier M (248 files); 100 replayed commits.
    %% Every tool that ran here ran its no-LLM path, so USD is 0 for all of them; the wall-clock that separates them is in the table and on the freshness quadrant chart. A bar at the baseline is a measured zero; a dashed stub is a tool that could not be run. Measured on corpus hono, tier M (248 files); 100 replayed commits.
```


**X4 bytes that differ between two builds of one commit**

```mermaid
%%{init: {"theme": "dark", "themeVariables": {"xyChart": {"backgroundColor": "#000000", "titleColor": "#ffffff", "xAxisLabelColor": "#c3c2b7", "yAxisLabelColor": "#c3c2b7", "xAxisTitleColor": "#ffffff", "yAxisTitleColor": "#ffffff", "plotColorPalette": "#0fa976,#e0561c,#2f86ef"}}}}%%
xychart-beta
    title "X4 reproducibility: bytes that differ between two builds"
    x-axis ["crg", "greplost", "graphify"]
    y-axis "bytes differing between two builds of one commit" 0 --> 7500000
    bar [5160286, 0, 0]
    %% series, in order: bytes
    %% not measured, omitted from the x axis: ua
    %% Bytes differing between two builds of one commit; lower is better. Corpus anyq, tier S (148 files).
    %% Two builds of the same tree, each in its own process, compared over that tool's own documented artifact files; viewer and database files are excluded per competitor and each cell's caveat says which. A bar at the baseline is a measured zero — the best result this metric has — and a dashed stub is a tool that could not be run. Measured on corpus anyq, tier S (148 files).
```


**X5 artifact lines changed by a one-line source change**

```mermaid
%%{init: {"theme": "dark", "themeVariables": {"xyChart": {"backgroundColor": "#000000", "titleColor": "#ffffff", "xAxisLabelColor": "#c3c2b7", "yAxisLabelColor": "#c3c2b7", "xAxisTitleColor": "#ffffff", "yAxisTitleColor": "#ffffff", "plotColorPalette": "#0fa976,#e0561c,#2f86ef"}}}}%%
xychart-beta
    title "X5 diff signal after a one-line change"
    x-axis ["crg", "greplost", "graphify"]
    y-axis "artifact lines added plus removed" 0 --> 75
    bar [60, 54, 24]
    %% series, in order: lines
    %% not measured, omitted from the x axis: ua
    %% Artifact lines added plus removed; lower is better. Corpus anyq, tier S (148 files).
    %% Absolute lines, and the artifacts they are lines of are not the same size: the denominators are in the table (and in each cell's value) and they differ by an order of magnitude, so this chart ranks the size of the diff a reviewer reads, not the share of the artifact it touched. Measured on corpus anyq, tier S (148 files).
```


**X6 cold start to a first usable map**

```mermaid
%%{init: {"theme": "dark", "themeVariables": {"xyChart": {"backgroundColor": "#000000", "titleColor": "#ffffff", "xAxisLabelColor": "#c3c2b7", "yAxisLabelColor": "#c3c2b7", "xAxisTitleColor": "#ffffff", "yAxisTitleColor": "#ffffff", "plotColorPalette": "#0fa976,#e0561c,#2f86ef"}}}}%%
xychart-beta
    title "X6 cold start to a first usable map"
    x-axis ["graphify", "crg", "greplost"]
    y-axis "seconds, median of the timed runs" 0 --> 2.5
    bar [2.159, 1.207, 0.283]
    %% series, in order: seconds
    %% not measured, omitted from the x axis: ua
    %% Seconds, median of the timed runs; lower is better. Corpus anyq, tier S (148 files).
    %% Timed from a fresh copy of the repo (no cache, no artifact) to the tool's own first usable output, every tool in its own child process so interpreter startup is counted for all of them; the spread is in each cell's detail. Measured on corpus anyq, tier S (148 files).
```
<!-- headtohead:end -->

### Single-tool numbers

<!-- singletool:start (generated from bench/RESULTS.md; do not edit) -->
greplost measured against its own section 3 targets, one row per metric id. The measured column is filled from `bench/results/*.json` by the harness and is never typed by hand (tech spec 10.10); a metric whose suite has not run says `not run` rather than carrying a placeholder.

| ID | Metric | Target | Measured | Source |
|---|---|---|---|---|
| S1 | import edge precision / recall | >= 0.99 / >= 0.97 | 1 / 1 | Eval 1, `structural` (hono (248 files)) |
| S2 | export precision / recall | >= 0.99 / >= 0.99 | 1 / 0.999 | Eval 1, `structural` (hono (248 files)) |
| S3 | call edge precision (confidence=high) | >= 0.95 | 1 | Eval 1, `structural` (hono (248 files)) |
| S4 | import cycle Jaccard | = 1.00 | 1 | Eval 1, `structural` (hono (248 files)) |
| unparsable | files whose tree-sitter parse is broken at the root level | 0 | 5 | Eval 1, `structural` |
| F1 | `verify` catch rate on stale maps | 100% | 100% | Eval 2, `replay` |
| F2 | `verify` false positives after `update` | 0% (byte-identical) | 0% | Eval 2, `replay` |
| P1 | full build, 1k / 10k files | <= 1s / <= 10s (measured on anyq, tier S, 148 files) | 203 ms (p50) | Bench 3, `perf` |
| P2 | incremental update p95, 1k / 10k files | <= 500ms / <= 1s (measured on anyq, tier S, 148 files) | 145 ms | Bench 3, `perf` |
| P3 | peak RSS at 10k files | <= 500MB (reported) (measured on anyq, tier S, 148 files) | 229.9 MB | Bench 3, `perf` |
| M1 | INDEX.md token budget | <= 3000 tokens at 10k files (measured on greplost, 120 files) | 777 tokens | Map quality, `mapquality` |
| M2 | diagrams exceeding the node cap after auto-split | 0 | 0 | Map quality, `mapquality` |
| A1 | agent tokens per task vs baseline (median) | <= 50% | not run | Eval 4, `agent` |
| A2 | agent tool calls per task vs baseline | <= 40% | not run | Eval 4, `agent` |
| A3 | agent answer accuracy vs baseline | non-inferior; +10pt on blast radius | not run | Eval 4, `agent` |
| A4 | agent wall-clock per task vs baseline | <= 60% | not run | Eval 4, `agent` |

> F2 rests on 1 full-vs-incremental comparison over a walk of 100 commits. It compares the structure artifacts that `listStructurePaths` enumerates — `INDEX.md`, `manifest.json`, `graph/*.jsonl`, `repo/*.md`, `packages/*/{MAP,API}.md` and `packages/*/modules/**` — and not the whole `.greplost/` directory: `config.json`, `cache/` and the runtime files (`.dirty`, `.lock`, `.state.json`) are excluded, because they are not the map and are not committed (ruling 2026-09-02).

> `unparsable` counts files whose tree-sitter parse root is an ERROR node or has one as a direct child: the top level of the file is not a program the grammar recognises (`findUnparsableFiles` in `@greplost/core`, Appendix C ruling 2026-09-03). The extractor recovers around ERROR nodes, so these files are still scored — which is the problem: whatever the grammar could not read costs S1 and S2 recall with no line saying so unless it is counted here. tree-sitter-typescript 0.23.2 is the newest grammar that exists, and hono's generic call signatures hit open upstream issue https://github.com/tree-sitter/tree-sitter-typescript/issues/335. The count is read from the structural payload when it reports one, and otherwise derived from it — a file every one of whose truth items was missed is a file nothing was extracted from — and it is `n/a` with `not measured` when the payload carries neither. Nothing about it is asserted here.

> Rows reading `not run` have no result file behind them, not a value of zero; the section below each metric names the command that would produce one.
<!-- singletool:end -->

Suites: structural precision and recall against the TypeScript compiler and a Go call-graph program (S1 to S4), commit replay freshness (F1, F2), build and update latency (P1, P2), map quality (M1), and agent task cost with and without the map (A1 to A4). The corpus is pinned in `bench/corpus.json`.

## Repository layout

```
packages/core       tree-sitter extraction, resolution, graph, metrics
packages/render     Markdown, ASCII and Mermaid rendering
packages/sync       init, incremental update, verify, git hooks, locking
packages/cli        the greplost command
packages/semantic   optional LLM summaries and flows
packages/workspace  multi-repo mode
greplost-plugin     Claude Code plugin (hooks, skill, commands, agent)
bench               evaluation harness, truth generators, competitor adapters
```

## License

MIT
