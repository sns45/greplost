# Sub-project spec: semantic

Implements tech spec section 6. Package: `packages/semantic` (`@greplost/semantic`). Leaf 1.6 owns `packages/semantic/**`.

## Contract

```ts
export type PromptRunner = (prompt: string, opts: { model: string }) => Promise<string>;   // default: `claude -p --model <m> --output-format text` via child process
export interface RefreshOptions { pkg?: string; model?: string; runner?: PromptRunner; dryRun?: boolean; batchSize?: number /* default 12 */; today?: string /* YYYY-MM-DD, default new Date() */; }
export interface RefreshResult { refreshed: number; skipped: number; calls: number; flows: string[]; }
export async function refresh(root: string, opts?: RefreshOptions): Promise<RefreshResult>;
export function selectEntryPoints(snapshot: Snapshot, pkg: PackageInfo): string[];   // deterministic heuristic below
export function renderFlows(pkg: PackageInfo, flows: Flow[]): string;               // FLOWS.md text
export interface Flow { title: string; steps: Array<{ file: string; symbol?: string; note: string }>; mermaid: string; }
```

## Rules

- Stale set: `manifest.files[f]` with `staleSummary === true` or without `summaryHash`, restricted to `pkg` when given. Files are batched (`batchSize`) into one prompt each: the prompt carries, per file, the path, the exports line and key symbols from the module card (never the whole source; at most the first 120 lines of source when exports are empty), and asks for a JSON object `{ "<path>": "<one paragraph>" }`. Rule in the prompt: one paragraph of intent, no restating of signatures, no markdown.
- Cache write: `cache/summaries.json` = `stableStringify(cache, 2) + "\n"`, key = the file's sha256, value `{ path, text, refreshedAt: today, model }`. Entries whose sha256 is no longer in the manifest and whose path has a fresher entry are pruned; the newest stale entry per path is kept so the banner can show it.
- After writing the cache, run `update({ mode: "incremental" })` from `@greplost/sync` so cards pick up the text (the structure layer stays byte-stable: only card prose changes, and only through the committed cache).
- `FLOWS.md` per package: `selectEntryPoints` = files in the package with `fanIn === 0` whose basename matches `/^(main|index|server|app|cli|worker|handler)\./` or that contain an exported function named `main`/`handler`/`fetch`, sorted by descending downstream reach (transitive import closure size), top 5. The prompt gets, per entry point, the ordered list of files reachable within depth 3 and the resolved call edges among them, and asks for 2 to 5 flows as JSON (`Flow[]` with a `sequenceDiagram` body the runner returns as text; greplost wraps it in a fence). Output file `packages/<slug>/FLOWS.md`: title, `> Semantic layer, refreshed <today>; may lag code.`, one `## <title>` per flow with the numbered steps and the diagram.
- `dryRun` builds prompts and reports counts without calling the runner.
- Cost discipline: the second `refresh` on an unchanged repo makes zero runner calls (gate).
- Model default: `config.semantic.model`.

## Tests

- Injected runner returning canned JSON: first refresh on `fixtures/tiny-ts` (temp copy with an initialised map) writes 12 entries and renders cards with the text (assert `packages/core/src/retry.ts` card contains the canned sentence); second refresh → `calls === 0`; edit one file → exactly one stale entry, banner rendered with `refreshedAt`, refresh → one call for one file (batch of 1); `--pkg @tiny/core` restricts; `dryRun` makes no calls and writes nothing; FLOWS.md for `worker` names `apps/worker/src/main.ts` as the entry point; a runner that returns invalid JSON produces a clear error and leaves the cache untouched.
