/**
 * `greplost query <symbol|path>` (tech spec 9, plugin-cli spec "--json shapes").
 *
 * The command an agent reaches for instead of grepping: where a symbol is
 * declared, what it looks like, which package owns it, which card documents it,
 * who imports the file it lives in and who calls it, all read out of the
 * committed structure, never parsed.
 *
 * One argument, two questions. A path that the map knows about is a question
 * about a file, so it also answers with the `file` block; anything else is a
 * question about a symbol. The tie is broken by the manifest rather than by
 * shape alone, so a symbol called `a/b` (impossible in practice) or a file that
 * was never indexed both still fall through to the symbol search instead of
 * dead-ending.
 */

import { callersOf, findSymbols, importersOf } from "@greplost/core";
import type { Structure } from "@greplost/core";
import type { DeclKind, Declaration, ImportEdge, Manifest } from "@greplost/core/schema";
import { compareDeclarations, compareStrings } from "@greplost/core/schema";

import type { CommandContext } from "../args.ts";
import { fields, printError, printJson, printLine, summarise, table } from "../output.ts";
import { cardOf, importsOfFile, loadStructure, resolveFile, toRepoRelative } from "./structure.ts";
import { dispatchWorkspace } from "./workspace.ts";

/** One declaration and everything the map knows about it. */
export interface QueryMatch {
  id: string;
  file: string;
  name: string;
  kind: DeclKind;
  signature: string;
  span: [number, number];
  exported: boolean;
  package: string;
  /** `.greplost`-relative module card path. */
  card: string;
  /** Files importing the declaring file and naming this symbol (or importing `*`). */
  importers: string[];
  /** Symbol ids that call this declaration. */
  callers: string[];
}

/** The file block, present when the argument named an indexed file. */
export interface QueryFile {
  path: string;
  package: string;
  card: string;
  exports: string[];
  imports: string[];
  importers: string[];
  fanIn: number;
  fanOut: number;
  blast: number;
  loc: number;
}

export interface QueryResult {
  query: string;
  matches: QueryMatch[];
  file?: QueryFile;
}

export async function run(ctx: CommandContext): Promise<number> {
  const handled = await dispatchWorkspace("query", ctx);
  if (handled !== undefined) return handled;

  const needle = ctx.operands[0] as string;
  const structure = loadStructure(ctx.root);
  const result = queryStructure(structure, ctx.root, needle);

  if (ctx.json) {
    printJson(result);
    return result.file === undefined && result.matches.length === 0 ? 1 : 0;
  }

  if (result.file === undefined && result.matches.length === 0) {
    printError(`no match for "${needle}"`);
    return 1;
  }

  if (result.file !== undefined) printFile(result.file);
  if (result.matches.length > 0) {
    if (result.file !== undefined) printLine();
    printMatches(result.matches);
  }
  return 0;
}

/** The whole answer, as `--json` serialises it. Pure: no output, no filesystem. */
export function queryStructure(structure: Structure, root: string, needle: string): QueryResult {
  const manifest = structure.manifest;
  const asFile = resolveFile(manifest, toRepoRelative(root, needle));

  const declarations =
    asFile === undefined
      ? findSymbols(structure.symbols, needle)
      : [...structure.symbols.filter((decl) => decl.file === asFile)].sort(compareDeclarations);

  // One pass over the edges rather than one per declaration: a file query on a
  // large module would otherwise re-scan the whole import graph per symbol.
  const byTarget = importEdgesByTarget(structure, declarations);
  const matches = declarations.map((decl) => describe(structure, manifest, decl, byTarget));

  const result: QueryResult = { query: needle, matches };
  if (asFile !== undefined) result.file = describeFile(structure, manifest, asFile);
  return result;
}

/** Import and re-export edges into each declaring file, indexed once. */
function importEdgesByTarget(structure: Structure, declarations: Declaration[]): Map<string, ImportEdge[]> {
  const wanted = new Set(declarations.map((decl) => decl.file));
  const byTarget = new Map<string, ImportEdge[]>();
  if (wanted.size === 0) return byTarget;

  for (const edge of structure.imports) {
    if (edge.kind !== "import" && edge.kind !== "reexport") continue;
    if (!wanted.has(edge.to)) continue;
    const bucket = byTarget.get(edge.to);
    if (bucket === undefined) byTarget.set(edge.to, [edge]);
    else bucket.push(edge);
  }
  return byTarget;
}

function describe(
  structure: Structure,
  manifest: Manifest,
  decl: Declaration,
  byTarget: Map<string, ImportEdge[]>,
): QueryMatch {
  const entry = manifest.files[decl.file];
  return {
    id: decl.id,
    file: decl.file,
    name: decl.name,
    kind: decl.kind,
    signature: decl.signature,
    span: decl.span,
    exported: decl.exported,
    package: entry?.pkg ?? "",
    card: cardOf(manifest, decl.file),
    importers: symbolImporters(byTarget.get(decl.file) ?? [], decl),
    callers: callersOf(structure.calls, decl.id),
  };
}

/**
 * Files that import `decl`'s file *and name this symbol*: the exported name is
 * the root of the symbol path, so a caller of `Registry.register` is found
 * through an import of `Registry`. A namespace import (`*`) names everything,
 * so it counts; a side-effect import names nothing, so it does not.
 */
function symbolImporters(edges: readonly ImportEdge[], decl: Declaration): string[] {
  const exportedName = decl.name.split(".")[0] as string;
  const importers = new Set<string>();
  for (const edge of edges) {
    const symbols = edge.symbols ?? [];
    if (symbols.includes("*") || symbols.includes(exportedName)) importers.add(edge.from);
  }
  return [...importers].sort(compareStrings);
}

function describeFile(structure: Structure, manifest: Manifest, file: string): QueryFile {
  const entry = manifest.files[file];
  return {
    path: file,
    package: entry?.pkg ?? "",
    card: cardOf(manifest, file),
    exports: entry?.exports ?? [],
    imports: importsOfFile(structure, file),
    importers: importersOf(structure.imports, file),
    fanIn: entry?.fanIn ?? 0,
    fanOut: entry?.fanOut ?? 0,
    blast: entry?.blast ?? 0,
    loc: entry?.loc ?? 0,
  };
}

function printFile(file: QueryFile): void {
  printLine(file.path);
  for (const line of fields([
    ["package", file.package],
    ["card", file.card],
    ["loc", String(file.loc)],
    ["fan-in", String(file.fanIn)],
    ["fan-out", String(file.fanOut)],
    ["blast", String(file.blast)],
    ["exports", summarise(file.exports, 8)],
    ["imports", summarise(file.imports)],
    ["importers", summarise(file.importers)],
  ])) {
    printLine(line);
  }
}

function printMatches(matches: QueryMatch[]): void {
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
    ["importers", summarise(only.importers)],
    ["callers", summarise(only.callers)],
  ])) {
    printLine(line);
  }
}
