import type { PatternMatchResult, PatternCategory } from "../patterns/pattern-library.js";

/**
 * Time-based metrics for heuristic analysis
 */
export interface TimeHeuristic {
  /** How long the agent has been in current state (ms) */
  stateDuration: number;
  /** Output lines per minute */
  outputFrequency: number;
  /** Time since last output change (ms) */
  lastOutputAge: number;
  /** Recent state history (last 10 states) */
  stateHistory: string[];
}

/**
 * Result of time heuristic analysis
 */
export interface HeuristicAdjustment {
  /** Confidence adjustment (-100 to +100) */
  confidenceAdjust: number;
  /** Human-readable reasoning for adjustment */
  reasoning: string[];
}

/**
 * Time Heuristics Analyzer
 *
 * Applies 4 time-based rules to adjust pattern matching confidence:
 * 1. State Duration: Penalize rapid state changes (<5s)
 * 2. Output Frequency: Detect conflicts between activity and output rate
 * 3. Last Output Age: Detect stale output claiming activity
 * 4. State Oscillation: Penalize unstable detection (>3 states in 5 checks)
 *
 * Goal: Improve accuracy from 85% (Pattern-only) → 90% (Pattern + Time)
 */
export class TimeHeuristicsAnalyzer {
  /**
   * Analyze time metrics and adjust pattern confidence
   */
  analyze(
    patternResult: PatternMatchResult,
    timeData: TimeHeuristic
  ): HeuristicAdjustment {
    let confidenceAdjust = 0;
    const reasoning: string[] = [];

    // Rule 1: Short-lived states are suspicious (prevents rapid false flips)
    if (timeData.stateDuration < 5000) { // <5s
      confidenceAdjust -= 10;
      reasoning.push(`State duration ${timeData.stateDuration}ms < 5s, reducing confidence -10`);
    }

    // Rule 2: Output frequency should match activity level
    if (timeData.outputFrequency > 10) {
      // High output (>10 lines/min) conflicts with idle/blocked states
      if (patternResult.category === "shell_prompt" ||
          patternResult.category === "waiting_input" ||
          patternResult.category === "interactive") {
        confidenceAdjust -= 15;
        reasoning.push(`High output frequency (${timeData.outputFrequency}/min) conflicts with idle/blocked state -15`);
      }
    } else if (timeData.outputFrequency === 0) {
      // No output but claiming active work
      if (patternResult.category !== "shell_prompt" &&
          patternResult.category !== "waiting_input" &&
          patternResult.targetState !== "idle") {
        confidenceAdjust -= 10;
        reasoning.push("No output but claiming activity -10");
      }
    }

    // Rule 3: Stale output suggests idle (>30s without change)
    if (timeData.lastOutputAge > 30000) { // >30s
      if (patternResult.targetState !== "idle") {
        confidenceAdjust -= 20;
        reasoning.push(`Output stale ${Math.round(timeData.lastOutputAge / 1000)}s, likely idle -20`);
      }
    }

    // Rule 4: State oscillation indicates unstable detection
    const recentStates = timeData.stateHistory.slice(-5); // Last 5 states
    const uniqueStates = new Set(recentStates);
    if (uniqueStates.size > 3) { // >3 different states in last 5 checks
      confidenceAdjust -= 15;
      reasoning.push(`State oscillation (${uniqueStates.size} states in 5 checks) -15`);
    }

    return { confidenceAdjust, reasoning };
  }

  /**
   * Calculate final confidence with time adjustments applied
   */
  calculateFinalConfidence(
    baseConfidence: number,
    adjustment: HeuristicAdjustment
  ): number {
    const finalConfidence = baseConfidence + adjustment.confidenceAdjust;
    return Math.max(0, Math.min(100, finalConfidence)); // Clamp to 0-100
  }
}
