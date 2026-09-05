---
description: Report the blast radius of a file or node id, everything that transitively depends on it, from the greplost map.
argument-hint: <path|node-id>
allowed-tools: Bash(greplost impact:*), Bash(bunx greplost impact:*)
---

Run `greplost impact "$ARGUMENTS" --json` in the project root (if `greplost`
is not on PATH, run `bunx greplost impact "$ARGUMENTS" --json` instead).

The argument may be a file path or a **node id** of the form
`<file>#<kind>.<name>` (a Terraform resource, a Kubernetes object, a workflow
job, a Dockerfile stage, a framework signal). Quote a node id, because it holds
a `#`.

A file target returns `radius` plus a `files` list; a node id returns `radius`
plus a `nodes` list, and that radius counts nodes over import, re-export and
reference edges together. Report the `radius` (the full reverse closure, never
truncated) and the list grouped by `depth`, most important (lowest depth) first,
and say which of the two you got: the two radii answer different questions and
are not comparable. If the argument is not in the map, say so and suggest
`/greplost:update` or confirm the path or node id is spelled and rooted
correctly.
