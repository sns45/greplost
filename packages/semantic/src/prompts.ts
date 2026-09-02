/**
 * greplost:semantic prompts and answer parsing (tech spec 6; semantic spec
 * "Rules").
 *
 * Two prompts and their two parsers, and nothing else: no filesystem, no
 * network, no snapshot. Everything a model is told is assembled by the caller
 * and handed in, so what greplost asks for is readable in one file and
 * testable without a model.
 *
 * What the prompts deliberately do not contain is source. A module card
 * already prints signatures, so a summary that restates them is worse than no
 * summary; what the model is given is the shape of the module (its path, its
 * exported names, its declarations as written) and what it is asked for is the
 * one thing the structure layer cannot derive: why the module exists. Whole
 * files are sent only when there is no shape to send — a module with no exports
 * — and then only its first `HEAD_LINES` lines, because the cost of a refresh
 * has to stay proportional to the repository rather than to its largest file.
 *
 * Both parsers are strict in the same direction: they never guess. A model that
 * answers with prose, with a path nobody asked about, or with three flows where
 * five were the maximum is a failed call, and a failed call must leave the
 * committed cache exactly as it found it.
 */

import type { Flow, FlowStep } from "./flows.ts";

/** First line of a summary prompt; also how an injected runner tells the two apart. */
export const SUMMARY_TASK = "greplost:summarise-modules";

/** First line of a flows prompt. */
export const FLOWS_TASK = "greplost:describe-flows";

/** Line prefix introducing one file in a summary prompt. */
export const FILE_PREFIX = "FILE: ";

/** Line prefix introducing one entry point in a flows prompt. */
export const ENTRY_PREFIX = "ENTRY POINT: ";

/** Source lines sent for a module that exports nothing (semantic spec "Rules"). */
export const HEAD_LINES = 120;

/** Declarations listed per file: enough to show the shape, few enough to stay cheap. */
const SYMBOL_CAP = 20;

/** Everything the model is told about one module. */
export interface SummaryRequest {
  /** Repo-relative path, and the key the answer must come back under. */
  path: string;
  /** Exported names, sorted, from the manifest. */
  exports: string[];
  /** Signatures as written, from the structure layer. */
  symbols: string[];
  /** First `HEAD_LINES` lines of source; used only when `exports` is empty. */
  head?: string;
}

/** One entry point and the neighbourhood the model gets to reason about. */
export interface FlowRequest {
  /** Repo-relative path of the entry point. */
  file: string;
  /** Files reachable from it within three import hops, in reach order. */
  reaches: string[];
  /** Resolved call edges among those files, as `from -> to (confidence)`. */
  calls: string[];
}

/**
 * The batch prompt: one paragraph of intent per file, answered as a single
 * JSON object keyed by the paths exactly as given.
 */
export function buildSummaryPrompt(files: readonly SummaryRequest[]): string {
  const blocks = files.map((file) => {
    const lines = [`${FILE_PREFIX}${file.path}`];
    lines.push(`Exports: ${file.exports.length === 0 ? "none" : file.exports.join(", ")}`);
    if (file.symbols.length > 0) {
      lines.push("Declarations:");
      for (const symbol of file.symbols.slice(0, SYMBOL_CAP)) lines.push(`  ${symbol}`);
      if (file.symbols.length > SYMBOL_CAP) lines.push(`  … ${file.symbols.length - SYMBOL_CAP} more`);
    }
    // Only when there was no shape to send: a module with no exports and often
    // no declarations either (a script, a barrel of side effects).
    if (file.exports.length === 0 && file.head !== undefined && file.head.trim() !== "") {
      lines.push(`Source (first ${HEAD_LINES} lines):`);
      for (const line of file.head.split("\n")) lines.push(`  ${line}`);
    }
    return lines.join("\n");
  });

  return [
    SUMMARY_TASK,
    "",
    "You are documenting a codebase for engineers and coding agents who have never seen it.",
    "For each module below, write one paragraph saying what it is for: the job it does in this",
    "system, and why the system has it.",
    "",
    "Rules:",
    "1. Intent only. Never restate signatures, parameters or return types; the generated card",
    "   already prints them directly above your paragraph.",
    "2. No markdown. No bullets, no headings, no code fences, no backticks.",
    "3. One paragraph per module, two to four sentences, plain prose.",
    "4. If a module's purpose is genuinely unclear, say what it appears to do and no more.",
    "",
    "Answer with a single JSON object and nothing else: every key is a path exactly as given",
    "below, every value is that module's paragraph.",
    "",
    '{"<path>": "<one paragraph>"}',
    "",
    `Modules (${files.length}):`,
    "",
    blocks.join("\n\n"),
    "",
  ].join("\n");
}

/**
 * The answer to `buildSummaryPrompt`, as `path -> paragraph`.
 *
 * Throws unless the model answered with a JSON object mapping at least one of
 * the requested paths to a non-empty string. Paths nobody asked about are
 * dropped rather than refused — a model that volunteers an extra key has not
 * corrupted the answer for the keys that were asked for — but a requested path
 * whose value is not usable prose is a failed call, because writing it to the
 * cache would commit nonsense to the repository.
 */
export function parseSummaryResponse(answer: string, requested: readonly string[]): Map<string, string> {
  const parsed = parseJson(answer, "an object mapping each path to one paragraph");
  if (!isPlainObject(parsed)) {
    throw new Error(`greplost: the model answered with ${describe(parsed)}, not a JSON object of summaries`);
  }

  const wanted = new Set(requested);
  const summaries = new Map<string, string>();
  for (const key of Object.keys(parsed)) {
    if (!wanted.has(key)) continue;
    const value = parsed[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`greplost: the model's JSON has no usable summary for ${key}`);
    }
    summaries.set(key, collapse(value));
  }

  if (summaries.size === 0) {
    throw new Error(
      `greplost: the model's JSON named none of the ${requested.length} files it was asked about`,
    );
  }
  return summaries;
}

/**
 * The flows prompt: two to five flows through one package, each with steps and
 * a `sequenceDiagram` body.
 */
export function buildFlowsPrompt(pkgName: string, entries: readonly FlowRequest[]): string {
  const blocks = entries.map((entry) => {
    const lines = [`${ENTRY_PREFIX}${entry.file}`];
    lines.push("Reaches (within three import hops):");
    for (const file of entry.reaches) lines.push(`  ${file}`);
    if (entry.calls.length > 0) {
      lines.push("Resolved calls:");
      for (const call of entry.calls) lines.push(`  ${call}`);
    }
    return lines.join("\n");
  });

  return [
    FLOWS_TASK,
    "",
    `You are documenting the package \`${pkgName}\` for an engineer joining the project today.`,
    "Below are its entry points, the files each one reaches, and the resolved calls between them.",
    "",
    "Describe between 2 and 5 flows: the paths through this package a newcomer actually asks",
    "about. Each flow needs a short title, ordered steps, and a Mermaid sequence diagram.",
    "",
    "Rules:",
    "1. Every step names one file from the lists below, optionally one symbol inside it, and a",
    "   short note saying what happens there. Never invent a path.",
    "2. The diagram is a `sequenceDiagram` body only. Do not wrap it in a code fence; greplost",
    "   adds the fence.",
    "3. Notes are plain prose: no markdown, no backticks.",
    "",
    "Answer with a single JSON array and nothing else:",
    "",
    '[{"title": "...", "steps": [{"file": "...", "symbol": "...", "note": "..."}], "mermaid": "sequenceDiagram\\n ..."}]',
    "",
    `Entry points (${entries.length}):`,
    "",
    blocks.join("\n\n"),
    "",
  ].join("\n");
}

/** Flows a package may carry (tech spec 6). */
export const MIN_FLOWS = 2;
export const MAX_FLOWS = 5;

/**
 * The answer to `buildFlowsPrompt`.
 *
 * The count is enforced here rather than trimmed silently: "2 to 5 sequence
 * diagrams" is the documented shape of `FLOWS.md`, and a model that answers
 * with one flow has misunderstood the question badly enough that quietly
 * writing its one flow would be the wrong repair.
 */
export function parseFlowsResponse(answer: string): Flow[] {
  const parsed = parseJson(answer, "an array of flows");
  if (!Array.isArray(parsed)) {
    throw new Error(`greplost: the model answered with ${describe(parsed)}, not a JSON array of flows`);
  }
  if (parsed.length < MIN_FLOWS || parsed.length > MAX_FLOWS) {
    throw new Error(
      `greplost: the model returned ${parsed.length} flows; FLOWS.md carries 2 to 5 (tech spec 6)`,
    );
  }

  return parsed.map((value, index) => toFlow(value, index));
}

function toFlow(value: unknown, index: number): Flow {
  const at = `flow ${index + 1}`;
  if (!isPlainObject(value)) throw new Error(`greplost: ${at} in the model's JSON is not an object`);

  const title = value["title"];
  if (typeof title !== "string" || title.trim() === "") {
    throw new Error(`greplost: ${at} in the model's JSON has no title`);
  }
  const rawSteps = value["steps"];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error(`greplost: ${at} in the model's JSON has no steps`);
  }
  const mermaid = value["mermaid"];
  if (typeof mermaid !== "string" || mermaid.trim() === "") {
    throw new Error(`greplost: ${at} in the model's JSON has no sequence diagram`);
  }

  const steps: FlowStep[] = rawSteps.map((step, position) => {
    const where = `${at}, step ${position + 1}`;
    if (!isPlainObject(step)) throw new Error(`greplost: ${where} in the model's JSON is not an object`);
    const file = step["file"];
    const note = step["note"];
    if (typeof file !== "string" || file.trim() === "") {
      throw new Error(`greplost: ${where} in the model's JSON names no file`);
    }
    if (typeof note !== "string" || note.trim() === "") {
      throw new Error(`greplost: ${where} in the model's JSON has no note`);
    }
    const symbol = step["symbol"];
    const named = typeof symbol === "string" && symbol.trim() !== "";
    return { file: file.trim(), note: collapse(note), ...(named ? { symbol: (symbol as string).trim() } : {}) };
  });

  return { title: collapse(title), steps, mermaid: normaliseDiagram(mermaid) };
}

/**
 * A `sequenceDiagram` body, fence-free and correctly headed.
 *
 * Models fence diagrams even when told not to, and they occasionally omit the
 * `sequenceDiagram` header. Both are formatting slips rather than wrong
 * answers, and repairing them here is what keeps `FLOWS.md` renderable on
 * GitHub without a second round trip.
 */
function normaliseDiagram(mermaid: string): string {
  let body = mermaid.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(body);
  if (fenced !== null) body = (fenced[1] ?? "").trim();
  if (!/^sequenceDiagram\b/.test(body)) body = `sequenceDiagram\n${body}`;
  return body;
}

/**
 * JSON out of a model's answer.
 *
 * A fenced block wins when there is one; otherwise the span from the first
 * opening bracket to the last closing one is tried, which is what survives a
 * model that prefaced its JSON with a sentence. Everything else is a failed
 * call, and it says so with the first hundred characters of what did come back,
 * because "invalid JSON" without the evidence is a bug report nobody can act
 * on.
 */
function parseJson(answer: string, expected: string): unknown {
  for (const candidate of jsonCandidates(answer)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next, then fail with the whole answer rather than a fragment.
    }
  }
  throw new Error(
    `greplost: the model did not answer with JSON (expected ${expected}); it said: ${excerpt(answer)}`,
  );
}

function jsonCandidates(answer: string): string[] {
  const candidates: string[] = [];
  const trimmed = answer.trim();
  if (trimmed !== "") candidates.push(trimmed);

  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(answer);
  const fencedBody = fenced?.[1]?.trim();
  if (fencedBody !== undefined && fencedBody !== "") candidates.push(fencedBody);

  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));
  }
  return candidates;
}

function excerpt(answer: string): string {
  const flat = collapse(answer);
  if (flat === "") return "(nothing)";
  return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
}

/** Whitespace collapsed to single spaces: a summary is one paragraph, never a layout. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
