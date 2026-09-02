# greplost

> grep lost. Read the map.

greplost generates a committed, deterministic, always-fresh map of a codebase
under `.greplost/`: Markdown you can read on GitHub, ASCII trees, Mermaid
diagrams, and JSONL graphs that coding agents query instead of grepping. The
structure layer is built from the AST with tree-sitter and contains no LLM
output, so two builds of the same commit are byte-identical and `greplost
verify` fails CI the moment the map lags the code.

Languages: TypeScript, TSX, JavaScript, JSX and Go.

## Install

```bash
bun add -g greplost        # or: npm i -g greplost
greplost --version
```

Requires Bun 1.2 or Node 20. Grammars ship inside the package; nothing is
downloaded at runtime.

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

`init` writes `.greplost/config.json` from the defaults and never rewrites it
afterwards; the languages it starts with are the TypeScript family, plus `go`
when the repository has a `go.mod`. Every command accepts `--root <dir>` and
`--json`, and the JSON shapes are stable.

Exit codes: 0 success, 1 drift or not found, 2 usage error.

## Full documentation

Everything else — the artifact layout, the Claude Code plugin, the benchmark
results, and the design spec — is in the project README:
<https://github.com/sns45/greplost#readme>.

MIT licensed.
