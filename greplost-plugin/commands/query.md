---
description: Look up a symbol, file or node id in the greplost map: definition, importers, callers, package, card path.
argument-hint: <symbol|path|node-id>
allowed-tools: Bash(greplost query:*), Bash(bunx greplost query:*)
---

Run `greplost query "$ARGUMENTS" --json` in the project root (if `greplost` is
not on PATH, run `bunx greplost query "$ARGUMENTS" --json` instead).

The argument may be a symbol name, a file path, or a **node id** of the form
`<file>#<kind>.<name>`: a Terraform resource, a Kubernetes object, a Helm
template document, a workflow job or step, a Dockerfile build stage or a
framework signal. Quote a node id, because it holds a `#`.

Read the result (see the `greplost` skill for the exact shape). If `matches`
is non-empty, report each match's name, kind, file:span, package, and, for a
single match, its `card` path, `importers` and `callers`. If the argument
resolved to an indexed file, also report the `file` block (exports, imports,
importers, fan-in/out, blast radius, loc). If it resolved to a node id, report
the `node` block as well: its kind, card, span, `meta`, and the `references` and
`referencedBy` edges, which are how a node reaches other nodes and files. If nothing matched, say so and
suggest `/greplost:update` in case the map is stale, or a plain Grep if the
target may not be a declaration at all.
