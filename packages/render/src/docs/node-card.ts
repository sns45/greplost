/**
 * greplost:render node card,
 * `packages/<slug>/modules/<file>/<nodeSlug(kind, name)>.md` (spec 4.4).
 *
 * One card per non-file node: a Terraform resource or module, a workflow job or
 * step, a Dockerfile stage, a Kubernetes document, a framework route, a Pulumi
 * resource. The card is generic over `NODE_KINDS` and reads nothing but the
 * `Declaration` and the reference edges, so a language leaf that adds a kind
 * gets cards for free and this file never grows a per-language branch.
 *
 * It is a sibling of its file's card, and **no path here ever contains a `#`**:
 * a `#` in a Markdown link is a URL fragment, so a card at
 * `main.tf#resource.x.md` would leave every inbound link silently pointing at
 * the wrong page and nothing would fail loudly.
 */

import type { Declaration, ReferenceEdge } from "@greplost/core/schema";
import { compareStrings, isNodeDeclaration, splitNodeId } from "@greplost/core/schema";

import type { DocContext } from "../render.ts";
import { packageDir, relLink } from "../slug.ts";

/** Entries listed in `**References:**` / `**Referenced by:**` before the tail (spec 4.4). */
export const REFERENCE_CAP = 50;

export function buildNodeCard(ctx: DocContext, id: string): string {
  const parts = splitNodeId(id);
  const decl = parts === null ? undefined : ctx.declById.get(id);
  if (parts === null || decl === undefined || !isNodeDeclaration(decl)) {
    throw new Error(`greplost: no node card for ${id}: not a node this map declares`);
  }
  const pkg = ctx.packageOf(parts.file);
  const self = ctx.nodeCardPathOf(id);
  if (pkg === undefined || self === undefined) {
    throw new Error(`greplost: no node card for ${id}: ${parts.file} belongs to no package`);
  }
  const link = (target: string): string => relLink(self, target);

  // One block per field, joined by blank lines, exactly as the module card
  // does: repository Markdown treats a single newline as a space, so bare
  // newlines would run the whole card together as one wrapped paragraph.
  const fileCard = ctx.cardPathOf(parts.file);
  const inFile = fileCard === undefined ? `\`${parts.file}\`` : `[\`${parts.file}\`](${link(fileCard)})`;
  const blocks: string[] = [
    `# ${id}`,
    ctx.generatedLine,
    `**Kind:** \`${parts.kind}\`  **In file:** ${inFile}`,
    `**Package:** \`${pkg.name}\` ([map](${link(`${packageDir(pkg.name)}/MAP.md`)}))`,
  ];

  const attributes = attributesField(decl);
  if (attributes !== undefined) blocks.push(`**Attributes:** ${attributes}`);

  const from = ctx.referencesFrom.get(id) ?? [];
  const to = ctx.referencesTo.get(id) ?? [];
  blocks.push(`**References:** ${edgesField(ctx, from, (edge) => edge.to, parts.file, link)}`);
  blocks.push(`**Referenced by:** ${edgesField(ctx, to, (edge) => edge.from, parts.file, link)}`);

  // Nodes, not files, and over imports *plus* reference edges, the file card's
  // `**Blast radius:** N files` is the manifest's import-only figure, and the
  // two are deliberately different questions about the same source line.
  const blast = ctx.nodeBlast.get(id) ?? 0;
  blocks.push(`**Blast radius:** ${blast} node(s) (\`greplost impact ${id}\`)`);
  blocks.push(`**Source:** L${decl.span[0]}-${decl.span[1]}`);

  return `${blocks.map((b) => b.replace(/\n+$/, "")).join("\n\n")}\n`;
}

/**
 * `meta` in sorted key order as `` `k: v` `` joined by `, `, or undefined when
 * the node carries none. `meta` is the only place a language puts an attribute
 * with no other home (a resource type, a route method, a base image), so this
 * is what makes the card useful without teaching it any one language.
 */
function attributesField(decl: Declaration): string | undefined {
  const meta = decl.meta;
  if (meta === undefined) return undefined;
  const keys = Object.keys(meta).sort(compareStrings);
  if (keys.length === 0) return undefined;
  return keys.map((key) => `\`${key}: ${meta[key]}\``).join(", ");
}

/**
 * One reference list, sorted by the id at the far end, capped, each entry
 * labelled with its `refKind`.
 *
 * The label is the id's `<kind>.<name>` half when the target lives in the same
 * file, and the full id otherwise, so a cross-file edge says which file it
 * crossed to. Spec 4.4's example renders the bare name (`aws_kms_key.logs`);
 * that was amended in fix round 1 because the bare name of a `local`, a
 * `provider` or a `module` is a single opaque word, `tags`, `aws`, `logs`,
 * with nothing to say what kind of thing it is. The kind-qualified form is also
 * exactly what the file card's Nodes block prints, so one node reads the same
 * on both cards, and it is unique within a file by construction (the `~<n>`
 * duplicate suffix lives in the id), so no two entries can collide.
 */
function edgesField(
  ctx: DocContext,
  edges: readonly ReferenceEdge[],
  endpoint: (edge: ReferenceEdge) => string,
  file: string,
  link: (target: string) => string,
): string {
  if (edges.length === 0) return "None.";
  const sorted = [...edges].sort(
    (a, b) => compareStrings(endpoint(a), endpoint(b)) || compareStrings(a.refKind, b.refKind),
  );
  const shown = sorted.slice(0, REFERENCE_CAP);

  const listed = shown
    .map((edge) => {
      const target = endpoint(edge);
      const label = shortLabel(target, file);
      const card = cardFor(ctx, target);
      const body = card === undefined ? `\`${label}\`` : `[\`${label}\`](${link(card)})`;
      return `${body} (${edge.refKind})`;
    })
    .join(", ");
  // Same tail as the module card's Key symbols and Imported by, so a reader
  // learns one convention rather than three.
  return sorted.length > shown.length ? `${listed}, … ${sorted.length - shown.length} more` : listed;
}

/**
 * The artifact a reference endpoint links to, or undefined when it has none: an
 * `ext:` id, a directory a language resolved a module source to, or a node the
 * map mentions but does not declare. A link is only ever written to a card this
 * render actually emits.
 */
function cardFor(ctx: DocContext, target: string): string | undefined {
  const decl = ctx.declById.get(target);
  // A plain symbol has no card of its own, so an edge that names one (a route
  // handler, say) links to the module card that documents it.
  if (decl !== undefined) return isNodeDeclaration(decl) ? ctx.nodeCardPathOf(target) : ctx.cardPathOf(decl.file);
  return target.includes("#") ? undefined : ctx.cardPathOf(target);
}

/**
 * A reference endpoint as a card reads it: `<kind>.<name>` at home, the full id
 * abroad. Taken off the id rather than the declaration, so it is right even for
 * a target the map mentions without declaring.
 */
function shortLabel(target: string, file: string): string {
  const parts = splitNodeId(target);
  if (parts === null || parts.file !== file) return target;
  return target.slice(target.indexOf("#") + 1);
}
