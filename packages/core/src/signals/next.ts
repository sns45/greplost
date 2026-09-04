/**
 * Next.js App Router signal pass (build 2, leaf 2.3).
 *
 * Inert stub written by the seam (leaf 2.0); see `signals/react.ts` for why a signal stub
 * returns nothing rather than throwing.
 */

import type { Lang } from "../schema.ts";
import type { SignalInput, SignalOutput, SignalPass } from "./index.ts";

const LANGS: ReadonlySet<Lang> = new Set<Lang>(["ts", "tsx", "js", "jsx"]);

export const nextPass: SignalPass = {
  id: "next",
  langs: LANGS,
  applies(_path: string, _source: string): boolean {
    return false;
  },
  run(_input: SignalInput): SignalOutput {
    return { decls: [], refs: [] };
  },
};
