/**
 * GitHub Actions reference rules (build 2, spec 2026-09-04 sections 0.3 and 2.4).
 *
 * `extract/yaml-actions.ts` records what a workflow *asks for*, a job id, an action reference,
 * a word out of a `run:` body, and this module decides which node or file that is, or drops
 * it. The rule is the one that governs call edges (tech spec 5.1): `high` when the request
 * lands on exactly one thing, **anything ambiguous dropped, never guessed**.
 *
 * Three mechanisms, and the scope each searches:
 *
 *  - `needs`, a job id against the `job` and `task` nodes of the **same file**. `needs` is
 *    scoped to one workflow by the format itself, so a job id that also exists in a sibling
 *    workflow is not a candidate; searching wider would draw an edge Actions would never run.
 *  - `uses`, three shapes, following the Terraform `module` precedent (driver ruling
 *    2026-09-04):
 *      * `./path`, a repo-local action or reusable workflow. A directory resolves to the
 *        `action.yml` it holds; a `.yml`/`.yaml` path resolves to that file. A path the index
 *        does not cover resolves to nothing: it is a repo path the map does not carry, and
 *        calling it external would invent a dependency on a marketplace action.
 *      * `owner/repo[/subpath]@ref`, an action outside the repo, `ext:action/<owner>/<repo>`,
 *        with the subpath kept when there is one and the `@ref` kept out of the id. The ref is
 *        a *version*, exactly as a Terraform module's `version` is not part of its source, and
 *        it lives in `meta.usesRef` on the step; the subpath stays because
 *        `github/codeql-action/init` and `github/codeql-action/analyze` are two actions.
 *      * anything else (`docker://…`, an expression), not a repository, so not an edge.
 *  - `config`, a literal token from a `run:` body against the indexed file set. Exactly one
 *    match is `high`; a token matching two paths is two plausible answers, so neither is drawn.
 *    This is the edge that puts a workflow in a script's blast radius (spec 2.4).
 *
 * Nothing here ever returns an `unresolved:` target (spec 0.3): a reference the map cannot
 * place is not an edge at all.
 */

import type { Declaration, FileRecord, ReferenceEdge, ReferenceRecord } from "../schema.ts";
import { externalId } from "../schema.ts";
import type { ReferenceContext } from "./link.ts";
import { referenceSource } from "./link.ts";

/** The `ext:` namespace an action outside the repo lands in (spec section 0.2). */
const ACTION_NAMESPACE = "action/";

/** The two file names GitHub reads a local action's definition from, in the order it tries them. */
const ACTION_FILES: readonly string[] = ["action.yml", "action.yaml"];

/**
 * Per-build indexes, built on first use and thrown away with the context that owns them.
 *
 * `linkReferences` calls this module once per reference with the same `ReferenceContext`, so a
 * repo with 3,000 `run:` tokens walks the file set once rather than 3,000 times.
 */
const JOBS_BY_CONTEXT = new WeakMap<ReferenceContext, ReadonlyMap<string, readonly Declaration[]>>();
const PATHS_BY_CONTEXT = new WeakMap<ReferenceContext, ReadonlyMap<string, readonly string[]>>();

/** `job` and `task` nodes keyed `<file>\u0000<jobId>`, so `needs` never leaves its own file. */
function jobsFor(ctx: ReferenceContext): ReadonlyMap<string, readonly Declaration[]> {
  const cached = JOBS_BY_CONTEXT.get(ctx);
  if (cached !== undefined) return cached;

  const byKey = new Map<string, Declaration[]>();
  for (const kind of ["job", "task"] as const) {
    for (const decl of ctx.nodesByKind.get(kind) ?? []) {
      const key = `${decl.file}\u0000${decl.name}`;
      const bucket = byKey.get(key);
      if (bucket === undefined) byKey.set(key, [decl]);
      else bucket.push(decl);
    }
  }
  JOBS_BY_CONTEXT.set(ctx, byKey);
  return byKey;
}

/**
 * Every indexed path by the tokens that could name it: the whole path, and each of its
 * proper suffixes at a segment boundary.
 *
 * A `run:` body is written from the repo root most of the time and from a subdirectory the rest
 * of it, so `scripts/x.ts` and `x.ts` both have to be able to find `scripts/x.ts`, and a
 * suffix that two files share is exactly the ambiguity spec 2.4 says to drop.
 */
function pathsFor(ctx: ReferenceContext): ReadonlyMap<string, readonly string[]> {
  const cached = PATHS_BY_CONTEXT.get(ctx);
  if (cached !== undefined) return cached;

  const byToken = new Map<string, string[]>();
  const add = (token: string, file: string): void => {
    const bucket = byToken.get(token);
    if (bucket === undefined) byToken.set(token, [file]);
    else if (!bucket.includes(file)) bucket.push(file);
  };
  for (const file of ctx.files) {
    add(file, file);
    let slash = file.indexOf("/");
    while (slash !== -1) {
      add(file.slice(slash + 1), file);
      slash = file.indexOf("/", slash + 1);
    }
  }
  PATHS_BY_CONTEXT.set(ctx, byToken);
  return byToken;
}

function edge(
  file: FileRecord,
  ref: ReferenceRecord,
  to: string,
  confidence: ReferenceEdge["confidence"],
): ReferenceEdge {
  return {
    from: referenceSource(file.path, ref),
    to,
    kind: "reference",
    refKind: ref.refKind,
    // The language-native request that produced the edge, so a card can show *why* it exists.
    symbols: [ref.to],
    confidence,
  };
}

/** A job id against the `job` and `task` nodes of the file that named it. */
function resolveNeeds(file: FileRecord, ref: ReferenceRecord, ctx: ReferenceContext): ReferenceEdge | null {
  const found = jobsFor(ctx).get(`${file.path}\u0000${ref.to}`);
  if (found === undefined || found.length !== 1) return null;
  const target = found[0] as Declaration;
  // A job that needs itself is a workflow that never runs, not a dependency.
  if (referenceSource(file.path, ref) === target.id) return null;
  return edge(file, ref, target.id, "high");
}

/** Join a repo-relative directory with a `./`-prefixed path, or null when it escapes the repo. */
function joinFromFile(fromFile: string, relative: string): string | null {
  const dir = fromFile.slice(0, Math.max(fromFile.lastIndexOf("/"), 0));
  const segments: string[] = [];
  for (const segment of `${dir}/${relative}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join("/");
}

/**
 * A local `uses`; the file it names.
 *
 * A local action reference is resolved **from the repository root**, which is what GitHub
 * itself does: `./.github/actions/setup` in a workflow six directories down still means the
 * repository's own `.github/actions/setup`. A path with a YAML extension is a reusable
 * workflow and names the file; anything else is a directory and names the `action.yml` in it.
 */
function resolveLocalUses(target: string, ctx: ReferenceContext): string | null {
  const root = joinFromFile("", target);
  if (root === null) return null;
  if (root.endsWith(".yml") || root.endsWith(".yaml")) return ctx.files.has(root) ? root : null;
  for (const base of ACTION_FILES) {
    const candidate = `${root}/${base}`;
    if (ctx.files.has(candidate)) return candidate;
  }
  return null;
}

/**
 * An external `uses`, `ext:action/<owner>/<repo>[/<subpath>]`, the ref left out of the id.
 *
 * `owner/repo` is the smallest thing GitHub will resolve, so a single-segment reference is not
 * an action reference at all and produces nothing.
 */
export function externalUsesId(uses: string): string | null {
  const at = uses.lastIndexOf("@");
  const address = at <= 0 ? uses : uses.slice(0, at);
  if (address.includes("://") || address.startsWith(".") || address.startsWith("/")) return null;
  const segments = address.split("/");
  if (segments.length < 2) return null;
  for (const segment of segments) if (segment === "" || segment === "." || segment === "..") return null;
  return externalId(`${ACTION_NAMESPACE}${address}`);
}

/** A step's or a job's `uses`: a repo-local file, or an action outside the repo. */
function resolveUses(file: FileRecord, ref: ReferenceRecord, ctx: ReferenceContext): ReferenceEdge | null {
  if (ref.to.startsWith("./") || ref.to.startsWith("../")) {
    const local = resolveLocalUses(ref.to, ctx);
    return local === null ? null : edge(file, ref, local, "high");
  }
  const external = externalUsesId(ref.to);
  return external === null ? null : edge(file, ref, external, "high");
}

/** A `run:` token that names exactly one indexed path. */
function resolveConfig(file: FileRecord, ref: ReferenceRecord, ctx: ReferenceContext): ReferenceEdge | null {
  const found = pathsFor(ctx).get(ref.to);
  if (found === undefined || found.length !== 1) return null;
  const target = found[0] as string;
  // A workflow naming itself is not a dependency on anything.
  if (target === file.path) return null;
  return edge(file, ref, target, "high");
}

/**
 * One GitHub Actions reference, resolved to the node or file it names, or null when it names no
 * single one.
 */
export function resolveYamlActionsReferences(
  file: FileRecord,
  ref: ReferenceRecord,
  ctx: ReferenceContext,
): ReferenceEdge | null {
  switch (ref.refKind) {
    case "needs":
      return resolveNeeds(file, ref, ctx);
    case "uses":
      return resolveUses(file, ref, ctx);
    case "config":
      return resolveConfig(file, ref, ctx);
    default:
      return null;
  }
}
