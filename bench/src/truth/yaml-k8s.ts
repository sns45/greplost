/**
 * Kubernetes manifest truth generator (build 2, leaf 2.8).
 *
 * A throwing stub written by the seam (leaf 2.0) so `loadTruth("yaml-k8s")` fails with a
 * sentence naming the file and the leaf that owes it, rather than with a module-not-found
 * from a dynamic import. Leaf 2.8 replaces this file and nothing else.
 *
 * Oracle independence (bench spec section 0 / 1.6): a truth generator may not import
 * tree-sitter or `packages/core`. The `Truth` type import below is erased at runtime, which
 * is why it is the only one here.
 */

import type { Truth } from "./ts.ts";

export const NOTES: readonly string[] = ["not-implemented"];

export function generateTruth(root: string, files: string[]): Truth {
  throw new Error(
    `greplost: the yaml-k8s truth generator is not implemented yet ` +
      `(${files.length} file(s) under ${root}); see build-2 leaf 2.8`,
  );
}
