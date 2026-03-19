import { PATTERN_LIBRARY, PatternCategory, type PatternMatchResult } from "./pattern-library.js";
import { ShellPromptDetector } from "./detectors/shell-prompt.js";
import { WaitingInputDetector } from "./detectors/waiting-input.js";
import { ThinkingDetector } from "./detectors/thinking.js";
import { ToolExecutionDetector } from "./detectors/tool-execution.js";
import { InteractiveDetector } from "./detectors/interactive.js";
import { ErrorDetector } from "./detectors/error.js";
import { LongRunningDetector } from "./detectors/long-running.js";
import { SpawnDetector } from "./detectors/spawn.js";
import type { BasePatternDetector } from "./detectors/base-detector.js";

/**
 * Orchestrates pattern detection across all categories
 *
 * Priority-based matching:
 * 1. Collect matches from all detectors
 * 2. Sort by priority (lower number = higher precedence)
 * 3. Return best match (highest priority, then confidence)
 *
 * This ensures critical patterns (ERROR, WAITING_INPUT) are never
 * overshadowed by lower-priority patterns (SHELL_PROMPT).
 */
export class PatternMatcher {
  private detectors: Map<PatternCategory, BasePatternDetector>;

  constructor() {
    this.detectors = new Map([
      [PatternCategory.SHELL_PROMPT, new ShellPromptDetector(PATTERN_LIBRARY.SHELL_PROMPT)],
      [PatternCategory.WAITING_INPUT, new WaitingInputDetector(PATTERN_LIBRARY.WAITING_INPUT)],
      [PatternCategory.THINKING, new ThinkingDetector(PATTERN_LIBRARY.THINKING)],
      [PatternCategory.TOOL_EXECUTION, new ToolExecutionDetector(PATTERN_LIBRARY.TOOL_EXECUTION)],
      [PatternCategory.INTERACTIVE, new InteractiveDetector(PATTERN_LIBRARY.INTERACTIVE)],
      [PatternCategory.ERROR, new ErrorDetector(PATTERN_LIBRARY.ERROR)],
      [PatternCategory.LONG_RUNNING, new LongRunningDetector(PATTERN_LIBRARY.LONG_RUNNING)],
      [PatternCategory.SPAWN, new SpawnDetector(PATTERN_LIBRARY.SPAWN)],
    ]);
  }

  /**
   * Analyze terminal output and return best matching pattern
   */
  analyze(output: string): PatternMatchResult {
    const lines = output.split('\n').filter(l => l.trim());
    const lastLine = lines[lines.length - 1] || '';
    const last5Lines = lines.slice(-5).join('\n');

    const context = {
      lastLine,
      last5Lines,
      fullOutput: output,
      lineCount: lines.length
    };

    // Collect all matches
    const results: PatternMatchResult[] = [];

    for (const detector of this.detectors.values()) {
      const match = detector.test(context);
      if (match.matched) {
        results.push(match);
      }
    }

    // Return best match based on priority and confidence
    return this.selectBestMatch(results);
  }

  /**
   * Select best match from results
   * Priority: highest priority (lower number) first, then highest confidence
   */
  private selectBestMatch(results: PatternMatchResult[]): PatternMatchResult {
    if (results.length === 0) {
      return {
        matched: false,
        confidence: 0,
        category: null
      };
    }

    // Sort by priority first (lower = higher precedence), then confidence
    results.sort((a, b) => {
      if (a.priority !== b.priority) {
        return (a.priority || 999) - (b.priority || 999); // Lower priority number = higher precedence
      }
      return (b.confidence || 0) - (a.confidence || 0); // Higher confidence wins
    });

    return results[0];
  }
}
