/**
 * Reference linking (build 2, spec 2026-09-04 section 0.3; owned by the seam, leaf 2.0).
 *
 * A reference is a dependency that is neither an import nor a call: a Terraform expression
 * naming another resource, a Kubernetes Service selecting a workload, a workflow job that
 * `needs` another, a Dockerfile's base image. `FileRecord.refs` holds them as the extractor saw
 * them — language-native text, never a node id — and this module turns them into
 * `ReferenceEdge`s by dispatching on the owning file's `lang`.
 *
 * Two rules from the spec are enforced here rather than in every language module, so no
 * language can get them wrong on its own:
 *
 *  - an edge may never target `unresolved:`; an unresolvable reference is simply not emitted;
 *  - the result is deduplicated and sorted by `(from, to, refKind, symbols joined by ",")`,
 *    which is the order `graph/references.jsonl` is written in.
 *
 * Confidence is the language module's call, and the rule is the same one that governs call
 * edges: `high` for a unique resolution, `med` for exactly one documented hop, anything
 * ambiguous dropped rather than guessed.
 */

import type {
  DeclKind,
  Declaration,
  FileRecord,
  Lang,
  ReferenceEdge,
  ReferenceRecord,
} from "../schema.ts";
import { compareStrings, isNodeKind, symbolId } from "../schema.ts";
import type { RepoContext, Resolver } from "../resolve/resolver.ts";
import { resolveDockerfileReferences } from "./dockerfile.ts";
import { resolveHclReferences } from "./hcl.ts";
import { resolveYamlReferences } from "./yaml.ts";

/** What a per-language reference rule is allowed to look at. */
export interface ReferenceContext {
  /** Every indexed file, by repo-relative path. */
  readonly recordByPath: ReadonlyMap<string, FileRecord>;
  /** Every declaration in the build, by id — the lookup a resolved reference lands on. */
  readonly declarationById: ReadonlyMap<string, Declaration>;
  /** Non-file nodes grouped by kind, for rules that search a kind (`selector`, `config-ref`). */
  readonly nodesByKind: ReadonlyMap<DeclKind, readonly Declaration[]>;
  /** The build's specifier resolver, for a reference that names a file or a package. */
  readonly resolver: Resolver;
  /** The indexed file set. A reference to a file outside it does not resolve. */
  readonly files: ReadonlySet<string>;
}

/** One language's reference rules. `null` means "this reference does not resolve; drop it". */
export type ReferenceRule = (
  file: FileRecord,
  ref: ReferenceRecord,
  ctx: ReferenceContext,
) => ReferenceEdge | null;

/**
 * Reference rules by the owning file's language.
 *
 * `Partial` on purpose: most languages express dependencies as imports and calls and produce no
 * `ReferenceRecord` at all. A language that *does* produce one and has no entry here is a
 * mistake worth an error, not a silent drop — see `linkReferences`.
 */
const REFERENCE_RULES: Readonly<Partial<Record<Lang, ReferenceRule>>> = {
  hcl: resolveHclReferences,
  yaml: resolveYamlReferences,
  dockerfile: resolveDockerfileReferences,
};

/**
 * The node id a reference starts from: the owning declaration when `ref.from` names one, and
 * the file itself when it is `""` (a file-level reference).
 *
 * Shared so every language spells the `from` side the same way. `ref.from` is a local symbol
 * path for a symbol node and a `<kind>.<name>` pair for a non-file node; both are already the
 * text after the `#`, so `symbolId` is the whole rule.
 */
export function referenceSource(file: string, ref: ReferenceRecord): string {
  return ref.from === "" ? file : symbolId(file, ref.from);
}

/** Sorted by `(from, to, refKind, symbols joined by ",")`, per spec section 0.3. */
export function compareReferenceEdges(a: ReferenceEdge, b: ReferenceEdge): number {
  return (
    compareStrings(a.from, b.from) ||
    compareStrings(a.to, b.to) ||
    compareStrings(a.refKind, b.refKind) ||
    compareStrings((a.symbols ?? []).join(","), (b.symbols ?? []).join(","))
  );
}

/**
 * Every reference edge in a build, sorted and deduplicated.
 *
 * `files` are the extracted records, `resolver` is the build's specifier resolver, and `ctx` is
 * the repo context the resolver was built from; the richer `ReferenceContext` the language
 * rules see is derived from those three so a caller cannot forget to build one.
 */
export function linkReferences(
  files: readonly FileRecord[],
  resolver: Resolver,
  ctx: RepoContext,
): ReferenceEdge[] {
  // Nothing to index, and nothing to walk: a build with no references pays for none of this.
  if (!files.some((file) => file.refs !== undefined && file.refs.length > 0)) return [];

  const context = buildReferenceContext(files, resolver, ctx);
  const edges: ReferenceEdge[] = [];

  for (const file of files) {
    const refs = file.refs;
    if (refs === undefined || refs.length === 0) continue;
    const rule = REFERENCE_RULES[file.lang];
    if (rule === undefined) {
      throw new Error(
        `greplost: ${file.path} produced ${refs.length} reference${refs.length === 1 ? "" : "s"} but ` +
          `there are no reference rules for "${file.lang}" (add packages/core/src/references/${file.lang}.ts)`,
      );
    }
    for (const ref of refs) {
      const edge = rule(file, ref, context);
      if (edge === null) continue;
      // Spec section 0.3: a reference never points at `unresolved:`. A rule that cannot place
      // one returns null; one that returns an unresolved target is a bug, so it is dropped
      // here rather than written into the map.
      if (edge.to.startsWith("unresolved:")) continue;
      edges.push(edge);
    }
  }

  edges.sort(compareReferenceEdges);
  return dedupe(edges);
}

/** Adjacent duplicates only: the list is already sorted by every field that identifies an edge. */
function dedupe(edges: readonly ReferenceEdge[]): ReferenceEdge[] {
  const out: ReferenceEdge[] = [];
  for (const edge of edges) {
    const previous = out[out.length - 1];
    if (previous !== undefined && compareReferenceEdges(previous, edge) === 0) continue;
    out.push(edge);
  }
  return out;
}

function buildReferenceContext(
  files: readonly FileRecord[],
  resolver: Resolver,
  ctx: RepoContext,
): ReferenceContext {
  const recordByPath = new Map<string, FileRecord>();
  const declarationById = new Map<string, Declaration>();
  const nodesByKind = new Map<DeclKind, Declaration[]>();

  for (const file of files) {
    recordByPath.set(file.path, file);
    for (const decl of file.decls) {
      declarationById.set(decl.id, decl);
      if (!isNodeKind(decl.kind)) continue;
      const bucket = nodesByKind.get(decl.kind);
      if (bucket === undefined) nodesByKind.set(decl.kind, [decl]);
      else bucket.push(decl);
    }
  }

  return { recordByPath, declarationById, nodesByKind, resolver, files: ctx.files };
}
