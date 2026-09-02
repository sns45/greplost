/**
 * Public surface of `@greplost/core`.
 *
 * Everything the render, sync, CLI, semantic and workspace packages need is
 * re-exported here; `@greplost/core/schema` stays available as the narrow
 * type-only entry point that wave-1 leaves built against.
 *
 * `resolve/` owns the shared `Resolver`/`ResolvedTarget` names: `graph/link.ts`
 * declares structurally identical ones for its own independence, and
 * `graph/index.ts` deliberately does not re-export them, so this file has no
 * ambiguous star.
 */

export * from "./schema.ts";

export * from "./config.ts";
export * from "./discover.ts";
export * from "./hash.ts";
export * from "./parser.ts";
export * from "./unparsable.ts";

export * from "./extract/index.ts";
export * from "./resolve/index.ts";
export * from "./graph/index.ts";
export * from "./graph/query.ts";
export * from "./serialize/index.ts";

export * from "./build.ts";
