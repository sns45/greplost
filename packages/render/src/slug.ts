/**
 * greplost:render artifact paths.
 *
 * Pure path arithmetic over posix-style, repo-relative strings; no filesystem
 * access. All paths here are relative to the `.greplost/` artifact root.
 */

import { posix } from "node:path";
import type { DeclKind, PackageInfo } from "@greplost/core/schema";
import { packageSlug, splitNodeId } from "@greplost/core/schema";

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
 * Filename stem of a non-file node's card: `<kind>.<name>` with `/` folded to
 * `__` and every remaining character outside `[A-Za-z0-9._-]` folded to `-`,
 * the same two rules `packageSlug` uses.
 *
 * A route name (`/users/[id]`), a Pulumi type token (`aws:s3/bucket:Bucket`)
 * and the `~<n>` a duplicate carries in its id are all legal node names and
 * none of them is a legal path segment, so the slug is not optional. It is
 * lossy on purpose: the id stays canonical, and `assertNoCardCollision` turns
 * the rare two-names-one-slug case into a loud failure rather than a lost card.
 */
export function nodeSlug(kind: DeclKind, name: string): string {
  return `${kind}.${name}`.replace(/\//g, "__").replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * Artifact-root-relative path of a non-file node's card: a sibling of its
 * file's card, inside a directory named after the file.
 *
 * `infra/main.tf#resource.aws_s3_bucket.logs` in package `infra` becomes
 * `packages/infra/modules/main.tf/resource.aws_s3_bucket.logs.md`.
 *
 * **No artifact path ever contains a `#`** (spec 0.2). A `#` in a Markdown link
 * is a URL fragment, so a card written to `main.tf#resource.x.md` would leave
 * the file card and every inbound link silently pointing at the wrong page and
 * nothing would fail loudly. The name is taken from the *id*, so the `~<n>`
 * suffix that makes a duplicate unique survives into the path.
 */
export function nodeCardPath(pkg: PackageInfo, id: string): string {
  const parts = splitNodeId(id);
  if (parts === null) throw new Error(`greplost: not a node id: ${id}`);
  const rel = pkg.path === "." ? parts.file : stripPackagePrefix(parts.file, pkg.path);
  return `${packageDir(pkg.name)}/modules/${rel}/${nodeSlug(parts.kind, parts.name)}.md`;
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
