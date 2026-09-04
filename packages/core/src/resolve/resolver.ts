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
 * Five additions beyond the spec's four rules, each of which can only ever point
 * at a file the index already holds, and each matching what tsc or Node does:
 *  - a bare specifier is probed against a *declared* tsconfig `baseUrl` after
 *    `paths` misses (tsc tries baseUrl before node_modules; with `paths` alone and
 *    no `baseUrl`, tsc does no such probing and neither does this);
 *  - a workspace subpath with no `exports` entry is probed against the package
 *    directory and its `src/` - but never when `exports` matched it to `null`,
 *    which Node and tsc both treat as deliberately unimportable;
 *  - the root package is resolvable by its own name, so a repo that imports
 *    itself ("my-lib/sub") gets a file edge instead of a phantom external;
 *  - `#name` subpath imports go through the package scope's `imports` map and
 *    then tsconfig `paths`, so they never masquerade as an external package;
 *  - `${configDir}` in a tsconfig mapping is substituted (tsconfig 5.5).
 */

import { builtinModules } from "node:module";
import { createGoResolver } from "./go.ts";
import { loadTsconfigPaths } from "./tsconfig.ts";
import type { TsPaths } from "./tsconfig.ts";
import { compareStrings } from "../schema.ts";
import type { Lang, PackageInfo } from "../schema.ts";
import { createDockerfileResolver } from "./dockerfile.ts";
import { createHclResolver } from "./hcl.ts";
import { createJavaResolver } from "./java.ts";
import { createKotlinResolver } from "./kotlin.ts";
import { createPythonResolver } from "./python.ts";
import { createRustResolver } from "./rust.ts";
import { createYamlResolver } from "./yaml.ts";

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

/** A per-language resolver: schema 2 languages answer on the *file*, not on its directory. */
type LanguageResolver = (fromFile: string, specifier: string) => ResolvedTarget;

/**
 * Schema 2 languages resolve through their own module (spec 2026-09-04 section 0.4).
 *
 * The table is `Partial` because ts/tsx/js/jsx and go do not belong in it: the four
 * JavaScript dialects share the rules in this file, and Go's resolver is directory-based and
 * predates the convention. Everything else gets one module per language, so a language leaf
 * replaces one file and edits nothing shared.
 */
const LANGUAGE_RESOLVERS: Readonly<Partial<Record<Lang, (ctx: RepoContext) => LanguageResolver>>> = {
  python: createPythonResolver,
  rust: createRustResolver,
  java: createJavaResolver,
  kotlin: createKotlinResolver,
  hcl: createHclResolver,
  yaml: createYamlResolver,
  dockerfile: createDockerfileResolver,
};

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
  seedRootPackageName();

  // Go import paths are module paths, not file paths: leaf 1.8's rules live in
  // `resolve/go.ts` and share this context's indexed file set and reader.
  const resolveGo = createGoResolver(ctx);

  /**
   * Schema 2 language resolvers, built on first use.
   *
   * Lazily, because a repo indexes one or two languages and building all seven eagerly would
   * make every TypeScript build pay for them; and because an unimplemented language's module
   * is allowed to be expensive or absent-minded about a context it will never read.
   */
  const languageResolvers = new Map<Lang, LanguageResolver>();
  function languageResolver(lang: Lang): LanguageResolver | undefined {
    const cached = languageResolvers.get(lang);
    if (cached !== undefined) return cached;
    const factory = LANGUAGE_RESOLVERS[lang];
    if (factory === undefined) return undefined;
    const made = factory(ctx);
    languageResolvers.set(lang, made);
    return made;
  }

  /**
   * A repo whose root package.json has a name may import itself by that name
   * ("my-lib/sub"), which is a real file edge, not an external dependency. The root
   * carries `source: "root"`, so it is registered here rather than in the loop above,
   * and never displaces a workspace package that already owns the name.
   */
  function seedRootPackageName(): void {
    const manifest = manifestFor("");
    const name = manifest && typeof manifest["name"] === "string" ? manifest["name"].trim() : "";
    if (!name || workspaceByName.has(name)) return;
    const root = ctx.packages.find((pkg) => pkg.path === "." || pkg.path === "");
    workspaceByName.set(name, root ?? { name, path: ".", source: "root" });
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
    // tsc resolves a non-relative specifier against baseUrl before node_modules, but
    // only when baseUrl was actually declared: with `paths` alone there is no such root.
    if (!config.baseUrlDeclared) return null;
    return probe(normalizeJoin(config.baseUrl, specifier));
  }

  /** Rule 3: a bare specifier naming a workspace package. */
  function resolveWorkspace(pkg: PackageInfo, subpath: string): string | null {
    const dir = pkg.path === "." ? "" : pkg.path;
    const manifest = manifestFor(dir);
    const targets: string[] = [];

    if (manifest) {
      const match = exportsTargets(manifest["exports"], subpath === "" ? "." : `./${subpath}`);
      // `null` in an exports map means "not importable": Node and tsc both refuse it,
      // so no legacy probing may resurrect the file behind it.
      if (match.blocked) return null;
      targets.push(...match.targets);
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

  /**
   * Node subpath imports (`#internal/x`) through the package scope's `imports` map.
   * Returns null when no key matched, so the caller can still try tsconfig `paths`;
   * a matched-but-blocked key resolves to `unresolved` and stops there.
   */
  function resolveSubpathImport(fromDir: string, specifier: string): ResolvedTarget | null {
    const scope = packageScope(fromDir);
    const manifest = scope === null ? null : manifestFor(scope);
    if (scope === null || !manifest) return null;
    const match = importsTargets(manifest["imports"], specifier);
    if (match.blocked) return UNRESOLVED;
    if (match.targets.length === 0) return null;
    for (const target of match.targets) {
      if (/^\.\.?(\/|$)/.test(target) || target.startsWith("/")) {
        const candidate = normalizeJoin(scope, target.replace(/^\//, ""));
        // An `imports` target may not leave its own package directory.
        if (candidate === null) continue;
        if (scope !== "" && candidate !== scope && !candidate.startsWith(`${scope}/`)) continue;
        const hit = probe(candidate);
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

    if (lang === "go") return resolveGo(fromDir, specifier);

    // Rule 1: relative and root-absolute specifiers.
    if (/^\.\.?(\/|$)/.test(specifier)) {
      const hit = probe(normalizeJoin(fromDir, specifier));
      return hit ? { type: "file", path: hit } : UNRESOLVED;
    }
    if (specifier.startsWith("/")) {
      const hit = probe(normalizeJoin("", specifier.slice(1)));
      return hit ? { type: "file", path: hit } : UNRESOLVED;
    }

    // "#" is reserved for package-internal imports: never an npm package name, so it
    // goes through the `imports` map and then tsconfig `paths`, but never to external.
    if (specifier.startsWith("#")) {
      const internal = resolveSubpathImport(fromDir, specifier);
      if (internal) return internal;
      const aliased = resolveTsconfig(fromDir, specifier);
      return aliased ? { type: "file", path: aliased } : UNRESOLVED;
    }

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
      const normalized = normalizeRelative(fromFile);
      const byLanguage = languageResolver(lang);
      // A schema 2 language answers on the file, not on its directory: its own module decides
      // what the right unit even is (a Python package is a directory, a Rust crate is a
      // manifest). The memo key below carries whichever of the two the answer depends on, so
      // the cache can never hand one file another file's answer.
      const fromDir = byLanguage === undefined ? parentDir(normalized) : normalized;
      const key = `${lang}\u0000${fromDir}\u0000${specifier}`;
      const cached = resultByKey.get(key);
      if (cached) return cached;
      const result =
        byLanguage === undefined ? resolveUncached(fromDir, specifier, lang) : byLanguage(normalized, specifier);
      resultByKey.set(key, result);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// tsconfig paths matching
// ---------------------------------------------------------------------------

/**
 * Substitutions for `specifier` from the single best-matching key, in the order the
 * key lists them. tsc picks one pattern - an exact key, else the longest matching
 * prefix - and never falls through to another key when its targets miss.
 */
function pathMappings(config: TsPaths, specifier: string): string[] {
  const keys = Object.keys(config.paths);
  if (keys.length === 0) return [];

  let best: string | null = null;
  for (const key of keys) {
    if (!key.includes("*")) {
      if (key === specifier) return config.paths[key] ?? [];
      continue;
    }
    if (wildcardStar(key, specifier) === null) continue;
    if (
      best === null ||
      starPrefix(key).length > starPrefix(best).length ||
      (starPrefix(key).length === starPrefix(best).length && compareStrings(key, best) < 0)
    ) {
      best = key;
    }
  }
  if (best === null) return [];

  const star = wildcardStar(best, specifier) ?? "";
  return (config.paths[best] ?? []).map((mapping) => mapping.replaceAll("*", star));
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

/**
 * The outcome of looking one subpath up in an `exports`/`imports` map.
 *
 * `blocked` means a key matched but maps to `null`: the package deliberately makes
 * that subpath unimportable, so no fallback may resolve it.
 */
interface SubpathMatch {
  targets: string[];
  blocked: boolean;
}

const NO_MATCH: SubpathMatch = { targets: [], blocked: false };
const BLOCKED: SubpathMatch = { targets: [], blocked: true };

function matched(targets: string[]): SubpathMatch {
  return { targets, blocked: false };
}

/** Candidate targets for `key` ("." or "./sub"), best first. */
function exportsTargets(exportsField: unknown, key: string): SubpathMatch {
  if (exportsField === undefined) return NO_MATCH;
  if (exportsField === null) return key === "." ? BLOCKED : NO_MATCH;
  if (typeof exportsField === "string") return key === "." ? matched([exportsField]) : NO_MATCH;
  if (Array.isArray(exportsField)) return key === "." ? conditionTargets(exportsField) : NO_MATCH;
  if (typeof exportsField !== "object") return NO_MATCH;

  const map = exportsField as Record<string, unknown>;
  const keys = Object.keys(map);
  if (keys.length === 0) return NO_MATCH;

  // Sugar: conditions (or a single target) for "." only.
  if (!keys.every((k) => k === "." || k.startsWith("./"))) {
    return key === "." ? conditionTargets(map) : NO_MATCH;
  }
  return subpathTargets(map, keys, key);
}

/** Candidate targets for a `#`-prefixed subpath import. */
function importsTargets(importsField: unknown, key: string): SubpathMatch {
  if (!importsField || typeof importsField !== "object" || Array.isArray(importsField)) return NO_MATCH;
  const map = importsField as Record<string, unknown>;
  const keys = Object.keys(map);
  if (keys.length === 0 || !keys.every((k) => k.startsWith("#"))) return NO_MATCH;
  return subpathTargets(map, keys, key);
}

/** Exact key, then `*` patterns by longest prefix, then trailing-slash folders. */
function subpathTargets(map: Record<string, unknown>, keys: string[], key: string): SubpathMatch {
  if (Object.prototype.hasOwnProperty.call(map, key)) return conditionTargets(map[key]);

  const patterns = keys
    .filter((k) => k.includes("*") && wildcardStar(k, key) !== null)
    .sort((a, b) => starPrefix(b).length - starPrefix(a).length || compareStrings(a, b));
  for (const pattern of patterns) {
    const star = wildcardStar(pattern, key) ?? "";
    const match = conditionTargets(map[pattern]);
    if (match.blocked) return BLOCKED;
    if (match.targets.length > 0) return matched(match.targets.map((t) => t.replaceAll("*", star)));
  }

  // Deprecated trailing-slash folder mappings ("./lib/": "./src/lib/").
  const folders = keys
    .filter((k) => k.endsWith("/") && key.startsWith(k))
    .sort((a, b) => b.length - a.length || compareStrings(a, b));
  for (const folder of folders) {
    const rest = key.slice(folder.length);
    const match = conditionTargets(map[folder]);
    if (match.blocked) return BLOCKED;
    if (match.targets.length > 0) {
      return matched(match.targets.map((t) => (t.endsWith("/") ? t + rest : t)));
    }
  }
  return NO_MATCH;
}

/**
 * Flatten a target: string, array, or a (possibly nested) conditions object.
 * An explicit `null` with nothing else to offer is a block, not a miss.
 */
function conditionTargets(value: unknown): SubpathMatch {
  if (typeof value === "string") return matched([value]);
  if (value === null) return BLOCKED;
  if (value === undefined) return NO_MATCH;
  if (Array.isArray(value)) {
    const targets: string[] = [];
    let blocked = false;
    for (const entry of value) {
      const match = conditionTargets(entry);
      targets.push(...match.targets);
      blocked ||= match.blocked;
    }
    // An array is a list of alternatives: a null entry is skipped while any
    // sibling still resolves, and only blocks when it is all there is.
    return targets.length > 0 ? matched(targets) : { targets, blocked };
  }
  if (typeof value !== "object") return NO_MATCH;
  const map = value as Record<string, unknown>;
  const targets: string[] = [];
  let blocked = false;
  for (const condition of EXPORT_CONDITIONS) {
    if (!Object.prototype.hasOwnProperty.call(map, condition)) continue;
    const match = conditionTargets(map[condition]);
    targets.push(...match.targets);
    blocked ||= match.blocked;
  }
  return targets.length > 0 ? matched(targets) : { targets, blocked };
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
