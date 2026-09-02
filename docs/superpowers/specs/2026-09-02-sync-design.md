# Sub-project spec: sync

Implements tech spec sections 7.2 to 7.4 and 8. Package: `packages/sync` (`@greplost/sync`).
Depends on `@greplost/core` (`buildSnapshot`, `serializeSnapshot`, `readStructure`) and `@greplost/render` (`renderArtifacts`).

## Modules and ownership

| Leaf | Files | Exports |
|---|---|---|
| 1.3.1 build-verify | `src/artifacts.ts`, `src/build.ts`, `src/write.ts`, `src/verify.ts`, `src/index.ts` | `STRUCTURE_GLOBS`, `isStructurePath`, `listStructurePaths`, `buildArtifacts`, `writeArtifacts`, `verify`, `readSummaries`, `unifiedDiff` |
| 1.3.2 incremental | `src/incremental.ts`, `src/state.ts`, `src/lock.ts`, `src/dirty.ts`, `src/githooks.ts`, `src/parse-cache.ts`, `src/init.ts` | `update`, `init`, `readState`, `writeState`, `withLock`, `appendDirty`, `readAndClearDirty`, `installGitHooks`, `FileParseCache` |

`src/index.ts` is written by 1.3.1 re-exporting only its own modules; leaf 1.3.2 (a later wave) appends re-exports for its modules. Ownership of `src/index.ts` transfers to 1.3.2 when it starts.

## Interfaces

```ts
// artifacts.ts
export function isStructurePath(rel: string): boolean;   // true for INDEX.md, manifest.json, graph/*.jsonl, repo/*.md, packages/*/MAP.md, packages/*/API.md, packages/*/modules/**/*.md; false for config.json, cache/**, packages/*/FLOWS.md, WORKSPACE.md, .dirty, .lock, .state.json, .gitignore
// build.ts
export interface BuildArtifactsOptions { config?: GreplostConfig; parser?: ParserHandle; cache?: ParseCache; }
export interface BuildResult { snapshot: Snapshot; files: Map<string, string>; }   // files = serializeSnapshot ∪ renderArtifacts, all structure paths
export function readSummaries(root: string): SummaryCache;                          // {} when cache/summaries.json is absent
export async function buildArtifacts(root: string, opts?: BuildArtifactsOptions): Promise<BuildResult>;
// write.ts
export interface WriteResult { written: string[]; deleted: string[]; unchanged: number; }
export function writeArtifacts(root: string, files: Map<string, string>): WriteResult;   // writes only when bytes differ; deletes structure paths on disk that are not in `files`; never touches non-structure paths; creates directories
// verify.ts
export interface VerifyResult { ok: boolean; changed: string[]; missing: string[]; extra: string[]; diff?: string; }
export async function verify(root: string, opts?: { diff?: boolean } & BuildArtifactsOptions): Promise<VerifyResult>;   // in-memory build vs disk, byte comparison; `diff` = unified diff of the first divergent file (sorted by path), at most 200 lines
// incremental.ts
export interface UpdateOptions { mode: "incremental" | "full"; files?: string[]; quiet?: boolean; }
export interface UpdateResult { mode: "incremental" | "full"; dirty: number; reparsed: number; cached: number; written: number; deleted: number; ms: number; skipped?: "locked" | "clean"; }
export async function update(root: string, opts: UpdateOptions): Promise<UpdateResult>;
// init.ts
export interface InitResult { created: string[]; update: UpdateResult; hooks: string[]; }
export async function init(root: string, opts?: { hooks?: boolean }): Promise<InitResult>;   // writes .greplost/config.json (DEFAULT_CONFIG) when absent, .greplost/.gitignore, full update, git hooks
// state.ts
export interface SyncState { lastIndexedCommit?: string; }
export function readState(root: string): SyncState;  export function writeState(root: string, state: SyncState): void;   // .greplost/.state.json
// lock.ts
export async function withLock<T>(root: string, fn: () => Promise<T>): Promise<T | undefined>;   // undefined when another live holder exists
export function isLocked(root: string): boolean;
// dirty.ts
export function appendDirty(root: string, paths: string[]): void;   // O(1) append, one path per line
export function readAndClearDirty(root: string): string[];            // unique, sorted, repo-relative
// parse-cache.ts
export class FileParseCache implements ParseCache { constructor(root: string); load(): void; save(): void; }   // .greplost/cache/parse.json, { [`${lang}:${sha256}`]: FileRecord }; gitignored; get(sha256, lang); records are immutable (never mutate what the cache returns)
// githooks.ts
export interface HookInstallResult { installed: string[]; mode: "husky" | "plain" | "none"; notes: string[]; }
export function installGitHooks(root: string): HookInstallResult;
export const HOOK_MARKER = "# greplost-hook";
```

## Rules

**Build.** `buildArtifacts` = `buildSnapshot({ root, config, parser, cache, summaries: readSummaries(root) })`, then `serializeSnapshot` merged with `renderArtifacts`. Keys are artifact-relative paths; all satisfy `isStructurePath`.

**Write.** Compare bytes before writing so unchanged files keep their mtime (git stays quiet). Containment is checked on real paths: every directory segment under `.greplost/` is walked with `lstat` (a symlink segment is replaced by a real directory) and the parent's `realpath` must lie inside the artifact root's `realpath` before any write or delete; a directory squatting an artifact path is removed only when empty or when it contains nothing but structure paths (ruling 2026-09-03). A regular file that blocks a directory segment is refused (`greplost: refusing to delete .greplost/<p>: not a greplost artifact`), never deleted; a symlinked `.greplost` root is allowed and its target becomes the containment boundary, so a committed symlink pointing outside the repo would let an unattended `update` manage files there (documented risk). Hard-linked artifacts are replaced (unlink then write), never written through. A failed write is retried after removing the target only for `EACCES`/`EPERM`/`EISDIR`/`ENOTDIR`; other errors propagate with the artifact intact. Prune: any file on disk under `.greplost/` for which `isStructurePath` is true and which is absent from the map is deleted (e.g. the card of a removed file); empty directories are removed. Never write outside `.greplost/`.

**Verify.** Build in memory with the committed `cache/summaries.json`, compare against disk for every structure path in either set: `changed` (both exist, bytes differ), `missing` (expected, not on disk), `extra` (on disk, not expected). `ok` iff all three are empty. With `diff`, produce a unified diff (`--- a/.greplost/<p>`, `+++ b/.greplost/<p>`, 3 lines of context) of the first path in `changed` (or the first `missing`/`extra` listed as whole-file added/removed), capped at 200 lines including a trailing `… truncated` line (199 body lines plus the marker; ruling 2026-09-03).

**Update (incremental).**
1. `withLock`. If locked → `{ skipped: "locked" }` and nothing else.
2. Dirty set = `readAndClearDirty` ∪ `opts.files` ∪ (git available: `git diff --name-only <lastIndexedCommit>..HEAD` when `lastIndexedCommit` is set and still exists, plus `git status --porcelain` paths). Files that no longer exist are still "dirty" (their cards get pruned).
3. Fast path: dirty set empty, `lastIndexedCommit === HEAD`, and `git status --porcelain` empty → `{ skipped: "clean" }` after re-acquiring nothing (still inside the lock).
4. Load `FileParseCache`, run `buildArtifacts` with it (unchanged files hit the cache by sha256; `reparsed` counts misses, `cached` counts hits), save the cache (pruning entries whose sha256 is not in the current manifest), `writeArtifacts`, `writeState({ lastIndexedCommit: HEAD })`.
5. `mode: "full"` skips steps 2 and 3, ignores the parse cache for reads (still saves it), and otherwise does the same. Full and incremental produce byte-identical `.greplost/` by construction: both render the whole map in memory and write only differing bytes. The tech spec's "regenerate only dependent artifacts" is satisfied at the write layer; parse work is the only thing skipped.
6. `ms` is measured wall-clock; `quiet` suppresses console output.

**Lock.** `.greplost/.lock` holds `{"pid":<n>,"ts":<epoch ms>}`. A lock is stale when the pid is not alive (`process.kill(pid, 0)` throws `ESRCH`) or `ts` is older than 60 s; stale locks are reclaimed. Written with `wx` flag for atomic creation; removed in `finally`.

**Dirty file.** `.greplost/.dirty`, one path per line, appended with `appendFileSync`. Paths are normalised to repo-relative posix form; absolute paths outside the repo are ignored.

**Init.** Creates `.greplost/config.json` from `DEFAULT_CONFIG` (2-space stable JSON) if absent, `.greplost/.gitignore` containing `.dirty`, `.lock`, `.state.json`, `cache/parse.json`; runs `update({ mode: "full" })`; installs git hooks unless `hooks === false`.

**Git hooks.** For `post-commit`, `post-merge`, `post-checkout`: if `.husky/` exists, append the block to `.husky/<hook>` (creating it, executable); else write or append to `.git/hooks/<hook>` (creating with a `#!/bin/sh` shebang, executable). The block is idempotent (skip when `HOOK_MARKER` present) and detached:

```sh
# greplost-hook
if command -v greplost >/dev/null 2>&1; then GL="greplost"; elif command -v bunx >/dev/null 2>&1; then GL="bunx greplost"; else GL=""; fi
[ -n "$GL" ] && ( $GL update --incremental --quiet >/dev/null 2>&1 & )
# end greplost-hook
```

When `lefthook.yml` exists, still install plain hooks and add a note recommending a `lefthook` entry. Not a git repo → `mode: "none"`, no files touched.

## Tests

- `build.test.ts`: `buildArtifacts` on `fixtures/tiny-ts` yields exactly the union of core golden files and render golden files (byte-equal, path sets equal); `isStructurePath` table test.
- `verify.test.ts`: copy the fixture to a temp dir, `init` (hooks off), `verify` → ok; edit one source file (add an import) → `verify` fails with that file's card in `changed` and `diff` starting with `--- a/.greplost/`; `update` → ok again; delete a source file → `verify` reports `extra` for its card; add a stray structure file → `extra`; a stray `cache/foo.json` is ignored.
- `incremental.test.ts` (temp copy with `git init`, one commit): `update incremental` then `update full` into a second temp copy → `.greplost/` trees byte-identical (`diff -r` semantics implemented in the test); second incremental run reports `skipped: "clean"`; after editing a file: `reparsed: 1`, `cached: 11`; parse cache round-trips; `.dirty` is consumed and cleared; commit + `lastIndexedCommit` matches `git rev-parse HEAD`.
- `lock.test.ts`: live lock blocks (`withLock` returns undefined), stale pid is reclaimed, lock removed after the callback throws.
- `githooks.test.ts`: plain install creates three executable hooks with the marker; second install is a no-op; husky directory is preferred; not a git repo → none.
