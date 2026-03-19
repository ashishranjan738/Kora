/**
 * Universal cost estimation using tiktoken
 * Works for all providers (Claude, Codex, Aider, Kiro, Goose)
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
  try {
    const encoding = encoding_for_model("gpt-4" as TiktokenModel);
    const tokens = encoding.encode(text);
    const count = tokens.length;
    encoding.free();
    return count;
  } catch (err) {
    // Fallback: rough estimate (1 token ≈ 4 chars)
    return Math.ceil(text.length / 4);
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

/**
 * Estimate tokens and cost from terminal output
 * Assumes the new output since last check is the model's response (output tokens)
 * and accumulated output represents context (input tokens)
 */
export interface TokenEstimate {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export function estimateFromOutput(
  currentOutput: string,
  previousOutput: string = "",
): TokenEstimate {
  // New content since last check = output tokens (model generated this)
  const newContent = currentOutput.slice(previousOutput.length);
  const tokensOut = estimateTokens(newContent);

  // Total accumulated output = input tokens (context for model)
  // This is a rough approximation: in reality, the model sees the conversation history
  const tokensIn = estimateTokens(currentOutput);

  const costUsd = estimateCost(tokensIn, tokensOut);

  return { tokensIn, tokensOut, costUsd };
}
