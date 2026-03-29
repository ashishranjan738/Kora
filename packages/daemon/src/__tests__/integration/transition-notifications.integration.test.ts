/**
 * Integration tests for task transition notifications.
 * Tests runbook delivery, variable interpolation, cancellation, reassignment, backward movement.
 */

import { describe, it, expect } from "vitest";
import {
  resolveVariables,
  buildTransitionNotification,
  buildCancellationNotification,
  buildBackwardNotification,
  buildReassignmentNotification,
} from "../../core/variable-resolver.js";
import type { ResolverContext } from "../../core/variable-resolver.js";

describe("Transition notifications", () => {
  const baseCtx: ResolverContext = {
    task: { id: "abc123", title: "Fix login bug", priority: "P0", status: "review", assignedTo: "dev-1" },
    newState: { id: "review", label: "Review" },
    oldState: { id: "in-progress", label: "In Progress" },
    agent: { id: "dev-1", name: "Dev 1" },
    baseBranch: "main",
    sessionId: "test-session",
  };

  it("buildTransitionNotification includes runbook instructions", () => {
    const msg = buildTransitionNotification(baseCtx, "Review the code for bugs and style issues.");
    expect(msg).toContain("Fix login bug");
    expect(msg).toContain("Review");
    expect(msg).toContain("Your instructions");
    expect(msg).toContain("Review the code for bugs and style issues.");
    expect(msg).toContain("abc123");
    expect(msg).toContain("P0");
  });

  it("resolves variables in instruction templates", () => {
    const template = "Review PR for {task.title} (task {task.id}). Push to {baseBranch}.";
    const resolved = resolveVariables(template, baseCtx);
    expect(resolved).toBe("Review PR for Fix login bug (task abc123). Push to main.");
  });

  it("buildCancellationNotification includes task info", () => {
    const ctx = { ...baseCtx, newState: { id: "done", label: "Done" } };
    const msg = buildCancellationNotification(ctx);
    expect(msg).toContain("Fix login bug");
    expect(msg).toContain("cancelled/closed");
    expect(msg).toContain("abc123");
    expect(msg).toContain("Done");
  });

  it("buildReassignmentNotification includes previous assignee", () => {
    const msg = buildReassignmentNotification(baseCtx, "Old Dev");
    expect(msg).toContain("Fix login bug");
    expect(msg).toContain("reassigned");
    expect(msg).toContain("Old Dev");
    expect(msg).toContain("abc123");
  });

  it("buildBackwardNotification shows old → new state", () => {
    const ctx = {
      ...baseCtx,
      oldState: { id: "review", label: "Review" },
      newState: { id: "in-progress", label: "In Progress" },
    };
    const msg = buildBackwardNotification(ctx, "Tests failed");
    expect(msg).toContain("backward");
    expect(msg).toContain("Review");
    expect(msg).toContain("In Progress");
    expect(msg).toContain("Tests failed");
  });

  it("unknown variables preserved in template", () => {
    const resolved = resolveVariables("Hello {unknown.var}", baseCtx);
    expect(resolved).toBe("Hello {unknown.var}");
  });

  it("buildTransitionNotification without instructions omits runbook", () => {
    const msg = buildTransitionNotification(baseCtx);
    expect(msg).toContain("Fix login bug");
    expect(msg).toContain("Review");
    expect(msg).not.toContain("Your instructions");
  });
});
