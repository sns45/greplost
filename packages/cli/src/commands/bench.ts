/**
 * `greplost bench <suite> [args...]` and `greplost screenshots` (tech spec 9,
 * 10, 11).
 *
 * The benchmark harness is a development tool that lives in the repository, not
 * in the published package: it needs the corpus, the competitors, playwright
 * and a `bun` on PATH. So these two commands are a delegation and a refusal.
 * The refusal is exit 2 rather than 1 on purpose: asking a published binary to
 * run the harness is a usage error, not a failed benchmark, and a benchmark
 * that "fails" for the wrong reason is worse than one that will not start.
 *
 * The detection is deliberately narrow: the harness must both exist at the
 * expected place relative to the installed package *and* sit in a checkout
 * whose root manifest is this monorepo's, so a user project that happens to
 * have a `bench/src/cli.ts` cannot be mistaken for the greplost repo.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { CommandContext } from "../args.ts";
import { packageRoot, printError } from "../output.ts";

/** The monorepo's root manifest name; the marker that says "this is the repo". */
const REPO_MANIFEST_NAME = "greplost-monorepo";

/** Absolute path of the repo checkout holding the bench harness, if there is one. */
export function benchRepoRoot(): string | undefined {
  const candidate = path.resolve(packageRoot(), "..", "..");
  if (!existsSync(path.join(candidate, "bench", "src", "cli.ts"))) return undefined;

  try {
    const manifest = JSON.parse(readFileSync(path.join(candidate, "package.json"), "utf8")) as {
      name?: unknown;
    };
    if (manifest.name !== REPO_MANIFEST_NAME) return undefined;
  } catch {
    return undefined;
  }
  return candidate;
}

/** Run `bun bench/src/cli.ts <args...>` in the repo, inheriting stdio. */
export function delegateToBench(args: string[]): number {
  const repo = benchRepoRoot();
  if (repo === undefined) {
    printError("the benchmark harness runs only inside the greplost repository (bench/src/cli.ts not found)");
    return 2;
  }

  const result = spawnSync("bun", [path.join("bench", "src", "cli.ts"), ...args], {
    cwd: repo,
    stdio: "inherit",
  });

  if (result.error !== undefined) {
    const reason = (result.error as NodeJS.ErrnoException).code === "ENOENT"
      ? "bun is not on PATH"
      : result.error.message;
    printError(`cannot run the benchmark harness: ${reason}`);
    return 2;
  }
  if (result.signal !== null && result.signal !== undefined) {
    printError(`the benchmark harness was killed by ${result.signal}`);
    return 1;
  }
  return result.status ?? 1;
}

export async function run(ctx: CommandContext): Promise<number> {
  const suite = ctx.operands[0] as string;
  return delegateToBench([suite, ...(ctx.options.passthrough ?? [])]);
}
