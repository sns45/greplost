/**
 * The tiny fixture repos every language's gate runs against (bench spec 5.2).
 *
 * One entry per fixture, written once by the seam (leaf 2.0) so a language leaf adds its
 * fixture directory and nothing else. `bench:structural --fixture <name>` looks a target up
 * here; `--fixture` with no value still means `tiny-ts` and `--fixture-go` still means
 * `tiny-go`, because every build-1 gate is written that way.
 *
 * A fixture is the smallest repo that exercises every rule its language has. It is not a
 * benchmark: the corpus entries in `bench/corpus.json` are.
 */

import path from "node:path";
import type { Lang } from "@greplost/core/schema";

/** Monorepo root: `bench/src/..`/`..`. */
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

export interface FixtureEntry {
  /** Absolute path to the fixture checkout. */
  root: string;
  /** The language its structural gate scores. */
  lang: Lang;
}

function fixture(name: string, lang: Lang): FixtureEntry {
  return { root: path.join(REPO_ROOT, "fixtures", name), lang };
}

export const FIXTURES: Readonly<Record<string, FixtureEntry>> = {
  "tiny-ts": fixture("tiny-ts", "ts"),
  "tiny-go": fixture("tiny-go", "go"),
  "tiny-python": fixture("tiny-python", "python"),
  "tiny-rust": fixture("tiny-rust", "rust"),
  "tiny-java": fixture("tiny-java", "java"),
  "tiny-kotlin": fixture("tiny-kotlin", "kotlin"),
  "tiny-terraform": fixture("tiny-terraform", "hcl"),
  "tiny-k8s": fixture("tiny-k8s", "yaml"),
  "tiny-helm": fixture("tiny-helm", "yaml"),
  "tiny-actions": fixture("tiny-actions", "yaml"),
  "tiny-docker": fixture("tiny-docker", "dockerfile"),
  "tiny-signals-ts": fixture("tiny-signals-ts", "tsx"),
  "tiny-pulumi-go": fixture("tiny-pulumi-go", "go"),
};

/** Fixture names in sorted order, for an error message that lists what is on offer. */
export function fixtureNames(): string[] {
  return Object.keys(FIXTURES).sort();
}
