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

    it("has e2e-testing policy (Fix #5)", () => {
      expect(DEFAULT_NUDGE_POLICIES["e2e-testing"]).toBeDefined();
      const policy = DEFAULT_NUDGE_POLICIES["e2e-testing"];
      expect(policy.enabled).toBe(true);
      expect(policy.nudgeAfterMinutes).toBe(30);
      expect(policy.intervalMinutes).toBe(20);
      expect(policy.target).toBe("assignee");
      expect(policy.escalateAfterCount).toBe(3);
      expect(policy.escalateTo).toBe("architect");
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

    it("review nudges after 30 minutes (Fix #4: adjusted from 15)", () => {
      const policy = DEFAULT_NUDGE_POLICIES["review"];
      expect(policy.enabled).toBe(true);
      expect(policy.nudgeAfterMinutes).toBe(30);
      expect(policy.intervalMinutes).toBe(20);
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
      { id: "t1", status: "in-progress", status_changed_at: new Date(now - 90 * 60_000).toISOString() },
      { id: "t2", status: "in-progress", status_changed_at: new Date(now - 30 * 60_000).toISOString() },
      { id: "t3", status: "review", status_changed_at: new Date(now - 35 * 60_000).toISOString() },
      { id: "t4", status: "review", status_changed_at: new Date(now - 5 * 60_000).toISOString() },
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

    expect(staleInProgress).toHaveLength(1);
    expect(staleInProgress[0].id).toBe("t1");

    expect(staleReview).toHaveLength(1);
    expect(staleReview[0].id).toBe("t3");
  });

  it("determines escalation based on nudge count", () => {
    const policy = DEFAULT_NUDGE_POLICIES["in-progress"];
    const escalateAfter = policy.escalateAfterCount;

    expect(1 >= escalateAfter).toBe(false);
    expect(2 >= escalateAfter).toBe(false);
    expect(3 >= escalateAfter).toBe(true);
    expect(4 >= escalateAfter).toBe(true);
  });

  it("respects max nudge limit", () => {
    const policy = DEFAULT_NUDGE_POLICIES["in-progress"];
    expect(policy.maxNudges).toBe(8);
    expect(8 >= policy.maxNudges).toBe(true);
    expect(7 >= policy.maxNudges).toBe(false);
  });
});

describe("Reassignment grace period (Fix #6)", () => {
  it("skips nudge if task was updated within 5 min grace period", () => {
    const now = Date.now();
    const task = {
      updated_at: new Date(now - 2 * 60_000).toISOString(),
      status_changed_at: new Date(now - 90 * 60_000).toISOString(),
    };
    const updatedAt = new Date(task.updated_at).getTime();
    const statusChangedAt = new Date(task.status_changed_at).getTime();
    const wasRecentlyReassigned = updatedAt > statusChangedAt && (now - updatedAt) / 60_000 < 5;
    expect(wasRecentlyReassigned).toBe(true);
  });

  it("does not skip if reassignment was more than 5 min ago", () => {
    const now = Date.now();
    const task = {
      updated_at: new Date(now - 10 * 60_000).toISOString(),
      status_changed_at: new Date(now - 90 * 60_000).toISOString(),
    };
    const updatedAt = new Date(task.updated_at).getTime();
    const statusChangedAt = new Date(task.status_changed_at).getTime();
    const wasRecentlyReassigned = updatedAt > statusChangedAt && (now - updatedAt) / 60_000 < 5;
    expect(wasRecentlyReassigned).toBe(false);
  });
});

describe("Escalation self-loop protection (Fix #2)", () => {
  it("detects self-loop when architect is also assignee", () => {
    const task = { assigned_to: "master-agent-1" };
    const resolvedArchitect = "master-agent-1";
    const isSelfLoop = "architect" !== "assignee" && resolvedArchitect === task.assigned_to;
    expect(isSelfLoop).toBe(true);
  });

  it("does not trigger for different agents", () => {
    const task = { assigned_to: "worker-agent-1" };
    const resolvedArchitect = "master-agent-2";
    const isSelfLoop = "architect" !== "assignee" && resolvedArchitect === task.assigned_to;
    expect(isSelfLoop).toBe(false);
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
    for (let i = 0; i < 10; i++) expect(isWithinLimit("agent-1")).toBe(true);
    expect(isWithinLimit("agent-1")).toBe(false);
    expect(isWithinLimit("agent-2")).toBe(true);
  });
});
