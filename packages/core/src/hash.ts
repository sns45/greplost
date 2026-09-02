/**
 * Content hashing and line counting shared by discovery and extraction.
 *
 * Kept dependency-free (node:crypto only) so it can be called from anywhere
 * in the structure layer without pulling in fs or process concerns.
 */

import { createHash } from "node:crypto";

/** Hex-encoded sha256 of raw bytes (or the UTF-8 encoding of a string). */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Line count per the schema definition: the count of "\n" characters, plus
 * one if the final line lacks a trailing newline. Empty input is 0 lines.
 * CRLF line endings count once per line, since only "\n" is counted.
 */
export function countLoc(source: string): number {
  if (source.length === 0) return 0;
  let newlines = 0;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* "\n" */) newlines++;
  }
  const endsWithNewline = source.charCodeAt(source.length - 1) === 10;
  return endsWithNewline ? newlines : newlines + 1;
}
