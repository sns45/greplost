/**
 * One timed operation, in its own process (bench spec 1.5.5, tech spec 10.5).
 *
 * `perf.ts` spawns this file once per iteration. Peak RSS is a high-water mark
 * for a whole process, so ten builds in one process report one number that
 * belongs to none of them; and a warm JIT, a warm module graph and warm WASM
 * grammars make the second build in a process a different measurement from the
 * first. One process per iteration costs a few hundred milliseconds of startup,
 * which the parent reports separately, and buys a peak RSS per run and a build
 * time that is not a function of what ran before it.
 *
 * The protocol is one marked JSON line on stdout. Anything else the operation
 * prints is ignored, and a process that exits without the line is a failed
 * measurement rather than a zero.
 */
import { performance } from "node:perf_hooks";

import { FileParseCache, update } from "@greplost/sync";

/** How the child hands its measurement back: the only marked line on stdout. */
export const MARKER = "#greplost-perf#";

/** Operations the child knows how to time. */
export type ChildOp = "full" | "incremental" | "cache-save";

export interface ChildReport {
  /** The operation's own milliseconds, excluding process startup. */
  ms: number;
  /** Peak resident set of this process, in bytes. */
  peakRssBytes: number;
  /** Whatever the operation reported about itself (files written, cache hits, ...). */
  detail: Record<string, number>;
}

/**
 * Peak resident set in bytes.
 *
 * `maxRSS` units are not portable: `getrusage` reports bytes on macOS and
 * kilobytes on Linux, and the runtimes do not agree on normalising it (Bun
 * hands back what the kernel said; Node divides). Two independent signals
 * decide it here, and they have to agree before the value is scaled: the
 * platform (only macOS reports bytes) and the ratio against the resident set
 * right now (a byte reading is within a small factor of it, a kilobyte reading
 * is about a thousand times smaller). Requiring both means a runtime that
 * changes its mind about normalising on macOS is caught by the ratio, and a
 * platform whose ratio is briefly misleading is caught by the platform check.
 */
export function peakRssBytes(raw: number, resident: number, platform: string = process.platform): number {
  const looksLikeBytes = raw >= resident / 8;
  const platformReportsBytes = platform === "darwin";
  return looksLikeBytes && platformReportsBytes ? raw : raw * 1024;
}

/** Run one operation and write the report line. */
export async function runChild(op: string, root: string): Promise<void> {
  const started = performance.now();
  const detail: Record<string, number> = {};
  let ms: number;

  switch (op) {
    case "full":
    case "incremental": {
      const result = await update(root, { mode: op === "full" ? "full" : "incremental", quiet: true });
      // A skipped update did no work, and timing it would report a number for a
      // build that never happened. `locked` means a previous child died holding
      // the lock, `clean` means the checkout was already indexed; either way the
      // iteration is not a measurement, and a benchmark that reports one anyway
      // is worse than one that stops.
      if (result.skipped !== undefined) {
        throw new Error(`perf: ${op} update was skipped (${result.skipped}); nothing was measured`);
      }
      ms = result.ms;
      detail["written"] = result.written;
      detail["deleted"] = result.deleted;
      detail["reparsed"] = result.reparsed;
      detail["cached"] = result.cached;
      detail["dirty"] = result.dirty;
      break;
    }
    case "cache-save": {
      const cache = new FileParseCache(root);
      cache.load();
      detail["entries"] = cache.size;
      const at = performance.now();
      cache.save();
      ms = performance.now() - at;
      break;
    }
    default:
      throw new Error(`perf: unknown child operation "${op}"`);
  }

  const raw = process.resourceUsage().maxRSS;
  const resident = process.memoryUsage().rss;
  const report: ChildReport = {
    ms: Math.round(ms * 1000) / 1000,
    peakRssBytes: peakRssBytes(raw, resident),
    // Both raw numbers travel with the report so the unit call above can be
    // audited from the committed results file rather than trusted.
    detail: { ...detail, childMs: Math.round(performance.now() - started), maxRssRaw: raw, rssBytes: resident },
  };
  process.stdout.write(`${MARKER}${JSON.stringify(report)}\n`);
}

if (import.meta.main) {
  await runChild(process.argv[2] ?? "", process.argv[3] ?? "");
}
