---
description: Check whether the committed greplost map still matches the source (the CI gate), and show a diff if not.
allowed-tools: Bash(greplost verify:*), Bash(bunx greplost verify:*), Bash(command -v greplost:*)
---

Run `greplost verify --diff --json` in the project root (if `greplost` is not
on PATH, run `bunx greplost verify --diff --json` instead).

Report `ok`. If `ok` is false, list `changed`/`missing`/`extra` paths and show
the `diff` (starts `--- a/.greplost/...`); tell the user to run
`/greplost:update` to bring the map back in sync. Exit code 1 on drift is
expected behaviour, not a tool failure — do not treat it as an error to
recover from silently.
