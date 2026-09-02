/**
 * The `greplost` entry point (tech spec 9, plugin-cli spec "CLI contract").
 *
 * `main` returns an exit code and never calls `process.exit`: `bin/greplost.js`
 * owns the process, the tests own the return value, and a command that has
 * written to stdout is never cut off mid-write. Three codes and nothing else:
 * 0 success, 1 "drift or not found" (a real answer the caller must act on),
 * 2 usage error (the command line was wrong, nothing ran).
 *
 * Two things happen before any command does: the grammar directory is pointed
 * at the bundle's vendored copy when this module is running from `dist/`, and
 * `--root` is resolved. Both are process-level facts that every command would
 * otherwise have to rediscover.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { USAGE, parseArgs, resolveRoot } from "./args.ts";
import type { CommandContext, ParsedCommand } from "./args.ts";
import { errorMessage, printError, printLine } from "./output.ts";

import * as bench from "./commands/bench.ts";
import * as flows from "./commands/flows.ts";
import * as hook from "./commands/hook.ts";
import * as impact from "./commands/impact.ts";
import * as init from "./commands/init.ts";
import * as query from "./commands/query.ts";
import * as refresh from "./commands/refresh.ts";
import * as screenshots from "./commands/screenshots.ts";
import * as update from "./commands/update.ts";
import * as verify from "./commands/verify.ts";
import * as version from "./commands/version.ts";

/**
 * Point `web-tree-sitter` at the grammars the build copied next to the bundle.
 *
 * Only when running from `dist/`: from source the grammars sit beside
 * `@greplost/core` and finding them is that package's job. An environment that
 * already sets the variable is left alone, because an override the user asked
 * for outranks the one we would have guessed.
 */
function configureGrammarDir(): void {
  if (!import.meta.url.includes("/dist/")) return;
  const existing = process.env["GREPLOST_GRAMMAR_DIR"];
  if (existing !== undefined && existing !== "") return;
  process.env["GREPLOST_GRAMMAR_DIR"] = fileURLToPath(new URL("./grammars", import.meta.url));
}

configureGrammarDir();

export async function main(argv: string[]): Promise<number> {
  configureGrammarDir();

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    printError(parsed.message);
    return 2;
  }

  const command = parsed.command;
  if (command.name === "help") {
    printLine(USAGE);
    return 0;
  }

  const cwd = process.cwd();
  let root: string;
  try {
    root = resolveRoot(cwd, command.root);
  } catch (cause) {
    printError(errorMessage(cause));
    return 2;
  }

  const ctx: CommandContext = {
    root,
    rootGiven: command.root !== undefined,
    cwd,
    json: command.json,
    operands: command.operands,
    options: command.options,
  };

  try {
    return await dispatch(command.name, ctx);
  } catch (cause) {
    printError(errorMessage(cause));
    return 1;
  }
}

function dispatch(name: Exclude<ParsedCommand["name"], "help">, ctx: CommandContext): Promise<number> {
  switch (name) {
    case "init":
      return init.run(ctx);
    case "update":
      return update.run(ctx);
    case "verify":
      return verify.run(ctx);
    case "query":
      return query.run(ctx);
    case "impact":
      return impact.run(ctx);
    case "flows":
      return flows.run(ctx);
    case "refresh":
      return refresh.run(ctx);
    case "bench":
      return bench.run(ctx);
    case "screenshots":
      return screenshots.run(ctx);
    case "hook":
      return hook.run(ctx);
    case "version":
      return version.run(ctx);
  }
}

/**
 * True when this module is what the runtime was asked to execute, rather than
 * something `bin/greplost.js` imported. Compared by path rather than through
 * `import.meta.main` so the check means the same thing under Bun (source) and
 * Node (bundle).
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (cause: unknown) => {
      printError(errorMessage(cause));
      process.exitCode = 1;
    },
  );
}
