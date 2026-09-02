/**
 * `greplost query` across a workspace (tech spec 4.4, driver ruling 2026-09-03).
 *
 * Tech spec 4.4 puts `query` next to `impact` as a command that operates across
 * the workspace, and the reason is the same one: the answer an agent needs most
 * ("who uses this?") is the answer that stops being true at a repo boundary. A
 * symbol declared in `repo-a` and consumed only from `repo-b` looks unused from
 * inside `repo-a`, which is exactly how a "safe" deletion breaks a sibling.
 *
 * The shape is the single-repo `--json` shape, match for match, with `id`,
 * `file` and every path in it carrying its `<repoDir>::` prefix. One parser
 * reads both, which is the whole point of a stable shape.
 */

import { callersOf, findSymbols } from "@greplost/core";
import type { Declaration, ImportEdge, Manifest, PackageInfo } from "@greplost/core/schema";
import { compareStrings } from "@greplost/core/schema";
import { cardPath } from "@greplost/render";

import { splitWorkspaceId, workspaceId } from "./config.ts";
import type { RepoView } from "./cross.ts";
import { readWorkspaceRepos, resolveWorkspaceTarget, workspacePairs } from "./impact.ts";

/** One declaration, with every id and path workspace-qualified. */
export interface WorkspaceQueryMatch {
  /** `<repoDir>::<file>#<symbol>`. */
  id: string;
  /** `<repoDir>::<file>`. */
  file: string;
  name: string;
  kind: Declaration["kind"];
  signature: string;
  span: [number, number];
  exported: boolean;
  package: string;
  /** `<repoDir>::<.greplost-relative card path>`, or `""` when the file has no card. */
  card: string;
  /** Workspace ids of files importing the declaring file and naming this symbol. */
  importers: string[];
  /** Workspace symbol ids that call this declaration. */
  callers: string[];
}

/** The file block, present when the needle named an indexed file. */
export interface WorkspaceQueryFile {
  path: string;
  package: string;
  card: string;
  exports: string[];
  /** Workspace ids this file imports, cross-repo targets included. */
  imports: string[];
  /** Workspace ids importing this file, cross-repo importers included. */
  importers: string[];
  fanIn: number;
  fanOut: number;
  blast: number;
  loc: number;
}

export interface WorkspaceQueryResult {
  query: string;
  matches: WorkspaceQueryMatch[];
  file?: WorkspaceQueryFile;
}

/**
 * Every declaration in the workspace that `needle` names.
 *
 * The union of each repo's `findSymbols`, so the matching rules (exact id, then
 * exact name, then dotted suffix) are core's and cannot drift from the
 * single-repo command. Results are ordered by (repo, id): repos in directory
 * order, and within a repo by symbol id, which is the order the ruling fixes.
 *
 * A needle that names an indexed file — `repo-a::src/index.ts`, or the path on
 * disk — answers with that file's declarations and its file block instead, the
 * same way the single-repo command does.
 */
export async function queryAcross(root: string, needle: string): Promise<WorkspaceQueryResult> {
  const repos = readWorkspaceRepos(root);
  const asFile = needle === "" ? undefined : resolveWorkspaceTarget(root, needle, repos);

  const matches: WorkspaceQueryMatch[] = [];
  const pairs = workspacePairs(repos);

  for (const repo of repos) {
    const declarations = declarationsOf(repo, needle, asFile);
    if (declarations.length === 0) continue;

    const byTarget = importEdgesByTarget(repo, declarations);
    for (const decl of declarations) {
      matches.push(describe(repo, decl, byTarget));
    }
  }

  const result: WorkspaceQueryResult = { query: needle, matches };
  if (asFile !== undefined) {
    const file = describeFile(repos, pairs, asFile);
    if (file !== undefined) result.file = file;
  }
  return result;
}

/** This repo's contribution to the match list, sorted by symbol id. */
function declarationsOf(repo: RepoView, needle: string, asFile: string | undefined): Declaration[] {
  if (asFile !== undefined) {
    const split = splitWorkspaceId(asFile);
    if (split === null || split.repo !== repo.dir) return [];
    return [...repo.symbols.filter((decl) => decl.file === split.local)].sort((a, b) =>
      compareStrings(a.id, b.id),
    );
  }
  return [...findSymbols(repo.symbols, needle)].sort((a, b) => compareStrings(a.id, b.id));
}

function describe(repo: RepoView, decl: Declaration, byTarget: Map<string, ImportEdge[]>): WorkspaceQueryMatch {
  const entry = repo.manifest?.files[decl.file];
  return {
    id: workspaceId(repo.dir, decl.id),
    file: workspaceId(repo.dir, decl.file),
    name: decl.name,
    kind: decl.kind,
    signature: decl.signature,
    span: decl.span,
    exported: decl.exported,
    package: entry?.pkg ?? "",
    card: cardOf(repo, decl.file),
    importers: symbolImporters(repo, byTarget.get(decl.file) ?? [], decl),
    callers: callersOf(repo.calls, decl.id).map((id) => workspaceId(repo.dir, id)),
  };
}

/** Import and re-export edges into each declaring file, indexed once per repo. */
function importEdgesByTarget(repo: RepoView, declarations: readonly Declaration[]): Map<string, ImportEdge[]> {
  const wanted = new Set(declarations.map((decl) => decl.file));
  const byTarget = new Map<string, ImportEdge[]>();
  if (wanted.size === 0) return byTarget;

  for (const edge of repo.imports) {
    if (edge.kind !== "import" && edge.kind !== "reexport") continue;
    if (!wanted.has(edge.to)) continue;
    const bucket = byTarget.get(edge.to);
    if (bucket === undefined) byTarget.set(edge.to, [edge]);
    else bucket.push(edge);
  }
  return byTarget;
}

/**
 * Files naming this symbol when they import its file, workspace-qualified.
 *
 * The same rule the single-repo command uses: the exported name is the root of
 * the symbol path, a namespace import (`*`) names everything, a side-effect
 * import names nothing. Cross-repo importers are added by `describeFile`'s
 * pair walk, not here — a cross edge records the file it entered the sibling
 * by, and that is the file-level fact, not a per-symbol one.
 */
function symbolImporters(repo: RepoView, edges: readonly ImportEdge[], decl: Declaration): string[] {
  const exportedName = decl.name.split(".")[0] as string;
  const importers = new Set<string>();
  for (const edge of edges) {
    const symbols = edge.symbols ?? [];
    if (symbols.includes("*") || symbols.includes(exportedName)) importers.add(workspaceId(repo.dir, edge.from));
  }
  return [...importers].sort(compareStrings);
}

/** The file block for a workspace file id, or `undefined` when nothing indexes it. */
function describeFile(
  repos: readonly RepoView[],
  pairs: ReadonlyArray<readonly [string, string]>,
  id: string,
): WorkspaceQueryFile | undefined {
  const split = splitWorkspaceId(id);
  if (split === null) return undefined;
  const repo = repos.find((candidate) => candidate.dir === split.repo);
  const entry = repo?.manifest?.files[split.local];
  if (repo === undefined || entry === undefined) return undefined;

  const imports = new Set<string>();
  const importers = new Set<string>();
  for (const [from, to] of pairs) {
    if (from === id) imports.add(to);
    if (to === id) importers.add(from);
  }

  return {
    path: id,
    package: entry.pkg,
    card: cardOf(repo, split.local),
    exports: entry.exports,
    imports: [...imports].sort(compareStrings),
    importers: [...importers].sort(compareStrings),
    fanIn: entry.fanIn,
    fanOut: entry.fanOut,
    blast: entry.blast,
    loc: entry.loc,
  };
}

/**
 * The module card for a repo file, workspace-qualified.
 *
 * `source` is not part of the card-path rule and `cardPath` never reads it; the
 * manifest does not record how a package was discovered, so it is filled with
 * the ordinary case rather than invented per package (the same compromise
 * `packages/cli/src/commands/structure.ts` makes).
 */
function cardOf(repo: RepoView, file: string): string {
  const manifest: Manifest | null = repo.manifest;
  const entry = manifest?.files[file];
  const pkg = entry === undefined ? undefined : manifest?.packages[entry.pkg];
  if (entry === undefined || pkg === undefined) return "";
  const info: PackageInfo = { name: entry.pkg, path: pkg.path, source: "package.json" };
  return workspaceId(repo.dir, cardPath(info, file));
}
