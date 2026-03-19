import { describe, it, expect, beforeEach } from "vitest";
import {
  TimeHeuristicsAnalyzer,
  type TimeHeuristic,
  type HeuristicAdjustment
} from "../../../idle-detection/heuristics/time-analyzer.js";
import type { PatternMatchResult } from "../../../idle-detection/patterns/pattern-library.js";

describe("TimeHeuristicsAnalyzer", () => {
  let analyzer: TimeHeuristicsAnalyzer;

  beforeEach(() => {
    analyzer = new TimeHeuristicsAnalyzer();
  });

  describe("Rule 1: State Duration", () => {
    it("should reduce confidence for short-lived states (<5s)", () => {
      const patternResult: PatternMatchResult = {
        matched: true,
        confidence: 80,
        category: "shell_prompt" as any,
        targetState: "idle" as any
      };

      const timeData: TimeHeuristic = {
        stateDuration: 3000, // 3s - too short
        outputFrequency: 5,
        lastOutputAge: 10000,
        stateHistory: ["idle"]
      };

      const result = analyzer.analyze(patternResult, timeData);
      expect(result.confidenceAdjust).toBe(-10);
      expect(result.reasoning.length).toBeGreaterThan(0);
      expect(result.reasoning[0]).toContain("State duration");
    });

    it("should not penalize states longer than 5s", () => {
      const patternResult: PatternMatchResult = {
        matched: true,
        confidence: 80,
        category: "shell_prompt" as any,
        targetState: "idle" as any
      };

      const timeData: TimeHeuristic = {
        stateDuration: 10000, // 10s - good
        outputFrequency: 0,
        lastOutputAge: 10000,
        stateHistory: ["idle"]
      };

      const result = analyzer.analyze(patternResult, timeData);
      // Should not have the -10 penalty from rule 1
      expect(result.confidenceAdjust).toBeGreaterThanOrEqual(-10);
    });
  });

  describe("Rule 2: Output Frequency", () => {
    it("should penalize idle state with high output frequency", () => {
      const patternResult: PatternMatchResult = {
        matched: true,
        confidence: 80,
        category: "shell_prompt" as any,
        targetState: "idle" as any
      };

      const timeData: TimeHeuristic = {
        stateDuration: 10000,
        outputFrequency: 15, // >10 lines/min - high output
        lastOutputAge: 5000,
        stateHistory: ["idle"]
      };

      const result = analyzer.analyze(patternResult, timeData);
      expect(result.confidenceAdjust).toBeLessThanOrEqual(-15);
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it("should penalize waiting_input state with high output frequency", () => {
      const patternResult: PatternMatchResult = {
        matched: true,
        confidence: 90,
        category: "waiting_input" as any,
        targetState: "idle" as any
      };

      const timeData: TimeHeuristic = {
        stateDuration: 10000,
        outputFrequency: 20, // Very high output
        lastOutputAge: 5000,
        stateHistory: ["idle"]
      };

      const result = analyzer.analyze(patternResult, timeData);
      expect(result.confidenceAdjust).toBeLessThanOrEqual(-15);
    });

    it("should penalize activity claim with zero output", () => {
      const patternResult: PatternMatchResult = {
        matched: true,
        confidence: 85,
        category: "tool_execution" as any,
        targetState: "working" as any
      };

      const timeData: TimeHeuristic = {
        stateDuration: 10000,
        outputFrequency: 0, // No output
        lastOutputAge: 5000,
        stateHistory: ["working"]
      };

      const result = analyzer.analyze(patternResult, timeData);
      expect(result.confidenceAdjust).toBeLessThanOrEqual(-10);
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it("should not penalize idle state with zero output", () => {
      const patternResult: PatternMatchResult = {
        matched: true,
        confidence: 80,
        category: "shell_prompt" as any,
        targetState: "idle" as any
      };

      const timeData: TimeHeuristic = {
        stateDuration: 10000,
        outputFrequency: 0, // No output - expected for idle
        lastOutputAge: 5000,
        stateHistory: ["idle"]
      };

      const result = analyzer.analyze(patternResult, timeData);
      // Should not have the -10 penalty from rule 2
      const hasZeroOutputPenalty = result.reasoning.some(r => r.includes("No output"));
      expect(hasZeroOutputPenalty).toBe(false);
    });
  });

  describe("Rule 3: Last Output Age", () => {
    it("should penalize non-idle state with stale output (>30s)", () => {
      const patternResult: PatternMatchResult = {
        matched: true,
        confidence: 85,
        category: "tool_execution" as any,
        targetState: "working" as any
      };

      const timeData: TimeHeuristic = {
        stateDuration: 10000,
        outputFrequency: 0,
        lastOutputAge: 35000, // 35s - stale
        stateHistory: ["working"]
      };

      const result = analyzer.analyze(patternResult, timeData);
      expect(result.confidenceAdjust).toBeLessThanOrEqual(-20);
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it("should not penalize idle state with stale output", () => {
      const patternResult: PatternMatchResult = {
        matched: true,
        confidence: 80,
        category: "shell_prompt" as any,
        targetState: "idle" as any
      };

      const timeData: TimeHeuristic = {
        stateDuration: 10000,
        outputFrequency: 0,
        lastOutputAge: 40000, // 40s - stale, but expected for idle
        stateHistory: ["idle"]
      };

      const result = analyzer.analyze(patternResult, timeData);
      // Should not have the -20 penalty from rule 3
      const hasStaleOutputPenalty = result.reasoning.some(r => r.includes("Output stale"));
      expect(hasStaleOutputPenalty).toBe(false);
    });

    it("should not penalize recent output", () => {
      const patternResult: PatternMatchResult = {
        matched: true,
        confidence: 85,
        category: "tool_execution" as any,
        targetState: "working" as any
      };

      const timeData: TimeHeuristic = {
        stateDuration: 10000,
        outputFrequency: 5,
        lastOutputAge: 5000, // 5s - recent
        stateHistory: ["working"]
      };

      const result = analyzer.analyze(patternResult, timeData);
      // Should not have the -20 penalty from rule 3
      const hasStaleOutputPenalty = result.reasoning.some(r => r.includes("Output stale"));
      expect(hasStaleOutputPenalty).toBe(false);
    });
  });

  describe("Rule 4: State Oscillation", () => {
    it("should penalize frequent state changes (>3 states in 5 checks)", () => {
      const patternResult: PatternMatchResult = {
        matched: true,
        confidence: 80,
        category: "shell_prompt" as any,
        targetState: "idle" as any
      };

      const timeData: TimeHeuristic = {
        stateDuration: 6000,
        outputFrequency: 0,
        lastOutputAge: 5000,
        stateHistory: ["idle", "working", "blocked", "thinking", "working"] // 4 unique states
      };

      const result = analyzer.analyze(patternResult, timeData);
      expect(result.confidenceAdjust).toBeLessThanOrEqual(-15);
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it("should not penalize stable states (<=3 states in 5 checks)", () => {
      const patternResult: PatternMatchResult = {
        matched: true,
        confidence: 80,
        category: "shell_prompt" as any,
        targetState: "idle" as any
      };

      const timeData: TimeHeuristic = {
        stateDuration: 10000,
        outputFrequency: 0,
        lastOutputAge: 5000,
        stateHistory: ["working", "working", "working", "idle", "idle"] // 2 unique states
      };

      const result = analyzer.analyze(patternResult, timeData);
      // Should not have the -15 penalty from rule 4
      const hasOscillationPenalty = result.reasoning.some(r => r.includes("State oscillation"));
      expect(hasOscillationPenalty).toBe(false);
    });

    it("should handle empty state history", () => {
      const patternResult: PatternMatchResult = {
        matched: true,
        confidence: 80,
        category: "shell_prompt" as any,
        targetState: "idle" as any
      };

      const timeData: TimeHeuristic = {
        stateDuration: 10000,
        outputFrequency: 0,
        lastOutputAge: 5000,
        stateHistory: [] // Empty history
      };

      const result = analyzer.analyze(patternResult, timeData);
      // Should not crash or have oscillation penalty
      const hasOscillationPenalty = result.reasoning.some(r => r.includes("State oscillation"));
      expect(hasOscillationPenalty).toBe(false);
    });
  });

  describe("Combined Rules", () => {
    it("should apply multiple penalties when multiple rules match", () => {
      const patternResult: PatternMatchResult = {
        matched: true,
        confidence: 85,
        category: "tool_execution" as any,
        targetState: "working" as any
      };

      const timeData: TimeHeuristic = {
        stateDuration: 3000, // <5s - Rule 1: -10
        outputFrequency: 0, // No output - Rule 2: -10
        lastOutputAge: 35000, // >30s - Rule 3: -20
        stateHistory: ["idle", "error", "thinking", "blocked", "working"] // 5 unique = Rule 4: -15
      };

      const result = analyzer.analyze(patternResult, timeData);
      // Total penalty should be -10 -10 -20 -15 = -55
      expect(result.confidenceAdjust).toBe(-55);
      expect(result.reasoning.length).toBeGreaterThanOrEqual(4);
    });

    it("should have zero adjustment when no rules match", () => {
      const patternResult: PatternMatchResult = {
        matched: true,
        confidence: 80,
        category: "shell_prompt" as any,
        targetState: "idle" as any
      };

      const timeData: TimeHeuristic = {
        stateDuration: 10000, // >5s - no penalty
        outputFrequency: 0, // Expected for idle
        lastOutputAge: 15000, // <30s - no penalty
        stateHistory: ["idle", "idle", "idle", "idle", "idle"] // Stable
      };

      const result = analyzer.analyze(patternResult, timeData);
      expect(result.confidenceAdjust).toBe(0);
      expect(result.reasoning.length).toBe(0);
    });
  });

  describe("Final Confidence Calculation", () => {
    it("should clamp negative confidences to 0", () => {
      const adjustment: HeuristicAdjustment = {
        confidenceAdjust: -90,
        reasoning: ["Large penalty"]
      };

      const finalConfidence = analyzer.calculateFinalConfidence(50, adjustment);
      expect(finalConfidence).toBe(0);
    });

    it("should clamp confidences above 100", () => {
      const adjustment: HeuristicAdjustment = {
        confidenceAdjust: 50,
        reasoning: []
      };

      const finalConfidence = analyzer.calculateFinalConfidence(80, adjustment);
      expect(finalConfidence).toBe(100);
    });

    it("should correctly apply adjustments in normal range", () => {
      const adjustment: HeuristicAdjustment = {
        confidenceAdjust: -20,
        reasoning: ["Stale output"]
      };

      const finalConfidence = analyzer.calculateFinalConfidence(85, adjustment);
      expect(finalConfidence).toBe(65);
    });
  });
});
