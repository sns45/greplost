---
description: Report the blast radius of a file — everything that transitively imports it — from the greplost map.
argument-hint: <path>
allowed-tools: Bash(greplost impact:*), Bash(bunx greplost impact:*), Bash(command -v greplost:*)
---

Run `greplost impact "$ARGUMENTS" --json` in the project root (if `greplost`
is not on PATH, run `bunx greplost impact "$ARGUMENTS" --json` instead).

Report the `radius` (full reverse-import closure, never truncated) and the
`files` list grouped by `depth`, most important (lowest depth) first. If the
path is not in the map, say so and suggest `/greplost:update` or confirm the
path is spelled/rooted correctly.
