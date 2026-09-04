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
 * The registry is complete on day one with an inert stub per pass (`applies` returns false), so
 * leaves 2.3 and 2.7 each replace exactly one module and edit nothing shared.
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
 * Run every applicable pass over one file and concatenate what they produce.
 *
 * `enabled` is `config.signals`: absent means every pass whose `applies` returns true (the
 * common case, needing no config at all), and `[]` turns the layer off entirely, which is how
 * a repo opts out. An id in `enabled` that no pass answers to is ignored rather than fatal:
 * config written against a newer greplost must not break an older one.
 *
 * Note for whoever bumps `PARSE_CACHE_VERSION`: this makes extraction depend on
 * `config.signals`, and the parse cache is keyed by `(lang, sha256)` alone. Two builds of the
 * same checkout under different `signals` settings would share cache entries. Every pass is
 * inert today, so nothing can differ yet; the first pass that produces a node has to be landed
 * together with a `PARSE_CACHE_VERSION` bump.
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
