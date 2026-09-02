/**
 * Public surface of `@greplost/render`.
 *
 * The primitives (mermaid, ascii, split, tokens, slug) and the document layer
 * (`renderArtifacts` plus the six per-document renderers) are re-exported
 * together, so `packages/sync` and the CLI import one entry point.
 */

export * from "./mermaid.ts";
export * from "./ascii.ts";
export * from "./split.ts";
export * from "./tokens.ts";
export * from "./slug.ts";

export {
  GENERATED_LINE,
  createContext,
  renderApi,
  renderArtifacts,
  renderCard,
  renderHotspots,
  renderIndex,
  renderPackageMap,
  renderRepoMap,
} from "./render.ts";
export type { DocContext, RenderInput } from "./render.ts";
