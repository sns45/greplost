/**
 * The human half of `greplost query` (plugin-cli spec "CLI contract").
 *
 * Split out of `query.ts` so that the command file holds the answer and this
 * one holds the look of it: an agent reads `--json` and never runs any of this,
 * a person reads only this and never sees the shapes.
 *
 * `--brief` is the evaluation's ask (leaf 2.15). A Go import names a package,
 * so every exported symbol of a widely imported package carries that package's
 * whole importer list, and a `query` over a dozen matches printed the same
 * forty paths a dozen times. In brief mode the list becomes its own count,
 * which is the part a reader was going to act on anyway.
 */

import { compareStrings } from "@greplost/core/schema";

import { fields, printError, printLine, summarise, table } from "../output.ts";
import type { QueryDirectory, QueryFile, QueryMatch, QueryNode } from "./query.ts";

/** `12 files`, the brief-mode stand-in for a list nobody was going to read. */
function count(items: readonly string[], noun: string): string {
  return `${items.length} ${noun}${items.length === 1 ? "" : "s"}`;
}

function listOrCount(items: readonly string[], brief: boolean, noun: string): string {
  return brief ? count(items, noun) : summarise(items);
}

export function printFile(file: QueryFile, brief = false): void {
  printLine(file.path);
  for (const line of fields([
    ["package", file.package],
    ["card", file.card],
    ["loc", String(file.loc)],
    ["fan-in", String(file.fanIn)],
    ["fan-out", String(file.fanOut)],
    ["blast", String(file.blast)],
    ["exports", brief ? count(file.exports, "export") : summarise(file.exports, 8)],
    ["imports", listOrCount(file.imports, brief, "import")],
    ["importers", listOrCount(file.importers, brief, "file")],
  ])) {
    printLine(line);
  }
}

/**
 * A node reads as one block, not as a row in a table of one: everything the map
 * knows about it fits in eight aligned fields, and the table form would waste
 * four columns on a single answer.
 */
export function printNode(node: QueryNode): void {
  printLine(node.id);
  const attributes = Object.entries(node.meta ?? {})
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
  for (const line of fields([
    ["kind", node.kind],
    ["file", node.file],
    ["package", node.package],
    ["card", node.card],
    ["source", `L${node.span[0]}-${node.span[1]}`],
    ["attributes", attributes],
    ["blast", String(node.blast)],
    ["references", summarise(node.references.map((r) => `${r.to} (${r.refKind})`))],
    ["referenced by", summarise(node.referencedBy.map((r) => `${r.from} (${r.refKind})`))],
  ])) {
    printLine(line);
  }
}

/**
 * A directory is its file table, in path order, with the figures a reader picks
 * files by: how big, how much it exposes, how many files depend on it and how
 * many it depends on.
 */
export function printDirectory(directory: QueryDirectory): void {
  printLine(directory.path);
  printLine();
  const rows = directory.files.map((file) => [
    file.path,
    String(file.loc),
    String(file.exports),
    String(file.fanIn),
    String(file.fanOut),
  ]);
  for (const line of table(["FILE", "LOC", "EXPORTS", "FAN-IN", "FAN-OUT"], rows)) printLine(line);
  printLine();
  printLine(`${directory.files.length} file${directory.files.length === 1 ? "" : "s"} in the map`);
}

export function printMatches(matches: QueryMatch[], brief = false): void {
  for (const line of table(
    ["NAME", "KIND", "LOCATION", "PACKAGE"],
    matches.map((match) => [
      match.name,
      match.kind,
      `${match.file}:${match.span[0]}-${match.span[1]}`,
      match.package,
    ]),
  )) {
    printLine(line);
  }

  const only = matches.length === 1 ? matches[0] : undefined;
  if (only === undefined) {
    if (matches.length > 1) {
      printLine();
      printLine(`${matches.length} matches; run \`greplost query <id>\` for one of them`);
    }
    return;
  }

  printLine();
  for (const line of fields([
    ["signature", only.signature],
    ["card", only.card],
    ["importers", listOrCount(only.importers, brief, "file")],
    ["callers", listOrCount(only.callers, brief, "caller")],
  ])) {
    printLine(line);
  }
}

/**
 * The nearest ids, under a miss. On stderr with the error they belong to, so a
 * shell pipeline reading stdout still gets nothing at all on a miss, which is
 * the contract every other failure here keeps.
 */
export function printSuggestions(suggestions: readonly string[]): void {
  if (suggestions.length === 0) return;
  printError(`did you mean: ${suggestions.join(", ")}`);
}
