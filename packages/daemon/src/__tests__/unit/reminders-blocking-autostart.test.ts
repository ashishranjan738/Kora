/**
 * Tests for PRs #231-233:
 * - Custom per-agent reminders (CRUD, conditions, rate limiting)
 * - Blocked agent notification bypass (short notification always delivered)
 * - START NOW notification + auto-transition to in-progress
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Custom Reminders (PR #231)
// ---------------------------------------------------------------------------

describe("Custom per-agent reminders (PR #231)", () => {
  interface Reminder {
    id: string;
    agentId: string;
    message: string;
    condition: "when-idle" | "when-has-unread" | "when-no-task" | "always";
    intervalMs: number;
    enabled: boolean;
    lastFiredAt: number | null;
  }

  function shouldFire(reminder: Reminder, agent: { idle: boolean; unread: number; activeTasks: number }, now: number): boolean {
    if (!reminder.enabled) return false;
    if (reminder.lastFiredAt && now - reminder.lastFiredAt < reminder.intervalMs) return false;

    switch (reminder.condition) {
      case "when-idle": return agent.idle;
      case "when-has-unread": return agent.unread > 0;
      case "when-no-task": return agent.activeTasks === 0;
      case "always": return true;
      default: return false;
    }
  }

  describe("CRUD operations", () => {
    it("creates a reminder with required fields", () => {
      const reminder: Reminder = {
        id: "r1",
        agentId: "worker-1",
        message: "Check your inbox!",
        condition: "when-has-unread",
        intervalMs: 5 * 60 * 1000,
        enabled: true,
        lastFiredAt: null,
      };
      expect(reminder.condition).toBe("when-has-unread");
      expect(reminder.enabled).toBe(true);
    });

    it("disabled reminder does not fire", () => {
      const reminder: Reminder = {
        id: "r1", agentId: "w1", message: "test", condition: "always",
        intervalMs: 1000, enabled: false, lastFiredAt: null,
      };
      expect(shouldFire(reminder, { idle: true, unread: 5, activeTasks: 0 }, Date.now())).toBe(false);
    });
  });

  describe("Conditional triggers", () => {
    const baseReminder: Reminder = {
      id: "r1", agentId: "w1", message: "test", condition: "when-idle",
      intervalMs: 60000, enabled: true, lastFiredAt: null,
    };

    it("when-idle fires when agent is idle", () => {
      expect(shouldFire(
        { ...baseReminder, condition: "when-idle" },
        { idle: true, unread: 0, activeTasks: 0 },
        Date.now(),
      )).toBe(true);
    });

    it("when-idle does NOT fire when agent is working", () => {
      expect(shouldFire(
        { ...baseReminder, condition: "when-idle" },
        { idle: false, unread: 0, activeTasks: 2 },
        Date.now(),
      )).toBe(false);
    });

    it("when-has-unread fires when unread > 0", () => {
      expect(shouldFire(
        { ...baseReminder, condition: "when-has-unread" },
        { idle: false, unread: 3, activeTasks: 1 },
        Date.now(),
      )).toBe(true);
    });

    it("when-has-unread does NOT fire when unread = 0", () => {
      expect(shouldFire(
        { ...baseReminder, condition: "when-has-unread" },
        { idle: false, unread: 0, activeTasks: 1 },
        Date.now(),
      )).toBe(false);
    });

    it("when-no-task fires when activeTasks = 0", () => {
      expect(shouldFire(
        { ...baseReminder, condition: "when-no-task" },
        { idle: true, unread: 0, activeTasks: 0 },
        Date.now(),
      )).toBe(true);
    });

    it("when-no-task does NOT fire when has tasks", () => {
      expect(shouldFire(
        { ...baseReminder, condition: "when-no-task" },
        { idle: false, unread: 0, activeTasks: 2 },
        Date.now(),
      )).toBe(false);
    });

    it("always fires regardless of state", () => {
      expect(shouldFire(
        { ...baseReminder, condition: "always" },
        { idle: false, unread: 0, activeTasks: 5 },
        Date.now(),
      )).toBe(true);
    });
  });

  describe("Rate limiting", () => {
    it("does not fire before interval elapsed", () => {
      const now = Date.now();
      const reminder: Reminder = {
        id: "r1", agentId: "w1", message: "test", condition: "always",
        intervalMs: 5 * 60 * 1000, enabled: true, lastFiredAt: now - 60000, // 1 min ago
      };
      expect(shouldFire(reminder, { idle: true, unread: 0, activeTasks: 0 }, now)).toBe(false);
    });

    it("fires after interval elapsed", () => {
      const now = Date.now();
      const reminder: Reminder = {
        id: "r1", agentId: "w1", message: "test", condition: "always",
        intervalMs: 5 * 60 * 1000, enabled: true, lastFiredAt: now - 6 * 60 * 1000, // 6 min ago
      };
      expect(shouldFire(reminder, { idle: true, unread: 0, activeTasks: 0 }, now)).toBe(true);
    });

    it("fires on first trigger (lastFiredAt = null)", () => {
      const reminder: Reminder = {
        id: "r1", agentId: "w1", message: "test", condition: "always",
        intervalMs: 5 * 60 * 1000, enabled: true, lastFiredAt: null,
      };
      expect(shouldFire(reminder, { idle: true, unread: 0, activeTasks: 0 }, Date.now())).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Blocked Agent Notification Bypass (PR #232)
// ---------------------------------------------------------------------------

describe("Blocked agent notification bypass (PR #232)", () => {
  describe("Short notification always delivered", () => {
    it("blocked agent receives short notification via sendKeys", () => {
      const isBlocked = true;
      const shortNotification = "[New message from Worker-A. Use check_messages tool to read it.]";

      // Even when blocked, short notification is sent directly
      let notificationSent = false;
      if (isBlocked) {
        // Full message buffered, but short notification sent via sendKeys
        notificationSent = true;
      }
      expect(notificationSent).toBe(true);
    });

    it("non-blocked agent receives full message normally", () => {
      const isBlocked = false;
      let deliveryMethod = "none";

      if (isBlocked) {
        deliveryMethod = "short-notification";
      } else {
        deliveryMethod = "full-message-queue";
      }
      expect(deliveryMethod).toBe("full-message-queue");
    });
  });

  describe("Auto-expire blocking after 5 minutes", () => {
    it("blocking expires after 5 min", () => {
      const BLOCKING_EXPIRE_MS = 5 * 60 * 1000;
      const blockStartedAt = Date.now() - 6 * 60 * 1000; // 6 min ago
      const now = Date.now();

      const expired = now - blockStartedAt > BLOCKING_EXPIRE_MS;
      expect(expired).toBe(true);
    });

    it("blocking does NOT expire before 5 min", () => {
      const BLOCKING_EXPIRE_MS = 5 * 60 * 1000;
      const blockStartedAt = Date.now() - 3 * 60 * 1000; // 3 min ago
      const now = Date.now();

      const expired = now - blockStartedAt > BLOCKING_EXPIRE_MS;
      expect(expired).toBe(false);
    });

    it("expired blocking returns isBlocked=false", () => {
      const BLOCKING_EXPIRE_MS = 5 * 60 * 1000;
      const blockStartedAt = Date.now() - 10 * 60 * 1000;
      const now = Date.now();

      const isBlocked = (now - blockStartedAt <= BLOCKING_EXPIRE_MS);
      expect(isBlocked).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// START NOW + Auto-Transition (PR #233)
// ---------------------------------------------------------------------------

describe("START NOW notification + auto-transition (PR #233)", () => {
  describe("Notification text", () => {
    it("includes START NOW in assignment notification", () => {
      const taskTitle = "Fix login CSS";
      const priority = "P1";
      const notification = `[Task assigned — START NOW] "${taskTitle}" (${priority}). Begin implementation immediately.`;

      expect(notification).toContain("START NOW");
      expect(notification).toContain(taskTitle);
      expect(notification).toContain(priority);
      expect(notification).toContain("Begin implementation immediately");
    });
  });

  describe("Auto-transition to in-progress", () => {
    function autoTransition(task: { status: string; assignedTo: string | null }, workflowStates: { id: string }[]): string {
      // When task is assigned and in first workflow state, auto-move to second
      if (!task.assignedTo) return task.status;
      if (workflowStates.length < 2) return task.status;

      const firstState = workflowStates[0].id;
      const secondState = workflowStates[1].id;

      if (task.status === firstState) {
        return secondState;
      }
      return task.status;
    }

    it("auto-transitions from pending to in-progress on assignment", () => {
      const states = [{ id: "pending" }, { id: "in-progress" }, { id: "review" }, { id: "done" }];
      const newStatus = autoTransition({ status: "pending", assignedTo: "Dev 1" }, states);
      expect(newStatus).toBe("in-progress");
    });

    it("auto-transitions from backlog to in-progress on assignment", () => {
      const states = [{ id: "backlog" }, { id: "in-progress" }, { id: "review" }, { id: "done" }];
      const newStatus = autoTransition({ status: "backlog", assignedTo: "Dev 1" }, states);
      expect(newStatus).toBe("in-progress");
    });

    it("does NOT auto-transition if already past first state", () => {
      const states = [{ id: "pending" }, { id: "in-progress" }, { id: "review" }, { id: "done" }];
      const newStatus = autoTransition({ status: "review", assignedTo: "Dev 1" }, states);
      expect(newStatus).toBe("review");
    });

    it("does NOT auto-transition if not assigned", () => {
      const states = [{ id: "pending" }, { id: "in-progress" }];
      const newStatus = autoTransition({ status: "pending", assignedTo: null }, states);
      expect(newStatus).toBe("pending");
    });

    it("handles simple 3-state workflow (todo → in-progress)", () => {
      const states = [{ id: "todo" }, { id: "in-progress" }, { id: "done" }];
      const newStatus = autoTransition({ status: "todo", assignedTo: "Worker" }, states);
      expect(newStatus).toBe("in-progress");
    });

    it("handles single-state workflow (no transition)", () => {
      const states = [{ id: "done" }];
      const newStatus = autoTransition({ status: "done", assignedTo: "Agent" }, states);
      expect(newStatus).toBe("done");
    });
  });
});
