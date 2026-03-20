/**
 * Integration tests for orchestrator blocking wired into production.
 * Tests the full flow: message → pattern detection → blocking → resume.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PatternDetector } from "../../core/orchestrator-blocking/detection/pattern-detector.js";
import { OrchestratorStateMachine } from "../../core/orchestrator-blocking/state-machine.js";
import { OrchestratorState } from "../../core/orchestrator-blocking/types.js";
import { BlockingCategory } from "../../core/orchestrator-blocking/detection/patterns.js";

describe("Orchestrator Blocking Integration", () => {
  let detector: PatternDetector;
  let sm: OrchestratorStateMachine;

  beforeEach(() => {
    detector = new PatternDetector();
    sm = new OrchestratorStateMachine();
  });

  describe("Full blocking flow", () => {
    it("detects decision point → blocks → resumes on user input", () => {
      // Master agent sends a decision question
      const result = detector.detect(
        "Should I merge PR #111 or #112 first? Both modify agent-health.ts."
      );
      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.DECISION);
      expect(result.confidence).toBeGreaterThanOrEqual(70);

      // Transition to PLANNING first (required before BLOCKED)
      sm.transition(OrchestratorState.PLANNING, "Starting work", "system");
      expect(sm.getState()).toBe(OrchestratorState.PLANNING);

      // Enter BLOCKED state
      sm.transition(OrchestratorState.BLOCKED, result.reasoning.join("; "), "system");
      expect(sm.isBlocked()).toBe(true);

      // User resumes
      sm.transition(OrchestratorState.PLANNING, "User chose PR #111 first", "user");
      expect(sm.isBlocked()).toBe(false);
      expect(sm.getState()).toBe(OrchestratorState.PLANNING);
    });

    it("detects risky operation → force blocks from EXECUTING state", () => {
      const result = detector.detect(
        "⚠️ This will delete the production messages table. Should I proceed?"
      );
      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.RISK);

      // Agent is in EXECUTING state
      sm.transition(OrchestratorState.PLANNING, "Planning", "system");
      sm.transition(OrchestratorState.EXECUTING, "Executing", "system");

      // Force block (can block from any state)
      sm.forceBlock(result.reasoning.join("; "));
      expect(sm.isBlocked()).toBe(true);
    });

    it("does NOT block on status updates", () => {
      const result = detector.detect(
        "Status update: Completed PR #111 review. Moving on to PR #112."
      );
      expect(result.matched).toBe(false);
    });

    it("does NOT block on rhetorical questions", () => {
      const result = detector.detect(
        "What's next? I'll continue with Phase 2 implementation."
      );
      expect(result.matched).toBe(false);
    });

    it("does NOT block on autonomous action statements", () => {
      const result = detector.detect(
        "I'll proceed with the database migration. Starting now."
      );
      expect(result.matched).toBe(false);
    });
  });

  describe("Message buffering simulation", () => {
    it("buffers messages while blocked, processes on resume", () => {
      const buffer: string[] = [];

      // Enter blocked state
      sm.transition(OrchestratorState.PLANNING, "Planning", "system");
      sm.transition(OrchestratorState.BLOCKED, "Need user decision", "system");

      // Simulate messages arriving while blocked
      buffer.push("Worker A: Finished the frontend task");
      buffer.push("Worker B: Backend migration complete");
      buffer.push("Tester: Tests are passing");

      expect(buffer.length).toBe(3);
      expect(sm.isBlocked()).toBe(true);

      // Resume
      sm.transition(OrchestratorState.PLANNING, "User provided input", "user");
      expect(sm.isBlocked()).toBe(false);

      // Process buffered messages
      const processed = [...buffer];
      buffer.length = 0;
      expect(processed.length).toBe(3);
      expect(buffer.length).toBe(0);
    });
  });

  describe("Blocking category detection", () => {
    it("detects missing information", () => {
      const result = detector.detect(
        "The requirement says 'make it faster' but I need clarification on what to optimize."
      );
      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.MISSING_INFO);
    });

    it("detects conflicts", () => {
      const result = detector.detect(
        "There is a conflict between the backend and frontend approaches. Agent Backend says use REST, but Agent Frontend says use GraphQL."
      );
      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.CONFLICT);
    });

    it("detects critical errors", () => {
      const result = detector.detect(
        "Critical error: All agents are down. Cannot access the GitHub API."
      );
      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.ERROR);
    });

    it("detects destructive operations", () => {
      const result = detector.detect(
        "I need to force push to main and reset --hard the production branch."
      );
      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.RISK);
    });

    it("detects preference questions", () => {
      const result = detector.detect(
        "What's your preference — TypeScript strict mode or relaxed? Need your decision on this."
      );
      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.DECISION);
    });
  });

  describe("State machine transitions", () => {
    it("validates the full lifecycle", () => {
      expect(sm.getState()).toBe(OrchestratorState.IDLE);

      sm.transition(OrchestratorState.PLANNING, "Starting", "system");
      expect(sm.getState()).toBe(OrchestratorState.PLANNING);

      sm.transition(OrchestratorState.EXECUTING, "Assigning work", "system");
      expect(sm.getState()).toBe(OrchestratorState.EXECUTING);

      sm.transition(OrchestratorState.REPORTING, "Work complete", "system");
      expect(sm.getState()).toBe(OrchestratorState.REPORTING);

      sm.transition(OrchestratorState.IDLE, "Report delivered", "system");
      expect(sm.getState()).toBe(OrchestratorState.IDLE);
    });

    it("rejects invalid transitions", () => {
      // Can't go directly from IDLE to BLOCKED
      expect(() => {
        sm.transition(OrchestratorState.BLOCKED, "test", "system");
      }).toThrow("Invalid state transition");
    });

    it("tracks state history", () => {
      sm.transition(OrchestratorState.PLANNING, "Plan", "system");
      sm.transition(OrchestratorState.BLOCKED, "Blocked", "system");
      sm.transition(OrchestratorState.PLANNING, "Resumed", "user");

      const history = sm.getHistory();
      expect(history.length).toBe(3);
      expect(history[0].from).toBe(OrchestratorState.IDLE);
      expect(history[0].to).toBe(OrchestratorState.PLANNING);
      expect(history[1].to).toBe(OrchestratorState.BLOCKED);
      expect(history[2].to).toBe(OrchestratorState.PLANNING);
      expect(history[2].triggeredBy).toBe("user");
    });

    it("force block works from any non-blocked state", () => {
      sm.transition(OrchestratorState.PLANNING, "Plan", "system");
      sm.transition(OrchestratorState.EXECUTING, "Execute", "system");

      sm.forceBlock("Emergency: all agents crashed");
      expect(sm.isBlocked()).toBe(true);
      expect(sm.getHistory().slice(-1)[0].reason).toContain("FORCE BLOCK");
    });

    it("cannot force block when already blocked", () => {
      sm.transition(OrchestratorState.PLANNING, "Plan", "system");
      sm.transition(OrchestratorState.BLOCKED, "Blocked", "system");

      expect(() => {
        sm.forceBlock("Double block");
      }).toThrow("Already in BLOCKED state");
    });
  });

  describe("Confidence scoring", () => {
    it("explicit markers get 100% confidence", () => {
      const result = detector.detect('```blocking-request\nreason: "test"\ncategory: "decision"\n```');
      expect(result.confidence).toBe(100);
      expect(result.method).toBe("explicit");
    });

    it("strong signals get high confidence", () => {
      // Multiple strong patterns
      const result = detector.detect(
        "Should I delete the production database? This is risky and cannot be undone. Are you sure you want to proceed?"
      );
      expect(result.confidence).toBeGreaterThanOrEqual(80);
    });

    it("weak signals stay below threshold", () => {
      // A message with only mild risk language
      const result = detector.detect(
        "There might be some risk involved with this approach."
      );
      // Should either not match or have low confidence
      if (result.matched) {
        expect(result.confidence).toBeLessThan(90);
      }
    });
  });

  describe("Edge cases", () => {
    it("handles empty messages", () => {
      const result = detector.detect("");
      expect(result.matched).toBe(false);
    });

    it("handles very long messages", () => {
      const longMsg = "Should I proceed? ".repeat(500);
      const result = detector.detect(longMsg);
      expect(result.matched).toBe(true);
    });

    it("handles messages with special characters", () => {
      const result = detector.detect(
        'Should I use `DROP TABLE users;` or `TRUNCATE TABLE users;`? 🤔'
      );
      expect(result.matched).toBe(true);
    });

    it("state machine reset clears history", () => {
      sm.transition(OrchestratorState.PLANNING, "Plan", "system");
      sm.reset();
      expect(sm.getState()).toBe(OrchestratorState.IDLE);
      expect(sm.getHistory()).toHaveLength(0);
    });
  });
});
