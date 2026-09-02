/**
 * Competitor adapters suite (bench leaf 1.5.2).
 *
 * Loaded lazily by the driver-owned dispatcher `bench/src/cli.ts`, which calls
 * the exported `run(args)` and uses its return value as the process exit code.
 *
 *   bun bench/src/cli.ts adapters roundtrip
 *   graphify: 6 imports, 5 calls
 *   ua: 6 imports, 4 calls
 *   crg: 6 imports, 5 calls
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Adapter, CompetitorArtifact } from "./types.ts";
import { crgAdapter } from "./crg.ts";
import { graphifyAdapter } from "./graphify.ts";
import { uaAdapter } from "./ua.ts";

export type { Adapter, CompetitorArtifact } from "./types.ts";
export { EdgeSet, toRepoRelative, toSymbolId } from "./types.ts";
export { crgAdapter } from "./crg.ts";
export { graphifyAdapter } from "./graphify.ts";
export { uaAdapter } from "./ua.ts";

/** Ordered the way `bench/competitors.json` lists the tools. */
export const adapters: Adapter[] = [graphifyAdapter, uaAdapter, crgAdapter];

const here = path.dirname(fileURLToPath(import.meta.url)); // bench/src/adapters
const benchDir = path.resolve(here, "..", "..");
const monorepoRoot = path.resolve(benchDir, "..");

/** A committed competitor artifact describing `fixtures/tiny-ts`. */
export interface CompetitorFixture {
  tool: CompetitorArtifact["tool"];
  /** Directory to point the adapter at (it holds the tool's own output layout). */
  dir: string;
  /**
   * The root the fixture's paths are anchored at.
   *
   * graphify and ua write project-relative paths, so theirs is the real
   * `fixtures/tiny-ts` checkout. crg's documented qualified-name format is
   * absolute (`docs/schema.md`), and a committed fixture cannot carry a real
   * machine path, so its artifact is anchored at the synthetic root
   * `/work/tiny-ts` and this records it. A real bench run passes the checkout
   * the competitor was actually run in.
   */
  repoRoot: string;
}

export const fixtures: CompetitorFixture[] = [
  {
    tool: "graphify",
    dir: path.join(benchDir, "fixtures", "competitors", "graphify"),
    repoRoot: path.join(monorepoRoot, "fixtures", "tiny-ts"),
  },
  {
    tool: "ua",
    dir: path.join(benchDir, "fixtures", "competitors", "ua"),
    repoRoot: path.join(monorepoRoot, "fixtures", "tiny-ts"),
  },
  {
    tool: "crg",
    dir: path.join(benchDir, "fixtures", "competitors", "crg"),
    repoRoot: "/work/tiny-ts",
  },
];

function roundtrip(): number {
  for (const fixture of fixtures) {
    const adapter = adapters.find((a) => a.tool === fixture.tool);
    if (adapter === undefined) {
      console.error(`greplost: no adapter registered for ${fixture.tool}`);
      return 1;
    }
    const artifact = adapter.load(fixture.dir, fixture.repoRoot);
    console.log(`${artifact.tool}: ${artifact.imports.length} imports, ${artifact.calls.length} calls`);
  }
  return 0;
}

export async function run(args: string[]): Promise<number> {
  // Flags are tolerated so the suite survives being handed the common bench
  // args (`--tier`, `--dry-run`); none of them change what roundtrip does,
  // because it reads committed fixtures and touches nothing else.
  const command = args.find((a) => !a.startsWith("-")) ?? "roundtrip";
  if (command !== "roundtrip") {
    console.error(`greplost: unknown adapters command "${command}" (expected: roundtrip)`);
    return 2;
  }
  try {
    return roundtrip();
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}
