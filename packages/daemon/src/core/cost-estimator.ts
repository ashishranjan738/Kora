/**
 * Universal cost estimation using tiktoken
 * Works for all providers (Claude, Codex, Aider, Kiro, Goose)
 *
 * Note: Estimates have ~10-20% margin of error due to:
 * - Input token estimation (2x output heuristic)
 * - Provider-specific pricing variations
 * - Context window management differences
 */

import { encoding_for_model } from "tiktoken";
import type { TiktokenModel } from "tiktoken";

// Approximate cost rates ($ per million tokens)
export const COST_RATES = {
  INPUT_PER_M_TOKENS: 3,
  OUTPUT_PER_M_TOKENS: 15,
} as const;

/**
 * Estimate token count for a given text using tiktoken
 * Uses cl100k_base encoding (same as GPT-4, Claude-3+)
 */
export function estimateTokens(text: string): number {
  let encoding;
  try {
    encoding = encoding_for_model("gpt-4" as TiktokenModel);
    const tokens = encoding.encode(text);
    return tokens.length;
  } catch (err) {
    // Fallback: rough estimate (1 token ≈ 4 chars)
    return Math.ceil(text.length / 4);
  } finally {
    // Ensure encoding is freed even if error occurs
    if (encoding) {
      encoding.free();
    }
  }
}

/**
 * Estimate cost in USD based on token count
 */
export function estimateCost(tokensIn: number, tokensOut: number): number {
  const inputCost = (tokensIn / 1_000_000) * COST_RATES.INPUT_PER_M_TOKENS;
  const outputCost = (tokensOut / 1_000_000) * COST_RATES.OUTPUT_PER_M_TOKENS;
  return inputCost + outputCost;
}
