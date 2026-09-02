/**
 * Reading a suite's result payload (bench leaf 1.5.7).
 *
 * Every value `RESULTS.md` prints comes through this file, and nothing here
 * knows what a document looks like. The split matters because the two halves
 * have opposite failure modes: a renderer that guesses is a lie, and a reader
 * that refuses to guess is a report that says `not run` for a suite whose
 * payload merely nests its summary one level deeper than documented.
 *
 * So the reading is forgiving and the forgiveness is disclosed. `firstNum` walks
 * a list of candidate paths, then falls back to searching the payload for the
 * key by name, and every use of that fallback is recorded in `assumptions` and
 * printed in the document preamble. A payload that matches nothing degrades that
 * section to `not run` and never throws.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { compareStrings } from "@greplost/core/schema";

import type { ReportModel, RunTarget } from "./results-md.ts";
import { provenanceLine } from "./results-md.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

/** One suite's newest result: the parsed payload and the file it came from. */
export interface Payload {
  data: Record<string, unknown>;
  file: string;
}


export function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** `a.b.c` against a payload; undefined at any hop yields null. */
function at(root: unknown, dotted: string): unknown {
  let cursor: unknown = root;
  for (const key of dotted.split(".")) {
    const record = rec(cursor);
    if (record === null) return undefined;
    cursor = record[key];
  }
  return cursor;
}

/**
 * Every value this report found by searching for a key name rather than at a
 * documented path. Collected per `buildModel` call and printed in the preamble,
 * because a number read out of a payload whose shape nobody agreed on is a
 * number a reader should be able to distrust on sight.
 */
export let assumptions: string[] = [];

/** Clear the disclosed-assumption log at the start of a `buildModel` pass. */
export function resetAssumptions(): void {
  assumptions = [];
}

/**
 * The first of `paths` that holds a finite number; then, as a fallback, the first
 * value found anywhere in the payload under the last path segment of any
 * candidate. The fallback is what makes this report survive a neighbour suite
 * nesting its summary one level deeper than documented — and every use of it is
 * recorded in `assumptions`, so it is a disclosed guess rather than a silent one.
 */
export function firstNum(root: unknown, paths: readonly string[]): number | null {
  for (const dotted of paths) {
    const value = num(at(root, dotted));
    if (value !== null) return value;
  }
  for (const dotted of paths) {
    const key = dotted.split(".").pop();
    if (key === undefined) continue;
    const found = deepFind(root, key, 5);
    const value = num(found);
    if (value !== null) {
      assumptions.push(`\`${key}\` was not at ${paths.map((path_) => `\`${path_}\``).join(" or ")}; the value used was found by searching the payload for that key`);
      return value;
    }
  }
  return null;
}

export function firstStr(root: unknown, paths: readonly string[]): string | null {
  for (const dotted of paths) {
    const value = str(at(root, dotted));
    if (value !== null) return value;
  }
  return null;
}

/** Breadth-first search for `key`, so the shallowest match wins. */
function deepFind(root: unknown, key: string, maxDepth: number): unknown {
  let frontier: unknown[] = [root];
  for (let depth = 0; depth <= maxDepth; depth++) {
    const next: unknown[] = [];
    for (const node of frontier) {
      const record = rec(node);
      if (record === null) continue;
      if (key in record) return record[key];
      for (const child of Object.keys(record).sort()) next.push(record[child]);
    }
    if (next.length === 0) return undefined;
    frontier = next;
  }
  return undefined;
}

/** Three decimals under 10, one under 1000, none above; `not run` for null. */
export function fmt(value: number | null): string {
  if (value === null) return "not run";
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return String(Math.round(value));
  if (magnitude >= 10) return String(Math.round(value * 10) / 10);
  return String(Math.round(value * 1000) / 1000);
}


/**
 * The rendered provenance line for a payload, or null when it carries no date
 * and no SHA.
 *
 * It goes through `provenanceLine`, so the corpus, the file count and the walk
 * length travel with the date wherever the payload recorded them. A head-to-head
 * table that says "Measured 2026-09-02" and not "on fixtures/tiny-ts (12 files,
 * 24 commits)" invites the reader to size the result wrongly, and the numbers in
 * it are small enough that the difference matters.
 */
export function provenanceOf(payload: Payload | null): string | null {
  if (payload === null) return null;
  const date = str(payload.data["date"]);
  const sha = str(payload.data["greplostSha"]);
  if (date === null && sha === null) return null;
  return provenanceLine(date, sha, targetOf(payload));
}

export function firstMachine(payloads: readonly (Payload | null)[]): Record<string, unknown> | null {
  for (const payload of payloads) {
    if (payload === null) continue;
    const machine = rec(payload.data["machine"]);
    if (machine !== null && Object.keys(machine).length > 0) return machine;
  }
  return null;
}

/**
 * The corpus table: every repo any payload named, with its pinned facts.
 *
 * A payload carries whatever the suite that wrote it recorded, and several
 * record only the repo's name — which rendered as `| gin | - | - | - |`, three
 * dashes for facts the repository already knows. Tier, language and the pinned
 * SHA come from `bench/corpus.json` whenever it lists the repo, and the payload
 * fills in only what the pinned file does not have (review round 2, minor).
 */
export function mergeCorpus(payloads: readonly (Payload | null)[]): ReportModel["corpus"] {
  const pinned = corpusIndex();
  const seen = new Map<string, ReportModel["corpus"][number]>();
  for (const payload of payloads) {
    if (payload === null) continue;
    for (const entry of arr(payload.data["corpus"])) {
      const record = rec(entry);
      const name = record === null ? null : str(record["name"]);
      if (name === null || seen.has(name)) continue;
      const listed = pinned.get(name);
      const sha = listed?.sha ?? str(record?.["sha"]);
      const tier = listed?.tier ?? str(record?.["tier"]);
      const lang = listed?.lang ?? str(record?.["lang"]);
      seen.set(name, {
        name,
        ...(sha === null || sha === undefined ? {} : { sha }),
        ...(tier === null || tier === undefined ? {} : { tier }),
        ...(lang === null || lang === undefined ? {} : { lang }),
      });
    }
  }
  return [...seen.values()].sort((a, b) => compareStrings(a.name, b.name));
}

/**
 * Versions: the machine profile's toolchain, the pinned competitor versions from
 * `bench/competitors.json`, and the Claude CLI and model the agent suite recorded
 * (tech spec 10.1, "pinned everything").
 */
export function versionRows(agent: Payload | null, headtohead: Payload | null): { name: string; value: string }[] {
  const rows: { name: string; value: string }[] = [];
  const machine = firstMachine([headtohead, agent]);
  for (const key of ["greplostVersion", "greplostSha", "bun", "node", "go"]) {
    const value = machine === null ? null : machine[key];
    if (typeof value === "string" && value.length > 0) rows.push({ name: key, value });
  }
  const claudeVersion = agent === null ? null : firstStr(agent.data, ["claudeVersion", "cli.version", "versions.claude"]);
  if (claudeVersion !== null) rows.push({ name: "claude CLI", value: claudeVersion });
  const model = agent === null ? null : firstStr(agent.data, ["model", "cli.model", "versions.model"]);
  if (model !== null) rows.push({ name: "claude model", value: model });

  for (const tool of competitors()) {
    rows.push({ name: `${tool.name} (pinned)`, value: `${tool.version} @ ${tool.commit.slice(0, 7)}` });
  }
  return rows;
}

interface CompetitorEntry {
  name: string;
  version: string;
  commit: string;
  syncMechanism: string | null;
}

/** `bench/competitors.json`, or an empty list when it is missing or unreadable. */
export function competitors(): CompetitorEntry[] {
  try {
    const file = path.join(REPO_ROOT, "bench", "competitors.json");
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { tools?: unknown };
    return arr(parsed.tools).flatMap((entry) => {
      const record = rec(entry);
      const name = record === null ? null : str(record["name"]);
      if (name === null) return [];
      return [{
        name,
        version: str(record?.["version"]) ?? "unknown",
        commit: str(record?.["commit"]) ?? "unknown",
        syncMechanism: str(record?.["syncMechanism"]),
      }];
    });
  } catch {
    return [];
  }
}

export interface CorpusEntry {
  name: string;
  sha: string | null;
  tier: string | null;
  lang: string | null;
}

/**
 * `bench/corpus.json`, keyed by repo name.
 *
 * The pinned record is where a repo's tier and language live; a result payload
 * carries whatever the suite that wrote it happened to include, which for some
 * suites is the name alone. Tech spec 10.1 asks `RESULTS.md` to pin the corpus,
 * and it can only do that from the pinned file (review round 2, minor).
 */
export function corpusIndex(): Map<string, CorpusEntry> {
  const out = new Map<string, CorpusEntry>();
  try {
    const file = path.join(REPO_ROOT, "bench", "corpus.json");
    if (!existsSync(file)) return out;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { repos?: unknown };
    for (const entry of arr(parsed.repos)) {
      const record = rec(entry);
      const name = record === null ? null : str(record["name"]);
      if (name === null) continue;
      out.set(name, {
        name,
        sha: str(record?.["sha"]),
        tier: str(record?.["tier"]),
        lang: str(record?.["lang"]),
      });
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * The scale one suite's row was measured at: repo, tier, and file count.
 *
 * A repo the pinned corpus does not list is a fixture, which is exactly the
 * distinction `scopeTarget` needs to decide whether a tier- or file-scoped
 * target was earned.
 */
export function runFor(repo: string | null, files: number | null): RunTarget | undefined {
  if (repo === null) return files === null ? undefined : { files };
  const pinned = corpusIndex().get(repo);
  const out: RunTarget = { repo, fixture: pinned === undefined };
  if (pinned?.tier != null) out.tier = pinned.tier;
  if (files !== null) out.files = files;
  return out;
}

// ---------------------------------------------------------------------------
// per-suite readers
// ---------------------------------------------------------------------------

/** What a head-to-head run was measured on, for the provenance line. */
export function targetOf(payload: Payload | null): RunTarget | undefined {
  if (payload === null) return undefined;
  const target = rec(payload.data["target"]);
  if (target === null) return undefined;
  const out: RunTarget = {};
  const repo = str(target["repo"]);
  if (repo !== null) out.repo = repo;
  if (typeof target["fixture"] === "boolean") out.fixture = target["fixture"];
  const tier = str(target["tier"]);
  if (tier !== null) out.tier = tier;
  const files = num(target["files"]);
  if (files !== null) out.files = files;
  const commits = num(target["commits"]);
  if (commits !== null) out.commits = commits;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** F1 as a rate in [0, 1], from either field spelling the replay suite may use. */
export function replayF1(payload: Payload): number | null {
  const rate = firstNum(payload.data, ["summary.f1CatchRate", "f1CatchRate", "f1"]);
  if (rate !== null) return rate > 1 ? rate / 100 : rate;
  const caught = firstNum(payload.data, ["summary.driftCaught", "driftCaught"]);
  const total = firstNum(payload.data, ["summary.driftTotal", "driftTotal"]);
  if (caught === null || total === null || total === 0) return null;
  return caught / total;
}

export function replayF2(payload: Payload): number | null {
  const rate = firstNum(payload.data, ["summary.f2Mismatch", "f2Mismatch", "f2"]);
  if (rate !== null) return rate > 1 ? rate / 100 : rate;
  const mismatches = firstNum(payload.data, ["summary.f2Mismatches", "f2Mismatches"]);
  const checks = firstNum(payload.data, ["summary.f2Checks", "f2Checks"]);
  if (mismatches === null || checks === null || checks === 0) return null;
  return mismatches / checks;
}

/** One timed perf scenario, flattened out of whatever shape the payload used. */
export interface Scenario {
  /** `<repo> <scenario>`, or just the scenario when the payload is flat. */
  name: string;
  /** The bare scenario name (`full`, `incremental-1`), for matching P1 to P3. */
  kind: string;
  repo: string | null;
  p50: number | null;
  p95: number | null;
  rss: number | null;
  files: number | null;
  tier: string | null;
}

/**
 * Every timed scenario in a perf payload.
 *
 * The shape the perf suite actually writes is
 * `repos: [{ name, files, tier, scenarios: [{ scenario, ms: { p50, p95 }, peakRssBytes }] }]`
 * — an array of repos, each holding an array of scenarios whose percentiles are
 * nested under `ms`. This reader was first written against a flat
 * `scenarios: { name: { p50, p95, rss } }` object, which matched nothing, so
 * P1 to P3 rendered `not run` beside a payload that had the numbers all along.
 * Both shapes are read now, plus a `repos` object keyed by name, because a
 * report that silently says "not run" about data it was handed is the worst of
 * the three failure modes.
 */
export function scenariosOf(payload: Payload): Scenario[] {
  const found: Scenario[] = [];
  const seen = new Set<string>();

  const push = (repo: string | null, files: number | null, tier: string | null, kind: string, entry: Record<string, unknown>): void => {
    const ms = rec(entry["ms"]);
    const p50 = num(entry["p50"]) ?? (ms === null ? null : num(ms["p50"]));
    const p95 = num(entry["p95"]) ?? (ms === null ? null : num(ms["p95"]));
    if (p50 === null && p95 === null) return;
    const name = repo === null ? kind : `${repo} ${kind}`;
    if (seen.has(name)) return;
    seen.add(name);
    found.push({
      name,
      kind,
      repo,
      p50,
      p95,
      rss:
        num(entry["peakRssBytes"]) ??
        num(entry["rss"]) ??
        num(entry["maxRSS"]) ??
        num(entry["peakRss"]) ??
        num(rec(entry["detail"])?.["rssBytes"]),
      files,
      tier,
    });
  };

  /** A `scenarios` value that is either an array of records or an object of them. */
  const consider = (repo: string | null, files: number | null, tier: string | null, container: unknown): void => {
    if (Array.isArray(container)) {
      for (const item of container) {
        const entry = rec(item);
        if (entry === null) continue;
        push(repo, files, tier, str(entry["scenario"]) ?? str(entry["name"]) ?? "scenario", entry);
      }
      return;
    }
    const record = rec(container);
    if (record === null) return;
    for (const key of Object.keys(record).sort()) {
      const entry = rec(record[key]);
      if (entry !== null) push(repo, files, tier, key, entry);
    }
  };

  const repos = payload.data["repos"];
  if (Array.isArray(repos)) {
    for (const item of repos) {
      const entry = rec(item);
      if (entry === null) continue;
      consider(str(entry["name"]), num(entry["files"]), str(entry["tier"]), entry["scenarios"] ?? entry);
    }
  } else {
    const record = rec(repos);
    if (record !== null) {
      for (const name of Object.keys(record).sort()) {
        const entry = rec(record[name]);
        if (entry === null) continue;
        consider(name, num(entry["files"]), str(entry["tier"]), entry["scenarios"] ?? entry);
      }
    }
  }

  if (found.length === 0) consider(null, null, null, payload.data["scenarios"]);
  return found;
}

/** One condition's aggregated agent numbers. */
export interface ConditionStats {
  accuracy: number | null;
  tokens: number | null;
  toolCalls: number | null;
  wallClock: number | null;
  cost: number | null;
}

/** `category -> condition -> stats`, from whichever container the agent suite used. */
export function agentCategories(payload: Payload): Map<string, Map<string, ConditionStats>> {
  const out = new Map<string, Map<string, ConditionStats>>();
  const container =
    rec(payload.data["categories"]) ?? rec(payload.data["byCategory"]) ?? rec(payload.data["results"]) ?? null;
  if (container === null) return out;
  for (const category of Object.keys(container).sort()) {
    const conditions = rec(container[category]);
    if (conditions === null) continue;
    const inner = new Map<string, ConditionStats>();
    for (const condition of Object.keys(conditions).sort()) {
      const stats = rec(conditions[condition]);
      if (stats === null) continue;
      const read = (...names: string[]): number | null => {
        for (const name of names) {
          const direct = num(stats[name]);
          if (direct !== null) return direct;
          // `{ mean, median, std }` blocks: the spec reports variance, so a
          // scalar may be one level down. Median first: it is what A1 gates on.
          const nested = rec(stats[name]);
          if (nested !== null) {
            const value = num(nested["median"]) ?? num(nested["mean"]) ?? num(nested["p50"]);
            if (value !== null) return value;
          }
        }
        return null;
      };
      inner.set(condition, {
        accuracy: read("accuracy", "acc", "score"),
        tokens: read("tokens", "totalTokens"),
        toolCalls: read("toolCalls", "tool_calls", "calls"),
        wallClock: read("wallClock", "wallClockSeconds", "seconds"),
        cost: read("cost", "costUsd", "total_cost_usd"),
      });
    }
    if (inner.size > 0) out.set(category, inner);
  }
  return out;
}
