/**
 * greplost:render artifact paths.
 *
 * Pure path arithmetic over posix-style, repo-relative strings; no filesystem
 * access. All paths here are relative to the `.greplost/` artifact root.
 */

import { posix } from "node:path";
import type { PackageInfo } from "@greplost/core/schema";
import { packageSlug } from "@greplost/core/schema";

/** Artifact-root-relative directory for a package's rendered docs: `packages/<slug>`. */
export function packageDir(pkgName: string): string {
  return `packages/${packageSlug(pkgName)}`;
}

/**
 * Artifact-root-relative path of a module card for `file` (repo-relative path)
 * belonging to `pkg`: `<packageDir>/modules/<relative-to-package-path>.md`.
 * The root package (`pkg.path === "."`) has no meaningful prefix to strip, so
 * its cards use the file's full repo-relative path.
 */
export function cardPath(pkg: PackageInfo, file: string): string {
  const rel = pkg.path === "." ? file : stripPackagePrefix(file, pkg.path);
  return `${packageDir(pkg.name)}/modules/${rel}.md`;
}

function stripPackagePrefix(file: string, pkgPath: string): string {
  const prefix = `${pkgPath}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

/**
 * Posix relative link from one artifact (a file, `fromArtifact`) to another
 * (`toArtifact`), both paths relative to the `.greplost/` root. The link is
 * computed from `fromArtifact`'s containing directory.
 *
 * `relLink("packages/tiny__core/modules/src/registry.ts.md", "packages/tiny__core/MAP.md")`
 * => `"../../MAP.md"`.
 */
export function relLink(fromArtifact: string, toArtifact: string): string {
  const fromDir = posix.dirname(fromArtifact);
  const rel = posix.relative(fromDir, toArtifact);
  return rel === "" ? posix.basename(toArtifact) : rel;
}
