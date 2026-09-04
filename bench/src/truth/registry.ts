/**
 * Truth generators, by convention (bench spec 5.2).
 *
 * `loadTruth("python")` imports `bench/src/truth/python.ts` and hands back its module. Nothing
 * registers: adding the file is enough, which is what lets a language leaf land without editing
 * a shared file.
 *
 * Every truth generator is independent of tree-sitter and of `packages/core` — that is the
 * whole point of an oracle — so this module imports nothing from either at runtime; the two
 * type imports below are erased.
 */

import type { Edge, Lang } from "@greplost/core/schema";
import type { Truth } from "./ts.ts";

/**
 * What `loadTruth` can be asked for: every `Lang`, plus the truth targets that are a *flavour*
 * or a *layer* rather than a language. `bench/src/truth/yaml.ts` dispatches the three YAML
 * flavours the same way `packages/core/src/extract/yaml.ts` does.
 */
export type TruthTarget =
  | Lang
  | "yaml-k8s"
  | "yaml-helm"
  | "yaml-actions"
  | "signals-ts"
  | "signals-pulumi-go";

export interface TruthModule {
  generateTruth(root: string, files: string[]): Truth;
  /** Raw, non-`Truth` payload the IaC and signal scorers read: reference and node sets. */
  generateExtra?(root: string, files: string[]): { references: Edge[]; nodes: string[] };
  readonly NOTES?: readonly string[];
}

/**
 * The build-1 oracles predate this convention and export `generateTsTruth`/`generateGoTruth`;
 * they are owned by leaves 1.5.1 and 1.8 and are not rewritten for a naming rule. `loadTruth`
 * therefore accepts either the convention name or the build-1 name, and every build-2 module
 * exports `generateTruth`.
 */
function legacyName(target: TruthTarget): string {
  const camel = target.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  return `generate${camel.charAt(0).toUpperCase()}${camel.slice(1)}Truth`;
}

/** Convention: bench/src/truth/<lang>.ts. Nothing registers; adding a file is enough. */
export async function loadTruth(lang: TruthTarget): Promise<TruthModule> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(`./${lang}.ts`)) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      `greplost: no truth generator for "${lang}" (expected bench/src/truth/${lang}.ts): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  const generate = mod["generateTruth"] ?? mod[legacyName(lang)];
  if (typeof generate !== "function") {
    throw new Error(
      `greplost: bench/src/truth/${lang}.ts does not export generateTruth ` +
        `(nor the build-1 name ${legacyName(lang)})`,
    );
  }

  const extra = mod["generateExtra"];
  const notes = mod["NOTES"];
  return {
    generateTruth: generate as TruthModule["generateTruth"],
    ...(typeof extra === "function" ? { generateExtra: extra as NonNullable<TruthModule["generateExtra"]> } : {}),
    ...(Array.isArray(notes) ? { NOTES: notes as readonly string[] } : {}),
  };
}
