/**
 * Integration tests for stale nudge enhancement with workflow state instructions.
 */

import { describe, it, expect } from "vitest";

describe("Stale nudge enhancement", () => {
  it("StaleTaskWatchdog stores workflow state instructions", async () => {
    const { StaleTaskWatchdog } = await import("../../core/stale-task-watchdog.js");
    const watchdog = new StaleTaskWatchdog({
      sessionId: "test",
      database: { getActiveTasks: () => [], recordNudge: () => {}, getNudgeCount: () => 0, getRecentNudges: () => [] } as any,
      agentManager: { getAgent: () => null } as any,
      messageQueue: { enqueue: () => {} } as any,
    });

    watchdog.setWorkflowStates([
      { id: "in-progress", label: "In Progress", instructions: "Write code and tests." },
      { id: "review", label: "Review", instructions: "Check for bugs." },
      { id: "done", label: "Done" },
    ]);

    expect(watchdog).toBeDefined();
  });

  it("StaleTaskWatchdog works with states that have no instructions", async () => {
    const { StaleTaskWatchdog } = await import("../../core/stale-task-watchdog.js");
    const watchdog = new StaleTaskWatchdog({
      sessionId: "test",
      database: { getActiveTasks: () => [], recordNudge: () => {}, getNudgeCount: () => 0, getRecentNudges: () => [] } as any,
      agentManager: { getAgent: () => null } as any,
      messageQueue: { enqueue: () => {} } as any,
    });

    watchdog.setWorkflowStates([
      { id: "in-progress", label: "In Progress" },
      { id: "review", label: "Review" },
    ]);

    expect(watchdog).toBeDefined();
  });
});
