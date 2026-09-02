/**
 * Public surface of `@greplost/sync`.
 *
 * The build-verify half (leaf 1.3.1): what the structure layer owns under
 * `.greplost/`, how a checkout becomes that map, how the map reaches disk
 * without churn, and how CI proves the two agree. The incremental half
 * (`update`, `init`, the lock, the dirty file, the git hooks and the parse
 * cache) appends its re-exports here.
 */

export { STRUCTURE_GLOBS, isStructurePath, listStructurePaths } from "./artifacts.ts";

export { buildArtifacts, readSummaries } from "./build.ts";
export type { BuildArtifactsOptions, BuildResult } from "./build.ts";

export { writeArtifacts } from "./write.ts";
export type { WriteResult } from "./write.ts";

export { unifiedDiff, verify } from "./verify.ts";
export type { VerifyOptions, VerifyResult } from "./verify.ts";
