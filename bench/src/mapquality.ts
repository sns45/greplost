/**
 * Map quality gates (tech spec 3, 10.8; bench spec 1.5.4):
 *
 *   M1  INDEX.md token budget                         <= 3000 tokens (js-tiktoken cl100k_base)
 *   M2  diagram node cap after auto-split              no fence above `config.diagram.maxNodes` (default 25)
 *   -   Mermaid render check                           every fence parses (`./mermaid-check.ts`)
 *
 * `run` walks every `.md` file under an artifact dir (`--dir <path>`, or `--repo <name>`
 * for `bench/.corpus/<name>/.greplost`, or `--fixture` for the golden render dir; default
 * `.greplost` at the repo root), extracts every fenced ```mermaid block, counts node
 * definitions per fence (lines matching `^\s+\S+\["`, i.e. `  id["label"]`; edge lines
 * never contain `[` because edge labels use `|...|`, not brackets — see
 * `packages/render/src/mermaid.ts`), and parses every fence with `checkMermaid`.
 *
 * `--dry-run` prints the table shape and stops: no fence is parsed, the artifact dir need
 * not exist, and — the point of the flag — no result file is written. `bench all
 * --dry-run` runs every suite, so a dry run that wrote a payload here would make the
 * shape-check the published M1 and M2.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import { compareStrings, stableStringify } from "@greplost/core/schema";
import { checkMermaid, type Checker } from "./mermaid-check.ts";
import { loadCorpus, repoDir } from "./corpus.ts";
import { machineProfile } from "./machine.ts";
import { gitSha7, todayIso, writeResult } from "./results-io.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const SUITE = "mapquality";
/** `--fixture`: the pre-rendered artifact dir used by tests and cold-start checks (bench spec "Shared conventions"). */
const GOLDEN_FIXTURE_DIR = path.join(REPO_ROOT, "packages", "render", "test", "golden", "tiny-ts");

/** Section 3: M1 target. */
export const M1_TOKEN_BUDGET = 3000;
/** Appendix B default; overridden by `config.json`'s `diagram.maxNodes`. */
export const DEFAULT_MAX_NODES = 25;

/** A node definition line (`  id["label"]`). Edge lines use `-->`/`|label|`, never `[`. */
const NODE_LINE_RE = /^\s+\S+\["/;
/** What an unmeasured cell prints. One spelling, matching `results-md.ts`. */
const NOT_RUN = "not run";
/**
 * One fenced ```mermaid block. Non-greedy so back-to-back fences are captured separately;
 * this relies on fences never being nested (a mermaid fence's body never itself contains a
 * ``` line), which holds for every artifact `packages/render` emits — its Mermaid fences
 * hold only diagram syntax (render spec "Documents"), never markdown or other code.
 */
const MERMAID_FENCE_RE = /```mermaid\r?\n([\s\S]*?)```/g;

interface Options {
  /** Explicit `--dir <path>`, if given; wins over `--repo` and `--fixture`. */
  dirArg: string | undefined;
  /** `--repo <name>`: resolves to `bench/.corpus/<name>/.greplost`. */
  repo: string | undefined;
  /** `--fixture`: the golden render dir. */
  fixture: boolean;
  gate: boolean;
  json: boolean;
  /** `--dry-run`: print the shape, write nothing, measure nothing (bench spec conventions). */
  dryRun: boolean;
}

interface Target {
  dir: string;
  /** Shared results-payload shape (bench spec "Shared conventions"): `[]` for an arbitrary
   *  directory (plain `--dir` or `--fixture`), or the one pinned repo for `--repo <name>`. */
  corpus: Array<{ name: string; sha: string; tier: string; lang: string }>;
  /**
   * What the map was made of, so M1's target keeps its scale.
   *
   * Section 3 words M1 as a budget "at 10k files", and `scopeTarget` (`results-md.ts`)
   * qualifies a target written against a file count with the scale actually measured —
   * that is why the P rows read "(measured on anyq, tier S, 148 files)". Without the repo
   * and the file count on the payload, M1 printed a 10k-file budget beside a number taken
   * on a 120-file map and invited the reader to take the one for the other.
   */
  repo: string;
  /** True when the dir is a fixture render rather than a real repo's map. */
  fixture: boolean;
  /** Tier of the pinned corpus repo, when the target is one. */
  tier: string | undefined;
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
    // the last stdout line follows the suite's convention only when `--gate` was passed.
    return reportFailure(options, `${SUITE}: error: ${(err as Error).message}`, "error", 1);
  }
}

/**
 * Prints the failure to stderr and, only when `--gate` was passed, the
 * `GATE FAIL (<reason>)` line the bench spec's shared conventions promise as the last
 * stdout line. Without `--gate` nothing is printed on stdout: a non-gated run that hits an
 * error is not a "gate" event, so it must not emit a gate-shaped line.
 */
function reportFailure(options: Options, message: string, gateReason: string, code: number): number {
  console.error(message);
  if (options.gate) console.log(`${SUITE}: GATE FAIL (${gateReason})`);
  return code;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    dirArg: undefined,
    repo: undefined,
    fixture: false,
    gate: false,
    json: false,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Unknown flags are ignored on purpose: `bench all` forwards one argument list to
    // every suite.
    if (arg === "--dir") options.dirArg = args[++i];
    else if (arg === "--repo") options.repo = args[++i];
    else if (arg === "--fixture") options.fixture = true;
    else if (arg === "--gate") options.gate = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--dry-run") options.dryRun = true;
  }
  return options;
}

/**
 * `--dir` wins outright (an explicit path is exactly what was asked for); otherwise
 * `--repo <name>` resolves to that corpus repo's artifact dir (`bench/.corpus/<name>/
 * .greplost`, which the driver initialises before a real `--repo` run) and carries its
 * pinned identity into the results payload's `corpus` field; otherwise `--fixture` points
 * at the golden render dir; otherwise the default is `.greplost` at the repo root.
 */
export function resolveTarget(options: Options): Target {
  if (options.dirArg !== undefined) {
    const dir = path.resolve(options.dirArg);
    // An arbitrary directory names itself by the tree it is the map of, which is
    // its parent — `<repo>/.greplost` -> `<repo>`.
    return { dir, corpus: [], repo: path.basename(path.dirname(dir)), fixture: false, tier: undefined };
  }
  if (options.repo !== undefined) {
    const entry = loadCorpus().repos.find((repo) => repo.name === options.repo);
    if (!entry) throw new Error(`unknown repo "${options.repo}" in bench/corpus.json`);
    return {
      dir: path.join(repoDir(entry.name), ".greplost"),
      corpus: [{ name: entry.name, sha: entry.sha, tier: entry.tier, lang: entry.lang }],
      repo: entry.name,
      fixture: false,
      tier: entry.tier,
    };
  }
  if (options.fixture) {
    return { dir: GOLDEN_FIXTURE_DIR, corpus: [], repo: "tiny-ts", fixture: true, tier: undefined };
  }
  return {
    dir: path.join(REPO_ROOT, ".greplost"),
    corpus: [],
    repo: ownRepoName(),
    fixture: false,
    tier: undefined,
  };
}

/**
 * What to call the repository whose own `.greplost` is being measured.
 *
 * Not `path.basename(REPO_ROOT)`: this file resolves its root from its own path, so
 * inside a git worktree that basename is the worktree's throwaway name
 * (`agent-a93f0ee7ee34ba4dc`) and the published payload would say the map was measured on
 * a repository nobody has heard of. `--git-common-dir` points at the *main* checkout's
 * `.git` from any worktree, so its parent is the project directory in both cases.
 */
export function ownRepoName(): string {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const name = path.basename(path.dirname(common));
    if (name !== "" && name !== ".") return name;
  } catch {
    // Not a git checkout, or no git: the directory name is all there is.
  }
  return path.basename(REPO_ROOT);
}

/**
 * How many files the map was built from, read out of the artifact dir's own
 * `manifest.json` (`files` is keyed by repo-relative path).
 *
 * Null when the dir carries no readable manifest: an unknown scale is reported as
 * unknown, never as zero, because "0 files" beside a token count would read as a
 * measurement of an empty repo.
 */
export function indexedFileCount(dir: string): number | null {
  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { files?: unknown };
    const files = parsed.files;
    return files !== null && typeof files === "object" ? Object.keys(files as object).length : null;
  } catch {
    return null;
  }
}

async function execute(options: Options): Promise<number> {
  const target = resolveTarget(options);
  const relDir = path.relative(REPO_ROOT, target.dir) || ".";

  // `--dry-run` produces the output shape and stops, before the dir is required to
  // exist, before a fence is parsed and — the point of the flag — before anything is
  // written. This suite used to fall straight through to `writeResult`, so
  // `bun run bench:all --dry-run` left a real `mapquality-*.json` in `bench/results/`
  // and that payload became the published M1 and M2 (review round 3, critical 1).
  if (options.dryRun) {
    printTable({
      dir: relDir,
      tokens: null,
      fenceCount: null,
      maxNodeCount: null,
      maxNodes: null,
      failures: [],
      checker: null,
    });
    console.log(`${SUITE}: dry-run ok`);
    return 0;
  }

  if (!existsSync(target.dir) || !statSync(target.dir).isDirectory()) {
    return reportFailure(options, `${SUITE}: error: artifact dir not found: ${target.dir}`, "dir", 2);
  }

  const fences = await collectFences(target.dir);

  const indexPath = path.join(target.dir, "INDEX.md");
  const tokens = existsSync(indexPath) ? countTokens(readFileSync(indexPath, "utf8")) : null;

  const maxNodes = readMaxNodes(target.dir);
  const maxNodeCount = fences.reduce((max, fence) => Math.max(max, fence.nodeCount), 0);
  const failures = fences.filter((fence) => !fence.ok);
  const checker: Checker = fences[0]?.checker ?? (await checkMermaid('graph LR\n  a["a"]\n')).checker;

  const missed: string[] = [];
  if (tokens === null || tokens > M1_TOKEN_BUDGET) missed.push("M1");
  if (maxNodeCount > maxNodes) missed.push("M2");
  if (failures.length > 0) missed.push("parse");

  const files = indexedFileCount(target.dir);
  const payload = {
    // Set explicitly (rather than left to `writeResult` to fill in) so the `--json`
    // output printed below is the same record that lands on disk, suite/date/sha included.
    suite: SUITE,
    date: todayIso(),
    greplostSha: gitSha7(),
    // `repo` and `files` are the scale M1's budget is written against; `report-evals.ts`
    // turns them into the `RunTarget` that qualifies the target column.
    target: {
      dir: relDir,
      repo: target.repo,
      files,
      ...(target.fixture ? { fixture: true } : {}),
      ...(target.tier === undefined ? {} : { tier: target.tier }),
    },
    machine: machineProfile(),
    corpus: target.corpus,
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
    printTable({
      dir: relDir,
      tokens: tokens ?? "missing",
      fenceCount: fences.length,
      maxNodeCount,
      maxNodes,
      failures,
      checker,
    });
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
  } catch (err) {
    console.error(
      `${SUITE}: warning: could not parse ${configPath} (${(err as Error).message}); ` +
        `using the default node cap ${DEFAULT_MAX_NODES}`,
    );
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

/**
 * The M1/M2 table.
 *
 * `null` in a numeric field means *not measured* and prints `not run`, which is the
 * whole of what `--dry-run` has to say. A measured-but-absent INDEX.md is the string
 * `"missing"` instead: a file that is not there and a file nobody looked at are
 * different findings, and only one of them is a gate miss.
 */
function printTable(info: {
  dir: string;
  tokens: number | "missing" | null;
  fenceCount: number | null;
  maxNodeCount: number | null;
  maxNodes: number | null;
  failures: FenceReport[];
  checker: Checker | null;
}): void {
  const show = (value: number | string | null): string => (value === null ? NOT_RUN : String(value));
  console.log(`${SUITE}: ${info.dir}`);
  console.log(`  INDEX.md tokens (cl100k_base): ${show(info.tokens)} (<= ${M1_TOKEN_BUDGET})`);
  console.log(`  fences: ${show(info.fenceCount)}`);
  console.log(`  max nodes per fence: ${show(info.maxNodeCount)} (<= ${show(info.maxNodes)})`);
  console.log(`  parse failures: ${info.checker === null ? NOT_RUN : info.failures.length}`);
  console.log(`  checker: ${show(info.checker)}`);
  for (const failure of info.failures) {
    console.log(`  FAIL ${failure.file} fence ${failure.index}: ${failure.error ?? "unknown error"}`);
  }
}
