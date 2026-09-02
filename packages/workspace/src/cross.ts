/**
 * Cross-repo edges (tech spec 4.4, workspace spec "Rules").
 *
 * One repo's map cannot see another's. What it does record is every import it
 * could not resolve inside itself, as `ext:<package>` — and that is exactly the
 * evidence a workspace needs: if repo B imports `ext:@fx/a` and repo A publishes
 * `@fx/a`, the two repos are joined by that import, at the file that wrote it.
 *
 * Only names a sibling actually publishes count. An `ext:` target is matched
 * against the npm package names a sibling's own `package.json` files declare,
 * and against the module paths its `go.mod` files declare; nothing is inferred
 * from a directory name, so a package that happens to share a name with an
 * unrelated npm dependency cannot invent an edge. This is the v1 rule the tech
 * spec fixes; declared contracts (OpenAPI, proto, topic literals) are v2.
 *
 * Nothing here reads a workspace artifact. Cross edges are recomputed from the
 * repos' committed maps every time, so `impact` can never answer from a stale
 * `cross.jsonl` and `verify` has something independent to compare against.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { readStructure } from "@greplost/core";
import type { Structure } from "@greplost/core";
import { filesByDirectory } from "@greplost/core/graph";
import type { ImportEdge } from "@greplost/core/schema";
import { ARTIFACT_DIR, compareEdges, compareStrings } from "@greplost/core/schema";

import { isDirectory, workspaceId } from "./config.ts";

/**
 * One import that crosses a repository boundary.
 *
 * `kind` is always `"import"`: a re-export across repos is still one repo
 * depending on another, and the field exists so the line is shaped like a core
 * `Edge`. `confidence` is always `"high"` — the target is a package name a
 * sibling literally declares, never a guess.
 */
export interface CrossEdge {
  /** `<repoDir>::<file>` in the importing repo. */
  from: string;
  /** `<repoDir>::<file>`, `<repoDir>::<package directory>` (Go), or `<repoDir>::pkg:<name>`. */
  to: string;
  kind: "import";
  symbols?: string[];
  confidence: "high";
  /** The specifier as written, so a reader can find the import statement. */
  specifier: string;
}

/** A cross edge with the parts `WORKSPACE.md` renders but `cross.jsonl` does not repeat. */
export interface ResolvedCross {
  edge: CrossEdge;
  fromRepo: string;
  fromFile: string;
  toRepo: string;
  /** The sibling package name the specifier matched. */
  toPackage: string;
}

/** Everything the workspace layer needs from one repo's committed map. */
export interface RepoView {
  /** Workspace-relative directory, e.g. `repo-a`. */
  dir: string;
  absolute: string;
  /** Root package name, or the directory's own name when the repo declares none. */
  name: string;
  /** Package names the repo's map records, sorted. */
  packages: string[];
  /** Indexed repo-relative files, sorted. */
  files: string[];
  fileSet: Set<string>;
  filesByDir: Map<string, string[]>;
  imports: ImportEdge[];
  /** True when `.greplost/manifest.json` was readable. */
  indexed: boolean;
  /** npm package names this repo publishes -> entry file id, when one is indexed. */
  npmPackages: Map<string, string | undefined>;
  /** Go module paths this repo publishes -> the module's repo-relative directory. */
  goModules: Map<string, string>;
}

/**
 * Load one repo's committed map.
 *
 * An unindexed repo is not an error here: `verifyWorkspace` has to be able to
 * report "this repo has no map" as a divergence rather than crash, and the
 * build path calls `ensureRepoMap` first so it never sees one.
 */
export function readRepo(root: string, dir: string): RepoView {
  const absolute = path.join(path.resolve(root), dir);
  const structure = readStructureOf(absolute);

  const files = structure === null ? [] : Object.keys(structure.manifest.files).sort(compareStrings);
  const packages = structure === null ? [] : Object.keys(structure.manifest.packages).sort(compareStrings);

  const view: RepoView = {
    dir,
    absolute,
    name: repoName(absolute, structure, dir),
    packages,
    files,
    fileSet: new Set(files),
    filesByDir: filesByDirectory(files),
    imports: structure?.imports ?? [],
    indexed: structure !== null,
    npmPackages: new Map(),
    goModules: new Map(),
  };

  // The published name is the one the package itself declares, not the name the
  // repo's manifest happens to key it under: core renames duplicates and falls
  // back to a directory basename, and neither of those is a name a sibling
  // could ever import. A Go module's identity is its `module` path, which core
  // deliberately shortens to the last segment for display.
  for (const name of packages) {
    const entry = structure?.manifest.packages[name];
    if (entry === undefined) continue;

    const manifest = readJson(path.join(absolute, entry.path, "package.json"));
    const declared = manifest !== null && typeof manifest["name"] === "string" ? manifest["name"].trim() : "";
    if (manifest !== null && declared !== "") {
      view.npmPackages.set(declared, entryFile(view, entry.path, manifest));
      continue;
    }

    const module = goModulePath(readText(path.join(absolute, entry.path, "go.mod")));
    if (module !== "") view.goModules.set(module, normalizeDir(entry.path));
  }

  return view;
}

/**
 * Every cross edge in the workspace, deduplicated and sorted.
 *
 * Both `import` and `reexport` edges are considered: `export * from "@fx/a"` is
 * as real a dependency on a sibling as an import is, and dropping it would lose
 * the file it happens in from every downstream blast radius.
 */
export function crossEdges(repos: readonly RepoView[]): ResolvedCross[] {
  const ordered = [...repos].sort((a, b) => compareStrings(a.dir, b.dir));
  const out: ResolvedCross[] = [];

  for (const from of ordered) {
    for (const edge of from.imports) {
      if (edge.kind !== "import" && edge.kind !== "reexport") continue;
      if (!edge.to.startsWith("ext:")) continue;
      if (!from.fileSet.has(edge.from)) continue;

      const match = matchSibling(ordered, from, edge.to.slice("ext:".length));
      if (match === null) continue;

      const symbols = edge.symbols ?? [];
      out.push({
        edge: {
          from: workspaceId(from.dir, edge.from),
          to: workspaceId(match.repo.dir, match.target),
          kind: "import",
          ...(symbols.length === 0 ? {} : { symbols: [...symbols] }),
          confidence: "high",
          specifier: edge.specifier,
        },
        fromRepo: from.dir,
        fromFile: edge.from,
        toRepo: match.repo.dir,
        toPackage: match.pkg,
      });
    }
  }

  out.sort(
    (a, b) =>
      compareEdges(a.edge, b.edge) ||
      compareStrings(a.edge.specifier, b.edge.specifier) ||
      compareStrings(a.toPackage, b.toPackage),
  );

  const deduped: ResolvedCross[] = [];
  for (const cross of out) {
    const previous = deduped[deduped.length - 1];
    if (
      previous !== undefined &&
      compareEdges(previous.edge, cross.edge) === 0 &&
      previous.edge.specifier === cross.edge.specifier
    ) {
      continue;
    }
    deduped.push(cross);
  }
  return deduped;
}

interface SiblingMatch {
  repo: RepoView;
  /** Repo-relative target inside the sibling: a file, a package directory, or `pkg:<name>`. */
  target: string;
  pkg: string;
}

/**
 * The sibling an `ext:<pkg>` target belongs to, or `null`.
 *
 * An exact npm name wins over a Go module prefix, and a longer module path wins
 * over a shorter one, so nesting cannot make the answer depend on repo order.
 * Ties between two siblings publishing the same name go to the first repo
 * directory in sorted order, which is at least deterministic; a workspace that
 * does that has a real ambiguity nothing here can resolve.
 */
function matchSibling(repos: readonly RepoView[], from: RepoView, pkg: string): SiblingMatch | null {
  for (const repo of repos) {
    if (repo.dir === from.dir) continue;
    if (!repo.npmPackages.has(pkg)) continue;
    const entry = repo.npmPackages.get(pkg);
    return { repo, target: entry ?? `pkg:${pkg}`, pkg };
  }

  let best: SiblingMatch | null = null;
  let bestLength = -1;
  for (const repo of repos) {
    if (repo.dir === from.dir) continue;
    for (const [module, moduleDir] of repo.goModules) {
      if (pkg !== module && !pkg.startsWith(`${module}/`)) continue;
      if (module.length <= bestLength) continue;
      bestLength = module.length;
      const subpath = pkg.slice(module.length).replace(/^\//, "");
      best = { repo, target: goTarget(repo, moduleDir, subpath, module), pkg: module };
    }
  }
  return best;
}

/**
 * A Go import path inside a sibling module: its package **directory**.
 *
 * A Go import names a package, not a file (tech spec Appendix C), so the
 * directory id is the Go analogue of the npm entry file, and `impactAcross`
 * expands it to that directory's files exactly as core does inside one repo. A
 * directory the sibling does not index falls back to the package pseudo-id.
 */
function goTarget(repo: RepoView, moduleDir: string, subpath: string, module: string): string {
  const dir = normalizeDir(subpath === "" ? moduleDir : joinRelative(moduleDir, subpath));
  return (repo.filesByDir.get(dir) ?? []).length > 0 ? dir : `pkg:${module}`;
}

/**
 * The indexed file a package's `exports`/`main` points at, or `undefined`.
 *
 * Every condition of `exports` is collected in a fixed order and the first
 * candidate that is actually in the sibling's map wins, so a package whose
 * `exports` names both a built `dist/index.js` and a `source` entry resolves to
 * the one the map has. A short extension probe covers the common extensionless
 * `main`. Nothing is invented: a package that ships only built output the map
 * does not index has no entry file, and its edges land on `pkg:<name>`.
 */
function entryFile(repo: RepoView, packagePath: string, manifest: Record<string, unknown>): string | undefined {
  const candidates = [...exportTargets(manifest["exports"], 0)];
  if (typeof manifest["main"] === "string") candidates.push(manifest["main"]);

  const base = normalizeDir(packagePath);
  for (const candidate of candidates) {
    const joined = normalizeJoin(base, candidate);
    if (joined === null) continue;
    for (const probe of probes(joined)) {
      if (repo.fileSet.has(probe)) return probe;
    }
  }
  return undefined;
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

/** Every string an `exports` value can resolve to, richest condition first. */
function exportTargets(value: unknown, depth: number): string[] {
  if (depth > MAX_EXPORTS_DEPTH) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => exportTargets(entry, depth + 1));
  if (value === null || typeof value !== "object") return [];

  const map = value as Record<string, unknown>;
  const keys = Object.keys(map);
  // A subpath map: only the package's own entry point is relevant here.
  if (keys.some((key) => key.startsWith("."))) {
    return Object.hasOwn(map, ".") ? exportTargets(map["."], depth + 1) : [];
  }

  const out: string[] = [];
  for (const condition of EXPORT_CONDITIONS) {
    if (Object.hasOwn(map, condition)) out.push(...exportTargets(map[condition], depth + 1));
  }
  for (const key of keys.sort(compareStrings)) {
    if (!EXPORT_CONDITIONS.includes(key)) out.push(...exportTargets(map[key], depth + 1));
  }
  return out;
}

/** The file ids one entry-point path could mean, most literal first. */
function probes(target: string): string[] {
  const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  return [target, ...extensions.map((ext) => `${target}${ext}`), ...extensions.map((ext) => `${target}/index${ext}`)];
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

function readStructureOf(repoAbsolute: string): Structure | null {
  const artifactDir = path.join(repoAbsolute, ARTIFACT_DIR);
  if (!isDirectory(artifactDir)) return null;
  return readStructure(artifactDir);
}

/** The repo's own name: its root package, else its manifest or go.mod, else its directory. */
function repoName(absolute: string, structure: Structure | null, dir: string): string {
  if (structure !== null) {
    for (const [name, entry] of Object.entries(structure.manifest.packages)) {
      if (normalizeDir(entry.path) === ".") return name;
    }
  }
  const manifest = readJson(path.join(absolute, "package.json"));
  if (manifest !== null && typeof manifest["name"] === "string" && manifest["name"].trim() !== "") {
    return manifest["name"].trim();
  }
  const module = goModulePath(readText(path.join(absolute, "go.mod")));
  return module === "" ? path.basename(dir) : module;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJson(file: string): Record<string, unknown> | null {
  const text = readText(file);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The `module <path>` directive of a `go.mod`, or `""`.
 *
 * Core parses this too, behind `detectPackages`, but does not export the
 * parser; five lines here is cheaper than a change to a driver-owned package.
 */
export function goModulePath(text: string | null): string {
  if (text === null) return "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    const match = /^module\s+(.+)$/.exec(line);
    if (match === null) continue;
    const value = (match[1] ?? "").trim();
    return value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1) : value;
  }
  return "";
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/** A repo-relative directory as the map spells it: posix, no `./`, `"."` at the root. */
function normalizeDir(dir: string): string {
  const segments: string[] = [];
  for (const segment of dir.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    segments.push(segment);
  }
  return segments.length === 0 ? "." : segments.join("/");
}

function joinRelative(dir: string, rest: string): string {
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
