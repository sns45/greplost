/**
 * `greplost` argument parsing and root discovery (plugin-cli spec "CLI contract").
 *
 * Everything here is decided before a single artifact is read, which is what
 * makes exit code 2 mean exactly one thing: the command line was wrong. A flag
 * belongs to one command and only that command, so `greplost verify --full`
 * fails loudly rather than quietly verifying; the alternative, a permissive
 * global flag set, turns a typo into a silent no-op, and the whole point of
 * the CLI is that an agent can trust what it just ran.
 *
 * `bench` is the one deliberate exception: everything after the suite name is
 * handed to the bench dispatcher untouched, because those flags are that
 * harness's vocabulary and this parser must never need updating when a suite
 * grows one.
 */

import { statSync } from "node:fs";
import path from "node:path";

import { ARTIFACT_DIR } from "@greplost/core/schema";

export type CommandName =
  | "init"
  | "update"
  | "verify"
  | "query"
  | "impact"
  | "flows"
  | "refresh"
  | "bench"
  | "screenshots"
  | "hook"
  | "version"
  | "help";

/** The four hook events the plugin transport understands (tech spec 7.1). */
export const HOOK_EVENTS = ["session-start", "pre-tool-use", "post-tool-use", "stop"] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Per-command options. Every field is absent unless the command line set it. */
export interface CommandOptions {
  /** `init --no-hooks` -> false. */
  hooks?: boolean;
  /** `init --workspace`: build the multi-repo workspace map (tech spec 9). */
  workspace?: boolean;
  /** `update --semantic`: refresh the semantic layer after the update (tech spec 9). */
  semantic?: boolean;
  /** `update` mode; always set for `update`. */
  mode?: "incremental" | "full";
  /** `update --files a b`. */
  files?: string[];
  /** `update --quiet`. */
  quiet?: boolean;
  /** `verify --diff`. */
  diff?: boolean;
  /** `impact --depth n`; a non-negative integer. */
  depth?: number;
  /** `refresh --model m`. */
  model?: string;
  /** `refresh --dry-run`. */
  dryRun?: boolean;
  /** `bench <suite> [...]`: everything after the suite name, verbatim. */
  passthrough?: string[];
}

export interface ParsedCommand {
  name: CommandName;
  /** Positional operands, in order, without the command name. */
  operands: string[];
  /** `--root` as written; resolved by `resolveRoot`, never here. */
  root?: string;
  json: boolean;
  options: CommandOptions;
}

export type ParseResult = { ok: true; command: ParsedCommand } | { ok: false; message: string };

/**
 * What a command actually runs against: the parse, with `--root` resolved.
 * Every command module takes exactly this and returns an exit code.
 */
export interface CommandContext {
  /** Absolute repo root. */
  root: string;
  /** True when `--root` was given, rather than discovered from `cwd`. */
  rootGiven: boolean;
  /** The directory the command was invoked from. */
  cwd: string;
  json: boolean;
  operands: string[];
  options: CommandOptions;
}

/**
 * One synopsis and one summary per command, so `greplost help <cmd>` and the
 * full usage block can never disagree about what a command takes.
 */
const COMMAND_USAGE: ReadonlyArray<readonly [CommandName, string, string]> = [
  ["init", "greplost init [--no-hooks] [--workspace]", "build the map, install git hooks, write config"],
  [
    "update",
    "greplost update [--incremental|--full] [--files <p>...] [--semantic] [--quiet]",
    "bring the map up to date",
  ],
  ["verify", "greplost verify [--diff]", "exit 1 on drift"],
  ["query", "greplost query <symbol|path>", "definition, importers, callers, package, card"],
  ["impact", "greplost impact <path> [--depth <n>]", "blast radius, by depth"],
  ["flows", "greplost flows <pkg>", "print the package's FLOWS.md"],
  ["refresh", "greplost refresh [pkg] [--model <m>] [--dry-run]", "semantic layer"],
  ["bench", "greplost bench <suite> [args...]", "benchmark suites (inside the greplost repo)"],
  ["screenshots", "greplost screenshots", "regenerate docs/assets"],
  ["hook", `greplost hook <${HOOK_EVENTS.join("|")}>`, "Claude Code plugin transport (payload on stdin)"],
  ["version", "greplost --version", "print the version"],
  ["help", "greplost --help | greplost help <command>", "print this"],
];

const USAGE_FOOTER = `Every command accepts --root <dir> and --json.
In a workspace (a directory holding greplost.workspace.json), update, verify,
query and impact act on every listed repo when run from that root; init there
needs --workspace; update --files is ignored and --semantic is refused.
Exit codes: 0 success, 1 drift or not found, 2 usage error.`;

/** Column width: the longest synopsis that is not itself an outlier. */
const USAGE_WIDTH = Math.max(...COMMAND_USAGE.filter(([, s]) => s.length <= 46).map(([, s]) => s.length));

/**
 * `  <synopsis>  <summary>`, aligned. A synopsis too long for the column keeps
 * the column honest by dropping its summary to the next line rather than
 * pushing every other row to the right.
 */
function usageLine(synopsis: string, summary: string): string {
  if (synopsis.length > USAGE_WIDTH) return `  ${synopsis}\n  ${" ".repeat(USAGE_WIDTH)}  ${summary}`;
  return `  ${synopsis.padEnd(USAGE_WIDTH)}  ${summary}`.replace(/\s+$/, "");
}

export const USAGE = `usage: greplost <command> [options]

${COMMAND_USAGE.map(([, synopsis, summary]) => usageLine(synopsis, summary)).join("\n")}

${USAGE_FOOTER}`;

/** Usage for one command, for `greplost help <cmd>` and `greplost <cmd> --help`. */
export function usageFor(name: string): string {
  const entry = COMMAND_USAGE.find(([command]) => command === name);
  if (entry === undefined) return USAGE;
  return `usage: ${entry[1]}\n\n  ${entry[2]}\n\n${USAGE_FOOTER}`;
}

const COMMANDS: ReadonlySet<string> = new Set<CommandName>([
  "init",
  "update",
  "verify",
  "query",
  "impact",
  "flows",
  "refresh",
  "bench",
  "screenshots",
  "hook",
  "version",
  "help",
]);

/** Operand arity per command: `[min, max]`, `max` of -1 meaning unbounded. */
const ARITY: Readonly<Record<CommandName, readonly [number, number]>> = {
  init: [0, 0],
  update: [0, 0],
  verify: [0, 0],
  query: [1, 1],
  impact: [1, 1],
  flows: [1, 1],
  refresh: [0, 1],
  bench: [1, 1],
  screenshots: [0, 0],
  hook: [1, 1],
  version: [0, 0],
  help: [0, 1],
};

/** A cursor over the remaining argv, so flag handlers can consume values. */
interface Cursor {
  argv: string[];
  index: number;
}

function usageError(message: string): ParseResult {
  return { ok: false, message };
}

export function parseArgs(argv: string[]): ParseResult {
  const first = argv[0];
  if (first === undefined) return usageError(`no command given\n\n${USAGE}`);

  let name: CommandName;
  let rest: string[];

  if (first === "--help" || first === "-h") {
    name = "help";
    rest = argv.slice(1);
  } else if (first === "--version" || first === "-v" || first === "-V") {
    name = "version";
    rest = argv.slice(1);
  } else if (first.startsWith("-") && first !== "-") {
    return usageError(`unknown option ${first}\n\n${USAGE}`);
  } else if (COMMANDS.has(first)) {
    name = first as CommandName;
    rest = argv.slice(1);
  } else {
    return usageError(`unknown command "${first}"\n\n${USAGE}`);
  }

  return parseRest(name, rest);
}

function parseRest(name: CommandName, argv: string[]): ParseResult {
  const options: CommandOptions = {};
  const operands: string[] = [];
  let root: string | undefined;
  let json = false;
  let helpRequested = false;
  let flagsEnded = false;

  if (name === "update") options.mode = "incremental";

  const cursor: Cursor = { argv, index: 0 };

  while (cursor.index < argv.length) {
    const arg = argv[cursor.index] as string;
    cursor.index += 1;

    if (flagsEnded || arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      // The bench dispatcher owns its own flags; this parser must not need a
      // release every time a suite grows one. The two flags the usage block
      // promises on every command are lifted out of the tail first, so
      // `greplost bench structural --root x` means what it says.
      if (name === "bench" && operands.length === 1) {
        const tail = splitBenchTail(argv.slice(cursor.index));
        cursor.index = argv.length;
        if (tail.error !== undefined) return usageError(`${tail.error}\n\n${USAGE}`);
        if (tail.root !== undefined) root = tail.root;
        if (tail.json) json = true;
        options.passthrough = tail.passthrough;
      }
      continue;
    }

    if (arg === "--") {
      flagsEnded = true;
      continue;
    }

    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);

    if (flag === "--help" || flag === "-h") {
      helpRequested = true;
      continue;
    }

    if (flag === "--root") {
      const value = takeValue(cursor, inline);
      if (value === undefined) return usageError(`--root needs a directory\n\n${USAGE}`);
      root = value;
      continue;
    }

    if (flag === "--json") {
      if (inline !== undefined) return usageError(`--json takes no value\n\n${USAGE}`);
      json = true;
      continue;
    }

    const handled = applyCommandFlag(name, flag, inline, cursor, options);
    if (handled !== true) return usageError(`${handled}\n\n${USAGE}`);
  }

  if (helpRequested) {
    return { ok: true, command: { name: "help", operands: [name], json, options: {}, ...rootOf(root) } };
  }

  const [min, max] = ARITY[name];
  if (operands.length < min) {
    return usageError(`${name} needs ${min === 1 ? "an argument" : `${min} arguments`}\n\n${USAGE}`);
  }
  if (max !== -1 && operands.length > max) {
    return usageError(`${name} takes at most ${max} argument${max === 1 ? "" : "s"}\n\n${USAGE}`);
  }

  if (name === "hook") {
    const event = operands[0] as string;
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      return usageError(`unknown hook event "${event}"; expected one of ${HOOK_EVENTS.join(", ")}\n\n${USAGE}`);
    }
  }

  return { ok: true, command: { name, operands, json, options, ...rootOf(root) } };
}

function rootOf(root: string | undefined): { root?: string } {
  return root === undefined ? {} : { root };
}

interface BenchTail {
  root: string | undefined;
  json: boolean;
  passthrough: string[];
  error?: string;
}

/**
 * Lift `--root` and `--json` out of a `bench` tail, leaving everything else for
 * the suite.
 *
 * `--root` is consumed: no bench suite defines one, and the usage block
 * promises it on every command. `--json` is recorded *and forwarded*, because
 * the CLI has no `--json` rendering of its own for `bench` (it delegates with
 * inherited stdio) while a suite may well have one, and `bench/src/mapquality.ts`
 * already does. Swallowing it there would break a flag that works today.
 */
function splitBenchTail(tail: readonly string[]): BenchTail {
  const passthrough: string[] = [];
  let root: string | undefined;
  let json = false;

  for (let index = 0; index < tail.length; index += 1) {
    const arg = tail[index] as string;
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);

    if (flag === "--root") {
      if (inline !== undefined) {
        root = inline;
        continue;
      }
      const next = tail[index + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-")) {
        return { root, json, passthrough, error: "--root needs a directory" };
      }
      root = next;
      index += 1;
      continue;
    }

    if (flag === "--json" && inline === undefined) json = true;
    passthrough.push(arg);
  }

  return { root, json, passthrough };
}

/**
 * Consume a flag's value: the inline `--k=v` form, else the next argv entry.
 *
 * A separate entry that itself looks like a flag is refused. `--root --json`
 * is a forgotten argument, not a directory called `--json`, and swallowing it
 * would run the command against the wrong place in silence. The inline form
 * has no such ambiguity, so `--root=--json` would be honoured.
 */
function takeValue(cursor: Cursor, inline: string | undefined): string | undefined {
  if (inline !== undefined) return inline;
  const next = cursor.argv[cursor.index];
  if (next === undefined || (next.startsWith("-") && next !== "-")) return undefined;
  cursor.index += 1;
  return next;
}

/**
 * Apply one command-specific flag. Returns `true` when it belongs to `name`,
 * otherwise the usage message explaining why it does not.
 */
function applyCommandFlag(
  name: CommandName,
  flag: string,
  inline: string | undefined,
  cursor: Cursor,
  options: CommandOptions,
): true | string {
  const noValue = (): true | string => (inline === undefined ? true : `${flag} takes no value`);

  if (name === "init") {
    if (flag === "--no-hooks") {
      options.hooks = false;
      return noValue();
    }
    // Parsed even though the workspace layer is not in this build: a flag the
    // tech spec documents should report a missing layer (exit 1), not read as
    // a typo (exit 2).
    if (flag === "--workspace") {
      options.workspace = true;
      return noValue();
    }
  }

  if (name === "update") {
    if (flag === "--full") {
      options.mode = "full";
      return noValue();
    }
    if (flag === "--incremental") {
      options.mode = "incremental";
      return noValue();
    }
    if (flag === "--quiet") {
      options.quiet = true;
      return noValue();
    }
    if (flag === "--semantic") {
      options.semantic = true;
      return noValue();
    }
    if (flag === "--files") {
      const first = takeValue(cursor, inline);
      if (first === undefined) return "--files needs at least one path";
      const files = options.files ?? [];
      files.push(first);
      // Variadic: swallow following operands until the next flag, so
      // `--files a.ts b.ts --quiet` reads the way it looks.
      if (inline === undefined) {
        while (cursor.index < cursor.argv.length) {
          const next = cursor.argv[cursor.index] as string;
          if (next.startsWith("-") && next !== "-") break;
          files.push(next);
          cursor.index += 1;
        }
      }
      options.files = files;
      return true;
    }
  }

  if (name === "verify" && flag === "--diff") {
    options.diff = true;
    return noValue();
  }

  if (name === "impact" && flag === "--depth") {
    const value = takeValue(cursor, inline);
    if (value === undefined) return "--depth needs an integer";
    if (!/^\d+$/.test(value)) return `--depth needs a non-negative integer, got "${value}"`;
    options.depth = Number(value);
    return true;
  }

  if (name === "refresh") {
    if (flag === "--model") {
      const value = takeValue(cursor, inline);
      if (value === undefined) return "--model needs a model name";
      options.model = value;
      return true;
    }
    if (flag === "--dry-run") {
      options.dryRun = true;
      return noValue();
    }
  }

  return `unknown option ${flag} for "${name}"`;
}

/**
 * The nearest ancestor of `cwd` (inclusive) that holds a `.greplost/`
 * directory, or `cwd` when there is none.
 *
 * "Or cwd" rather than an error: `greplost init` has to work in a repo that is
 * not indexed yet, and that is the command people run first.
 */
export function findRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (isDirectory(path.join(dir, ARTIFACT_DIR))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

/**
 * The root a command runs against: an explicit `--root` resolved against
 * `cwd`, else discovery. Throws when `--root` is not a directory, because
 * every command after this point would otherwise report "no map here" for
 * what is really a typo.
 */
export function resolveRoot(cwd: string, explicit: string | undefined): string {
  if (explicit === undefined) return findRoot(cwd);
  const resolved = path.resolve(cwd, explicit);
  if (!isDirectory(resolved)) throw new Error(`--root ${explicit} is not a directory`);
  return resolved;
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
