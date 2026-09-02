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
  repoMap: "repo/MAP.md",
  hotspots: "repo/HOTSPOTS.md",
  config: "config.json",
  summaries: "cache/summaries.json",
  /** Runtime files, never committed (listed in `.greplost/.gitignore`). */
  dirty: ".dirty",
  lock: ".lock",
  state: ".state.json",
} as const;

export type Lang = "ts" | "tsx" | "js" | "jsx" | "go";

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
};

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
  | "namespace";

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
}

export type Confidence = "high" | "med";

/** graph/*.jsonl line. Imports and re-exports use ImportEdge; calls use CallEdge. */
export interface Edge {
  from: string;
  to: string;
  kind: "import" | "reexport" | "call";
  symbols?: string[];
  confidence: Confidence;
}

export interface ImportEdge extends Edge {
  kind: "import" | "reexport";
  /** `from` is a file id; `to` is a file id, `ext:<pkg>`, or `unresolved:<specifier>`. */
  specifier: string;
  importKind: ImportKind;
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
  /** Exported names, sorted; `export *` targets are followed one level. */
  exports: string[];
  /** Number of distinct repo files importing this file (import + reexport edges). */
  fanIn: number;
  /** Number of distinct repo files this file imports (import + reexport edges, repo files only). */
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
  /** Number of file-level import/reexport edges behind this package edge. */
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
