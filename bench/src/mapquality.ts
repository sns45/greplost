/**
 * Map quality gates (tech spec 3, 10.8; bench spec 1.5.4):
 *
 *   M1  INDEX.md token budget                         <= 3000 tokens (js-tiktoken cl100k_base)
 *   M2  diagram node cap after auto-split              no fence above `config.diagram.maxNodes` (default 25)
 *   -   Mermaid render check                           every fence parses (`./mermaid-check.ts`)
 *
 * `run` walks every `.md` file under an artifact dir (`--dir`, default `.greplost` at the
 * repo root), extracts every fenced ```mermaid block, counts node definitions per fence
 * (lines matching `^\s+\S+\["`, i.e. `  id["label"]`; edge lines never contain `[` because
 * edge labels use `|...|`, not brackets — see `packages/render/src/mermaid.ts`), and parses
 * every fence with `checkMermaid`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import { compareStrings, stableStringify } from "@greplost/core/schema";
import { checkMermaid, type Checker } from "./mermaid-check.ts";
import { machineProfile } from "./machine.ts";
import { gitSha7, todayIso, writeResult } from "./results-io.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const SUITE = "mapquality";

/** Section 3: M1 target. */
export const M1_TOKEN_BUDGET = 3000;
/** Appendix B default; overridden by `config.json`'s `diagram.maxNodes`. */
export const DEFAULT_MAX_NODES = 25;

/** A node definition line (`  id["label"]`). Edge lines use `-->`/`|label|`, never `[`. */
const NODE_LINE_RE = /^\s+\S+\["/;
/** One fenced ```mermaid block; non-greedy so back-to-back fences are captured separately. */
const MERMAID_FENCE_RE = /```mermaid\r?\n([\s\S]*?)```/g;

interface Options {
  dir: string;
  gate: boolean;
  json: boolean;
}

export interface FenceReport {
  /** Path of the containing file, relative to `--dir`, posix separators. */
  file: string;
  /** 1-based index of this fence within its file. */
  index: number;
  nodeCount: number;
  ok: boolean;
  error?: string;
  checker: Checker;
}

export async function run(args: string[]): Promise<number> {
  const options = parseArgs(args);
  try {
    return await execute(options);
  } catch (err) {
    // Nothing below the argument parser may escape: `run` always returns an exit code, and
    // the last stdout line always follows the suite's convention.
    console.error(`${SUITE}: ${(err as Error).message}`);
    console.log(`${SUITE}: GATE FAIL (error)`);
    return 1;
  }
}

function parseArgs(args: string[]): Options {
  const options: Options = { dir: path.join(REPO_ROOT, ".greplost"), gate: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Unknown flags are ignored on purpose: `bench all` forwards one argument list to
    // every suite.
    if (arg === "--dir") options.dir = path.resolve(args[++i] ?? options.dir);
    else if (arg === "--gate") options.gate = true;
    else if (arg === "--json") options.json = true;
  }
  return options;
}

async function execute(options: Options): Promise<number> {
  if (!existsSync(options.dir) || !statSync(options.dir).isDirectory()) {
    console.error(`${SUITE}: artifact dir not found: ${options.dir}`);
    console.log(`${SUITE}: GATE FAIL (dir)`);
    return 2;
  }

  const fences = await collectFences(options.dir);

  const indexPath = path.join(options.dir, "INDEX.md");
  const tokens = existsSync(indexPath) ? countTokens(readFileSync(indexPath, "utf8")) : null;

  const maxNodes = readMaxNodes(options.dir);
  const maxNodeCount = fences.reduce((max, fence) => Math.max(max, fence.nodeCount), 0);
  const failures = fences.filter((fence) => !fence.ok);
  const checker: Checker = fences[0]?.checker ?? (await checkMermaid('graph LR\n  a["a"]\n')).checker;

  const missed: string[] = [];
  if (tokens === null || tokens > M1_TOKEN_BUDGET) missed.push("M1");
  if (maxNodeCount > maxNodes) missed.push("M2");
  if (failures.length > 0) missed.push("parse");

  const relDir = path.relative(REPO_ROOT, options.dir) || ".";
  const payload = {
    // Set explicitly (rather than left to `writeResult` to fill in) so the `--json`
    // output printed below is the same record that lands on disk, suite/date/sha included.
    suite: SUITE,
    date: todayIso(),
    greplostSha: gitSha7(),
    dir: relDir,
    machine: machineProfile(),
    corpus: [{ dir: relDir }],
    tokens: { indexMd: tokens, budget: M1_TOKEN_BUDGET, encoding: "cl100k_base" },
    diagrams: {
      fences: fences.length,
      maxNodes,
      maxNodeCount,
      byFence: fences.map(({ file, index, nodeCount, ok, error, checker: fenceChecker }) => ({
        file,
        index,
        nodeCount,
        ok,
        error,
        checker: fenceChecker,
      })),
    },
    checker,
    gate: options.gate ? { passed: missed.length === 0, missed } : null,
  };

  if (options.json) {
    console.log(stableStringify(payload, 2));
  } else {
    printTable({ dir: relDir, tokens, fenceCount: fences.length, maxNodeCount, maxNodes, failures, checker });
  }

  writeResult(SUITE, payload);

  if (!options.gate) return 0;
  if (missed.length > 0) {
    console.log(`${SUITE}: GATE FAIL (${missed.join(",")})`);
    return 1;
  }
  console.log(`${SUITE}: GATE PASS`);
  return 0;
}

// ---------------------------------------------------------------------------
// walking, extraction, counting
// ---------------------------------------------------------------------------

async function collectFences(dir: string): Promise<FenceReport[]> {
  const fences: FenceReport[] = [];
  for (const file of walkMarkdown(dir)) {
    const text = readFileSync(path.join(dir, file), "utf8");
    const bodies = [...text.matchAll(MERMAID_FENCE_RE)].map((match) => match[1] ?? "");
    for (let i = 0; i < bodies.length; i++) {
      const body = bodies[i] ?? "";
      const result = await checkMermaid(body);
      fences.push({
        file,
        index: i + 1,
        nodeCount: countNodes(body),
        ok: result.ok,
        checker: result.checker,
        ...(result.error !== undefined ? { error: result.error } : {}),
      });
    }
  }
  return fences;
}

/** Every `.md` file under `dir`, recursively, as posix paths relative to `dir`, sorted. */
export function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = path.join(dir, rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(entryRel);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(entryRel);
    }
  };
  walk("");
  return out.sort(compareStrings);
}

export function countNodes(fenceBody: string): number {
  return fenceBody.split("\n").filter((line) => NODE_LINE_RE.test(line)).length;
}

function readMaxNodes(dir: string): number {
  const configPath = path.join(dir, "config.json");
  if (!existsSync(configPath)) return DEFAULT_MAX_NODES;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { diagram?: { maxNodes?: unknown } };
    const value = parsed.diagram?.maxNodes;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_NODES;
  } catch {
    return DEFAULT_MAX_NODES;
  }
}

let encoder: Tiktoken | undefined;
export function countTokens(text: string): number {
  encoder ??= getEncoding("cl100k_base");
  return encoder.encode(text).length;
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

function printTable(info: {
  dir: string;
  tokens: number | null;
  fenceCount: number;
  maxNodeCount: number;
  maxNodes: number;
  failures: FenceReport[];
  checker: Checker;
}): void {
  console.log(`${SUITE}: ${info.dir}`);
  console.log(`  INDEX.md tokens (cl100k_base): ${info.tokens === null ? "missing" : info.tokens} (<= ${M1_TOKEN_BUDGET})`);
  console.log(`  fences: ${info.fenceCount}`);
  console.log(`  max nodes per fence: ${info.maxNodeCount} (<= ${info.maxNodes})`);
  console.log(`  parse failures: ${info.failures.length}`);
  console.log(`  checker: ${info.checker}`);
  for (const failure of info.failures) {
    console.log(`  FAIL ${failure.file} fence ${failure.index}: ${failure.error ?? "unknown error"}`);
  }
}
