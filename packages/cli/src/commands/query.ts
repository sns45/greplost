/**
 * `greplost query <symbol|path|directory|node-id>` (tech spec 9, plugin-cli
 * spec "--json shapes").
 *
 * The command an agent reaches for instead of grepping: where a symbol is
 * declared, what it looks like, which package owns it, which card documents it,
 * who imports the file it lives in and who calls it, all read out of the
 * committed structure, never parsed.
 *
 * One argument, four questions, answered in this order: an indexed file, an
 * exact node id, a directory the map holds files under, then the symbol search.
 * The tie is broken by the manifest rather than by shape alone, so a symbol
 * called `a/b` (impossible in practice) or a file that was never indexed both
 * still fall through to the symbol search instead of dead-ending.
 *
 * Every answer carries a `status` (leaf 2.15). A miss is not one thing: a typo,
 * a file the config excludes and a file written since the last update need
 * three different next actions, and only the last of them is `greplost update`.
 * `status.ts` decides which, from the checkout rather than from the map, and a
 * miss that names nothing at all gets the nearest ids the map does hold.
 */

import { findSymbols } from "@greplost/core";
import type { Structure } from "@greplost/core";
import type { Confidence, DeclKind, Declaration, RefKind } from "@greplost/core/schema";
import { compareDeclarations } from "@greplost/core/schema";

import type { CommandContext } from "../args.ts";
import { printError, printJson, printLine } from "../output.ts";
import {
  describe,
  describeDirectory,
  describeFile,
  describeNode,
  importEdgesByTarget,
  indexReferences,
} from "./query-describe.ts";
import { printDirectory, printFile, printMatches, printNode, printSuggestions } from "./query-print.ts";
import { filesStatus, statusOf } from "./status.ts";
import type { QueryStatus, StatusVerdict } from "./status.ts";
import { loadStructure, resolveDirectory, resolveFile, resolveNode, toRepoRelative } from "./structure.ts";
import { nearestIds } from "./suggest.ts";
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
  /**
   * Files importing the declaring file and naming this symbol (or importing
   * `*`). Where imports target a package directory rather than a file (Go),
   * every importer of the package is listed for every *exported* declaration
   * in it, because a Go import names the package and cannot name a symbol.
   */
  importers: string[];
  /** Symbol ids that call this declaration. */
  callers: string[];
  /**
   * Schema 2. Language, IaC or framework attributes of a non-file node; omitted
   * when the declaration carries none, exactly as spec 4.5 declares it.
   */
  meta?: Record<string, string>;
  /**
   * Schema 2. Reference edges leaving and entering this declaration, always
   * present and `[]` when there are none (spec 4.5), so a consumer reads
   * `.length` without first testing for the key. A repo with no reference edges
   * gets two empty arrays, not two missing fields.
   */
  references: ReferenceOut[];
  referencedBy: ReferenceIn[];
}

/** A reference edge as `query` reports it, from the near end. */
export interface ReferenceOut {
  to: string;
  refKind: RefKind;
  confidence: Confidence;
}

/** A reference edge as `query` reports it, from the far end. */
export interface ReferenceIn {
  from: string;
  refKind: RefKind;
  confidence: Confidence;
}

/**
 * The node block, present when the argument named a non-file node. Mirrors
 * `QueryFile`: a node is the other thing a map holds that is not a symbol, and
 * an agent should not have to read it differently.
 */
export interface QueryNode {
  id: string;
  file: string;
  kind: DeclKind;
  name: string;
  package: string;
  /** `.greplost`-relative node card path; slugged, so it never contains a `#`. */
  card: string;
  meta?: Record<string, string>;
  references: ReferenceOut[];
  referencedBy: ReferenceIn[];
  /** Reverse closure over import, re-export and reference edges: the card's figure. */
  blast: number;
  span: [number, number];
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

/**
 * One row of a directory answer: the same four figures the file block carries,
 * with `exports` as a count rather than a list, because a directory answer is a
 * table and a table cell is not the place to read forty names.
 */
export interface QueryDirectoryFile {
  path: string;
  loc: number;
  /** Number of exported names, not the names: `query <file>` lists those. */
  exports: number;
  fanIn: number;
  fanOut: number;
}

/**
 * The directory block, present when the argument named a directory the map
 * holds files under (leaf 2.15). The evaluation asked `greplost query
 * packages/pgmq` and was told to run an update; a directory is a perfectly
 * ordinary thing to ask about, and the map already knows every file below it.
 */
export interface QueryDirectory {
  path: string;
  /** Every indexed file under it, at any depth, sorted. */
  files: QueryDirectoryFile[];
}

export interface QueryResult {
  query: string;
  /**
   * Why this answer is what it is (leaf 2.15): `found`, `absent` (nothing
   * matches and nothing is on disk under that path), `excluded` (on disk, and
   * the config drops it) or `stale` (on disk, and the map does not describe it
   * or no longer describes these bytes).
   */
  status: QueryStatus;
  matches: QueryMatch[];
  file?: QueryFile;
  /** Schema 2: present when the argument was an exact non-file node id. */
  node?: QueryNode;
  /** Present when the argument named a directory the map holds files under. */
  directory?: QueryDirectory;
  /** The `exclude` pattern that drops the path, when `status` is `excluded`. */
  excludedBy?: string;
  /** One line explaining a `status` that is not `found`; the text mode's error. */
  message?: string;
  /** Up to five nearest ids the map does hold; present only when nothing matched. */
  suggestions?: string[];
}

export async function run(ctx: CommandContext): Promise<number> {
  const handled = await dispatchWorkspace("query", ctx);
  if (handled !== undefined) return handled;

  const needle = ctx.operands[0] as string;
  const structure = loadStructure(ctx.root);
  const result = queryStructure(structure, ctx.root, needle);
  const answered = hasAnswer(result);
  applyStatus(result, structure, ctx.root, needle, answered);

  if (ctx.json) {
    printJson(result);
    return answered ? 0 : 1;
  }

  if (!answered) {
    printError(result.message ?? `no match for "${needle}"`);
    printSuggestions(result.suggestions ?? []);
    return 1;
  }

  if (result.node !== undefined) {
    printNode(result.node);
  } else if (result.directory !== undefined) {
    printDirectory(result.directory);
  } else {
    if (result.file !== undefined) printFile(result.file, ctx.options.brief === true);
    if (result.matches.length > 0) {
      if (result.file !== undefined) printLine();
      printMatches(result.matches, ctx.options.brief === true);
    }
  }

  // A stale answer is still an answer, so it goes to stdout under the answer it
  // qualifies rather than to stderr, where it would look like a failure.
  if (result.status !== "found" && result.message !== undefined) {
    printLine();
    printLine(result.message);
  }
  return 0;
}

/** True when the map answered at all: a file, a node, a directory or a symbol. */
function hasAnswer(result: QueryResult): boolean {
  return (
    result.file !== undefined ||
    result.node !== undefined ||
    result.directory !== undefined ||
    result.matches.length > 0
  );
}

/**
 * Fill in `status`, its message, and the suggestions, from the checkout.
 *
 * Separate from `queryStructure` because that function is pure and this half is
 * not: it stats and hashes files, reads `config.json` and, on a miss, ranks
 * every id in the map. A `query` that answered pays for one hash of one file;
 * only a miss pays for the ranking.
 */
function applyStatus(
  result: QueryResult,
  structure: Structure,
  root: string,
  needle: string,
  answered: boolean,
): void {
  const verdict = verdictFor(result, structure, root, needle, answered);
  result.status = verdict.status;
  if (verdict.excludedBy !== undefined) result.excludedBy = verdict.excludedBy;
  if (verdict.message !== undefined) result.message = verdict.message;
  if (!answered) result.suggestions = nearestIds(structure, needle);
}

/**
 * Which classifier judges this answer.
 *
 * A path answer is judged as the path it named; an answer built from
 * declarations (a symbol search, or a node id, neither of which is a path) is
 * judged by the files those declarations were read from, because that is what
 * "is this still true" means for a symbol (fix round 1). A miss is judged by
 * the argument, which is where `absent`, `excluded` and `stale` are decided.
 */
function verdictFor(
  result: QueryResult,
  structure: Structure,
  root: string,
  needle: string,
  answered: boolean,
): StatusVerdict {
  const target = result.file ?? result.directory;
  if (target !== undefined) return statusOf(root, structure.manifest, target.path, true, needle);
  if (answered) return filesStatus(root, structure.manifest, result.matches.map((match) => match.file));
  // A node id is not a path, and neither is a symbol name; handing either to
  // the path classifier would ask the filesystem about a string that was never
  // meant to be one.
  const relative = needle.includes("#") ? "" : toRepoRelative(root, needle);
  return statusOf(root, structure.manifest, relative, false, needle);
}

/** The whole answer, as `--json` serialises it. Pure: no output, no filesystem. */
export function queryStructure(structure: Structure, root: string, needle: string): QueryResult {
  const manifest = structure.manifest;
  // The ladder, in this order and no other (spec 4.5, extended by leaf 2.15):
  // an indexed file first and still first, then an exact non-file node id, then
  // a directory the map holds files under, then the symbol search. A node id
  // can never be mistaken for a path, because `looksLikePath` rejects anything
  // holding a `#`, and a directory is tried before symbols because a path that
  // names a real directory is never a symbol name.
  const relative = toRepoRelative(root, needle);
  const asFile = resolveFile(manifest, relative);
  const asNode = asFile === undefined ? resolveNode(structure, needle) : undefined;
  const asDirectory =
    asFile === undefined && asNode === undefined ? resolveDirectory(manifest, relative) : undefined;

  let declarations: Declaration[];
  if (asFile !== undefined) {
    declarations = [...structure.symbols.filter((decl) => decl.file === asFile)].sort(compareDeclarations);
  } else if (asNode !== undefined) {
    declarations = [asNode];
  } else if (asDirectory !== undefined) {
    // A directory answer is its file table. Listing every declaration of every
    // file under it would answer a question nobody asked and, on a package of
    // seventy files, would bury the table it did ask for.
    declarations = [];
  } else {
    declarations = findSymbols(structure.symbols, needle);
  }

  // One pass over each edge collection rather than one per declaration: a file
  // query on a large module would otherwise re-scan the whole import graph, and
  // both reference directions, once per symbol it answers with.
  const byTarget = importEdgesByTarget(structure, declarations);
  const edges = indexReferences(structure.references);
  const matches = declarations.map((decl) => describe(structure, manifest, decl, byTarget, edges));

  // The map's own verdict, refined by `applyStatus` once the checkout has been
  // consulted; a caller of this pure function still gets a usable one.
  const result: QueryResult = { query: needle, status: "absent", matches };
  if (asFile !== undefined) result.file = describeFile(structure, manifest, asFile);
  if (asNode !== undefined) result.node = describeNode(structure, manifest, asNode, edges);
  if (asDirectory !== undefined) result.directory = describeDirectory(manifest, asDirectory);
  if (hasAnswer(result)) result.status = "found";
  return result;
}

