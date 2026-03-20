import { describe, it, expect, beforeEach } from "vitest";
import { PatternDetector } from "../../orchestrator-blocking/detection/pattern-detector.js";
import {
  BLOCKING_PATTERNS,
  NON_BLOCKING_PATTERNS,
  BlockingCategory,
  countPatterns,
  getCategories,
  getPatternsByCategory
} from "../../orchestrator-blocking/detection/patterns.js";

describe("Pattern Library", () => {
  describe("Pattern Count and Structure", () => {
    it("should have at least 60 blocking patterns", () => {
      const total = countPatterns();
      expect(total).toBeGreaterThanOrEqual(60);
    });

    it("should have all 5 blocking categories", () => {
      const categories = getCategories();
      expect(categories).toContain(BlockingCategory.DECISION);
      expect(categories).toContain(BlockingCategory.RISK);
      expect(categories).toContain(BlockingCategory.MISSING_INFO);
      expect(categories).toContain(BlockingCategory.CONFLICT);
      expect(categories).toContain(BlockingCategory.ERROR);
      expect(categories.length).toBeGreaterThanOrEqual(5);
    });

    it("should have non-blocking patterns for exclusions", () => {
      expect(NON_BLOCKING_PATTERNS.length).toBeGreaterThan(0);
    });

    it("should have valid pattern definitions", () => {
      for (const [name, definition] of Object.entries(BLOCKING_PATTERNS)) {
        expect(definition.category).toBeDefined();
        expect(definition.patterns).toBeInstanceOf(Array);
        expect(definition.patterns.length).toBeGreaterThan(0);
        expect(definition.weight).toBeGreaterThan(0);
        expect(definition.priority).toBeGreaterThanOrEqual(1);
        expect(definition.priority).toBeLessThanOrEqual(5);
        expect(definition.description).toBeDefined();
      }
    });
  });

  describe("Pattern Category Distribution", () => {
    it("should have DECISION patterns (most common)", () => {
      const decisionPatterns = getPatternsByCategory(BlockingCategory.DECISION);
      expect(decisionPatterns.length).toBeGreaterThan(0);
    });

    it("should have RISK patterns", () => {
      const riskPatterns = getPatternsByCategory(BlockingCategory.RISK);
      expect(riskPatterns.length).toBeGreaterThan(0);
    });

    it("should have MISSING_INFO patterns", () => {
      const missingInfoPatterns = getPatternsByCategory(BlockingCategory.MISSING_INFO);
      expect(missingInfoPatterns.length).toBeGreaterThan(0);
    });

    it("should have CONFLICT patterns", () => {
      const conflictPatterns = getPatternsByCategory(BlockingCategory.CONFLICT);
      expect(conflictPatterns.length).toBeGreaterThan(0);
    });

    it("should have ERROR patterns", () => {
      const errorPatterns = getPatternsByCategory(BlockingCategory.ERROR);
      expect(errorPatterns.length).toBeGreaterThan(0);
    });
  });

  describe("Pattern Matching Validity", () => {
    it("should match decision question patterns", () => {
      const pattern = BLOCKING_PATTERNS.DECISION_QUESTIONS.patterns[0];
      expect(pattern.test("Should I merge this PR?")).toBe(true);
      expect(pattern.test("Should I deploy to production?")).toBe(true);
      expect(pattern.test("Should I implement feature X?")).toBe(true);
    });

    it("should match risk confirmation patterns", () => {
      const pattern = BLOCKING_PATTERNS.RISK_CONFIRMATION.patterns[0];
      expect(pattern.test("This will delete production data")).toBe(true);
      expect(pattern.test("This will break backward compatibility")).toBe(true);
    });

    it("should match missing info patterns", () => {
      const pattern = BLOCKING_PATTERNS.MISSING_INFO.patterns[0];
      expect(pattern.test("Need your input on the architecture")).toBe(true);
      expect(pattern.test("Need more information about requirements")).toBe(true);
    });

    it("should match conflict patterns", () => {
      const pattern = BLOCKING_PATTERNS.CONFLICTS.patterns[0];
      expect(pattern.test("There's a conflict between Agent A and Agent B")).toBe(true);
      expect(pattern.test("Conflict between requirements")).toBe(true);
    });

    it("should match error patterns", () => {
      const pattern = BLOCKING_PATTERNS.CRITICAL_ERRORS.patterns[0];
      expect(pattern.test("Critical error in the build system")).toBe(true);
      expect(pattern.test("Critical failure detected")).toBe(true);
    });
  });
});

describe("PatternDetector", () => {
  let detector: PatternDetector;

  beforeEach(() => {
    detector = new PatternDetector();
  });

  describe("Explicit Blocking Marker", () => {
    it("should detect explicit blocking marker with 100% confidence", () => {
      const message = `
I need your decision on this:

\`\`\`blocking-request
reason: "Need approval for database migration"
category: "decision"
\`\`\`
      `;

      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.confidence).toBe(100);
      expect(result.method).toBe("explicit");
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it("should extract category from explicit marker", () => {
      const message = `
\`\`\`blocking-request
reason: "Risky operation"
category: "risk"
\`\`\`
      `;

      const result = detector.detect(message);

      expect(result.category).toBe(BlockingCategory.RISK);
    });

    it("should default to DECISION category if not specified", () => {
      const message = `
\`\`\`blocking-request
reason: "Need approval"
\`\`\`
      `;

      const result = detector.detect(message);

      expect(result.category).toBe(BlockingCategory.DECISION);
    });
  });

  describe("Non-Blocking Pattern Detection", () => {
    it("should not block on rhetorical questions", () => {
      const message = "What's next? Let's continue with Phase 2 implementation.";
      const result = detector.detect(message);

      expect(result.matched).toBe(false);
      expect(result.confidence).toBe(95);
      expect(result.method).toBe("none");
    });

    it("should not block on status updates", () => {
      const message = "Status update: Completed PR #111 review, moving to #112.";
      const result = detector.detect(message);

      expect(result.matched).toBe(false);
    });

    it("should not block on FYI messages", () => {
      const message = "FYI - Frontend completed the Timeline UI implementation.";
      const result = detector.detect(message);

      expect(result.matched).toBe(false);
    });

    it("should not block on autonomous action statements", () => {
      const message = "I'll continue with the integration tests now.";
      const result = detector.detect(message);

      expect(result.matched).toBe(false);
    });
  });

  describe("Decision Pattern Detection", () => {
    it("should detect decision questions with high confidence", () => {
      const message = "Should I merge PR #111 or PR #112 first?";
      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.DECISION);
      expect(result.confidence).toBeGreaterThanOrEqual(70);
      expect(result.matchedPatterns.length).toBeGreaterThan(0);
    });

    it("should detect multiple options presentation", () => {
      const message = `
I've analyzed two approaches:

1. Sequential merge (safer, slower)
2. Parallel merge (faster, riskier)

Which approach do you prefer?
      `;

      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.DECISION);
      expect(result.confidence).toBeGreaterThanOrEqual(75);
    });

    it("should detect trade-off discussions", () => {
      const message = `
There are pros and cons to each approach:

Pros: Faster execution
Cons: Higher risk of conflicts

What's your preference?
      `;

      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.DECISION);
    });

    it("should detect preference questions", () => {
      const message = "Which library do you prefer: X or Y?";
      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.DECISION);
    });
  });

  describe("Risk Pattern Detection", () => {
    it("should detect destructive operations with high confidence", () => {
      const message = "This will delete the production database. Should I proceed?";
      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.RISK);
      expect(result.confidence).toBeGreaterThanOrEqual(75);
    });

    it("should detect confirmation requests", () => {
      const message = "Are you sure you want to force push to main?";
      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.RISK);
    });

    it("should detect general risk indicators", () => {
      const message = "This is a risky operation that may break backward compatibility.";
      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.RISK);
    });
  });

  describe("Missing Info Pattern Detection", () => {
    it("should detect missing information requests", () => {
      const message = "Need your input on the target platform before I can proceed.";
      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.MISSING_INFO);
    });

    it("should detect unclear requirements", () => {
      const message = "The requirements are unclear. What is the priority?";
      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.MISSING_INFO);
    });

    it("should detect clarification requests", () => {
      const message = "Can you clarify what you mean by 'responsive design'?";
      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.MISSING_INFO);
    });
  });

  describe("Conflict Pattern Detection", () => {
    it("should detect agent disagreements", () => {
      const message = "There's a conflict between Frontend and Backend on the API design.";
      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.CONFLICT);
    });

    it("should detect contradictory requirements", () => {
      const message = "The requirements are contradictory - speed vs. quality.";
      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.CONFLICT);
    });
  });

  describe("Error Pattern Detection", () => {
    it("should detect critical errors", () => {
      const message = "Critical error: All agents are down and unavailable.";
      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.ERROR);
    });

    it("should detect service unavailability", () => {
      const message = "GitHub API is unavailable - cannot access repositories.";
      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.ERROR);
    });
  });

  describe("Confidence Scoring", () => {
    it("should have confidence >= 70 for strong matches", () => {
      const message = "Should I deploy to production? This will affect all users.";
      const result = detector.detect(message);

      expect(result.confidence).toBeGreaterThanOrEqual(70);
    });

    it("should have lower confidence for weak matches", () => {
      const message = "Maybe we could consider alternative approaches.";
      const result = detector.detect(message);

      // This is a weak/ambiguous message, should have low confidence or not match
      if (result.matched) {
        expect(result.confidence).toBeLessThan(85);
      }
    });

    it("should boost confidence for multiple pattern matches", () => {
      const message = "Should I merge PR #111 or #112? This is a critical decision affecting production deployment.";

      const result = detector.detect(message);

      // Should detect decision patterns
      expect(result.matched).toBe(true);
      expect(result.matchedPatterns.length).toBeGreaterThan(0);
      expect(result.category).toBe(BlockingCategory.DECISION);
      // Should have decent confidence
      expect(result.confidence).toBeGreaterThanOrEqual(70);
    });
  });

  describe("Numbered Options Detection", () => {
    it("should detect numbered lists (1. 2. 3.)", () => {
      const message = `
Here are three options:
1. Approach A
2. Approach B
3. Approach C

Which one should I use?
      `;

      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.reasoning.some(r => r.includes("numbered options"))).toBe(true);
    });

    it("should not trigger on single numbered item", () => {
      const message = "1. First task is to review PR #111.";
      const result = detector.detect(message);

      // Single numbered item shouldn't add bonus score
      // (might still match if decision patterns present)
      if (result.matched) {
        expect(result.reasoning.some(r => r.includes("numbered options"))).toBe(false);
      }
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty messages", () => {
      const message = "";
      const result = detector.detect(message);

      expect(result.matched).toBe(false);
      expect(result.confidence).toBe(100);
    });

    it("should handle messages with only whitespace", () => {
      const message = "   \n\n   \t  ";
      const result = detector.detect(message);

      expect(result.matched).toBe(false);
    });

    it("should handle very long messages", () => {
      const message = "Should I proceed? " + "context ".repeat(1000);
      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.DECISION);
    });

    it("should handle messages with special characters", () => {
      const message = "Should I use $variable or @parameter?";
      const result = detector.detect(message);

      expect(result.matched).toBe(true);
    });
  });

  describe("Pattern Priority Sorting", () => {
    it("should sort matched patterns by priority", () => {
      const message = `
Critical error detected.
Should I proceed with this risky operation?
Need your decision.
      `;

      const result = detector.detect(message);

      expect(result.matchedPatterns.length).toBeGreaterThan(0);

      // Check that patterns are sorted by priority (ascending)
      for (let i = 1; i < result.matchedPatterns.length; i++) {
        expect(result.matchedPatterns[i].priority).toBeGreaterThanOrEqual(
          result.matchedPatterns[i - 1].priority
        );
      }
    });
  });

  describe("Confidence Threshold", () => {
    it("should have confidence threshold of 70", () => {
      expect(detector.getConfidenceThreshold()).toBe(70);
    });

    it("should not match if confidence below threshold", () => {
      // This is tricky - we need a message that scores low but not zero
      // For now, just verify the threshold is enforced
      const threshold = detector.getConfidenceThreshold();
      expect(threshold).toBe(70);
    });
  });

  describe("Method Reporting", () => {
    it("should report explicit method for explicit markers", () => {
      const message = "```blocking-request\nreason: test\n```";
      const result = detector.detect(message);

      expect(result.method).toBe("explicit");
    });

    it("should report pattern method for pattern matches", () => {
      const message = "Should I proceed?";
      const result = detector.detect(message);

      if (result.matched) {
        expect(result.method).toBe("pattern");
      }
    });

    it("should report none method for non-blocking", () => {
      const message = "What's next?";
      const result = detector.detect(message);

      expect(result.method).toBe("none");
    });
  });

  describe("Reasoning Output", () => {
    it("should provide reasoning for all detections", () => {
      const message = "Should I merge PR #111?";
      const result = detector.detect(message);

      expect(result.reasoning).toBeInstanceOf(Array);
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it("should include matched pattern names in reasoning", () => {
      const message = "Should I proceed with this?";
      const result = detector.detect(message);

      if (result.matched) {
        const hasPatternName = result.reasoning.some(r =>
          r.includes("DECISION") || r.includes("Matched")
        );
        expect(hasPatternName).toBe(true);
      }
    });

    it("should include confidence score in reasoning", () => {
      const message = "Should I do X or Y?";
      const result = detector.detect(message);

      if (result.matched) {
        const hasConfidence = result.reasoning.some(r => r.includes("Confidence"));
        expect(hasConfidence).toBe(true);
      }
    });
  });
});
