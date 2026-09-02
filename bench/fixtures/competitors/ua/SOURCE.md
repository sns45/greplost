# Provenance: Understand-Anything fixture

Hand-written to Understand-Anything's documented output format.
**Understand-Anything was not run to produce this file** — the bench does not
install competitor tools, and the adapters are exercised on fixtures (leaf 1.5.2
brief). Everything below says where each part of the format came from and which
parts are inferred.

## Pinned version

| | |
|---|---|
| Repo | <https://github.com/Egonex-AI/Understand-Anything> (moved from `Lum1104/Understand-Anything`) |
| Version | `v2.9.0` |
| Commit | `f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8` |
| Marketplace | `/plugin marketplace add Egonex-AI/Understand-Anything` |

## What the fixture describes

`fixtures/tiny-ts`, restricted to seven files:
`apps/worker/src/{main,config}.ts` and
`packages/core/src/{registry,retry,bus,events,queue}.ts`, plus the workspace
`tsconfig.json` as a `config:` node. 14 nodes, 19 edges. Paths are
project-relative, which is what the format documents.

## Where the format came from

Each claim, with the source it was taken from at commit `f08763d`.

| Part of the format | Source | Confidence |
|---|---|---|
| `.ua/knowledge-graph.json` is the graph, `.ua/meta.json` the analysis metadata, and `.understand-anything/` is the legacy directory that stays in use when present | [`README.md`](https://github.com/Egonex-AI/Understand-Anything/blob/v2.9.0/README.md) "Analyze your codebase" and "Share the Graph with Your Team" | documented |
| `KnowledgeGraph` = `{ version, kind?, project, nodes, edges, layers, tour }` | [`understand-anything-plugin/packages/core/src/types.ts`](https://github.com/Egonex-AI/Understand-Anything/blob/v2.9.0/understand-anything-plugin/packages/core/src/types.ts) | read from source |
| `ProjectMeta` = `{ name, languages, frameworks, description, analyzedAt, gitCommitHash }` | `packages/core/src/types.ts` | read from source |
| `GraphNode` = `{ id, type, name, filePath?, lineRange?, summary, tags, complexity, languageNotes?, ... }` | `packages/core/src/types.ts` | read from source |
| `GraphEdge` = `{ source, target, type, direction, description?, weight }`, `direction` one of `forward` / `backward` / `bidirectional` | `packages/core/src/types.ts` | read from source |
| The 27 node types and 38 edge types | `packages/core/src/types.ts` | read from source |
| Node id conventions `file:<path>`, `function:<path>:<name>`, `class:<path>:<name>`, `config:<path>`, `document:<path>`, `service:<path>`, `table:<path>:<name>`, `endpoint:<path>:<name>`, `pipeline:<path>`, `schema:<path>`, `resource:<path>` | [`understand-anything-plugin/agents/file-analyzer.md`](https://github.com/Egonex-AI/Understand-Anything/blob/v2.9.0/understand-anything-plugin/agents/file-analyzer.md) "Node Types and ID Conventions" | documented |
| Per-edge-type weights: `contains` 1.0, `imports` 0.7, `calls` 0.8, `inherits` / `implements` 0.9, `exports` 0.8, `depends_on` 0.6, `tested_by` 0.5, `configures` 0.6 | `agents/file-analyzer.md` edge tables | documented |
| One `imports` edge per resolved project-internal specifier, from the scanner's `batchImportData`, externals already filtered out | `agents/file-analyzer.md` "Import edge creation rule" | documented |
| `calls` edges are inferred "from imports + function names when confident" | `agents/file-analyzer.md` edge table | documented |
| The significance filter: only functions of 10+ lines, classes with 2+ methods or 20+ lines, and exported symbols become sub-file nodes | `agents/file-analyzer.md` "Step 2" | documented |
| `file-analyzer` always emits `direction: "forward"` | `agents/file-analyzer.md` "Required fields for every edge" | documented |
| `meta.json` = `{ lastAnalyzedAt, gitCommitHash, version, analyzedFiles }`, and the `git diff <last-hash>..HEAD` staleness flow | [`docs/superpowers/specs/2026-03-14-understand-anything-design.md`](https://github.com/Egonex-AI/Understand-Anything/blob/v2.9.0/docs/superpowers/specs/2026-03-14-understand-anything-design.md) "Persistence & Staleness Detection" | documented (v1 design doc, still matches `AnalysisMeta` in `types.ts`) |

## What is inferred

These parts are **not** copied from a real run and could differ:

1. **The values.** Every node, summary, tag, complexity rating and edge was
   written by hand from `fixtures/tiny-ts`'s source, in the style the
   file-analyzer prompt asks for.
2. **Which symbols survive the significance filter.** The fixture promotes
   `main`, `loadConfig`, `createRegistry`, `retry`, `Registry` and `Bus`, and
   deliberately does *not* promote `formatEvent` (a one-liner) or `createBus`.
   A real run's judgement could differ in either direction: the filter is
   applied by an LLM, so it is not deterministic.
3. **Which `calls` edges an LLM would infer.** The four in the fixture are the
   ones a reader could infer from the imports plus the function names, which is
   what the prompt asks for. A real run might add or miss some.
4. **Class-level call granularity.** `Registry.register` calling `Bus.emit` is
   recorded as `class:...registry.ts:Registry` -> `class:...bus.ts:Bus`, because
   the format has no method node to point at. This follows from the node-type
   list and the significance filter, but it is an inference about how the agent
   would express a method-to-method call, not something the prompt states.
5. **Top-level key order and formatting.** `types.ts` fixes the fields but not
   their serialised order; this file uses declaration order and two-space
   indentation.
6. **`layers` and `tour` contents.** Produced by other agents
   (`architecture-analyzer`, `tour-builder`) whose prompts were not read; the
   two entries here are plausible sketches. The adapter ignores both.

## Ambiguity the adapter has to live with

`filePath` is documented as REQUIRED for file-level nodes and optional for
sub-file nodes, while the id also carries the path. When they disagree the
adapter trusts the **id**, because ids are what edges are keyed on and
`agents/file-analyzer.md` warns that invalid ids are auto-corrected during
assembly ("which may cause unexpected edge rewiring").
