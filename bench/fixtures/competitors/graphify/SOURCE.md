# Provenance: graphify fixture

Hand-written to graphify's documented output format. **graphify was not run to
produce this file** — the bench does not install competitor tools, and the
adapters are exercised on fixtures (leaf 1.5.2 brief). Everything below says
where each part of the format came from and which parts are inferred.

## Pinned version

| | |
|---|---|
| Repo | <https://github.com/Graphify-Labs/graphify> |
| Version | `v0.9.53` (latest release on 2026-08-30) |
| Commit | `33362d969292b57eda82f3fbd9eb5f3f5bc9bbc2` |
| Package | `graphifyy` on PyPI |

## What the fixture describes

`fixtures/tiny-ts`, restricted to seven files:
`apps/worker/src/{main,config}.ts` and
`packages/core/src/{registry,retry,bus,events,queue}.ts`.
20 nodes, 30 links. Paths are project-relative.

## Where the format came from

Each claim, with the source it was taken from at commit `33362d9`.

| Part of the format | Source | Confidence |
|---|---|---|
| Output dir `graphify-out/` with `graph.json`, `GRAPH_REPORT.md`, `graph.html` | [`README.md`](https://github.com/Graphify-Labs/graphify/blob/v0.9.53/README.md) "Get started" | documented |
| `graph.json` is NetworkX node-link | [`docs/how-it-works.md`](https://github.com/Graphify-Labs/graphify/blob/v0.9.53/docs/how-it-works.md) "The graph format" | documented |
| Node fields `id`, `label`, `file_type`, `source_file` | `docs/how-it-works.md` "The graph format" | documented |
| Edge fields `source`, `target`, `relation`, `confidence`, `confidence_score`, `source_file` | `docs/how-it-works.md` "The graph format" | documented |
| `confidence` vocabulary `EXTRACTED` / `INFERRED` / `AMBIGUOUS`, and the INFERRED score rubric (0.95 / 0.85 / 0.75 / 0.65 / 0.55) | `docs/how-it-works.md` "Confidence tagging" | documented |
| Top-level keys `directed`, `multigraph`, `graph`, `nodes`, `links`, `hyperedges`, `built_at_commit` | [`graphify/export.py:to_json`](https://github.com/Graphify-Labs/graphify/blob/v0.9.53/graphify/export.py) | read from source |
| Per-node `community`, `community_name`, `norm_label` added at write time | `graphify/export.py:to_json` | read from source |
| Key order (`id`, `label`, then sorted; `source`, `target`, `relation`, then sorted) and node/link ordering by the key-sorted compact JSON string | `graphify/export.py:to_json` `_canonical` / `_json_sort_key` | read from source |
| Node ids are `normalize_id` slugs: casefold + NFKC to a fixpoint, `[^\w]+` -> `_`, collapse, strip | [`graphify/ids.py`](https://github.com/Graphify-Labs/graphify/blob/v0.9.53/graphify/ids.py) | read from source |
| File node id is `_make_id(str(path))`; symbol ids are `_make_id(stem, name)` where the stem is the path without its extension | [`graphify/extract.py`](https://github.com/Graphify-Labs/graphify/blob/v0.9.53/graphify/extract.py), [`graphify/extractors/base.py`](https://github.com/Graphify-Labs/graphify/blob/v0.9.53/graphify/extractors/base.py) `_file_stem` | read from source |
| File node label is the basename; a top-level function is `name()`; a method is `.name()`; a class is its bare name | [`graphify/extractors/engine.py`](https://github.com/Graphify-Labs/graphify/blob/v0.9.53/graphify/extractors/engine.py) `add_node` in the `function_types` / class branches | read from source |
| `contains` runs file -> class/function; `method` runs class -> method | `graphify/extractors/engine.py` | read from source |
| `imports_from` (file -> file), `imports` and `re_exports` (file -> symbol) for TS/JS, with `context`, `type_only`, `target_file` | `graphify/extract.py` `_import_js` | read from source |
| `calls` edges carry `context: "call"` and `confidence_score: 1.0` when EXTRACTED | `graphify/extract.py` `_emit_call`, `graphify/extractors/engine.py` | read from source |
| Sourceless cross-file stub nodes (`source_file: ""`, plus `origin_file`) | `graphify/extractors/engine.py` `ensure_named_node` | read from source |
| `rationale` nodes and `rationale_for` edges from `# NOTE:` comments | `graphify/extract.py` `_add_rationale` | read from source |
| Import-family edges may point at a target that is not a node (unresolved specifiers, external packages) | `graphify/build.py` (the endpoint filter keeps `imports` / `imports_from` / `re_exports` with an unknown target) | read from source |

## What is inferred

These parts are **not** copied from a real run and could differ from what
graphify actually writes:

1. **The values.** Every id, label, line number, community assignment and edge
   in this file was written by hand from `fixtures/tiny-ts`'s source. The ids
   were produced by re-implementing `normalize_id` in JavaScript, so they should
   match, but they have not been checked against the Python implementation.
2. **Which symbols graphify would promote to nodes.** The fixture gives every
   exported class, function and method a node. graphify's real extractor may
   emit more (private members, arrow functions bound to consts) or fewer.
3. **Whether the workspace aliases resolve.** `apps/worker/src/main.ts` imports
   `@tiny/core` and `@tiny/adapters`, which resolve only through the
   `tsconfig.json` `paths` mapping. The fixture assumes graphify does **not**
   resolve them and emits `imports_from` edges to `_make_id("ref", spec)` stubs
   with no node behind them. If graphify does read `tsconfig.json` paths, a real
   artifact would carry two more resolved import edges here.
4. **`source_file` is project-relative here.** `graphify/extractors/base.py`
   notes that an absolute path can be passed in and that an id-remap post-pass
   re-derives the repo-relative form, while
   [`graphify/paths.py`](https://github.com/Graphify-Labs/graphify/blob/v0.9.53/graphify/paths.py)
   `is_absolute_any_platform` lists `graph.json` as a place absolute paths
   travel. Which of the two a real run writes is **ambiguous**, so the adapter
   re-anchors both and `bench/test/adapters.test.ts` covers absolute and
   Windows-separator variants directly.
5. **`links` vs `edges`.** `graphify/paths.py` `load_node_link_graph` documents
   that the clustered writer uses `links` and the raw `--no-cluster` writer uses
   `edges`. This fixture uses `links` (the clustered writer); the adapter
   accepts either, and a test covers the `edges` spelling.
6. **`GRAPH_REPORT.md`** in this directory is a plausible sketch, not a real
   report. The adapter never reads it; it exists so the directory has the shape
   of a real `graphify-out/`.
