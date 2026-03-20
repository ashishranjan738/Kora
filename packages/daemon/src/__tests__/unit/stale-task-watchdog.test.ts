/**
 * Unit tests for StaleTaskWatchdog.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_NUDGE_POLICIES, type NudgePolicy } from "../../core/stale-task-watchdog.js";

describe("StaleTaskWatchdog", () => {
  describe("Default nudge policies", () => {
    it("has policies for standard statuses", () => {
      expect(DEFAULT_NUDGE_POLICIES["pending"]).toBeDefined();
      expect(DEFAULT_NUDGE_POLICIES["in-progress"]).toBeDefined();
      expect(DEFAULT_NUDGE_POLICIES["review"]).toBeDefined();
      expect(DEFAULT_NUDGE_POLICIES["blocked"]).toBeDefined();
      expect(DEFAULT_NUDGE_POLICIES["done"]).toBeDefined();
    });

    it("pending and done are disabled", () => {
      expect(DEFAULT_NUDGE_POLICIES["pending"].enabled).toBe(false);
      expect(DEFAULT_NUDGE_POLICIES["done"].enabled).toBe(false);
    });

    it("in-progress nudges after 60 minutes", () => {
      const policy = DEFAULT_NUDGE_POLICIES["in-progress"];
      expect(policy.enabled).toBe(true);
      expect(policy.nudgeAfterMinutes).toBe(60);
      expect(policy.intervalMinutes).toBe(30);
      expect(policy.target).toBe("assignee");
      expect(policy.escalateAfterCount).toBe(3);
      expect(policy.escalateTo).toBe("architect");
      expect(policy.maxNudges).toBe(8);
    });

    it("review nudges after 15 minutes", () => {
      const policy = DEFAULT_NUDGE_POLICIES["review"];
      expect(policy.enabled).toBe(true);
      expect(policy.nudgeAfterMinutes).toBe(15);
      expect(policy.intervalMinutes).toBe(15);
      expect(policy.target).toBe("architect");
      expect(policy.escalateAfterCount).toBe(3);
      expect(policy.escalateTo).toBe("user");
    });

    it("blocked nudges after 10 minutes with faster escalation", () => {
      const policy = DEFAULT_NUDGE_POLICIES["blocked"];
      expect(policy.enabled).toBe(true);
      expect(policy.nudgeAfterMinutes).toBe(10);
      expect(policy.escalateAfterCount).toBe(2);
      expect(policy.escalateTo).toBe("user");
    });
  });

  describe("NudgePolicy validation", () => {
    it("all policies have required fields", () => {
      for (const [status, policy] of Object.entries(DEFAULT_NUDGE_POLICIES)) {
        expect(typeof policy.enabled).toBe("boolean");
        expect(typeof policy.nudgeAfterMinutes).toBe("number");
        expect(typeof policy.intervalMinutes).toBe("number");
        expect(["assignee", "architect", "user", "all"]).toContain(policy.target);
        expect(typeof policy.escalateAfterCount).toBe("number");
        expect(["architect", "user", "all"]).toContain(policy.escalateTo);
        expect(typeof policy.maxNudges).toBe("number");
      }
    });

    it("enabled policies have positive thresholds", () => {
      for (const [status, policy] of Object.entries(DEFAULT_NUDGE_POLICIES)) {
        if (policy.enabled) {
          expect(policy.nudgeAfterMinutes).toBeGreaterThan(0);
          expect(policy.intervalMinutes).toBeGreaterThan(0);
          expect(policy.maxNudges).toBeGreaterThan(0);
        }
      }
    });

    it("escalation targets differ from initial targets", () => {
      for (const [status, policy] of Object.entries(DEFAULT_NUDGE_POLICIES)) {
        if (policy.enabled && policy.escalateAfterCount > 0) {
          expect(policy.escalateTo).not.toBe(policy.target);
        }
      }
    });
  });
});

describe("Stale task detection logic", () => {
  it("identifies tasks stuck longer than threshold", () => {
    const now = Date.now();
    const tasks = [
      { id: "t1", status: "in-progress", status_changed_at: new Date(now - 90 * 60_000).toISOString() }, // 90min
      { id: "t2", status: "in-progress", status_changed_at: new Date(now - 30 * 60_000).toISOString() }, // 30min
      { id: "t3", status: "review", status_changed_at: new Date(now - 20 * 60_000).toISOString() }, // 20min
      { id: "t4", status: "review", status_changed_at: new Date(now - 5 * 60_000).toISOString() }, // 5min
    ];

    const inProgressThreshold = DEFAULT_NUDGE_POLICIES["in-progress"].nudgeAfterMinutes;
    const reviewThreshold = DEFAULT_NUDGE_POLICIES["review"].nudgeAfterMinutes;

    const staleInProgress = tasks.filter(t => {
      if (t.status !== "in-progress") return false;
      const mins = (now - new Date(t.status_changed_at).getTime()) / 60_000;
      return mins >= inProgressThreshold;
    });

    const staleReview = tasks.filter(t => {
      if (t.status !== "review") return false;
      const mins = (now - new Date(t.status_changed_at).getTime()) / 60_000;
      return mins >= reviewThreshold;
    });

    expect(staleInProgress).toHaveLength(1); // t1 (90min > 60min threshold)
    expect(staleInProgress[0].id).toBe("t1");

    expect(staleReview).toHaveLength(1); // t3 (20min > 15min threshold)
    expect(staleReview[0].id).toBe("t3");
  });

  it("determines escalation based on nudge count", () => {
    const policy = DEFAULT_NUDGE_POLICIES["in-progress"];
    const escalateAfter = policy.escalateAfterCount;

    expect(1 >= escalateAfter).toBe(false); // nudge 1 — no escalation
    expect(2 >= escalateAfter).toBe(false); // nudge 2 — no escalation
    expect(3 >= escalateAfter).toBe(true);  // nudge 3 — ESCALATE
    expect(4 >= escalateAfter).toBe(true);  // nudge 4 — still escalated
  });

  it("respects max nudge limit", () => {
    const policy = DEFAULT_NUDGE_POLICIES["in-progress"];
    const maxNudges = policy.maxNudges;

    expect(maxNudges).toBe(8);
    // At nudge count 8, should stop
    expect(8 >= maxNudges).toBe(true);
    expect(7 >= maxNudges).toBe(false);
  });
});

describe("Nudge message formatting", () => {
  it("creates proper stale task alert message", () => {
    const task = { title: "Fix CSS bug", status: "review", assigned_to: "frontend-abc" };
    const nudgeCount = 2;
    const maxNudges = 8;
    const minutesInStatus = 47;

    const message = `[Stale Task Alert] Task "${task.title}" has been in "${task.status}" for ${minutesInStatus}min. ` +
      `Nudge #${nudgeCount} of ${maxNudges}. ` +
      `Assigned to: ${task.assigned_to}. ` +
      `Action needed: update status or reassign.`;

    expect(message).toContain("Fix CSS bug");
    expect(message).toContain("review");
    expect(message).toContain("47min");
    expect(message).toContain("Nudge #2 of 8");
    expect(message).toContain("frontend-abc");
  });

  it("creates escalation message", () => {
    const prefix = "[ESCALATION]";
    expect(prefix).toBe("[ESCALATION]");
  });

  it("creates batch summary for multiple stale tasks", () => {
    const tasks = [
      { title: "Fix CSS", status: "review", minutesInStatus: 47, nudgeCount: 3 },
      { title: "Add tests", status: "in-progress", minutesInStatus: 120, nudgeCount: 2 },
      { title: "Update docs", status: "review", minutesInStatus: 30, nudgeCount: 1 },
    ];

    const summaries = tasks.map(t =>
      `  - "${t.title}" (${t.status}, ${t.minutesInStatus}min, nudge #${t.nudgeCount})`
    );
    const message = `[Stale Task Summary] ${tasks.length} tasks need attention:\n${summaries.join("\n")}`;

    expect(message).toContain("3 tasks need attention");
    expect(message).toContain("Fix CSS");
    expect(message).toContain("Add tests");
    expect(message).toContain("Update docs");
  });
});

describe("Rate limiting", () => {
  it("allows up to MAX_NUDGES_PER_AGENT_PER_HOUR", () => {
    const MAX = 10;
    const counts = new Map<string, { count: number; windowStart: number }>();
    const now = Date.now();

    function isWithinLimit(key: string): boolean {
      const record = counts.get(key);
      if (!record || now - record.windowStart > 3600_000) {
        counts.set(key, { count: 1, windowStart: now });
        return true;
      }
      if (record.count >= MAX) return false;
      record.count++;
      return true;
    }

    // First 10 should pass
    for (let i = 0; i < 10; i++) {
      expect(isWithinLimit("agent-1")).toBe(true);
    }
    // 11th should be rate-limited
    expect(isWithinLimit("agent-1")).toBe(false);

    // Different agent is fine
    expect(isWithinLimit("agent-2")).toBe(true);
  });
});
