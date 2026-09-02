/**
 * Mermaid parse gate (tech spec 10.8 "Mermaid render check", risk table section 14
 * "Mermaid render limits on GitHub -> ... headless parse check in CI"; bench spec 1.5.4).
 *
 * Primary path: mermaid 11's own parser, run headless. `mermaid.parse` never touches a
 * page, but the package still reads `window`/`document` while its module initializes, so
 * a jsdom window is installed on `globalThis` only for the duration of that one (memoized)
 * import; mermaid keeps a reference to the window it saw at import time and goes on
 * working after the shim globals are removed (confirmed empirically: see the leaf report).
 * The shim is not left on `globalThis` for the rest of the process because this package
 * also pulls in `jsdom` and `playwright` directly elsewhere, and a stray `window` global
 * could change how a library elsewhere decides whether it is "in a browser".
 *
 * Fallback path: a strict structural validator of the exact diagram subset greplost's
 * render package emits (render spec "Rules": `graph LR|TD`, node lines `  id["label"]`,
 * edges `  a --> b` / `  a -->|n| b`). This only runs if the mermaid+jsdom path could not
 * be made to initialize in this environment. `checker` on every result says which path
 * actually produced it, and `mapquality.ts` surfaces that in its output and results
 * payload per the bench spec's shared conventions.
 */

export type Checker = "mermaid" | "subset";

export interface CheckResult {
  ok: boolean;
  error?: string;
  checker: Checker;
}

interface MermaidLike {
  initialize(config: Record<string, unknown>): void;
  parse(text: string, options?: { suppressErrors?: boolean }): Promise<unknown>;
}

const SHIM_KEYS = ["window", "document", "navigator", "HTMLElement", "SVGElement", "Node", "DOMParser"] as const;
type ShimKey = (typeof SHIM_KEYS)[number];

/** Module-level memo: `undefined` = not attempted yet, `null` = attempted and failed. */
let mermaidLib: MermaidLike | null | undefined;
let mermaidInitError: string | undefined;
let loading: Promise<MermaidLike | null> | undefined;

/**
 * Installs a jsdom window on `globalThis` just long enough to import and prove out
 * mermaid, then restores whatever was there before (nothing, in every real run; tests may
 * run other jsdom-backed code in the same process, so this restores rather than deletes).
 */
async function attemptLoad(): Promise<MermaidLike | null> {
  const g = globalThis as Record<string, unknown>;
  const saved = new Map<ShimKey, unknown>();
  try {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
    for (const key of SHIM_KEYS) saved.set(key, g[key]);
    g["window"] = dom.window;
    g["document"] = dom.window.document;
    g["navigator"] = dom.window.navigator;
    g["HTMLElement"] = dom.window.HTMLElement;
    g["SVGElement"] = dom.window.SVGElement;
    g["Node"] = dom.window.Node;
    g["DOMParser"] = dom.window.DOMParser;

    const mod = (await import("mermaid")) as { default?: MermaidLike } & Partial<MermaidLike>;
    const mermaid = mod.default ?? (mod as unknown as MermaidLike);
    mermaid.initialize({ startOnLoad: false });
    // Prove it actually parses before trusting it for every future call in this process.
    await mermaid.parse('graph LR\n  a["a"]\n', { suppressErrors: false });
    return mermaid;
  } catch (err) {
    mermaidInitError = messageOf(err);
    return null;
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete g[key];
      else g[key] = value;
    }
  }
}

function loadMermaid(): Promise<MermaidLike | null> {
  if (mermaidLib !== undefined) return Promise.resolve(mermaidLib);
  if (!loading) {
    loading = attemptLoad().then((lib) => {
      mermaidLib = lib;
      return lib;
    });
  }
  return loading;
}

/** Parses one Mermaid fence and reports which checker produced the verdict. */
export async function checkMermaid(text: string): Promise<CheckResult> {
  const mermaid = await loadMermaid();
  if (mermaid) {
    try {
      await mermaid.parse(text, { suppressErrors: false });
      return { ok: true, checker: "mermaid" };
    } catch (err) {
      return { ok: false, error: messageOf(err), checker: "mermaid" };
    }
  }
  return checkSubset(text);
}

/** Why the mermaid+jsdom path is unavailable in this process, once it has been tried. */
export function mermaidUnavailableReason(): string | undefined {
  return mermaidLib === null ? mermaidInitError : undefined;
}

function messageOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Mermaid's parse errors append an ASCII-art caret line under the message; the first
  // line alone (`Parse error on line N: ...`) is what belongs in a one-line report.
  return message.split("\n")[0] ?? message;
}

// ---------------------------------------------------------------------------
// subset validator (fallback)
// ---------------------------------------------------------------------------

/** Exactly what `renderGraph` (render spec "Rules", packages/render/src/mermaid.ts) emits. */
const HEADER_RE = /^graph (LR|TD)$/;
const NODE_RE = /^[A-Za-z0-9_]+\["[^"]*"\]$/;
const EDGE_RE = /^[A-Za-z0-9_]+ -->(?:\|[^|]*\|)? [A-Za-z0-9_]+$/;

/**
 * Strict structural validator for the diagram subset greplost emits: a `graph LR`/`graph
 * TD` header, then only node lines (`id["label"]`) and edge lines (`a --> b` /
 * `a -->|label| b`). Anything else (a different diagram type, a dangling arrow, a stray
 * line) is rejected. This does not attempt to be a general Mermaid grammar; it only needs
 * to recognise the fences `packages/render` actually produces.
 */
export function checkSubset(text: string): CheckResult {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const header = lines[0];
  if (header === undefined || !HEADER_RE.test(header)) {
    return {
      ok: false,
      checker: "subset",
      error: `subset: expected "graph LR" or "graph TD" as the first line, got ${JSON.stringify(header ?? "")}`,
    };
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (NODE_RE.test(line) || EDGE_RE.test(line)) continue;
    return { ok: false, checker: "subset", error: `subset: unrecognised line ${i + 1}: ${JSON.stringify(line)}` };
  }

  return { ok: true, checker: "subset" };
}
