/**
 * Go directory import targets, end to end through the render layer (leaf 1.8,
 * fix round 1).
 *
 * A Go import names a package, so an import edge's `to` is the package
 * *directory* (tech spec Appendix C). Every consumer that asks "who imports this
 * file?" has to expand that, or a Go repo renders with no fan-in, no blast
 * radius and an empty "Imported by" list while `graph/imports.jsonl` is perfectly
 * correct. `graph/directories.ts` is the one place that expansion happens; this
 * file proves it reaches the numbers and the cards.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSnapshot, importersOf } from "@greplost/core";
import { expandDirectoryTargets, impactOf } from "@greplost/core/graph";
import type { GreplostConfig, Snapshot } from "@greplost/core/schema";
import { DEFAULT_CONFIG } from "@greplost/core/schema";

import { renderArtifacts } from "../src/render.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TINY_GO = path.join(REPO_ROOT, "fixtures/tiny-go");
const GO_CONFIG: GreplostConfig = { ...DEFAULT_CONFIG, languages: ["go"] };

const STORE = "internal/store/store.go";
const MEMORY = "internal/store/memory.go";
const RETRY = "internal/retry/retry.go";
const MAIN = "cmd/app/main.go";

let snapshot: Snapshot;
let artifacts: Map<string, string>;

beforeAll(async () => {
  snapshot = await buildSnapshot({ root: TINY_GO, config: GO_CONFIG });
  artifacts = renderArtifacts({ snapshot, summaries: {} });
});

describe("go directory targets", () => {
  test("the raw edges still target directories, not files", () => {
    expect(snapshot.imports.filter((e) => e.from === MAIN).map((e) => e.to)).toEqual([
      "ext:fmt",
      "internal/retry",
      "internal/store",
    ]);
  });

  test("expandDirectoryTargets turns one directory edge into one pair per file", () => {
    const pairs = expandDirectoryTargets(
      snapshot.imports,
      snapshot.files.map((f) => f.path),
    );
    // main.go imports two packages, and each reaches both of its files.
    expect(pairs.filter(([from]) => from === MAIN).map(([, to]) => to)).toEqual([
      "internal/retry/backoff.go",
      RETRY,
      MEMORY,
      STORE,
    ]);
  });

  test("fan-in and fan-out count the files behind a package import", () => {
    expect(snapshot.manifest.files[STORE]?.fanIn).toBeGreaterThan(0);
    expect(snapshot.manifest.files[MEMORY]?.fanIn).toBeGreaterThan(0);
    expect(snapshot.manifest.files[MAIN]?.fanOut).toBe(4);
    expect(snapshot.manifest.files[MAIN]?.fanIn).toBe(0);
  });

  test("blast radius reaches through a package import", () => {
    expect(snapshot.manifest.files[RETRY]?.blast).toBeGreaterThan(0);
    // retry is imported by main and by store.go, and store.go is imported by main.
    expect(snapshot.manifest.files[STORE]?.blast).toBeGreaterThan(0);
  });

  test("the package graph is no longer empty for a Go repo", () => {
    expect(snapshot.metrics.packageEdges.length).toBe(0); // one package: no cross-package edge
    // ...but the file graph behind it is populated, which is what the cards read.
    expect(Object.values(snapshot.manifest.files).some((entry) => entry.fanIn > 0)).toBe(true);
  });

  test("importersOf resolves a file through its package directory", () => {
    expect(importersOf(snapshot.imports, STORE)).toEqual([MAIN]);
    expect(importersOf(snapshot.imports, MEMORY)).toEqual([MAIN]);
    expect(importersOf(snapshot.imports, RETRY)).toEqual([MAIN, STORE]);
    expect(importersOf(snapshot.imports, MAIN)).toEqual([]);
  });

  test("impactOf walks the expanded pairs", () => {
    const pairs = expandDirectoryTargets(
      snapshot.imports,
      snapshot.files.map((f) => f.path),
    );
    expect(impactOf(pairs, RETRY).map((hit) => hit.path)).toContain(MAIN);
    expect(impactOf(pairs, STORE)).toEqual([{ path: MAIN, depth: 1 }]);
  });

  test("the module card lists its importers", () => {
    const card = artifacts.get("packages/tiny/modules/internal/store/store.go.md");
    expect(card).toBeDefined();
    expect(card).toContain("Imported by");
    expect(card).toContain(MAIN);
  });

  test("a file nobody imports says so", () => {
    const card = artifacts.get("packages/tiny/modules/cmd/app/main.go.md");
    expect(card).toBeDefined();
    expect(card).not.toContain(`\`${STORE}\`\n`);
  });
});
