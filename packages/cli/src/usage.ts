/**
 * Every line `greplost` prints when it is explaining itself (plugin-cli spec
 * "CLI contract").
 *
 * The command vocabulary lives here rather than in `args.ts` because the help
 * text *is* the vocabulary: one synopsis and one summary per command, and one
 * place a command is added. `args.ts` parses against this list and re-exports
 * the names its callers already import, so nothing outside had to learn a new
 * module when the help outgrew the parser: leaf 2.15 added the node kinds, the
 * four statuses, the default excludes and what `--depth` actually bounds,
 * because the evaluation had to read the source to learn all four.
 */

import { ARTIFACT_DIR, DEFAULT_CONFIG, NODE_KINDS } from "@greplost/core/schema";

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
  [
    "query",
    "greplost query <symbol|path|dir|node-id> [--brief]",
    "definition, references, importers, callers, card",
  ],
  ["impact", "greplost impact <path|node-id> [--depth <n>]", "blast radius, by depth"],
  ["flows", "greplost flows <pkg>", "print the package's FLOWS.md"],
  ["refresh", "greplost refresh [pkg] [--model <m>] [--dry-run]", "semantic layer"],
  ["bench", "greplost bench <suite> [args...]", "benchmark suites (inside the greplost repo)"],
  ["screenshots", "greplost screenshots", "regenerate docs/assets"],
  ["hook", `greplost hook <${HOOK_EVENTS.join("|")}>`, "Claude Code plugin transport (payload on stdin)"],
  ["version", "greplost --version", "print the version"],
  ["help", "greplost --help | greplost help <command>", "print this"],
];

const USAGE_FOOTER = `Every command accepts --root <dir> and --json.
A node id names a non-file node inside a file: <file>#<kind>.<name>, as in
main.tf#resource.aws_vpc.main or ci.yml#job.build. A file's blast radius counts
files over imports; a node's counts nodes over imports and reference edges.
In a workspace (a directory holding greplost.workspace.json), update, verify,
query and impact act on every listed repo when run from that root; init there
needs --workspace; update --files is ignored and --semantic is refused.
Exit codes: 0 success, 1 drift or not found, 2 usage error.

${excludeBlock()}`;

/**
 * The default `exclude` patterns, and where to change them (leaf 2.15).
 *
 * The evaluation spent a turn on `go/core/base_test.go` and read the empty
 * answer as a bug; the patterns were only ever written into a config file the
 * reader had no reason to open. Printed from `DEFAULT_CONFIG` rather than
 * retyped, so this block cannot go stale, and wrapped rather than one per line,
 * which would double the length of `--help` for fifteen short globs.
 */
function excludeBlock(): string {
  const lines: string[] = [];
  let current = " ";
  for (const pattern of DEFAULT_CONFIG.exclude) {
    const next = `${current}${current === " " ? "" : ","} ${pattern}`;
    if (next.length > 78) {
      lines.push(`${current},`);
      current = `  ${pattern}`;
      continue;
    }
    current = next;
  }
  lines.push(current);
  return [
    `Excluded by default (tests included), from "exclude" in ${ARTIFACT_DIR}/config.json,`,
    "which init writes once and never rewrites:",
    ...lines,
  ].join("\n");
}

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

/**
 * What one command needs said that its one-line summary cannot hold
 * (leaf 2.15).
 *
 * Both entries answer a question the evaluation had to answer from the source:
 * which kinds a node id may name, and what `--depth` actually bounds. The node
 * kinds are printed from `NODE_KINDS` rather than retyped, so a language leaf
 * that adds one cannot leave this list behind.
 */
const COMMAND_DETAIL: Readonly<Partial<Record<CommandName, string>>> = {
  query: [
    "An argument is tried as an indexed file, then an exact node id, then a",
    "directory the map holds files under, then a symbol search. A directory",
    "answer lists its files with LOC, exports, fan-in and fan-out.",
    "A node id is <file>#<kind>.<name>, and <kind> is one of:",
    `  ${[...NODE_KINDS].sort().join(", ")}`,
    "Every answer carries a status: found, absent (nothing on disk under that",
    "path either), excluded (on disk, dropped by the config, which names the",
    "pattern), or stale (on disk, and the map does not describe these bytes;",
    "that one is the case `greplost update` fixes). A miss prints the nearest",
    "ids the map does hold. --brief prints counts where the text output would",
    "otherwise repeat a long importer list.",
  ].join("\n"),
  impact: [
    "radius is the full reverse closure and is never bounded: for a file it",
    "counts files over import and re-export edges, for a node id it counts",
    "nodes over import, re-export and reference edges.",
    "--depth bounds the listing, never the radius; --json reports returned",
    "and truncated beside radius so the two counts can never be confused.",
  ].join("\n"),
};

/** Usage for one command, for `greplost help <cmd>` and `greplost <cmd> --help`. */
export function usageFor(name: string): string {
  const entry = COMMAND_USAGE.find(([command]) => command === name);
  if (entry === undefined) return USAGE;
  const detail = COMMAND_DETAIL[entry[0]];
  const body = detail === undefined ? "" : `${detail}\n\n`;
  return `usage: ${entry[1]}\n\n  ${entry[2]}\n\n${body}${USAGE_FOOTER}`;
}
