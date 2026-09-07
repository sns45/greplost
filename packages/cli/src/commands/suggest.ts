/**
 * "Did you mean" for a miss (leaf 2.15, PLAN "Build 2.1").
 *
 * The evaluation guessed `.github/workflows/publish.yml#job.compliance` where
 * the map holds `.github/workflows/publish.yml#task.compliance`, and got an
 * empty answer with nothing to try next. The id was one word wrong, and the map
 * already knows every id it holds, so the honest response is to name the
 * nearest few rather than to make the reader guess a second time.
 *
 * Nearest is decided by two rules, in this order:
 *
 *  1. **containment**: an id that holds the argument as a substring, or whose
 *     last segment starts with the argument's last segment. This is what makes
 *     a bare `retry` suggest `packages/core/src/retry.ts#retry` rather than
 *     whichever id happens to be four edits away.
 *  2. **edit distance**, bounded, over the whole id.
 *
 * Ties inside each rule break on the id itself, so the list is a pure function
 * of the map and the argument: two runs of the same query print the same five
 * suggestions in the same order, which is the contract every other list in this
 * CLI already keeps.
 */

import type { Structure } from "@greplost/core";
import { compareStrings } from "@greplost/core/schema";

/** Suggestions offered on a miss (plugin-cli spec "--json shapes"). */
export const SUGGESTION_LIMIT = 5;

/**
 * How far apart two ids may be and still be suggested: half the argument's
 * length, and never fewer than 4 edits, so a short symbol tolerates a typo and
 * a long node id tolerates a wrong kind (`job` where the map says `task`, eight
 * edits) without letting every path in the repo qualify. A generous cutoff
 * costs only work, never accuracy: the five printed are still the five nearest.
 */
function cutoffFor(needle: string): number {
  return Math.max(4, Math.ceil(needle.length / 2));
}

/**
 * Up to `limit` ids the map holds that are nearest to `needle`: declaration and
 * node ids first, then file paths, ranked by the rules above.
 *
 * The candidate set is every id a `query` argument could legally have named, so
 * a suggestion is always something that answers when it is run.
 */
export function nearestIds(structure: Structure, needle: string, limit = SUGGESTION_LIMIT): string[] {
  if (needle === "") return [];
  const candidates = candidateIds(structure);
  const lower = needle.toLowerCase();
  const tail = lastSegment(lower);
  const cutoff = cutoffFor(needle);

  const contained: string[] = [];
  const scored: Array<{ id: string; distance: number }> = [];

  for (const id of candidates) {
    const idLower = id.toLowerCase();
    if (idLower.includes(lower) || (tail !== "" && lastSegment(idLower).startsWith(tail))) {
      contained.push(id);
      continue;
    }
    // Against the whole id *and* against its last segment, whichever is closer:
    // a person types `Regsitry`, and the id that means is
    // `packages/core/src/registry.ts#Registry`, which the whole-id comparison
    // could never reach. `boundedDistance` applies the length window itself, so
    // a candidate too long to be within the cutoff costs one subtraction.
    const distance = Math.min(
      boundedDistance(lower, idLower, cutoff),
      boundedDistance(lower, lastSegment(idLower), cutoff),
    );
    if (distance <= cutoff) scored.push({ id, distance });
  }

  contained.sort(compareStrings);
  scored.sort((a, b) => a.distance - b.distance || compareStrings(a.id, b.id));

  const out: string[] = [];
  for (const id of [...contained, ...scored.map((entry) => entry.id)]) {
    if (out.length >= limit) break;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Every id the map can be asked about: declaration ids (which include node
 * ids), then the file paths, deduplicated and sorted, so the scan order never
 * depends on the order the graph files happened to hold.
 */
function candidateIds(structure: Structure): string[] {
  const ids = new Set<string>();
  for (const decl of structure.symbols) ids.add(decl.id);
  for (const file of Object.keys(structure.manifest.files)) ids.add(file);
  return [...ids].sort(compareStrings);
}

/** The part after the last `/` or `#`: the name a person actually typed. */
function lastSegment(id: string): string {
  const cut = Math.max(id.lastIndexOf("/"), id.lastIndexOf("#"));
  return cut === -1 ? id : id.slice(cut + 1);
}

/**
 * Levenshtein distance, abandoned as soon as every cell of a row exceeds
 * `cutoff`, which is what keeps a miss on a large map cheap: the full matrix is
 * only ever filled for the handful of candidates that are actually close.
 * Returns `cutoff + 1` for anything further away.
 */
export function boundedDistance(a: string, b: string, cutoff: number): number {
  if (a === b) return 0;
  const over = cutoff + 1;
  if (Math.abs(a.length - b.length) > cutoff) return over;

  let previous: number[] = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current: number[] = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let best = current[0] as number;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
      current[j] = value;
      if (value < best) best = value;
    }
    if (best > cutoff) return over;
    const swap = previous;
    previous = current;
    current = swap;
  }
  const distance = previous[b.length] as number;
  return distance > cutoff ? over : distance;
}
