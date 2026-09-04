/**
 * React component signal pass (build 2, leaf 2.3).
 *
 * Inert stub written by the seam (leaf 2.0): `applies` returns false, so the pass is never
 * given a tree and produces nothing. Leaf 2.3 replaces this file and nothing else.
 *
 * Unlike an extractor stub this one does not throw. A signal pass is an *addition* to a
 * language greplost already reads, so an unimplemented pass has an honest empty answer: the
 * file's declarations are still complete, they just carry no `component.<Name>` node yet.
 */

import type { Lang } from "../schema.ts";
import type { SignalInput, SignalOutput, SignalPass } from "./index.ts";

const LANGS: ReadonlySet<Lang> = new Set<Lang>(["ts", "tsx", "js", "jsx"]);

export const reactPass: SignalPass = {
  id: "react",
  langs: LANGS,
  applies(_path: string, _source: string): boolean {
    return false;
  },
  run(_input: SignalInput): SignalOutput {
    return { decls: [], refs: [] };
  },
};
