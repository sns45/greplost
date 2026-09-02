/**
 * `greplost flows <pkg>` (tech spec 9).
 *
 * `FLOWS.md` is a semantic-layer document, so it is often simply not there.
 * That is a normal state of the world rather than a failure of this command,
 * and the useful answer is the one that says how to make it exist. It is still
 * "not found", though, so it exits 1 and writes nothing to stdout.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { ARTIFACT_DIR } from "@greplost/core/schema";
import { packageDir } from "@greplost/render";

import type { CommandContext } from "../args.ts";
import { printError, printJson, printLine } from "../output.ts";

export interface FlowsResult {
  package: string;
  /** `.greplost`-relative path of the document. */
  path: string;
  text: string;
}

export async function run(ctx: CommandContext): Promise<number> {
  const name = ctx.operands[0] as string;
  const artifactRoot = path.join(ctx.root, ARTIFACT_DIR);

  // A package can be named either way round: `@tiny/core` as it appears in the
  // manifest, or `tiny__core` as it appears in the artifact path.
  for (const relative of [`${packageDir(name)}/FLOWS.md`, `packages/${name}/FLOWS.md`]) {
    const file = path.join(artifactRoot, relative);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (ctx.json) printJson({ package: name, path: relative, text } satisfies FlowsResult);
    else printLine(text.replace(/\n$/, ""));
    return 0;
  }

  printError(`no FLOWS.md for ${name}; run \`greplost refresh ${name}\``);
  return 1;
}
