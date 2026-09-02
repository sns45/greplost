---
description: Build the greplost structure map for this repo, install its git hooks, and write config.
allowed-tools: Bash(greplost init:*), Bash(bunx greplost init:*), Bash(command -v greplost:*)
---

Run `greplost init` in the project root (if `greplost` is not on PATH, run
`bunx greplost init` instead). Then report, concisely:

- what it created (`.greplost/` and its contents, `.greplost.json` config)
- which git hooks it installed, if any
- the exit code, and the stderr message verbatim if it failed

If `.greplost/` already exists, `init` is idempotent and safe to re-run — say
so rather than treating a second run as an error.
