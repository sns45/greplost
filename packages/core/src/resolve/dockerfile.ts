/**
 * Dockerfile resolution (build 2, spec 2026-09-04 section 2.5, "References").
 *
 * One job: turn a `COPY`/`ADD` source into the repo file it names. A Dockerfile has no import
 * statement, so this is the whole of it — `resolveDockerfileCall` exists only to keep the shape
 * of the language pipeline uniform (spec section 0.4) and can never be reached.
 *
 * The build context is not written down anywhere greplost can read: `docker build -f X .` takes
 * it from the command line, a compose file or a CI job, and a Dockerfile itself never says
 * which directory its sources are relative to. So a source is probed against exactly two
 * contexts — the Dockerfile's own directory (the default when nobody says otherwise) and the
 * repository root (what a monorepo build almost always passes) — and it resolves only when the
 * two agree on **one** indexed file. Two different files is ambiguous and resolves to nothing,
 * which is the rule that governs every edge in greplost (tech spec 5.1).
 *
 * A glob, an absolute path, a URL and anything holding a build variable are refused before the
 * probe: none of them can name one repo file, and `COPY . /app` naming every file at once is
 * the case that would otherwise invent an edge to whichever file sorted first.
 */

import type { CallSite, Confidence, FileRecord } from "../schema.ts";
import type { RepoContext, ResolvedTarget } from "./resolver.ts";

/** The repo-root directory id, for a Dockerfile that sits at the top of the repo. */
const DOCKERFILE_ROOT_DIR_ID = ".";

const UNRESOLVED: ResolvedTarget = { type: "unresolved" };

/** Placeholder for the per-language call index; a Dockerfile has no calls, so it holds nothing. */
type DockerfileCallIndex = Readonly<Record<string, never>>;

/** Characters that make a source a pattern rather than a name (`COPY src/*.js /app/`). */
const GLOB_CHARACTERS = /[*?[\]{}]/u;

/** Directory of a repo-relative path; `"."` for a file at the repo root. */
function dockerfileDirectoryOf(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index === -1 ? DOCKERFILE_ROOT_DIR_ID : filePath.slice(0, index);
}

/**
 * A source that could name exactly one file in the build context.
 *
 * Everything refused here is refused because it *cannot* name one: a glob and `.` name many, an
 * absolute path and a URL name something outside the context entirely, and a path holding a
 * build variable names whatever the builder computes.
 */
function isContextPath(source: string): boolean {
  if (source === "" || source === "." || source === "..") return false;
  if (source.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(source)) return false;
  if (source.includes("://")) return false;
  if (source.includes("$") || GLOB_CHARACTERS.test(source)) return false;
  if (source.endsWith("/")) return false;
  return !/[\n\0]/u.test(source);
}

/** Join and normalise, returning null when the result escapes the repo root. */
function normalizeJoin(dir: string, rest: string): string | null {
  const segments: string[] = [];
  for (const segment of `${dir}/${rest}`.replace(/\\/gu, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join("/");
}

/**
 * A `COPY`/`ADD` source resolver over the indexed file set.
 *
 * Nothing here touches the filesystem (tech spec 5.1): a path the repository holds but does not
 * index is honestly unresolved rather than guessed at, which is also why a `COPY package.json`
 * produces no edge — greplost indexes no language that owns a `package.json`.
 */
export function createDockerfileResolver(
  ctx: RepoContext,
): (fromFile: string, specifier: string) => ResolvedTarget {
  return (fromFile: string, specifier: string): ResolvedTarget => {
    if (!isContextPath(specifier)) return UNRESOLVED;

    const candidates = new Set<string>();
    const dir = dockerfileDirectoryOf(fromFile);
    for (const base of [dir === DOCKERFILE_ROOT_DIR_ID ? "" : dir, ""]) {
      const candidate = normalizeJoin(base, specifier);
      if (candidate !== null && ctx.files.has(candidate)) candidates.add(candidate);
    }
    if (candidates.size !== 1) return UNRESOLVED;
    return { type: "file", path: [...candidates][0] as string };
  };
}

/**
 * A Dockerfile has no call edges (spec 2.5), so this is never reached: `extractDockerfile`
 * returns `calls: []` for every file. It throws rather than returning null so that a `CallSite`
 * appearing here — which could only come from a bug in the extractor — is a loud failure and
 * not a quietly missing edge.
 */
export function resolveDockerfileCall(
  file: FileRecord,
  _site: CallSite,
  _index: DockerfileCallIndex,
): { to: string; confidence: Confidence } | null {
  throw new Error(
    `greplost: a Dockerfile has no call edges, so ${file.path} cannot have produced one (build-2 leaf 2.10)`,
  );
}
