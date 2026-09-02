# Sub-project spec: plugin-cli

Implements tech spec sections 7.1 and 9. Packages: `packages/cli` (published as `greplost`) and `greplost-plugin/` (Claude Code plugin at the repo root).

## Modules and ownership

| Leaf | Files |
|---|---|
| 1.4.1 cli | `packages/cli/src/main.ts`, `src/args.ts`, `src/output.ts`, `src/commands/{init,update,verify,query,impact,flows,refresh,bench,screenshots,hook,version}.ts`, `src/index.ts`, `packages/cli/test/*.test.ts` |
| 1.4.2 plugin | `greplost-plugin/.claude-plugin/plugin.json`, `greplost-plugin/hooks/hooks.json`, `greplost-plugin/skills/greplost/SKILL.md`, `greplost-plugin/commands/{init,update,query,impact,refresh,verify}.md`, `greplost-plugin/agents/greplost-navigator.md`, `greplost-plugin/README.md` |

`packages/cli/package.json` and `bin/greplost.js` already exist (driver-owned); the build script bundles `src/main.ts` for node and copies grammars to `dist/grammars`. `main.ts` must set `GREPLOST_GRAMMAR_DIR` from `dist/grammars` when running from a bundle (detect via `import.meta.url` containing `/dist/`) and leave it alone otherwise.

## CLI contract

```
greplost init [--no-hooks]                           build + install git hooks + write config
greplost update [--incremental|--full] [--files <p>...] [--quiet]     default: incremental
greplost verify [--diff]                             exit 1 on drift
greplost query <symbol|path> [--json]
greplost impact <path> [--json] [--depth <n>]
greplost flows <pkg>                                 print packages/<slug>/FLOWS.md (or a hint to run refresh)
greplost refresh [pkg] [--model <m>] [--dry-run]     semantic layer (delegates to @greplost/semantic)
greplost bench <suite> [args...]                     delegates to bench/src/cli.ts when run inside the greplost repo; otherwise exit 2 with a message
greplost screenshots                                 delegates to bench/src/cli.ts screenshots
greplost hook <session-start|pre-tool-use|post-tool-use|stop>    reads Claude Code hook JSON on stdin (plugin use)
greplost --version | --help
```

Exit codes: 0 success, 1 drift or failed gate or not found, 2 usage error. `main(argv): Promise<number>` is exported and never calls `process.exit` itself (bin does). Every command accepts `--root <dir>` (default: nearest ancestor of cwd containing `.greplost/`, else cwd) and `--json`.

Human output is short and column aligned; `--json` output is `stableStringify(value, 2)` on stdout and nothing else. Errors go to stderr as `greplost: <message>`.

### `--json` shapes (stable, documented in the SKILL)

```ts
// query
{ query: string; matches: Array<{ id: string; file: string; name: string; kind: DeclKind; signature: string; span: [number, number]; exported: boolean; package: string; card: string /* .greplost-relative */; importers: string[] /* files importing the declaring file and naming the symbol, or the file when `*` */; callers: string[] /* symbol ids */ }>;
  file?: { path: string; package: string; card: string; exports: string[]; imports: string[]; importers: string[]; fanIn: number; fanOut: number; blast: number; loc: number } }
// impact
{ path: string; radius: number; files: Array<{ path: string; depth: number }> }
// verify
{ ok: boolean; changed: string[]; missing: string[]; extra: string[]; diff?: string }
// update / init
{ mode: "incremental" | "full"; dirty: number; reparsed: number; cached: number; written: number; deleted: number; ms: number; skipped?: string }
```

`query` reads `.greplost/graph/*.jsonl` and `manifest.json` through `readStructure` and answers from `findSymbols`, `importersOf`, `callersOf` (core); it never parses source. A path argument (contains `/` or ends with a known extension and exists in the manifest) returns the `file` block; otherwise `matches` (empty → exit 1). `impact` uses `impactOf` over import + reexport edges; `--depth` truncates.

### `hook` subcommand (plugin transport)

Reads the hook payload JSON from stdin (fields per the Claude Code hooks reference: `hook_event_name`, `cwd`, `tool_name`, `tool_input`) and prints JSON to stdout:

- `session-start`: when `<cwd>/.greplost/INDEX.md` exists print `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"This repo has a greplost map: read .greplost/INDEX.md before exploring; use `greplost query`/`impact --json`."}}`, else print nothing.
- `pre-tool-use` (Glob, Grep): when the map exists print `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"greplost: consult .greplost/INDEX.md or `greplost query <symbol> --json` before grepping."}}`. Never blocks.
- `post-tool-use` (Edit, Write, MultiEdit): `appendDirty(root, [tool_input.file_path])` for paths inside the repo; prints nothing.
- `stop`: runs `update({ mode: "incremental", quiet: true })` when the map exists; prints nothing; always exits 0 (a failed update must never block the session; log to stderr).

The implementer verifies the exact output field names against the current Claude Code hooks reference (`claude-code-guide` agent or docs) and records the version consulted in the report; the JSON above is the expected shape as of Claude Code 2.1.

## Plugin

- `plugin.json`: `{ "name": "greplost", "version": "0.0.1", "description": "grep lost. Read the map.", "author": { "name": "Shantanu", "url": "https://github.com/sns45" }, "repository": "https://github.com/sns45/greplost", "keywords": [...] }` plus the hooks/skills/commands/agents paths if the schema requires them (check the plugin reference).
- `hooks.json` events per tech spec 7.1, each `command` = `greplost hook <event>` with a 10 s timeout for Stop and 5 s for the rest; the command falls back to `bunx greplost` when `greplost` is not on PATH (`sh -c 'command -v greplost >/dev/null && greplost hook stop || bunx greplost hook stop'`).
- `SKILL.md` (frontmatter `name: greplost`, `description:` triggers on any codebase-orientation question): tells the agent to read INDEX.md first, then use `greplost query --json` and `impact --json`, documents the JSON shapes above, and lists when to fall back to grep (content search, not structure).
- Commands: `/greplost:init`, `/greplost:update`, `/greplost:query <needle>`, `/greplost:impact <path>`, `/greplost:refresh [pkg]`, `/greplost:verify`, each a short markdown prompt that runs the CLI via Bash and reports the result.
- `agents/greplost-navigator.md`: read-only subagent (tools: Read, Bash limited to `greplost` commands, Glob, Grep) that answers structural questions from the map and cites card paths.

## Tests

- `args.test.ts`: parsing of every command, unknown flag → usage error exit 2, `--json` and `--root` on all commands.
- `commands.test.ts`: on a temp copy of `fixtures/tiny-ts`: `init --no-hooks` creates the map; `verify` exit 0; `query Registry --json` matches the documented shape (assert keys and that `matches[0].file === "packages/core/src/registry.ts"`); `query packages/core/src/retry.ts --json` returns the `file` block with `importers` containing `packages/core/src/registry.ts`; `impact packages/core/src/retry.ts --json` lists `packages/adapters/src/sqs.ts` at depth 2 (via `@tiny/core` index) and `radius` equals the manifest `blast`; edit a file → `verify` exit 1 and `--diff` text starts with `--- a/.greplost/`; `update` → exit 0.
- `hook.test.ts`: each hook event with a synthetic stdin payload produces the documented stdout (or nothing) and exit 0, including when the map is absent.
- Plugin leaf gate: `claude --plugin-dir ./greplost-plugin -p "say ok" --allowedTools ""` exits 0 with the plugin loaded (check `claude plugin validate ./greplost-plugin` if available) and a hooks debug run (`claude --debug hooks` or the documented equivalent) shows the SessionStart, PreToolUse and Stop hooks firing in `fixtures/tiny-ts` after `greplost init`. The implementer records the exact commands used.
