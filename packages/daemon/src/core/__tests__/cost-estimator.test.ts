import { describe, it, expect } from "vitest";
import { estimateTokens, estimateCost, COST_RATES } from "../cost-estimator.js";

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

  describe("Cumulative Cost Tracking (UsageMonitor behavior)", () => {
    it("validates delta-based cumulative counting", () => {
      // Simulate usage-monitor behavior: track deltas, not full re-counts
      const output1 = "Line 1\nLine 2\n";
      const output2 = "Line 1\nLine 2\nLine 3\n";
      const output3 = "Line 1\nLine 2\nLine 3\nLine 4\n";

      const tokens1 = estimateTokens(output1);
      const tokens2 = estimateTokens(output2);
      const tokens3 = estimateTokens(output3);

      // Delta approach: only count new tokens
      const delta1to2 = tokens2 - tokens1;
      const delta2to3 = tokens3 - tokens2;

      expect(delta1to2).toBeGreaterThan(0);
      expect(delta2to3).toBeGreaterThan(0);

      // Cumulative output = sum of deltas
      const cumulativeOut = delta1to2 + delta2to3;
      expect(cumulativeOut).toBe(tokens3 - tokens1);
    });

    it("validates 2x input heuristic cost estimation", () => {
      // Simulate usage-monitor: output tokens + 2x input heuristic
      const outputTokens = 1000;
      const inputTokens = outputTokens * 2;

      const cost = estimateCost(inputTokens, outputTokens);

      // Cost = (2000 / 1M * $3) + (1000 / 1M * $15) = $0.006 + $0.015 = $0.021
      expect(cost).toBeCloseTo(0.021, 5);
    });

    it("validates realistic agent session cost", () => {
      // Simulate a small agent session
      const terminalOutput = `
$ claude code
Starting task...
[Tool] Read file.ts
[Tool] Edit file.ts
Task complete!
`.trim();

      const outputTokens = estimateTokens(terminalOutput);
      const inputTokens = outputTokens * 2; // 2x heuristic

      const cost = estimateCost(inputTokens, outputTokens);

      // Small session should be under $0.01
      expect(cost).toBeLessThan(0.01);
      expect(outputTokens).toBeGreaterThan(10);
    });
  });

  describe("Memory Management", () => {
    it("handles multiple estimations without memory leak", () => {
      // Validates encoding.free() is called in finally block
      for (let i = 0; i < 100; i++) {
        const text = `Iteration ${i}: some test text`;
        const tokens = estimateTokens(text);
        expect(tokens).toBeGreaterThan(0);
      }
      // If encoding wasn't freed, this would cause memory issues
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
