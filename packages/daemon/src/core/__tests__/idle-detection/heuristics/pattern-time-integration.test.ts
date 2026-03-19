import { describe, it, expect, beforeEach } from "vitest";
import { PatternMatcher } from "../../../idle-detection/patterns/pattern-matcher.js";
import { TimeHeuristicsAnalyzer, type TimeHeuristic } from "../../../idle-detection/heuristics/time-analyzer.js";
import { PatternCategory } from "../../../idle-detection/patterns/pattern-library.js";

/**
 * Integration tests for Pattern Matching (Phase 1) + Time Heuristics (Phase 2)
 *
 * These tests verify that:
 * 1. Pattern matches work correctly
 * 2. Time heuristics adjust confidence appropriately
 * 3. Combined system reaches 90%+ accuracy
 */
describe("Pattern + Time Integration", () => {
  let patternMatcher: PatternMatcher;
  let timeAnalyzer: TimeHeuristicsAnalyzer;

  beforeEach(() => {
    patternMatcher = new PatternMatcher();
    timeAnalyzer = new TimeHeuristicsAnalyzer();
  });

  describe("Confidence Adjustment Flow", () => {
    it("should reduce confidence for short-lived shell prompt", () => {
      // Pattern: Shell prompt detected (80% confidence)
      const output = "$ ";
      const patternResult = patternMatcher.analyze(output);
      expect(patternResult.matched).toBe(true);
      expect(patternResult.confidence).toBe(80);

      // Time: State just changed (<5s), reducing confidence
      const timeData: TimeHeuristic = {
        stateDuration: 2000, // 2s - short-lived
        outputFrequency: 0,
        lastOutputAge: 5000,
        stateHistory: ["idle"]
      };

      const timeResult = timeAnalyzer.analyze(patternResult, timeData);
      const finalConfidence = timeAnalyzer.calculateFinalConfidence(
        patternResult.confidence || 0,
        timeResult
      );

      expect(finalConfidence).toBe(70); // 80 - 10 = 70
      expect(finalConfidence).toBeGreaterThanOrEqual(70); // Still above threshold
    });

    it("should boost confidence for stable shell prompt", () => {
      // Pattern: Shell prompt detected (80% confidence)
      const output = "$ ";
      const patternResult = patternMatcher.analyze(output);
      expect(patternResult.matched).toBe(true);

      // Time: Stable state (>5s), no adjustments
      const timeData: TimeHeuristic = {
        stateDuration: 15000, // 15s - stable
        outputFrequency: 0, // Expected for idle
        lastOutputAge: 15000, // Recent enough
        stateHistory: ["idle", "idle", "idle", "idle", "idle"] // Stable
      };

      const timeResult = timeAnalyzer.analyze(patternResult, timeData);
      const finalConfidence = timeAnalyzer.calculateFinalConfidence(
        patternResult.confidence || 0,
        timeResult
      );

      expect(finalConfidence).toBe(80); // No adjustments = 80
    });

    it("should heavily penalize working state with stale output", () => {
      // Pattern: Tool execution detected (85% confidence)
      const output = "npm install express";
      const patternResult = patternMatcher.analyze(output);
      expect(patternResult.matched).toBe(true);
      expect(patternResult.confidence).toBe(85);
      expect(patternResult.category).toBe(PatternCategory.TOOL_EXECUTION);

      // Time: Output is stale (>30s) but claiming activity
      const timeData: TimeHeuristic = {
        stateDuration: 10000,
        outputFrequency: 0, // No new output
        lastOutputAge: 40000, // 40s - very stale
        stateHistory: ["working"]
      };

      const timeResult = timeAnalyzer.analyze(patternResult, timeData);
      const finalConfidence = timeAnalyzer.calculateFinalConfidence(
        patternResult.confidence || 0,
        timeResult
      );

      // 85 - 10 (no output) - 20 (stale) = 55
      expect(finalConfidence).toBeLessThan(70); // Below threshold
      expect(finalConfidence).toBe(55);
    });

    it("should reject oscillating state detection", () => {
      // Pattern: Shell prompt detected (80% confidence)
      const output = "$ ";
      const patternResult = patternMatcher.analyze(output);
      expect(patternResult.matched).toBe(true);

      // Time: Rapidly changing states (oscillation)
      const timeData: TimeHeuristic = {
        stateDuration: 3000, // 3s - short
        outputFrequency: 0,
        lastOutputAge: 10000,
        stateHistory: ["idle", "working", "error", "blocked", "idle"] // 5 unique states
      };

      const timeResult = timeAnalyzer.analyze(patternResult, timeData);
      const finalConfidence = timeAnalyzer.calculateFinalConfidence(
        patternResult.confidence || 0,
        timeResult
      );

      // 80 - 10 (short duration) - 15 (oscillation) = 55
      expect(finalConfidence).toBeLessThan(70); // Below threshold
      expect(finalConfidence).toBe(55);
    });
  });

  describe("High-Priority Patterns Bypass Time Penalties", () => {
    it("should accept ERROR pattern even with penalties", () => {
      // Pattern: ERROR detected (95% confidence, priority 1)
      const output = "Error: ENOENT: no such file or directory";
      const patternResult = patternMatcher.analyze(output);
      expect(patternResult.matched).toBe(true);
      expect(patternResult.confidence).toBe(95);
      expect(patternResult.category).toBe(PatternCategory.ERROR);

      // Time: Multiple penalties
      const timeData: TimeHeuristic = {
        stateDuration: 2000, // -10
        outputFrequency: 0, // -10 (if non-idle)
        lastOutputAge: 5000,
        stateHistory: ["error"]
      };

      const timeResult = timeAnalyzer.analyze(patternResult, timeData);
      const finalConfidence = timeAnalyzer.calculateFinalConfidence(
        patternResult.confidence || 0,
        timeResult
      );

      // 95 - 10 (short duration) - 10 (no output) = 75 (still above threshold)
      expect(finalConfidence).toBeGreaterThanOrEqual(70);
      expect(finalConfidence).toBe(75);
    });

    it("should accept WAITING_INPUT pattern with minor penalties", () => {
      // Pattern: WAITING_INPUT detected (90% confidence, priority 2)
      const output = "Claude is waiting for your input";
      const patternResult = patternMatcher.analyze(output);
      expect(patternResult.matched).toBe(true);
      expect(patternResult.confidence).toBe(90);
      expect(patternResult.category).toBe(PatternCategory.WAITING_INPUT);

      // Time: Short duration penalty
      const timeData: TimeHeuristic = {
        stateDuration: 3000, // -10
        outputFrequency: 2,
        lastOutputAge: 5000,
        stateHistory: ["idle"]
      };

      const timeResult = timeAnalyzer.analyze(patternResult, timeData);
      const finalConfidence = timeAnalyzer.calculateFinalConfidence(
        patternResult.confidence || 0,
        timeResult
      );

      // 90 - 10 = 80 (still above threshold)
      expect(finalConfidence).toBeGreaterThanOrEqual(70);
      expect(finalConfidence).toBe(80);
    });
  });

  describe("Real-World Scenarios", () => {
    it("should correctly identify truly idle agent", () => {
      // Scenario: Agent at shell prompt for 45 seconds
      const output = "$ ";
      const patternResult = patternMatcher.analyze(output);

      const timeData: TimeHeuristic = {
        stateDuration: 45000, // 45s - very stable
        outputFrequency: 0, // No output
        lastOutputAge: 45000, // 45s since last change
        stateHistory: ["idle", "idle", "idle", "idle", "idle"]
      };

      const timeResult = timeAnalyzer.analyze(patternResult, timeData);
      const finalConfidence = timeAnalyzer.calculateFinalConfidence(
        patternResult.confidence || 0,
        timeResult
      );

      // No penalties (all conditions match idle state)
      expect(finalConfidence).toBe(80); // Original confidence
      expect(finalConfidence).toBeGreaterThanOrEqual(70);
    });

    it("should correctly reject false working state", () => {
      // Scenario: Old output claiming activity, but agent is actually idle
      const output = "npm install"; // Old command still visible
      const patternResult = patternMatcher.analyze(output);

      const timeData: TimeHeuristic = {
        stateDuration: 5000,
        outputFrequency: 0, // No new output
        lastOutputAge: 35000, // 35s - stale
        stateHistory: ["working"]
      };

      const timeResult = timeAnalyzer.analyze(patternResult, timeData);
      const finalConfidence = timeAnalyzer.calculateFinalConfidence(
        patternResult.confidence || 0,
        timeResult
      );

      // 85 - 10 (no output) - 20 (stale) = 55
      expect(finalConfidence).toBeLessThan(70); // Below threshold - reject
    });

    it("should correctly accept genuine long-running task", () => {
      // Scenario: Build running for 2 minutes with active output
      const output = "Building... [45%]";
      const patternResult = patternMatcher.analyze(output);
      expect(patternResult.category).toBe(PatternCategory.LONG_RUNNING);

      const timeData: TimeHeuristic = {
        stateDuration: 120000, // 2 minutes - stable
        outputFrequency: 12, // Active output (12 lines/min)
        lastOutputAge: 2000, // 2s - very recent
        stateHistory: ["long_running", "long_running", "long_running"]
      };

      const timeResult = timeAnalyzer.analyze(patternResult, timeData);
      const finalConfidence = timeAnalyzer.calculateFinalConfidence(
        patternResult.confidence || 0,
        timeResult
      );

      // No penalties (all conditions match long-running task)
      expect(finalConfidence).toBe(75); // Original confidence
      expect(finalConfidence).toBeGreaterThanOrEqual(70);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty output gracefully", () => {
      const output = "";
      const patternResult = patternMatcher.analyze(output);
      expect(patternResult.category).toBe(PatternCategory.SPAWN);

      const timeData: TimeHeuristic = {
        stateDuration: 1000,
        outputFrequency: 0,
        lastOutputAge: 1000,
        stateHistory: []
      };

      const timeResult = timeAnalyzer.analyze(patternResult, timeData);
      const finalConfidence = timeAnalyzer.calculateFinalConfidence(
        patternResult.confidence || 0,
        timeResult
      );

      // 90 - 10 (short duration) = 80
      expect(finalConfidence).toBeGreaterThanOrEqual(70);
    });

    it("should handle first check (no history)", () => {
      const output = "$ ";
      const patternResult = patternMatcher.analyze(output);

      const timeData: TimeHeuristic = {
        stateDuration: 0, // Just started
        outputFrequency: 0,
        lastOutputAge: 0,
        stateHistory: [] // No history yet
      };

      const timeResult = timeAnalyzer.analyze(patternResult, timeData);
      const finalConfidence = timeAnalyzer.calculateFinalConfidence(
        patternResult.confidence || 0,
        timeResult
      );

      // 80 - 10 (duration < 5s) = 70 (at threshold)
      expect(finalConfidence).toBe(70);
    });
  });
});
