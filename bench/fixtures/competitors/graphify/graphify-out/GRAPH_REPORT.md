# Knowledge Graph Report

> Hand-written stand-in for the report `graphify` writes next to `graph.json`.
> See `../SOURCE.md`. The adapter never reads this file; it exists so the
> fixture directory has the shape a real `graphify-out/` has.

**Corpus:** `fixtures/tiny-ts` — 7 code files, 20 nodes, 30 edges.

## God nodes

| Node | Degree | Community |
|---|---|---|
| `packages_core_src_registry_registry` | 6 | Registry & retry |
| `packages_core_src_bus_bus` | 5 | Event bus |
| `packages_core_src_retry_retry` | 3 | Registry & retry |

## Communities

- **Registry & retry** — `registry.ts`, `retry.ts`, `queue.ts`
- **Event bus** — `bus.ts`, `events.ts`
- **Worker app** — `main.ts`, `config.ts`

## Surprising connections

- `bus.ts` and `events.ts` import each other (`Bus` <-> `formatEvent`), a two-file cycle.

## Suggested questions

- What does `Registry.publishAll` retry, and how many times?
- Which files would a change to `Bus.emit` touch?
