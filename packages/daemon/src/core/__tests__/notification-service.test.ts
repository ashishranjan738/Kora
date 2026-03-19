/**
 * Integration tests for EnhancedNotificationService.
 *
 * Tests: WebSocket event emission, notification types (agent-crash, task-complete,
 * agent-idle), storage limits (100 max FIFO), session-scoped isolation,
 * rate limiting readiness, and mark-as-read / clear-all patterns.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EnhancedNotificationService,
  type Notification,
  type NotificationType,
} from "../notification-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createService(): EnhancedNotificationService {
  return new EnhancedNotificationService();
}

function collectEmitted(service: EnhancedNotificationService): Notification[] {
  const collected: Notification[] = [];
  service.on("notification", (n) => collected.push(n));
  return collected;
}

// ---------------------------------------------------------------------------
// Tests — Core sendInApp
// ---------------------------------------------------------------------------

describe("EnhancedNotificationService", () => {
  let service: EnhancedNotificationService;

  beforeEach(() => {
    service = createService();
  });

  describe("sendInApp", () => {
    it("creates notification with auto-generated id and timestamp", () => {
      const emitted = collectEmitted(service);

      service.sendInApp({
        type: "agent-crashed",
        title: "Agent Crashed",
        body: "Worker-1 has crashed",
        sessionId: "session-1",
        agentId: "agent-1",
      });

      expect(emitted).toHaveLength(1);
      expect(emitted[0].id).toMatch(/^notif-\d+-/);
      expect(emitted[0].timestamp).toBeGreaterThan(0);
    });

    it("stores notification in internal list", () => {
      service.sendInApp({
        type: "task-complete",
        title: "Task Done",
        body: "Login page completed",
        sessionId: "session-1",
      });

      const recent = service.getRecent(10);
      expect(recent).toHaveLength(1);
      expect(recent[0].title).toBe("Task Done");
    });

    it("emits notification event for WebSocket broadcast", () => {
      const listener = vi.fn();
      service.on("notification", listener);

      service.sendInApp({
        type: "pr-ready",
        title: "PR Ready",
        body: "Frontend created PR #42",
        sessionId: "session-1",
      });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "pr-ready",
          title: "PR Ready",
        })
      );
    });

    it("preserves all fields in emitted notification", () => {
      const emitted = collectEmitted(service);

      service.sendInApp({
        type: "budget-exceeded",
        title: "Budget Exceeded",
        body: "Agent-X exceeded budget: $5.00",
        sessionId: "session-abc",
        agentId: "agent-x",
      });

      expect(emitted[0]).toMatchObject({
        type: "budget-exceeded",
        title: "Budget Exceeded",
        body: "Agent-X exceeded budget: $5.00",
        sessionId: "session-abc",
        agentId: "agent-x",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — Notification Types (agent-crash, task-complete, agent-idle triggers)
  // ---------------------------------------------------------------------------

  describe("notification type triggers", () => {
    it("agentCrashed sends agent-crashed notification", () => {
      const emitted = collectEmitted(service);

      service.agentCrashed("session-1", "agent-1", "Worker-A");

      expect(emitted).toHaveLength(1);
      expect(emitted[0].type).toBe("agent-crashed");
      expect(emitted[0].body).toContain("Worker-A");
      expect(emitted[0].body).toContain("crashed");
      expect(emitted[0].agentId).toBe("agent-1");
    });

    it("agentIdle sends agent-idle notification with duration", () => {
      const emitted = collectEmitted(service);

      // 5 minutes idle
      service.agentIdle("session-1", "agent-2", "Backend", 5 * 60 * 1000);

      expect(emitted).toHaveLength(1);
      expect(emitted[0].type).toBe("agent-idle");
      expect(emitted[0].body).toContain("Backend");
      expect(emitted[0].body).toContain("5 minutes");
    });

    it("taskCompleted sends task-complete notification", () => {
      const emitted = collectEmitted(service);

      service.taskCompleted("session-1", "Build login page", "Frontend");

      expect(emitted).toHaveLength(1);
      expect(emitted[0].type).toBe("task-complete");
      expect(emitted[0].body).toContain("Frontend");
      expect(emitted[0].body).toContain("Build login page");
    });

    it("taskCompleted works without agent name", () => {
      const emitted = collectEmitted(service);

      service.taskCompleted("session-1", "Fix tests");

      expect(emitted).toHaveLength(1);
      expect(emitted[0].body).toBe("Fix tests");
    });

    it("prReady sends pr-ready notification with URL", () => {
      const emitted = collectEmitted(service);

      service.prReady("session-1", "https://github.com/org/repo/pull/42", "Frontend");

      expect(emitted).toHaveLength(1);
      expect(emitted[0].type).toBe("pr-ready");
      expect(emitted[0].body).toContain("https://github.com/org/repo/pull/42");
    });

    it("budgetExceeded sends budget-exceeded notification with cost", () => {
      const emitted = collectEmitted(service);

      service.budgetExceeded("session-1", "agent-3", "Tests", 12.5);

      expect(emitted).toHaveLength(1);
      expect(emitted[0].type).toBe("budget-exceeded");
      expect(emitted[0].body).toContain("$12.50");
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — Storage Limit (100 max, FIFO eviction)
  // ---------------------------------------------------------------------------

  describe("storage limit (100 max, FIFO eviction)", () => {
    it("stores up to 100 notifications", () => {
      for (let i = 0; i < 100; i++) {
        service.sendInApp({
          type: "task-complete",
          title: `Task ${i}`,
          body: `Task ${i} done`,
          sessionId: "session-1",
        });
      }

      expect(service.getRecent(200)).toHaveLength(100);
    });

    it("evicts oldest notification when exceeding 100", () => {
      // Fill to 100
      for (let i = 0; i < 100; i++) {
        service.sendInApp({
          type: "task-complete",
          title: `Task ${i}`,
          body: `Task ${i} done`,
          sessionId: "session-1",
        });
      }

      // Add one more — should evict the oldest (Task 0)
      service.sendInApp({
        type: "task-complete",
        title: "Task 100",
        body: "Task 100 done",
        sessionId: "session-1",
      });

      const all = service.getRecent(200);
      expect(all).toHaveLength(100);

      // Newest should be first (unshift)
      expect(all[0].title).toBe("Task 100");

      // Oldest (Task 0) should be evicted
      const titles = all.map((n) => n.title);
      expect(titles).not.toContain("Task 0");
      expect(titles).toContain("Task 1"); // Task 1 is now the oldest
    });

    it("maintains FIFO order (newest first)", () => {
      service.sendInApp({ type: "task-complete", title: "First", body: "1", sessionId: "s" });
      service.sendInApp({ type: "task-complete", title: "Second", body: "2", sessionId: "s" });
      service.sendInApp({ type: "task-complete", title: "Third", body: "3", sessionId: "s" });

      const recent = service.getRecent(10);
      expect(recent[0].title).toBe("Third");
      expect(recent[1].title).toBe("Second");
      expect(recent[2].title).toBe("First");
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — Session-Scoped Notification Isolation
  // ---------------------------------------------------------------------------

  describe("session-scoped isolation", () => {
    it("getRecentForSession filters by sessionId", () => {
      service.sendInApp({ type: "agent-crashed", title: "Crash A", body: "a", sessionId: "session-a" });
      service.sendInApp({ type: "task-complete", title: "Task B", body: "b", sessionId: "session-b" });
      service.sendInApp({ type: "agent-idle", title: "Idle A", body: "c", sessionId: "session-a" });
      service.sendInApp({ type: "pr-ready", title: "PR C", body: "d", sessionId: "session-c" });

      const sessionA = service.getRecentForSession("session-a", 10);
      expect(sessionA).toHaveLength(2);
      expect(sessionA.every((n) => n.sessionId === "session-a")).toBe(true);

      const sessionB = service.getRecentForSession("session-b", 10);
      expect(sessionB).toHaveLength(1);
      expect(sessionB[0].title).toBe("Task B");

      const sessionC = service.getRecentForSession("session-c", 10);
      expect(sessionC).toHaveLength(1);
    });

    it("getRecentForSession returns empty for unknown session", () => {
      service.sendInApp({ type: "task-complete", title: "Task", body: "x", sessionId: "session-1" });

      const result = service.getRecentForSession("unknown-session", 10);
      expect(result).toEqual([]);
    });

    it("getRecentForSession respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        service.sendInApp({ type: "task-complete", title: `T${i}`, body: `${i}`, sessionId: "s1" });
      }

      const limited = service.getRecentForSession("s1", 3);
      expect(limited).toHaveLength(3);
    });

    it("notifications from different sessions don't interfere", () => {
      // Create 50 notifications for session-a and 50 for session-b
      for (let i = 0; i < 50; i++) {
        service.sendInApp({ type: "task-complete", title: `A-${i}`, body: "", sessionId: "session-a" });
        service.sendInApp({ type: "task-complete", title: `B-${i}`, body: "", sessionId: "session-b" });
      }

      // Global should have all 100
      expect(service.getRecent(200)).toHaveLength(100);

      // Each session should have its own 50
      expect(service.getRecentForSession("session-a", 100)).toHaveLength(50);
      expect(service.getRecentForSession("session-b", 100)).toHaveLength(50);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — getRecent
  // ---------------------------------------------------------------------------

  describe("getRecent", () => {
    it("returns empty array when no notifications", () => {
      expect(service.getRecent(10)).toEqual([]);
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        service.sendInApp({ type: "task-complete", title: `T${i}`, body: "", sessionId: "s" });
      }

      expect(service.getRecent(3)).toHaveLength(3);
      expect(service.getRecent(10)).toHaveLength(5);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — Rate Limiting Readiness (idle notification throttle)
  // ---------------------------------------------------------------------------

  describe("idle notification rate limiting readiness", () => {
    it("multiple rapid idle notifications are all stored (service doesn't throttle)", () => {
      // The service itself stores all notifications.
      // Rate limiting (max 1 idle per 15min) should be enforced by the caller.
      // Here we verify the service accepts all of them.
      for (let i = 0; i < 5; i++) {
        service.agentIdle("session-1", "agent-1", "Worker", 5 * 60 * 1000);
      }

      const all = service.getRecent(10);
      expect(all).toHaveLength(5);
      expect(all.every((n) => n.type === "agent-idle")).toBe(true);
    });

    it("idle notifications include agentId for caller-side deduplication", () => {
      service.agentIdle("session-1", "agent-1", "Worker", 300000);

      const notif = service.getRecent(1)[0];
      expect(notif.agentId).toBe("agent-1");
      expect(notif.sessionId).toBe("session-1");
      // Callers can use agentId + timestamp to implement per-agent throttling
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — Event Listener Management
  // ---------------------------------------------------------------------------

  describe("event listener management", () => {
    it("supports multiple listeners", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      service.on("notification", listener1);
      service.on("notification", listener2);

      service.sendInApp({ type: "task-complete", title: "T", body: "", sessionId: "s" });

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it("removeListener stops delivery to that listener", () => {
      const listener = vi.fn();

      service.on("notification", listener);
      service.sendInApp({ type: "task-complete", title: "T1", body: "", sessionId: "s" });
      expect(listener).toHaveBeenCalledOnce();

      service.removeListener("notification", listener);
      service.sendInApp({ type: "task-complete", title: "T2", body: "", sessionId: "s" });
      expect(listener).toHaveBeenCalledOnce(); // Still 1, not 2
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — Notification ID uniqueness
  // ---------------------------------------------------------------------------

  describe("notification ID uniqueness", () => {
    it("generates unique IDs for rapid-fire notifications", () => {
      const ids = new Set<string>();

      for (let i = 0; i < 50; i++) {
        service.sendInApp({ type: "task-complete", title: `T${i}`, body: "", sessionId: "s" });
      }

      const all = service.getRecent(50);
      all.forEach((n) => ids.add(n.id));

      // All 50 should have unique IDs
      expect(ids.size).toBe(50);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — All NotificationType values
  // ---------------------------------------------------------------------------

  describe("all notification types", () => {
    const types: NotificationType[] = [
      "agent-crashed",
      "agent-idle",
      "task-complete",
      "pr-ready",
      "budget-exceeded",
    ];

    it.each(types)("accepts %s notification type", (type) => {
      const emitted = collectEmitted(service);

      service.sendInApp({ type, title: `Test ${type}`, body: "body", sessionId: "s" });

      expect(emitted).toHaveLength(1);
      expect(emitted[0].type).toBe(type);
    });
  });
});
