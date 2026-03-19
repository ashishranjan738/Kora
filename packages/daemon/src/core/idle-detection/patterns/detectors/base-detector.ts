import type { PatternDetectorConfig, PatternMatchResult } from "../pattern-library.js";

export interface DetectionContext {
  lastLine: string;
  last5Lines: string;
  fullOutput: string;
  lineCount: number;
}

/**
 * Base class for all pattern detectors
 */
export abstract class BasePatternDetector {
  constructor(protected config: PatternDetectorConfig) {}

  /**
   * Test if the context matches any patterns in this detector
   */
  test(context: DetectionContext): PatternMatchResult {
    const targetText = this.getTargetText(context);

    for (const pattern of this.config.patterns) {
      if (pattern.test(targetText)) {
        return {
          matched: true,
          confidence: this.config.confidence,
          category: this.config.category,
          targetState: this.config.targetState,
          priority: this.config.priority,
          matchedPattern: pattern.source
        };
      }
    }

    return {
      matched: false,
      confidence: 0,
      category: this.config.category
    };
  }

  /**
   * Get the text to test against patterns
   * Default: test against last line
   * Override in subclasses for different behavior
   */
  protected getTargetText(context: DetectionContext): string {
    return context.lastLine;
  }
}
