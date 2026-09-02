---
description: Refresh the greplost map incrementally (or fully with $ARGUMENTS = --full) so it matches the current working tree.
argument-hint: [--full]
allowed-tools: Bash(greplost update:*), Bash(bunx greplost update:*), Bash(command -v greplost:*)
---

Run `greplost update --json $ARGUMENTS` in the project root (if `greplost` is
not on PATH, run `bunx greplost update --json $ARGUMENTS` instead). Default
mode is incremental over `.greplost/.dirty` and any changed files; pass
`--full` only when asked to rebuild everything.

Parse the JSON result (`mode`, `dirty`, `reparsed`, `cached`, `written`,
`deleted`, `ms`, `skipped?`) and report it as one short line, e.g. "updated:
3 files reparsed, 5 cards written, 42ms". If `.greplost/` does not exist yet,
say that `/greplost:init` needs to run first.
