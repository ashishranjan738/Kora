import { describe, it, expect } from "vitest";
import {
  PATTERN_LIBRARY,
  PatternCategory,
  getTotalPatternCount,
  getOrderedConfigs
} from "../../idle-detection/patterns/pattern-library.js";

describe("Pattern Library", () => {
  describe("Structure", () => {
    it("should have all 8 categories", () => {
      const categories = Object.keys(PATTERN_LIBRARY);
      expect(categories).toHaveLength(8);
      expect(categories).toContain("SHELL_PROMPT");
      expect(categories).toContain("WAITING_INPUT");
      expect(categories).toContain("THINKING");
      expect(categories).toContain("TOOL_EXECUTION");
      expect(categories).toContain("INTERACTIVE");
      expect(categories).toContain("ERROR");
      expect(categories).toContain("LONG_RUNNING");
      expect(categories).toContain("SPAWN");
    });

    it("should have 60+ total patterns", () => {
      const totalPatterns = getTotalPatternCount();
      expect(totalPatterns).toBeGreaterThanOrEqual(60);
    });

    it("should have correct pattern counts per category", () => {
      expect(PATTERN_LIBRARY.SHELL_PROMPT.patterns).toHaveLength(11);
      expect(PATTERN_LIBRARY.WAITING_INPUT.patterns).toHaveLength(8);
      expect(PATTERN_LIBRARY.THINKING.patterns).toHaveLength(6);
      expect(PATTERN_LIBRARY.TOOL_EXECUTION.patterns).toHaveLength(7);
      expect(PATTERN_LIBRARY.INTERACTIVE.patterns).toHaveLength(10);
      expect(PATTERN_LIBRARY.ERROR.patterns).toHaveLength(12);
      expect(PATTERN_LIBRARY.LONG_RUNNING.patterns).toHaveLength(7);
      expect(PATTERN_LIBRARY.SPAWN.patterns).toHaveLength(5);
    });
  });

  describe("Priority System", () => {
    it("should prioritize ERROR patterns highest (priority 1)", () => {
      expect(PATTERN_LIBRARY.ERROR.priority).toBe(1);
    });

    it("should prioritize WAITING_INPUT higher than SHELL_PROMPT", () => {
      expect(PATTERN_LIBRARY.WAITING_INPUT.priority).toBe(2);
      expect(PATTERN_LIBRARY.SHELL_PROMPT.priority).toBe(8);
      expect(PATTERN_LIBRARY.WAITING_INPUT.priority).toBeLessThan(
        PATTERN_LIBRARY.SHELL_PROMPT.priority
      );
    });

    it("should prioritize SPAWN as priority 3", () => {
      expect(PATTERN_LIBRARY.SPAWN.priority).toBe(3);
    });

    it("should have SHELL_PROMPT as lowest priority (fallback)", () => {
      const priorities = Object.values(PATTERN_LIBRARY).map(c => c.priority);
      const maxPriority = Math.max(...priorities);
      expect(PATTERN_LIBRARY.SHELL_PROMPT.priority).toBe(maxPriority);
      expect(maxPriority).toBe(8);
    });

    it("should return configs sorted by priority", () => {
      const ordered = getOrderedConfigs();
      expect(ordered[0].category).toBe(PatternCategory.ERROR);
      expect(ordered[ordered.length - 1].category).toBe(PatternCategory.SHELL_PROMPT);
    });
  });

  describe("Confidence Levels", () => {
    it("should have ERROR with highest confidence (95)", () => {
      expect(PATTERN_LIBRARY.ERROR.confidence).toBe(95);
    });

    it("should have WAITING_INPUT with 90 confidence", () => {
      expect(PATTERN_LIBRARY.WAITING_INPUT.confidence).toBe(90);
    });

    it("should have SHELL_PROMPT with 80 confidence", () => {
      expect(PATTERN_LIBRARY.SHELL_PROMPT.confidence).toBe(80);
    });

    it("should have confidence between 70-95 for all categories", () => {
      Object.values(PATTERN_LIBRARY).forEach(config => {
        expect(config.confidence).toBeGreaterThanOrEqual(70);
        expect(config.confidence).toBeLessThanOrEqual(95);
      });
    });
  });

  describe("Target States", () => {
    it("should map SHELL_PROMPT to idle", () => {
      expect(PATTERN_LIBRARY.SHELL_PROMPT.targetState).toBe("idle");
    });

    it("should map WAITING_INPUT to idle", () => {
      expect(PATTERN_LIBRARY.WAITING_INPUT.targetState).toBe("idle");
    });

    it("should map ERROR to error", () => {
      expect(PATTERN_LIBRARY.ERROR.targetState).toBe("error");
    });

    it("should map INTERACTIVE to blocked", () => {
      expect(PATTERN_LIBRARY.INTERACTIVE.targetState).toBe("blocked");
    });

    it("should map THINKING to thinking", () => {
      expect(PATTERN_LIBRARY.THINKING.targetState).toBe("thinking");
    });

    it("should map TOOL_EXECUTION to working", () => {
      expect(PATTERN_LIBRARY.TOOL_EXECUTION.targetState).toBe("working");
    });
  });

  describe("Pattern Validation", () => {
    it("all patterns should be valid RegExp objects", () => {
      Object.values(PATTERN_LIBRARY).forEach(config => {
        config.patterns.forEach(pattern => {
          expect(pattern).toBeInstanceOf(RegExp);
        });
      });
    });

    it("should not have duplicate patterns", () => {
      const allPatterns = Object.values(PATTERN_LIBRARY).flatMap(
        config => config.patterns.map(p => p.source)
      );
      const uniquePatterns = new Set(allPatterns);
      expect(uniquePatterns.size).toBe(allPatterns.length);
    });
  });
});
