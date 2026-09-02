/**
 * `greplost refresh` (tech spec 4.1, 6; semantic spec "Rules").
 *
 * The semantic layer's one job, and the layer rule is what makes it hard: an
 * LLM writes prose into `cache/summaries.json`, and not one byte of the
 * structure layer may move except through that cache. So nothing here renders
 * a card, edits a manifest or knows what a module card looks like. It decides
 * which files are stale, asks a model about them in batches, writes the cache,
 * and hands the rest back to `@greplost/sync`, which rebuilds the whole map
 * from the checkout exactly as it would have anyway. A card gains a paragraph
 * because the cache gained an entry, never because this file wrote to it.
 *
 * Cost is the other constraint that shapes the code. Summaries are keyed by the
 * sha256 of the content they describe, so a second refresh on an unchanged
 * repository finds nothing stale and makes zero calls — that is a gate, not an
 * aspiration — and a teammate who pulls the committed cache pays nothing for
 * code that has not moved. `FLOWS.md` follows the same rule from the other
 * side: it is regenerated when the package it describes was actually
 * resummarised, or when it does not exist yet, and skipped otherwise.
 *
 * Ordering is chosen for what survives a failure, because every failure here
 * happens after money has been spent. Nothing is written until every batch has
 * parsed — each batch gets one retry first, since a model that fumbles its
 * output format once usually does not fumble it twice — so a genuinely bad
 * answer leaves the committed cache byte-identical. Once the cache is written
 * the map is rebuilt and only then are the flows asked for, so a fumbled flows
 * call costs a document rather than twelve paragraphs; it is recorded in the
 * result and warned about, never thrown. A batch that answers for only some of
 * the files it was given is the same shape of problem: the files it did answer
 * for are committed, the rest stay stale, and the caller is told the count
 * rather than left to notice.
 *
 * Concurrency: the read-merge-write of the cache runs inside `@greplost/sync`'s
 * advisory lock, and the manifest is re-read inside it too, so an entry another
 * process committed while this one was waiting on a model is neither pruned as
 * unknown nor overwritten from a stale view of the repository. The lock is
 * never held across a model call — a hook that waits on a language model is a
 * hook that makes the shell feel broken — and it is never held across the
 * rebuild either, because `update` takes it itself. Residual window: if the
 * lock cannot be taken within `LOCK_ATTEMPTS` tries the merge proceeds without
 * it rather than discarding summaries that have already been paid for, so two
 * refreshes whose merges interleave in that window can still lose one entry
 * each. The alternative — dropping the work — is worse.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildSnapshot, loadConfig } from "@greplost/core";
import type { Manifest, PackageInfo, Snapshot, SummaryCache, SummaryEntry } from "@greplost/core/schema";
import { ARTIFACT_DIR, ARTIFACT_PATHS, compareStrings, packageSlug, stableStringify } from "@greplost/core/schema";
import { packageDir } from "@greplost/render";
import { FileParseCache, readSummaries, update, withLock } from "@greplost/sync";

import { REACH_DEPTH, callLines, importGraph, isoDate, reachableFrom, renderFlows, selectEntryPoints } from "./flows.ts";
import type { FlowRequest, SummaryRequest } from "./prompts.ts";
import { HEAD_LINES, buildFlowsPrompt, buildSummaryPrompt, parseFlowsResponse, parseSummaryResponse } from "./prompts.ts";
import { defaultRunner } from "./runner.ts";
import type { PromptRunner } from "./runner.ts";

/** Files per prompt (semantic spec "Contract"). */
export const DEFAULT_BATCH_SIZE = 12;

/**
 * Retries one summary batch gets before the run gives up.
 *
 * One, not three: an answer that is not the JSON it was asked for is usually a
 * formatting slip a second attempt does not repeat, and a model that has
 * genuinely misunderstood the request will keep misunderstanding it at full
 * price. The retry sends the same prompt, so it is the same request.
 */
export const RETRIES_PER_BATCH = 1;

/** Tries at the advisory lock before the merge goes ahead without it. */
const LOCK_ATTEMPTS = 5;

/** Wait between those tries; an `update` holds the lock for well under this. */
const LOCK_RETRY_MS = 200;

export interface RefreshOptions {
  /** Restrict to one package, by name (`@tiny/core`) or artifact slug (`tiny__core`). */
  pkg?: string;
  /** Model to ask. Defaults to `config.semantic.model`. */
  model?: string;
  /** The seam. Defaults to headless `claude -p`. */
  runner?: PromptRunner;
  /** Build the prompts, report the counts, call nothing and write nothing. */
  dryRun?: boolean;
  /** Files per prompt. */
  batchSize?: number;
  /** `YYYY-MM-DD` stamped on every entry written by this run. Defaults to today. */
  today?: string;
}

export interface RefreshResult {
  /** Summaries written (or, in a dry run, that would have been written). */
  refreshed: number;
  /** Files in scope whose summary was already current. */
  skipped: number;
  /** Runner calls made: summary batches, their retries, and flow documents. */
  calls: number;
  /**
   * Files that were asked about and did not come back, sorted.
   *
   * Not an error: they stay stale, the next refresh asks again, and the files
   * the same batch did answer for are committed. Reported because a silently
   * short answer is otherwise invisible until someone notices a card with no
   * prose on it.
   */
  unanswered: string[];
  /** `.greplost`-relative paths of the `FLOWS.md` documents this run wrote. */
  flows: string[];
  /**
   * Packages whose `FLOWS.md` could not be written, and why.
   *
   * A flows call happens after the summaries are committed, so failing the
   * whole run for one would throw away work that is already paid for and
   * already on disk. The caller warns; the exit code stays 0.
   */
  flowsFailed: Array<{ pkg: string; reason: string }>;
  /**
   * What happened to the map after the cache was written.
   *
   * Reported rather than assumed: writing prose nobody can see is the one way
   * a successful refresh can still be useless, and `update` declines to run
   * when another process holds the lock. `"unnecessary"` means there was
   * nothing new to show.
   */
  update: "rebuilt" | "locked" | "unnecessary";
}

export async function refresh(root: string, opts: RefreshOptions = {}): Promise<RefreshResult> {
  const absoluteRoot = path.resolve(root);
  const config = loadConfig(absoluteRoot);
  // A repository that has switched the semantic layer off has said so on
  // purpose, and the cheapest possible refresh is the one that does not run.
  if (!config.semantic.enabled) {
    throw new Error(
      `greplost: the semantic layer is disabled; set "semantic.enabled" to true in ${ARTIFACT_DIR}/${ARTIFACT_PATHS.config}`,
    );
  }

  const model = opts.model ?? config.semantic.model;
  const today = opts.today ?? isoDate(new Date());
  const dryRun = opts.dryRun === true;

  // A malformed date would reach the committed cache and the staleness banner,
  // where it is a lie every reader has to take at face value.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new Error(`greplost: today must be an ISO date (YYYY-MM-DD), not "${today}"`);
  }

  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`greplost: batchSize must be a positive whole number, not ${String(opts.batchSize)}`);
  }

  const cache = readSummaries(absoluteRoot);
  // Read-only use of the parse cache `update` maintains: never `save`d from
  // here, so a dry run still writes nothing, but a warm cache means a refresh
  // does not re-parse a repository the last update already parsed.
  const parseCache = new FileParseCache(absoluteRoot);
  parseCache.load();
  const snapshot = await buildSnapshot({ root: absoluteRoot, config, summaries: cache, cache: parseCache });
  // Resolved before anything is asked, so a typo in a package name costs
  // nothing but a message.
  const target = opts.pkg === undefined ? undefined : resolvePackage(snapshot, opts.pkg);

  const scope = filesInScope(snapshot.manifest, target);
  const stale = scope.filter((file) => isStale(snapshot.manifest, file));
  const skipped = scope.length - stale.length;
  // Indexed once: scanning every declaration per file would make prompt
  // assembly quadratic in a repository's size, and a refresh is the one command
  // that already costs money.
  const symbols = signaturesByFile(snapshot);

  const runner = opts.runner ?? defaultRunner();
  const batches = chunk(stale, batchSize);

  if (dryRun) {
    // The prompts are built anyway: a dry run that skipped them would not
    // exercise the one part of a refresh that can fail before a model is
    // involved (an unreadable source file, a package that does not exist).
    for (const batch of batches) buildSummaryPrompt(batch.map((file) => summaryRequest(absoluteRoot, snapshot, symbols, file)));
    return { refreshed: stale.length, skipped, calls: 0, unanswered: [], flows: [], flowsFailed: [], update: "unnecessary" };
  }

  let calls = 0;
  const written = new Map<string, string>();
  const unanswered: string[] = [];
  for (const batch of batches) {
    const prompt = buildSummaryPrompt(batch.map((file) => summaryRequest(absoluteRoot, snapshot, symbols, file)));
    // One retry, with the same prompt. A batch that cannot be parsed is usually
    // a formatting slip rather than a disagreement about the request, and
    // failing the run would discard every batch already paid for. Two failures
    // is a real disagreement, and then the run fails with nothing written.
    //
    // The retry covers the call as well as the answer: a rate limit or a
    // dropped connection is the same kind of accident as a fenced JSON block,
    // and losing eleven good batches to either is the outcome worth avoiding.
    // `calls` counts attempts, including one the runner rejected, because an
    // attempt that failed was still an attempt someone paid for.
    let answers: Map<string, string> | undefined;
    for (let attempt = 0; attempt < 1 + RETRIES_PER_BATCH; attempt++) {
      calls++;
      try {
        answers = parseSummaryResponse(await runner(prompt, { model }), batch);
        break;
      } catch (cause) {
        if (attempt === RETRIES_PER_BATCH) throw cause;
      }
    }
    const parsed = answers ?? new Map<string, string>();
    for (const [file, text] of parsed) written.set(file, text);
    for (const file of batch) if (!parsed.has(file)) unanswered.push(file);
  }
  unanswered.sort(compareStrings);

  let updated: RefreshResult["update"] = "unnecessary";
  if (written.size > 0) {
    const entries = new Map<string, CacheWrite>();
    for (const [file, text] of written) {
      // The hash the summary was written *for*: the content the model was shown,
      // not whatever the file may have become while it was thinking.
      const sha256 = snapshot.manifest.files[file]?.sha256;
      if (sha256 === undefined) continue;
      entries.set(file, { hash: sha256, entry: { path: file, text, refreshedAt: today, model } });
    }
    await commitCache(absoluteRoot, entries, snapshot.manifest);

    // `files` is not a hint here, it is the guarantee: an incremental update on
    // a clean git tree takes the fast path and skips, and the whole point of
    // this call is that the cards pick up prose the checkout cannot explain.
    const result = await update(absoluteRoot, {
      mode: "incremental",
      files: [...written.keys()].sort(compareStrings),
      quiet: true,
    });
    // "clean" cannot happen while `files` is non-empty, but calling it "locked"
    // if it ever did would send a reader hunting for a process that is not there.
    updated = result.skipped === undefined ? "rebuilt" : result.skipped === "locked" ? "locked" : "unnecessary";
  }

  const flows: string[] = [];
  const flowsFailed: RefreshResult["flowsFailed"] = [];
  for (const pkg of flowPackages(snapshot, target)) {
    const entryPoints = selectEntryPoints(snapshot, pkg);
    if (entryPoints.length === 0) continue;

    const relative = `${packageDir(pkg.name)}/FLOWS.md`;
    const file = path.join(absoluteRoot, ARTIFACT_DIR, relative);
    // Regenerated when the package it describes actually moved, or when it does
    // not exist yet. Anything looser would make the zero-call gate unreachable:
    // flows would cost a call on every refresh of an unchanged repository.
    const resummarised = [...written.keys()].some((done) => snapshot.manifest.files[done]?.pkg === pkg.name);
    if (!resummarised && existsSync(file)) continue;

    // Per package, and never fatal: the summaries are already committed, and a
    // second package's document is not the first one's business either.
    try {
      calls++;
      const answer = await runner(buildFlowsPrompt(pkg.name, flowRequests(snapshot, entryPoints)), { model });
      writeFile(file, relative, renderFlows(pkg, parseFlowsResponse(answer), today));
      flows.push(relative);
    } catch (cause) {
      flowsFailed.push({ pkg: pkg.name, reason: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  return { refreshed: written.size, skipped, calls, unanswered, flows, flowsFailed, update: updated };
}

/* -------------------------------------------------------------------------- */
/* The CLI's contract                                                          */
/* -------------------------------------------------------------------------- */

/** What `greplost refresh` passes through, plus the seams an embedder may want. */
export interface RefreshCommandOptions {
  /** `greplost refresh [pkg]`. */
  package?: string;
  model?: string;
  dryRun?: boolean;
  json?: boolean;
  runner?: PromptRunner;
  batchSize?: number;
  today?: string;
}

/**
 * `greplost refresh`, as an exit code.
 *
 * The CLI leaf left this seam deliberately shaped: the semantic layer owns its
 * own output and its own failures, so the command surface never has to know
 * what a model call is. Anything thrown becomes one `greplost: ` line on
 * stderr and exit 1, which is the same failure shape every other command has.
 */
export async function refreshCommand(root: string, opts: RefreshCommandOptions = {}): Promise<number> {
  try {
    const result = await refresh(root, {
      ...(opts.package === undefined ? {} : { pkg: opts.package }),
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.runner === undefined ? {} : { runner: opts.runner }),
      ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
      ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
      ...(opts.today === undefined ? {} : { today: opts.today }),
    });

    if (opts.json === true) console.log(stableStringify(result, 2));
    else console.log(humanSummary(result, opts.dryRun === true));
    warn(result, opts.dryRun === true);
    return 0;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(message.startsWith("greplost: ") ? message : `greplost: ${message}`);
    return 1;
  }
}

/**
 * Everything a *successful* refresh still has to say out loud.
 *
 * All of it on stderr, including in `--json` mode, for two reasons that point
 * the same way: `--json` stdout has to stay one parseable document, and none of
 * these are failures. A partial answer, a flows document that could not be
 * written and a rebuild that lost a race all leave the repository better than
 * it was; they just leave it short of what was asked for, and a person who is
 * not told will read a map that is quietly incomplete and believe it.
 */
function warn(result: RefreshResult, dryRun: boolean): void {
  if (dryRun) return;

  if (result.unanswered.length > 0) {
    const asked = result.refreshed + result.unanswered.length;
    console.error(
      `greplost: the model did not answer for ${result.unanswered.length} of ${asked} files; they stay stale`,
    );
  }
  for (const failure of result.flowsFailed) {
    console.error(`greplost: could not write FLOWS.md for ${failure.pkg}: ${failure.reason}`);
  }
  if (result.update === "locked") {
    console.error("greplost: another update held the lock; run `greplost update` to render the new summaries");
  }
}

function humanSummary(result: RefreshResult, dryRun: boolean): string {
  const noun = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
  if (dryRun) {
    return `greplost: ${noun(result.refreshed, "summary", "summaries")} would be refreshed, ${result.skipped} already fresh (dry run)`;
  }
  const parts = [
    `${noun(result.refreshed, "summary", "summaries")} refreshed`,
    `${result.skipped} already fresh`,
    `${noun(result.calls, "model call", "model calls")}`,
  ];
  if (result.flows.length > 0) parts.push(`${noun(result.flows.length, "flow document", "flow documents")}`);
  return `greplost: ${parts.join(", ")}`;
}

/* -------------------------------------------------------------------------- */
/* Scope                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The package `name` refers to, by manifest name or by the slug its artifacts
 * live under. Both are accepted because both are on screen: `greplost flows`
 * prints one and `.greplost/packages/` shows the other.
 */
function resolvePackage(snapshot: Snapshot, name: string): PackageInfo {
  const byName = snapshot.packages.find((pkg) => pkg.name === name);
  if (byName !== undefined) return byName;
  const bySlug = snapshot.packages.find((pkg) => packageSlug(pkg.name) === name);
  if (bySlug !== undefined) return bySlug;

  const known = snapshot.packages.map((pkg) => pkg.name).sort(compareStrings);
  throw new Error(`greplost: no package ${name} in this repository (known: ${known.join(", ")})`);
}

/** Indexed files, sorted, restricted to `target` when there is one. */
function filesInScope(manifest: Manifest, target: PackageInfo | undefined): string[] {
  const files = Object.keys(manifest.files).sort(compareStrings);
  if (target === undefined) return files;
  return files.filter((file) => manifest.files[file]?.pkg === target.name);
}

/**
 * Stale set (semantic spec "Rules"): the manifest says the summary lags the
 * code, or there has never been one. A file with no summary is not marked
 * `staleSummary` by the core build — there is nothing for it to lag — so the
 * missing `summaryHash` is what puts it in scope for a first refresh.
 */
function isStale(manifest: Manifest, file: string): boolean {
  const entry = manifest.files[file];
  if (entry === undefined) return false;
  return entry.staleSummary || entry.summaryHash === undefined;
}

function flowPackages(snapshot: Snapshot, target: PackageInfo | undefined): PackageInfo[] {
  const packages = target === undefined ? [...snapshot.packages] : [target];
  return packages.sort((a, b) => compareStrings(a.name, b.name));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

/* -------------------------------------------------------------------------- */
/* Prompt inputs                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What the model is told about one file: its path, its exported names and its
 * declarations as written. Source is read only when there are no exports to
 * describe, and then only its head (semantic spec "Rules").
 */
function summaryRequest(
  root: string,
  snapshot: Snapshot,
  signatures: ReadonlyMap<string, string[]>,
  file: string,
): SummaryRequest {
  const exports = snapshot.manifest.files[file]?.exports ?? [];
  const symbols = signatures.get(file) ?? [];
  if (exports.length > 0) return { path: file, exports: [...exports], symbols };

  const head = readHead(path.join(root, file));
  return { path: file, exports: [], symbols, ...(head === undefined ? {} : { head }) };
}

/** Declaration signatures grouped by file, in the snapshot's declaration order. */
function signaturesByFile(snapshot: Snapshot): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const decl of snapshot.symbols) {
    const bucket = byFile.get(decl.file);
    if (bucket === undefined) byFile.set(decl.file, [decl.signature]);
    else bucket.push(decl.signature);
  }
  return byFile;
}

function readHead(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8").split("\n").slice(0, HEAD_LINES).join("\n");
  } catch {
    // A file the manifest knows about but the checkout no longer holds; the
    // structure layer will prune it on the next build, and the model can do
    // without it in the meantime.
    return undefined;
  }
}

/** One entry point, the files it reaches within `REACH_DEPTH` hops, and the calls between them. */
function flowRequests(snapshot: Snapshot, entryPoints: readonly string[]): FlowRequest[] {
  const graph = importGraph(snapshot);
  return entryPoints.map((file) => {
    const reached = reachableFrom(graph, file, REACH_DEPTH);
    const neighbourhood = new Set([file, ...reached]);
    return { file, reaches: [...reached].sort(compareStrings), calls: callLines(snapshot, neighbourhood) };
  });
}

/* -------------------------------------------------------------------------- */
/* The cache                                                                   */
/* -------------------------------------------------------------------------- */

/** One summary this run is committing: the content hash it describes, and the entry. */
interface CacheWrite {
  hash: string;
  entry: SummaryEntry;
}

/**
 * Read the cache, re-read the manifest, merge, write — under the update lock.
 *
 * Both reads happen inside the lock and as late as possible. Model calls take
 * minutes, and in that time another refresh can commit entries, a teammate's
 * `git pull` can land a new file and an `update` can reindex the tree; merging
 * onto a view of the world from before all that would prune entries as unknown
 * and overwrite hashes that are now the current ones.
 *
 * When the lock cannot be taken the merge goes ahead anyway. That is a real
 * (small) window in which two interleaved merges lose an entry each, and it is
 * still the right trade: the alternative is throwing away summaries that have
 * already been paid for because a git hook happened to be rebuilding the map.
 * Returns whether the lock was held, for callers that want to say so.
 */
async function commitCache(
  root: string,
  written: ReadonlyMap<string, CacheWrite>,
  fallback: Manifest,
): Promise<boolean> {
  const merge = (): void => {
    writeCache(root, nextCache(readSummaries(root), currentManifest(root, fallback), written));
  };

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    const held = await withLock(root, () => {
      merge();
      return Promise.resolve(true);
    });
    if (held === true) return true;
    if (attempt + 1 < LOCK_ATTEMPTS) await delay(LOCK_RETRY_MS);
  }

  merge();
  return false;
}

/**
 * The manifest as it is on disk right now, or the one this run built when there
 * is nothing readable there.
 *
 * `manifest.json` alone, rather than `readStructure`: the only question here is
 * which paths and hashes the map currently describes, and the three graph files
 * `readStructure` also parses can run to megabytes on a real repository — which
 * is not something to do while holding the lock every git hook is waiting on.
 * Same reasoning, and the same shape check, as `@greplost/sync`'s own
 * manifest-only read.
 */
function currentManifest(root: string, fallback: Manifest): Manifest {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(root, ARTIFACT_DIR, ARTIFACT_PATHS.manifest), "utf8"));
    return isManifest(parsed) ? parsed : fallback;
  } catch {
    // Absent, unreadable, or not a manifest at all. The snapshot's own view is
    // the best answer available, and the update that follows rewrites the file
    // anyway.
    return fallback;
  }
}

/** Shape check only: enough to refuse a file that is not our manifest. */
function isManifest(value: unknown): value is Manifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as { version?: unknown; files?: unknown; packages?: unknown };
  return (
    typeof candidate.version === "string" &&
    typeof candidate.files === "object" &&
    candidate.files !== null &&
    !Array.isArray(candidate.files) &&
    typeof candidate.packages === "object" &&
    candidate.packages !== null
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The cache this run commits: what was there, plus one entry per summary
 * written, minus what neither describes current content nor is the last thing
 * anyone wrote about a path the map still holds.
 *
 * That second survivor is the banner's evidence. A stale card renders the
 * newest summary its path ever had, so pruning "everything that is not
 * current" would silently turn every stale card back into a placeholder the
 * moment its file changed (tech spec 6, render spec).
 *
 * A path this run rewrote is the exception, and it is why the rule is here at
 * all. `refreshedAt` is a date, because a date is what the banner renders, so
 * every refresh on a given day ties with every other refresh that day; the
 * tie-break is the smallest hash, which is arbitrary. Six edit-and-refresh
 * cycles in one afternoon therefore left the *first* summary of the day
 * standing as "newest", and the next edit rendered it under the banner. So a
 * rewritten path keeps exactly one entry and the tie becomes unreachable: the
 * entry for the manifest's current hash when there is one — which is the
 * concurrent case, where another process resummarised the file this run was
 * still thinking about — and otherwise the one this run just wrote.
 */
function nextCache(
  cache: SummaryCache,
  manifest: Manifest,
  written: ReadonlyMap<string, CacheWrite>,
): SummaryCache {
  const merged: SummaryCache = { ...cache };
  for (const { hash, entry } of written.values()) merged[hash] = entry;

  const current = new Set(Object.values(manifest.files).map((entry) => entry.sha256));

  // The single hash each rewritten path is allowed to keep.
  const rewritten = new Map<string, string>();
  for (const [file, { hash }] of written) {
    const live = manifest.files[file]?.sha256;
    rewritten.set(file, live !== undefined && merged[live] !== undefined ? live : hash);
  }

  const newest = newestByPath(merged);
  const pruned: SummaryCache = {};
  for (const hash of Object.keys(merged).sort(compareStrings)) {
    const entry = merged[hash];
    if (entry === undefined) continue;

    const only = rewritten.get(entry.path);
    if (only !== undefined) {
      if (only === hash) pruned[hash] = entry;
      continue;
    }

    // Current content, or the last thing anyone wrote about a file the map
    // still describes. A path the manifest no longer holds has no card and so
    // no banner to feed: keeping its prose would make the committed cache grow
    // with the repository's history rather than its size, which is the one
    // thing `writeArtifacts` already refuses to do with cards.
    const indexed = manifest.files[entry.path] !== undefined;
    if (current.has(hash) || (indexed && newest.get(entry.path) === hash)) pruned[hash] = entry;
  }
  return pruned;
}

/**
 * The newest entry per path, resolved exactly as the core build resolves it:
 * keys in code-unit order, only a strictly newer `refreshedAt` wins, so a tie
 * lands on the smallest hash on every machine (core `indexSummaries`).
 */
function newestByPath(cache: SummaryCache): Map<string, string> {
  const newest = new Map<string, { hash: string; refreshedAt: string }>();
  for (const hash of Object.keys(cache).sort(compareStrings)) {
    const entry = cache[hash];
    if (entry === undefined) continue;
    const current = newest.get(entry.path);
    if (current === undefined || compareStrings(entry.refreshedAt, current.refreshedAt) > 0) {
      newest.set(entry.path, { hash, refreshedAt: entry.refreshedAt });
    }
  }
  const byPath = new Map<string, string>();
  for (const [file, best] of newest) byPath.set(file, best.hash);
  return byPath;
}

function writeCache(root: string, cache: SummaryCache): void {
  writeFile(path.join(root, ARTIFACT_DIR, ARTIFACT_PATHS.summaries), ARTIFACT_PATHS.summaries, `${stableStringify(cache, 2)}\n`);
}

/** Serial number for temporary files, so one run cannot collide with itself. */
let tempCounter = 0;

/**
 * Put `contents` at `file` through a sibling temporary and a rename.
 *
 * Not `writeFileSync` on the target, for the two reasons `@greplost/sync`'s
 * writer gives and one of its own. A reader must never see half a file:
 * `readSummaries` throws on a cache it cannot parse, so a torn write would take
 * `greplost update` and `greplost verify` down for everyone until someone
 * deleted it by hand. An in-place write also rewrites a hard-linked inode under
 * its other name. And a rename fails or succeeds whole, so a failure leaves the
 * committed file exactly as it was.
 *
 * The temporary uses the naming `writeArtifacts` uses (`.<name>.<pid>.<n>.tmp`)
 * so that a process killed between the write and the rename leaves something
 * `update` already knows how to sweep, and that neither `verify` nor the
 * pruner will act on.
 */
function writeFile(file: string, label: string, contents: string): void {
  const dir = path.dirname(file);
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${tempCounter++}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temporary, contents);
    renameSync(temporary, file);
  } catch (cause) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Nothing reads a `.tmp`; leaving one behind is not worth an error.
    }
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`greplost: cannot write ${ARTIFACT_DIR}/${label}: ${reason}`);
  }
}
