---
description: Regenerate the semantic layer (FLOWS.md and similar) for a package, or the whole repo if no package is given.
argument-hint: [package]
allowed-tools: Bash(greplost refresh:*), Bash(bunx greplost refresh:*), Bash(command -v greplost:*)
---

Run `greplost refresh $ARGUMENTS --json` in the project root (if `greplost`
is not on PATH, run `bunx greplost refresh $ARGUMENTS --json` instead); omit
the argument to refresh every package.

Report what changed. If it exits 1 with "semantic layer not available in this
build" on stderr, say plainly that this build of greplost has no semantic
layer configured yet — that is expected in some checkouts, not a bug to chase.
