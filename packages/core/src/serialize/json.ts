/**
 * JSON and JSONL primitives for the structure layer. Every artifact goes
 * through here so key order and line endings stay under one rule.
 */

import { stableStringify } from "../schema.ts";

/** Pretty JSON for `manifest.json`: sorted keys, 2-space indent, trailing newline. */
export function toJson(value: unknown): string {
  return `${stableStringify(value, 2)}\n`;
}

/** One compact, key-sorted object per line, each newline terminated. Empty input gives an empty file. */
export function toJsonl(items: readonly unknown[]): string {
  let out = "";
  for (const item of items) out += `${stableStringify(item)}\n`;
  return out;
}

/** Parse a JSONL artifact. Blank lines are ignored; a malformed line is an error. */
export function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`greplost: invalid JSONL on line ${i + 1}: ${reason}`);
    }
  }
  return out;
}
