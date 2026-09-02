---
description: Look up a symbol or file in the greplost map — definition, importers, callers, package, card path.
argument-hint: <symbol|path>
allowed-tools: Bash(greplost query:*), Bash(bunx greplost query:*), Bash(command -v greplost:*)
---

Run `greplost query "$ARGUMENTS" --json` in the project root (if `greplost` is
not on PATH, run `bunx greplost query "$ARGUMENTS" --json` instead).

Read the result (see the `greplost` skill for the exact shape). If `matches`
is non-empty, report each match's name, kind, file:span, package, and — for a
single match — its `card` path, `importers` and `callers`. If the argument
resolved to an indexed file, also report the `file` block (exports, imports,
importers, fan-in/out, blast radius, loc). If nothing matched, say so and
suggest `/greplost:update` in case the map is stale, or a plain Grep if the
target may not be a declaration at all.
