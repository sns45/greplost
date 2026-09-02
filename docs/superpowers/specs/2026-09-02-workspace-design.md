# Sub-project spec: workspace

Implements tech spec section 4.4 (multi-repo mode) and X10. Package: `packages/workspace` (`@greplost/workspace`). Leaf 1.7 owns `packages/workspace/**` and `fixtures/two-repo-workspace/**`.

## Contract

```ts
export interface WorkspaceConfig { name: string; repos: string[]; }   // greplost.workspace.json at the workspace root; repos are relative dirs
export function findWorkspaceRoot(startDir: string): string | null;     // nearest ancestor with greplost.workspace.json
export function loadWorkspace(root: string): WorkspaceConfig;
export interface CrossEdge { from: string; to: string; kind: "import"; symbols?: string[]; confidence: "high"; specifier: string; }  // ids are `<repoDir>::<fileId>`
export interface WorkspaceBuild { repos: Array<{ dir: string; name: string; packages: string[]; files: number }>; cross: CrossEdge[]; files: Map<string, string>; }
export async function buildWorkspace(root: string): Promise<WorkspaceBuild>;   // ensures each repo's .greplost/ is fresh (update incremental), then computes cross edges and renders
export async function verifyWorkspace(root: string): Promise<VerifyResult>;
export function impactAcross(root: string, target: string /* repoDir::file */, depth?: number): Array<{ id: string; depth: number }>;
```

## Rules

- Cross-repo edge source (v1): an `ImportEdge` in repo A whose `to` is `ext:<pkg>` where `<pkg>` equals the name of a package (`source: "package.json"` or the root package) in sibling repo B, or a Go import path that starts with sibling B's module path. The edge targets B's package entry file when B's package.json `exports`/`main` resolves to an indexed file, else B's package pseudo-id `pkg:<name>`.
- Artifacts at `<workspace>/.greplost/`: `WORKSPACE.md` (title `# <name> workspace`, generated line, a table of repos with package counts and file counts and links `./<repo>/.greplost/INDEX.md`, a Mermaid `graph LR` of repos with cross-edge counts, and a `## Cross-repo dependencies` table From (repo, file) | To (repo, package) | Symbols) and `graph/cross.jsonl` (sorted CrossEdge lines, same serialization rules as core).
- `impactAcross`: reverse BFS over the union of every repo's import + reexport edges (prefixed with `<repoDir>::`) and the cross edges; results sorted by (depth, id).
- `verifyWorkspace` = every repo's `verify` plus a byte comparison of the workspace artifacts.
- CLI integration (owned by the cli leaf, already landed): when `findWorkspaceRoot(cwd)` is non-null and the command is `update`, `verify` or `impact`, the CLI calls the workspace functions; this leaf adds the small dispatch in `packages/cli/src/commands/{update,verify,impact}.ts` only if the CLI leaf left the documented `workspaceHook` seam; otherwise it reports the seam as a concern and the driver wires it.

## Fixture

`fixtures/two-repo-workspace/greplost.workspace.json` `{ "name": "two-repo", "repos": ["./repo-a", "./repo-b"] }`; `repo-a` publishes `@fx/a` (package.json `name`, `exports: { ".": "./src/index.ts" }`, `src/index.ts` exporting `hello`); `repo-b` (package `@fx/b`) imports `{ hello } from "@fx/a"` in `src/main.ts`; each repo has 2 to 3 files. Each repo directory is a plain directory (no nested `.git`), so the fixture stays hermetic.

## Tests

- `buildWorkspace` on a temp copy of the fixture: one cross edge `repo-b::src/main.ts → repo-a::src/index.ts` with symbols `["hello"]`; `WORKSPACE.md` and `graph/cross.jsonl` byte-stable across two builds; `impactAcross(root, "repo-a::src/index.ts")` contains `repo-b::src/main.ts` at depth 1; `verifyWorkspace` ok, then fails after editing `repo-a/src/index.ts` without updating, then ok after `buildWorkspace`.
