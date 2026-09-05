# Sub-project specs: languages, IaC, signals, non-file nodes, bench coverage (build 2)

Authority: `docs/greplost-tech-spec.md` (binding, with Appendix C), then this file, then
`docs/superpowers/plans/2026-09-04-build-2-plan.md`, then `PLAN.md`.

Build 2 adds, to a greplost that already ships TypeScript, TSX, JavaScript, JSX and Go:

| Group | Adds |
|---|---|
| languages | Python, Rust, Java, Kotlin |
| iac | Terraform (HCL), Kubernetes and Helm YAML, GitHub Actions workflows, Dockerfiles |
| signals | React components, TanStack Start routes and loaders, Next.js app routes and handlers, Pulumi programs in TypeScript and in Go (tech spec 5.1 "signals", v1.5) |
| render-and-cli | cards, `query` and `impact` for non-file nodes |
| bench | a pinned corpus per language or format, a compiler-grade truth generator per language, a structural gate in CI |

**Out of scope, stated so nobody looks for it:** the head-to-head suite (tech spec 10.0, X1 to
X10) is left exactly as build 1 measured it. Graphify, Understand-Anything and
code-review-graph are not run on Python, Rust, Java, Kotlin, HCL, YAML, Dockerfiles or the
signal layer, and `RESULTS.md` must say so in one sentence next to the X table: *"X1 to X10
cover TypeScript and Go only; build 2's languages are scored against their own compiler truth
in the single-tool table below, with no competitor arm."* Anything else would be an
unsupported comparison.

---

## 0. Shared contracts (every group depends on these)

### 0.1 Driver amendments to `packages/core/src/schema.ts`

`schema.ts` is driver-owned. Three amendments beyond the ones already landed on 2026-09-04
(`Lang`, `LANG_BY_EXTENSION`, `LANG_BY_BASENAME`, `DOCKERFILE_PREFIX`, the schema-2 `DeclKind`
values, `Declaration.meta`, `ReferenceEdge`, `ARTIFACT_PATHS.references`, `Snapshot.references`)
are required, and the driver lands all three in wave 0 as part of leaf 2.0:

```ts
export const SCHEMA_VERSION = "2";           // was "1"

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

export type RefKind =
  | "hcl-ref"        // a Terraform expression naming a resource, data source, variable, module output or provider
  | "selector"       // a Kubernetes label selector, or a Service -> workload match
  | "config-ref"     // a Kubernetes configMap/secret/volume reference, or a Compose-style env file
  | "needs"          // a GitHub Actions job dependency
  | "uses"           // a GitHub Actions step using an action, or a Terraform `module` source
  | "from-image"     // a Dockerfile FROM
  | "copy-from"      // a Dockerfile COPY --from
  | "helm-values"    // a Helm template reading a `.Values` key
  | "config"         // a config file naming a code entry point
  | "resource-input" // a Pulumi resource fed another resource's output
  | "route-handler"; // a route node bound to the handler declaration that serves it

/** FileRecord gains one optional field; every existing extractor keeps returning undefined. */
export interface FileRecord {
  /* … unchanged … */
  refs?: ReferenceRecord[];
}

/** Framework signal passes to run; absent means "every pass whose `applies` returns true". */
export interface GreplostConfig {
  /* … unchanged … */
  signals?: Array<"next" | "pulumi-go" | "pulumi-ts" | "react" | "tanstack">;
}

/** DeclKinds that name a thing inside a file rather than the file itself (schema 2). */
export const NODE_KINDS: ReadonlySet<DeclKind> = new Set([
  "resource", "data", "variable", "output", "provider", "module",
  "job", "step", "stage", "image", "component", "route", "handler", "task",
]);

export function isNodeKind(kind: DeclKind): boolean;
/** `<file>#<kind>.<name>`; throws when `name` contains "#", "\n" or NUL. */
export function nodeId(file: string, kind: DeclKind, name: string): string;
/** Inverse of `nodeId`; null when `id` is not a node id (a plain symbol id is not). */
export function splitNodeId(id: string): { file: string; kind: DeclKind; name: string } | null;
```

`SCHEMA_VERSION = "2"` changes every `manifest.json`, so leaf 2.0 also regenerates
`packages/core/test/golden/**`, `packages/render/test/golden/**`, `packages/sync/test/**`
snapshots and this repo's own `.greplost/` map. Ownership of those goldens transfers from
build-1 leaves 1.1.5 and 1.2.2 to leaf 2.0 at that point.

### 0.2 Node identity (the determinism contract, extended)

Tech spec 5.3 is unchanged for files, packages, externals and symbols. Schema 2 adds one form:

| Node | Id | Example |
|---|---|---|
| file | `<repo-relative-path>` | `infra/main.tf` |
| symbol | `<file>#<symbolPath>` | `packages/core/src/registry.ts#Registry.register` |
| **non-file node** | `<file>#<kind>.<name>` | `infra/main.tf#resource.aws_s3_bucket.logs` |
| package | `pkg:<name>` | `pkg:@greplost/core` |
| external | `ext:<name>` | `ext:react`, `ext:image/node:20`, `ext:action/actions/checkout@v4` |
| unresolved | `unresolved:<specifier>` | `unresolved:./nope` |

`<kind>` is the `DeclKind` string verbatim. `<name>` is the node's language-native name, fixed
per kind below. External ids for build-2 mechanisms are namespaced so they never collide with
an npm or Go package name: `ext:image/<ref>`, `ext:action/<owner>/<repo>@<ref>`,
`ext:provider/<name>`, `ext:module/<source>`, `ext:chart/<name>`, `ext:crate/<name>`,
`ext:maven/<group>:<artifact>`, `ext:pypi/<dist>`. No schema change is needed: these are just
strings produced by `externalId()`.

**Uniqueness.** Node ids are unique within a file. When the natural name collides, or when a
document has no name, the id takes a `#<index>` suffix on the name where `<index>` is the
0-based position of the document, stage or step in the file: `deploy.yaml#resource.Deployment.#2`.
Position, never a hash, so a rename does not renumber unrelated nodes.

**Name characters.** A name may not contain `#`, a newline or NUL (`nodeId` throws). `/`, `.`,
`:`, `$`, `[` and `]` are allowed, because routes and Pulumi type tokens need them.

**Card path.** A non-file node's card is a sibling of its file's card, in a directory named
after the file:

```
packages/<packageSlug(pkg.name)>/modules/<file relative to pkg.path>.md        # the file card
packages/<packageSlug(pkg.name)>/modules/<file relative to pkg.path>/<nodeSlug(kind, name)>.md
```

`nodeSlug(kind, name)` = `` `${kind}.${name}` `` with `/` replaced by `__` and every character
outside `[A-Za-z0-9._-]` replaced by `-`. So `infra/main.tf#resource.aws_s3_bucket.logs` renders
to `packages/<slug>/modules/infra/main.tf/resource.aws_s3_bucket.logs.md`, and
`app/users/[id]/page.tsx#route./users/[id]` renders to
`.../modules/app/users/[id]/page.tsx/route.__users__-id-.md`. **No artifact path ever contains
`#`**, a `#` in a Markdown link is a URL fragment, so the file card and every inbound link
would silently point at the wrong page.

`packages/render/src/slug.ts` gains `nodeSlug(kind, name)` and `nodeCardPath(pkg, id)`;
`renderArtifacts` gains `assertNoCardCollision(paths)` alongside the existing
`assertNoSlugCollision`.

### 0.3 Reference edges

`graph/references.jsonl`, one `ReferenceEdge` per line, sorted by
`(from, to, refKind, symbols joined by ",")`.

- `from` is a node id or a file id; `to` is a node id, a file id, or an `ext:` id.
- `confidence` is `high` when the reference resolves to exactly one node in the indexed set;
  `med` when it resolves through exactly one documented level of indirection (a Terraform
  `module` output to the module's `output` node, a Helm template `.Values.x` to the
  `values.yaml` key node, a Kubernetes `Service` selector to a workload whose labels are a
  superset). **Anything ambiguous is dropped, never guessed**, the same rule that governs call
  edges (tech spec 5.1).
- A reference never targets `unresolved:`; an unresolvable reference is not emitted.
- `symbols` carries the language-native address that produced the edge
  (`["aws_vpc.main.id"]`, `[".Values.image.tag"]`) so a card can show *why* the edge exists.

`linkReferences(files, resolver, ctx)` in `packages/core/src/references/link.ts` turns every
`FileRecord.refs` into edges by dispatching on the owning file's `lang`; per-language rules live
in `packages/core/src/references/<lang>.ts`.

### 0.4 Language pipeline shape (identical for every new language)

```
packages/core/src/extract/<lang>.ts    extract<Lang>(path, lang, source, tree)
                                         -> Pick<FileRecord, "decls"|"imports"|"exports"|"calls"|"refs">
packages/core/src/resolve/<lang>.ts    create<Lang>Resolver(ctx) -> (fromFile, specifier) => ResolvedTarget
                                       resolve<Lang>Call(file, site, index) -> { to, confidence } | null
packages/core/src/references/<lang>.ts resolve<Lang>References(file, ref, ctx) -> ReferenceEdge | null
bench/src/truth/<lang>.ts              generateTruth(root, files) -> Truth
fixtures/tiny-<name>/                  the smallest repo exercising every rule
```

`extractFile` dispatches on `lang` through a static table in
`packages/core/src/extract/index.ts` (written whole by leaf 2.0, with a throwing stub per
language that its leaf replaces). `bench/src/truth/registry.ts` loads
`./truth/${lang}.ts` by convention and calls its `generateTruth` export, **no shared file is
edited when a language lands**, which is what keeps a wave's leaves disjoint.

### 0.5 Grammars

Vendored in `packages/core/grammars/`, recorded in `VERSIONS.txt`, regenerated by
`bun scripts/vendor-grammars.ts`. Verified on this machine 2026-09-04: `web-tree-sitter` 0.27
accepts grammar ABI 13 to 15.

| Grammar | Version | How it is vendored |
|---|---|---|
| tree-sitter-python | 0.25.0 | npm tarball **ships `tree-sitter-python.wasm`**; copy it |
| tree-sitter-rust | 0.24.0 | npm tarball **ships `tree-sitter-rust.wasm`**; copy it |
| tree-sitter-java | 0.23.5 | npm tarball **ships `tree-sitter-java.wasm`**; copy it |
| tree-sitter-kotlin | 0.3.8 | **no wasm in the tarball**; build with `bunx tree-sitter-cli@0.27 build --wasm` |
| tree-sitter-yaml | 0.5.0 | **no wasm in the tarball**; build with `bunx tree-sitter-cli@0.27 build --wasm` |
| tree-sitter-hcl | v1.2.0 (`fad991865fee927dd1de5e172fb3f08ac674d914`, tree-sitter-grammars/tree-sitter-hcl) | npm name is a security placeholder; clone the tag and build |
| tree-sitter-dockerfile | v0.2.0 (`868e44ce378deb68aac902a9db68ff82d2299dd0`, camdencheek/tree-sitter-dockerfile) | npm name is a security placeholder; clone the tag and build |

Build 1's spike proved `tree-sitter-cli build --wasm` needs no Docker on this machine. Leaf 2.0
writes `scripts/build-grammars.sh` (clone the two pinned tags into a temp dir, build all four
missing wasms, copy into `packages/core/grammars/`) and extends `scripts/vendor-grammars.ts`
for the three that ship one. Every wasm's ABI is asserted in `packages/core/test/parser.test.ts`
by loading it and parsing a one-line fixture.

### 0.6 Config

`DEFAULT_CONFIG.languages` stays `["ts", "tsx", "js", "jsx"]`: adding a language must not
silently change any existing repo's map. New languages are opt-in through
`.greplost/config.json`, and `greplost init` adds a language when it finds its marker file:

| Lang | Marker |
|---|---|
| python | `pyproject.toml`, `setup.py`, or any `*.py` outside `exclude` |
| rust | `Cargo.toml` |
| java | `pom.xml`, `build.gradle`, `build.gradle.kts` |
| kotlin | `build.gradle.kts`, or any `*.kt` |
| hcl | any `*.tf` |
| yaml | `Chart.yaml`, `.github/workflows/*.yml`, or any `*.yaml` with an `apiVersion:` first key |
| dockerfile | any `Dockerfile*` |

Detection is a filename-and-first-key test only; it never parses. This repo's own
`.greplost/config.json` gains `yaml` and `dockerfile` (it has workflows and a Dockerfile in
fixtures) as part of leaf 2.12's dogfood pass.

---

## 1. Sub-project: languages (Python, Rust, Java, Kotlin)

### 1.1 Modules and ownership

| Module | Owner leaf | Provides |
|---|---|---|
| `packages/core/src/extract/python.ts` | 2.1 | `extractPython` |
| `packages/core/src/resolve/python.ts` | 2.1 | `createPythonResolver`, `buildPythonCallIndex`, `resolvePythonCall` |
| `packages/core/test/extract-python.test.ts` | 2.1 | |
| `fixtures/tiny-python/**` | 2.1 | |
| `bench/src/truth/python.ts`, `bench/truth/pytruth/**`, `bench/test/truth-python.test.ts` | 2.1 | |
| `packages/core/src/extract/rust.ts`, `resolve/rust.ts`, `test/extract-rust.test.ts`, `fixtures/tiny-rust/**`, `bench/src/truth/rust.ts`, `bench/truth/rusttruth/**`, `bench/test/truth-rust.test.ts` | 2.4 | |
| `packages/core/src/extract/java.ts`, `resolve/java.ts`, `test/extract-java.test.ts`, `fixtures/tiny-java/**`, `bench/src/truth/java.ts`, `bench/truth/javatruth/**`, `bench/test/truth-java.test.ts` | 2.5 | |
| `packages/core/src/extract/kotlin.ts`, `resolve/kotlin.ts`, `test/extract-kotlin.test.ts`, `fixtures/tiny-kotlin/**`, `bench/src/truth/kotlin.ts`, `bench/truth/kotlintruth/**`, `bench/test/truth-kotlin.test.ts` | 2.6 | |

### 1.2 Python

**Declarations.** `function_definition` -> `function` (`method` when nested in a
`class_definition`, `parent` = the class's dotted path); `class_definition` -> `class`;
module-level assignments whose target is a plain identifier -> `const` when the name is
`SCREAMING_SNAKE`, else `var`; annotated module-level assignments keep the annotation in the
signature. `decorated_definition` contributes its decorators to `signature` (first line only)
and `meta.decorators` (comma-joined, sorted). `exported` = the name does not start with `_`,
**unless** the module defines `__all__` as a list of string literals, in which case `exported`
= membership in `__all__`. Async functions keep `async ` in the signature. Signature = the
`def`/`class` header text through the closing `)` and any `-> T`, whitespace collapsed, 200-char
cap.

**Imports.** `import_statement` -> one record per `dotted_name`/`aliased_import`, specifier =
the dotted module path, symbols `[{ name: "*", local: <alias or the first segment> }]`.
`import_from_statement` -> specifier = the module path with relative dots preserved (`.`, `..`,
`.pkg.mod`), one `ImportedSymbol` per imported name (`*` for a star import), `kind: "static"`.
`if TYPE_CHECKING:` bodies and `from __future__ import annotations` produce `kind: "type"`.
An import inside a function body is still `static` (Python has no dynamic-import syntax to
distinguish); `importlib.import_module("x")` with a string-literal argument is `kind: "dynamic"`.

**Exports.** One `named` record per exported declaration, plus one per `__all__` entry that
names something the module imported (a re-export, `from` = the originating specifier when it is
known, `kind: "named"`). Python has no `default`; `star` is never emitted.

**Calls.** `call` with `identifier` -> `name`; `attribute` on an identifier -> `obj.method`;
`attribute` on `self` -> `this.method` (normalised to the schema's `this.` form so the linker
is shared); a call to a name bound to a class -> `new Name` is **not** used, Python has no
`new`, so a constructor call is a plain `name` call and the linker resolves it to the class
declaration. Deeper chains, subscripted callees and calls on call results are dropped.

**Resolution.** Absolute imports: the specifier's dotted path maps to
`<sys.path root>/<a>/<b>.py` or `<a>/<b>/__init__.py`. Roots, in order: the directory holding
`pyproject.toml` plus its `[tool.setuptools] package-dir`/`packages` or `[project] name`; a
`src/` directory when it exists; the repo root. Relative imports (`from . import x`,
`from ..pkg import y`) resolve against the importing file's package directory, one `.` per
level above. A specifier that resolves to a directory containing `__init__.py` targets that
`__init__.py` (a file id, not a directory id, Python packages are files, unlike Go). Anything
else is `ext:pypi/<top-level segment>` for a known distribution root, otherwise
`{ type: "external", pkg: <first segment> }`. Standard-library module names come from a
vendored, sorted list in `resolve/python.ts` (`PY_STDLIB`, generated from `sys.stdlib_module_names`
on python3 3.14 and committed as a literal, never read at runtime).

**Call resolution.** `name` -> a top-level declaration in the same file -> `high`; a name bound
by exactly one `from X import name` whose target file declares it -> `high`; `obj.method` where
`obj` is a module alias from `import X as obj` -> the declaration in the target file -> `high`;
`this.method` inside a class -> `<file>#<Class>.<method>` -> `high`; a name re-exported through
exactly one `__init__.py` -> `med`. Everything else drops.

### 1.3 Rust

**Declarations.** `function_item` -> `function` (`method` inside an `impl_item`, `parent` =
the impl's type name); `struct_item` -> `struct`; `enum_item` -> `enum`; `trait_item` ->
`trait`; `impl_item` -> `impl`, name = `<Type>` or `<Trait> for <Type>`; `type_item` -> `type`;
`const_item` -> `const`; `static_item` -> `var`; `mod_item` -> `module`; `macro_definition` ->
`function` with `meta.macro = "1"`. `exported` = the item has a `pub`, `pub(crate)` or
`pub(in …)` visibility modifier; `meta.visibility` records which. Generic parameters and where
clauses stay in the signature up to the 200-char cap.

**Imports.** `use_declaration` -> one record per leaf of the use tree, specifier = the path with
`crate`, `super`, `self` preserved, symbols `[{ name: <last segment>, local: <alias or last
segment> }]`; a `use x::*` glob gives `name: "*"`; `pub use` sets `reexport: true`.
`extern crate` -> a `static` import of the crate name. `mod foo;` (a `mod_item` with no body)
is an import of `foo.rs`/`foo/mod.rs` with `kind: "static"` and `symbols: []`, which is how
Rust's module tree becomes an import graph.

**Exports.** One `named` record per `pub` item; `pub use a::b as c` -> `named` with
`local: "b"`, `from: "a"`.

**Calls.** `call_expression` with `identifier` -> `name`; with a `scoped_identifier` of exactly
two segments -> `obj.method`; `field_expression` callee on `self` -> `this.method`;
`Type::new(...)` -> `obj.method` with `obj = Type`; macro invocations are not calls.

**Resolution.** A `mod` item and a `use crate::a::b` both resolve inside the crate: find the
crate root (`src/lib.rs` or `src/main.rs` under the nearest `Cargo.toml`, plus every
`[[bin]]`/`[[example]]` path), then walk the module path to `<dir>/<seg>.rs` or
`<dir>/<seg>/mod.rs`. `use <workspace member>::…` resolves through `Cargo.toml`'s
`[workspace] members` to that member's crate root. Everything else is
`ext:crate/<first segment>`. `super::` walks one module level up; `self::` stays.

**Call resolution.** Same-file item -> `high`; a name imported by exactly one `use` whose target
declares it -> `high`; `Type::method` where `Type` is declared in the crate and exactly one
`impl Type` declares `method` -> `high`; `this.method` inside an impl -> that impl's method ->
`high`; a name reached through exactly one `pub use` -> `med`. Trait-dispatched calls (a method
on a generic or `dyn` receiver) are **dropped**: they are the Rust analogue of TypeScript's
interface dispatch, and precision is gated while recall is reported (tech spec 14).

### 1.4 Java

**Declarations.** `class_declaration` -> `class`; `interface_declaration` -> `interface`;
`enum_declaration` -> `enum`; `record_declaration` -> `record`; `annotation_type_declaration` ->
`interface` with `meta.annotation = "1"`; `method_declaration`/`constructor_declaration` ->
`method`, `parent` = the enclosing type's dotted path, name = `<Type>.<method>` (overloads share
a name; the span disambiguates and `compareDeclarations` keeps the order stable);
`field_declaration` -> `const` when `static final`, else `var`. `exported` = the declaration has
`public` (or is an interface member, which is implicitly public). `meta.annotations` holds the
sorted, comma-joined annotation names, which is what makes Spring-style routing visible later.

**Imports.** `import_declaration` -> specifier = the fully qualified name; symbols
`[{ name: <last segment>, local: <last segment> }]`, or `name: "*"` for an on-demand import;
`import static` sets `meta`-free `kind: "static"` and `name` = the member.

**Exports.** One `named` record per `public` type and per `public` member of a `public` type.

**Calls.** `method_invocation` with a bare `identifier` -> `name`; with an `object` that is an
`identifier` -> `obj.method`; on `this` -> `this.method`; `object_creation_expression` ->
`new Type`. Chained and generic-witness calls are dropped.

**Resolution.** A Java import names a type, and a type lives in a file: map the fully qualified
name to `<source root>/<a>/<b>/<Type>.java`. Source roots, in order: every `src/main/java`,
every `src/test/java` (excluded by config anyway), and the repo root. A same-package reference
with no import resolves to a sibling file in the same directory. Everything else is
`ext:maven/<first two segments>` for a `com.x`/`org.x` prefix, otherwise
`{ type: "external", pkg: <first segment> }`. `java.*` and `javax.*` are external.

**Call resolution.** Same-file method -> `high`; a static import naming exactly one declaration
-> `high`; `obj.method` where `obj` is a field or local whose declared type is an indexed type
with exactly one `method` -> `high` (the declared type is read from the field/local
declaration's text; no inference); `new Type` -> the type's constructor or, absent one, the
type declaration -> `high`; `this.method` -> the enclosing type's method -> `high`. Interface
dispatch and unqualified inherited calls are dropped.

### 1.5 Kotlin

**Declarations.** `function_declaration` -> `function` (`method` inside a
`class_declaration`/`object_declaration`); `class_declaration` -> `class`, or `interface` when
it carries the `interface` keyword, or `record` when it is a `data class`;
`object_declaration` -> `class` with `meta.object = "1"`; `property_declaration` -> `const` for
`val`, `var` for `var`; `type_alias` -> `type`; a companion object's members take
`parent = <Outer>.Companion`. `exported` = the declaration has no `private`/`internal`
modifier. `meta.suspend = "1"` on suspend functions, `meta.annotations` as in Java.

**Imports, exports, calls, resolution.** As Java, with three differences: a Kotlin file may
declare several top-level types, so a fully qualified import resolves by searching the indexed
files of the target package directory for a declaration with that name; a file-level
`@file:JvmName` is recorded in `meta` and ignored for resolution; extension functions are
declared with name `<Receiver>.<name>` and `parent = <Receiver>` so a `recv.ext()` call
resolves the same way a method does.

### 1.6 Truth generators (languages)

Every generator is **independent of tree-sitter** and returns the existing `Truth` shape from
`bench/src/truth/ts.ts` (`files`, `imports`, `exports`, `calls`, `cycles`, `notes`). Each ships
as a small program in its own language, built once and cached under `bench/.corpus/.tools/`
keyed by a 16-hex hash of its sources, exactly like `bench/truth/gocallgraph`.

**Python, `bench/truth/pytruth/main.py`** (python3 3.14, standard library only). Walks the
file list, parses each with `ast.parse(source, type_comments=True)`, and emits one JSON
document on stdout with the same key set the Go tool uses.
- imports: every `ast.Import`/`ast.ImportFrom`, resolved with an implementation of PEP 328/420
  resolution written against `importlib.util.resolve_name` plus a `sys.path` built from the
  detected roots. A resolved module maps to its `.py` file through `importlib.machinery`'s
  `FileFinder` over the corpus root only (never the host's site-packages: the finder is given an
  explicit path list, and `sys.path` is not consulted).
- exports: module-level names not starting with `_`, or `__all__` when present, computed by
  walking the AST, never by importing the module. **Nothing is executed**; the tool never
  imports corpus code, so a malicious or broken corpus cannot run.
- calls: `ast.Call` nodes, with a scope-aware binder (module scope, class scope, function
  scope) mapping a callee name to a definition in the same module or to an imported module's
  definition. Ambiguous names are omitted from truth, matching the extractor's "never guess".
- notes: `["ast-only", "no-import-execution", "pep420-namespace-packages"]`.

**Rust, `bench/truth/rusttruth/`** (a cargo binary crate, edition 2021, `syn` 2 +
`proc-macro2` + `cargo_metadata`, `rustc` 1.88). `cargo metadata --no-deps --format-version 1`
gives the workspace members and each target's crate root; `syn::parse_file` gives the item tree
per file; the module tree is walked from each crate root so a `mod` item maps to the right file.
Imports come from `use` trees resolved against the module tree; exports are `pub` items;
calls are `syn::ExprCall`/`ExprMethodCall` resolved by the same conservative rules the extractor
uses, implemented independently. Vendored `Cargo.lock` pins every dependency; the build runs
`cargo build --release --offline` after a one-time `cargo fetch`, and the leaf reports the
fetch as a network prerequisite. notes: `["syn-item-tree", "cargo-metadata-roots",
"no-trait-dispatch"]`.

**Java, `bench/truth/javatruth/Truth.java`** (javac 21, `com.sun.source` Compiler Tree API,
compiled and run with the JDK already on the machine, no build tool). Creates a
`JavacTask` over the corpus's `.java` files with `-proc:none` and a classpath of exactly the
corpus's own source roots, walks each `CompilationUnitTree`, and resolves every
`MethodInvocationTree` through `Trees.getElement`. Unresolvable elements (missing third-party
jars) are recorded in `errors` and their files are dropped from `Truth.files`, so a file the
compiler never fully saw is never scored. exports come from `Elements.getAllMembers` filtered to
`public`. notes: `["javac-tree-api", "source-classpath-only", "unresolved-files-dropped"]`.

**Kotlin: see the ruling in 1.7.**

### 1.7 Ruling: Kotlin ships reported-only

**Decision.** Build 2 does not build a compiler-grade Kotlin truth generator for the corpus.
Kotlin's structural numbers are **reported, never gated**, and `RESULTS.md` states the truth
source as *"greplost fixture oracle; no corpus-scale compiler oracle: see the build-2 ruling"*.

**Why.** `kotlinc` is absent from this machine (a leaf may `brew install kotlin`, and CI must
install it), and installing it only yields a compiler, not a documented, stable, machine-readable
symbol and call dump. `kotlin-compiler-embeddable`'s PSI and FIR APIs are internal and change
shape between minor versions; a per-file import and call oracle through them is a multi-day JVM
sub-project on its own, out of proportion to one language in a build that adds eleven. Compiling
the chosen corpus (`kotlinx.coroutines`, a Gradle multiplatform build) outside Gradle is not
reliable either.

**What is built instead**, so Kotlin is not merely asserted:

1. `bench/truth/kotlintruth/` **is** built, but only for `fixtures/tiny-kotlin`, where
   compilation is trivially controllable: `kotlinc fixtures/tiny-kotlin -d <tmp>` then
   `javap -v -p` over the emitted classfiles. `javap -v` prints each class's `SourceFile`
   attribute, which restores per-`.kt` attribution; the constant pool and method bodies give
   exports and call edges. This is a genuine, independent, compiler-grade oracle for the
   fixture, and the fixture is written to exercise every extraction rule.
2. On the corpus, the Kotlin gate is: a deterministic build (two builds byte-identical), a
   parse-health bound (fewer than 1% of `.kt` files carry a root-level `ERROR` node, listed in
   the unparsable bucket), and non-empty extraction (declarations and imports > 0 for every
   file that is not empty).
3. `RESULTS.md` publishes Kotlin's S1 to S4 numbers **from the fixture oracle only**, labelled
   as such, and lists Kotlin under "where we do not have compiler truth" next to the existing
   losses table. A benchmark that hides which numbers are weaker is marketing (tech spec 10.1
   principle 6).

If a later build wants the corpus-scale oracle, the path is: pin a Kotlin version, run
`./gradlew compileKotlin` inside the corpus, then apply the same `javap -v` reader to the
Gradle-produced classfiles. That is recorded here so it is not rediscovered.

### 1.8 Tests (exact `describe` names)

`packages/core/test/extract-python.test.ts`: `declarations`, `imports`, `exports`, `calls`,
`__all__`, `tiny-python`.
`packages/core/test/extract-rust.test.ts`: `declarations`, `use trees`, `mod tree`, `calls`,
`visibility`, `tiny-rust`.
`packages/core/test/extract-java.test.ts`: `declarations`, `imports`, `annotations`, `calls`,
`tiny-java`.
`packages/core/test/extract-kotlin.test.ts`: `declarations`, `imports`, `extensions`, `calls`,
`tiny-kotlin`.
`bench/test/truth-python.test.ts`: `python tool`, `fixture truth`, `oracle independence`,
`no import execution`.
`bench/test/truth-rust.test.ts`: `rust tool`, `fixture truth`, `oracle independence`.
`bench/test/truth-java.test.ts`: `java tool`, `fixture truth`, `oracle independence`.
`bench/test/truth-kotlin.test.ts`: `kotlin fixture oracle`, `reported only`.

`oracle independence` asserts, in each case, that the truth generator's output changes when the
fixture changes and that the generator's module graph does not import anything from
`packages/core` (the oracle must never be scored against itself, tech spec 10.1 principle 2).

---

## 2. Sub-project: IaC (Terraform, Kubernetes and Helm, GitHub Actions, Dockerfiles)

### 2.1 Modules and ownership

| Module | Owner leaf |
|---|---|
| `packages/core/src/extract/hcl.ts`, `resolve/hcl.ts`, `references/hcl.ts`, `test/extract-hcl.test.ts`, `fixtures/tiny-terraform/**`, `bench/src/truth/hcl.ts`, `bench/truth/tfinspect/**`, `bench/test/truth-hcl.test.ts` | 2.2 |
| `packages/core/src/extract/yaml-k8s.ts`, `extract/yaml-helm.ts`, `references/yaml-k8s.ts`, `test/extract-yaml-k8s.test.ts`, `fixtures/tiny-k8s/**`, `fixtures/tiny-helm/**`, `bench/src/truth/yaml-k8s.ts`, `bench/src/truth/yaml-helm.ts`, `bench/test/truth-yaml-k8s.test.ts` | 2.8 |
| `packages/core/src/extract/yaml-actions.ts`, `references/yaml-actions.ts`, `test/extract-yaml-actions.test.ts`, `fixtures/tiny-actions/**`, `bench/src/truth/yaml-actions.ts`, `bench/test/truth-yaml-actions.test.ts` | 2.9 |
| `packages/core/src/extract/dockerfile.ts`, `resolve/dockerfile.ts`, `references/dockerfile.ts`, `test/extract-dockerfile.test.ts`, `fixtures/tiny-docker/**`, `bench/src/truth/dockerfile.ts`, `bench/test/truth-dockerfile.test.ts` | 2.10 |
| `packages/core/src/extract/yaml.ts` (flavour dispatcher), `resolve/yaml.ts`, `references/yaml.ts`, `bench/src/truth/yaml.ts` (flavour dispatcher) | 2.0 (seam) |

`extract/yaml.ts` is a dispatcher, written whole by the seam, that classifies each YAML
document and delegates. Classification is a pure function of the file path and the document's
top-level keys, in this order (first match wins, recorded in `meta.flavour`):

1. path matches `.github/workflows/*.y?ml` **and** the document has an `on` (or `"on"`) key ->
   `actions`
2. the file is `Chart.yaml`, `values.yaml`, or lives under a directory holding a `Chart.yaml` ->
   `helm`
3. the document has both `apiVersion` and `kind` -> `k8s`
4. otherwise -> `plain`, which contributes a file node with `loc` and nothing else

### 2.2 Terraform (HCL)

**Declarations.** A `block` node at the top level, by its first label:

| Block | DeclKind | Node name | `meta` |
|---|---|---|---|
| `resource "T" "N"` | `resource` | `T.N` | `type: T`, `provider: <T's first segment>` |
| `data "T" "N"` | `data` | `T.N` | `type: T`, `provider` |
| `variable "N"` | `variable` | `N` | `type` (the declared type expression), `default` when a literal, `sensitive` |
| `output "N"` | `output` | `N` | `sensitive` |
| `provider "N"` | `provider` | `N` | `alias` when present |
| `module "N"` | `module` | `N` | `source`, `version` |
| `locals` | `const` (one per attribute) | `local.<name>` | |
| `terraform` | `const` | `terraform` | `required_version` when a literal |

`exported` is `true` for `output` and `variable`, `false` otherwise. `signature` is the block
header as written (`resource "aws_s3_bucket" "logs"`).

**Imports.** Only `module` blocks produce an import: specifier = the `source` string.
`kind: "static"`, `symbols: []`, `reexport: false`.

**References** (`refKind: "hcl-ref"` unless noted). Every `variable_expr`/`get_attr` chain
inside an attribute value is walked, and an address is recorded when its head matches a known
prefix: `var.X`, `local.X`, `each.X` (ignored), `count.X` (ignored), `module.M.O`,
`data.T.N.attr`, `<T>.<N>.attr` (a managed resource), `provider`/`alias` in a `provider =`
meta-argument, and `depends_on = [ ... ]` entries. `to` in the `ReferenceRecord` is the raw
address text; the linker maps it to a node id. A `module.M.O` reference resolves to the module's
`output.O` node inside the module's directory when the module source is a local path
(`confidence: "med"`, one documented hop); when the source is a registry address it becomes
`ext:module/<source>` and is emitted with `refKind: "uses"`, `confidence: "high"`.
`provider "N"` blocks referenced by a resource's implicit provider (the type prefix) produce
`refKind: "hcl-ref"`, `confidence: "high"` only when exactly one provider block declares that
name and no `alias`.

**Resolution.** A local `module` source (`./x`, `../x`) targets that **directory** (a directory
id, as for Go, because Terraform loads all `.tf` in a directory as one module); a registry or
git source is `ext:module/<source>`. `terraform.required_providers` entries become
`ext:provider/<name>`.

**Truth, `bench/truth/tfinspect/main.go`** (Go, `github.com/hashicorp/terraform-config-inspect`
pinned in `go.mod`; the machine has terraform 1.12 and go). For each directory containing
`.tf` files, `tfconfig.LoadModule(dir)` yields the module's resources, data sources, variables,
outputs, provider requirements and module calls, each with a `Pos{Filename, Line}`, which is
exactly the per-file attribution greplost needs. imports = module calls mapped to
`(callerFile, targetDir)`; exports = variables and outputs per file; calls = **empty** (HCL has
no calls; `Truth.calls` is `[]` and S3 is `N/A` for HCL, printed as `n/a` rather than 0);
references = a second JSON key `references` that the HCL scorer reads, produced by
`terraform-config-inspect`'s expression references where available and, for the resource-to-
resource edges it does not model, by `terraform graph -type=plan` on the fixture only.
notes: `["terraform-config-inspect", "no-call-edges", "graph-only-on-fixture"]`.

`Truth` gains no field: the HCL scorer reads `references` from the tool's raw JSON, and
`bench/src/structural.ts` scores it as a fifth metric **S5 (reference precision/recall)**,
reported for every IaC target and gated at precision >= 0.95, recall reported.

### 2.3 Kubernetes and Helm YAML

**Declarations.** One `resource` node per document with `apiVersion` and `kind`:
name = `<kind>.<metadata.name>`, or `<kind>.#<docIndex>` when `metadata.name` is absent or
templated. `meta`: `apiVersion`, `kind`, `namespace` (when set), `flavour` (`k8s` or `helm`).
Container images inside a workload produce an `image` node per container:
name = `<containerName>`, `meta.image` = the image reference, `meta.container` = the name.
`exported` is `false` for every Kubernetes node (a manifest exports nothing).

Helm adds: `Chart.yaml` -> one `module` node named after the chart, `meta.version`,
`meta.appVersion`; `values.yaml` -> one `variable` node per **top-level** key
(`meta.path` = the dotted path, values below the top level are not nodes; the cap keeps a
1,000-key values file from producing 1,000 nodes).

**Helm template ruling.** A file under `templates/` is not valid YAML: it carries Go template
actions. greplost does **not** run `helm`. The extractor applies a documented, deterministic
pre-pass before parsing: every `{{ … }}` span is replaced, in place, by a placeholder of the
same byte length made of `_` characters (so every line and column is preserved and spans stay
truthful), and a `{{-`/`-}}` action that begins a line is replaced by an equal-length run of
spaces. `meta.templated = "1"` marks any node whose name or image came from a replaced span,
and such a node's name falls back to the document-index form. The raw templated text is kept in
`meta.nameTemplate` / `meta.imageTemplate`.

**References.** `selector`: a `Service`/`NetworkPolicy` selector whose match labels are a subset
of exactly one workload's pod template labels -> that workload's node, `confidence: "high"`;
more than one match -> dropped. `config-ref`: `configMapRef`, `secretRef`, `configMapKeyRef`,
`secretKeyRef`, `persistentVolumeClaim.claimName`, and `volumes[].configMap.name` -> the named
`ConfigMap`/`Secret`/`PVC` node when exactly one exists, `confidence: "high"`.
`helm-values`: a template action containing `.Values.<path>` -> the `values.yaml` top-level
variable node for the path's first segment, `confidence: "med"`.
`from-image`: an `image` node -> `ext:image/<ref>`, `confidence: "high"`.

**Truth, `bench/src/truth/yaml-k8s.ts`** (TypeScript, `js-yaml` 4, an **independent** parser
reading the same files; `js-yaml` is added to `bench/package.json` by leaf 2.0 so no wave leaf
adds a dependency). `js-yaml.loadAll` over each file gives the document list; the oracle then
computes the node set, the selector edges and the config edges from the parsed objects, with no
code shared with `packages/core`. `Truth.imports` is `[]`, `Truth.calls` is `[]`,
`Truth.exports` maps each file to its sorted node names, and the tool's raw JSON carries
`references` for S5.

For Helm the oracle is different and is stated as such: `helm template <chart>` (helm is present
on this machine) renders the chart with its default values, and the oracle scores the **set of
(kind, apiVersion) pairs and the per-template-file node counts** against greplost's templated
nodes. Names are not compared, because a rendered name is a value and greplost's is a template.
notes: `["js-yaml-oracle", "helm-template-render", "names-not-compared-for-templates"]`.

### 2.4 GitHub Actions

**Declarations.** One `job` node per `jobs.<id>` (name = the job id, `meta.name` = the display
name, `meta.runsOn`, `meta.if` when present); one `step` node per step,
name = `<jobId>.#<stepIndex>` (0-based), `meta.uses` or `meta.run` (first 80 characters,
whitespace collapsed), `meta.name`; one `task` node for a reusable-workflow call
(`jobs.<id>.uses`), name = the job id, `meta.uses`. A composite action's `action.yml` produces
the same `step` nodes with a synthetic job id `runs`.

**References.** `needs`: `jobs.<id>.needs` -> the named job's node, `confidence: "high"`.
`uses`: a step's `uses` -> `ext:action/<owner>/<repo>@<ref>` for a third-party action, or the
repo-local file (`./.github/actions/x/action.yml`) as a file id, or the reusable workflow file
for `jobs.<id>.uses: ./.github/workflows/y.yml`, `confidence: "high"`.
`config`: a `run:` body naming a script that exists in the repo (`bun run …`, `./scripts/x.sh`,
`node scripts/x.mjs`) -> that file id, `confidence: "high"` when exactly one repo path matches
the literal token, dropped otherwise. This is the "config file naming a code entry point" edge
from the schema, and it is what makes a workflow appear in a script's blast radius.

**Truth, `bench/src/truth/yaml-actions.ts`** reads the same files with `js-yaml` and, for the
workflow schema itself, with `@actions/workflow-parser`'s public parse entry point when it
installs cleanly; if it does not, the oracle is `js-yaml` plus a hand-written schema walk, and
the note says which was used. `Truth.exports` maps a workflow file to its sorted job ids;
`references` carries `needs`, `uses` and `config`. notes include `["js-yaml-oracle"]` or
`["actions-workflow-parser"]`.

### 2.5 Dockerfiles

**Declarations.** One `stage` node per `FROM`: name = the `AS <name>` alias, or `#<index>`
(0-based) when unnamed; `meta.base` = the base image reference, `meta.platform` when
`--platform` is given, `meta.index`. One `image` node per stage that is the final stage,
name = the stage name, `meta.entrypoint`/`meta.cmd` (first 120 characters) when present.
`ARG`/`ENV` at the top level -> `const` declarations named `arg.<N>` / `env.<N>` with
`meta.default` when a literal. `exported` is `true` for a named stage (another Dockerfile can
`COPY --from` it), `false` otherwise.

**References.** `from-image`: a stage -> the sibling stage node when the base names an earlier
stage in the same file (`confidence: "high"`), otherwise -> `ext:image/<ref>`.
`copy-from`: `COPY --from=<stage>` -> the named stage node (`high`) or `ext:image/<ref>`.
`config`: a `COPY`/`ADD` source that names exactly one indexed repo path -> that file id
(`high`); a glob or a build-context-relative path matching more than one file is dropped.

**Truth, `bench/src/truth/dockerfile.ts`** uses `dockerfile-ast` (added to `bench/package.json`
by leaf 2.0), an independent parser, reading the same files: `DockerfileParser.parse(source)`
gives instructions with ranges; the oracle derives stages, base images, `COPY --from` edges and
`ARG`/`ENV` from the instruction list. `Truth.exports` maps a file to its sorted stage names;
`references` carries `from-image`, `copy-from` and `config`. notes: `["dockerfile-ast-oracle"]`.

### 2.6 Tests (exact `describe` names)

`extract-hcl.test.ts`: `blocks`, `module imports`, `references`, `locals`, `tiny-terraform`.
`extract-yaml-k8s.test.ts`: `documents`, `images`, `selectors`, `config refs`,
`helm templates`, `values`, `tiny-k8s`, `tiny-helm`.
`extract-yaml-actions.test.ts`: `jobs`, `steps`, `needs`, `uses`, `run scripts`, `tiny-actions`.
`extract-dockerfile.test.ts`: `stages`, `base images`, `copy from`, `args`, `tiny-docker`.
`bench/test/truth-hcl.test.ts`: `tf tool`, `fixture truth`, `oracle independence`.
`bench/test/truth-yaml-k8s.test.ts`: `js-yaml oracle`, `helm render`, `oracle independence`.
`bench/test/truth-yaml-actions.test.ts`: `workflow oracle`, `oracle independence`.
`bench/test/truth-dockerfile.test.ts`: `dockerfile-ast oracle`, `oracle independence`.

---

## 3. Sub-project: signals (React, TanStack Start, Next.js, Pulumi)

Tech spec 5.1 lists "Signals (v1.5)" as a extraction row. Build 2 makes it a real layer: a
**signal pass** runs after the language extractor, over the same parse tree, and contributes
extra `Declaration`s and `ReferenceRecord`s without changing anything the language extractor
produced.

### 3.1 Contract

```ts
// packages/core/src/signals/index.ts   (owned by leaf 2.0, complete on day one)
export interface SignalPass {
  /** Stable, sorted id; also the value of `meta.signal` on every node it produces. */
  readonly id: "react" | "tanstack" | "next" | "pulumi-ts" | "pulumi-go";
  readonly langs: ReadonlySet<Lang>;
  /** Cheap path/text test; a pass that returns false is never given the tree. */
  applies(path: string, source: string): boolean;
  run(input: SignalInput): SignalOutput;
}

export interface SignalInput {
  path: string;
  lang: Lang;
  source: string;
  tree: Tree;
  /** What the language extractor already found, frozen. */
  base: Readonly<Pick<FileRecord, "decls" | "imports" | "exports" | "calls">>;
}

export interface SignalOutput {
  decls: Declaration[];
  refs: ReferenceRecord[];
}

/** Sorted by `id`; `extractFile` runs each applicable pass and concatenates. */
export const SIGNAL_PASSES: readonly SignalPass[];
export function runSignals(input: SignalInput): SignalOutput;
```

Determinism: passes run in `id` order, their outputs are concatenated then sorted with
`compareDeclarations` (declarations) and by `(from, to, refKind, line)` (references); a pass may
not read the filesystem, the clock or the environment. Every signal node carries
`meta.signal = <pass id>`. A signal node never replaces a language declaration: `Button.tsx`
still has its `function Button` declaration **and** a `component.Button` node, and the component
node's `meta.decl` names the declaration's symbol path so the card can link them.

Passes are enabled by `config.signals` (a new optional key, defaulting to every pass whose
`applies` returns true): no config change is needed for the common case, and
`{ "signals": [] }` turns the layer off entirely, which is how a repo opts out.

### 3.2 React components (pass `react`, leaf 2.3)

`applies`: lang is `tsx`/`jsx`, or the source contains `from "react"`.

A declaration is a component when it is a function or a class, its name starts with an
upper-case letter, and either (a) its body contains a `jsx_element`/`jsx_self_closing_element`
return, or (b) it is wrapped in `React.memo`/`forwardRef`. Node: `component.<Name>`,
`meta.decl` = the declaration's symbol path, `meta.hooks` = the sorted, comma-joined names of
`use*` calls in its body, `meta.props` = the props type name when the signature names one.
No reference edges.

### 3.3 TanStack Start routes and loaders (pass `tanstack`, leaf 2.3)

`applies`: the source contains `createFileRoute` or `createRootRoute`, or the path is under a
directory named `routes` in a repo whose root has a `@tanstack/react-start` dependency.

A `createFileRoute("<path>")(...)` call gives a `route.<path>` node with
`meta.framework = "tanstack-start"`, `meta.file` = the route file; `createRootRoute` gives
`route./`. Inside the options object, a `loader` property gives a
`handler.loader` node, `beforeLoad` gives `handler.beforeLoad`, `component` gives a
`route-handler` reference to the referenced component node (or declaration),
`confidence: "high"` when the property's value is a single identifier that resolves in the same
file, `med` when it resolves through exactly one import, dropped otherwise. `server routes`
(`createServerFileRoute`) give `route.<path>` with `meta.server = "1"` and one `handler.<METHOD>`
per method key.

When the route path is not a string literal, the pass emits nothing for that call: a route whose
path is computed is not a route greplost can name.

### 3.4 Next.js app routes (pass `next`, leaf 2.3)

`applies`: the path matches `**/app/**/{page,layout,route,loading,error,template,default}.{ts,tsx,js,jsx}`.

The route path is derived from the directory path under `app/`: segments are kept, `(group)`
segments are dropped, `[slug]`/`[...rest]`/`[[...opt]]` are kept verbatim, `@slot` parallel
routes are dropped from the path and recorded in `meta.slot`. `page.tsx` -> `route.<path>` with
`meta.kind = "page"`; `layout.tsx` -> `route.<path>` with `meta.kind = "layout"`;
`route.ts` -> `route.<path>` with `meta.kind = "handler"` plus one `handler.<METHOD>` node per
exported `GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS` function. `meta.dynamic` is `"1"` when any
segment is dynamic; `meta.runtime` records an exported `runtime` const when it is a string
literal. A `route-handler` reference links a `page` route to its default-exported component
declaration.

Pages Router (`pages/**`) is explicitly **not** covered in build 2; the spec says so and the
Next.js corpus subset is chosen to be App Router only.

### 3.5 Pulumi TypeScript (pass `pulumi-ts`, leaf 2.3)

`applies`: the source contains `@pulumi/`.

A `new X(...)` expression whose constructor `X` resolves to a class that extends
`pulumi.CustomResource`, `pulumi.ComponentResource` or a class from an `@pulumi/*` import gives
a `resource.<varName>` node, where `varName` is the identifier the expression is assigned to,
or `#<index>` when it is not assigned. `meta.type` = the Pulumi type token when the class is
from a `@pulumi/<provider>` module (derived as `<provider>:<module>/<class lower-cased first
letter>:<Class>` from the import specifier and the class name, recorded verbatim in
`meta.typeSource = "import-path"`), `meta.provider` = the provider segment,
`meta.resourceName` = the first constructor argument when it is a string literal.

`resource-input`: an argument expression that reads a property of another resource in the same
file (`bucket.arn`, `vpc.id`, or an `.apply(...)` on one) gives a reference from the new
resource's node to the referenced resource's node, `refKind: "resource-input"`,
`symbols: ["<var>.<prop>"]`, `confidence: "high"` when the referenced identifier is bound to
exactly one resource node in the file, `med` when it is imported from exactly one other indexed
file that declares it, dropped otherwise.

**The class check is structural, not name-based**: the pass resolves the constructor identifier
to its import, and the import's specifier must start with `@pulumi/`, or the class must be
declared in the same file with a heritage clause naming a `pulumi.*Resource`. A local class
named `Bucket` is not a resource.

### 3.6 Pulumi Go (pass `pulumi-go`, leaf 2.7)

`applies`: lang is `go` and the source imports a path starting with
`github.com/pulumi/pulumi-` or `github.com/pulumi/pulumi/sdk`.

A call `<pkg>.New<Type>(ctx, "<name>", &<pkg>.<Type>Args{...})` where `<pkg>` is an alias of a
`github.com/pulumi/pulumi-<provider>/sdk/...` import gives a `resource.<varName>` node
(`varName` from the `:=` binding, or `#<index>`), `meta.type` =
`<provider>:<last import segment>/<lower-cased Type>:<Type>`, `meta.provider`,
`meta.resourceName` = the string-literal second argument.
`resource-input`: a field value in the `Args` literal that reads another resource variable's
field (`vpc.ID()`, `bucket.Arn`) gives a `resource-input` reference under the same confidence
rules as 3.5.

### 3.7 Truth generators (signals)

**Pulumi TS and the TS/TSX signal passes, `bench/src/truth/signals-ts.ts`.** The oracle is the
**TypeScript compiler**, reusing the program construction already written for
`bench/src/truth/ts.ts` (`ts.createProgram` with the workspace emulation from ruling 10.3) but
none of its edge logic. For each source file it walks the AST with the type checker available:
- components: a function/class whose return type is assignable to `JSX.Element`/`ReactNode`, or
  whose declaration is wrapped in `React.memo`/`forwardRef` (checked through the checker's
  symbol of the callee, not the text).
- Pulumi resources: `new X()` where `checker.getTypeAtLocation(X)`'s declared class has
  `pulumi.CustomResource` or `pulumi.ComponentResource` in its base-type chain, the exact check
  the scope calls for, and one only a checker can make.
- routes: `createFileRoute` call sites where the callee's symbol resolves to
  `@tanstack/react-start`/`@tanstack/react-router`; Next.js routes are derived from the file
  path by an independent implementation of the App Router path rules, plus the checker for the
  exported HTTP-method functions.
notes: `["tsc-checker-oracle", "base-type-chain-for-pulumi", "app-router-path-rules"]`.

**Pulumi Go, `bench/truth/pulumigotruth/main.go`**, a second Go program next to
`gocallgraph`, using `golang.org/x/tools/go/packages` with `NeedTypes|NeedTypesInfo` and
`go/types` to find calls whose result type implements `pulumi.Resource` (the interface is looked
up in the loaded package set with `types.Implements`). Per-file attribution comes from the
`token.FileSet`. notes: `["go-types-oracle", "types-implements-pulumi-resource"]`.

Both are scored on the **node set** (S6: signal-node precision/recall, gated at precision
>= 0.95, recall reported) and on `resource-input` edges (folded into S5).

### 3.8 Tests (exact `describe` names)

`packages/core/test/signals-ts.test.ts`: `react components`, `tanstack routes`,
`tanstack loaders`, `next app routes`, `next handlers`, `pulumi resources`,
`resource inputs`, `pass ordering`, `signals disabled`, `tiny-signals-ts`.
`packages/core/test/signals-pulumi-go.test.ts`: `pulumi go resources`, `resource inputs`,
`tiny-pulumi-go`.
`bench/test/signals-ts.test.ts`: `checker oracle`, `oracle independence`.
`bench/test/signals-pulumi-go.test.ts`: `go types oracle`, `oracle independence`.

---

## 4. Sub-project: render and CLI for non-file nodes (leaf 2.11)

### 4.1 The problem, stated precisely

Everything downstream of the manifest is driven by `manifest.files`:
`createContext` builds `filesByPackage` from `Object.keys(manifest.files)`, `renderArtifacts`
loops over it to emit cards, `buildCard` throws for anything else, `impact` refuses anything
`resolveFile` does not find, and `isFileId(to) ? [to] : filesInDirectory.get(to)` silently
resolves a `#` id to the empty list. Reference edges are read by nothing.

### 4.2 Decision: no `Manifest.nodes`

Non-file nodes stay in `graph/symbols.jsonl` as `Declaration`s whose `kind` is in `NODE_KINDS`.
The manifest is unchanged. Reasons: the manifest is the hot path for `verify` and incremental
update and must stay small; a node's blast radius is cheap to compute on demand
(`impactOf` is already id-agnostic and is already called per `impact` invocation); and a
`FileEntry` for a node would carry five fields that mean nothing for one (`sha256`, `loc`,
`fanOut`, `summaryHash`, `staleSummary`).

### 4.3 Contracts

```ts
// packages/core/src/serialize/read.ts, Structure gains one field
export interface Structure { /* … */ references: ReferenceEdge[]; }   // [] when the file is absent

// packages/core/src/graph/query.ts
export function findSymbols(symbols: Declaration[], needle: string): Declaration[];   // unchanged
export function nodesOf(symbols: readonly Declaration[], file: string): Declaration[];
export function referencesOf(refs: readonly ReferenceEdge[], id: string): ReferenceEdge[];
export function referencedBy(refs: readonly ReferenceEdge[], id: string): ReferenceEdge[];
/** import ∪ reexport ∪ reference pairs, for blast radius over a mixed graph. */
export function impactPairs(structure: Structure): Array<readonly [string, string]>;

// packages/render/src/slug.ts
export function nodeSlug(kind: DeclKind, name: string): string;
export function nodeCardPath(pkg: PackageInfo, id: string): string;

// packages/render/src/docs/node-card.ts
export function buildNodeCard(ctx: DocContext, id: string): string;

// packages/render/src/render.ts, DocContext gains
nodesOf: Map<string, Declaration[]>;          // file id -> its node declarations, span-sorted
declById: Map<string, Declaration>;
referencesFrom: Map<string, ReferenceEdge[]>;
referencesTo: Map<string, ReferenceEdge[]>;
nodeCardPathOf(id: string): string | undefined;
```

`renderArtifacts` emits, after each file card, one card per node declared in that file, at
`nodeCardPath(pkg, id)`. `assertNoCardCollision` throws when two artifacts claim one path.

### 4.4 The node card

```markdown
# infra/main.tf#resource.aws_s3_bucket.logs

> Generated by greplost. Do not edit by hand; run `greplost update`.

**Kind:** `resource`  **In file:** [`infra/main.tf`](../main.tf.md)
**Package:** `infra` ([map](../../../MAP.md))
**Attributes:** `type: aws_s3_bucket`, `provider: aws`
**References:** [`aws_kms_key.logs`](resource.aws_kms_key.logs.md) (hcl-ref), `ext:provider/aws` (hcl-ref)
**Referenced by:** [`aws_s3_bucket_policy.logs`](resource.aws_s3_bucket_policy.logs.md) (hcl-ref)
**Blast radius:** 4 node(s) (`greplost impact infra/main.tf#resource.aws_s3_bucket.logs`)
**Source:** L12-31
```

Rules: `**Attributes:**` lists `meta` in sorted key order, `` `k: v` `` joined by `, `, omitted
when `meta` is absent. `**References:**` and `**Referenced by:**` are capped at
`REFERENCE_CAP = 50` with the existing `, … N more` tail, sorted by target id, each labelled
with its `refKind`. Blast radius counts nodes reachable in reverse over `impactPairs`. Links
are relative and never contain `#`.

The **file card** gains one block, inserted between `**Key symbols:**` and `**Calls:**`,
omitted when the file has no nodes:

```markdown
**Nodes:**
- [`resource.aws_s3_bucket.logs`](main.tf/resource.aws_s3_bucket.logs.md)  L12-31
```

capped at `NODE_CAP = 50`. `**Key symbols:**` continues to list only non-node declarations, so
a Terraform file's 40 resources appear once, under Nodes, not twice.

Package `MAP.md` gains a `## Nodes` section listing node counts per file (only when the package
has any), and `INDEX.md` gains one column, `nodes`, in the package table (only when the repo has
any). Neither changes a byte for a repo with no nodes, the M1 token budget is unaffected for
existing users, which is asserted by a test.

### 4.5 CLI

`greplost query <symbol|path|node-id>`: `resolveFile` is tried first (unchanged); then an exact
node-id match against `structure.symbols`; then `findSymbols`. `QueryMatch` gains
`meta?: Record<string, string>`, `card` now points at the node card for a node kind, and two new
arrays:

```ts
export interface QueryMatch {
  /* … existing fields … */
  meta?: Record<string, string>;
  references: Array<{ to: string; refKind: string; confidence: Confidence }>;
  referencedBy: Array<{ from: string; refKind: string; confidence: Confidence }>;
}
```

`QueryResult` gains `node?: QueryNode` mirroring `QueryFile` for a node target
(`{ id, file, kind, name, meta, card, references, referencedBy, blast, span }`).

`greplost impact <path|node-id>`: `resolveFile` first; then an exact node id present in
`structure.symbols`. For a node target, `radius` is `impactOf(impactPairs(structure), id).length`
and `files` becomes `nodes: Array<{ id: string; depth: number }>`; the JSON keeps `files` for a
file target (no breaking change for existing consumers) and adds `nodes` only for a node target.
`--depth` filters as before.

`looksLikePath` gains: a candidate containing `#` is never a path. `toRepoRelative` leaves `#`
alone (it already does).

Workspace mode (`packages/workspace/src/impact.ts`) is unchanged in build 2; a node id is
repo-local and cross-repo reference edges are out of scope. The spec says so.

### 4.6 Tests (exact `describe` names)

`packages/render/test/nodes.test.ts`: `node card`, `node card path`, `file card nodes block`,
`no nodes no change`, `card path collisions`, `reference caps`, `golden tiny-terraform`.
`packages/cli/test/nodes.test.ts`: `query node`, `query node json`, `impact node`,
`impact node json`, `looksLikePath rejects hashes`, `file target unchanged`.
`packages/core/test/references.test.ts`: `references jsonl round trip`, `impactPairs`,
`referencesOf`, `absent references file`.

`no nodes no change` is the regression that protects every existing user: build the `tiny-ts`
fixture and assert the artifact map is byte-identical to the build-1 golden except for the
manifest's `version` field.

---

## 5. Sub-project: bench coverage (leaves 2.1 to 2.10 contribute; leaf 2.12 integrates)

### 5.1 Corpus

Pinned 2026-09-04 by `git ls-remote`/`rev-parse` on this machine; file counts measured by
`git ls-tree -r --name-only` at the pinned commit. Every repo is permissively licensed, verified
through the GitHub API on 2026-09-04: MIT (pydantic, docker-python, docker-node, starter-workflows,
TanStack/router, next.js), Apache-2.0 (gson, kotlinx.coroutines, both terraform-aws-modules,
kubernetes/examples, pulumi/examples), and the Unlicense/MIT dual grant on ripgrep. Two report
`NOASSERTION` to GitHub's detector and were checked by hand: `bitnami/charts` carries
`SPDX-License-Identifier: APACHE-2.0` in `LICENSE.md`, and `actions/starter-workflows` carries a
plain MIT `LICENSE`. Added to `bench/corpus.json` **in one edit by leaf 2.0**, so no wave leaf
touches that file.

| name | repo | commit | tier | lang | subset (counted) |
|---|---|---|---|---|---|
| pydantic | pydantic/pydantic | `c23cb86ef197693fc016437614f174252a3d189a` | S | python | `pydantic/`, 105 `.py` |
| ripgrep | BurntSushi/ripgrep | `3fce3b5bb0236da2df6d99672afb8a719642eca7` | S | rust | `crates/`, 95 `.rs` |
| gson | google/gson | `b3f4ca20087f9066de4c340522ff84e0558e1ad1` | S | java | `**/src/main/`, 122 `.java` |
| coroutines | Kotlin/kotlinx.coroutines | `f63a04bacb8beeafcc9d49199b1e4bb08931b7eb` | S | kotlin | `kotlinx-coroutines-core/{common,jvm}/src/`, 163 `.kt` |
| tf-aws-vpc | terraform-aws-modules/terraform-aws-vpc | `cf0e3ca46fd51f47bf095957f2a6ac6127c89045` | S | hcl | whole repo, 77 `.tf` |
| tf-aws-eks | terraform-aws-modules/terraform-aws-eks | `48a429f63cf96361ea2f4b42677d0cc8a9a656e0` | S | hcl | whole repo, 87 `.tf` |
| k8s-examples | kubernetes/examples | `d6b8cd27eacb51e651a1aa6f7c190a28713eff6e` | S | yaml | whole repo, 250 `.yaml` (plain manifests) |
| bitnami-charts | bitnami/charts | `8f8032ba37888cdeb20b35a2136fb1e8b5557e97` | S | yaml | `bitnami/{wordpress,kafka,postgresql,redis}/`, 130 `.yaml` (Helm) |
| starter-workflows | actions/starter-workflows | `e3c451d60f119b71caebf13c98ac45da6e15b4b7` | S | yaml | whole repo, 187 workflow `.yml` |
| docker-python | docker-library/python | `8f2cb2e1c9cae4d8f772fe61f1427c96acea3257` | S | dockerfile | whole repo, 44 Dockerfiles |
| docker-node | nodejs/docker-node | `b6ff152e7276a8ab650533769b8cc099883cdffa` | S | dockerfile | whole repo, 21 Dockerfiles |
| pulumi-ts | pulumi/examples | `2d507c12f836f67323fb1ba80454035eac082b27` | S | ts | `aws-ts-*/`, 122 `.ts` |
| pulumi-go | pulumi/examples | `2d507c12f836f67323fb1ba80454035eac082b27` | S | go | `*-go-*/`, 85 `.go` |
| tanstack-start | TanStack/router | `650acb4a894f7bf36bd3591de65d10bca9594254` | S | tsx | `examples/react/start-*/`, 391 `.ts`/`.tsx` |
| next-app | vercel/next.js | `1b5400c92633ca56c81c4c0a670e3416992ef64e` | S | tsx | `examples/*/app/**`, 338 `.ts`/`.tsx` (App Router, 82 apps) |

Two entries are honestly below the tier-S band and are labelled as such in `RESULTS.md`:
**docker-python (44)** and **docker-node (21)**. No public repository carries 100+ Dockerfiles;
the two together give 65, which is the realistic ceiling for the format, and greplost's own
repo adds its Dockerfiles on top. `CorpusRepoEntry` gains a `subset?: string` field (a picomatch
pattern applied by `corpus.ts` when it writes the per-repo `.greplost/config.json` include
list), so a subset is enforced by the harness rather than remembered by a human.

`CorpusLang` widens from `"ts" | "go"` to `Lang`. `structural.ts`'s local
`interface CorpusRepo { lang?: string }` is replaced by the typed entry so an unknown language
can no longer be silently scored as TypeScript; that gap is a bug leaf 2.0 closes.

### 5.2 Harness changes (all owned by leaf 2.0, so no language leaf edits a shared file)

```ts
// bench/src/fixtures.ts   (new)
export const FIXTURES: Readonly<Record<string, { root: string; lang: Lang }>>;
//   tiny-ts, tiny-go, tiny-python, tiny-rust, tiny-java, tiny-kotlin, tiny-terraform,
//   tiny-k8s, tiny-helm, tiny-actions, tiny-docker, tiny-signals-ts, tiny-pulumi-go

// bench/src/truth/registry.ts   (new)
export interface TruthModule {
  generateTruth(root: string, files: string[]): Truth;
  /** Raw, non-`Truth` payload the IaC and signal scorers read: reference and node sets. */
  generateExtra?(root: string, files: string[]): { references: Edge[]; nodes: string[] };
  readonly NOTES?: readonly string[];
}
/** Dynamic `import("./<lang>.ts")`; throws a clear error naming the missing module. */
export async function loadTruth(lang: Lang): Promise<TruthModule>;
```

`bench/src/structural.ts` changes:
- `parseArgs` gains `--fixture <name>` (bare `--fixture` still means `tiny-ts`, and
  `--fixture-go` still means `tiny-go`, so every build-1 gate keeps passing) and `--lang <lang>`.
- `TruthLang` becomes `Lang`; `resolveTargets` reads `entry.lang` directly.
- `scoredFiles(snapshot, lang)` matches `file.lang === lang`, with `ts|tsx|js|jsx` as one family.
- `buildOptionsFor` injects `{ ...DEFAULT_CONFIG, languages: [lang] }` for every non-TS-family
  target (generalising the existing Go special case), and applies the corpus entry's `subset`.
- `TARGETS` gains `S5: 0.95` (reference precision) and `S6: 0.95` (signal-node precision).
- `missedMetrics` gains `S5`/`S6`, and treats a metric as **`n/a`** rather than a miss when the
  truth module reports it as unsupported (HCL has no calls; Kotlin has no corpus oracle).
  `n/a` prints as `n/a` and is never a pass or a fail.
- **A gate whose every metric is `n/a` must not pass vacuously.** When a target's truth module
  reports no gated metric at all, `--gate` instead requires three substitute checks, and prints
  them: the snapshot is byte-identical when built twice, fewer than 1% of the target's files
  carry a root-level `ERROR` node (the unparsable bucket lists them), and every non-empty file
  yields at least one declaration or import. This is what actually gates Kotlin, and leaf 2.0
  builds it; without it `bench:structural --repo coroutines --gate` would pass on an extractor
  that returned nothing.
- the payload gains `perLang: Record<Lang, { repos: string[]; gated: boolean; truthSource: string }>`.

### 5.3 CI

`.github/workflows/ci.yml` (leaf 2.12) grows one job, `structural-langs`, running on
`ubuntu-latest` with: `actions/setup-python@v5` (3.14), `dtolnay/rust-toolchain@stable` (1.88),
`actions/setup-java@v4` (temurin 21), `fwilhe2/setup-kotlin@v1` **or**
`sudo snap install --classic kotlin` (the leaf verifies which works and records it),
`hashicorp/setup-terraform@v3` (1.12), `azure/setup-helm@v4`, and Docker preinstalled on the
runner. The job runs `bun run bench:structural --tier S --gate` over the build-2 corpus. The
existing `verify`/test jobs are untouched. Truth tools are cached by their source hash through
`actions/cache` on `bench/.corpus/.tools`.

Because the corpus clones cost minutes, the language job runs on `pull_request` for paths under
`packages/core/src/{extract,resolve,references,signals}/**` and `bench/**`, and on a nightly
schedule for everything.

### 5.4 Documentation (leaf 2.12)

- `bench/RESULTS.md`: a new "Languages, IaC and signals" section, generated from the payload,
  with one row per language: corpus, files scored, S1, S2, S3, S4, S5, S6, truth source, gated
  or reported. The out-of-scope sentence from the top of this spec goes directly under the X
  table.
- `README.md`: the language list in the pitch, and one sentence saying the head-to-head numbers
  cover TypeScript and Go only. Regenerated through `bun run readme:sync`; `readme:check` must
  stay green.
- `docs/greplost-tech-spec.md` Appendix C: one ruling row per decision recorded here (schema 2,
  node ids, Helm template pre-pass, Kotlin reported-only, Dockerfile corpus size, head-to-head
  scope).
- This repo's own `.greplost/config.json` gains `yaml` and `dockerfile`; the pre-commit hook
  refreshes the dogfood map.

### 5.5 Tests (exact `describe` names)

`bench/test/registry.test.ts`: `loadTruth`, `missing module error`, `fixtures table`.
`bench/test/structural-langs.test.ts`: `per-lang targets`, `subset config`, `n/a metrics`,
`S5 and S6`, `build-1 flags still work`.
`bench/test/corpus.test.ts` gains `subset patterns` and `every build-2 entry resolves`.
