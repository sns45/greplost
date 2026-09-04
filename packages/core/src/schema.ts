/**
 * greplost shared schema: the interface contract between every sub-project.
 *
 * Owned by the driver. Leaves import types from "@greplost/core/schema" and
 * never edit this file; a needed change is reported, not made.
 *
 * Determinism contract (tech spec 5.3) restated for implementers:
 *  - Node id: files are `<repo-relative-path>` (forward slashes, no leading "./");
 *    symbols are `<path>#<symbol-path>` (e.g. `packages/core/src/registry.ts#Registry.register`);
 *    packages are `pkg:<name>`; externals are `ext:<package-name>`;
 *    unresolvable relative specifiers are `unresolved:<specifier>`.
 *  - Ordering: every collection is sorted with `compareStrings` (code-unit order,
 *    never localeCompare). Edges sort by (from, to, kind, symbols joined by ",").
 *    Declarations sort by (file, span[0], id).
 *  - JSON: keys sorted recursively; manifest.json is 2-space indented; JSONL is one
 *    compact object per line, sorted keys, "\n" terminated, trailing newline.
 *  - No timestamps, absolute paths, machine names, or environment values anywhere
 *    in structure-layer output.
 */

export const SCHEMA_VERSION = "1";

/** Artifact directory name, relative to the repo root. */
export const ARTIFACT_DIR = ".greplost";

/** Structure-layer artifact paths, relative to ARTIFACT_DIR. */
export const ARTIFACT_PATHS = {
  index: "INDEX.md",
  manifest: "manifest.json",
  imports: "graph/imports.jsonl",
  calls: "graph/calls.jsonl",
  symbols: "graph/symbols.jsonl",
  /** Schema 2: references that are neither imports nor calls (IaC references, config-to-code links). */
  references: "graph/references.jsonl",
  repoMap: "repo/MAP.md",
  hotspots: "repo/HOTSPOTS.md",
  config: "config.json",
  summaries: "cache/summaries.json",
  /** Runtime files, never committed (listed in `.greplost/.gitignore`). */
  dirty: ".dirty",
  lock: ".lock",
  state: ".state.json",
} as const;

export type Lang =
  | "ts"
  | "tsx"
  | "js"
  | "jsx"
  | "go"
  | "python"
  | "rust"
  | "java"
  | "kotlin"
  | "hcl"
  | "yaml"
  | "dockerfile";

export const LANG_BY_EXTENSION: Readonly<Record<string, Lang>> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".go": "go",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".tf": "hcl",
  ".tfvars": "hcl",
  ".hcl": "hcl",
  ".yaml": "yaml",
  ".yml": "yaml",
};

/** Languages keyed by exact basename, for files that have no extension (schema 2, ruling 2026-09-04). */
export const LANG_BY_BASENAME: Readonly<Record<string, Lang>> = {
  Dockerfile: "dockerfile",
  Containerfile: "dockerfile",
};

/** Basename prefixes that also mean Dockerfile (`Dockerfile.dev`, `Dockerfile.ci`). */
export const DOCKERFILE_PREFIX = "Dockerfile.";

export type DeclKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "let"
  | "var"
  | "method"
  | "struct"
  | "namespace"
  /* schema 2 (ruling 2026-09-04): more languages, IaC and framework signals */
  | "trait"
  | "impl"
  | "record"
  | "module"
  | "resource"
  | "data"
  | "variable"
  | "output"
  | "provider"
  | "job"
  | "step"
  | "stage"
  | "image"
  | "component"
  | "route"
  | "handler"
  | "task";

/** One declaration. Persisted as a line of graph/symbols.jsonl. */
export interface Declaration {
  /** `<file>#<symbolPath>` */
  id: string;
  /** Repo-relative file path. */
  file: string;
  /** Symbol path: `name` for top-level, `Parent.name` for members. */
  name: string;
  kind: DeclKind;
  /**
   * Signature as written: declaration header with whitespace collapsed to
   * single spaces, without the body, at most 200 characters (then "…").
   * Examples: `export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T>`,
   * `class SqsAdapter implements Queue`, `async publish(body: string): Promise<Ack>`,
   * `export const DEFAULT_ATTEMPTS = 3`, `export type Ack = { ok: true; id: string } | { ok: false; reason: string }`.
   */
  signature: string;
  exported: boolean;
  /** 1-based inclusive line span [start, end]. */
  span: [number, number];
  /** Symbol path of the enclosing declaration (class name for methods). Absent for top-level. */
  parent?: string;
  /**
   * Language, IaC or framework attributes with no other home, sorted keys, string values only
   * (schema 2): e.g. `{ type: "aws_s3_bucket" }` on a Terraform resource, `{ method: "GET", path: "/users" }`
   * on a route, `{ provider: "aws" }` on a Pulumi resource, `{ base: "node:20" }` on an image.
   */
  meta?: Record<string, string>;
}

export type ImportKind = "static" | "dynamic" | "type" | "side-effect";

export interface ImportedSymbol {
  /** Exported name in the target module: identifier, "default", or "*" (namespace). */
  name: string;
  /** Local binding name in the importing file. */
  local: string;
}

/** Raw import as extracted from one file, before resolution. */
export interface ImportRecord {
  specifier: string;
  kind: ImportKind;
  symbols: ImportedSymbol[];
  /** True for `export ... from "x"` (a re-export, not a local binding). */
  reexport: boolean;
  /** 1-based line of the import. */
  line: number;
}

export interface ExportRecord {
  /** Exported name; "default" for default exports; "*" for `export * from`. */
  name: string;
  kind: "named" | "default" | "star";
  /** Local declaration name when the export renames or re-exports (`export { a as b }`, `export { a } from`). */
  local?: string;
  /** Specifier when the export is re-exported from another module. */
  from?: string;
}

/** A call site as extracted, before resolution. */
export interface CallSite {
  /** Symbol path of the enclosing declaration ("" for top-level code). */
  caller: string;
  /**
   * Callee text, normalised:
   *  - `foo` for a plain identifier call,
   *  - `obj.method` for a one-level member call on an identifier (`a.b.c()` is dropped),
   *  - `this.method` for calls on `this`,
   *  - `new Foo` for constructor calls (also `new ns.Foo`).
   * Anything else (computed members, calls on call results, `super`, deeper chains) is not recorded.
   */
  callee: string;
  line: number;
}

/** Everything the extractor knows about one file, with no cross-file knowledge. */
export interface FileRecord {
  path: string;
  lang: Lang;
  /** Hex sha256 of the raw bytes. */
  sha256: string;
  /** Number of lines: count of "\n" plus one if the last line lacks a newline; 0 for an empty file. */
  loc: number;
  decls: Declaration[];
  imports: ImportRecord[];
  exports: ExportRecord[];
  calls: CallSite[];
  /** Schema 2: references before resolution; every build-1 extractor leaves it undefined. */
  refs?: ReferenceRecord[];
}

export type Confidence = "high" | "med";

/** graph/*.jsonl line. Imports and re-exports use ImportEdge; calls use CallEdge. */
export interface Edge {
  from: string;
  to: string;
  kind: "import" | "reexport" | "call" | "reference";
  symbols?: string[];
  confidence: Confidence;
}

export interface ImportEdge extends Edge {
  kind: "import" | "reexport";
  /** `from` is a file id; `to` is a file id, `ext:<pkg>`, or `unresolved:<specifier>`. */
  specifier: string;
  importKind: ImportKind;
}

/** Schema 2: the mechanism behind a reference edge (spec 2026-09-04, section 0.1). */
export type RefKind =
  | "hcl-ref"
  | "selector"
  | "config-ref"
  | "needs"
  | "uses"
  | "from-image"
  | "copy-from"
  | "helm-values"
  | "config"
  | "resource-input"
  | "route-handler";

/**
 * A reference as extracted from one file, before resolution: `to` is language-native text
 * (a Terraform address, a Kubernetes selector, an action ref, a base image), never a node id.
 * `from` is the local symbol path of the owning declaration, or "" for a file-level reference.
 */
export interface ReferenceRecord {
  from: string;
  to: string;
  refKind: RefKind;
  line: number;
}

/**
 * Schema 2: a non-import, non-call dependency between nodes. `from` and `to` are node ids
 * (files or `<file>#<symbol>`); `refKind` names the mechanism: `hcl-ref` (a Terraform expression
 * naming a resource, variable, data source or module output), `selector` (a Kubernetes label
 * selector), `needs` (a GitHub Actions job dependency), `from-image` (a Dockerfile base image),
 * `config` (a config file naming a code entry point), `resource-input` (a Pulumi resource fed
 * another's output).
 */
export interface ReferenceEdge extends Edge {
  kind: "reference";
  refKind: RefKind;
}

export interface CallEdge extends Edge {
  kind: "call";
  /** `from` is `<file>#<symbol>` or `<file>` for top-level code; `to` is `<file>#<symbol>`. */
  confidence: Confidence;
}

export interface PackageInfo {
  /** Package name from package.json / go.mod, or the directory basename when absent. */
  name: string;
  /** Repo-relative directory ("." for the root package). */
  path: string;
  /** How the package was found. */
  source: "root" | "package.json" | "go.mod" | "workspace-glob";
}

export interface PackageEntry {
  path: string;
  /** Package names this package imports from (sorted, unique, excludes itself). */
  deps: string[];
  /** Package names that import this package (sorted, unique). */
  rdeps: string[];
  loc: number;
  files: number;
}

export interface FileEntry {
  sha256: string;
  pkg: string;
  lang: Lang;
  loc: number;
  /** Exported names, sorted; `export *` chains are followed transitively (ruling 2026-09-02). */
  exports: string[];
  /** Number of distinct repo files importing this file (import + reexport edges). */
  fanIn: number;
  /** Number of distinct import targets this file resolves inside the repo: files for TypeScript, package directories for Go (ruling 2026-09-03). */
  fanOut: number;
  /** Blast radius: size of the reverse transitive closure over import + reexport edges. */
  blast: number;
  /** sha256 the semantic summary was written for. */
  summaryHash?: string;
  staleSummary: boolean;
}

export interface Manifest {
  version: string;
  packages: Record<string, PackageEntry>;
  files: Record<string, FileEntry>;
}

export interface DiagramConfig {
  maxNodes: number;
  splitBy: "directory";
}

export interface GreplostConfig {
  include: string[];
  exclude: string[];
  languages: Lang[];
  diagram: DiagramConfig;
  packages: { roots: string[] };
  semantic: { enabled: boolean; model: string };
  /** Schema 2: framework signal passes to run; absent means every pass whose `applies` returns true. */
  signals?: Array<"next" | "pulumi-go" | "pulumi-ts" | "react" | "tanstack">;
}

export const DEFAULT_CONFIG: GreplostConfig = {
  include: ["**"],
  exclude: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
    "**/.greplost/**",
    "**/*.d.ts",
    "**/*.test.*",
    "**/*.spec.*",
    "**/__tests__/**",
    "**/testdata/**",
    "**/*_test.go",
    "**/vendor/**",
  ],
  languages: ["ts", "tsx", "js", "jsx"],
  diagram: { maxNodes: 25, splitBy: "directory" },
  packages: { roots: ["packages/*", "apps/*"] },
  semantic: { enabled: true, model: "claude-sonnet-5" },
};

export interface PackageEdge {
  from: string;
  to: string;
  /** Number of resolved import/reexport edges behind this package edge: one per import statement, never expanded to a Go package's files (ruling 2026-09-02). */
  count: number;
}

export interface Metrics {
  /** Sorted list of sorted cycles (each a list of file ids), from Tarjan SCCs of size > 1 over import + reexport edges. */
  cycles: string[][];
  /** Package-level edges, sorted by (from, to). */
  packageEdges: PackageEdge[];
}

/** The in-memory result of a structure-layer build. Everything downstream consumes this. */
export interface Snapshot {
  /** Absolute repo root; never serialized. */
  root: string;
  config: GreplostConfig;
  packages: PackageInfo[];
  /** Sorted by path. */
  files: FileRecord[];
  manifest: Manifest;
  /** Sorted per the contract. */
  imports: ImportEdge[];
  calls: CallEdge[];
  symbols: Declaration[];
  /** Schema 2; absent on snapshots built before references existed. Sorted per the contract. */
  references?: ReferenceEdge[];
  metrics: Metrics;
}

/** Semantic-layer cache (cache/summaries.json): contentHash -> entry. Committed. */
export interface SummaryEntry {
  /** Repo-relative path of the file the summary was written for (lets a stale card find its last summary). */
  path: string;
  text: string;
  /** ISO date (YYYY-MM-DD) the summary was generated; only ever rendered inside the semantic banner. */
  refreshedAt: string;
  model: string;
}

export type SummaryCache = Record<string, SummaryEntry>;

/** Deterministic code-unit string order. Never use localeCompare in structure-layer code. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareEdges(a: Edge, b: Edge): number {
  return (
    compareStrings(a.from, b.from) ||
    compareStrings(a.to, b.to) ||
    compareStrings(a.kind, b.kind) ||
    compareStrings((a.symbols ?? []).join(","), (b.symbols ?? []).join(","))
  );
}

export function compareDeclarations(a: Declaration, b: Declaration): number {
  return compareStrings(a.file, b.file) || a.span[0] - b.span[0] || compareStrings(a.id, b.id);
}

export function symbolId(file: string, symbolPath: string): string {
  return `${file}#${symbolPath}`;
}

export function packageId(name: string): string {
  return `pkg:${name}`;
}

export function externalId(pkg: string): string {
  return `ext:${pkg}`;
}

export function unresolvedId(specifier: string): string {
  return `unresolved:${specifier}`;
}

/** DeclKinds that name a thing inside a file rather than the file itself (schema 2). */
export const NODE_KINDS: ReadonlySet<DeclKind> = new Set<DeclKind>([
  "resource", "data", "variable", "output", "provider", "module",
  "job", "step", "stage", "image", "component", "route", "handler", "task",
]);

export function isNodeKind(kind: DeclKind): boolean {
  return NODE_KINDS.has(kind);
}

/** `<file>#<kind>.<name>`; throws when `name` contains "#", a newline or NUL (schema 2). */
export function nodeId(file: string, kind: DeclKind, name: string): string {
  if (/[#\n\0]/.test(name)) throw new Error(`greplost: node name "${name}" may not contain "#", a newline or NUL`);
  return `${file}#${kind}.${name}`;
}

/** Inverse of `nodeId`; null when `id` is not a node id (a plain symbol id is not). */
export function splitNodeId(id: string): { file: string; kind: DeclKind; name: string } | null {
  const hash = id.indexOf("#");
  if (hash < 0) return null;
  const file = id.slice(0, hash);
  const rest = id.slice(hash + 1);
  const dot = rest.indexOf(".");
  if (dot < 0) return null;
  const kind = rest.slice(0, dot) as DeclKind;
  if (!NODE_KINDS.has(kind)) return null;
  const name = rest.slice(dot + 1);
  return name.length === 0 ? null : { file, kind, name };
}

export function isFileId(id: string): boolean {
  return !id.includes("#") && !id.startsWith("pkg:") && !id.startsWith("ext:") && !id.startsWith("unresolved:");
}

/**
 * Package slug used in artifact paths (`packages/<slug>/`): "@" removed, "/" -> "__",
 * any other character outside [A-Za-z0-9._-] -> "-".
 */
export function packageSlug(name: string): string {
  return name.replace(/^@/, "").replace(/\//g, "__").replace(/[^A-Za-z0-9._-]/g, "-");
}

/** Stable JSON: keys sorted recursively. `indent` 0 gives a single line. */
export function stableStringify(value: unknown, indent = 0): string {
  return JSON.stringify(sortKeys(value), null, indent === 0 ? undefined : indent);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort(compareStrings)) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}
