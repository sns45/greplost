/**
 * Terraform (HCL) resolution (build 2, spec 2026-09-04 section 2.2, "Resolution").
 *
 * One job: turn a `module` block's `source` into a target id. Terraform loads *every* `.tf`
 * file in a directory as one module, so a local source (`./x`, `../x`) names a **directory**,
 * exactly as a Go import names a package directory (tech spec Appendix C) and for the same
 * reason: there is no single file to point at. Everything else — a registry address, a git
 * URL, an archive — is outside the repo and becomes `ext:module/<source>`, namespaced so it can
 * never collide with an npm or Go package id (spec section 0.2).
 *
 * A local source naming a directory that holds no indexed `.tf` file is **unresolved**, not
 * external: it is a repo path the map simply does not cover, and calling it external would
 * invent a dependency on a registry module that does not exist.
 *
 * HCL has no calls, so `resolveHclCall` exists only to keep the shape of the language pipeline
 * uniform (spec section 0.4). `extractHcl` never produces a `CallSite`, so it is unreachable,
 * and it says so rather than pretending to resolve something.
 */

import type { CallSite, Confidence, FileRecord } from "../schema.ts";
import type { RepoContext, ResolvedTarget } from "./resolver.ts";

/** The repo-root directory id. A module source of `../..` from `a/b/` resolves here. */
export const HCL_ROOT_DIR_ID = ".";

/** The `ext:` namespace a module source outside the repo lands in (spec section 0.2). */
export const HCL_MODULE_NAMESPACE = "module/";

/** The `ext:` namespace a provider requirement lands in (spec section 0.2). */
export const HCL_PROVIDER_NAMESPACE = "provider/";

/** Extension of a file Terraform loads as part of a module. */
const MODULE_FILE_SUFFIX = ".tf";

const UNRESOLVED: ResolvedTarget = { type: "unresolved" };

/** Placeholder for the per-language call index; HCL has no calls, so it holds nothing. */
export type HclCallIndex = Readonly<Record<string, never>>;

/** Directory of a repo-relative path; `"."` for a file at the repo root. */
export function hclDirectoryOf(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index === -1 ? HCL_ROOT_DIR_ID : filePath.slice(0, index);
}

/**
 * A module source Terraform reads from the local filesystem.
 *
 * Terraform's own rule (module source types): a source is local exactly when it begins with
 * `./` or `../`. Everything else — including a bare `foo/bar/baz`, which is a *registry*
 * address and not a path — is fetched from somewhere outside this repo.
 */
export function isLocalModuleSource(source: string): boolean {
  return /^\.\.?\//.test(source) || source === "." || source === "..";
}

/**
 * An absolute filesystem source (`/opt/modules/vpc`).
 *
 * Terraform reads it from the local disk, so it is not an external module, but the map speaks
 * only repo-relative paths and can never name it: it resolves to nothing at all.
 */
function isAbsoluteModuleSource(source: string): boolean {
  return source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source);
}

/** Join and normalise, returning null when the result escapes the repo root. */
function normalizeJoin(dir: string, rest: string): string | null {
  const segments: string[] = [];
  for (const segment of `${dir}/${rest}`.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/**
 * A Terraform module-source resolver over the indexed file set.
 *
 * The set of directories that *are* modules is computed once, on first use, from the indexed
 * files themselves: a directory is a module exactly when the map holds a `.tf` file in it.
 * Nothing here touches the filesystem (tech spec 5.1), so a module the repo references but
 * does not index is honestly unresolved rather than guessed at.
 */
export function createHclResolver(ctx: RepoContext): (fromFile: string, specifier: string) => ResolvedTarget {
  let moduleDirs: Set<string> | null = null;

  function directories(): Set<string> {
    if (moduleDirs === null) {
      const dirs = new Set<string>();
      for (const file of ctx.files) {
        if (!file.endsWith(MODULE_FILE_SUFFIX)) continue;
        const dir = hclDirectoryOf(file);
        dirs.add(dir === HCL_ROOT_DIR_ID ? "" : dir);
      }
      moduleDirs = dirs;
    }
    return moduleDirs;
  }

  return (fromFile: string, specifier: string): ResolvedTarget => {
    if (specifier === "" || isAbsoluteModuleSource(specifier)) return UNRESOLVED;
    if (!isLocalModuleSource(specifier)) {
      return { type: "external", pkg: `${HCL_MODULE_NAMESPACE}${specifier}` };
    }
    const from = hclDirectoryOf(fromFile);
    const target = normalizeJoin(from === HCL_ROOT_DIR_ID ? "" : from, specifier);
    if (target === null) return UNRESOLVED;
    if (!directories().has(target)) return UNRESOLVED;
    return { type: "file", path: target === "" ? HCL_ROOT_DIR_ID : target };
  };
}

/**
 * HCL has no call edges (spec 2.2), so this is never reached: `extractHcl` returns `calls: []`
 * for every file. It throws rather than returning null so that a `CallSite` appearing here —
 * which could only come from a bug in the extractor — is a loud failure and not a quietly
 * missing edge.
 */
export function resolveHclCall(
  file: FileRecord,
  _site: CallSite,
  _index: HclCallIndex,
): { to: string; confidence: Confidence } | null {
  throw new Error(`greplost: HCL has no call edges, so ${file.path} cannot have produced one (build-2 leaf 2.2)`);
}
