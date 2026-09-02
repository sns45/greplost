/**
 * `bench screenshots`: regenerate the section 11 evidence into `docs/assets/`
 * (tech spec 11; bench leaf 1.5.7).
 *
 * Every visual in the README is produced by a command in this file, so a
 * screenshot cannot drift from the code it claims to show. The captures need
 * external tools — `vhs` for terminal recordings, `freeze` for code
 * screenshots, playwright's chromium for rendered pages — and those tools are
 * not always installed.
 *
 * The rule when one is missing: **skip that capture, print the exact command
 * that would install it, and keep going.** A screenshot run that aborts because
 * `freeze` is absent silently stops regenerating the nine captures that do not
 * need it, and the README then shows stale images with no warning. So this suite
 * never fails as a whole; it reports.
 *
 * Captures 7, 8 and 9 (the benchmark charts and the hero staleness curve) are
 * not here: they are rendered by `report.ts` from committed result payloads,
 * which is the only way a chart can carry numbers a reader can check.
 *
 *   bun bench/src/cli.ts screenshots --check
 *   bun bench/src/cli.ts screenshots
 *   bun bench/src/cli.ts screenshots --only init --assets /tmp/shots
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const SUITE = "screenshots";
const ASSETS_DIR = path.join(REPO_ROOT, "docs", "assets");
const TAPES_DIR = path.join(REPO_ROOT, "docs", "tapes");
/** No capture may hold the suite for longer than this. */
const CAPTURE_TIMEOUT_MS = 900_000;

// ---------------------------------------------------------------------------
// tool detection
// ---------------------------------------------------------------------------

export type ToolId = "vhs" | "freeze" | "playwright";

export interface ToolStatus {
  /** How the tool is named in the `--check` listing. */
  name: string;
  id: ToolId;
  available: boolean;
  /** What the tool reports about itself, when it is present. */
  version: string | null;
  /** The exact command that installs it. Never empty. */
  install: string;
  /** Present but unusable (playwright installed, its browser binary is not). */
  note: string | null;
}

function onPath(binary: string): string | null {
  const which = spawnSync("sh", ["-c", `command -v ${JSON.stringify(binary)}`], { encoding: "utf8" });
  const found = which.status === 0 ? which.stdout.trim() : "";
  return found.length > 0 ? found : null;
}

function versionOf(binary: string): string | null {
  const ran = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 30_000 });
  const line = (ran.stdout ?? "").split("\n")[0]?.trim() ?? "";
  return ran.status === 0 && line.length > 0 ? line : null;
}

/**
 * Playwright is two things: the npm package (a bench devDependency) and the
 * browser binary it downloads separately. Both have to be there, and the second
 * one is the one that is usually missing, so they are reported apart.
 */
function playwrightStatus(): ToolStatus {
  const install = "bunx playwright install chromium";
  let executable: string | null = null;
  let note: string | null = null;
  try {
    const playwright = createRequire(import.meta.url)("playwright") as { chromium: { executablePath(): string } };
    executable = playwright.chromium.executablePath();
  } catch (err) {
    return {
      name: "playwright (chromium)",
      id: "playwright",
      available: false,
      version: null,
      install: `bun install && ${install}`,
      note: `the playwright package did not load: ${(err as Error).message}`,
    };
  }
  const available = executable !== null && executable.length > 0 && existsSync(executable);
  if (!available) note = `the playwright package is installed but its chromium build is not at ${executable ?? "any known path"}`;
  return {
    name: "playwright (chromium)",
    id: "playwright",
    available,
    version: available ? path.basename(path.dirname(path.dirname(executable ?? ""))) : null,
    install,
    note,
  };
}

/** Every section 11 tool and whether this machine has it. Never throws. */
export function checkTools(): ToolStatus[] {
  const vhs = onPath("vhs");
  const freeze = onPath("freeze");
  return [
    {
      name: "vhs",
      id: "vhs",
      available: vhs !== null,
      version: vhs === null ? null : versionOf("vhs"),
      install: "brew install vhs",
      note: null,
    },
    {
      name: "freeze",
      id: "freeze",
      available: freeze !== null,
      version: freeze === null ? null : versionOf("freeze"),
      install: "brew install freeze",
      note: null,
    },
    playwrightStatus(),
  ];
}

// ---------------------------------------------------------------------------
// captures
// ---------------------------------------------------------------------------

interface CaptureContext {
  assets: string;
  tools: Map<ToolId, ToolStatus>;
  /** True when the caller accepted captures that spend model tokens. */
  paid: boolean;
}

interface CaptureResult {
  /** Files written, absolute. */
  written: string[];
  /** Why nothing was written, when nothing was. */
  skipped: string | null;
}

export interface Capture {
  /** The number in the tech spec 11 table. */
  id: number;
  /** A stable slug `--only` matches on. */
  name: string;
  description: string;
  needs: ToolId[];
  /** True when running it consumes model tokens; skipped unless `--paid`. */
  paid: boolean;
  perform(ctx: CaptureContext): CaptureResult;
}

function runCommand(binary: string, args: string[], cwd: string): { ok: boolean; output: string } {
  const ran = spawnSync(binary, args, { cwd, encoding: "utf8", timeout: CAPTURE_TIMEOUT_MS });
  return {
    ok: ran.error === undefined && ran.status === 0,
    output: `${ran.stdout ?? ""}${ran.stderr ?? (ran.error === undefined ? "" : ran.error.message)}`.trim(),
  };
}

/** Run one tape and collect the files its `Output` directives named. */
function runTape(ctx: CaptureContext, tape: string): CaptureResult {
  const file = path.join(TAPES_DIR, tape);
  if (!existsSync(file)) return { written: [], skipped: `docs/tapes/${tape} is missing` };
  const outputs = [...readFileSync(file, "utf8").matchAll(/^\s*Output\s+(\S+)/gm)].map((match) => match[1] ?? "");
  const ran = runCommand("vhs", [path.join("docs", "tapes", tape)], REPO_ROOT);
  if (!ran.ok) return { written: [], skipped: `vhs failed on ${tape}: ${lastLine(ran.output)}` };
  return { written: collect(ctx, outputs), skipped: null };
}

/**
 * A `freeze` code screenshot of a command's own output.
 *
 * The captured text goes to a temp file, not into `docs/assets/`: that directory
 * holds the images the README embeds, and a stray `.txt` beside each PNG is
 * clutter a future reader has to decide about. `env` lets a capture keep a
 * command's side effects out of the working tree.
 */
function freezeCommand(
  ctx: CaptureContext,
  out: string,
  command: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): CaptureResult {
  const target = path.join(ctx.assets, out);
  const ran = spawnSync(command[0] ?? "", command.slice(1), {
    cwd,
    encoding: "utf8",
    timeout: CAPTURE_TIMEOUT_MS,
    ...(env === undefined ? {} : { env }),
  });
  const text = `$ ${command.join(" ")}\n${ran.stdout ?? ""}${ran.stderr ?? ""}`;
  const scratch = path.join(mkdtempSync(path.join(tmpdir(), "greplost-freeze-")), `${path.basename(out, ".png")}.txt`);
  writeFileSync(scratch, text);
  mkdirSync(ctx.assets, { recursive: true });
  const frozen = runCommand("freeze", ["--output", target, "--language", "ansi", scratch], REPO_ROOT);
  if (!frozen.ok) return { written: [], skipped: `freeze failed: ${lastLine(frozen.output)}` };
  return { written: [target], skipped: null };
}

/** Move tape outputs into `--assets` when it is not the default directory. */
function collect(ctx: CaptureContext, outputs: readonly string[]): string[] {
  const written: string[] = [];
  for (const rel of outputs) {
    const source = path.isAbsolute(rel) ? rel : path.join(REPO_ROOT, rel);
    if (!existsSync(source)) continue;
    const destination = path.join(ctx.assets, path.basename(source));
    if (path.resolve(source) !== path.resolve(destination)) {
      mkdirSync(ctx.assets, { recursive: true });
      copyFileSync(source, destination);
    }
    written.push(destination);
  }
  return written;
}

function lastLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  return lines[lines.length - 1] ?? "no output";
}

/** A corpus checkout the terminal captures can run inside, or null. */
function corpusRepo(name: string): string | null {
  const dir = path.join(REPO_ROOT, "bench", ".corpus", name);
  return existsSync(dir) ? dir : null;
}

export const CAPTURES: Capture[] = [
  {
    id: 1,
    name: "init",
    description: "`greplost init` on hono with timing output (GIF plus final-frame PNG)",
    needs: ["vhs"],
    paid: false,
    perform: (ctx) => {
      if (corpusRepo("hono") === null) {
        return { written: [], skipped: "bench/.corpus/hono is not checked out (`bun bench/src/cli.ts corpus setup --tier M`)" };
      }
      return runTape(ctx, "init.tape");
    },
  },
  {
    id: 2,
    name: "map-on-github",
    description: "a package MAP.md rendered on GitHub with Mermaid, at a pinned commit",
    needs: ["playwright"],
    paid: false,
    perform: () => ({
      written: [],
      skipped:
        "needs a public commit of a repo with a committed `.greplost/` to point at; greplost has not been " +
        "published, so there is no pinned URL to screenshot yet",
    }),
  },
  {
    id: 3,
    name: "pr-diff",
    description: "a PR diff showing a new architecture edge in `repo/MAP.md`",
    needs: ["playwright"],
    paid: false,
    perform: () => ({
      written: [],
      skipped: "needs the fixture PR in the demo repo, which does not exist yet",
    }),
  },
  {
    id: 4,
    name: "verify-ci",
    description: "`greplost verify` failing in CI (red check) then passing",
    needs: ["playwright"],
    paid: false,
    perform: () => ({
      written: [],
      skipped: "needs the fixture PR's checks tab in the demo repo, which does not exist yet",
    }),
  },
  {
    id: 5,
    name: "side-by-side",
    description: "baseline session grepping vs greplost session answering, composed into one image",
    needs: ["vhs"],
    paid: true,
    perform: (ctx) => {
      const left = runTape(ctx, "side-by-side-baseline.tape");
      if (left.skipped !== null) return left;
      const right = runTape(ctx, "side-by-side-greplost.tape");
      if (right.skipped !== null) return right;
      const composed = compose(ctx, [left.written, right.written].map((files) => files.find((file) => file.endsWith(".png"))));
      return { written: [...left.written, ...right.written, ...(composed === null ? [] : [composed])], skipped: null };
    },
  },
  {
    id: 6,
    name: "query-impact",
    description: "`greplost impact` and `query --json` output",
    needs: ["freeze"],
    paid: false,
    perform: (ctx) => {
      const root = corpusRepo("hono") ?? path.join(REPO_ROOT, "fixtures", "tiny-ts");
      const cli = path.join(REPO_ROOT, "packages", "cli", "src", "main.ts");
      const first = freezeCommand(ctx, "query-json.png", ["bun", cli, "query", "retry", "--json", "--root", root], REPO_ROOT);
      const second = freezeCommand(ctx, "impact.png", ["bun", cli, "impact", "packages/core/src/retry.ts", "--root", root], REPO_ROOT);
      const skipped = first.skipped ?? second.skipped;
      return { written: [...first.written, ...second.written], ...(skipped === null ? { skipped: null } : { skipped }) };
    },
  },
  {
    id: 10,
    name: "three-artifacts",
    description: "the same one-line change in three artifacts, side by side (X5)",
    needs: ["freeze"],
    paid: false,
    perform: () => ({
      written: [],
      skipped:
        "needs a head-to-head X5 run whose competitor artifacts are on disk " +
        "(`bun bench/src/cli.ts headtohead --fixture --metrics X5`), and every competitor it composes must " +
        "have been installed for that run",
    }),
  },
  {
    id: 11,
    name: "reproducibility",
    description: "`diff -r` of two builds per tool with byte counts (X4)",
    needs: ["freeze"],
    paid: false,
    perform: (ctx) => {
      const root = path.join(REPO_ROOT, "fixtures", "tiny-ts");
      // Redirected away from `bench/results/`: capturing a screenshot must not
      // add a committed benchmark result as a side effect.
      const results = mkdtempSync(path.join(tmpdir(), "greplost-shot-results-"));
      return freezeCommand(
        ctx,
        "reproducibility.png",
        ["bun", path.join(REPO_ROOT, "bench", "src", "cli.ts"), "headtohead", "--fixture", "--metrics", "X4"],
        root,
        { ...process.env, GREPLOST_BENCH_RESULTS_DIR: results, NODE_ENV: "test" },
      );
    },
  },
  {
    id: 12,
    name: "head-to-head-table",
    description: "the X1 to X10 table with its win/loss/tie column",
    needs: [],
    paid: false,
    perform: () => ({
      written: [],
      skipped: "rendered straight from bench/RESULTS.md by `bench report`; there is nothing to capture",
    }),
  },
];

/**
 * Two PNGs side by side, through an SVG that references them and the same
 * rasteriser the charts use. Returns null when it cannot be done, which is not
 * an error: both halves have already been written on their own.
 */
function compose(ctx: CaptureContext, pngs: (string | undefined)[]): string | null {
  const files = pngs.filter((file): file is string => file !== undefined && existsSync(file));
  if (files.length < 2) return null;
  try {
    const { Resvg } = createRequire(import.meta.url)("@resvg/resvg-js") as {
      Resvg: new (svg: string) => { render(): { asPng(): Buffer } };
    };
    // Sized from the files' own bytes is impossible without decoding them, so a
    // fixed half-width is used and each image is fitted into it.
    const half = 900;
    const height = 560;
    const parts = files
      .slice(0, 2)
      .map((file, index) => {
        const data = readFileSync(file).toString("base64");
        return `<image x="${index * half}" y="0" width="${half}" height="${height}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${data}"/>`;
      })
      .join("\n");
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `width="${half * 2}" height="${height}" viewBox="0 0 ${half * 2} ${height}">\n` +
      `<rect x="0" y="0" width="${half * 2}" height="${height}" fill="#ffffff"/>\n${parts}\n</svg>\n`;
    const out = path.join(ctx.assets, "side-by-side.png");
    mkdirSync(ctx.assets, { recursive: true });
    writeFileSync(out, new Resvg(svg).render().asPng());
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

interface Options {
  check: boolean;
  list: boolean;
  only: string | undefined;
  assets: string;
  paid: boolean;
}

function parseArgs(args: string[]): Options {
  const options: Options = { check: false, list: false, only: undefined, assets: ASSETS_DIR, paid: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Unknown flags are ignored: `bench all` forwards one argument list to every suite.
    if (arg === "--check") options.check = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--paid") options.paid = true;
    else if (arg === "--only") options.only = args[++i];
    else if (arg === "--assets") {
      const next = args[++i];
      if (next !== undefined) options.assets = path.resolve(next);
    }
  }
  return options;
}

export async function run(args: string[]): Promise<number> {
  const options = parseArgs(args);
  const tools = checkTools();
  const byId = new Map(tools.map((tool) => [tool.id, tool]));

  if (options.check || options.list) {
    for (const tool of tools) {
      const detail = tool.available
        ? `available${tool.version === null ? "" : ` (${tool.version})`}`
        : `missing — install with \`${tool.install}\``;
      console.log(`  ${tool.name}: ${detail}${tool.note === null ? "" : ` [${tool.note}]`}`);
    }
    if (options.list) {
      for (const capture of CAPTURES) {
        const needs = capture.needs.length === 0 ? "no external tool" : capture.needs.join(", ");
        console.log(`  #${capture.id} ${capture.name}: ${capture.description} (needs ${needs}${capture.paid ? ", costs model tokens" : ""})`);
      }
    }
    const available = tools.filter((tool) => tool.available).length;
    // The gate matches this exact shape, always last on stdout.
    console.log(`${SUITE}: ${available} available, ${tools.length - available} missing`);
    return 0;
  }

  const ctx: CaptureContext = { assets: options.assets, tools: byId, paid: options.paid };
  mkdirSync(ctx.assets, { recursive: true });

  let done = 0;
  let skipped = 0;
  for (const capture of CAPTURES) {
    if (options.only !== undefined && !capture.name.includes(options.only)) continue;
    const missing = capture.needs.filter((need) => byId.get(need)?.available !== true);
    if (missing.length > 0) {
      const instructions = missing.map((need) => byId.get(need)?.install ?? need).join(" && ");
      console.log(`${SUITE}: #${capture.id} ${capture.name}: skipped, needs ${missing.join(", ")} — \`${instructions}\``);
      skipped++;
      continue;
    }
    if (capture.paid && !options.paid) {
      console.log(`${SUITE}: #${capture.id} ${capture.name}: skipped, it spends model tokens (pass --paid to run it)`);
      skipped++;
      continue;
    }
    let result: CaptureResult;
    try {
      result = capture.perform(ctx);
    } catch (err) {
      // One capture throwing must never stop the others.
      result = { written: [], skipped: (err as Error).message };
    }
    if (result.skipped !== null) {
      console.log(`${SUITE}: #${capture.id} ${capture.name}: skipped, ${result.skipped}`);
      skipped++;
      continue;
    }
    for (const file of result.written) {
      const size = existsSync(file) ? statSync(file).size : 0;
      console.log(`${SUITE}: #${capture.id} ${capture.name}: wrote ${path.relative(REPO_ROOT, file)} (${size} bytes)`);
    }
    done++;
  }

  console.log(`${SUITE}: ${done} captured, ${skipped} skipped`);
  const available = tools.filter((tool) => tool.available).length;
  console.log(`${SUITE}: ${available} available, ${tools.length - available} missing`);
  return 0;
}
