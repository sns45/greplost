/**
 * greplost:semantic flow selection and `FLOWS.md` (tech spec 6; semantic spec
 * "Rules").
 *
 * `FLOWS.md` answers the question a new engineer asks first and a card can
 * never answer: not "what is this module", but "what happens when something
 * arrives". That is a question about entry points, so the only judgement
 * greplost makes on its own is which files are entry points; what happens after
 * one is reached is the model's to describe.
 *
 * The heuristic is deliberately narrow and entirely deterministic. An entry
 * point is a file nothing in the repository imports (`fanIn === 0`) that either
 * is named like a program's front door or exports one of the three names a
 * runtime calls (`main`, `handler`, `fetch`). Those are ranked by downstream
 * reach — the size of the transitive import closure below them — because the
 * entry point that touches the most of the package is the one whose flow
 * explains the most of it, and the top five survive. A library package with no
 * such file gets no flows and no document, which is the honest answer: nothing
 * calls into it on its own.
 *
 * Everything here is pure. `renderFlows` takes the flows it is given and emits
 * bytes; the only date it can ever write is the one it is handed, on the banner
 * line, exactly as the layer rule requires (tech spec 4.1, 5.3).
 */

import type { PackageInfo, Snapshot } from "@greplost/core/schema";
import { compareStrings } from "@greplost/core/schema";
import { expandDirectoryTargets } from "@greplost/core/graph";

/** One step of a flow: a file, optionally a symbol inside it, and what happens there. */
export interface FlowStep {
  file: string;
  symbol?: string;
  note: string;
}

/** One flow through a package: a title, ordered steps, and a `sequenceDiagram` body. */
export interface Flow {
  title: string;
  steps: FlowStep[];
  /** Mermaid `sequenceDiagram` body, without a code fence. */
  mermaid: string;
}

/** Front-door file names (semantic spec "Rules"). */
const ENTRY_BASENAME = /^(main|index|server|app|cli|worker|handler)\./;

/** Exported names a runtime calls without anything in the repo importing them. */
const ENTRY_EXPORTS: ReadonlySet<string> = new Set(["main", "handler", "fetch"]);

/** Entry points one package's `FLOWS.md` is built from. */
export const MAX_ENTRY_POINTS = 5;

/** Import hops the flows prompt describes around an entry point. */
export const REACH_DEPTH = 3;

/**
 * The files in `pkg` that a flow could start from, best first.
 *
 * Ties are broken by path so the answer never depends on manifest iteration
 * order: two entry points with the same reach have to come back in the same
 * order on every machine, or `FLOWS.md` is not reproducible.
 */
export function selectEntryPoints(snapshot: Snapshot, pkg: PackageInfo): string[] {
  const { graph, exported } = derived(snapshot);

  const candidates: Array<{ file: string; reach: number }> = [];
  for (const file of Object.keys(snapshot.manifest.files).sort(compareStrings)) {
    const entry = snapshot.manifest.files[file];
    if (entry === undefined || entry.pkg !== pkg.name || entry.fanIn !== 0) continue;
    if (!ENTRY_BASENAME.test(basename(file)) && !exported.has(file)) continue;
    candidates.push({ file, reach: reachableFrom(graph, file).size });
  }

  candidates.sort((a, b) => b.reach - a.reach || compareStrings(a.file, b.file));
  return candidates.slice(0, MAX_ENTRY_POINTS).map((candidate) => candidate.file);
}

/**
 * The two whole-repository indexes `selectEntryPoints` needs, computed once per
 * snapshot.
 *
 * A monorepo asks for entry points once per package, and both indexes are
 * linear in the whole graph rather than in one package, so recomputing them
 * per call would make flow selection quadratic in the number of packages for
 * no reason. Keyed weakly on the snapshot, which is the value both are derived
 * from and which nothing downstream is allowed to mutate (PLAN.md, ruling
 * 2026-09-02).
 */
const DERIVED = new WeakMap<Snapshot, { graph: Map<string, string[]>; exported: Set<string> }>();

function derived(snapshot: Snapshot): { graph: Map<string, string[]>; exported: Set<string> } {
  const cached = DERIVED.get(snapshot);
  if (cached !== undefined) return cached;
  const computed = { graph: buildImportGraph(snapshot), exported: exportedEntryNames(snapshot) };
  DERIVED.set(snapshot, computed);
  return computed;
}

/**
 * Forward import adjacency over `import` and `reexport` edges, with Go package
 * directories expanded to their files (tech spec Appendix C). Sorted, so a
 * breadth-first walk over it is deterministic.
 *
 * Shared and read-only: one instance is derived per snapshot and handed to
 * every caller, so mutating it would corrupt the next question asked.
 */
export function importGraph(snapshot: Snapshot): ReadonlyMap<string, readonly string[]> {
  return derived(snapshot).graph;
}

function buildImportGraph(snapshot: Snapshot): Map<string, string[]> {
  const files = Object.keys(snapshot.manifest.files);
  const graph = new Map<string, string[]>();
  for (const [from, to] of expandDirectoryTargets(snapshot.imports, files)) {
    const bucket = graph.get(from);
    if (bucket === undefined) graph.set(from, [to]);
    else if (!bucket.includes(to)) bucket.push(to);
  }
  for (const bucket of graph.values()) bucket.sort(compareStrings);
  return graph;
}

/**
 * Files reachable from `file`, excluding itself, in breadth-first order.
 * `depth` caps the number of hops; the default is the whole closure, which is
 * what "downstream reach" means when entry points are ranked.
 */
export function reachableFrom(
  graph: ReadonlyMap<string, readonly string[]>,
  file: string,
  depth = Number.POSITIVE_INFINITY,
): Set<string> {
  const seen = new Set<string>([file]);
  const reached = new Set<string>();
  let frontier = [file];
  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const target of graph.get(current) ?? []) {
        if (seen.has(target)) continue;
        seen.add(target);
        reached.add(target);
        next.push(target);
      }
    }
    frontier = next;
  }
  return reached;
}

/** Resolved call edges whose caller and callee both sit inside `files`, as prompt lines. */
export function callLines(snapshot: Snapshot, files: ReadonlySet<string>): string[] {
  const lines: string[] = [];
  for (const call of snapshot.calls) {
    if (!files.has(fileOf(call.from)) || !files.has(fileOf(call.to))) continue;
    lines.push(`${call.from} -> ${call.to} (${call.confidence})`);
  }
  return [...new Set(lines)].sort(compareStrings);
}

/**
 * `FLOWS.md` for one package: the title, the semantic-layer banner, and one
 * section per flow with its numbered steps and its fenced diagram.
 *
 * `today` is passed in rather than read from the clock so that the document is
 * a pure function of its inputs; the default exists only for a caller that
 * genuinely means "now".
 */
export function renderFlows(pkg: PackageInfo, flows: readonly Flow[], today = isoDate(new Date())): string {
  const blocks: string[] = [
    `# Flows: ${pkg.name}`,
    `> Semantic layer, refreshed ${today}; may lag code.`,
  ];

  for (const flow of flows) {
    blocks.push(`## ${flow.title}`);
    blocks.push(flow.steps.map((step, index) => `${index + 1}. ${renderStep(step)}`).join("\n"));
    blocks.push(["```mermaid", flow.mermaid, "```"].join("\n"));
  }

  return `${blocks.join("\n\n")}\n`;
}

/** `` 1. `path` (`symbol`): note `` — the symbol is dropped when the model named none. */
function renderStep(step: FlowStep): string {
  const where = step.symbol === undefined ? `\`${step.file}\`` : `\`${step.file}\` (\`${step.symbol}\`)`;
  return `${where}: ${step.note}`;
}

/** `YYYY-MM-DD`, the only date shape the semantic layer ever writes. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Files that export one of the names a runtime *calls* directly.
 *
 * The name alone is not enough: `export const fetch = 5` is a constant that
 * happens to be called `fetch`, and treating it as a front door would put a
 * module of numbers at the head of a flow. So the declaration has to be
 * callable — a `function`, or a `const`/`let` bound to an arrow or a function
 * expression, which is how the extractor records `export const handler = async
 * () => {}` and `export const fetch = function () {}`. The signature is the
 * header as written, so the `=>` or the `function` keyword is in it and the
 * body is not.
 */
function exportedEntryNames(snapshot: Snapshot): Set<string> {
  const files = new Set<string>();
  for (const decl of snapshot.symbols) {
    if (!decl.exported || decl.parent !== undefined) continue;
    if (!ENTRY_EXPORTS.has(decl.name)) continue;
    if (decl.kind === "function") {
      files.add(decl.file);
      continue;
    }
    if (decl.kind !== "const" && decl.kind !== "let") continue;
    if (decl.signature.includes("=>") || decl.signature.includes("function")) files.add(decl.file);
  }
  return files;
}

function basename(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? file : file.slice(slash + 1);
}

/** The file half of a node id: `<file>#<symbol>` or a bare file. */
function fileOf(id: string): string {
  const hash = id.indexOf("#");
  return hash === -1 ? id : id.slice(0, hash);
}
