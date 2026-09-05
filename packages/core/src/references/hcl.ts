/**
 * Terraform reference rules (build 2, spec 2026-09-04 sections 0.3 and 2.2).
 *
 * `extractHcl` records the raw address text of every expression that names something; this
 * module decides which node that text means, and at what confidence, or drops it. The rule is
 * the one that governs call edges (tech spec 5.1): `high` when the address resolves to exactly
 * one node, `med` for exactly one documented hop, **anything ambiguous dropped, never guessed**.
 *
 * The scope of every lookup is the *module*, which in Terraform is a directory: `terraform`
 * loads every `.tf` file in one directory as a single module, and an address may never reach
 * out of it. That is what makes a 90-directory corpus repo tractable, `aws_vpc.main` in
 * `examples/complete` cannot be confused with `aws_vpc.main` in `examples/simple`, and it is
 * why the index below is keyed by directory rather than by file.
 *
 * The one documented hop is `module.M.O`: the module call names a directory, and `O` is an
 * `output` node inside it. Every other address is a single lookup inside the caller's own
 * directory.
 *
 * Two address shapes are not chains and are recognised by their shape alone:
 *
 *  - a single segment (`aws`) is a *provider configuration*: the implicit provider of a
 *    resource whose type begins with that name, or an explicit `provider = aws`. It resolves
 *    only when exactly one `provider` block declares that name and carries no alias.
 *  - `provider/<name>` is a `terraform.required_providers` entry and always becomes
 *    `ext:provider/<name>`. The `/` cannot occur in an HCL address, so the two can never be
 *    confused (the sentinel is defined by `extract/hcl.ts`).
 */

import type { Declaration, FileRecord, ReferenceEdge, ReferenceRecord } from "../schema.ts";
import { externalId } from "../schema.ts";
import type { ReferenceContext } from "./link.ts";
import { referenceSource } from "./link.ts";
import { REQUIRED_PROVIDER_PREFIX } from "../extract/hcl.ts";
import { HCL_PROVIDER_NAMESPACE, hclDirectoryOf } from "../resolve/hcl.ts";

/**
 * Declarations of one module (one directory), keyed by the name as written.
 *
 * `Declaration.name` is already the name the file wrote, the `~<n>` uniqueness suffix lives in
 * the id and nowhere else (driver ruling 2026-09-04), so the key needs no unpicking. Two
 * `provider "aws"` blocks in one file therefore land in one bucket and make `aws` genuinely
 * ambiguous, which is the answer: finding only the first would report an ambiguous reference as
 * a certain one.
 */
type ModuleIndex = Map<string, Declaration[]>;

/**
 * Per-build index, built on first use and thrown away with the context that owns it.
 *
 * `linkReferences` calls this module once per reference with the same `ReferenceContext`, so
 * the index is memoised against that object rather than rebuilt for every address.
 */
const INDEX_BY_CONTEXT = new WeakMap<ReferenceContext, Map<string, ModuleIndex>>();

/** `<kind>.<name>` for a node, `const:<name>` for the `terraform` settings block. */
function indexKey(decl: Declaration): string {
  return decl.kind === "const" ? `const:${decl.name}` : `${decl.kind}.${decl.name}`;
}

function indexFor(ctx: ReferenceContext): Map<string, ModuleIndex> {
  const cached = INDEX_BY_CONTEXT.get(ctx);
  if (cached !== undefined) return cached;

  const byDirectory = new Map<string, ModuleIndex>();
  for (const record of ctx.recordByPath.values()) {
    if (record.lang !== "hcl") continue;
    const dir = hclDirectoryOf(record.path);
    let module = byDirectory.get(dir);
    if (module === undefined) {
      module = new Map<string, Declaration[]>();
      byDirectory.set(dir, module);
    }
    for (const decl of record.decls) {
      const key = indexKey(decl);
      const bucket = module.get(key);
      if (bucket === undefined) module.set(key, [decl]);
      else bucket.push(decl);
    }
  }

  INDEX_BY_CONTEXT.set(ctx, byDirectory);
  return byDirectory;
}

/** The one declaration `key` names in `directory`, or null when there is not exactly one. */
function only(index: Map<string, ModuleIndex>, directory: string, key: string): Declaration | null {
  const found = index.get(directory)?.get(key);
  if (found === undefined || found.length !== 1) return null;
  return found[0] as Declaration;
}

/**
 * The provider configuration `name` means in `directory`, when it is unambiguous.
 *
 * `alias` is the alias the address asked for, or null for the default configuration. Spec 2.2
 * fixes the rule for the implicit case: `high` only when exactly one `provider` block declares
 * that name and carries no alias.
 */
function providerConfig(
  index: Map<string, ModuleIndex>,
  directory: string,
  name: string,
  alias: string | null,
): Declaration | null {
  const candidates = index.get(directory)?.get(`provider.${name}`) ?? [];
  const matching = candidates.filter((decl) => (decl.meta?.["alias"] ?? null) === alias);
  return matching.length === 1 ? (matching[0] as Declaration) : null;
}

/** The module directory a local `module` call points at, or null when it is not local. */
function moduleDirectory(file: FileRecord, call: Declaration, ctx: ReferenceContext): string | null {
  const source = call.meta?.["source"];
  if (source === undefined || source === "") return null;
  const target = ctx.resolver.resolve(file.path, source, "hcl");
  return target.type === "file" ? target.path : null;
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
    // The language-native address that produced the edge, so a card can show *why* it exists.
    symbols: [ref.to],
    confidence,
  };
}

/**
 * A `module` block's source: the module directory for a local path, `ext:module/<source>` for
 * a registry or git address, and nothing at all for a local path the map does not index.
 */
function resolveUses(file: FileRecord, ref: ReferenceRecord, ctx: ReferenceContext): ReferenceEdge | null {
  const target = ctx.resolver.resolve(file.path, ref.to, "hcl");
  if (target.type === "file") return edge(file, ref, target.path, "high");
  if (target.type === "external") return edge(file, ref, externalId(target.pkg), "high");
  return null;
}

function resolveAddress(file: FileRecord, ref: ReferenceRecord, ctx: ReferenceContext): ReferenceEdge | null {
  const index = indexFor(ctx);
  const directory = hclDirectoryOf(file.path);

  // `terraform.required_providers` entries: always an external provider (spec 2.2).
  if (ref.to.startsWith(REQUIRED_PROVIDER_PREFIX)) {
    const name = ref.to.slice(REQUIRED_PROVIDER_PREFIX.length);
    if (name === "") return null;
    return edge(file, ref, externalId(`${HCL_PROVIDER_NAMESPACE}${name}`), "high");
  }

  const segments = ref.to.split(".");
  const head = segments[0] as string;

  // A single segment is a provider configuration with no alias: `provider = aws`, or the
  // implicit provider a resource takes from its type prefix.
  if (segments.length === 1) {
    const provider = providerConfig(index, directory, head, null);
    return provider === null ? null : edge(file, ref, provider.id, "high");
  }

  switch (head) {
    case "var": {
      const variable = only(index, directory, `variable.${segments[1] as string}`);
      return variable === null ? null : edge(file, ref, variable.id, "high");
    }
    case "local": {
      const entry = only(index, directory, `local.${segments[1] as string}`);
      return entry === null ? null : edge(file, ref, entry.id, "high");
    }
    case "data": {
      // `data.<type>.<name>`: three segments at the very least.
      if (segments.length < 3) return null;
      const source = only(index, directory, `data.${segments[1] as string}.${segments[2] as string}`);
      return source === null ? null : edge(file, ref, source.id, "high");
    }
    case "module": {
      const call = only(index, directory, `module.${segments[1] as string}`);
      if (call === null) return null;
      // `module.M` on its own (a `depends_on` entry) names the module call itself.
      if (segments.length === 2) return edge(file, ref, call.id, "high");
      // `module.M.O` is the one documented hop: through the module call, into the directory it
      // names, onto that module's `output` node. A registry module has no indexed outputs, so
      // the hop simply does not land and the reference is dropped.
      const target = moduleDirectory(file, call, ctx);
      if (target === null) return null;
      const output = only(index, target, `output.${segments[2] as string}`);
      return output === null ? null : edge(file, ref, output.id, "med");
    }
    default: {
      // A managed resource, `<type>.<name>[.attr…]`.
      const resource = only(index, directory, `resource.${head}.${segments[1] as string}`);
      if (resource !== null) return edge(file, ref, resource.id, "high");
      // Otherwise the only other two-segment address that names a block is an aliased provider
      // configuration, `aws.west`, written in a `provider =` meta-argument.
      const provider = providerConfig(index, directory, head, segments[1] as string);
      return provider === null ? null : edge(file, ref, provider.id, "high");
    }
  }
}

/**
 * One Terraform reference, resolved to the node it names, or null when it names no single one.
 *
 * Never returns an `unresolved:` target: an address the map cannot place is not an edge at all
 * (spec section 0.3).
 */
export function resolveHclReferences(
  file: FileRecord,
  ref: ReferenceRecord,
  ctx: ReferenceContext,
): ReferenceEdge | null {
  if (ref.refKind === "uses") return resolveUses(file, ref, ctx);
  if (ref.refKind !== "hcl-ref") return null;
  return resolveAddress(file, ref, ctx);
}
