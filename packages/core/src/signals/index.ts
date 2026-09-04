/**
 * Framework signal passes (build 2, spec 2026-09-04 section 3.1; owned by the seam, leaf 2.0).
 *
 * A signal pass runs after the language extractor, over the same parse tree, and contributes
 * extra `Declaration`s and `ReferenceRecord`s without changing anything the language extractor
 * produced. `Button.tsx` keeps its `function Button` declaration *and* gains a
 * `component.Button` node; the node's `meta.decl` names the declaration's symbol path so a card
 * can link the two.
 *
 * Determinism: passes run in `id` order, their outputs are concatenated and then sorted
 * (`compareDeclarations` for declarations, `(from, to, refKind, line)` for references). A pass
 * may not read the filesystem, the clock or the environment — everything it is allowed to see
 * is in `SignalInput`.
 *
 * The registry was complete on day one with an inert stub per pass (`applies` returns false), so
 * each leaf replaces exactly one module and edits nothing shared. The four TypeScript passes are
 * live (leaf 2.3); `pulumi-go` is still the stub (leaf 2.7).
 */

import { compareDeclarations, compareStrings } from "../schema.ts";
import type { Declaration, FileRecord, Lang, ReferenceRecord } from "../schema.ts";
import type { Tree } from "web-tree-sitter";
import { nextPass } from "./next.ts";
import { pulumiGoPass } from "./pulumi-go.ts";
import { pulumiTsPass } from "./pulumi-ts.ts";
import { reactPass } from "./react.ts";
import { tanstackPass } from "./tanstack.ts";

/** Every pass id. Also the value of `meta.signal` on every node the pass produces. */
export type SignalPassId = "next" | "pulumi-go" | "pulumi-ts" | "react" | "tanstack";

export interface SignalInput {
  path: string;
  lang: Lang;
  source: string;
  tree: Tree;
  /** What the language extractor already found, frozen. */
  base: Readonly<Pick<FileRecord, "decls" | "imports" | "exports" | "calls">>;
}

export interface SignalOutput {
  decls: Declaration[];
  refs: ReferenceRecord[];
}

export interface SignalPass {
  /** Stable, sorted id; also the value of `meta.signal` on every node it produces. */
  readonly id: SignalPassId;
  readonly langs: ReadonlySet<Lang>;
  /** Cheap path/text test; a pass that returns false is never given the tree. */
  applies(path: string, source: string): boolean;
  run(input: SignalInput): SignalOutput;
  /**
   * What this pass reads from the path, beyond the file's language; `""` when it reads only
   * the source. Optional, because most passes answer `""`.
   *
   * Extraction is cached and deduplicated by `(lang, sha256)` — two files with the same bytes
   * are parsed once and the record is re-stamped with the second file's path. That is sound
   * only while nothing in the record depends on the path, which stopped being true the moment
   * a pass named a node after it: Next.js's `app/a/page.tsx` and `app/b/page.tsx` can be
   * byte-identical and are still different routes, and the second would inherit the first
   * one's `route.` node. A pass that reads the path says so here, and the key grows to match.
   */
  readonly pathKey?: (path: string) => string;
}

/** Sorted by id so the pass order is part of the determinism contract. */
export const SIGNAL_PASSES: readonly SignalPass[] = [
  nextPass,
  pulumiGoPass,
  pulumiTsPass,
  reactPass,
  tanstackPass,
].sort((a, b) => compareStrings(a.id, b.id));

export { nextPass } from "./next.ts";
export { pulumiGoPass } from "./pulumi-go.ts";
export { pulumiTsPass } from "./pulumi-ts.ts";
export { reactPass } from "./react.ts";
export { tanstackPass } from "./tanstack.ts";

/**
 * Everything the signal layer reads from a path, for a file of this language: `""` when the
 * layer's output for these bytes cannot depend on where they live.
 *
 * `extractAll` folds this into the extraction cache key. `applies` is not consulted, because it
 * needs the source and the key must be computable from the path alone; the answer is therefore
 * conservative, which is the safe direction — an extra key never produces a wrong record.
 */
export function signalPathKey(path: string, lang: Lang, enabled?: readonly SignalPassId[]): string {
  const wanted = enabled === undefined ? null : new Set<string>(enabled);
  const parts: string[] = [];
  for (const pass of SIGNAL_PASSES) {
    if (wanted !== null && !wanted.has(pass.id)) continue;
    if (!pass.langs.has(lang) || pass.pathKey === undefined) continue;
    const key = pass.pathKey(path);
    if (key !== "") parts.push(`${pass.id}=${key}`);
  }
  return parts.join(";");
}

/**
 * Run every applicable pass over one file and concatenate what they produce.
 *
 * `enabled` is `config.signals`: absent means every pass whose `applies` returns true (the
 * common case, needing no config at all), and `[]` turns the layer off entirely, which is how
 * a repo opts out. An id in `enabled` that no pass answers to is ignored rather than fatal:
 * config written against a newer greplost must not break an older one.
 *
 * `config.signals` therefore changes what extraction produces for the same bytes, so it is part
 * of the parse cache's stamp (`parseCacheStamp` in `@greplost/sync`) rather than something a
 * `PARSE_CACHE_VERSION` bump could stand in for: a version is bumped once, and this differs
 * between two builds of the same checkout.
 */
export function runSignals(input: SignalInput, enabled?: readonly SignalPassId[]): SignalOutput {
  const decls: Declaration[] = [];
  const refs: ReferenceRecord[] = [];
  const wanted = enabled === undefined ? null : new Set<string>(enabled);

  for (const pass of SIGNAL_PASSES) {
    if (wanted !== null && !wanted.has(pass.id)) continue;
    if (!pass.langs.has(input.lang)) continue;
    if (!pass.applies(input.path, input.source)) continue;
    const out = pass.run(input);
    decls.push(...out.decls);
    refs.push(...out.refs);
  }

  decls.sort(compareDeclarations);
  refs.sort(
    (a, b) =>
      compareStrings(a.from, b.from) ||
      compareStrings(a.to, b.to) ||
      compareStrings(a.refKind, b.refKind) ||
      a.line - b.line,
  );
  return { decls, refs };
}
