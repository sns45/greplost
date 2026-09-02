/**
 * Specifier resolution (core-extract spec, "Resolution rules").
 *
 * The resolver never touches the file system: it works from `RepoContext`, whose
 * `files` set is the indexed file set and whose `readFile` returns repo-relative
 * text (null when absent). A file that exists on disk but is not indexed is
 * unresolved by design - the map only ever points at files it knows.
 *
 * Nothing is guessed: every `{ type: "file" }` answer names a path that is in
 * `ctx.files`.
 *
 * Four additions beyond the spec's four rules, each of which can only ever point
 * at a file the index already holds, and each matching what tsc or Node does:
 *  - a bare specifier is probed against an explicit tsconfig `baseUrl` after
 *    `paths` misses (tsc tries baseUrl before node_modules);
 *  - a workspace subpath with no `exports` entry is probed against the package
 *    directory and its `src/`;
 *  - `#name` subpath imports go through the package scope's `imports` map, so
 *    they never masquerade as an external package;
 *  - `${configDir}` in a tsconfig mapping is substituted (tsconfig 5.5).
 */

import { builtinModules } from "node:module";
import { loadTsconfigPaths } from "./tsconfig.ts";
import type { TsPaths } from "./tsconfig.ts";
import type { Lang, PackageInfo } from "../schema.ts";

export type ResolvedTarget =
  | { type: "file"; path: string }
  | { type: "external"; pkg: string }
  | { type: "unresolved" };

export interface RepoContext {
  /** Absolute repo root. Never used to read: it identifies the repo for callers. */
  root: string;
  /** Indexed, repo-relative file paths (forward slashes). */
  files: ReadonlySet<string>;
  packages: PackageInfo[];
  /** Repo-relative read; null when the file is absent. */
  readFile: (rel: string) => string | null;
}

export interface Resolver {
  /**
   * Resolve one import specifier. The answer depends only on the importing
   * file's directory, so results are memoised per (lang, directory, specifier)
   * and the returned object is shared: treat it as read-only.
   */
  resolve(fromFile: string, specifier: string, lang: Lang): ResolvedTarget;
}

const UNRESOLVED: ResolvedTarget = { type: "unresolved" };

/** Probed in order for an extensionless candidate and for `<candidate>/index`. */
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

/** An ESM-style specifier written against emitted JavaScript maps back to its source. */
const JS_TO_TS: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/** package.json `exports` conditions, in the order the spec fixes. */
const EXPORT_CONDITIONS = ["bun", "source", "import", "default", "require", "types"] as const;

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);

export function createResolver(ctx: RepoContext): Resolver {
  const files = ctx.files;
  const tsconfigByDir = new Map<string, TsPaths | null>();
  const manifestByDir = new Map<string, Record<string, unknown> | null>();
  const scopeByDir = new Map<string, string | null>();
  const resultByKey = new Map<string, ResolvedTarget>();

  const workspaceByName = new Map<string, PackageInfo>();
  for (const pkg of ctx.packages) {
    if (pkg.source !== "package.json") continue;
    if (!workspaceByName.has(pkg.name)) workspaceByName.set(pkg.name, pkg);
  }

  /** First indexed file for a repo-relative candidate, or null. */
  function probe(candidate: string | null): string | null {
    if (candidate === null) return null;
    if (candidate !== "") {
      if (files.has(candidate)) return candidate;
      const dot = candidate.lastIndexOf(".");
      const slash = candidate.lastIndexOf("/");
      if (dot > slash + 1) {
        const mapped = JS_TO_TS[candidate.slice(dot)];
        if (mapped) {
          const stem = candidate.slice(0, dot);
          for (const ext of mapped) {
            if (files.has(stem + ext)) return stem + ext;
          }
        }
      }
      for (const ext of EXTENSIONS) {
        if (files.has(candidate + ext)) return candidate + ext;
      }
    }
    for (const ext of EXTENSIONS) {
      const indexFile = joinRelative(candidate, `index${ext}`);
      if (files.has(indexFile)) return indexFile;
    }
    return null;
  }

  function tsconfigFor(dir: string): TsPaths | null {
    const cached = tsconfigByDir.get(dir);
    if (cached !== undefined) return cached;
    // loadTsconfigPaths takes the importing file; any name inside `dir` selects the same config.
    const loaded = loadTsconfigPaths(ctx.root, joinRelative(dir, "file.ts"), ctx.readFile);
    tsconfigByDir.set(dir, loaded);
    return loaded;
  }

  function manifestFor(dir: string): Record<string, unknown> | null {
    const cached = manifestByDir.get(dir);
    if (cached !== undefined) return cached;
    const text = ctx.readFile(joinRelative(dir, "package.json"));
    let parsed: Record<string, unknown> | null = null;
    if (text !== null) {
      try {
        const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
        if (value && typeof value === "object" && !Array.isArray(value)) {
          parsed = value as Record<string, unknown>;
        }
      } catch {
        parsed = null;
      }
    }
    manifestByDir.set(dir, parsed);
    return parsed;
  }

  /** Directory of the nearest package.json at or above `dir` (Node's package scope). */
  function packageScope(dir: string): string | null {
    const cached = scopeByDir.get(dir);
    if (cached !== undefined) return cached;
    let scope: string | null = null;
    let current = dir;
    for (;;) {
      if (manifestFor(current) !== null) {
        scope = current;
        break;
      }
      if (current === "") break;
      current = parentDir(current);
    }
    scopeByDir.set(dir, scope);
    return scope;
  }

  /** Rule 2: tsconfig `paths`, then a bare specifier under an explicit `baseUrl`. */
  function resolveTsconfig(dir: string, specifier: string): string | null {
    const config = tsconfigFor(dir);
    if (!config) return null;
    for (const mapping of pathMappings(config, specifier)) {
      // A mapping starting with "/" is repo-root-relative (a substituted "${configDir}").
      const candidate = mapping.startsWith("/")
        ? normalizeJoin("", mapping.slice(1))
        : normalizeJoin(config.baseUrl, mapping);
      const hit = probe(candidate);
      if (hit) return hit;
    }
    // tsc resolves a non-relative specifier against baseUrl before node_modules;
    // this only ever fires when the mapped file is actually indexed.
    return probe(normalizeJoin(config.baseUrl, specifier));
  }

  /** Rule 3: a bare specifier naming a workspace package. */
  function resolveWorkspace(pkg: PackageInfo, subpath: string): string | null {
    const dir = pkg.path === "." ? "" : pkg.path;
    const manifest = manifestFor(dir);
    const targets: string[] = [];

    if (manifest) {
      targets.push(...exportsTargets(manifest["exports"], subpath === "" ? "." : `./${subpath}`));
      if (subpath === "") {
        for (const field of ["module", "main"] as const) {
          const value = manifest[field];
          if (typeof value === "string") targets.push(value);
        }
      }
    }
    if (subpath !== "") targets.push(`./${subpath}`, `./src/${subpath}`);

    for (const target of targets) {
      const hit = probe(normalizeJoin(dir, target));
      if (hit) return hit;
    }
    if (subpath === "") {
      for (const fallback of ["src/index", "index"]) {
        const hit = probe(normalizeJoin(dir, fallback));
        if (hit) return hit;
      }
    }
    return null;
  }

  /** Rule 3, second half: a bare specifier that is not a builtin. */
  function resolveBare(specifier: string): ResolvedTarget {
    const { name, subpath } = splitBareSpecifier(specifier);
    const workspace = workspaceByName.get(name);
    if (workspace) {
      const hit = resolveWorkspace(workspace, subpath);
      return hit ? { type: "file", path: hit } : UNRESOLVED;
    }
    return { type: "external", pkg: name };
  }

  /** Node subpath imports (`#internal/x`), resolved through the package scope's `imports`. */
  function resolveSubpathImport(fromDir: string, specifier: string): ResolvedTarget {
    const scope = packageScope(fromDir);
    const manifest = scope === null ? null : manifestFor(scope);
    if (scope === null || !manifest) return UNRESOLVED;
    for (const target of importsTargets(manifest["imports"], specifier)) {
      if (/^\.\.?(\/|$)/.test(target) || target.startsWith("/")) {
        const hit = probe(normalizeJoin(scope, target.replace(/^\//, "")));
        if (hit) return { type: "file", path: hit };
        continue;
      }
      if (target.startsWith("#")) continue; // chained internal targets are not followed
      // A bare target (`"#dep": "some-package"`) continues through the bare rule.
      if (target.startsWith("node:") || BUILTINS.has(target)) return { type: "external", pkg: target };
      return resolveBare(target);
    }
    return UNRESOLVED;
  }

  function resolveUncached(fromDir: string, specifier: string, lang: Lang): ResolvedTarget {
    if (specifier === "") return UNRESOLVED;

    // Go import paths are module paths: leaf 1.8 adds the go.mod rules here.
    if (lang === "go") return { type: "external", pkg: specifier };

    // Rule 1: relative and root-absolute specifiers.
    if (/^\.\.?(\/|$)/.test(specifier)) {
      const hit = probe(normalizeJoin(fromDir, specifier));
      return hit ? { type: "file", path: hit } : UNRESOLVED;
    }
    if (specifier.startsWith("/")) {
      const hit = probe(normalizeJoin("", specifier.slice(1)));
      return hit ? { type: "file", path: hit } : UNRESOLVED;
    }

    // "#" is reserved for package-internal imports: never an npm package name.
    if (specifier.startsWith("#")) return resolveSubpathImport(fromDir, specifier);

    // Rule 2: tsconfig paths.
    const mapped = resolveTsconfig(fromDir, specifier);
    if (mapped) return { type: "file", path: mapped };

    // Rule 3: bare specifiers.
    if (specifier.startsWith("node:") || BUILTINS.has(specifier)) {
      return { type: "external", pkg: specifier };
    }
    return resolveBare(specifier);
  }

  return {
    resolve(fromFile: string, specifier: string, lang: Lang): ResolvedTarget {
      const fromDir = parentDir(normalizeRelative(fromFile));
      const key = `${lang}\u0000${fromDir}\u0000${specifier}`;
      const cached = resultByKey.get(key);
      if (cached) return cached;
      const result = resolveUncached(fromDir, specifier, lang);
      resultByKey.set(key, result);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// tsconfig paths matching
// ---------------------------------------------------------------------------

/** Mappings for `specifier`, exact keys first, then wildcards by longest prefix. */
function pathMappings(config: TsPaths, specifier: string): string[] {
  const keys = Object.keys(config.paths);
  if (keys.length === 0) return [];

  const exact: string[] = [];
  const wildcards: string[] = [];
  for (const key of keys) {
    if (!key.includes("*")) {
      if (key === specifier) exact.push(key);
    } else if (wildcardStar(key, specifier) !== null) {
      wildcards.push(key);
    }
  }
  wildcards.sort((a, b) => starPrefix(b).length - starPrefix(a).length || (a < b ? -1 : a > b ? 1 : 0));

  const out: string[] = [];
  for (const key of [...exact, ...wildcards]) {
    const star = key.includes("*") ? (wildcardStar(key, specifier) ?? "") : "";
    for (const mapping of config.paths[key] ?? []) {
      out.push(key.includes("*") ? mapping.replaceAll("*", star) : mapping);
    }
  }
  return out;
}

function starPrefix(key: string): string {
  const index = key.indexOf("*");
  return index === -1 ? key : key.slice(0, index);
}

/** The text matched by `*`, or null when the key does not match. */
function wildcardStar(key: string, specifier: string): string | null {
  const index = key.indexOf("*");
  if (index === -1) return key === specifier ? "" : null;
  const prefix = key.slice(0, index);
  const suffix = key.slice(index + 1);
  if (specifier.length < prefix.length + suffix.length) return null;
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

// ---------------------------------------------------------------------------
// package.json exports and imports
// ---------------------------------------------------------------------------

/** Candidate targets for `key` ("." or "./sub"), best first. */
function exportsTargets(exportsField: unknown, key: string): string[] {
  if (exportsField === undefined || exportsField === null) return [];
  if (typeof exportsField === "string") return key === "." ? [exportsField] : [];
  if (Array.isArray(exportsField)) return key === "." ? conditionTargets(exportsField) : [];
  if (typeof exportsField !== "object") return [];

  const map = exportsField as Record<string, unknown>;
  const keys = Object.keys(map);
  if (keys.length === 0) return [];

  // Sugar: conditions (or a single target) for "." only.
  if (!keys.every((k) => k === "." || k.startsWith("./"))) {
    return key === "." ? conditionTargets(map) : [];
  }
  return subpathTargets(map, keys, key);
}

/** Candidate targets for a `#`-prefixed subpath import. */
function importsTargets(importsField: unknown, key: string): string[] {
  if (!importsField || typeof importsField !== "object" || Array.isArray(importsField)) return [];
  const map = importsField as Record<string, unknown>;
  const keys = Object.keys(map);
  if (keys.length === 0 || !keys.every((k) => k.startsWith("#"))) return [];
  return subpathTargets(map, keys, key);
}

/** Exact key, then `*` patterns by longest prefix, then trailing-slash folders. */
function subpathTargets(map: Record<string, unknown>, keys: string[], key: string): string[] {
  if (Object.prototype.hasOwnProperty.call(map, key)) return conditionTargets(map[key]);

  const patterns = keys
    .filter((k) => k.includes("*") && wildcardStar(k, key) !== null)
    .sort((a, b) => starPrefix(b).length - starPrefix(a).length || (a < b ? -1 : a > b ? 1 : 0));
  for (const pattern of patterns) {
    const star = wildcardStar(pattern, key) ?? "";
    const targets = conditionTargets(map[pattern]).map((t) => t.replaceAll("*", star));
    if (targets.length > 0) return targets;
  }

  // Deprecated trailing-slash folder mappings ("./lib/": "./src/lib/").
  const folders = keys
    .filter((k) => k.endsWith("/") && key.startsWith(k))
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  for (const folder of folders) {
    const rest = key.slice(folder.length);
    const targets = conditionTargets(map[folder]).map((t) => (t.endsWith("/") ? t + rest : t));
    if (targets.length > 0) return targets;
  }
  return [];
}

/** Flatten a target: string, array, or a (possibly nested) conditions object. */
function conditionTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => conditionTargets(entry));
  if (typeof value !== "object") return [];
  const map = value as Record<string, unknown>;
  const out: string[] = [];
  for (const condition of EXPORT_CONDITIONS) {
    if (Object.prototype.hasOwnProperty.call(map, condition)) out.push(...conditionTargets(map[condition]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// specifier and path helpers
// ---------------------------------------------------------------------------

/** `@scope/name/rest` -> name `@scope/name`, subpath `rest`; `name/rest` likewise. */
function splitBareSpecifier(specifier: string): { name: string; subpath: string } {
  const scoped = specifier.startsWith("@");
  const first = specifier.indexOf("/");
  if (first === -1) return { name: specifier, subpath: "" };
  if (!scoped) return { name: specifier.slice(0, first), subpath: specifier.slice(first + 1) };
  const second = specifier.indexOf("/", first + 1);
  if (second === -1) return { name: specifier, subpath: "" };
  return { name: specifier.slice(0, second), subpath: specifier.slice(second + 1) };
}

function normalizeRelative(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function parentDir(p: string): string {
  const index = p.lastIndexOf("/");
  return index === -1 ? "" : p.slice(0, index);
}

function joinRelative(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
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
