import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AppDatabase } from "../database.js";
import os from "os";
import fs from "fs";
import path from "path";

describe("Message tracking — no duplicates on retry", () => {
  let db: AppDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-tracking-"));
    db = new AppDatabase(tmpDir);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should create only ONE tracking record when using messageId as PK", () => {
    const messageId = "msg-123";
    const sessionId = "session-1";
    const agentId = "agent-1";

    // Simulate first attempt (sent)
    db.trackMessageDelivery({
      id: messageId,  // Using messageId as PK
      sessionId,
      messageId,
      agentId,
      status: "sent",
      enqueuedAt: Date.now(),
      messageSizeBytes: 100,
      priority: "critical",
    });

    // Simulate retry attempt (should REPLACE, not create duplicate)
    db.trackMessageDelivery({
      id: messageId,  // Same messageId as PK
      sessionId,
      messageId,
      agentId,
      status: "sent",
      enqueuedAt: Date.now(),
      messageSizeBytes: 100,
      priority: "critical",
    });

    // Check: Only ONE record should exist
    const records = db.db.prepare(
      "SELECT COUNT(*) as count FROM message_deliveries WHERE message_id = ?"
    ).get(messageId) as { count: number };

    expect(records.count).toBe(1);
  });

  it("should show correct totalMessages count in metrics (not inflated by retries)", () => {
    const sessionId = "session-1";
    const agentId = "agent-1";

    // Simulate 3 messages with retries
    for (let i = 1; i <= 3; i++) {
      const messageId = `msg-${i}`;

      // First attempt
      db.trackMessageDelivery({
        id: messageId,
        sessionId,
        messageId,
        agentId,
        status: "sent",
        enqueuedAt: Date.now(),
        messageSizeBytes: 100,
        priority: i === 1 ? "critical" : "normal",
      });

      // Simulate retry for critical message
      if (i === 1) {
        db.trackMessageDelivery({
          id: messageId,  // Same ID = REPLACE
          sessionId,
          messageId,
          agentId,
          status: "sent",
          enqueuedAt: Date.now(),
          messageSizeBytes: 100,
          priority: "critical",
        });
      }
    }

    // Get metrics
    const metrics = db.getDeliveryMetrics(agentId);

    // Should show 3 messages, NOT 4 (even though critical message had retry)
    expect(metrics.totalMessages).toBe(3);
  });

  it("should allow different messages with different messageIds", () => {
    const sessionId = "session-1";
    const agentId = "agent-1";

    // Message 1
    db.trackMessageDelivery({
      id: "msg-1",
      sessionId,
      messageId: "msg-1",
      agentId,
      status: "sent",
      enqueuedAt: Date.now(),
      messageSizeBytes: 100,
      priority: "normal",
    });

    // Message 2 (different messageId)
    db.trackMessageDelivery({
      id: "msg-2",
      sessionId,
      messageId: "msg-2",
      agentId,
      status: "sent",
      enqueuedAt: Date.now(),
      messageSizeBytes: 200,
      priority: "high",
    });

    const metrics = db.getDeliveryMetrics(agentId);
    expect(metrics.totalMessages).toBe(2);
  });

  it("should update status correctly on retry success", () => {
    const messageId = "msg-retry-success";
    const sessionId = "session-1";
    const agentId = "agent-1";
    const enqueuedAt = Date.now();

    // Initial attempt (sent)
    db.trackMessageDelivery({
      id: messageId,
      sessionId,
      messageId,
      agentId,
      status: "sent",
      enqueuedAt,
      messageSizeBytes: 100,
      priority: "critical",
    });

    // Retry succeeds (delivered)
    db.trackMessageDelivery({
      id: messageId,  // Same ID
      sessionId,
      messageId,
      agentId,
      status: "delivered",
      enqueuedAt,
      deliveredAt: Date.now(),
      messageSizeBytes: 100,
      priority: "critical",
    });

    // Check: Only one record, status = delivered
    const record = db.db.prepare(
      "SELECT * FROM message_deliveries WHERE message_id = ?"
    ).get(messageId) as any;

    expect(record.status).toBe("delivered");
    expect(record.delivered_at).toBeDefined();
  });

  it("OLD BEHAVIOR: would create duplicates with random UUID (demonstration)", () => {
    const messageId = "msg-duplicate-demo";
    const sessionId = "session-1";
    const agentId = "agent-1";

    // Old behavior: different random UUID for each retry
    db.trackMessageDelivery({
      id: "random-uuid-1",  // ❌ Random UUID (old behavior)
      sessionId,
      messageId,
      agentId,
      status: "sent",
      enqueuedAt: Date.now(),
      messageSizeBytes: 100,
      priority: "critical",
    });

    db.trackMessageDelivery({
      id: "random-uuid-2",  // ❌ Different random UUID (old behavior)
      sessionId,
      messageId,
      agentId,
      status: "sent",
      enqueuedAt: Date.now(),
      messageSizeBytes: 100,
      priority: "critical",
    });

    // Old behavior would create 2 records
    const records = db.db.prepare(
      "SELECT COUNT(*) as count FROM message_deliveries WHERE message_id = ?"
    ).get(messageId) as { count: number };

    // This demonstrates the bug: 2 records for same message
    expect(records.count).toBe(2);  // Bug: duplicates

    // Metrics would be inflated
    const metrics = db.getDeliveryMetrics(agentId);
    expect(metrics.totalMessages).toBeGreaterThan(1);  // Bug: shows 2 instead of 1
  });
});
