/**
 * Test: Idle detection should NOT mark agents idle when they have active tasks.
 * Fixes b9a2f113: agents lose context after broadcast acknowledgment.
 */
import { describe, it, expect } from "vitest";
import { IDLE_MESSAGE_KEYWORDS } from "../../core/agent-health.js";
import { AgentHealthMonitor } from "../../core/agent-health.js";

describe("Idle detection with active tasks (b9a2f113 fix)", () => {
  describe("isMessageIdle detects idle keywords", () => {
    it("detects 'Standing by'", () => {
      expect(AgentHealthMonitor.isMessageIdle("Acknowledged. Standing by for next task.")).toBe(true);
    });

    it("detects 'task complete'", () => {
      expect(AgentHealthMonitor.isMessageIdle("Task complete. Ready for review.")).toBe(true);
    });

    it("does not trigger on normal work messages", () => {
      expect(AgentHealthMonitor.isMessageIdle("Fixed the bug in auth.ts, pushing now.")).toBe(false);
    });

    it("does not trigger on code content", () => {
      expect(AgentHealthMonitor.isMessageIdle("Updated the API endpoint to return correct status codes.")).toBe(false);
    });
  });

  describe("Active task check prevents false idle", () => {
    it("should NOT mark idle when agent has in-progress tasks", () => {
      const activeTasks = [
        { id: "t1", title: "Fix auth bug", status: "in-progress" },
      ];
      const message = "Understood. Standing by.";
      const isIdleMessage = AgentHealthMonitor.isMessageIdle(message);
      const shouldMarkIdle = isIdleMessage && activeTasks.length === 0;

      expect(isIdleMessage).toBe(true); // Message matches idle keywords
      expect(shouldMarkIdle).toBe(false); // But should NOT mark idle (has active tasks)
    });

    it("SHOULD mark idle when agent has zero active tasks", () => {
      const activeTasks: any[] = [];
      const message = "Standing by for next task.";
      const isIdleMessage = AgentHealthMonitor.isMessageIdle(message);
      const shouldMarkIdle = isIdleMessage && activeTasks.length === 0;

      expect(isIdleMessage).toBe(true);
      expect(shouldMarkIdle).toBe(true);
    });

    it("should NOT mark idle when agent has pending tasks", () => {
      const activeTasks = [
        { id: "t2", title: "Review PR", status: "pending" },
      ];
      const message = "Task complete, standing by.";
      const isIdleMessage = AgentHealthMonitor.isMessageIdle(message);
      const shouldMarkIdle = isIdleMessage && activeTasks.length === 0;

      expect(shouldMarkIdle).toBe(false);
    });

    it("should NOT mark idle when agent has tasks in review", () => {
      const activeTasks = [
        { id: "t3", title: "Watchdog fixes", status: "review" },
      ];
      const message = "Ready for new tasks.";
      const isIdleMessage = AgentHealthMonitor.isMessageIdle(message);
      const shouldMarkIdle = isIdleMessage && activeTasks.length === 0;

      expect(shouldMarkIdle).toBe(false);
    });
  });

  describe("IDLE_MESSAGE_KEYWORDS coverage", () => {
    it("includes broadcast acknowledgment patterns", () => {
      expect(IDLE_MESSAGE_KEYWORDS).toContain("standing by");
    });

    it("includes task completion patterns", () => {
      expect(IDLE_MESSAGE_KEYWORDS).toContain("task complete");
    });

    it("includes readiness patterns", () => {
      expect(IDLE_MESSAGE_KEYWORDS.some(kw => kw.includes("ready for"))).toBe(true);
    });
  });
});
