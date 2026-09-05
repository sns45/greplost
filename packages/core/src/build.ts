/**
 * Snapshot build: the one entry point that turns a checkout into a `Snapshot`
 * (tech spec 5.1 to 5.4, core-extract spec "Build").
 *
 * The pipeline is fixed: discover -> read -> hash -> (cache | extract) ->
 * detect packages -> resolve -> link imports -> export index -> link calls ->
 * metrics -> manifest. Only the reads are asynchronous; everything after them
 * is a pure function of the bytes on disk, which is what makes
 * `build(repo) == build(repo)` byte-for-byte (tech spec 5.3).
 *
 * Nothing here is order-sensitive: the discovered list is re-sorted before it
 * is used, so a different discovery order cannot change a byte of the output.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  Declaration,
  FileEntry,
  FileRecord,
  GreplostConfig,
  Lang,
  Manifest,
  Snapshot,
  SummaryCache,
} from "./schema.ts";
import {
  SCHEMA_VERSION,
  compareDeclarations,
  compareEdges,
  compareStrings,
  nodeId,
  splitNodeId,
  symbolId,
} from "./schema.ts";
import { loadConfig } from "./config.ts";
import { discoverFiles } from "./discover.ts";
import type { DiscoveredFile } from "./discover.ts";
import { sha256Hex } from "./hash.ts";
import { createParser } from "./parser.ts";
import type { ParserHandle } from "./parser.ts";
import { extractFile } from "./extract/index.ts";
import type { SignalPassId } from "./signals/index.ts";
import { signalPathKey } from "./signals/index.ts";
import { createResolver, detectPackages } from "./resolve/index.ts";
import { buildExportIndex, computeMetrics, exportNames, linkCalls, linkImports } from "./graph/index.ts";
import { linkReferences } from "./references/index.ts";

/**
 * Content-addressed extraction cache (tech spec 8), keyed by `(lang, sha256)`.
 *
 * The hash alone does not identify an extraction result: `ts`/`js` are read with
 * the TypeScript grammar and `tsx`/`jsx` with the TSX one, so two files with the
 * same bytes and different extensions (two empty files, say) are two records.
 * A file that merely moves, or that duplicates another file of the same
 * language, is never re-parsed; `buildSnapshot` re-stamps the path onto the hit.
 *
 * Records crossing this boundary are immutable: `buildSnapshot` shallow-freezes
 * every record and its `decls`/`imports`/`exports`/`calls`/`refs` arrays before
 * handing it to `set` and before putting it in the snapshot, so an implementation
 * may store and hand back the same object without any defensive copying. Nothing
 * downstream may mutate a `FileRecord`.
 */
export interface ParseCache {
  get(sha256: string, lang: Lang): FileRecord | undefined;
  set(record: FileRecord): void;
}

export interface BuildOptions {
  /** Repo root. Resolved to an absolute path; never serialized. */
  root: string;
  /** Config to build with. Defaults to `loadConfig(root)`. */
  config?: GreplostConfig;
  /** Parser handle. Created on demand, and only when something needs parsing. */
  parser?: ParserHandle;
  /** Extraction cache. Absent means every file is parsed. */
  cache?: ParseCache;
  /** Semantic-layer cache, for `summaryHash`/`staleSummary` only. */
  summaries?: SummaryCache;
  /**
   * Out-parameter: discovery appends, sorted, every candidate path it had to
   * skip because the path itself cannot be a map id (it holds a `#`, a newline
   * or a NUL; see `isMappablePath`). A caller that passes one can report the
   * count; one that does not still gets the same snapshot.
   */
  skipped?: string[];
}

/** Files read in parallel per batch: enough to saturate a disk, few enough to keep FDs sane. */
const READ_CONCURRENCY = 32;

interface SourceFile extends DiscoveredFile {
  source: string;
  sha256: string;
}

export async function buildSnapshot(opts: BuildOptions): Promise<Snapshot> {
  const root = path.resolve(opts.root);
  const config = opts.config ?? loadConfig(root);

  // Discovery order is not trusted: the pipeline is fed a path-sorted list so
  // the output cannot depend on how the files were found.
  const discovered = [...(await discoverFiles(root, config, opts.skipped))].sort((a, b) =>
    compareStrings(a.path, b.path),
  );
  const sources = await readSources(discovered);

  // A parser this build had to create for itself, released when the build ends. A
  // handle the caller passed in is the caller's and is never disposed here: a host
  // that builds twice with one parser (every test file that keeps one in `beforeAll`,
  // and `buildArtifacts` with `opts.parser`) would otherwise get freed wasm memory on
  // its second build.
  const owned: { handle: ParserHandle | null } = { handle: null };
  try {
    return await assemble(root, config, sources, opts, owned);
  } finally {
    owned.handle?.dispose();
  }
}

/**
 * Everything after the reads: extraction, resolution, linking and the manifest.
 *
 * Split out of `buildSnapshot` only so the parser it may create has one `finally` that
 * covers the whole of it, including the throwing paths (an unparsable file, a resolver
 * error), which are exactly the runs a leak would otherwise accumulate on.
 */
async function assemble(
  root: string,
  config: GreplostConfig,
  sources: SourceFile[],
  opts: BuildOptions,
  owned: { handle: ParserHandle | null },
): Promise<Snapshot> {
  const files = await extractAll(sources, opts, config.signals, owned);

  const paths = files.map((file) => file.path);
  const packages = detectPackages(root, paths, config);
  const readRepoFile = repoReader(root);
  const repoContext = { root, files: new Set(paths), packages, readFile: readRepoFile };
  const resolver = createResolver(repoContext);

  const imports = linkImports(files, resolver);
  const exportIndex = buildExportIndex(files, imports);
  const calls = linkCalls(files, imports, exportIndex);
  const references = linkReferences(files, resolver, repoContext);
  const { manifestFiles, manifestPackages, metrics } = computeMetrics(files, packages, imports);

  const summaries = indexSummaries(opts.summaries);
  const manifestEntries: Record<string, FileEntry> = {};
  for (const filePath of Object.keys(manifestFiles).sort(compareStrings)) {
    const computed = manifestFiles[filePath];
    // The key came from `manifestFiles` itself; a hole would mean a broken Map.
    if (computed === undefined) {
      throw new Error(`greplost: internal error: no computed metrics for ${filePath}`);
    }
    const summary = summaryFor(filePath, computed.sha256, summaries);
    manifestEntries[filePath] = {
      ...computed,
      exports: exportNames(exportIndex, filePath),
      staleSummary: summary.stale,
      ...(summary.hash === undefined ? {} : { summaryHash: summary.hash }),
    };
  }

  const manifest: Manifest = {
    version: SCHEMA_VERSION,
    packages: manifestPackages,
    files: manifestEntries,
  };

  const symbols: Declaration[] = [];
  for (const file of files) for (const decl of file.decls) symbols.push(decl);
  symbols.sort(compareDeclarations);

  return {
    root,
    config,
    packages,
    files,
    manifest,
    imports: [...imports].sort(compareEdges),
    calls: [...calls].sort(compareEdges),
    symbols,
    metrics,
    // Always present, `[]` when nothing produced one, so a consumer never has to ask whether
    // this snapshot predates schema 2. `serializeSnapshot` is what decides not to write the
    // artifact for an empty list, so an existing repo's artifact set does not change.
    references,
  };
}

/** Read every discovered file, hashing the raw bytes before decoding them. */
async function readSources(discovered: DiscoveredFile[]): Promise<SourceFile[]> {
  const sources: SourceFile[] = new Array<SourceFile>(discovered.length);
  for (let start = 0; start < discovered.length; start += READ_CONCURRENCY) {
    const batch = discovered.slice(start, start + READ_CONCURRENCY);
    const read = await Promise.all(batch.map(async (file) => readOne(file)));
    for (let i = 0; i < read.length; i++) sources[start + i] = read[i] as SourceFile;
  }
  return sources;
}

async function readOne(file: DiscoveredFile): Promise<SourceFile> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file.absPath);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`greplost: cannot read ${file.path}: ${reason}`);
  }
  // Source is the bytes, untouched: the hash and the text the extractor sees
  // describe the same file. (A leading BOM is left in place; tree-sitter keeps
  // it out of every node's text, so it changes no declaration or signature.)
  return { ...file, source: bytes.toString("utf8"), sha256: sha256Hex(bytes) };
}

/**
 * Cache lookups first, then one synchronous extraction pass over the misses.
 * The parser is created only if something actually needs parsing, so a fully
 * warm cache never pays for WASM start-up.
 *
 * Content, not path, is what gets parsed: two indexed files with identical
 * bytes are parsed once and the record is re-stamped for the second, whether
 * the twin arrived from the cache or from this very build.
 *
 * Content alone is not enough to identify a record, though: extraction also
 * depends on the language, so both the cache and the in-build twin map are
 * keyed by `(lang, sha256)`. Two empty files, one `.ts` and one `.jsx`, share a
 * hash and must not share a record.
 *
 * Every record leaving this function is frozen (see `freezeRecord`).
 */
async function extractAll(
  sources: SourceFile[],
  opts: BuildOptions,
  signals: readonly SignalPassId[] | undefined,
  owned: { handle: ParserHandle | null },
): Promise<FileRecord[]> {
  const cache = opts.cache;
  const files = new Array<FileRecord | undefined>(sources.length);
  /** Index of the first file to claim each (language, hash): the one that is parsed. */
  const firstOfKey = new Map<string, number>();
  /** (language, hash) -> the later files that share it and are filled from that parse. */
  const twins = new Map<string, number[]>();
  const misses: number[] = [];

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i] as SourceFile;
    const key = recordKey(source, signals);
    const hit = cache?.get(source.sha256, source.lang);
    // A cached record is only re-stampable onto another path while nothing in it came from
    // the path it was extracted at. The signal layer says what it reads (`signalPathKey`);
    // when the two paths disagree, the hit is not this file's record and it is re-extracted.
    if (hit !== undefined && signalPathKey(hit.path, hit.lang, signals) === signalPathKey(source.path, source.lang, signals)) {
      files[i] = restamp(hit, source.path);
      continue;
    }
    if (!firstOfKey.has(key)) {
      firstOfKey.set(key, i);
      misses.push(i);
      continue;
    }
    const siblings = twins.get(key);
    if (siblings === undefined) twins.set(key, [i]);
    else siblings.push(i);
  }

  if (misses.length > 0) {
    let parser = opts.parser;
    if (parser === undefined) {
      parser = await createParser();
      owned.handle = parser;
    }
    for (const i of misses) {
      const source = sources[i] as SourceFile;
      const record = freezeRecord(extract(source, parser, signals));
      cache?.set(record);
      files[i] = record;
      for (const twin of twins.get(recordKey(source, signals)) ?? []) {
        files[twin] = restamp(record, (sources[twin] as SourceFile).path);
      }
    }
  }

  return files.map((record, i) => {
    // Every slot is filled above: a cache hit, a parse, or a twin of a parse.
    if (record === undefined) {
      throw new Error(`greplost: internal error: no record extracted for ${(sources[i] as SourceFile).path}`);
    }
    return record;
  });
}

/**
 * Identity of an extraction result: the same bytes read as two languages are two records, and
 * so are the same bytes at two paths the signal layer would name differently (schema 2).
 */
function recordKey(source: SourceFile, signals: readonly SignalPassId[] | undefined): string {
  const fromPath = signalPathKey(source.path, source.lang, signals);
  return fromPath === "" ? `${source.lang}:${source.sha256}` : `${source.lang}:${source.sha256}:${fromPath}`;
}

/**
 * One file's extraction. A grammar failure names the file it happened on: the
 * raw parser error says only what went wrong, never where.
 */
function extract(source: SourceFile, parser: ParserHandle, signals: readonly SignalPassId[] | undefined): FileRecord {
  try {
    return extractFile(
      {
        path: source.path,
        lang: source.lang,
        source: source.source,
        sha256: source.sha256,
        ...(signals === undefined ? {} : { signals }),
      },
      parser,
    );
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`greplost: cannot parse ${source.path}: ${reason}`);
  }
}

/**
 * Records are immutable at the cache boundary and in the snapshot: a cache may
 * hand the same object to two builds, so a consumer that mutated one would
 * corrupt every later build. Shallow-frozen (the record and its four arrays);
 * the `Declaration` objects inside are shared, never rewritten in place.
 */
function freezeRecord(record: FileRecord): FileRecord {
  Object.freeze(record.decls);
  Object.freeze(record.imports);
  Object.freeze(record.exports);
  Object.freeze(record.calls);
  if (record.refs !== undefined) Object.freeze(record.refs);
  return Object.freeze(record);
}

/**
 * Re-address a cached record onto the path that asked for it. Identical bytes
 * can live at two paths, and a `Declaration` carries the file it came from in
 * both `file` and `id`, so those move with the record.
 *
 * Schema 2: a non-file node's id is `<file>#<kind>.<name>` and not
 * `<file>#<name>`, so re-addressing has to ask which form the declaration
 * takes. `symbolId` alone silently dropped the kind, which only shows up when
 * two files have *identical bytes*, 727 of terraform-aws-vpc's 1,909
 * declarations, because its per-example `outputs.tf` files are copies of one
 * another.
 *
 * `Declaration.id` is the canonical form and nothing re-derives it from the
 * kind and the name (driver ruling 2026-09-04): `splitNodeId` reads the kind
 * and the name back out of the id the producer wrote, so a producer whose
 * `name` is not what its id holds cannot double-stamp the kind
 * (`#route.route./x`, 42 false positives on next-app before this).
 *
 * The result is frozen either way: a foreign cache may hand back a record this
 * build never froze.
 */
function restamp(record: FileRecord, filePath: string): FileRecord {
  if (record.path === filePath) return freezeRecord(record);
  return freezeRecord({
    ...record,
    path: filePath,
    decls: record.decls.map((decl) => ({
      ...decl,
      file: filePath,
      // Only the file segment of an id changes between byte-identical files: the rest
      // (`#Store~2`, `#route./x`) is the declaration's identity and travels unchanged,
      // including the `~<n>` suffix a duplicate name carries (ruling 2026-09-04).
      id: moveId(decl.id, record.path, filePath),
    })),
  });
}

/** Re-home an id (`<file>#<rest>`) from `from` to `to`; an id of another file is returned as is. */
function moveId(id: string, from: string, to: string): string {
  const prefix = `${from}#`;
  return id.startsWith(prefix) ? `${to}#${id.slice(prefix.length)}` : id;
}

/**
 * Repo-relative reader for the resolver: package.json, tsconfig.json and the
 * like, which are not in the indexed file set. Memoised (misses included)
 * because one tsconfig is consulted by every file beneath it.
 */
function repoReader(root: string): (rel: string) => string | null {
  const cache = new Map<string, string | null>();
  return (rel: string): string | null => {
    const cached = cache.get(rel);
    if (cached !== undefined) return cached;
    let text: string | null;
    try {
      text = readFileSync(path.join(root, rel), "utf8");
    } catch {
      text = null;
    }
    cache.set(rel, text);
    return text;
  };
}

/**
 * The two lookups `summaryFor` needs, precomputed once: whole-cache scans per
 * file would make a large repo quadratic in the number of summaries.
 */
interface SummaryIndex {
  /** Is there a summary for this exact content? */
  fresh(sha256: string): boolean;
  /** Hash of the newest summary ever written for this path, if any. */
  newestFor(filePath: string): string | undefined;
}

function indexSummaries(summaries: SummaryCache | undefined): SummaryIndex | null {
  if (summaries === undefined) return null;
  const newest = new Map<string, { hash: string; refreshedAt: string }>();
  // Keys are visited in code-unit order and only a strictly newer entry wins,
  // so a `refreshedAt` tie resolves to the smallest hash, never to whatever
  // order the parsed JSON happened to have.
  for (const hash of Object.keys(summaries).sort(compareStrings)) {
    const entry = summaries[hash];
    if (entry === undefined) continue;
    const current = newest.get(entry.path);
    if (current === undefined || compareStrings(entry.refreshedAt, current.refreshedAt) > 0) {
      newest.set(entry.path, { hash, refreshedAt: entry.refreshedAt });
    }
  }
  return {
    fresh: (sha256) => summaries[sha256] !== undefined,
    newestFor: (filePath) => newest.get(filePath)?.hash,
  };
}

/**
 * `summaryHash`/`staleSummary` (tech spec 6, core-extract spec "Build"):
 *  - a summary written for the current content hash is fresh;
 *  - otherwise the newest summary written for this path is reported as stale,
 *    so a card can still show its last known prose behind the banner;
 *  - a file that was never summarised is not stale and carries no hash.
 */
function summaryFor(
  filePath: string,
  sha256: string,
  summaries: SummaryIndex | null,
): { hash?: string; stale: boolean } {
  if (summaries === null) return { stale: false };
  if (summaries.fresh(sha256)) return { hash: sha256, stale: false };
  const previous = summaries.newestFor(filePath);
  return previous === undefined ? { stale: false } : { hash: previous, stale: true };
}
