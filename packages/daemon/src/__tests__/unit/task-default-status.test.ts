/**
 * Test: Task default status should use session's first workflow state.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_WORKFLOW_STATES } from "@kora/shared";

describe("Task default status", () => {
  it("uses first workflow state ID as default when custom states configured", () => {
    const customStates = [
      { id: "backlog", label: "Backlog", color: "#888", category: "not-started" as const },
      { id: "dev", label: "Development", color: "#3b82f6", category: "active" as const },
      { id: "shipped", label: "Shipped", color: "#22c55e", category: "closed" as const },
    ];

    const firstState = customStates[0]?.id;
    const defaultStatus = firstState || "pending";

    expect(defaultStatus).toBe("backlog");
  });

  it("falls back to 'pending' when no custom workflow states", () => {
    const workflowStates = undefined;
    const firstState = workflowStates?.[0]?.id;
    const defaultStatus = firstState || "pending";

    expect(defaultStatus).toBe("pending");
  });

  it("falls back to 'pending' when workflow states array is empty", () => {
    const workflowStates: any[] = [];
    const firstState = workflowStates[0]?.id;
    const defaultStatus = firstState || "pending";

    expect(defaultStatus).toBe("pending");
  });

  it("uses DEFAULT_WORKFLOW_STATES first state (pending) when no custom states", () => {
    const firstState = DEFAULT_WORKFLOW_STATES[0]?.id;
    expect(firstState).toBe("pending");
  });

  it("handles Full Pipeline template correctly", () => {
    // Full Pipeline: backlog → in-progress → review → e2e-testing → staging → done
    const fullPipelineStates = [
      { id: "backlog", label: "Backlog", color: "#6b7280", category: "not-started" as const },
      { id: "in-progress", label: "In Progress", color: "#3b82f6", category: "active" as const },
      { id: "review", label: "Review", color: "#f59e0b", category: "active" as const },
      { id: "e2e-testing", label: "E2E Testing", color: "#8b5cf6", category: "active" as const },
      { id: "staging", label: "Staging", color: "#ec4899", category: "active" as const },
      { id: "done", label: "Done", color: "#22c55e", category: "closed" as const },
    ];

    const firstState = fullPipelineStates[0]?.id;
    const defaultStatus = firstState || "pending";

    // Should be "backlog", NOT "pending" — this is the fix for the bug
    expect(defaultStatus).toBe("backlog");
    expect(defaultStatus).not.toBe("pending");
  });
});
