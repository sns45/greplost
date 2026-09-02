# greplost (Claude Code plugin)

grep lost. Read the map.

Wires the `greplost` CLI into a Claude Code session: hooks that keep
`.greplost/` (the committed structure map) current and point agents at it, a
skill documenting `query`/`impact --json`, six `/greplost:*` slash commands,
and a read-only `greplost-navigator` subagent.

See [`docs/greplost-tech-spec.md`](../docs/greplost-tech-spec.md) sections 7.1
and 9 for the design this plugin implements, and the `greplost` package
itself for the CLI (`packages/cli`).

## What it adds

| Component | Effect |
|---|---|
| `hooks/hooks.json` | `SessionStart` and `PreToolUse` (Glob/Grep) inject an `additionalContext` reminder to read `.greplost/INDEX.md` when a map exists; `PostToolUse` (Edit/Write/MultiEdit) records the changed path so the next update is incremental; `Stop` runs `greplost update --incremental --quiet`. All four are advisory or best-effort: none of them can block a tool call or fail the session — a hook that errors logs to stderr and exits 0. |
| `skills/greplost/SKILL.md` | Tells Claude to read the map before grepping and documents the exact `--json` shapes for `query`, `impact`, `verify`, `update`/`init`. |
| `commands/*.md` | `/greplost:init`, `/greplost:update`, `/greplost:query <needle>`, `/greplost:impact <path>`, `/greplost:refresh [pkg]`, `/greplost:verify` — each runs the matching CLI command and reports the result. |
| `agents/greplost-navigator.md` | A read-only subagent (`Read`, `Grep`, `Glob`, `Bash`) scoped to answering structural questions from the map and citing card paths; it has no `Write`/`Edit`/`MultiEdit` tool. |

## Requirements

The `greplost` binary on `PATH` (`bunx greplost` also works and is the
fallback every hook and command uses automatically), and a repo that has run
`greplost init` at least once — the plugin is a no-op reminder in any repo
without a `.greplost/` directory; it never creates one on its own except
through `/greplost:init`, which you invoke explicitly.

## Install

### Local development / trying it out

From anywhere, pointing at a checkout of this repo:

```sh
claude --plugin-dir /path/to/greplost/greplost-plugin
```

Or from inside this repo:

```sh
claude --plugin-dir ./greplost-plugin
```

`/reload-plugins` picks up edits to the plugin without restarting the
session.

### Once published

`claude --plugin-dir` is a session-local dev flag, not an install. `greplost`
lives in a subdirectory of this monorepo, not at the repo root, so the
`owner/repo` GitHub shorthand (`sns45/greplost`) clones the whole repo as the
marketplace source: making the plugin installable this way needs a
`.claude-plugin/marketplace.json` at the **monorepo root** (not inside
`greplost-plugin/`) with an entry pointing `source` at `"./greplost-plugin"`.
That file is not part of this plugin's own directory — it is a separate,
repo-root deliverable this leaf does not own. Once it exists, install with:

```sh
/plugin marketplace add sns45/greplost
/plugin install greplost@greplost
```

(`claude plugin marketplace add sns45/greplost` and
`claude plugin install greplost@greplost` work the same way outside an
interactive session.) There is currently no single-command shorthand that
skips the marketplace step for a plugin living in a subdirectory of a larger
repo.

## Try the six commands

```
/greplost:init
/greplost:query Registry
/greplost:impact packages/core/src/registry.ts
/greplost:verify
/greplost:update
/greplost:refresh
```

Or delegate an orientation question to the navigator: "use the
greplost-navigator agent to explain what packages/core does and what depends
on it."

## Uninstall / disable

```
claude plugin uninstall greplost@greplost
```

or, for a `--plugin-dir` session, just drop the flag on the next launch.
