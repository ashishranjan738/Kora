import { describe, it, expect, beforeEach, vi } from "vitest";
import { PatternDetector } from "../../orchestrator-blocking/detection/pattern-detector.js";
import { OrchestratorStateMachine } from "../../orchestrator-blocking/state-machine.js";
import { OrchestratorState, BlockingCategory } from "../../orchestrator-blocking/index.js";

/**
 * Integration Tests for Orchestrator Blocking System
 *
 * These tests verify the complete blocking flow from message detection
 * through state transitions to orchestrator behavior changes.
 */
describe("Orchestrator Blocking Integration", () => {
  let detector: PatternDetector;
  let stateMachine: OrchestratorStateMachine;

  beforeEach(() => {
    detector = new PatternDetector();
    stateMachine = new OrchestratorStateMachine();
  });

  describe("Complete Blocking Flow", () => {
    it("should detect blocking, transition to BLOCKED, and stop orchestration", () => {
      // Setup: Orchestrator is executing work
      stateMachine.transition(OrchestratorState.PLANNING, "User command");
      stateMachine.transition(OrchestratorState.EXECUTING, "Plan ready");

      // Orchestrator sends a message that should trigger blocking
      const message = "Should I merge PR #111 or PR #112 first?";
      const result = detector.detect(message);

      // Pattern detector should identify blocking
      expect(result.matched).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(70);
      expect(result.category).toBe(BlockingCategory.DECISION);

      // Transition to BLOCKED state
      const blockEvent = stateMachine.transition(
        OrchestratorState.BLOCKED,
        result.reasoning.join("; "),
        "system"
      );

      // Verify blocked state
      expect(stateMachine.getState()).toBe(OrchestratorState.BLOCKED);
      expect(stateMachine.isBlocked()).toBe(true);
      expect(blockEvent.reason).toContain("Matched");
    });

    it("should resume from BLOCKED when user provides input", () => {
      // Start blocked
      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.transition(OrchestratorState.BLOCKED, "Decision needed");

      // User provides input
      const resumeEvent = stateMachine.transition(
        OrchestratorState.PLANNING,
        "User: Merge #111 first",
        "user"
      );

      // Verify resumed
      expect(stateMachine.getState()).toBe(OrchestratorState.PLANNING);
      expect(stateMachine.isBlocked()).toBe(false);
      expect(resumeEvent.triggeredBy).toBe("user");
    });

    it("should allow user to abort from BLOCKED state", () => {
      // Start blocked
      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.transition(OrchestratorState.BLOCKED, "Blocked");

      // User aborts
      const abortEvent = stateMachine.transition(
        OrchestratorState.IDLE,
        "User: abort",
        "user"
      );

      // Verify returned to idle
      expect(stateMachine.getState()).toBe(OrchestratorState.IDLE);
      expect(abortEvent.triggeredBy).toBe("user");
    });
  });

  describe("Real-World Blocking Scenarios", () => {
    it("should block on decision questions (Scenario 1)", () => {
      const messages = [
        "Should I merge PR #111 before or after PR #112?",
        "Which approach do you prefer: sequential or parallel?",
        "Do you want me to deploy to staging first?",
      ];

      for (const message of messages) {
        const result = detector.detect(message);
        expect(result.matched).toBe(true);
        expect(result.category).toBe(BlockingCategory.DECISION);
        expect(result.confidence).toBeGreaterThanOrEqual(70);
      }
    });

    it("should block on risky operations (Scenario 2)", () => {
      const messages = [
        "This will delete the production database. Should I proceed?",
        "Are you sure you want to force push to main?",
        "This operation is risky and may break backward compatibility.",
      ];

      for (const message of messages) {
        const result = detector.detect(message);
        expect(result.matched).toBe(true);
        expect(result.category).toBe(BlockingCategory.RISK);
        expect(result.confidence).toBeGreaterThanOrEqual(70);
      }
    });

    it("should block on missing information (Scenario 3)", () => {
      const messages = [
        "Need your input on the target platform before I can proceed.",
        "The requirements are unclear. What is the priority?",
        "Can you clarify what you mean by 'responsive design'?",
      ];

      for (const message of messages) {
        const result = detector.detect(message);
        expect(result.matched).toBe(true);
        expect(result.category).toBe(BlockingCategory.MISSING_INFO);
        expect(result.confidence).toBeGreaterThanOrEqual(70);
      }
    });

    it("should block on conflicts (Scenario 4)", () => {
      const messages = [
        "There's a conflict between Frontend and Backend on the API design.",
        "The requirements are contradictory - speed vs. quality.",
        "Agents disagree on the implementation approach.",
      ];

      for (const message of messages) {
        const result = detector.detect(message);
        expect(result.matched).toBe(true);
        expect(result.category).toBe(BlockingCategory.CONFLICT);
        expect(result.confidence).toBeGreaterThanOrEqual(70);
      }
    });

    it("should block on critical errors (Scenario 5)", () => {
      const messages = [
        "Critical error: All agents are down and unavailable.",
        "GitHub API is unavailable - cannot access repositories.",
        "Critical failure in the build system.",
      ];

      for (const message of messages) {
        const result = detector.detect(message);
        expect(result.matched).toBe(true);
        expect(result.category).toBe(BlockingCategory.ERROR);
        expect(result.confidence).toBeGreaterThanOrEqual(70);
      }
    });
  });

  describe("Non-Blocking Scenarios", () => {
    it("should NOT block on status updates", () => {
      const messages = [
        "Status update: Completed PR #111 review, moving to #112.",
        "Here's what I completed: Timeline UI implementation.",
        "Progress report: 3 tasks done, 2 remaining.",
      ];

      for (const message of messages) {
        const result = detector.detect(message);
        expect(result.matched).toBe(false);
        expect(result.method).toBe("none");
      }
    });

    it("should NOT block on rhetorical questions", () => {
      const messages = [
        "What's next? Let's continue with Phase 2 implementation.",
        "How's it going? Making good progress.",
        "This makes sense, right?",
      ];

      for (const message of messages) {
        const result = detector.detect(message);
        expect(result.matched).toBe(false);
      }
    });

    it("should NOT block on autonomous action statements", () => {
      const messages = [
        "I'll continue with the integration tests now.",
        "Starting execution of Phase 2.",
        "Proceeding with the merge as planned.",
      ];

      for (const message of messages) {
        const result = detector.detect(message);
        expect(result.matched).toBe(false);
      }
    });

    it("should NOT block on FYI messages", () => {
      const messages = [
        "FYI - Frontend completed the Timeline UI implementation.",
        "Just letting you know: tests are passing.",
        "Heads up: PR #111 is ready for review.",
      ];

      for (const message of messages) {
        const result = detector.detect(message);
        expect(result.matched).toBe(false);
      }
    });
  });

  describe("State Machine Integration", () => {
    it("should track complete orchestration lifecycle", () => {
      // Start orchestration
      expect(stateMachine.getState()).toBe(OrchestratorState.IDLE);

      // User gives command
      stateMachine.transition(OrchestratorState.PLANNING, "User: implement feature X");
      expect(stateMachine.getState()).toBe(OrchestratorState.PLANNING);

      // Start execution
      stateMachine.transition(OrchestratorState.EXECUTING, "Plan ready");
      expect(stateMachine.getState()).toBe(OrchestratorState.EXECUTING);

      // Hit blocking condition
      const blockingMessage = "Should I use library X or build custom?";
      const result = detector.detect(blockingMessage);
      expect(result.matched).toBe(true);

      stateMachine.transition(OrchestratorState.BLOCKED, result.reasoning[0]);
      expect(stateMachine.isBlocked()).toBe(true);

      // User responds
      stateMachine.transition(OrchestratorState.PLANNING, "User: use library X", "user");

      // Complete execution
      stateMachine.transition(OrchestratorState.EXECUTING, "Continuing");
      stateMachine.transition(OrchestratorState.REPORTING, "Work complete");

      // Return to idle
      stateMachine.transition(OrchestratorState.IDLE, "Report sent");
      expect(stateMachine.getState()).toBe(OrchestratorState.IDLE);

      // Check history
      const history = stateMachine.getHistory();
      expect(history).toHaveLength(7);

      // Find the blocked event
      const blockedEvent = history.find(e => e.to === OrchestratorState.BLOCKED);
      expect(blockedEvent).toBeDefined();

      // Find the user-triggered resume event
      const userEvent = history.find(e => e.triggeredBy === "user");
      expect(userEvent).toBeDefined();
    });

    it("should handle multiple blocking events in one session", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.transition(OrchestratorState.EXECUTING, "Execute");

      // First blocking event
      stateMachine.transition(OrchestratorState.BLOCKED, "Decision needed: PR order");
      stateMachine.transition(OrchestratorState.PLANNING, "User decided", "user");
      stateMachine.transition(OrchestratorState.EXECUTING, "Continue");

      // Second blocking event
      stateMachine.transition(OrchestratorState.BLOCKED, "Risky operation confirmation");
      stateMachine.transition(OrchestratorState.PLANNING, "User confirmed", "user");

      // Complete
      stateMachine.transition(OrchestratorState.EXECUTING, "Final execution");
      stateMachine.transition(OrchestratorState.REPORTING, "Done");
      stateMachine.transition(OrchestratorState.IDLE, "Report sent");

      const history = stateMachine.getHistory();
      const blockedEvents = history.filter(e => e.to === OrchestratorState.BLOCKED);
      expect(blockedEvents).toHaveLength(2);
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("should handle force blocking from any state", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.transition(OrchestratorState.EXECUTING, "Execute");

      // Critical error forces immediate blocking
      const forceEvent = stateMachine.forceBlock("Critical: All agents crashed");

      expect(stateMachine.isBlocked()).toBe(true);
      expect(forceEvent.reason).toContain("FORCE BLOCK");
      expect(forceEvent.reason).toContain("agents crashed");
    });

    it("should handle blocking during PLANNING phase", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start planning");

      const message = "Need your input on the architecture before I can proceed.";
      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.category).toBe(BlockingCategory.MISSING_INFO);

      // Should allow PLANNING → BLOCKED transition
      expect(stateMachine.canTransition(OrchestratorState.PLANNING, OrchestratorState.BLOCKED)).toBe(true);

      stateMachine.transition(OrchestratorState.BLOCKED, "Clarification needed");
      expect(stateMachine.isBlocked()).toBe(true);
    });

    it("should prevent invalid transitions even with blocking detected", () => {
      // Try to block from REPORTING state
      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.transition(OrchestratorState.EXECUTING, "Execute");
      stateMachine.transition(OrchestratorState.REPORTING, "Report");

      // Even if blocking is detected, invalid transition should fail
      expect(stateMachine.canTransition(OrchestratorState.REPORTING, OrchestratorState.BLOCKED)).toBe(false);

      expect(() => {
        stateMachine.transition(OrchestratorState.BLOCKED, "Try to block");
      }).toThrow("Invalid state transition");
    });

    it("should handle empty messages without crashing", () => {
      const result = detector.detect("");
      expect(result.matched).toBe(false);
      expect(result.confidence).toBe(100);
      expect(result.method).toBe("none");
    });

    it("should handle very long messages efficiently", () => {
      const longMessage = "Should I proceed? " + "context ".repeat(10000);
      const start = Date.now();
      const result = detector.detect(longMessage);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50); // Should be fast even for long messages
      expect(result.matched).toBe(true);
    });
  });

  describe("Event Emissions and Monitoring", () => {
    it("should emit events during state transitions", () => {
      const stateChangeListener = vi.fn();
      const blockedListener = vi.fn();

      stateMachine.on("state-change", stateChangeListener);
      stateMachine.on("state:blocked", blockedListener);

      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.transition(OrchestratorState.BLOCKED, "Decision needed");

      expect(stateChangeListener).toHaveBeenCalledTimes(2);
      expect(blockedListener).toHaveBeenCalledTimes(1);
      expect(blockedListener).toHaveBeenCalledWith(
        expect.objectContaining({
          to: OrchestratorState.BLOCKED,
          reason: "Decision needed"
        })
      );
    });

    it("should emit force-block event for emergency blocking", () => {
      const forceBlockListener = vi.fn();
      stateMachine.on("force-block", forceBlockListener);

      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.forceBlock("Emergency");

      expect(forceBlockListener).toHaveBeenCalledTimes(1);
      expect(forceBlockListener).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.stringContaining("FORCE BLOCK")
        })
      );
    });

    it("should track time in blocked state", async () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.transition(OrchestratorState.BLOCKED, "Blocked");

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));

      const timeBlocked = stateMachine.getTimeInCurrentState();
      expect(timeBlocked).toBeGreaterThanOrEqual(100);
      expect(timeBlocked).toBeLessThan(200);
    });
  });

  describe("Pattern + State Machine Coordination", () => {
    it("should block only when confidence is high enough", () => {
      // Ambiguous message with low confidence
      const ambiguous = "Maybe we could consider alternatives.";
      const result = detector.detect(ambiguous);

      // Should either not match or have low confidence
      if (result.matched) {
        expect(result.confidence).toBeLessThan(detector.getConfidenceThreshold());
      }

      // Should not trigger state transition
      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.transition(OrchestratorState.EXECUTING, "Execute");

      // If confidence is too low, don't block
      if (!result.matched || result.confidence < 70) {
        expect(stateMachine.getState()).toBe(OrchestratorState.EXECUTING);
      }
    });

    it("should provide detailed reasoning for blocking decisions", () => {
      const message = "Should I merge PR #111 or wait for PR #112?";
      const result = detector.detect(message);

      expect(result.matched).toBe(true);
      expect(result.reasoning).toBeInstanceOf(Array);
      expect(result.reasoning.length).toBeGreaterThan(0);

      // Reasoning should be descriptive
      const reasoning = result.reasoning.join(" ");
      expect(reasoning).toContain("Matched");
      expect(reasoning.toLowerCase()).toContain("decision");
    });

    it("should allow different categories to trigger blocking", () => {
      const testCases = [
        { message: "Should I proceed?", expectedCategory: BlockingCategory.DECISION },
        { message: "This will delete data.", expectedCategory: BlockingCategory.RISK },
        { message: "Need clarification.", expectedCategory: BlockingCategory.MISSING_INFO },
        { message: "Agents disagree.", expectedCategory: BlockingCategory.CONFLICT },
        { message: "Critical error occurred.", expectedCategory: BlockingCategory.ERROR },
      ];

      for (const testCase of testCases) {
        const result = detector.detect(testCase.message);
        expect(result.matched).toBe(true);
        expect(result.category).toBe(testCase.expectedCategory);
      }
    });
  });

  describe("Explicit Blocking Marker", () => {
    it("should respect explicit blocking marker with 100% confidence", () => {
      const explicitBlock = `
I need your decision:

\`\`\`blocking-request
reason: "Need approval for database migration"
category: "decision"
\`\`\`
      `;

      const result = detector.detect(explicitBlock);

      expect(result.matched).toBe(true);
      expect(result.confidence).toBe(100);
      expect(result.method).toBe("explicit");
      expect(result.category).toBe(BlockingCategory.DECISION);
    });

    it("should extract category from explicit marker", () => {
      const explicitBlock = `
\`\`\`blocking-request
reason: "Risky operation"
category: "risk"
\`\`\`
      `;

      const result = detector.detect(explicitBlock);

      expect(result.category).toBe(BlockingCategory.RISK);
      expect(result.confidence).toBe(100);
    });

    it("should handle explicit marker with invalid category gracefully", () => {
      const explicitBlock = `
\`\`\`blocking-request
reason: "Test"
category: "invalid_category"
\`\`\`
      `;

      const result = detector.detect(explicitBlock);

      // Should default to DECISION
      expect(result.category).toBe(BlockingCategory.DECISION);
      expect(result.matched).toBe(true);
    });
  });

  describe("Performance and Scalability", () => {
    it("should handle rapid state transitions", () => {
      for (let i = 0; i < 100; i++) {
        stateMachine.transition(OrchestratorState.PLANNING, `Iteration ${i}`);
        stateMachine.transition(OrchestratorState.EXECUTING, `Execute ${i}`);
        stateMachine.transition(OrchestratorState.REPORTING, `Report ${i}`);
        stateMachine.transition(OrchestratorState.IDLE, `Idle ${i}`);
      }

      const history = stateMachine.getHistory();
      expect(history).toHaveLength(400);
      expect(stateMachine.getState()).toBe(OrchestratorState.IDLE);
    });

    it("should detect patterns in batch messages efficiently", () => {
      const messages = Array(100).fill("Should I proceed?");

      const start = Date.now();
      for (const message of messages) {
        detector.detect(message);
      }
      const elapsed = Date.now() - start;

      // Should process 100 messages in under 500ms
      expect(elapsed).toBeLessThan(500);
    });
  });
});
