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
greplost query <directory> --json      # every mapped file under it, with its figures
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
  status: "found" | "absent" | "excluded" | "stale";
  matches: Array<{
    id: string; file: string; name: string; kind: string; signature: string;
    span: [number, number]; exported: boolean; package: string;
    card: string;          // repo-relative path to the module card, e.g.
                            // .greplost/packages/tiny__core/modules/src/registry.ts.md
    importers: string[];   // files importing the declaring file and naming this symbol
    callers: string[];     // symbol ids that call this declaration
  }>;
  file?: {                 // present only when the argument named an indexed file
    path: string; package: string; card: string;
    exports: string[]; imports: string[]; importers: string[];
    fanIn: number; fanOut: number; blast: number; loc: number;
  };
  directory?: {            // present only when the argument named a directory
    path: string;
    files: Array<{ path: string; loc: number; exports: number;
                   fanIn: number; fanOut: number }>;
  };
  excludedBy?: string;     // the exclude pattern, when status is "excluded"
  message?: string;        // one line explaining any status that is not "found"
  suggestions?: string[];  // up to 5 nearest ids, present only when nothing matched
}
```

A bare symbol name (`Registry`, `Registry.register`) searches declarations and
fills `matches`; a path (contains `/`, or an unambiguous filename suffix that
resolves to exactly one indexed file) also fills `file`; a directory the map
holds files under fills `directory`. Exit code is 1 when nothing matched, 0
otherwise; the JSON is printed either way, so check `status` rather than relying
on the process exit code inside a larger tool call.

**Read `status` before you conclude anything from an empty answer.** It is
`found` when the map answered and the file on disk still hashes to what the map
read; `absent` when nothing matches and no such path exists (a typo: read
`suggestions`); `excluded` when the path is on disk and the config keeps it out
(`excludedBy` names the pattern, and `message` names the config line to edit,
which is how the default test exclusions show up); `stale` when the path is on
disk and the map does not describe it, or no longer describes these bytes. Only
`stale` is fixed by `greplost update`; running one for the other three wastes a
turn. A `stale` answer that still carries `matches` or `file` is a real answer
built from bytes that have since changed.

`--brief` is a text-mode flag only; it never changes the JSON.

### Node ids: the things inside a file

A Terraform resource, a Kubernetes object, a Helm template document, a workflow
job or step, a Dockerfile build stage and a framework signal (a React component,
a route, a Pulumi resource) are nodes in the map, with the id
`<file>#<kind>.<name>` (a duplicate name inside one file takes a `~<n>` suffix on
the id only). `query` and `impact` take one wherever they take a path:

```
greplost query 'main.tf#resource.aws_vpc.this' --json
greplost impact '.github/workflows/ci.yml#job.test' --json
```

For an exact node id, `query --json` adds a `node` block next to `matches`:
`{ id, file, kind, name, package, card, span, blast, meta, references,
referencedBy }`, where `references` and `referencedBy` are the reference edges
(`hcl-ref`, `selector`, `config-ref`, `needs`, `uses`, `from-image`, `copy-from`,
`helm-values`, `config`, `resource-input`, `route-handler`) that link nodes to
each other and to files. No artifact path ever contains a `#`, so a node's card
does not live at its id: read the path out of the answer's `card` field, which
is repo-relative and already slugged
(`.greplost/packages/<slug>/modules/<file>/<kind>.<name>.md`, with a duplicate
name's `~<n>` suffix written `-<n>`).

### `impact` shape

`impact` answers two different questions and returns two different shapes,
decided by whether the argument is a file or a node id. Read `radius` from
whichever one came back; check for the `files` key to tell them apart.

A **file** target returns
`{ "path": string, "radius": number, "returned": number, "truncated": boolean,
"files": [{ "path": string, "depth": number }] }`.
`radius` is the file's full reverse-import closure over import and re-export
edges, read from the manifest, so it is the same number the module card prints;
`files` lists every dependent with its hop count and can be narrowed with
`--depth <n>`, which truncates the listing and never the radius. `returned` is
the length of that listing and `truncated` says whether `--depth` kept anything
out of it, so `"radius": 129` beside 16 listed files needs no interpretation:
129 files are reachable, 16 of them within the depth asked for.

A **node id** target returns
`{ "path": string, "radius": number, "returned": number, "truncated": boolean,
"nodes": [{ "id": string, "depth": number }] }`
, the same fields with `nodes` in place of `files`. That radius counts
**nodes** and is computed over import, re-export **and reference** edges
together, because a node has no manifest entry to read one from. The two radii
are not comparable: a Terraform variable forty resources read has a large node
radius while its file's radius may be zero, and both numbers are right.

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
invoked at the workspace root. Ids are then `<repo>::<path>`, the repo's
directory name, `::`, then the path inside that repo, everywhere a path or a
symbol id appears: `impact --json`'s `path` and `files[*].path`, and `query
--json`'s `file.path`, `file.card`, `matches[*].id`, `matches[*].file`,
`matches[*].card`, `importers[*]` and `callers[*]`. So a `card` reads
`repo-a::packages/tiny__core/modules/src/registry.ts.md`: the part after `::`
is relative to *that repo's* `.greplost/`, and unlike the single-repo shape it
does not carry the `.greplost/` prefix, because the repo directory does.

As an argument, `query` and `impact` accept the id (`repo-a::src/index.ts`), the
workspace-relative path (`repo-a/src/index.ts`) and an absolute path; only an
indexed file resolves, and nothing is guessed.

A workspace answer carries the same new fields: `status` on `query`, `returned`
and `truncated` on `impact`. The one narrowing is that a workspace `query` never
reports `excluded`, because its argument names an id or an indexed file rather
than an arbitrary path on disk; `found`, `absent` and `stale` all occur, and
`stale` is per repo, since each repo's map is committed separately.

## 3. When to fall back to grep instead

- Searching for a literal string, comment, TODO, log message, or anything
  inside a string/text asset rather than a declaration or import edge.
- Files outside the languages greplost indexes (check `.greplost/manifest.json`
  or the INDEX for the tracked languages).
- `.greplost/` is missing, or `greplost verify` reports drift and you need the
  current on-disk truth rather than the (possibly stale) map.
- Conceptual questions the map does not encode ("where is the billing logic
  discussed", domain terminology): the map is structural, not semantic,
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
untouched. A hook that fails logs to stderr and exits 0: it can never break the
session, and it can never be the reason a tool call did not run. If you see that
injected context, it is this same guidance surfacing without being asked; follow
it rather than waiting for a hook to act on your behalf.
