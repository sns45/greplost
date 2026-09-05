/**
 * Public surface of `@greplost/render`.
 *
 * The primitives (mermaid, ascii, split, tokens, slug), the terminal-output
 * helpers (`text.ts`, shared by the CLI and the workspace layer) and the
 * document layer (`renderArtifacts` plus the six per-document renderers) are
 * re-exported together, so `packages/sync` and the CLI import one entry point.
 */

export * from "./mermaid.ts";
export * from "./ascii.ts";
export * from "./split.ts";
export * from "./tokens.ts";
export * from "./slug.ts";
export * from "./text.ts";

export {
  GENERATED_LINE,
  createContext,
  renderApi,
  renderArtifacts,
  renderCard,
  renderHotspots,
  renderIndex,
  renderNodeCard,
  renderPackageMap,
  renderRepoMap,
} from "./render.ts";
export type { DocContext, RenderInput } from "./render.ts";

/** Schema 2: the non-file node card, and the cap its reference lists obey. */
export { REFERENCE_CAP, buildNodeCard } from "./docs/node-card.ts";
