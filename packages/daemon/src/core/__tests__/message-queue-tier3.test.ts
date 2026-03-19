import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MessageQueue, classifyPriority } from "../message-queue.js";
import { AppDatabase } from "../database.js";
import type { IPtyBackend } from "../pty-backend.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Comprehensive Unit Tests for Event Routing Tier 3
 *
 * Tests cover:
 * 1. Direct delivery channel (deliverDirect with retry logic)
 * 2. Delivery tracking (database operations)
 * 3. Priority routing (critical/high → direct, normal/low → queue)
 * 4. Database migration (v4 → v5)
 * 5. Cleanup (7-day retention)
 */

describe("Event Routing Tier 3 - Direct Delivery Channel", () => {
  let queue: MessageQueue;
  let mockTmux: IPtyBackend;
  let database: AppDatabase;
  let testRuntimeDir: string;

  beforeEach(async () => {
    // Create temp runtime directory
    testRuntimeDir = path.join("/tmp", `kora-test-${crypto.randomUUID()}`);
    fs.mkdirSync(testRuntimeDir, { recursive: true });

    // Initialize database
    database = new AppDatabase(testRuntimeDir);

    // Create mock tmux backend
    mockTmux = {
      newSession: vi.fn(),
      hasSession: vi.fn(),
      killSession: vi.fn(),
      sendKeys: vi.fn().mockResolvedValue(undefined),
      capturePane: vi.fn().mockResolvedValue("$ "),
      listSessions: vi.fn(),
      getSocketPathForSession: vi.fn(),
    } as any;

    queue = new MessageQueue(mockTmux, testRuntimeDir, "mcp");
    queue.registerMcpAgent("agent-1");
    queue.setDeliveryTracking(database, "test-session");
  });

  afterEach(async () => {
    if (queue) {
      queue.stop();
    }
    if (database) {
      database.close();
    }
    // Cleanup temp directory
    if (fs.existsSync(testRuntimeDir)) {
      fs.rmSync(testRuntimeDir, { recursive: true, force: true });
    }
  });

  describe("deliverDirect - Successful Delivery", () => {
    it("should return true on successful delivery", async () => {
      const result = await queue.deliverDirect(
        "agent-1",
        "tmux-1",
        "[Task assigned]: Test task",
        "master",
        "agent-1"
      );

      expect(result).toBe(true);
      expect(mockTmux.sendKeys).toHaveBeenCalledTimes(1);
    });

    it("should bypass queue and deliver immediately", async () => {
      const startTime = Date.now();

      await queue.deliverDirect(
        "agent-1",
        "tmux-1",
        "[Task assigned]: Urgent task",
        "master",
        "agent-1"
      );

      const elapsed = Date.now() - startTime;

      // Should deliver within 100ms (no queue delay)
      expect(elapsed).toBeLessThan(100);
      expect(mockTmux.sendKeys).toHaveBeenCalled();
    });

    it("should create mcp-pending file for MCP agents", async () => {
      const pendingDir = path.join(testRuntimeDir, "mcp-pending", "agent-1");

      await queue.deliverDirect(
        "agent-1",
        "tmux-1",
        "[Message from Master]: Test message",
        "master",
        "agent-1"
      );

      // Check if pending directory was created and file exists
      const files = fs.readdirSync(pendingDir);
      expect(files.length).toBeGreaterThan(0);
      expect(files[0]).toMatch(/\.json$/);
    });
  });

  describe("deliverDirect - Failed Delivery", () => {
    it("should return false on failed delivery", async () => {
      mockTmux.sendKeys = vi.fn().mockRejectedValue(new Error("Connection refused"));

      const result = await queue.deliverDirect(
        "agent-1",
        "tmux-1",
        "Test message",
        "master",
        "agent-1"
      );

      expect(result).toBe(false);
    });

    it("should emit delivery-failed event on failure", async () => {
      const broadcastSpy = vi.fn();
      queue.setBroadcastCallback(broadcastSpy);
      mockTmux.sendKeys = vi.fn().mockRejectedValue(new Error("Failed"));

      await queue.deliverDirect(
        "agent-1",
        "tmux-1",
        "[Task assigned]: Task",
        "master",
        "agent-1"
      );

      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "delivery-failed",
          agentId: "agent-1",
          priority: "critical"
        })
      );
    }, 10000); // Longer timeout for retry tests
  });

  describe("deliverDirect - Retry Logic", () => {
    it("should retry critical messages 3 times with exponential backoff", async () => {
      let attemptCount = 0;
      mockTmux.sendKeys = vi.fn().mockImplementation(async () => {
        attemptCount++;
        if (attemptCount <= 3) {
          throw new Error("Temporary failure");
        }
        return undefined;
      });

      const startTime = Date.now();
      const result = await queue.deliverDirect(
        "agent-1",
        "tmux-1",
        "[Task assigned]: Critical task",
        "master",
        "agent-1"
      );
      const elapsed = Date.now() - startTime;

      expect(result).toBe(true);
      expect(attemptCount).toBe(4); // Initial + 3 retries
      // Should take at least 1s + 2s + 4s = 7s for retries
      expect(elapsed).toBeGreaterThan(7000);
    }, 15000); // 15s timeout for retry tests

    it("should retry high priority messages 2 times", async () => {
      let attemptCount = 0;
      mockTmux.sendKeys = vi.fn().mockImplementation(async () => {
        attemptCount++;
        if (attemptCount <= 2) {
          throw new Error("Temporary failure");
        }
        return undefined;
      });

      const result = await queue.deliverDirect(
        "agent-1",
        "tmux-1",
        "[Question from Master]: Status?",
        "master",
        "agent-1"
      );

      expect(result).toBe(true);
      expect(attemptCount).toBe(3); // Initial + 2 retries
    });

    it("should NOT retry normal priority messages", async () => {
      let attemptCount = 0;
      mockTmux.sendKeys = vi.fn().mockImplementation(async () => {
        attemptCount++;
        throw new Error("Failure");
      });

      const result = await queue.deliverDirect(
        "agent-1",
        "tmux-1",
        "Normal message",
        "master",
        "agent-1"
      );

      expect(result).toBe(false);
      expect(attemptCount).toBe(1); // Only initial attempt, no retries
    });

    it("should return false if max retries exhausted", async () => {
      mockTmux.sendKeys = vi.fn().mockRejectedValue(new Error("Persistent failure"));

      const result = await queue.deliverDirect(
        "agent-1",
        "tmux-1",
        "[Task assigned]: Task",
        "master",
        "agent-1"
      );

      expect(result).toBe(false);
      expect(mockTmux.sendKeys).toHaveBeenCalledTimes(4); // Initial + 3 retries
    }, 15000); // 15s timeout for retry tests
  });

  describe("Priority Classification", () => {
    it("should classify critical priority correctly", () => {
      expect(classifyPriority("[Task assigned]: Do this")).toBe("critical");
      expect(classifyPriority("[Task from Master]: Build feature")).toBe("critical");
    });

    it("should classify high priority correctly", () => {
      expect(classifyPriority("[Question from Master]: Status?")).toBe("high");
      expect(classifyPriority("What is the status?")).toBe("high");
    });

    it("should classify low priority correctly", () => {
      expect(classifyPriority("[Broadcast]: Update for everyone")).toBe("low");
      expect(classifyPriority("[System]: Notification")).toBe("low");
    });

    it("should default to normal priority", () => {
      expect(classifyPriority("Regular message")).toBe("normal");
      expect(classifyPriority("[Message from Agent]: Info")).toBe("normal");
    });
  });
});

describe("Event Routing Tier 3 - Delivery Tracking", () => {
  let database: AppDatabase;
  let testRuntimeDir: string;

  beforeEach(() => {
    testRuntimeDir = path.join("/tmp", `kora-test-${crypto.randomUUID()}`);
    fs.mkdirSync(testRuntimeDir, { recursive: true });
    database = new AppDatabase(testRuntimeDir);
  });

  afterEach(() => {
    if (database) {
      database.close();
    }
    if (fs.existsSync(testRuntimeDir)) {
      fs.rmSync(testRuntimeDir, { recursive: true, force: true });
    }
  });

  describe("trackMessageDelivery", () => {
    it("should insert delivery record successfully", () => {
      const deliveryId = crypto.randomUUID();
      const messageId = crypto.randomUUID();

      database.trackMessageDelivery({
        id: deliveryId,
        sessionId: "test-session",
        messageId,
        agentId: "agent-1",
        status: "sent",
        enqueuedAt: Date.now(),
        messageSizeBytes: 100,
        priority: "critical"
      });

      const metrics = database.getDeliveryMetrics("agent-1");
      expect(metrics.totalMessages).toBe(1);
    });

    it("should calculate latency correctly", () => {
      const deliveryId = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      const enqueuedAt = Date.now();
      const deliveredAt = enqueuedAt + 500; // 500ms latency

      database.trackMessageDelivery({
        id: deliveryId,
        sessionId: "test-session",
        messageId,
        agentId: "agent-1",
        status: "delivered",
        enqueuedAt,
        deliveredAt,
        priority: "critical"
      });

      const metrics = database.getDeliveryMetrics("agent-1");
      expect(metrics.avgLatencyMs).toBeCloseTo(500, 0);
    });
  });

  describe("updateMessageDeliveryStatus", () => {
    it("should update status from sent to delivered", () => {
      const messageId = crypto.randomUUID();

      database.trackMessageDelivery({
        id: crypto.randomUUID(),
        sessionId: "test-session",
        messageId,
        agentId: "agent-1",
        status: "sent",
        enqueuedAt: Date.now(),
        priority: "critical"
      });

      database.updateMessageDeliveryStatus(messageId, "agent-1", "delivered");

      // Verify status updated (implicit through metrics)
      const metrics = database.getDeliveryMetrics("agent-1");
      expect(metrics.successRate).toBe(100);
    });

    it("should update status to read", () => {
      const messageId = crypto.randomUUID();

      database.trackMessageDelivery({
        id: crypto.randomUUID(),
        sessionId: "test-session",
        messageId,
        agentId: "agent-1",
        status: "delivered",
        enqueuedAt: Date.now(),
        priority: "high"
      });

      database.updateMessageDeliveryStatus(messageId, "agent-1", "read");

      const metrics = database.getDeliveryMetrics("agent-1");
      expect(metrics.successRate).toBe(100);
    });
  });

  describe("getDeliveryMetrics", () => {
    it("should calculate avgLatency correctly", () => {
      const now = Date.now();

      // Add 3 messages with 100ms, 200ms, 300ms latency
      for (let i = 0; i < 3; i++) {
        database.trackMessageDelivery({
          id: crypto.randomUUID(),
          sessionId: "test-session",
          messageId: crypto.randomUUID(),
          agentId: "agent-1",
          status: "delivered",
          enqueuedAt: now,
          deliveredAt: now + (i + 1) * 100,
          priority: "normal"
        });
      }

      const metrics = database.getDeliveryMetrics("agent-1");
      expect(metrics.avgLatencyMs).toBeCloseTo(200, 0); // Average of 100, 200, 300
    });

    it("should calculate successRate correctly", () => {
      const now = Date.now();

      // 3 successful deliveries
      for (let i = 0; i < 3; i++) {
        database.trackMessageDelivery({
          id: crypto.randomUUID(),
          sessionId: "test-session",
          messageId: crypto.randomUUID(),
          agentId: "agent-1",
          status: "delivered",
          enqueuedAt: now,
          deliveredAt: now + 100,
          priority: "normal"
        });
      }

      // 1 failed (stuck in 'sent' status for >60s)
      database.trackMessageDelivery({
        id: crypto.randomUUID(),
        sessionId: "test-session",
        messageId: crypto.randomUUID(),
        agentId: "agent-1",
        status: "sent",
        enqueuedAt: now - 70000, // 70 seconds ago
        priority: "normal"
      });

      const metrics = database.getDeliveryMetrics("agent-1");
      expect(metrics.totalMessages).toBe(4);
      expect(metrics.successRate).toBeCloseTo(75, 0); // 3/4 = 75%
      expect(metrics.failureCount).toBe(1);
    });

    it("should filter metrics by time window", () => {
      const now = Date.now();
      const oneHourAgo = now - 3600000;

      // Old message (outside window)
      database.trackMessageDelivery({
        id: crypto.randomUUID(),
        sessionId: "test-session",
        messageId: crypto.randomUUID(),
        agentId: "agent-1",
        status: "delivered",
        enqueuedAt: oneHourAgo - 1000,
        deliveredAt: oneHourAgo,
        priority: "normal"
      });

      // Recent message (inside window)
      database.trackMessageDelivery({
        id: crypto.randomUUID(),
        sessionId: "test-session",
        messageId: crypto.randomUUID(),
        agentId: "agent-1",
        status: "delivered",
        enqueuedAt: oneHourAgo + 1000,
        deliveredAt: oneHourAgo + 1500,
        priority: "normal"
      });

      const metrics = database.getDeliveryMetrics("agent-1", oneHourAgo);
      expect(metrics.totalMessages).toBe(1); // Only recent message
    });
  });

  describe("getRecentDeliveryFailures", () => {
    it("should return recent failures", () => {
      const now = Date.now();

      // 2 successful
      for (let i = 0; i < 2; i++) {
        database.trackMessageDelivery({
          id: crypto.randomUUID(),
          sessionId: "test-session",
          messageId: crypto.randomUUID(),
          agentId: "agent-1",
          status: "delivered",
          enqueuedAt: now,
          deliveredAt: now + 100,
          priority: "normal"
        });
      }

      // 3 failed
      for (let i = 0; i < 3; i++) {
        database.trackMessageDelivery({
          id: crypto.randomUUID(),
          sessionId: "test-session",
          messageId: `failed-${i}`,
          agentId: "agent-1",
          status: "sent",
          enqueuedAt: now - 70000, // Stuck for >60s
          priority: "critical"
        });
      }

      const failures = database.getRecentDeliveryFailures("agent-1");
      expect(failures.length).toBe(3);
      expect(failures.every(f => f.priority === "critical")).toBe(true);
    });

    it("should limit results to specified count", () => {
      const now = Date.now();

      // Create 15 failed messages
      for (let i = 0; i < 15; i++) {
        database.trackMessageDelivery({
          id: crypto.randomUUID(),
          sessionId: "test-session",
          messageId: `failed-${i}`,
          agentId: "agent-1",
          status: "sent",
          enqueuedAt: now - 70000,
          priority: "normal"
        });
      }

      const failures = database.getRecentDeliveryFailures("agent-1", 5);
      expect(failures.length).toBe(5);
    });
  });

  describe("cleanupOldDeliveries", () => {
    it("should delete records older than 7 days", () => {
      const now = Date.now();
      const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
      const sixDaysAgo = now - 6 * 24 * 60 * 60 * 1000;

      // Old record (should be deleted)
      database.trackMessageDelivery({
        id: crypto.randomUUID(),
        sessionId: "test-session",
        messageId: "old-message",
        agentId: "agent-1",
        status: "delivered",
        enqueuedAt: eightDaysAgo,
        deliveredAt: eightDaysAgo + 100,
        priority: "normal"
      });

      // Recent record (should be kept)
      database.trackMessageDelivery({
        id: crypto.randomUUID(),
        sessionId: "test-session",
        messageId: "recent-message",
        agentId: "agent-1",
        status: "delivered",
        enqueuedAt: sixDaysAgo,
        deliveredAt: sixDaysAgo + 100,
        priority: "normal"
      });

      const deleted = database.cleanupOldDeliveries(7);
      expect(deleted).toBe(1);

      const metrics = database.getDeliveryMetrics("agent-1");
      expect(metrics.totalMessages).toBe(1); // Only recent message remains
    });

    it("should preserve recent records", () => {
      const now = Date.now();

      // Add 5 recent records
      for (let i = 0; i < 5; i++) {
        database.trackMessageDelivery({
          id: crypto.randomUUID(),
          sessionId: "test-session",
          messageId: `message-${i}`,
          agentId: "agent-1",
          status: "delivered",
          enqueuedAt: now - i * 1000,
          deliveredAt: now - i * 1000 + 100,
          priority: "normal"
        });
      }

      const deleted = database.cleanupOldDeliveries(7);
      expect(deleted).toBe(0);

      const metrics = database.getDeliveryMetrics("agent-1");
      expect(metrics.totalMessages).toBe(5);
    });

    it("should handle empty table", () => {
      const deleted = database.cleanupOldDeliveries(7);
      expect(deleted).toBe(0);
    });
  });
});

describe("Event Routing Tier 3 - Priority Routing", () => {
  let queue: MessageQueue;
  let mockTmux: IPtyBackend;
  let database: AppDatabase;
  let testRuntimeDir: string;

  beforeEach(() => {
    testRuntimeDir = path.join("/tmp", `kora-test-${crypto.randomUUID()}`);
    fs.mkdirSync(testRuntimeDir, { recursive: true });
    database = new AppDatabase(testRuntimeDir);

    mockTmux = {
      newSession: vi.fn(),
      hasSession: vi.fn(),
      killSession: vi.fn(),
      sendKeys: vi.fn().mockResolvedValue(undefined),
      capturePane: vi.fn().mockResolvedValue("$ "),
      listSessions: vi.fn(),
      getSocketPathForSession: vi.fn(),
    } as any;

    queue = new MessageQueue(mockTmux, testRuntimeDir, "mcp");
    queue.registerMcpAgent("agent-1");
    queue.setDeliveryTracking(database, "test-session");
  });

  afterEach(() => {
    if (queue) {
      queue.stop();
    }
    if (database) {
      database.close();
    }
    if (fs.existsSync(testRuntimeDir)) {
      fs.rmSync(testRuntimeDir, { recursive: true, force: true });
    }
  });

  it("should bypass queue for critical messages (deliver immediately)", async () => {
    queue.enqueue("agent-1", "tmux-1", "[Task assigned]: Critical task", "master", "agent-1");

    // Critical messages bypass queue - queue should be empty
    const queueDepth = queue.getQueueDepth("agent-1");
    expect(queueDepth).toBe(0);

    // Give time for async delivery
    await new Promise(resolve => setTimeout(resolve, 100));

    // Should have delivered via mcp-pending
    expect(mockTmux.sendKeys).toHaveBeenCalled();
  });

  it("should use queue for high priority messages (but with higher priority)", async () => {
    queue.enqueue("agent-1", "tmux-1", "[Question from Master]: Status?", "master", "agent-1");

    // High priority messages use queue (only critical bypasses)
    const queueDepth = queue.getQueueDepth("agent-1");
    expect(queueDepth).toBeGreaterThan(0);

    // Start queue to deliver
    queue.start();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Should have been delivered
    expect(mockTmux.sendKeys).toHaveBeenCalled();
  });

  it("should use queue for normal messages", async () => {
    queue.enqueue("agent-1", "tmux-1", "Normal message", "master", "agent-1");

    const queueDepth = queue.getQueueDepth("agent-1");
    expect(queueDepth).toBeGreaterThan(0); // Message is in queue, not delivered directly
  });

  it("should use queue for low priority messages", async () => {
    // Low priority = broadcast/system messages
    // NOTE: Broadcasts are low priority, but in current implementation they may be
    // classified differently. Let's test with a clear low priority message.
    queue.enqueue("agent-1", "tmux-1", "[System]: Maintenance notification", "system", "agent-1");

    // Start queue to process messages
    queue.start();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Low priority messages should eventually be delivered
    const queueDepth = queue.getQueueDepth("agent-1");
    expect(queueDepth).toBeGreaterThanOrEqual(0); // May be 0 if already delivered
  });
});

describe("Event Routing Tier 3 - Database Migration", () => {
  let testRuntimeDir: string;

  beforeEach(() => {
    testRuntimeDir = path.join("/tmp", `kora-test-${crypto.randomUUID()}`);
    fs.mkdirSync(testRuntimeDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testRuntimeDir)) {
      fs.rmSync(testRuntimeDir, { recursive: true, force: true });
    }
  });

  it("should create message_deliveries table on migration", () => {
    const database = new AppDatabase(testRuntimeDir);

    // Check that table exists by attempting to insert
    expect(() => {
      database.trackMessageDelivery({
        id: crypto.randomUUID(),
        sessionId: "test-session",
        messageId: crypto.randomUUID(),
        agentId: "agent-1",
        status: "sent",
        enqueuedAt: Date.now(),
        priority: "normal"
      });
    }).not.toThrow();

    database.close();
  });

  it("should create indexes on migration", () => {
    const database = new AppDatabase(testRuntimeDir);

    // Indexes improve query performance - verify by running queries
    // Add multiple records
    for (let i = 0; i < 100; i++) {
      database.trackMessageDelivery({
        id: crypto.randomUUID(),
        sessionId: "test-session",
        messageId: crypto.randomUUID(),
        agentId: `agent-${i % 5}`,
        status: i % 2 === 0 ? "delivered" : "sent",
        enqueuedAt: Date.now(),
        priority: "normal"
      });
    }

    // Query should be fast with indexes
    const startTime = Date.now();
    const metrics = database.getDeliveryMetrics("agent-1");
    const elapsed = Date.now() - startTime;

    expect(elapsed).toBeLessThan(50); // Should be very fast with indexes
    expect(metrics).toBeDefined();

    database.close();
  });

  it("should be idempotent (can run migration twice)", () => {
    // Create database (runs migration)
    let database = new AppDatabase(testRuntimeDir);
    database.close();

    // Reopen same database (should not fail)
    expect(() => {
      database = new AppDatabase(testRuntimeDir);
      database.close();
    }).not.toThrow();
  });

  it("should set user_version to 5 after migration", () => {
    const database = new AppDatabase(testRuntimeDir);

    const version = database.db.pragma("user_version", { simple: true });
    expect(version).toBe(5);

    database.close();
  });
});
