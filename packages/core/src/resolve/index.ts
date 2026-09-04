/**
 * Resolve layer: package detection, tsconfig paths, and specifier resolution.
 * Everything downstream (graph linking, build) goes through these four entry points.
 *
 * Schema 2 adds one module per language behind `createResolver`'s dispatch table; they are
 * re-exported here so a leaf that replaces one can be reached without importing a deep path.
 */

export { detectPackages, packageOf } from "./packages.ts";
export { loadTsconfigPaths } from "./tsconfig.ts";
export type { TsPaths } from "./tsconfig.ts";
export { createResolver } from "./resolver.ts";
export type { RepoContext, ResolvedTarget, Resolver } from "./resolver.ts";

export { createDockerfileResolver, resolveDockerfileCall } from "./dockerfile.ts";
export { createHclResolver, resolveHclCall } from "./hcl.ts";
export { createJavaResolver, resolveJavaCall } from "./java.ts";
export { createKotlinResolver, resolveKotlinCall } from "./kotlin.ts";
export { createPythonResolver, resolvePythonCall } from "./python.ts";
export { createRustResolver, resolveRustCall } from "./rust.ts";
export { createYamlResolver, resolveYamlCall } from "./yaml.ts";
