/**
 * The one place that turns a path into a `Lang` (schema 2, spec 2026-09-04 section 0.4).
 *
 * Before this module the rule was inlined in five places (discovery, the unparsable
 * scanner, the incremental watcher, the parse cache and the CLI's path sniffing), each
 * of which only knew about extensions. Adding Dockerfiles made that a real bug: a file
 * with no extension, or one whose extension is a *variant* name (`Dockerfile.dev`), was
 * invisible to some call sites and visible to others.
 */

import { DOCKERFILE_PREFIX, LANG_BY_BASENAME, LANG_BY_EXTENSION } from "./schema.ts";
import type { Lang } from "./schema.ts";

/**
 * The language of a repo-relative path, or undefined when greplost has no extractor for it.
 *
 * Basename rules run first, so `Dockerfile.dev` is a Dockerfile rather than an unknown
 * `.dev` file and `Dockerfile.ts` is not read as TypeScript. A dot at position 0
 * (`.gitignore`) is not an extension separator, so a dotfile is never a language.
 */
export function langOf(path: string): Lang | undefined {
  const slash = path.lastIndexOf("/");
  const base = slash === -1 ? path : path.slice(slash + 1);

  const byBasename = LANG_BY_BASENAME[base];
  if (byBasename !== undefined) return byBasename;

  if (base.startsWith(DOCKERFILE_PREFIX) && base.length > DOCKERFILE_PREFIX.length) return "dockerfile";

  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return LANG_BY_EXTENSION[base.slice(dot)];
}
