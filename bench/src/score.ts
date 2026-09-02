/**
 * Deterministic set scoring for the bench harness (tech spec 10.1 principle 1, 10.3).
 *
 * Every number the harness reports comes from here: a set comparison, never a judge.
 * The comparison keys are fixed by the bench spec so that greplost, the compiler truth
 * and every competitor adapter are scored by the same code:
 *
 *   imports -> `${from} -> ${to}`      (repo files only; `ext:`/`unresolved:` filtered by the caller)
 *   calls   -> `${from} -> ${to}`
 *   exports -> `${file}#${name}`
 *   cycles  -> sorted member lists, compared as a set
 *
 * Empty-set conventions, pinned by `bench/test/score.test.ts`:
 *   - precision is 1 when nothing was predicted (no claim can be wrong);
 *   - recall is 1 when there was nothing to find;
 *   - F1 is 0 unless both are above 0, so a degenerate "predict nothing" run scores
 *     precision 1 / recall 0 / F1 0 and is caught by the recall half of the S1 and S2
 *     gates. S3 gates precision only, by design (tech spec section 3), so the structural
 *     runner reports call recall alongside it rather than hiding it.
 */
import { compareStrings, type Edge } from "@greplost/core/schema";

/** One precision/recall comparison, with the misses named so a failure is actionable. */
export interface Score {
  precision: number;
  recall: number;
  f1: number;
  tp: number;
  fp: number;
  fn: number;
  /** Predicted keys absent from truth, sorted. */
  falsePositives: string[];
  /** Truth keys absent from the prediction, sorted. */
  falseNegatives: string[];
}

/** Compare two key sets. Duplicates on either side are collapsed. */
export function scoreSet(pred: string[], truth: string[]): Score {
  const predicted = new Set(pred);
  const expected = new Set(truth);

  const falsePositives: string[] = [];
  let tp = 0;
  for (const key of predicted) {
    if (expected.has(key)) tp += 1;
    else falsePositives.push(key);
  }
  const falseNegatives: string[] = [];
  for (const key of expected) if (!predicted.has(key)) falseNegatives.push(key);

  const fp = falsePositives.length;
  const fn = falseNegatives.length;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    precision,
    recall,
    f1,
    tp,
    fp,
    fn,
    falsePositives: falsePositives.sort(compareStrings),
    falseNegatives: falseNegatives.sort(compareStrings),
  };
}

/** The comparison key of an edge: source and target only, never kind or confidence. */
export function edgeKey(edge: Pick<Edge, "from" | "to">): string {
  return `${edge.from} -> ${edge.to}`;
}

/** Compare two edge lists on `(from, to)`. */
export function scoreEdges(pred: Edge[], truth: Edge[]): Score {
  return scoreSet(pred.map(edgeKey), truth.map(edgeKey));
}

/** Flatten a `file -> exported names` record into sorted `file#name` comparison keys. */
export function exportKeys(exports: Record<string, string[]>): string[] {
  const keys: string[] = [];
  for (const file of Object.keys(exports)) for (const name of exports[file] ?? []) keys.push(`${file}#${name}`);
  return keys.sort(compareStrings);
}

/**
 * Jaccard index over cycle sets: |intersection| / |union|, where a cycle is identified by
 * its sorted member list. S4 gates this at 1.0, i.e. exact set match. Two empty sets are
 * an exact match (a repo with no cycles, correctly reported as having none).
 */
export function jaccardCycles(pred: string[][], truth: string[][]): number {
  const key = (cycle: string[]): string => [...cycle].sort(compareStrings).join(",");
  const predicted = new Set(pred.map(key));
  const expected = new Set(truth.map(key));
  if (predicted.size === 0 && expected.size === 0) return 1;
  let intersection = 0;
  for (const cycle of predicted) if (expected.has(cycle)) intersection += 1;
  const union = predicted.size + expected.size - intersection;
  return union === 0 ? 1 : intersection / union;
}
