/**
 * Public surface of `@greplost/sync`.
 *
 * The build-verify half (leaf 1.3.1): what the structure layer owns under
 * `.greplost/`, how a checkout becomes that map, how the map reaches disk
 * without churn, and how CI proves the two agree. The incremental half
 * (`update`, `init`, the lock, the dirty file, the git hooks and the parse
 * cache) is appended below it: the update loop, the state it keeps between
 * runs, the advisory lock that lets hooks and humans fire at once, the dirty
 * queue the editor hooks write to, the on-disk parse cache, and the two
 * commands (`init`, `update`) the CLI and the plugin drive everything through.
 */

export { STRUCTURE_GLOBS, isStructurePath, listStructurePaths } from "./artifacts.ts";

export { buildArtifacts, readSummaries } from "./build.ts";
export type { BuildArtifactsOptions, BuildResult } from "./build.ts";

export { writeArtifacts } from "./write.ts";
export type { WriteResult } from "./write.ts";

export { unifiedDiff, verify } from "./verify.ts";
export type { VerifyOptions, VerifyResult } from "./verify.ts";

export { appendDirty, readAndClearDirty } from "./dirty.ts";

export { HOOK_MARKER, HOOK_NAMES, installGitHooks } from "./githooks.ts";
export type { HookInstallResult } from "./githooks.ts";

export { update } from "./incremental.ts";
export type { UpdateOptions, UpdateResult } from "./incremental.ts";

export { init } from "./init.ts";
export type { InitOptions, InitResult } from "./init.ts";

export { LOCK_STALE_MS, isLocked, withLock } from "./lock.ts";
export type { LockInfo } from "./lock.ts";

export { FileParseCache, PARSE_CACHE_PATH, parseCacheKey } from "./parse-cache.ts";

export { readState, writeState } from "./state.ts";
export type { SyncState } from "./state.ts";
