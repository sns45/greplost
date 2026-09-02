---
name: greplost
description: Use before exploring an unfamiliar repo, or when answering "where is X defined", "who imports/calls Y", "what breaks if I change Z", "what does this package do", or estimating the blast radius of a change, in any repo that has a .greplost/ directory. Prefer this over Glob/Grep for structural questions; grep is still right for content search.
---

# greplost: read the map before you grep

This repo (or the one you are currently in) may carry a `.greplost/` directory:
a structure map of the codebase rebuilt on every edit and kept byte-identical
to the source by `greplost verify`. It answers "where/who/what-breaks"
questions from a pre-built graph in one call, instead of several rounds of
Glob/Grep/Read.

## 1. Orient first

If `.greplost/INDEX.md` exists, read it before doing anything else. It is a
short (target ≤3,000 token) tour of the repo: main components, package
boundaries, and hotspots. `.greplost/repo/MAP.md` and each package's `MAP.md`
go one level deeper; a module card at the path the `card` field below names
documents a single file's exports, imports and blast radius in isolation.

If `.greplost/` does not exist, this repo has no map: fall back to Glob/Grep/Read
as usual, and mention that running `/greplost:init` would build one.

## 2. Answer structural questions from the CLI, not from grep

```
greplost query <symbol|path> --json    # definition, importers, callers, package, card
greplost impact <path> --json          # blast radius: what breaks if this file changes
greplost flows <pkg> --json            # request/data flow doc for a package, if refreshed
```

Run these with the Bash tool (fall back to `bunx greplost <cmd>` if `greplost`
is not on PATH). `--json` output is `stableStringify`d and stable across runs;
parse it rather than the human-readable columns.

### `query` shape

`greplost query <needle> --json` returns:

```ts
{
  query: string;
  matches: Array<{
    id: string; file: string; name: string; kind: string; signature: string;
    span: [number, number]; exported: boolean; package: string;
    card: string;          // .greplost-relative path to the module card, e.g.
                            // packages/tiny__core/modules/src/registry.ts.md
    importers: string[];   // files importing the declaring file and naming this symbol
    callers: string[];     // symbol ids that call this declaration
  }>;
  file?: {                 // present only when the argument named an indexed file
    path: string; package: string; card: string;
    exports: string[]; imports: string[]; importers: string[];
    fanIn: number; fanOut: number; blast: number; loc: number;
  };
}
```

A bare symbol name (`Registry`, `Registry.register`) searches declarations and
fills `matches`; a path (contains `/`, or an unambiguous filename suffix that
resolves to exactly one indexed file) also fills `file`. Exit code is 1 when
nothing matched and there is no `file` block, 0 otherwise; the JSON is printed
either way, so check `matches.length` / `file` rather than relying on the
process exit code inside a larger tool call.

### `impact` shape

`greplost impact <path> --json` returns `{ "path": string, "radius": number, "files": [{ "path": string, "depth": number }] }` — `radius` is the file's full reverse-import closure (never truncated, matches the module card's blast figure); `files` lists every dependent with its hop count and can be narrowed with `--depth <n>`.

### `verify` and `update` shapes (for `/greplost:verify` and `/greplost:update`)

```
verify --json: { ok: boolean, changed: string[], missing: string[], extra: string[], diff?: string }
update --json / init --json: { mode: "incremental" | "full", dirty: number, reparsed: number,
                                cached: number, written: number, deleted: number, ms: number, skipped?: string }
```

`update --semantic --json` returns both results in one envelope, never two
documents: `{ "update": <the object above>, "refresh": <RefreshResult> }`. The
`refresh` key is absent when the refresh itself failed (its reason is on stderr
and the exit code is 1); the `update` half is always there, because the map was
already rebuilt by then.

### In a workspace (a directory holding `greplost.workspace.json`)

`update`, `verify`, `query` and `impact` run across every listed repo when
invoked at the workspace root. Ids are then `<repo>::<path>` — the repo's
directory name, `::`, then the path inside that repo — everywhere a path or a
symbol id appears: `impact --json`'s `path` and `files[*].path`, and `query
--json`'s `file.path`, `file.card`, `matches[*].id`, `matches[*].file`,
`matches[*].card`, `importers[*]` and `callers[*]`. So a `card` reads
`repo-a::packages/tiny__core/modules/src/registry.ts.md`: the part after `::`
is relative to *that repo's* `.greplost/`.

As an argument, `query` and `impact` accept the id (`repo-a::src/index.ts`), the
workspace-relative path (`repo-a/src/index.ts`) and an absolute path; only an
indexed file resolves, and nothing is guessed.

## 3. When to fall back to grep instead

- Searching for a literal string, comment, TODO, log message, or anything
  inside a string/text asset rather than a declaration or import edge.
- Files outside the languages greplost indexes (check `.greplost/manifest.json`
  or the INDEX for the tracked languages).
- `.greplost/` is missing, or `greplost verify` reports drift and you need the
  current on-disk truth rather than the (possibly stale) map.
- Conceptual questions the map does not encode ("where is the billing logic
  discussed", domain terminology) — the map is structural, not semantic,
  unless `greplost refresh` has populated FLOWS.md for the package in question.

## 4. About the hooks

Four hooks, and only two of them say anything:

- `SessionStart` injects a one-line pointer to `.greplost/INDEX.md` as
  `additionalContext`, when a map exists.
- `PreToolUse` on Glob/Grep injects the same reminder, again as
  `additionalContext`, when a map exists.
- `PostToolUse` on Edit/Write/MultiEdit appends the edited path to
  `.greplost/.dirty` and prints nothing. It needs only a `.greplost/` directory,
  not a built map, so an edit is recorded even before the first build; that
  queue is what makes the next update incremental rather than a rebuild.
- `Stop` runs a silent incremental update (`greplost update --incremental
  --quiet`) over that queue, when a map exists. It injects no context.

So the map you read later in a session already includes the edits made earlier
in it, without anyone running a command. greplost's hooks never emit a
permission decision: `PreToolUse` only adds context, so tool calls are neither
blocked nor auto-approved and your own permission prompt for Glob/Grep is
untouched. A hook that fails logs to stderr and exits 0 — it can never break the
session, and it can never be the reason a tool call did not run. If you see that
injected context, it is this same guidance surfacing without being asked; follow
it rather than waiting for a hook to act on your behalf.
