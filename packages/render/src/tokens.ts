/**
 * greplost:render token budget.
 *
 * Pure. `estimateTokens` is a cheap, deterministic proxy for LLM token count
 * (no tokenizer dependency): `Math.ceil(text.length / 3.5)`.
 */

/** Hard budget for INDEX.md, in estimated tokens (tech spec 4.2, render spec "Token budget"). */
export const INDEX_TOKEN_BUDGET = 3000;

/** Deterministic token estimate: characters / 3.5, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
