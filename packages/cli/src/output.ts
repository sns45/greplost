/**
 * Everything the CLI writes, and where the CLI lives on disk.
 *
 * Two audiences share one command surface, so they get two output modes and
 * nothing in between: `--json` is `stableStringify(value, 2)` on stdout and
 * literally nothing else, because an agent parses it; human mode is short,
 * column-aligned text, because a person reads it. Errors always go to stderr
 * with the `greplost: ` prefix, so neither mode can ever have its output
 * corrupted by a failure.
 *
 * Everything prints through `console.log`/`console.error` rather than
 * `process.stdout.write` so that the in-process tests can capture it the same
 * way they capture the one-line summaries `@greplost/sync` prints.
 *
 * The path helpers live here too: "where is my package.json" and "where are my
 * grammars" are questions about the installed binary, which is the same subject
 * as `--version`.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stableStringify } from "@greplost/core/schema";

import manifest from "../package.json" with { type: "json" };

/** The published version, inlined into the bundle at build time. */
export const VERSION: string = manifest.version;

export function printLine(text = ""): void {
  console.log(text);
}

/** `--json` output: the stable serialisation and nothing else. */
export function printJson(value: unknown): void {
  console.log(stableStringify(value, 2));
}

/**
 * One error line on stderr. The prefix is added here and only here, so a
 * message that already carries it (core and sync throw `greplost: …`) is not
 * printed twice.
 */
export function printError(message: string): void {
  console.error(message.startsWith("greplost: ") ? message : `greplost: ${message}`);
}

/** The message of anything that was thrown, without the stack. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Column-aligned rows, two spaces between columns, no trailing whitespace.
 * A short table is easier to scan than a paragraph and costs an agent nothing,
 * because an agent asks for `--json`.
 */
export function table(headers: readonly string[] | undefined, rows: readonly (readonly string[])[]): string[] {
  const all = headers === undefined ? rows : [headers, ...rows];
  if (all.length === 0) return [];

  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }

  return all.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ")
      .replace(/\s+$/, ""),
  );
}

/** An indented `key   value` block, aligned on the key. Empty values are dropped. */
export function fields(pairs: readonly (readonly [string, string])[]): string[] {
  const present = pairs.filter(([, value]) => value !== "");
  const width = present.reduce((max, [key]) => Math.max(max, key.length), 0);
  return present.map(([key, value]) => `  ${key.padEnd(width)}  ${value}`.replace(/\s+$/, ""));
}

/** A comma-joined list, capped, with a count of what was left out. */
export function summarise(items: readonly string[], cap = 5): string {
  if (items.length === 0) return "none";
  if (items.length <= cap) return items.join(", ");
  return `${items.slice(0, cap).join(", ")} (+${items.length - cap} more)`;
}

/**
 * The directory of the installed `greplost` package: the nearest ancestor of
 * this module holding a `package.json`. That is `packages/cli` both from
 * source (`src/output.ts`) and from the node bundle (`dist/main.js`), so
 * nothing downstream has to know which one it is running.
 */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(fileURLToPath(import.meta.url));
    dir = parent;
  }
}

/** Read the whole of stdin. `""` when stdin is a terminal, so nothing ever hangs. */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY === true) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
