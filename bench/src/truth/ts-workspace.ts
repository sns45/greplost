/**
 * Workspace entry mapping for the TypeScript truth generator (leaf 1.5.1, fix round 2).
 *
 * WHY THIS EXISTS — read before changing anything here.
 *
 * A corpus repo is a bare `git clone`: no `node_modules`, no `dist/`. In that state
 * `ts.resolveModuleName` cannot resolve `import { x } from "@anyq/kafka"`, because the
 * package's `exports` map points at `./dist/index.d.ts`, which was never built, and there
 * is no `node_modules/@anyq/kafka` symlink to follow. The compiler therefore reports *no
 * dependency*, while the repo plainly has one: `packages/kafka/src/index.ts`.
 *
 * That is a gap in the oracle, not in greplost. On the anyq corpus it produced 66 phantom
 * S1 false positives (precision 0.805) for edges that are simply correct. Scoring a tool
 * against a compiler that was denied the repo's own install step measures the clone, not
 * the tool.
 *
 * So the truth generator emulates the installed-and-built state for workspace packages
 * only, and it does so *independently of greplost's resolver* — reading the same manifests
 * Node and the package manager would read, never greplost's output:
 *
 *   1. Workspace packages come from the root `package.json` `workspaces` (array or
 *      `{ packages: [...] }`) and from `pnpm-workspace.yaml`'s `packages:` globs.
 *   2. A bare specifier whose package name matches a workspace package is resolved through
 *      that package's `exports` (conditions in order `types`, `import`, `default`,
 *      `require`; subpath patterns supported), else `types`, `module`, `main`.
 *   3. The resulting *built* path is mapped back to source through the package's
 *      tsconfig `outDir`/`rootDir` (defaults `dist`/`src`), trying `.ts`, `.tsx`, `.mts`,
 *      `.cts`. The same mapping is applied to any `.d.ts` the resolver did reach that fell
 *      outside the scored file list.
 *   4. An edge is emitted only when the mapped file is in the scored file list. Nothing is
 *      invented: a specifier naming no workspace package still yields no edge.
 *
 * Anything outside the workspace (a real npm dependency) is untouched: it has no source in
 * the repo, so it is correctly not an internal edge.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import ts from "typescript";

/** Source extensions a built artifact can map back to. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;
/** Extensions stripped from a built target before source extensions are tried. */
const BUILT_EXTENSIONS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"] as const;
/**
 * `exports` conditions, in the order the ruling fixes. `types` first on purpose: it is the
 * condition that names a `.d.ts`, which is the one that maps cleanly back to a source file.
 */
const CONDITIONS = ["types", "import", "default", "require"] as const;

interface WorkspacePackage {
  /** Package name from its package.json, e.g. `@anyq/kafka`. */
  name: string;
  /** Absolute package directory. */
  dir: string;
  manifest: Record<string, unknown>;
}

/** Emulates the installed-and-built state for a repo's own workspace packages. */
export class WorkspaceEntryMapper {
  private readonly byName = new Map<string, WorkspacePackage>();
  /** Package dirs, longest first, so the innermost package wins a prefix match. */
  private readonly byDepth: WorkspacePackage[] = [];
  private readonly outRoots = new Map<string, { outDir: string; rootDir: string }>();

  private constructor(packages: WorkspacePackage[]) {
    for (const pkg of packages) if (!this.byName.has(pkg.name)) this.byName.set(pkg.name, pkg);
    this.byDepth = [...packages].sort((a, b) => b.dir.length - a.dir.length);
  }

  /** Read the workspace layout of `absRoot`. Cheap and total: an empty mapper if there is none. */
  static load(absRoot: string): WorkspaceEntryMapper {
    const globs = workspaceGlobs(absRoot);
    if (globs.length === 0) return new WorkspaceEntryMapper([]);

    let manifests: string[];
    try {
      manifests = fg.sync(
        globs.map((glob) => `${glob.replace(/\/+$/, "")}/package.json`),
        { cwd: absRoot, absolute: true, ignore: ["**/node_modules/**"], suppressErrors: true },
      );
    } catch {
      return new WorkspaceEntryMapper([]);
    }

    const packages: WorkspacePackage[] = [];
    for (const manifestPath of manifests.sort()) {
      const manifest = readJson(manifestPath);
      const name = manifest && typeof manifest["name"] === "string" ? manifest["name"] : undefined;
      if (!manifest || !name) continue;
      packages.push({ name, dir: path.dirname(manifestPath), manifest });
    }
    return new WorkspaceEntryMapper(packages);
  }

  /** True when this repo has workspace packages at all. */
  get enabled(): boolean {
    return this.byName.size > 0;
  }

  /**
   * Absolute source files a bare workspace specifier could mean, best first.
   * Empty for a relative specifier or a name that is not a workspace package.
   */
  candidatesForSpecifier(specifier: string): string[] {
    const parsed = parseSpecifier(specifier);
    if (!parsed) return [];
    const pkg = this.byName.get(parsed.name);
    if (!pkg) return [];

    const target = entryTarget(pkg.manifest, parsed.subpath);
    if (target === undefined) return [];
    // `exports` targets are always package-relative and start with "./".
    const absolute = path.resolve(pkg.dir, target.replace(/^\.\//, ""));
    return this.candidatesForBuiltFile(absolute);
  }

  /**
   * Absolute source files a built artifact could have come from, best first.
   * Used both for `exports` targets and for a `.d.ts` the resolver reached that fell
   * outside the scored file list.
   */
  candidatesForBuiltFile(absolute: string): string[] {
    const pkg = this.byDepth.find((candidate) => isInside(candidate.dir, absolute));
    const base = stripBuiltExtension(absolute);
    const out: string[] = [];
    const push = (candidate: string): void => {
      if (!out.includes(candidate)) out.push(candidate);
    };

    if (pkg) {
      const { outDir, rootDir } = this.outAndRootDir(pkg);
      const relative = path.relative(outDir, base);
      if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        for (const ext of SOURCE_EXTENSIONS) push(path.join(rootDir, relative + ext));
        for (const ext of SOURCE_EXTENSIONS) push(path.join(rootDir, relative, `index${ext}`));
      }
    }
    // The target may already point at source (`exports: "./src/index.ts"`), and a `.js`
    // specifier for a `.ts` file lands here too.
    for (const ext of SOURCE_EXTENSIONS) push(base + ext);
    for (const ext of SOURCE_EXTENSIONS) push(path.join(base, `index${ext}`));
    return out;
  }

  /**
   * The package's build layout. `outDir`/`rootDir` come from the nearest tsconfig.json at or
   * above the package directory (with `extends` followed by the compiler itself), defaulting
   * to `<pkg>/dist` and `<pkg>/src`. A tsconfig further up whose `outDir` lands outside the
   * package is ignored: it describes that directory, not this package.
   */
  private outAndRootDir(pkg: WorkspacePackage): { outDir: string; rootDir: string } {
    const cached = this.outRoots.get(pkg.dir);
    if (cached) return cached;

    const fallback = { outDir: path.join(pkg.dir, "dist"), rootDir: path.join(pkg.dir, "src") };
    let resolved = fallback;
    const configPath = path.join(pkg.dir, "tsconfig.json");
    if (existsSync(configPath)) {
      const read = ts.readConfigFile(configPath, ts.sys.readFile);
      if (!read.error && read.config) {
        const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, pkg.dir);
        const outDir = parsed.options.outDir;
        const rootDir = parsed.options.rootDir;
        resolved = {
          outDir: outDir && isInside(pkg.dir, outDir) ? outDir : fallback.outDir,
          rootDir: rootDir && isInside(pkg.dir, rootDir) ? rootDir : fallback.rootDir,
        };
      }
    }
    this.outRoots.set(pkg.dir, resolved);
    return resolved;
  }
}

// ---------------------------------------------------------------------------
// workspace discovery
// ---------------------------------------------------------------------------

/** Workspace globs from package.json and pnpm-workspace.yaml, in that order, deduped. */
function workspaceGlobs(absRoot: string): string[] {
  const globs: string[] = [];

  const manifest = readJson(path.join(absRoot, "package.json"));
  const workspaces = manifest?.["workspaces"];
  if (Array.isArray(workspaces)) {
    for (const glob of workspaces) if (typeof glob === "string") globs.push(glob);
  } else if (workspaces && typeof workspaces === "object") {
    const packages = (workspaces as Record<string, unknown>)["packages"];
    if (Array.isArray(packages)) for (const glob of packages) if (typeof glob === "string") globs.push(glob);
  }

  for (const name of ["pnpm-workspace.yaml", "pnpm-workspace.yml"]) {
    const text = readText(path.join(absRoot, name));
    if (text) globs.push(...pnpmPackageGlobs(text));
  }

  // Negated globs ("!apps/legacy") are dropped rather than half-honoured: a package that
  // slips through is harmless, because an edge is still only emitted for a listed file.
  return [...new Set(globs.filter((glob) => glob.length > 0 && !glob.startsWith("!")))];
}

/**
 * The `packages:` list of a pnpm-workspace.yaml, without a YAML dependency: the file's one
 * relevant shape is a top-level `packages:` key followed by indented `- glob` items.
 */
function pnpmPackageGlobs(text: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (line.trim().length === 0) continue;
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = line.match(/^\s+-\s*(.+)$/);
    if (!item) break; // back to column 0: the packages list is over
    globs.push((item[1] ?? "").trim().replace(/^["']|["']$/g, ""));
  }
  return globs.filter((glob) => glob.length > 0);
}

// ---------------------------------------------------------------------------
// package entry resolution
// ---------------------------------------------------------------------------

/** Split a bare specifier into its package name and subpath (`.` or `./sub`). */
function parseSpecifier(specifier: string): { name: string; subpath: string } | undefined {
  if (specifier.length === 0) return undefined;
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) return undefined;
  const segments = specifier.split("/");
  const nameLength = specifier.startsWith("@") ? 2 : 1;
  if (segments.length < nameLength) return undefined;
  const name = segments.slice(0, nameLength).join("/");
  const rest = segments.slice(nameLength).join("/");
  return { name, subpath: rest.length === 0 ? "." : `./${rest}` };
}

/** The package-relative entry a subpath resolves to: `exports` first, then the legacy fields. */
function entryTarget(manifest: Record<string, unknown>, subpath: string): string | undefined {
  const fromExports = resolveExports(manifest["exports"], subpath);
  if (fromExports !== undefined) return fromExports;
  if (subpath !== ".") return undefined; // legacy fields only ever describe the root entry
  for (const field of ["types", "module", "main"]) {
    const value = manifest[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Resolve a subpath through an `exports` field, honouring subpath maps and patterns. */
function resolveExports(exportsField: unknown, subpath: string): string | undefined {
  if (typeof exportsField === "string") return subpath === "." ? exportsField : undefined;
  if (Array.isArray(exportsField)) {
    for (const item of exportsField) {
      const resolved = resolveExports(item, subpath);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }
  if (!exportsField || typeof exportsField !== "object") return undefined;

  const record = exportsField as Record<string, unknown>;
  const keys = Object.keys(record);
  const isSubpathMap = keys.some((key) => key === "." || key.startsWith("./"));
  // A bare conditions object (`exports: { types, import }`) describes the root entry only.
  if (!isSubpathMap) return subpath === "." ? pickCondition(record) : undefined;

  const exact = record[subpath];
  if (exact !== undefined) return pickCondition(exact);

  // Pattern keys, longest static prefix first, as Node resolves them.
  const patterns = keys
    .filter((key) => key.includes("*"))
    .sort((a, b) => b.slice(0, b.indexOf("*")).length - a.slice(0, a.indexOf("*")).length);
  for (const key of patterns) {
    const captured = matchPattern(key, subpath);
    if (captured === undefined) continue;
    const target = pickCondition(record[key]);
    if (target !== undefined) return target.replace(/\*/g, captured);
  }
  return undefined;
}

/** Walk a conditions object in the fixed condition order, following nesting and arrays. */
function pickCondition(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = pickCondition(item);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const condition of CONDITIONS) {
    if (condition in record) {
      const resolved = pickCondition(record[condition]);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}

/** The `*` capture of an `exports` pattern key against a subpath, if it matches. */
function matchPattern(key: string, subpath: string): string | undefined {
  const star = key.indexOf("*");
  if (star === -1) return undefined;
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) return undefined;
  if (subpath.length < prefix.length + suffix.length) return undefined;
  return subpath.slice(prefix.length, subpath.length - suffix.length);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Drop a built or source extension, including the two-part `.d.ts` family. */
function stripBuiltExtension(file: string): string {
  const declaration = file.match(/^(.*)\.d\.(?:ts|mts|cts)$/);
  if (declaration) return declaration[1] as string;
  const extension = path.extname(file);
  return (BUILT_EXTENSIONS as readonly string[]).includes(extension) ? file.slice(0, -extension.length) : file;
}

function isInside(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  const text = readText(file);
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
