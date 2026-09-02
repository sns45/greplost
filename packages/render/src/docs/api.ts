/**
 * greplost:render `packages/<slug>/API.md` (render spec "Documents").
 *
 * Also the home of the declaration-formatting rules shared with the module
 * card: the export entry form (`name(params): ret` for callables, `name (kind)`
 * otherwise), the API bullet form, and the key-symbol form. They live here
 * because API.md is the document whose whole job is rendering signatures;
 * `card.ts` imports them from here, which keeps the docs modules acyclic.
 */

import type { Declaration, ImportRecord, PackageInfo } from "@greplost/core/schema";
import { compareStrings } from "@greplost/core/schema";

import type { DocContext } from "../render.ts";

/**
 * Keywords stripped from the front of a signature before it is rendered.
 *
 * `default` is stripped everywhere, including for key symbols: the render spec
 * names only `export`/`declare` there, but a dangling `default function main()`
 * is plainly not what the card wants, and API.md strips it by name.
 */
const DECLARATION_KEYWORDS: ReadonlySet<string> = new Set(["export", "default", "declare"]);

/** Additionally stripped for an export entry, which shows `name(params): ret`. */
const CALLABLE_KEYWORDS: ReadonlySet<string> = new Set(["export", "default", "declare", "async", "function"]);

/** Leading `word` / `word*` tokens, so `function*` is consumed whole. */
const LEADING_WORD = /^([A-Za-z]+)(\*)?(\s+|$)/;

function stripLeading(signature: string, keywords: ReadonlySet<string>): string {
  let text = signature.trim();
  for (;;) {
    const match = LEADING_WORD.exec(text);
    if (match === null) break;
    if (!keywords.has(match[1] ?? "")) break;
    text = text.slice((match[0] ?? "").length).trimStart();
  }
  return text;
}

/** The last segment of a symbol path: `Registry.register` -> `register`. */
export function shortName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * An arrow-function const reads `const add = (a: number): number =>` as
 * extracted (the extractor keeps the header and drops the body), so the
 * callable form is the name followed by everything between `=` and the final
 * `=>`. Returns undefined for a const that is not a function.
 */
function callableConst(stripped: string): string | undefined {
  const trimmed = stripped.trim();
  if (!trimmed.endsWith("=>")) return undefined;
  const match = /^(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([\s\S]*)=>$/.exec(trimmed);
  if (match === null) return undefined;
  const head = (match[2] ?? "").trim().replace(/^async\s+/, "");
  if (!head.startsWith("(") && !head.startsWith("<")) return undefined;
  return `${match[1] ?? ""}${head}`;
}

/**
 * Card `**Exports:**` entry: functions and callable consts show
 * `name(params): ret`; everything else shows `name (kind)`.
 */
export function exportEntry(decl: Declaration): string {
  const stripped = stripLeading(decl.signature, CALLABLE_KEYWORDS);
  const name = shortName(decl.name);
  if (decl.kind === "function") {
    return stripped.startsWith(name) ? stripped : `${name} (${decl.kind})`;
  }
  if (decl.kind === "const" || decl.kind === "let" || decl.kind === "var") {
    const callable = callableConst(stripped);
    if (callable !== undefined) return callable;
  }
  return `${name} (${decl.kind})`;
}

/** API.md bullet body: the signature as written, without export/default/declare. */
export function apiSignature(decl: Declaration): string {
  return stripLeading(decl.signature, DECLARATION_KEYWORDS);
}

/**
 * Card `**Key symbols:**` body: the signature without export/default/declare,
 * with a member's own name replaced by its qualified symbol path so
 * `register(name: string, queue: Queue): void` reads
 * `Registry.register(name: string, queue: Queue): void`. Modifiers that sit in
 * front of a member name (`async`, `static`, `get`, `*`) are dropped by the
 * substitution: keeping them would produce `async *MemoryAdapter.poll(...)`,
 * which is not a shape anyone can read.
 */
export function keySymbol(decl: Declaration): string {
  const stripped = apiSignature(decl);
  if (decl.parent === undefined) return stripped;
  const short = shortName(decl.name);
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(short)}(?![A-Za-z0-9_$])`);
  const match = pattern.exec(stripped);
  if (match === null || match.index === undefined) return stripped;
  const start = match.index + (match[1] ?? "").length;
  return `${decl.name}${stripped.slice(start + short.length)}`;
}

/** `- re-exports \`a\`, \`b\` from \`./x\`` / `- re-exports * from \`./x\``. */
export function reexportBullet(record: ImportRecord): string {
  const names = record.symbols.map((s) => s.name).sort(compareStrings);
  if (names.length === 1 && names[0] === "*") return `- re-exports * from \`${record.specifier}\``;
  const listed = names.map((n) => (n === "*" ? "*" : `\`${n}\``)).join(", ");
  return `- re-exports ${listed} from \`${record.specifier}\``;
}

/** Top-level declarations of `file` that the manifest reports as exported. */
export function exportedDeclarations(ctx: DocContext, file: string): Declaration[] {
  const exported = new Set(ctx.fileEntry(file)?.exports ?? []);
  return (ctx.declsOf.get(file) ?? []).filter((d) => d.parent === undefined && exported.has(shortName(d.name)));
}

export function buildApi(ctx: DocContext, pkg: PackageInfo): string {
  const blocks: string[] = [`# ${pkg.name}: API`, ctx.generatedLine];

  const sections: string[] = [];
  for (const file of ctx.filesByPackage.get(pkg.name) ?? []) {
    const entry = ctx.fileEntry(file);
    if (entry === undefined || entry.exports.length === 0) continue;

    const bullets: string[] = [];
    for (const decl of exportedDeclarations(ctx, file)) {
      bullets.push(`- \`${apiSignature(decl)}\` L${decl.span[0]}-${decl.span[1]}`);
    }
    for (const imported of ctx.recordOf.get(file)?.imports ?? []) {
      if (imported.reexport) bullets.push(reexportBullet(imported));
    }
    if (bullets.length === 0) continue;
    sections.push(`## ${file}`, bullets.join("\n"));
  }

  if (sections.length === 0) blocks.push("No exported symbols.");
  else blocks.push(...sections);

  return `${blocks.map((b) => b.replace(/\n+$/, "")).join("\n\n")}\n`;
}
