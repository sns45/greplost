/**
 * What a `package.json` says its entry points are (workspace spec "Rules").
 *
 * Split out of `cross.ts` because it is a different question with different
 * rules: that file decides *which sibling* an `ext:` target belongs to, and
 * this one decides *which file inside it* the specifier actually names. The
 * second question is all of Node's `exports` resolution in miniature —
 * conditions, subpath keys, wildcard patterns, the legacy `main` — and it is
 * the part that has to stay honest, because every candidate it produces is
 * checked against the sibling's map before it becomes an edge.
 *
 * Nothing here reads the filesystem. A candidate is a string; whether it names
 * an indexed file is the caller's question, answered from the map.
 */

import { compareStrings } from "@greplost/core/schema";

/**
 * One npm package a repo publishes, kept whole rather than reduced to its entry
 * file: a sibling can import `@fx/a/sub` as readily as `@fx/a`, and answering
 * that needs the `exports` map itself, not the answer it gave for `"."`.
 */
export interface NpmPackage {
  /** Repo-relative directory of the package (`"."` for the root package). */
  path: string;
  /** The parsed `package.json`. */
  manifest: Record<string, unknown>;
  /** Indexed file the package root resolves to, when one does. */
  entry: string | undefined;
}

/** `@fx/a/sub` against the name `@fx/a` is the subpath `sub`; the bare name is `""`. */
export function subpathOf(specifier: string, name: string): string {
  if (!specifier.startsWith(`${name}/`)) return "";
  return specifier.slice(name.length + 1).replace(/^\.?\//, "");
}

/**
 * The indexed file one entry point of a sibling package resolves to.
 *
 * `subpath` is `""` for the package itself and `sub` for `@fx/a/sub`. Every
 * condition of the matching `exports` entry is collected in a fixed order and
 * the first candidate that is actually in the sibling's map wins, so a package
 * whose `exports` names both a built `dist/index.js` and a `source` entry
 * resolves to the one the map has. A short extension probe covers the common
 * extensionless `main`.
 *
 * A subpath that `exports` does not answer falls back the way Node's legacy
 * resolution does, to the path itself under the package directory, and only
 * then to the package's own entry file — which is where every subpath landed
 * before, so the change can only make an edge more precise, never less.
 * Nothing is invented: a package that ships only build output the map does not
 * index has no entry file at all, and its edges land on `pkg:<name>`.
 */
export function resolveNpmTarget(
  files: ReadonlySet<string>,
  pkg: NpmPackage,
  subpath: string,
): string | undefined {
  const key = subpath === "" ? "." : `./${subpath}`;
  const candidates = conditionTargets(exportsFor(pkg.manifest["exports"], key), 0);
  if (subpath === "" && typeof pkg.manifest["main"] === "string") candidates.push(pkg.manifest["main"]);
  if (subpath !== "") candidates.push(`./${subpath}`);

  for (const candidate of candidates) {
    const joined = normalizeJoin(pkg.path, candidate);
    if (joined === null) continue;
    for (const probe of probes(joined)) {
      if (files.has(probe)) return probe;
    }
  }
  return subpath === "" ? undefined : pkg.entry;
}

/**
 * The `exports` value for one subpath key (`"."` or `"./sub"`), or `undefined`.
 *
 * A string or array `exports` is the package entry and answers `"."` only. A
 * subpath map answers an exact key, then the `*` pattern with the longest
 * static prefix, which is Node's own precedence rule. A conditions map with no
 * `"."`-prefixed key is shorthand for `"."`.
 */
function exportsFor(value: unknown, key: string): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" || Array.isArray(value)) return key === "." ? value : undefined;
  if (typeof value !== "object") return undefined;

  const map = value as Record<string, unknown>;
  const keys = Object.keys(map);
  if (!keys.some((entry) => entry.startsWith("."))) return key === "." ? value : undefined;
  if (Object.hasOwn(map, key)) return map[key];

  let bestPrefix = "";
  let best: unknown;
  for (const pattern of keys.sort(compareStrings)) {
    const star = pattern.indexOf("*");
    if (star === -1 || pattern.indexOf("*", star + 1) !== -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    if (key.length < prefix.length + suffix.length) continue;
    if (best !== undefined && prefix.length <= bestPrefix.length) continue;
    bestPrefix = prefix;
    best = substituteStar(map[pattern], key.slice(prefix.length, key.length - suffix.length));
  }
  return best;
}

/** Put the matched `*` back into every string of a wildcard target. */
function substituteStar(value: unknown, star: string): unknown {
  if (typeof value === "string") return value.split("*").join(star);
  if (Array.isArray(value)) return value.map((entry) => substituteStar(entry, star));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = substituteStar(entry, star);
  }
  return out;
}

/** Conditions tried in order; `types` last because it names declarations, not source. */
const EXPORT_CONDITIONS: readonly string[] = [
  "source",
  "development",
  "import",
  "module",
  "default",
  "require",
  "node",
  "browser",
  "types",
];

const MAX_EXPORTS_DEPTH = 8;

/** Every string one resolved `exports` value can yield, richest condition first. */
function conditionTargets(value: unknown, depth: number): string[] {
  if (depth > MAX_EXPORTS_DEPTH) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => conditionTargets(entry, depth + 1));
  if (value === null || typeof value !== "object") return [];

  const map = value as Record<string, unknown>;
  const out: string[] = [];
  for (const condition of EXPORT_CONDITIONS) {
    if (Object.hasOwn(map, condition)) out.push(...conditionTargets(map[condition], depth + 1));
  }
  // Anything left that is not a subpath key: an unknown condition is still a
  // target, and one the caller may well be resolving under.
  for (const key of Object.keys(map).sort(compareStrings)) {
    if (key.startsWith(".") || EXPORT_CONDITIONS.includes(key)) continue;
    out.push(...conditionTargets(map[key], depth + 1));
  }
  return out;
}

/** The file ids one entry-point path could mean, most literal first. */
function probes(target: string): string[] {
  const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  return [target, ...extensions.map((ext) => `${target}${ext}`), ...extensions.map((ext) => `${target}/index${ext}`)];
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/** A repo-relative directory as the map spells it: posix, no `./`, `"."` at the root. */
export function normalizeDir(dir: string): string {
  const segments: string[] = [];
  for (const segment of dir.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    segments.push(segment);
  }
  return segments.length === 0 ? "." : segments.join("/");
}

export function joinRelative(dir: string, rest: string): string {
  return dir === "." || dir === "" ? rest : `${dir}/${rest}`;
}

/** Join and normalise a repo-relative path, or `null` when it escapes the repo. */
function normalizeJoin(dir: string, rest: string): string | null {
  const segments: string[] = [];
  for (const segment of joinRelative(dir, rest.replace(/\\/g, "/")).split("/")) {
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
