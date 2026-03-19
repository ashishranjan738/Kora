/**
 * Pattern Detector for Orchestrator Blocking
 *
 * Analyzes orchestrator messages to detect blocking situations using
 * pattern matching with confidence scoring.
 *
 * Algorithm:
 * 1. Check for explicit blocking marker (```blocking-request)
 * 2. Check for non-blocking patterns (early exit if matched)
 * 3. Scan all blocking patterns and accumulate score
 * 4. Calculate final confidence based on matched patterns
 * 5. Determine category based on highest-weighted matches
 */

import {
  BLOCKING_PATTERNS,
  NON_BLOCKING_PATTERNS,
  EXPLICIT_BLOCK_MARKER,
  BlockingCategory,
  type PatternDefinition
} from "./patterns.js";

export interface PatternMatch {
  patternName: string;
  category: BlockingCategory;
  pattern: RegExp;
  weight: number;
  priority: number;
}

export interface PatternMatchResult {
  matched: boolean;
  category: BlockingCategory;
  confidence: number; // 0-100
  score: number; // Raw score before normalization
  matchedPatterns: PatternMatch[];
  reasoning: string[];
  method: "explicit" | "pattern" | "none";
}

export class PatternDetector {
  private readonly CONFIDENCE_THRESHOLD = 70; // Minimum confidence to trigger blocking
  private readonly MAX_SCORE = 100; // Cap for score normalization

  /**
   * Detect blocking patterns in a message
   */
  detect(message: string): PatternMatchResult {
    const reasoning: string[] = [];
    const matchedPatterns: PatternMatch[] = [];

    // Step 1: Check for explicit blocking marker
    if (EXPLICIT_BLOCK_MARKER.test(message)) {
      reasoning.push("Explicit blocking marker detected (```blocking-request)");
      return {
        matched: true,
        category: this.extractExplicitCategory(message),
        confidence: 100,
        score: 100,
        matchedPatterns: [],
        reasoning,
        method: "explicit"
      };
    }

    // Step 2: Check for non-blocking patterns (early exit)
    for (const pattern of NON_BLOCKING_PATTERNS) {
      if (pattern.test(message)) {
        reasoning.push(`Non-blocking pattern matched: ${pattern.source}`);
        return {
          matched: false,
          category: BlockingCategory.NONE,
          confidence: 95,
          score: 0,
          matchedPatterns: [],
          reasoning,
          method: "none"
        };
      }
    }

    // Step 3: Scan all blocking patterns
    let totalScore = 0;
    const categoryScores = new Map<BlockingCategory, number>();

    for (const [name, definition] of Object.entries(BLOCKING_PATTERNS)) {
      for (const pattern of definition.patterns) {
        if (pattern.test(message)) {
          // Record match
          matchedPatterns.push({
            patternName: name,
            category: definition.category,
            pattern,
            weight: definition.weight,
            priority: definition.priority
          });

          // Accumulate score
          totalScore += definition.weight;

          // Track score by category
          const currentCategoryScore = categoryScores.get(definition.category) || 0;
          categoryScores.set(definition.category, currentCategoryScore + definition.weight);

          reasoning.push(
            `Matched ${name} (category: ${definition.category}, weight: ${definition.weight}, priority: ${definition.priority})`
          );
        }
      }
    }

    // Step 4: Check for multiple options (numbered lists)
    const numberedItems = this.countNumberedItems(message);
    if (numberedItems >= 2) {
      totalScore += 20;
      reasoning.push(`Detected ${numberedItems} numbered options (+20 score)`);

      // Add to decision category
      const decisionScore = categoryScores.get(BlockingCategory.DECISION) || 0;
      categoryScores.set(BlockingCategory.DECISION, decisionScore + 20);
    }

    // Step 5: No matches found
    if (matchedPatterns.length === 0) {
      return {
        matched: false,
        category: BlockingCategory.NONE,
        confidence: 100,
        score: 0,
        matchedPatterns: [],
        reasoning: ["No blocking patterns detected"],
        method: "none"
      };
    }

    // Step 6: Determine primary category (highest score)
    const primaryCategory = this.getPrimaryCategory(categoryScores);

    // Step 7: Calculate confidence
    const confidence = this.calculateConfidence(totalScore, matchedPatterns.length);

    reasoning.push(`Total score: ${totalScore}, Confidence: ${confidence}%`);

    return {
      matched: confidence >= this.CONFIDENCE_THRESHOLD,
      category: primaryCategory,
      confidence,
      score: totalScore,
      matchedPatterns: this.sortMatchedPatterns(matchedPatterns),
      reasoning,
      method: "pattern"
    };
  }

  /**
   * Extract category from explicit blocking marker
   */
  private extractExplicitCategory(message: string): BlockingCategory {
    const categoryMatch = message.match(/category:\s*"?(\w+)"?/i);
    if (categoryMatch) {
      const category = categoryMatch[1].toLowerCase();
      if (Object.values(BlockingCategory).includes(category as BlockingCategory)) {
        return category as BlockingCategory;
      }
    }
    return BlockingCategory.DECISION; // Default
  }

  /**
   * Count numbered items in message (1. 2. 3. etc.)
   */
  private countNumberedItems(message: string): number {
    const matches = message.match(/^\s*\d+[\.)]\s+/gm);
    return matches ? matches.length : 0;
  }

  /**
   * Determine primary category based on highest score
   */
  private getPrimaryCategory(categoryScores: Map<BlockingCategory, number>): BlockingCategory {
    if (categoryScores.size === 0) {
      return BlockingCategory.NONE;
    }

    let maxCategory = BlockingCategory.NONE;
    let maxScore = 0;

    for (const [category, score] of categoryScores.entries()) {
      if (score > maxScore) {
        maxScore = score;
        maxCategory = category;
      }
    }

    return maxCategory;
  }

  /**
   * Calculate confidence score (0-100) based on pattern matches
   *
   * Algorithm:
   * - Raw score is sum of all pattern weights
   * - Normalize using logarithmic scale for better distribution
   * - Boost for multiple matches
   */
  private calculateConfidence(score: number, matchCount: number): number {
    if (score === 0) {
      return 0;
    }

    // Normalize score to 0-100 using logarithmic scale
    // This gives better distribution: 25pts → ~75%, 50pts → ~85%, 100pts → ~95%
    let confidence = 50 + (40 * Math.log10(score + 1) / Math.log10(101));

    // Boost confidence if multiple patterns matched
    if (matchCount >= 2) {
      confidence += 15; // +15 for multiple matches (strong signal)
    }
    if (matchCount >= 4) {
      confidence += 10; // Additional +10 for many matches (very strong)
    }

    return Math.round(Math.min(100, Math.max(0, confidence)));
  }

  /**
   * Sort matched patterns by priority (ascending) then weight (descending)
   */
  private sortMatchedPatterns(patterns: PatternMatch[]): PatternMatch[] {
    return patterns.sort((a, b) => {
      // Sort by priority first (lower number = higher priority)
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      // Then by weight (higher weight = higher importance)
      return b.weight - a.weight;
    });
  }

  /**
   * Get the confidence threshold
   */
  getConfidenceThreshold(): number {
    return this.CONFIDENCE_THRESHOLD;
  }
}
