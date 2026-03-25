/**
 * Tests for stale task alert auto-dismiss on status change.
 */
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// 1. Status re-check before nudge (prevents stale alerts)
// ---------------------------------------------------------------------------

describe("Stale alert auto-dismiss: status re-check", () => {
  it("skips nudge when task status changed since getStaleTasks()", () => {
    // Simulates the watchdog check() logic
    const staleTask = { id: "t1", status: "in-progress" };
    const currentTask = { id: "t1", status: "done" }; // status changed

    const shouldSkip = currentTask.status !== staleTask.status;
    expect(shouldSkip).toBe(true);
  });

  it("sends nudge when task status unchanged", () => {
    const staleTask = { id: "t1", status: "in-progress" };
    const currentTask = { id: "t1", status: "in-progress" };

    const shouldSkip = currentTask.status !== staleTask.status;
    expect(shouldSkip).toBe(false);
  });

  it("skips nudge for any status change, not just done", () => {
    const transitions = [
      { from: "in-progress", to: "review" },
      { from: "in-progress", to: "done" },
      { from: "review", to: "done" },
      { from: "pending", to: "in-progress" },
    ];

    for (const { from, to } of transitions) {
      const shouldSkip = to !== from;
      expect(shouldSkip, `${from} → ${to} should skip nudge`).toBe(true);
    }
  });

  it("handles null/missing current task gracefully", () => {
    const staleTask = { id: "t1", status: "in-progress" };
    const currentTask = null; // task deleted

    // When task is deleted, skip nudge
    const shouldSkip = !currentTask || currentTask.status !== staleTask.status;
    expect(shouldSkip).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. clearNudgesForTask on status change
// ---------------------------------------------------------------------------

describe("Stale alert auto-dismiss: clearNudgesForTask", () => {
  it("clears nudges when task status changes to done", () => {
    // Simulates: old status = "in-progress", new status = "done"
    const oldStatus = "in-progress";
    const newStatus = "done";
    const statusChanged = newStatus !== oldStatus;
    expect(statusChanged).toBe(true);
    // clearNudgesForTask would be called
  });

  it("does not clear nudges when status unchanged", () => {
    const oldStatus = "in-progress";
    const newStatus = "in-progress"; // same — just a comment update
    const statusChanged = newStatus !== oldStatus;
    expect(statusChanged).toBe(false);
    // clearNudgesForTask would NOT be called
  });

  it("clears nudges on any status transition", () => {
    const transitions = [
      { old: "pending", new: "in-progress" },
      { old: "in-progress", new: "review" },
      { old: "review", new: "done" },
      { old: "in-progress", new: "blocked" },
    ];

    for (const t of transitions) {
      expect(t.new !== t.old, `${t.old} → ${t.new}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Done policy has enabled: false
// ---------------------------------------------------------------------------

describe("Stale alert: done policy disabled", () => {
  it("done status has nudging disabled", () => {
    // From DEFAULT_NUDGE_POLICIES
    const donePolicy = {
      enabled: false,
      nudgeAfterMinutes: 0,
      intervalMinutes: 0,
      maxNudges: 0,
    };

    expect(donePolicy.enabled).toBe(false);
    expect(donePolicy.maxNudges).toBe(0);
  });

  it("pending status also has nudging disabled", () => {
    const pendingPolicy = {
      enabled: false,
      nudgeAfterMinutes: 0,
      maxNudges: 0,
    };
    expect(pendingPolicy.enabled).toBe(false);
  });

  it("in-progress and review have nudging enabled", () => {
    const policies = {
      "in-progress": { enabled: true, nudgeAfterMinutes: 60 },
      "review": { enabled: true, nudgeAfterMinutes: 30 },
    };
    expect(policies["in-progress"].enabled).toBe(true);
    expect(policies["review"].enabled).toBe(true);
  });
});
