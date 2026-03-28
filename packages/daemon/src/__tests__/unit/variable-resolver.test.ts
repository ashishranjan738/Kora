/**
 * Tests for variable-resolver.ts (task 7ea7ca21).
 *
 * Verifies resolveVariables(), buildTransitionNotification(),
 * buildBackwardNotification(), buildCancellationNotification(),
 * buildReassignmentNotification().
 */
import { describe, it, expect } from "vitest";
import {
  resolveVariables,
  buildTransitionNotification,
  buildBackwardNotification,
  buildCancellationNotification,
  buildReassignmentNotification,
  type ResolverContext,
} from "../../core/variable-resolver.js";

const baseCtx: ResolverContext = {
  task: { id: "task-123", title: "Fix login bug", priority: "P1", status: "review", assignedTo: "dev-1" },
  newState: { id: "review", label: "Review" },
  oldState: { id: "in-progress", label: "In Progress" },
  agent: { id: "dev-1", name: "Dev 1" },
  baseBranch: "main",
  sessionId: "session-1",
};

describe("resolveVariables", () => {
  it("should resolve task variables", () => {
    const result = resolveVariables("Task: {task.title} [{task.id}]", baseCtx);
    expect(result).toBe("Task: Fix login bug [task-123]");
  });

  it("should resolve nested dotted paths", () => {
    const result = resolveVariables("{newState.label} from {oldState.label}", baseCtx);
    expect(result).toBe("Review from In Progress");
  });

  it("should resolve agent and session variables", () => {
    const result = resolveVariables("{agent.name} in {sessionId}", baseCtx);
    expect(result).toBe("Dev 1 in session-1");
  });

  it("should resolve baseBranch", () => {
    const result = resolveVariables("Rebase onto {baseBranch}", baseCtx);
    expect(result).toBe("Rebase onto main");
  });

  it("should leave unknown variables as-is", () => {
    const result = resolveVariables("{unknown.path} and {task.title}", baseCtx);
    expect(result).toBe("{unknown.path} and Fix login bug");
  });

  it("should handle empty template", () => {
    expect(resolveVariables("", baseCtx)).toBe("");
  });

  it("should handle template with no variables", () => {
    expect(resolveVariables("No variables here", baseCtx)).toBe("No variables here");
  });

  it("should handle missing context gracefully", () => {
    const result = resolveVariables("{task.title}", {});
    expect(result).toBe("{task.title}");
  });
});

describe("buildTransitionNotification", () => {
  it("should build notification with runbook instructions", () => {
    const msg = buildTransitionNotification(baseCtx, "Run tests and check coverage for {task.title}.");
    expect(msg).toContain('Task "Fix login bug" has entered **Review**');
    expect(msg).toContain("**Your instructions:**");
    expect(msg).toContain("Run tests and check coverage for Fix login bug.");
    expect(msg).toContain("Task ID: task-123 | Priority: P1");
  });

  it("should build notification without instructions", () => {
    const msg = buildTransitionNotification(baseCtx);
    expect(msg).toContain('Task "Fix login bug" has entered **Review**');
    expect(msg).not.toContain("Your instructions");
    expect(msg).toContain("Task ID: task-123");
  });

  it("should handle missing task info gracefully", () => {
    const msg = buildTransitionNotification({});
    expect(msg).toContain("Unknown task");
    expect(msg).toContain("unknown");
  });
});

describe("buildBackwardNotification", () => {
  it("should indicate backward movement", () => {
    const msg = buildBackwardNotification(baseCtx);
    expect(msg).toContain("moved backward");
    expect(msg).toContain("**In Progress** → **Review**");
  });

  it("should include reason if provided", () => {
    const msg = buildBackwardNotification(baseCtx, "Tests failed");
    expect(msg).toContain("Reason: Tests failed");
  });
});

describe("buildCancellationNotification", () => {
  it("should indicate cancellation", () => {
    const ctx = { ...baseCtx, newState: { id: "done", label: "Done" } };
    const msg = buildCancellationNotification(ctx);
    expect(msg).toContain("cancelled/closed");
    expect(msg).toContain("Fix login bug");
    expect(msg).toContain("Final state: Done");
  });
});

describe("buildReassignmentNotification", () => {
  it("should indicate reassignment with previous agent", () => {
    const msg = buildReassignmentNotification(baseCtx, "Dev 2");
    expect(msg).toContain("reassigned to you");
    expect(msg).toContain("Previously assigned to Dev 2");
    expect(msg).toContain("Current state: **Review**");
  });

  it("should work without previous agent", () => {
    const msg = buildReassignmentNotification(baseCtx);
    expect(msg).toContain("reassigned to you");
    expect(msg).not.toContain("Previously");
  });
});
