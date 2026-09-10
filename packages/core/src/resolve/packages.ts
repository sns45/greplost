/**
 * Package detection (core-extract spec, "Package detection").
 *
 * `detectPackages` is the only part of the resolve layer that touches the file
 * system: it reads manifests under `root` (package.json, go.mod,
 * pnpm-workspace.yaml, go.work) and expands the workspace globs. It only ever
 * looks at directories that hold an indexed file or that a glob expansion
 * reached, and every collection it produces is sorted with `compareStrings`, so
 * two runs over the same tree return the same list.
 *
 * A package.json is a package only inside a workspace glob (`packages.roots`,
 * the root package.json's `workspaces`, pnpm-workspace.yaml, go.work), because
 * npm alone says nothing about which nested manifests belong to the repo. A
 * go.mod needs no glob: the Go toolchain treats every module directory as a
 * unit whether or not a go.work lists it, so build 2.2 ruling 12 makes every
 * go.mod in the indexed tree a package rooted at its own directory. Otherwise a
 * Go monorepo whose modules sit outside `packages/*` and `apps/*` folds its
 * whole source tree into the root package, which is what issue 12 reported.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { compareStrings } from "../schema.ts";
import type { GreplostConfig, PackageInfo } from "../schema.ts";

/** Directory names never walked while expanding a workspace glob. */
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".cache",
  ".git",
  ".greplost",
  ".hg",
  ".next",
  ".svn",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "vendor",
]);

interface Manifest {
  name: string;
  source: "package.json" | "go.mod";
}

/**
 * Every package in the repo, sorted by path with the root package (".") first.
 *
 * `files` is the indexed, repo-relative file set (forward slashes). `config`
 * supplies `packages.roots`; the root manifests supply the rest of the globs.
 */
export function detectPackages(root: string, files: string[], config: GreplostConfig): PackageInfo[] {
  const read = (rel: string): string | null => readTextFile(root, rel);
  const packages: PackageInfo[] = [{ name: rootPackageName(read), path: ".", source: "root" }];

  const patterns = workspacePatterns(config, read);
  const insideGlob = patterns.length === 0 ? () => false : picomatch(patterns, { dot: true });
  // A repo with no indexed Go file has no Go module worth finding, and skipping
  // the probe keeps a TypeScript or Terraform build from opening a go.mod that
  // cannot exist once per directory.
  const probeGoMod = files.some(isGoFile);

  for (const dir of candidateDirectories(root, files, patterns)) {
    const glob = insideGlob(dir);
    if (!glob && !probeGoMod) continue;
    const manifest = readManifest(dir, read, { glob, goMod: probeGoMod });
    if (manifest) packages.push({ name: manifest.name, path: dir, source: manifest.source });
  }

  renameDuplicates(packages);
  return packages;
}

/** The package owning `path`: the deepest package directory that prefixes it, else the root. */
export function packageOf(filePath: string, packages: PackageInfo[]): PackageInfo {
  const normalized = normalizeRelative(filePath);
  let best: PackageInfo | undefined;
  let root: PackageInfo | undefined;
  for (const pkg of packages) {
    if (pkg.path === "." || pkg.path === "") {
      if (!root) root = pkg;
      continue;
    }
    const prefix = `${pkg.path}/`;
    if (!normalized.startsWith(prefix)) continue;
    if (!best || pkg.path.length > best.path.length) best = pkg;
  }
  if (best) return best;
  if (root) return root;
  const fallback = packages[0];
  if (fallback) return fallback;
  throw new Error("greplost: packageOf called with an empty package list");
}

// ---------------------------------------------------------------------------
// root package
// ---------------------------------------------------------------------------

/**
 * The name of the package at `.`: the root `package.json`'s, else the root
 * `go.mod`'s module, else the literal `root`.
 *
 * Not the checkout directory's basename, which is the one candidate that is a
 * property of the machine rather than of the repository. That name reaches
 * `manifest.packages`, every `manifest.files[*].pkg`, the `packages/<slug>/`
 * artifact directory and the INDEX/MAP titles, so deriving it from the
 * directory would make two clones of one repository produce two different maps
 * and `greplost verify` fail across machines, exactly what the determinism
 * contract of tech spec 5.3 forbids.
 *
 * That is also why a root module path of one segment keeps the segment instead
 * of falling back to the directory the way a nested go.mod does: at `.` the
 * directory is the checkout, and the checkout has no name the repository owns.
 * The root package stays `source: "root"`, found because it is the root rather
 * than because a manifest named it, whichever manifest supplied the name.
 */
function rootPackageName(read: (rel: string) => string | null): string {
  const pkg = parseJson(read("package.json"));
  const name = pkg && typeof pkg["name"] === "string" ? pkg["name"].trim() : "";
  if (name) return name;

  const segments = goModuleSegments(read("go.mod"));
  const goModule = segments[segments.length - 1] ?? "";
  if (goModule) return goModule;

  return "root";
}

// ---------------------------------------------------------------------------
// workspace globs
// ---------------------------------------------------------------------------

function workspacePatterns(config: GreplostConfig, read: (rel: string) => string | null): string[] {
  const patterns = new Set<string>();
  const add = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const pattern = normalizePattern(raw);
    if (pattern) patterns.add(pattern);
  };

  for (const glob of config.packages?.roots ?? []) add(glob);

  const rootPkg = parseJson(read("package.json"));
  if (rootPkg) {
    const workspaces = rootPkg["workspaces"];
    if (Array.isArray(workspaces)) {
      for (const entry of workspaces) add(entry);
    } else if (workspaces && typeof workspaces === "object") {
      const nested = (workspaces as Record<string, unknown>)["packages"];
      if (Array.isArray(nested)) for (const entry of nested) add(entry);
    }
  }

  for (const entry of pnpmWorkspacePackages(read("pnpm-workspace.yaml"))) add(entry);
  for (const entry of goWorkUseEntries(read("go.work"))) add(entry);

  return [...patterns].sort(compareStrings);
}

/** `packages:` entries of a pnpm-workspace.yaml, as written (block or flow sequence). */
function pnpmWorkspacePackages(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  let inList = false;
  for (const line of lines) {
    if (!inList) {
      const header = /^packages:\s*(.*)$/.exec(line);
      if (!header) continue;
      const inline = (header[1] ?? "").trim();
      if (inline.startsWith("[")) {
        for (const entry of inline.replace(/^\[/, "").replace(/\].*$/, "").split(",")) {
          const value = unquote(entry.trim());
          if (value) out.push(value);
        }
        return out;
      }
      inList = true;
      continue;
    }
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (!item) break; // a sibling key ends the sequence
    const value = unquote(stripYamlComment(item[1] ?? ""));
    if (value) out.push(value);
  }
  return out;
}

/** `use` entries of a go.work file, single-line and parenthesised block forms. */
function goWorkUseEntries(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripGoComment(raw).trim();
    if (!line) continue;
    if (inBlock) {
      if (line.startsWith(")")) {
        inBlock = false;
        continue;
      }
      const value = unquote(line);
      if (value) out.push(value);
      continue;
    }
    const block = /^use\s*\($/.exec(line);
    if (block) {
      inBlock = true;
      continue;
    }
    const single = /^use\s+(.+)$/.exec(line);
    if (single) {
      const value = unquote((single[1] ?? "").trim());
      if (value) out.push(value);
    }
  }
  return out;
}

/**
 * Repo-relative directories that could be packages, sorted, never ".".
 *
 * Every directory holding an indexed file, every ancestor of one, and every
 * directory a workspace glob expanded to. The glob filter is applied by the
 * caller, not here, because a go.mod is a package wherever it sits.
 */
function candidateDirectories(root: string, files: string[], patterns: string[]): string[] {
  const candidates = new Set<string>();
  for (const file of files) {
    let dir = parentDir(normalizeRelative(file));
    while (dir) {
      if (candidates.has(dir)) break;
      candidates.add(dir);
      dir = parentDir(dir);
    }
  }
  for (const pattern of patterns) {
    for (const dir of expandPattern(root, pattern)) candidates.add(dir);
  }
  return [...candidates].sort(compareStrings);
}

/** Directories on disk matching one workspace glob, without walking ignored trees. */
function expandPattern(root: string, pattern: string): string[] {
  let current = [""];
  for (const segment of pattern.split("/")) {
    if (!segment || segment === ".") continue;
    const next = new Set<string>();
    if (segment === "**") {
      for (const dir of current) {
        next.add(dir);
        for (const nested of descendants(root, dir)) next.add(nested);
      }
    } else if (isGlobSegment(segment)) {
      const isMatch = picomatch(segment, { dot: true });
      for (const dir of current) {
        for (const child of subdirectories(root, dir)) {
          if (isMatch(child)) next.add(joinRelative(dir, child));
        }
      }
    } else {
      for (const dir of current) {
        const candidate = joinRelative(dir, segment);
        if (isDirectory(root, candidate)) next.add(candidate);
      }
    }
    current = [...next].sort(compareStrings);
    if (current.length === 0) return [];
  }
  return current.filter((dir) => dir !== "");
}

function descendants(root: string, dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const child of subdirectories(root, current)) {
      if (IGNORED_DIRS.has(child)) continue;
      const next = joinRelative(current, child);
      out.push(next);
      stack.push(next);
    }
  }
  return out.sort(compareStrings);
}

function subdirectories(root: string, dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir === "" ? root : path.join(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  // Symlinked directories are deliberately not followed: they would let a
  // "**" pattern walk in a cycle, and an indexed file under one already puts
  // its directory in the candidate set.
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) out.push(entry.name);
  }
  return out.sort(compareStrings);
}

function isDirectory(root: string, rel: string): boolean {
  try {
    return statSync(rel === "" ? root : path.join(root, rel)).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// manifests
// ---------------------------------------------------------------------------

/**
 * The manifest making `dir` a package, or null.
 *
 * `look.glob` says the directory sits inside a workspace glob, which is what a
 * package.json needs; `look.goMod` says the repo has indexed Go files, so a
 * go.mod probe is worth a syscall. A directory holding both manifests inside a
 * glob is one package, not two, and package.json wins the name so a workspace
 * member keeps the name its dependents import it by.
 */
function readManifest(
  dir: string,
  read: (rel: string) => string | null,
  look: { glob: boolean; goMod: boolean },
): Manifest | null {
  if (look.glob) {
    const pkgJsonText = read(`${dir}/package.json`);
    if (pkgJsonText !== null) {
      const pkgJson = parseJson(pkgJsonText);
      const name = pkgJson && typeof pkgJson["name"] === "string" ? pkgJson["name"].trim() : "";
      // A package.json present but unparseable is still a package, named after its directory.
      return { name: name || basename(dir), source: "package.json" };
    }
  }
  if (!look.goMod) return null;
  const goMod = read(`${dir}/go.mod`);
  if (goMod === null) return null;
  return { name: goPackageName(goMod, dir), source: "go.mod" };
}

/**
 * A Go module path's segments, with a major-version suffix (`/v2`, `/v12`)
 * dropped. Empty when the file declares no module.
 *
 * The suffix is part of the import path, never part of the name: `bar/v2` and
 * `bar` are the same library, and a package called "v2" says nothing at all.
 */
function goModuleSegments(text: string | null): string[] {
  if (text === null) return [];
  for (const raw of text.split(/\r?\n/)) {
    const line = stripGoComment(raw).trim();
    const match = /^module\s+(.+)$/.exec(line);
    if (!match) continue;
    const modulePath = unquote((match[1] ?? "").trim());
    const segments = modulePath.split("/").filter((s) => s.length > 0);
    const last = segments.length - 1;
    if (last > 0 && /^v\d+$/.test(segments[last] ?? "")) segments.pop();
    return segments;
  }
  return [];
}

/**
 * The package name for a go.mod at `dir`: the module path's last segment.
 *
 * A module path of one segment falls back to the directory basename, because
 * that single segment is a bare host (`module example.com`) or an unqualified
 * name, and the directory reads better in a map either way.
 */
function goPackageName(text: string, dir: string): string {
  const segments = goModuleSegments(text);
  if (segments.length < 2) return basename(dir);
  return segments[segments.length - 1] ?? basename(dir);
}

/** Keep the first package of a duplicated name; later ones become `<name> (<path>)`. */
function renameDuplicates(packages: PackageInfo[]): void {
  const seen = new Set<string>();
  for (const pkg of packages) {
    if (seen.has(pkg.name)) pkg.name = `${pkg.name} (${pkg.path})`;
    seen.add(pkg.name);
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function readTextFile(root: string, rel: string): string | null {
  try {
    return readFileSync(path.join(root, rel), "utf8");
  } catch {
    return null;
  }
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizePattern(raw: string): string {
  const pattern = raw.replace(/\\/g, "/").trim();
  if (!pattern || pattern.startsWith("!")) return ""; // negations are not supported in v1
  return pattern.replace(/^\.\//, "").replace(/\/+$/, "");
}

function normalizeRelative(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function parentDir(p: string): string {
  const index = p.lastIndexOf("/");
  return index === -1 ? "" : p.slice(0, index);
}

function isGoFile(p: string): boolean {
  return p.endsWith(".go");
}

function basename(p: string): string {
  const index = p.lastIndexOf("/");
  return index === -1 ? p : p.slice(index + 1);
}

function joinRelative(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

function isGlobSegment(segment: string): boolean {
  return /[*?[\]{}!+@(]/.test(segment);
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function stripYamlComment(line: string): string {
  const index = line.indexOf(" #");
  return index === -1 ? line : line.slice(0, index);
}

function stripGoComment(line: string): string {
  const index = line.indexOf("//");
  return index === -1 ? line : line.slice(0, index);
}
