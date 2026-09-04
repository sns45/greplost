/**
 * The on-disk extraction cache (tech spec 8.2 to 8.3, Appendix C; sync spec
 * "parse-cache.ts").
 *
 * Parsing is what an update costs. Everything after it — resolution, linking,
 * metrics, rendering — is fast arithmetic over records that are already in
 * memory, so the only work worth skipping between two runs is the tree-sitter
 * pass over files whose bytes have not moved. That is exactly what this cache
 * stores: `.greplost/cache/parse.json`, one `FileRecord` per `(language,
 * sha256)`, gitignored because it is derived, machine-local and worthless to
 * anyone else.
 *
 * Content addressing, not path addressing, is the point. A file that moves is
 * a cache hit; a file duplicated under two names is one parse; a branch switch
 * back to yesterday's code is free. `buildSnapshot` re-stamps the path onto a
 * hit, so a record is only ever keyed by what actually determines its
 * contents. The language belongs in the key because the same bytes are read
 * with the TypeScript grammar as `.ts` and the TSX grammar as `.tsx`, and the
 * two produce different trees (Appendix C).
 *
 * Two invariants keep this honest:
 *
 *  - Records are immutable. Everything handed out is frozen, including what
 *    comes back off disk, so a consumer that mutates a record fails loudly
 *    here instead of silently corrupting the next build (Contract,
 *    "Immutability").
 *  - The key must agree with the record. A JSON file on disk is editable, and
 *    a record filed under the wrong hash would put an extraction of one file
 *    into the manifest entry of another. Entries that disagree are dropped on
 *    load, along with anything that is not a record at all.
 *
 * A cache is never a source of truth: corrupt, truncated or half-written JSON
 * reads as an empty cache, because the only cost of a miss is time.
 *
 * The same reasoning covers version skew, which is the one way a *valid* cache
 * can be wrong. Records are the extractor's output, so a greplost that has
 * learned to record something the previous one did not would inherit
 * yesterday's answers for every file whose bytes have not changed, and produce
 * a map that is neither the old version's nor the new one's. The stamp under
 * `#version` (a key no `lang:sha256` can collide with) makes that impossible: a
 * cache written by a different extractor generation is discarded, not merged.
 * `PARSE_CACHE_VERSION` is bumped by hand whenever a change to extraction would
 * alter the `FileRecord` for unchanged bytes; `SCHEMA_VERSION` covers changes
 * to the record's shape.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import type { ParseCache } from "@greplost/core";
import type { FileRecord, Lang } from "@greplost/core/schema";
import {
  ARTIFACT_DIR,
  LANG_BY_BASENAME,
  LANG_BY_EXTENSION,
  SCHEMA_VERSION,
  stableStringify,
} from "@greplost/core/schema";

import { safeWrite } from "./write.ts";

/** `.greplost/cache/parse.json`, relative to the artifact directory. */
export const PARSE_CACHE_PATH = "cache/parse.json";

/**
 * Extractor generation. Bump by hand when a greplost change would give
 * unchanged bytes a different `FileRecord`; every existing cache is then
 * discarded on load rather than mixed with fresh records.
 */
export const PARSE_CACHE_VERSION = "1";

/** Sentinel key. No real key can collide with it: `lang:sha256` has no `#`. */
export const PARSE_CACHE_VERSION_KEY = "#version";

/** What the sentinel must hold for a cache file to be usable. */
export const PARSE_CACHE_STAMP = `${SCHEMA_VERSION}/${PARSE_CACHE_VERSION}`;

/** The cache key for one extraction: language first, so a prefix scan groups by grammar. */
export function parseCacheKey(sha256: string, lang: Lang): string {
  return `${lang}:${sha256}`;
}

/**
 * Every `Lang` a discovered file can carry, for validating a record read back off disk.
 *
 * Both detection tables, not just the extension one: schema 2 added languages that are
 * recognised by basename (`Dockerfile`), and a set built from extensions alone would
 * throw away every cached Dockerfile record on load.
 */
const LANGS: ReadonlySet<string> = new Set<string>([
  ...Object.values(LANG_BY_EXTENSION),
  ...Object.values(LANG_BY_BASENAME),
]);

/**
 * A `ParseCache` backed by `.greplost/cache/parse.json`.
 *
 * Loading is lazy: constructing one costs nothing, so `update` can hand a
 * cache to a build that may turn out not to need it. `load()` is still public
 * because a caller that wants the read cost accounted for (or wants the file
 * touched inside the lock) should be able to ask for it.
 */
export class FileParseCache implements ParseCache {
  private readonly root: string;
  private readonly file: string;
  private readonly entries = new Map<string, FileRecord>();
  private loaded = false;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, ARTIFACT_DIR, PARSE_CACHE_PATH);
  }

  /** Number of records currently held. */
  get size(): number {
    this.ensureLoaded();
    return this.entries.size;
  }

  /**
   * Read the cache file into memory.
   *
   * Records already set in this session win over the file: `set` reflects the
   * bytes on disk right now, a stored record only reflects some earlier run.
   */
  load(): void {
    this.loaded = true;

    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Truncated by a crash mid-write, or edited by hand. Start over: the
      // next `save` replaces it with something valid.
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;

    // Written by a different extractor generation (or by something that is not
    // a parse cache at all): every record in it is suspect, so none are read.
    if ((parsed as Record<string, unknown>)[PARSE_CACHE_VERSION_KEY] !== PARSE_CACHE_STAMP) return;

    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (key === PARSE_CACHE_VERSION_KEY) continue;
      if (this.entries.has(key)) continue;
      if (!isFileRecord(value)) continue;
      // The filing must match the contents, or a hit answers with another
      // file's extraction.
      if (key !== parseCacheKey(value.sha256, value.lang)) continue;
      this.entries.set(key, freezeRecord(value));
    }
  }

  get(sha256: string, lang: Lang): FileRecord | undefined {
    this.ensureLoaded();
    return this.entries.get(parseCacheKey(sha256, lang));
  }

  set(record: FileRecord): void {
    // `buildSnapshot` freezes before handing a record over; freezing again is
    // free and makes the invariant hold for every other caller too.
    this.entries.set(parseCacheKey(record.sha256, record.lang), freezeRecord(record));
  }

  /**
   * Write the cache back, keeping only the keys in `keep` when it is given.
   *
   * Pruning is what stops the file growing without bound: every edit to a file
   * mints a new hash, and yesterday's hashes are never asked for again.
   * `update` passes the set of keys the build it just finished actually used,
   * so the cache stays the same size as the repo rather than the same size as
   * its history. Omitting `keep` rewrites everything, which is what a caller
   * that only wants to persist new records wants.
   */
  save(keep?: ReadonlySet<string>): void {
    // Merge with whatever is on disk first, so a save from a cache that was
    // never read does not throw away another run's records.
    this.ensureLoaded();

    if (keep !== undefined) {
      for (const key of [...this.entries.keys()]) {
        if (!keep.has(key)) this.entries.delete(key);
      }
    }

    const out: Record<string, FileRecord | string> = { [PARSE_CACHE_VERSION_KEY]: PARSE_CACHE_STAMP };
    for (const [key, value] of this.entries) out[key] = value;

    // `safeWrite`, not `mkdirSync` plus a write: it does the write-then-rename
    // (a reader, or a crash, never sees half a cache) *and* the containment
    // walk, so a repository carrying a committed `.greplost/cache -> anywhere`
    // gets the link replaced rather than followed. The cache file is
    // gitignored; the directory it lives in is not.
    try {
      safeWrite(this.root, PARSE_CACHE_PATH, `${stableStringify(out)}\n`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.startsWith("greplost: ")) throw cause;
      throw new Error(`greplost: cannot write ${ARTIFACT_DIR}/${PARSE_CACHE_PATH}: ${message}`);
    }
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.load();
  }
}

/**
 * Shallow-freeze a record and its four arrays, matching what `buildSnapshot`
 * does to a freshly parsed one. Shallow is deliberate: the elements are plain
 * data that nothing downstream has a reason to reach into, and deep-freezing
 * every declaration of every file would cost more than the parse it saved.
 */
function freezeRecord(record: FileRecord): FileRecord {
  Object.freeze(record.decls);
  Object.freeze(record.imports);
  Object.freeze(record.exports);
  Object.freeze(record.calls);
  return Object.freeze(record);
}

function isFileRecord(value: unknown): value is FileRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["path"] === "string" &&
    typeof candidate["sha256"] === "string" &&
    candidate["sha256"] !== "" &&
    typeof candidate["lang"] === "string" &&
    LANGS.has(candidate["lang"]) &&
    typeof candidate["loc"] === "number" &&
    Array.isArray(candidate["decls"]) &&
    Array.isArray(candidate["imports"]) &&
    Array.isArray(candidate["exports"]) &&
    Array.isArray(candidate["calls"])
  );
}
