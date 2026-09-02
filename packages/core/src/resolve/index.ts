/**
 * Resolve layer: package detection, tsconfig paths, and specifier resolution.
 * Everything downstream (graph linking, build) goes through these four entry points.
 */

export { detectPackages, packageOf } from "./packages.ts";
export { loadTsconfigPaths } from "./tsconfig.ts";
export type { TsPaths } from "./tsconfig.ts";
export { createResolver } from "./resolver.ts";
export type { RepoContext, ResolvedTarget, Resolver } from "./resolver.ts";
