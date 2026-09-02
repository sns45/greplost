# Sub-project spec: core-extract

Implements tech spec sections 5.1 to 5.4 and 8 (parse cache). Package: `packages/core` (`@greplost/core`).
Binding contract: `packages/core/src/schema.ts` (driver-owned; never edited by a leaf).

## Goal

Turn a repo into a `Snapshot` (schema.ts) deterministically, with no LLM and no
guessing: every edge is either resolved from the AST or not emitted.

## Modules and ownership

| Leaf | Files | Exports |
|---|---|---|
| 1.1.1 ts-extract | `src/parser.ts`, `src/extract/ts.ts`, `src/extract/index.ts` | `createParser`, `grammarDir`, `extractFile` |
| 1.1.2 resolve | `src/resolve/packages.ts`, `src/resolve/tsconfig.ts`, `src/resolve/resolver.ts`, `src/resolve/index.ts` | `detectPackages`, `packageOf`, `createResolver`, `loadTsconfigPaths` |
| 1.1.3 graph | `src/graph/{link,tarjan,blast,metrics,index}.ts`, `src/serialize/{json,write,read,index}.ts` | `linkImports`, `buildExportIndex`, `linkCalls`, `computeMetrics`, `stronglyConnected`, `blastRadius`, `impactOf`, `serializeSnapshot`, `readStructure`, `parseJsonl` |
| 1.1.4 discover | `src/config.ts`, `src/discover.ts`, `src/hash.ts` | `loadConfig`, `discoverFiles`, `sha256Hex`, `countLoc` |
| 1.1.5 build | `src/build.ts`, `src/graph/query.ts`, `src/index.ts`, golden files | `buildSnapshot`, `ParseCache`, `findSymbols`, `importersOf`, `callersOf` |

Tests live in `packages/core/test/<leaf>.test.ts` and run with `bun test`. Import
grammars from `packages/core/grammars/` (vendored; see VERSIONS.txt).

## Interfaces

```ts
// parser.ts
export interface ParserHandle { parse(source: string, lang: Lang): Tree; }   // Tree from web-tree-sitter
export function grammarDir(): string;   // process.env.GREPLOST_GRAMMAR_DIR ?? <packages/core>/grammars
export async function createParser(opts?: { grammarDir?: string }): Promise<ParserHandle>;
// Lang -> grammar file: ts, js -> tree-sitter-typescript.wasm; tsx, jsx -> tree-sitter-tsx.wasm; go -> tree-sitter-go.wasm.
// Languages load lazily and are cached for the handle's lifetime. Parser.init receives locateFile -> <grammarDir>/web-tree-sitter.wasm.

// extract/index.ts
export interface ExtractInput { path: string; lang: Lang; source: string; sha256: string; }
export function extractFile(input: ExtractInput, parser: ParserHandle): FileRecord;   // dispatches on lang; computes loc
// extract/ts.ts
export function extractTs(path: string, lang: Lang, source: string, tree: Tree): Pick<FileRecord, "decls" | "imports" | "exports" | "calls">;

// resolve/packages.ts
export function detectPackages(root: string, files: string[], config: GreplostConfig): PackageInfo[];   // sorted by path, "." first
export function packageOf(path: string, packages: PackageInfo[]): PackageInfo;                          // deepest path prefix, root fallback
// resolve/tsconfig.ts
export interface TsPaths { baseUrl: string /* repo-relative dir */; paths: Record<string, string[]>; }
export function loadTsconfigPaths(root: string, fromFile: string, readFile: (rel: string) => string | null): TsPaths | null;  // nearest tsconfig.json upward, extends chain followed, cached per directory
// resolve/resolver.ts
export type ResolvedTarget = { type: "file"; path: string } | { type: "external"; pkg: string } | { type: "unresolved" };
export interface RepoContext { root: string; files: ReadonlySet<string>; packages: PackageInfo[]; readFile: (rel: string) => string | null; }
export interface Resolver { resolve(fromFile: string, specifier: string, lang: Lang): ResolvedTarget; }
export function createResolver(ctx: RepoContext): Resolver;

// graph/link.ts
export function linkImports(files: FileRecord[], resolver: Resolver): ImportEdge[];   // one edge per ImportRecord; sorted, deduped on (from,to,kind,symbols,importKind)
export interface ExportTarget { file: string; symbol: string; hops: 0 | 1; unpinned?: true; }   // unpinned: listed in exportNames, never a call target
export type ExportIndex = Map<string /* file */, Map<string /* exported name */, ExportTarget>>;
export function buildExportIndex(files: FileRecord[], imports: ImportEdge[]): ExportIndex;   // direct decls (hops 0), one hop of named re-exports (hops 1), export * followed transitively for names (see Linking rules)
export function exportNames(index: ExportIndex, file: string): string[];                    // sorted, for FileEntry.exports
export function linkCalls(files: FileRecord[], imports: ImportEdge[], index: ExportIndex): CallEdge[];
// graph/tarjan.ts
export function stronglyConnected(nodes: string[], edges: ReadonlyArray<readonly [string, string]>): string[][];  // SCCs of size > 1, each sorted, list sorted by first id
// graph/blast.ts
export function blastRadius(nodes: string[], edges: ReadonlyArray<readonly [string, string]>): Map<string, number>; // reverse transitive closure size per node, SCC-condensed bitsets, O((V+E)·V/64)
export function impactOf(edges: ReadonlyArray<readonly [string, string]>, target: string): Array<{ path: string; depth: number }>; // reverse BFS, sorted by (depth, path)
// graph/metrics.ts
export function computeMetrics(files: FileRecord[], packages: PackageInfo[], imports: ImportEdge[]): { manifestFiles: Record<string, Omit<FileEntry, "summaryHash" | "staleSummary" | "exports">>; manifestPackages: Record<string, PackageEntry>; metrics: Metrics };
// serialize/*.ts
export function serializeSnapshot(s: Snapshot): Map<string, string>;   // ARTIFACT_PATHS.manifest (2-space, sorted keys) + imports/calls/symbols jsonl
export function parseJsonl<T>(text: string): T[];
export interface Structure { manifest: Manifest; imports: ImportEdge[]; calls: CallEdge[]; symbols: Declaration[]; }
export function readStructure(artifactDir: string): Structure | null;   // null when manifest.json is absent
// build.ts
export interface ParseCache { get(sha256: string): FileRecord | undefined; set(record: FileRecord): void; }
export interface BuildOptions { root: string; config?: GreplostConfig; parser?: ParserHandle; cache?: ParseCache; summaries?: SummaryCache; }
export async function buildSnapshot(opts: BuildOptions): Promise<Snapshot>;
// graph/query.ts (over Structure, so the CLI never parses)
export function findSymbols(symbols: Declaration[], needle: string): Declaration[];  // exact id, exact symbol path, then name suffix match; sorted
export function importersOf(imports: ImportEdge[], file: string): string[];
export function callersOf(calls: CallEdge[], symbolId: string): string[];
```

## Extraction rules (TypeScript, TSX, JavaScript, JSX)

Grammar: `typescript` for ts/js (JS is a subset the TS grammar accepts), `tsx` for tsx/jsx.

**Declarations** (`decls`), top level plus class members only:

- `function_declaration`, `generator_function_declaration` → `function`.
- `class_declaration`, `abstract_class_declaration` → `class`. Each `method_definition` in the body → `method`, name `Class.member` (constructor included as `Class.constructor`, getters/setters/static included, `#private` keeps the `#`), `parent: "Class"`.
- `interface_declaration` → `interface`; `type_alias_declaration` → `type`; `enum_declaration` → `enum`.
- `lexical_declaration` / `variable_declaration` → one entry per `variable_declarator` whose name is an identifier (destructuring patterns produce no declaration); kind `const` | `let` | `var`.
- `internal_module` (`namespace X {}`) → `namespace`. Members declared directly in a namespace body are tracked at any depth with dotted symbol paths (`N.f`, `A.B.f`), `parent` set to the enclosing namespace path, and `exported` true only when the member and every enclosing namespace carry `export` (ruling 2026-09-02).
- Class fields whose initializer is an arrow function or function expression are `method` declarations (`C.handle`, signature cut before the body); `abstract` method signatures and method signatures inside `declare class` bodies are `method` declarations; data fields and interface members are not declarations (ruling 2026-09-02).
- Wrapped in `export_statement` → `exported: true`. `export default function foo`/`class Foo` → exported, name as written. Anonymous `export default function () {}` / `export default class {}` → a declaration named `default`. `export default <expression>` → no declaration (export record only).
- `declare` (ambient) declarations are treated like ordinary ones.
- `signature`: node text from the declaration start (including a leading `export`/`export default`/`declare`) to the byte before the body node (`statement_block`, `class_body`, `interface_body`/`object_type`, `enum_body`); type aliases use the whole node; variables use the whole `variable_declarator`, cut before the body of an arrow-function or function-expression initializer. Whitespace runs collapse to one space, trailing space trimmed; longer than 200 characters → first 199 plus `…`.
- `span`: `[startRow + 1, endRow + 1]` of the outermost node (the `export_statement` when exported).

**Imports** (`imports`):

- `import_statement`: specifier = source string without quotes. `import type …` → kind `type`; otherwise `static`. Symbols: named `{ a, b as c }` → `{name:"a", local:"a"}, {name:"b", local:"c"}`; default `import X` → `{name:"default", local:"X"}`; namespace `import * as ns` → `{name:"*", local:"ns"}`; `import "x"` → kind `side-effect`, symbols `[]`. Inline `type` modifiers on specifiers do not change the kind.
- `export … from "x"` → `reexport: true`, kind `static` (`export type { } from` → `type`). `export * from "x"` → symbols `[{name:"*", local:"*"}]`; `export * as ns from "x"` → `[{name:"*", local:"ns"}]`; `export { a as b } from "x"` → `[{name:"a", local:"b"}]`.
- A type-position `import("x").T` (inside a type annotation, type alias or generic argument) → kind `type`, symbols `[{name:"T",local:"T"}]` (or `*` when no member is accessed), and no call site (ruling 2026-09-02).
- `import("x")` with a string-literal argument in value position → kind `dynamic`; symbols: `const { a, b } = await import("x")` → named; `const m = await import("x")` → `[{name:"*", local:"m"}]`; otherwise `[{name:"*", local:"*"}]`. Non-literal arguments are ignored.
- `require("x")` with a string literal → kind `static`; `const m = require("x")` → `[{name:"*", local:"m"}]`; `const { a } = require("x")` → named; bare statement → `side-effect`. `import m = require("x")` → static, `[{name:"*", local:"m"}]`.
- `line`: 1-based start row of the statement (or of the call for dynamic/require).

**Exports** (`exports`):

- Exported declarations → one `named` record per declared name (each variable declarator separately).
- `export { a, b as c }` → `named` with `name: "c", local: "b"`. `export { a as b } from "x"` → `named`, `local: "a"`, `from: "x"`. `export { default as X } from "x"` → `name: "X", local: "default", from`. `export { x as default }` → kind `default`, `local: "x"`.
- `export * from "x"` → `{ name: "*", kind: "star", from: "x" }`; `export * as ns from "x"` → `{ name: "ns", kind: "named", local: "*", from: "x" }`.
- `export default …` → `{ name: "default", kind: "default", local?: identifier when the expression is an identifier or a named function/class }`.
- `export = x` → `default`, `local: "x"`. JS `module.exports = …` → `default`; `exports.foo = …` / `module.exports.foo = …` → `named` foo. Best effort; documented as v1 CommonJS support.

**Call sites** (`calls`): every `call_expression` and `new_expression` anywhere in the file.

- `caller`: symbol path of the nearest enclosing tracked declaration: `function_declaration` name; `method_definition` → `Class.member`; a `variable_declarator` whose value is a function/arrow → its name; a class field initializer or a `static {}` block → `Class`; a function-valued class field → `Class.field`; a namespace member → its dotted path; otherwise `""`. Enclosing declarations are matched by node identity, never by name (a shadowing local cannot hijack attribution).
- `callee`: identifier → `name`; `member_expression` whose object is an identifier → `obj.prop`; object `this` → `this.prop`; `new X` → `new X`; `new ns.X` → `new ns.X`; optional chains (`a?.b()`) are treated like plain members; non-null assertions (`a!.b()`, `f!()`) are unwrapped. Skip `import(...)`, `require(...)`, `super`, deeper chains, computed members, calls on call results, and calls on parenthesised or `await` expressions.

## Resolution rules

`createResolver(ctx).resolve(fromFile, specifier, lang)`:

1. **Relative** (`./`, `../`) or root-absolute (`/`): `candidate = normalize(dirname(fromFile) + specifier)`. Probe in order and return the first that is in `ctx.files`: the exact path; if the specifier ends in `.js/.jsx/.mjs/.cjs`, the same path with `.ts/.tsx/.mts/.cts` respectively; `candidate + ext` for ext in `.ts .tsx .mts .cts .js .jsx .mjs .cjs`; `candidate/index + ext` in the same order. Otherwise `{ type: "unresolved" }`. (A file that exists on disk but is excluded by config is unresolved by design: the map only knows indexed files.)
2. **tsconfig paths**: `loadTsconfigPaths` for the importing file; match the specifier against each key (exact, or prefix/suffix around a single `*`), substitute into every mapping in order, resolve each mapped path relative to `baseUrl` with rule 1's probing; first hit wins. Keys are tried longest-prefix first.
3. **Bare specifiers**: package name = first segment, or first two for `@scope/name`; subpath = the rest. `node:` prefixed or Node builtin names → `{ type: "external", pkg: specifier }`. If a `PackageInfo` with `source: "package.json"` has that exact name: read its package.json; resolve subpath through `exports` (string, or object; when conditions are present try `bun`, `source`, `import`, `default`, `require`, `types` in that order; pattern keys with `*` supported) then `module`, `main`; a relative target is probed with rule 1 relative to the package dir; if nothing indexed is hit, try `src/index` and `index` with the extension list. Still nothing → `unresolved`. Any other bare name → `{ type: "external", pkg: packageName }`.
4. Go: see the go sub-project spec (rule set added to the resolver by leaf 1.8 without changing the interface).

## Package detection

`detectPackages(root, files, config)`:

- The root package always exists: `{ name: <root package.json name> ?? <go.mod module last segment> ?? basename(root), path: ".", source: "root" }`.
- Candidate globs: `config.packages.roots` ∪ root `package.json.workspaces` (array or `{ packages }`) ∪ `pnpm-workspace.yaml` `packages:` entries (lines starting with `- `, quotes stripped) ∪ `go.work` `use` entries. Every directory matching a glob that contains `package.json` or `go.mod` is a package: name from the manifest (`name`, or `module` path's last segment), else the directory basename; `source: "package.json" | "go.mod"`.
- Duplicate names: keep the first by path order and rename later ones `<name> (<path>)`.
- Result sorted by path with "." first. `packageOf(path)` picks the package with the longest `path + "/"` prefix, else the root.

## Linking rules (graph/link.ts)

- `linkImports`: for each `ImportRecord` in each file: `to` = resolved file id, `ext:<pkg>`, or `unresolved:<specifier>`; `kind` = `reexport` when `record.reexport`, else `import`; `symbols` = sorted unique `name`s; `confidence: "high"`; `specifier`, `importKind` copied. Sort with `compareEdges` (ties by importKind, then specifier), drop duplicates on (from, to, kind, symbols, importKind) so a static and a dynamic import of the same symbols stay two edges (ruling 2026-09-02).
- `buildExportIndex`: for file F: every exported top-level declaration `n` → `F → n → {file: F, symbol: n, hops: 0}` (methods excluded; `default` maps to the local declaration name when known, else `default`). Every `export { a as b } from "x"` resolved to file X where X declares `a` → `F → b → {file: X, symbol: a, hops: 1}`; `export * from "x"` → every name X exports (except `default`) is followed transitively through star chains (fixpoint over the star graph, cycle-safe, order-independent; ruling 2026-09-02): names reached through one star hop are pinned with hops 1, names reached through more than one hop or re-exported from an external/unresolved module are kept for `exportNames` but marked unpinned (never a call target). A local export shadows a star export; when two stars supply the same name the first in source order wins (tsc would treat it as ambiguous; recorded as a known delta). `exportNames(index, F)` = sorted keys, plus names from `export { a as b }` of local non-declaration bindings.
- `linkCalls`, for `CallSite (caller, callee)` in file F:
  - `name`: F has a top-level declaration `name` of kind other than `interface`/`type` → `F#name`, high. Else an `ImportRecord` in F (not reexport, kind `static`/`dynamic`) binds local `name` from module M (resolved file only): imported name `default` → M's `default` export target (hops 0 → high); imported name `n` → index[M][n]: hops 0 → high, hops 1 → med, unpinned or deeper → dropped. Namespace binding (`*`) never matches a bare name. Otherwise drop.
  - `this.m`: caller path `Class.member` or `Class` and F declares `Class.m` → `F#Class.m`, high.
  - `obj.m`: `obj` is a namespace import local from M → resolve `m` in M as above; `obj` is a same-file class with `F#obj.m` → high; `obj` is an imported symbol `Class` from M (hops 0) with `M#Class.m` declared → high. Otherwise drop.
  - `new X` → as `name` X; `new ns.X` → as `obj.m`.
  - `from` = `F#caller`, or `F` when caller is `""`. Dedupe on (from, to); sort with `compareEdges`.

## Metrics (graph/metrics.ts)

Edges considered: `import` + `reexport` whose `to` is a file id.

- `fanIn`/`fanOut` per file: distinct counterpart files.
- `blast` per file: `blastRadius` over the same edges (reverse closure size, excluding the file itself).
- `cycles`: `stronglyConnected` over the same edges; SCCs of size > 1, each sorted, list sorted by first element.
- Package edges: `(pkg(from), pkg(to))` for edges between different packages, counted; `deps`/`rdeps` from them; `loc` and `files` summed per package.
- `FileEntry.exports` comes from `exportNames`.

## Serialization

- `manifest.json`: `stableStringify(manifest, 2) + "\n"`.
- `graph/imports.jsonl`, `graph/calls.jsonl`: one `stableStringify(edge)` per line, sorted with `compareEdges`, trailing newline; an empty collection is an empty file.
- `graph/symbols.jsonl`: one `Declaration` per line sorted with `compareDeclarations`.
- `readStructure` parses those four files back; `parseJsonl` ignores blank lines.

## Build (build.ts)

`buildSnapshot`: `loadConfig` → `discoverFiles` → read bytes, `sha256Hex`, cache lookup (`cache.get(sha)` returns the record with `path` re-stamped, since identical content may live at two paths) or `extractFile` → `detectPackages` → `createResolver` → `linkImports` → `buildExportIndex` → `linkCalls` → `computeMetrics` → manifest (`summaryHash`/`staleSummary` from `opts.summaries` as the semantic spec defines: `summaries[sha]` present → `summaryHash: sha, staleSummary: false`; else the newest entry with `entry.path === path` → its key, `staleSummary: true`; else `staleSummary: false` and no `summaryHash`) → `Snapshot` with all collections sorted. Everything is synchronous after the reads; no worker threads in v1.

## Tests (bun test) and golden files

- Unit tests per leaf on inline sources and on `fixtures/tiny-ts`.
- `packages/core/test/golden/tiny-ts/{manifest.json,graph/imports.jsonl,graph/calls.jsonl,graph/symbols.jsonl}`: the build of the fixture, committed by leaf 1.1.5 and asserted byte-equal on every run. Updating them is a deliberate, reviewed change (`GREPLOST_UPDATE_GOLDEN=1 bun test`).
- Properties, leaf 1.1.5: build twice → identical bytes; shuffle the discovered file order → identical bytes; run with an empty parse cache and with a warm cache → identical bytes.
- tiny-ts facts the tests pin: 12 files; 3 packages (`tiny-ts` root, `@tiny/core`, `@tiny/adapters`, `worker` = 4 including root); one cycle `bus.ts ↔ events.ts`; `packages/core/src/index.ts` re-exports `retry`, `DEFAULT_ATTEMPTS`, `Priority`, star of `registry`; `memory.ts` has a dynamic import of `@tiny/core` with symbol `Priority`; `sqs.ts` imports external `@aws-sdk/client-sqs`; call edge `sqs.ts#SqsAdapter.publish → retry.ts#retry` is `med` (through the `@tiny/core` index re-export) and `registry.ts#Registry.publishAll → retry.ts#retry` is `high`.
