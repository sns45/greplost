/**
 * Per-file extraction: parse once, dispatch on language, run the signal passes, stamp the file
 * identity.
 *
 * Nothing here reads the filesystem or knows about other files: a `FileRecord` is exactly what
 * one file can say about itself (tech spec 5.1).
 *
 * The `switch` is the seam that keeps build 2's leaves disjoint (spec 2026-09-04 section 0.4).
 * It names every `Lang` on day one, with a throwing stub behind each unimplemented one, so a
 * language leaf replaces exactly one module and edits nothing shared. A `default` branch would
 * defeat that: adding a `Lang` must be a type error here, not a runtime surprise.
 */

import type { Declaration, FileRecord, Lang, ReferenceRecord } from "../schema.ts";
import type { ParserHandle } from "../parser.ts";
import type { Tree } from "web-tree-sitter";
import { countLoc } from "../hash.ts";
import { runSignals } from "../signals/index.ts";
import type { SignalPassId } from "../signals/index.ts";
import { extractDockerfile } from "./dockerfile.ts";
import { extractGo } from "./go.ts";
import { extractHcl } from "./hcl.ts";
import { extractJava } from "./java.ts";
import { extractKotlin } from "./kotlin.ts";
import { extractPython } from "./python.ts";
import { extractRust } from "./rust.ts";
import { extractTs } from "./ts.ts";
import { extractYaml } from "./yaml.ts";

export interface ExtractInput {
  /** Repo-relative path, forward slashes, no leading "./". */
  path: string;
  lang: Lang;
  source: string;
  /** Hex sha256 of the raw bytes, computed by the caller. */
  sha256: string;
  /**
   * Signal passes to run, from `config.signals`. Absent means every pass whose `applies`
   * returns true; `[]` turns the layer off, which is how a repo opts out (spec section 3.1).
   */
  signals?: readonly SignalPassId[];
}

export { extractDockerfile } from "./dockerfile.ts";
export { extractGo } from "./go.ts";
export { extractHcl } from "./hcl.ts";
export { extractJava } from "./java.ts";
export { extractKotlin } from "./kotlin.ts";
export { extractPython } from "./python.ts";
export { extractRust } from "./rust.ts";
export { extractTs } from "./ts.ts";
export { extractYaml, classifyYamlDocument, classifyYamlFile } from "./yaml.ts";
export type { YamlFlavour } from "./yaml.ts";
export { extractYamlActions } from "./yaml-actions.ts";
export { extractYamlHelm } from "./yaml-helm.ts";
export { extractYamlK8s } from "./yaml-k8s.ts";

/** What a language extractor returns: everything but the file's own identity. */
type ExtractedParts = Pick<FileRecord, "decls" | "imports" | "exports" | "calls" | "refs">;

/** The language extractor for one `Lang`. Total over `Lang` by construction (no `default`). */
function extractByLang(input: ExtractInput, tree: Tree): ExtractedParts {
  const { path, lang, source } = input;
  switch (lang) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
      return extractTs(path, lang, source, tree);
    case "go":
      return extractGo(path, lang, source, tree);
    case "python":
      return extractPython(path, lang, source, tree);
    case "rust":
      return extractRust(path, lang, source, tree);
    case "java":
      return extractJava(path, lang, source, tree);
    case "kotlin":
      return extractKotlin(path, lang, source, tree);
    case "hcl":
      return extractHcl(path, lang, source, tree);
    case "yaml":
      return extractYaml(path, lang, source, tree);
    case "dockerfile":
      return extractDockerfile(path, lang, source, tree);
  }
}

export function extractFile(input: ExtractInput, parser: ParserHandle): FileRecord {
  const { path, lang, source, sha256 } = input;
  const tree = parser.parse(source, lang);
  try {
    const parts = extractByLang(input, tree);

    // `SignalInput.base` is frozen by contract (spec section 3.1): a signal pass *adds* nodes
    // and references, and may never rewrite what the language extractor found. Freezing here
    // rather than trusting the contract makes an accidental mutation a `TypeError` in strict
    // mode instead of a wrong map. The arrays are frozen again by `buildSnapshot`, which is
    // idempotent.
    Object.freeze(parts.decls);
    Object.freeze(parts.imports);
    Object.freeze(parts.exports);
    Object.freeze(parts.calls);

    const signals = runSignals(
      {
        path,
        lang,
        source,
        tree,
        base: { decls: parts.decls, imports: parts.imports, exports: parts.exports, calls: parts.calls },
      },
      input.signals,
    );

    // A signal node never replaces a language declaration, so the two sets concatenate.
    const decls: Declaration[] =
      signals.decls.length === 0 ? parts.decls : [...parts.decls, ...signals.decls];
    const refs: ReferenceRecord[] | undefined = mergeRefs(parts.refs, signals.refs);

    // Built key by key rather than by spreading `parts`, so a record whose extractor left
    // `refs` undefined never gains the key: a build-1 language must serialise byte-for-byte
    // as it did under schema 1.
    return {
      path,
      lang,
      sha256,
      loc: countLoc(source),
      decls,
      imports: parts.imports,
      exports: parts.exports,
      calls: parts.calls,
      ...(refs === undefined ? {} : { refs }),
    };
  } finally {
    // The record copies every string it needs, so the WASM tree can go now instead of waiting
    // for a finalizer: a whole-repo build holds one tree.
    tree.delete();
  }
}

/**
 * `refs` stays `undefined` when neither side produced one, so every build-1 record serialises
 * byte-for-byte as it did before schema 2.
 */
function mergeRefs(
  fromLanguage: readonly ReferenceRecord[] | undefined,
  fromSignals: readonly ReferenceRecord[],
): ReferenceRecord[] | undefined {
  const language = fromLanguage ?? [];
  if (language.length === 0 && fromSignals.length === 0) return fromLanguage === undefined ? undefined : [];
  return [...language, ...fromSignals];
}
