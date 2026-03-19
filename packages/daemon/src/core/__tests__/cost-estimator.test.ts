import { describe, it, expect } from "vitest";
import { estimateTokens, estimateCost, estimateFromOutput, COST_RATES } from "../cost-estimator.js";

describe("Cost Estimator", () => {
  describe("estimateTokens", () => {
    it("estimates tokens for simple text", () => {
      const text = "Hello, world!";
      const tokens = estimateTokens(text);
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(10); // Rough sanity check
    });

    it("estimates tokens for longer text", () => {
      const text = "The quick brown fox jumps over the lazy dog. ".repeat(10);
      const tokens = estimateTokens(text);
      expect(tokens).toBeGreaterThan(50);
      expect(tokens).toBeLessThan(200);
    });

    it("handles empty string", () => {
      const tokens = estimateTokens("");
      expect(tokens).toBe(0);
    });

    it("handles unicode characters", () => {
      const text = "Hello 世界 🌍";
      const tokens = estimateTokens(text);
      expect(tokens).toBeGreaterThan(0);
    });

    it("estimates consistent token counts for similar structured text", () => {
      const text1 = "The quick brown fox jumps over the lazy dog. ";
      const text2 = "A fast red cat leaps across the sleepy bird. ";
      const tokens1 = estimateTokens(text1);
      const tokens2 = estimateTokens(text2);
      // Both sentences have similar structure and word count, should have similar token counts
      // Allow 50% tolerance since exact wording matters to tokenizer
      expect(Math.abs(tokens1 - tokens2) / tokens1).toBeLessThan(0.5);
    });
  });

  describe("estimateCost", () => {
    it("calculates cost correctly", () => {
      const tokensIn = 1_000_000; // 1M input tokens
      const tokensOut = 500_000;  // 500K output tokens

      const cost = estimateCost(tokensIn, tokensOut);

      const expectedInput = (tokensIn / 1_000_000) * COST_RATES.INPUT_PER_M_TOKENS; // $3
      const expectedOutput = (tokensOut / 1_000_000) * COST_RATES.OUTPUT_PER_M_TOKENS; // $7.5
      const expectedTotal = expectedInput + expectedOutput; // $10.5

      expect(cost).toBeCloseTo(expectedTotal, 5);
    });

    it("handles zero tokens", () => {
      const cost = estimateCost(0, 0);
      expect(cost).toBe(0);
    });

    it("handles only input tokens", () => {
      const cost = estimateCost(1_000_000, 0);
      expect(cost).toBeCloseTo(3, 5);
    });

    it("handles only output tokens", () => {
      const cost = estimateCost(0, 1_000_000);
      expect(cost).toBeCloseTo(15, 5);
    });

    it("scales linearly with token count", () => {
      const cost1 = estimateCost(1_000_000, 1_000_000);
      const cost2 = estimateCost(2_000_000, 2_000_000);
      expect(cost2).toBeCloseTo(cost1 * 2, 5);
    });
  });

  describe("estimateFromOutput", () => {
    it("estimates tokens and cost from new output", () => {
      const previousOutput = "Previous output line 1\nPrevious output line 2\n";
      const currentOutput = previousOutput + "New output line 3\nNew output line 4\n";

      const estimate = estimateFromOutput(currentOutput, previousOutput);

      expect(estimate.tokensIn).toBeGreaterThan(0);
      expect(estimate.tokensOut).toBeGreaterThan(0);
      expect(estimate.costUsd).toBeGreaterThan(0);

      // Output tokens should be less than input tokens (since new content is smaller than total)
      expect(estimate.tokensOut).toBeLessThan(estimate.tokensIn);
    });

    it("handles first output (no previous)", () => {
      const currentOutput = "First output line\n";
      const estimate = estimateFromOutput(currentOutput);

      expect(estimate.tokensIn).toBeGreaterThan(0);
      expect(estimate.tokensOut).toBeGreaterThan(0);
      expect(estimate.costUsd).toBeGreaterThan(0);

      // On first output, both should be based on the same content
      expect(estimate.tokensIn).toBe(estimateTokens(currentOutput));
      expect(estimate.tokensOut).toBe(estimateTokens(currentOutput));
    });

    it("returns zero when no new content", () => {
      const output = "Same output\n";
      const estimate = estimateFromOutput(output, output);

      expect(estimate.tokensOut).toBe(0); // No new content
      expect(estimate.tokensIn).toBeGreaterThan(0); // Still counts total as context
    });

    it("estimates realistic costs for typical agent output", () => {
      const previousOutput = `
$ claude code
Starting agent...
Task: Fix the bug
`;
      const currentOutput = previousOutput + `
[Tool Call] Read: src/index.ts
[Tool Call] Edit: src/index.ts
Fixed the bug by updating line 42.
Task complete.
`;

      const estimate = estimateFromOutput(currentOutput, previousOutput);

      // Should be reasonable small cost (under $0.01 for this small output)
      expect(estimate.costUsd).toBeLessThan(0.01);
      expect(estimate.tokensIn).toBeGreaterThan(20);
      expect(estimate.tokensOut).toBeGreaterThan(10);
    });

    it("handles large output gracefully", () => {
      const previousOutput = "Previous: " + "x".repeat(10000);
      const currentOutput = previousOutput + "New: " + "y".repeat(10000);

      const estimate = estimateFromOutput(currentOutput, previousOutput);

      expect(estimate.tokensIn).toBeGreaterThan(1000);
      expect(estimate.tokensOut).toBeGreaterThan(1000);
      expect(estimate.costUsd).toBeGreaterThan(0);
    });
  });

  describe("Cost Rates", () => {
    it("has reasonable rate constants", () => {
      expect(COST_RATES.INPUT_PER_M_TOKENS).toBe(3);
      expect(COST_RATES.OUTPUT_PER_M_TOKENS).toBe(15);
      expect(COST_RATES.OUTPUT_PER_M_TOKENS).toBeGreaterThan(COST_RATES.INPUT_PER_M_TOKENS);
    });
  });
});
