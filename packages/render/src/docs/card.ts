/**
 * greplost:render module card, `packages/<slug>/modules/<rel>.md`
 * (tech spec 4.3, render spec "Documents").
 *
 * One card per source file: the summary (with the staleness banner when the
 * code moved on), the package it belongs to, what it exports, what it imports,
 * who imports it, its blast radius, its declarations and its resolved calls.
 * The only date this file can ever emit is `SummaryEntry.refreshedAt`, and only
 * on the banner line.
 */

import type { CallEdge, Confidence, ImportRecord } from "@greplost/core/schema";
import { compareStrings } from "@greplost/core/schema";

import type { DocContext } from "../render.ts";
import { packageDir, relLink } from "../slug.ts";
import { exportEntry, keySymbol, shortName } from "./api.ts";

/** Tech spec 4.3: a card lists at most this many declarations, then says how many were dropped. */
const KEY_SYMBOL_CAP = 50;

const NO_SUMMARY = "No summary yet; run `greplost refresh`.";

export function buildCard(ctx: DocContext, file: string): string {
  const entry = ctx.fileEntry(file);
  const pkg = ctx.packageOf(file);
  if (entry === undefined || pkg === undefined) {
    throw new Error(`greplost: no module card for unknown file ${file}`);
  }
  const self = ctx.cardPathOf(file) ?? "";
  const link = (target: string | undefined): string | undefined =>
    target === undefined ? undefined : relLink(self, target);

  const blocks: string[] = [`# ${file}`, ctx.generatedLine, summaryBlock(ctx, file)];

  const fields: string[] = [];
  const mapLink = relLink(self, `${packageDir(pkg.name)}/MAP.md`);
  fields.push(`**Package:** \`${pkg.name}\` ([map](${mapLink}))`);
  fields.push(`**Exports:** ${exportsField(ctx, file)}`);
  fields.push(`**Imports:** ${importsField(ctx, file, link)}`);
  fields.push(`**Imported by:** ${importersField(ctx, file, link)}`);
  const blast = `${entry.blast} file${entry.blast === 1 ? "" : "s"}`;
  fields.push(`**Blast radius:** ${blast} (\`greplost impact ${file}\`)`);
  fields.push(`**Key symbols:**${keySymbolsField(ctx, file)}`);
  const calls = callsField(ctx, file, link);
  if (calls !== undefined) fields.push(`**Calls:** ${calls}`);
  blocks.push(fields.join("\n"));

  return `${blocks.map((b) => b.replace(/\n+$/, "")).join("\n\n")}\n`;
}

/**
 * Summary rule (render spec): the entry written for the current content when
 * there is one; otherwise, when the manifest reports the summary stale, the
 * last summary written for this path plus the banner; otherwise the
 * placeholder. `summaryHash` is what the core build resolved, so the card never
 * re-scans the cache.
 */
function summaryBlock(ctx: DocContext, file: string): string {
  const entry = ctx.fileEntry(file);
  if (entry === undefined) return `> ${NO_SUMMARY}`;

  const fresh = ctx.summaries[entry.sha256];
  if (fresh !== undefined) return `> ${fresh.text}`;

  if (entry.staleSummary) {
    const previous = entry.summaryHash === undefined ? undefined : ctx.summaries[entry.summaryHash];
    const text = previous?.text ?? NO_SUMMARY;
    const refreshedAt = previous?.refreshedAt;
    const banner =
      refreshedAt === undefined
        ? "> summary may lag code"
        : `> summary may lag code, last refreshed ${refreshedAt}`;
    return `> ${text}\n${banner}`;
  }

  return `> ${NO_SUMMARY}`;
}

function exportsField(ctx: DocContext, file: string): string {
  const names = ctx.fileEntry(file)?.exports ?? [];
  if (names.length === 0) return "None.";
  const byName = new Map<string, string>();
  for (const decl of ctx.declsOf.get(file) ?? []) {
    if (decl.parent !== undefined) continue;
    const short = shortName(decl.name);
    if (!byName.has(short)) byName.set(short, exportEntry(decl));
  }
  // A re-exported name has no local declaration to describe, so it is listed
  // bare; `manifest.files[f].exports` is the authoritative name set either way.
  return names.map((name) => `\`${byName.get(name) ?? name}\``).join(", ");
}

interface ImportGroup {
  specifier: string;
  symbols: Set<string>;
}

/**
 * Groups by specifier in source order of first appearance, symbols sorted. The
 * specifier links to the target's card when the target is a repo file, is left
 * bare for an external package, and is marked `(unresolved)` when the resolver
 * could not place it.
 */
function importsField(
  ctx: DocContext,
  file: string,
  link: (target: string | undefined) => string | undefined,
): string {
  const records: ImportRecord[] = ctx.recordOf.get(file)?.imports ?? [];
  const groups: ImportGroup[] = [];
  const bySpecifier = new Map<string, ImportGroup>();
  for (const record of records) {
    let group = bySpecifier.get(record.specifier);
    if (group === undefined) {
      group = { specifier: record.specifier, symbols: new Set() };
      bySpecifier.set(record.specifier, group);
      groups.push(group);
    }
    for (const symbol of record.symbols) group.symbols.add(symbol.name);
  }
  if (groups.length === 0) return "None.";

  const targets = new Map<string, string>();
  for (const edge of ctx.importsFrom.get(file) ?? []) {
    if (!targets.has(edge.specifier)) targets.set(edge.specifier, edge.to);
  }

  return groups
    .map((group) => {
      const target = targets.get(group.specifier);
      const card = target === undefined ? undefined : ctx.cardPathOf(target);
      const label =
        card === undefined ? `\`${group.specifier}\`` : `[\`${group.specifier}\`](${link(card)})`;
      if (target !== undefined && target.startsWith("unresolved:")) return `${label} (unresolved)`;
      const symbols = [...group.symbols].sort(compareStrings);
      return symbols.length === 0 ? label : `${label} (${symbols.join(", ")})`;
    })
    .join(", ");
}

function importersField(
  ctx: DocContext,
  file: string,
  link: (target: string | undefined) => string | undefined,
): string {
  const importers = ctx.importersOf.get(file) ?? [];
  if (importers.length === 0) return "None.";
  return importers
    .map((importer) => {
      const card = ctx.cardPathOf(importer);
      return card === undefined ? `\`${importer}\`` : `[\`${importer}\`](${link(card)})`;
    })
    .join(", ");
}

function keySymbolsField(ctx: DocContext, file: string): string {
  const decls = ctx.declsOf.get(file) ?? [];
  if (decls.length === 0) return " None.";
  const shown = decls.slice(0, KEY_SYMBOL_CAP);
  const lines = shown.map((d) => `- \`${keySymbol(d)}\`  L${d.span[0]}-${d.span[1]}`);
  if (decls.length > shown.length) lines.push(`- … ${decls.length - shown.length} more`);
  return `\n${lines.join("\n")}`;
}

const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = { high: 2, med: 1 };

/**
 * Resolved calls leaving this file, one entry per distinct callee, strongest
 * confidence first when the same callee is reached both ways. Omitted entirely
 * when the file has no resolved call edges.
 */
function callsField(
  ctx: DocContext,
  file: string,
  link: (target: string | undefined) => string | undefined,
): string | undefined {
  const calls: CallEdge[] = ctx.callsFrom.get(file) ?? [];
  if (calls.length === 0) return undefined;

  const best = new Map<string, Confidence>();
  for (const call of calls) {
    const current = best.get(call.to);
    if (current === undefined || CONFIDENCE_RANK[call.confidence] > CONFIDENCE_RANK[current]) {
      best.set(call.to, call.confidence);
    }
  }

  const entries = [...best.entries()].sort((a, b) => compareStrings(a[0], b[0]));
  return entries
    .map(([target, confidence]) => {
      const hash = target.indexOf("#");
      const targetFile = hash === -1 ? target : target.slice(0, hash);
      const symbol = hash === -1 ? target : target.slice(hash + 1);
      const card = ctx.cardPathOf(targetFile);
      const label = card === undefined ? `\`${target}\`` : `[\`${target}\`](${link(card)})`;
      return `\`${shortName(symbol)}\` → ${label} (${confidence})`;
    })
    .join(", ");
}
