# Provenance: code-review-graph fixture

Hand-written to code-review-graph's documented export format.
**code-review-graph was not run to produce this file** — the bench does not
install competitor tools, and the adapters are exercised on fixtures (leaf 1.5.2
brief). Everything below says where each part of the format came from and which
parts are inferred.

## Pinned version

| | |
|---|---|
| Repo | <https://github.com/tirth8205/code-review-graph> |
| Version | `v2.3.8` |
| Commit | `2c6dae32643572ee528eb9b77dbcc17f58f3a8c9` |
| Package | `code-review-graph` on PyPI |

## What the fixture describes

`fixtures/tiny-ts`, restricted to seven files:
`apps/worker/src/{main,config}.ts` and
`packages/core/src/{registry,retry,bus,events,queue}.ts`. 20 nodes, 17 edges.

**Paths are absolute**, anchored at the synthetic root `/work/tiny-ts`. That is
the documented format (see below) and the reason for the synthetic root is that
a committed fixture cannot carry a real machine path. `bench/src/adapters/index.ts`
records `/work/tiny-ts` as this fixture's `repoRoot`; a real bench run passes
the checkout the tool was actually run in.

## Which artifact this is

crg's graph is SQLite at `.code-review-graph/graph.db`. This fixture is the JSON
export that `code-review-graph visualize --format json` writes to
`.code-review-graph/graph.json`. The adapter reads the export, not the database:
it keeps the bench free of a SQLite dependency and of a committed binary, and it
uses crg's own resolution pass (`export_graph_data` resolves short edge targets
to full qualified names and drops what it cannot resolve).

## Where the format came from

Each claim, with the source it was taken from at commit `2c6dae3`.

| Part of the format | Source | Confidence |
|---|---|---|
| SQLite lives in `.code-review-graph/`; `visualize --format json` exports JSON | [`README.md`](https://github.com/tirth8205/code-review-graph/blob/v2.3.8/README.md) "Local storage" and the CLI reference | documented |
| `graph.db` / `graph.json` file names under the data dir (legacy `.code-review-graph.db`) | [`code_review_graph/cli.py`](https://github.com/tirth8205/code-review-graph/blob/v2.3.8/code_review_graph/cli.py) | read from source |
| Payload = `{ nodes, edges, stats, flows, communities }` | [`code_review_graph/visualization.py`](https://github.com/tirth8205/code-review-graph/blob/v2.3.8/code_review_graph/visualization.py) `export_graph_data` docstring | documented in source |
| Node dict `{ id, kind, name, qualified_name, file_path, line_start, line_end, language, parent_name, is_test }` plus `params`, `return_type`, `community_id` added by the exporter | [`code_review_graph/graph.py`](https://github.com/tirth8205/code-review-graph/blob/v2.3.8/code_review_graph/graph.py) `node_to_dict`, `visualization.py` `export_graph_data` | read from source |
| Edge dict `{ id, kind, source, target, file_path, line, confidence, confidence_tier }` plus `ambiguous_targets` / `unresolved_targets` and their `_target_count` / `_targets_truncated` companions | `graph.py` `edge_to_dict` | read from source |
| Node kinds `File`, `Class`, `Function`, `Type`, `Test`, and the Spring kinds `Endpoint`, `Scheduler`, `ConfigProperty` | [`docs/schema.md`](https://github.com/tirth8205/code-review-graph/blob/v2.3.8/docs/schema.md) "Node Types" | documented |
| Edge kinds `CALLS`, `IMPORTS_FROM`, `INHERITS`, `IMPLEMENTS`, `CONTAINS`, `TESTED_BY`, `DEPENDS_ON`, `REFERENCES`, `INJECTS`, `CONSUMES`, `PRODUCES`, `TEMPORAL_STUB`, `DEPENDS_ON_CONFIG`, `HANDLES`, `TRIGGERS`, `PUBLISHES` (`OVERRIDES` scored but never emitted) | `docs/schema.md` "Edge Types" | documented |
| **Qualified names are absolute**: `/abs/file.py`, `/abs/file.py::function`, `/abs/file.py::Class.method`, `/abs/file.py::Outer.Inner.method` | `docs/schema.md` "Qualified Name Format" | documented |
| The file path is everything before the FIRST `::`, and stored identities always use forward slashes | `graph.py` `_bridge_qualified_name` | read from source |
| A `File` node's `name` is the absolute file path | `docs/schema.md` "File" node table | documented |
| `confidence_tier` defaults to `EXTRACTED`; `scoped_resolver.py` rewrites become `INFERRED` | `graph.py` schema SQL, [`code_review_graph/scoped_resolver.py`](https://github.com/tirth8205/code-review-graph/blob/v2.3.8/code_review_graph/scoped_resolver.py) | read from source |
| `GraphStats` = `{ total_nodes, total_edges, nodes_by_kind, edges_by_kind, languages, files_count, last_updated }` | `graph.py` `GraphStats` | read from source |
| JSON is written with `indent=2` and a trailing newline | [`code_review_graph/exports.py`](https://github.com/tirth8205/code-review-graph/blob/v2.3.8/code_review_graph/exports.py) `export_json` | read from source |
| Exports can contain absolute paths and should be sanitised before publishing | `README.md` CLI reference | documented |

## What is inferred

These parts are **not** copied from a real run and could differ:

1. **The values.** Every node, qualified name, line range, param string and edge
   was written by hand from `fixtures/tiny-ts`'s source.
2. **The synthetic root `/work/tiny-ts`.** A real export carries the absolute
   path of the machine that built it.
3. **Which TypeScript constructs crg's tree-sitter parser promotes.** The
   fixture gives `Registry`, `Bus` a `Class` node, every method a `Function`
   node with `parent_name` set, and `WorkerConfig` / `Queue` a `Type` node.
   `docs/schema.md` says `Type` covers "a type alias, interface, enum,
   struct-like type, or parser-specific type construct where the language
   exposes one", so interfaces landing on `Type` is an inference. `Msg` and
   `Ack` in `queue.ts` are omitted for brevity.
4. **Node and edge `id` values, and their ordering.** They are SQLite
   autoincrement rowids; the fixture numbers them 1..N in a plausible insertion
   order.
5. **`language: "typescript"`.** The detected language string is documented as
   "python, typescript, go, etc." but the exact casing was not verified.
6. **`community_id` values.** `communities` is empty in this fixture (community
   detection needs the optional `[communities]` extra), yet the nodes still
   carry a `community_id`. In a real export without the extra those would all be
   `null`. The adapter ignores the field either way.
7. **The `INFERRED` call edge.** `Bus.emit` -> `formatEvent` is tagged
   `confidence_tier: "INFERRED"` with `confidence: 0.6` and an
   `ambiguous_targets` list, to exercise the confidence mapping. In a real run
   that call is a plain imported-function call and would very likely be
   `EXTRACTED`.
8. **`stats.last_updated` format.** Written as a naive ISO timestamp; the column
   is `TEXT` and the exact spelling was not verified.
