import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AppDatabase } from "../../core/database.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("Messages SQLite Storage", () => {
  let db: AppDatabase;
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-test-messages-"));
    db = new AppDatabase(testDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe("insertMessage", () => {
    it("should insert a message with all required fields", () => {
      const messageId = "msg-001";
      db.insertMessage({
        id: messageId,
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Hello from agent A",
        createdAt: Date.now(),
      });

      const messages = db.getMessages({
        toAgentId: "agent-b",
        sessionId: "test-session",
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe(messageId);
      expect(messages[0].content).toBe("Hello from agent A");
      expect(messages[0].status).toBe("pending");
      expect(messages[0].priority).toBe("normal");
    });

    it("should insert a message with optional fields (priority, channel, parent, metadata, payload)", () => {
      const messageId = "msg-002";
      const metadata = { urgent: true, source: "dashboard" };
      const payload = { taskId: "task-123" };

      db.insertMessage({
        id: messageId,
        sessionId: "test-session",
        fromAgentId: "master-agent",
        toAgentId: "worker-agent",
        messageType: "task",
        content: "Implement feature X",
        priority: "critical",
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        channel: "#backend",
        parentMessageId: "msg-001",
        metadata,
        payload,
      });

      const messages = db.getMessages({ toAgentId: "worker-agent" });

      expect(messages).toHaveLength(1);
      expect(messages[0].priority).toBe("critical");
      expect(messages[0].channel).toBe("#backend");
      expect(messages[0].parentMessageId).toBe("msg-001");
      expect(messages[0].metadata).toEqual(metadata);
      expect(messages[0].payload).toEqual(payload);
    });

    it("should handle null/undefined optional fields gracefully", () => {
      db.insertMessage({
        id: "msg-003",
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Test message",
        createdAt: Date.now(),
      });

      const messages = db.getMessages({ toAgentId: "agent-b" });

      expect(messages[0].channel).toBeNull();
      expect(messages[0].parentMessageId).toBeNull();
      expect(messages[0].expiresAt).toBeNull();
    });
  });

  describe("getMessages", () => {
    beforeEach(() => {
      // Insert test messages
      const now = Date.now();
      db.insertMessage({
        id: "msg-001",
        sessionId: "session-1",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Message 1",
        priority: "normal",
        createdAt: now - 3000,
      });
      db.insertMessage({
        id: "msg-002",
        sessionId: "session-1",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "task",
        content: "Message 2",
        priority: "high",
        createdAt: now - 2000,
      });
      db.insertMessage({
        id: "msg-003",
        sessionId: "session-1",
        fromAgentId: "agent-c",
        toAgentId: "agent-d",
        messageType: "question",
        content: "Message 3",
        priority: "critical",
        createdAt: now - 1000,
        channel: "#frontend",
      });
      db.insertMessage({
        id: "msg-004",
        sessionId: "session-2",
        fromAgentId: "agent-x",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Message 4",
        priority: "normal",
        createdAt: now,
      });
    });

    it("should filter by toAgentId", () => {
      const messages = db.getMessages({ toAgentId: "agent-b" });
      expect(messages).toHaveLength(3);
      expect(messages.every(m => m.toAgentId === "agent-b")).toBe(true);
    });

    it("should filter by fromAgentId", () => {
      const messages = db.getMessages({ fromAgentId: "agent-a" });
      expect(messages).toHaveLength(2);
      expect(messages.every(m => m.fromAgentId === "agent-a")).toBe(true);
    });

    it("should filter by sessionId", () => {
      const messages = db.getMessages({ sessionId: "session-1" });
      expect(messages).toHaveLength(3);
      expect(messages.every(m => m.sessionId === "session-1")).toBe(true);
    });

    it("should filter by status", () => {
      db.markMessageRead("msg-001");
      const pending = db.getMessages({ toAgentId: "agent-b", status: "pending" });
      const read = db.getMessages({ toAgentId: "agent-b", status: "read" });

      expect(pending).toHaveLength(2);
      expect(read).toHaveLength(1);
      expect(read[0].id).toBe("msg-001");
    });

    it("should filter by channel", () => {
      const messages = db.getMessages({ channel: "#frontend" });
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg-003");
    });

    it("should filter by since timestamp", () => {
      const now = Date.now();
      const messages = db.getMessages({ since: now - 1500 });
      expect(messages).toHaveLength(2); // msg-003 and msg-004
    });

    it("should respect limit parameter", () => {
      const messages = db.getMessages({ toAgentId: "agent-b", limit: 2 });
      expect(messages).toHaveLength(2);
    });

    it("should respect offset parameter", () => {
      const messages = db.getMessages({ toAgentId: "agent-b", offset: 1 });
      expect(messages).toHaveLength(2);
    });

    it("should return messages in descending order by created_at", () => {
      const messages = db.getMessages({ sessionId: "session-1" });
      expect(messages[0].id).toBe("msg-003"); // Most recent
      expect(messages[2].id).toBe("msg-001"); // Oldest
    });

    it("should combine multiple filters", () => {
      const messages = db.getMessages({
        sessionId: "session-1",
        toAgentId: "agent-b",
        status: "pending",
      });
      expect(messages).toHaveLength(2); // msg-001 and msg-002
    });
  });

  describe("markMessageDelivered", () => {
    it("should mark a pending message as delivered", () => {
      const messageId = "msg-001";
      db.insertMessage({
        id: messageId,
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Test",
        createdAt: Date.now(),
      });

      db.markMessageDelivered(messageId);

      const messages = db.getMessages({ toAgentId: "agent-b" });
      expect(messages[0].status).toBe("delivered");
      expect(messages[0].deliveredAt).toBeGreaterThan(0);
    });

    it("should not update non-pending messages", () => {
      const messageId = "msg-001";
      db.insertMessage({
        id: messageId,
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Test",
        createdAt: Date.now(),
      });

      db.markMessageRead(messageId);
      db.markMessageDelivered(messageId);

      const messages = db.getMessages({ toAgentId: "agent-b" });
      expect(messages[0].status).toBe("read"); // Should remain read
    });

    it("should handle non-existent message ID gracefully", () => {
      expect(() => db.markMessageDelivered("non-existent")).not.toThrow();
    });
  });

  describe("markMessageRead", () => {
    it("should mark a pending message as read", () => {
      const messageId = "msg-001";
      db.insertMessage({
        id: messageId,
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Test",
        createdAt: Date.now(),
      });

      db.markMessageRead(messageId);

      const messages = db.getMessages({ toAgentId: "agent-b" });
      expect(messages[0].status).toBe("read");
      expect(messages[0].readAt).toBeGreaterThan(0);
    });

    it("should mark a delivered message as read", () => {
      const messageId = "msg-001";
      db.insertMessage({
        id: messageId,
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Test",
        createdAt: Date.now(),
      });

      db.markMessageDelivered(messageId);
      db.markMessageRead(messageId);

      const messages = db.getMessages({ toAgentId: "agent-b" });
      expect(messages[0].status).toBe("read");
      expect(messages[0].deliveredAt).toBeGreaterThan(0);
      expect(messages[0].readAt).toBeGreaterThan(0);
    });

    it("should handle non-existent message ID gracefully", () => {
      expect(() => db.markMessageRead("non-existent")).not.toThrow();
    });
  });

  describe("markMessagesRead", () => {
    it("should mark multiple messages as read", () => {
      const messageIds = ["msg-001", "msg-002", "msg-003"];
      messageIds.forEach(id => {
        db.insertMessage({
          id,
          sessionId: "test-session",
          fromAgentId: "agent-a",
          toAgentId: "agent-b",
          messageType: "text",
          content: `Message ${id}`,
          createdAt: Date.now(),
        });
      });

      db.markMessagesRead(messageIds);

      const messages = db.getMessages({ toAgentId: "agent-b" });
      expect(messages).toHaveLength(3);
      expect(messages.every(m => m.status === "read")).toBe(true);
    });

    it("should handle empty array gracefully", () => {
      expect(() => db.markMessagesRead([])).not.toThrow();
    });

    it("should handle partial non-existent IDs gracefully", () => {
      db.insertMessage({
        id: "msg-001",
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Test",
        createdAt: Date.now(),
      });

      expect(() => db.markMessagesRead(["msg-001", "non-existent"])).not.toThrow();

      const messages = db.getMessages({ toAgentId: "agent-b" });
      expect(messages[0].status).toBe("read");
    });
  });

  describe("getUnreadMessageCount", () => {
    it("should count pending and delivered messages", () => {
      db.insertMessage({
        id: "msg-001",
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Pending",
        createdAt: Date.now(),
      });
      db.insertMessage({
        id: "msg-002",
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Delivered",
        createdAt: Date.now(),
      });
      db.markMessageDelivered("msg-002");

      const count = db.getUnreadMessageCount("agent-b");
      expect(count).toBe(2);
    });

    it("should not count read messages", () => {
      db.insertMessage({
        id: "msg-001",
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Read",
        createdAt: Date.now(),
      });
      db.markMessageRead("msg-001");

      const count = db.getUnreadMessageCount("agent-b");
      expect(count).toBe(0);
    });

    it("should not count expired messages", () => {
      db.insertMessage({
        id: "msg-001",
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Expired",
        createdAt: Date.now() - 10000,
        expiresAt: Date.now() - 5000,
      });

      db.cleanupExpiredMessages();

      const count = db.getUnreadMessageCount("agent-b");
      expect(count).toBe(0);
    });

    it("should return 0 for agent with no messages", () => {
      const count = db.getUnreadMessageCount("non-existent-agent");
      expect(count).toBe(0);
    });
  });

  describe("cleanupExpiredMessages", () => {
    it("should mark messages as expired when expires_at is past", () => {
      const now = Date.now();
      const thirtyOneDaysAgo = now - (31 * 24 * 60 * 60 * 1000);
      db.insertMessage({
        id: "msg-001",
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Expired message",
        createdAt: thirtyOneDaysAgo,
        expiresAt: thirtyOneDaysAgo + 1000,
      });

      const deleted = db.cleanupExpiredMessages();

      // Old expired messages (>30 days) should be marked expired and deleted
      const messages = db.getMessages({ toAgentId: "agent-b" });
      expect(messages).toHaveLength(0);
      expect(deleted).toBe(1);
    });

    it("should delete read messages older than 30 days", () => {
      const thirtyOneDaysAgo = Date.now() - (31 * 24 * 60 * 60 * 1000);
      db.insertMessage({
        id: "msg-001",
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Old read message",
        createdAt: thirtyOneDaysAgo,
      });
      db.markMessageRead("msg-001");

      const deleted = db.cleanupExpiredMessages();

      const messages = db.getMessages({ toAgentId: "agent-b" });
      expect(messages).toHaveLength(0);
      expect(deleted).toBeGreaterThan(0);
    });

    it("should delete pending/delivered messages older than 7 days", () => {
      const eightDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000);
      db.insertMessage({
        id: "msg-001",
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Old pending message",
        createdAt: eightDaysAgo,
      });

      const deleted = db.cleanupExpiredMessages();

      const messages = db.getMessages({ toAgentId: "agent-b" });
      expect(messages).toHaveLength(0);
      expect(deleted).toBeGreaterThan(0);
    });

    it("should not delete recent read messages", () => {
      const twoDaysAgo = Date.now() - (2 * 24 * 60 * 60 * 1000);
      db.insertMessage({
        id: "msg-001",
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Recent read message",
        createdAt: twoDaysAgo,
      });
      db.markMessageRead("msg-001");

      db.cleanupExpiredMessages();

      const messages = db.getMessages({ toAgentId: "agent-b" });
      expect(messages).toHaveLength(1);
    });

    it("should not delete recent pending messages", () => {
      const oneDayAgo = Date.now() - (1 * 24 * 60 * 60 * 1000);
      db.insertMessage({
        id: "msg-001",
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Recent pending message",
        createdAt: oneDayAgo,
      });

      db.cleanupExpiredMessages();

      const messages = db.getMessages({ toAgentId: "agent-b" });
      expect(messages).toHaveLength(1);
    });

    it("should return count of deleted messages", () => {
      const oldTimestamp = Date.now() - (32 * 24 * 60 * 60 * 1000);
      for (let i = 0; i < 5; i++) {
        db.insertMessage({
          id: `msg-${i}`,
          sessionId: "test-session",
          fromAgentId: "agent-a",
          toAgentId: "agent-b",
          messageType: "text",
          content: `Old message ${i}`,
          createdAt: oldTimestamp,
        });
        db.markMessageRead(`msg-${i}`);
      }

      const deleted = db.cleanupExpiredMessages();
      expect(deleted).toBe(5);
    });
  });

  describe("Performance", () => {
    it("should handle querying 1000+ messages efficiently", () => {
      const count = 1000;
      const startInsert = Date.now();

      for (let i = 0; i < count; i++) {
        db.insertMessage({
          id: `msg-${i}`,
          sessionId: "test-session",
          fromAgentId: "agent-a",
          toAgentId: "agent-b",
          messageType: "text",
          content: `Message ${i}`,
          createdAt: Date.now() - i * 1000,
        });
      }

      const insertTime = Date.now() - startInsert;
      expect(insertTime).toBeLessThan(5000); // Should insert 1000 messages in < 5s

      const startQuery = Date.now();
      const messages = db.getMessages({ toAgentId: "agent-b", limit: 100 });
      const queryTime = Date.now() - startQuery;

      expect(messages).toHaveLength(100);
      expect(queryTime).toBeLessThan(100); // Should query in < 100ms
    });

    it("should handle cleanup of 1000+ expired messages efficiently", () => {
      const count = 1000;
      const oldTimestamp = Date.now() - (32 * 24 * 60 * 60 * 1000);

      for (let i = 0; i < count; i++) {
        db.insertMessage({
          id: `msg-${i}`,
          sessionId: "test-session",
          fromAgentId: "agent-a",
          toAgentId: "agent-b",
          messageType: "text",
          content: `Old message ${i}`,
          createdAt: oldTimestamp,
        });
        db.markMessageRead(`msg-${i}`);
      }

      const startCleanup = Date.now();
      const deleted = db.cleanupExpiredMessages();
      const cleanupTime = Date.now() - startCleanup;

      expect(deleted).toBe(count);
      expect(cleanupTime).toBeLessThan(1000); // Should cleanup 1000 messages in < 1s
    });
  });

  describe("Edge Cases", () => {
    it("should handle duplicate message IDs (replace)", () => {
      db.insertMessage({
        id: "msg-001",
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Original",
        createdAt: Date.now(),
      });

      db.insertMessage({
        id: "msg-001",
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Updated",
        createdAt: Date.now(),
      });

      const messages = db.getMessages({ toAgentId: "agent-b" });
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Updated");
    });

    it("should handle very long message content", () => {
      const longContent = "A".repeat(100000); // 100KB
      db.insertMessage({
        id: "msg-001",
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: longContent,
        createdAt: Date.now(),
      });

      const messages = db.getMessages({ toAgentId: "agent-b" });
      expect(messages[0].content).toBe(longContent);
    });

    it("should handle special characters in content", () => {
      const specialContent = "Hello 🎉 <script>alert('xss')</script> \n\t \"quotes\" 'single'";
      db.insertMessage({
        id: "msg-001",
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: specialContent,
        createdAt: Date.now(),
      });

      const messages = db.getMessages({ toAgentId: "agent-b" });
      expect(messages[0].content).toBe(specialContent);
    });

    it("should handle complex JSON in metadata and payload", () => {
      const metadata = {
        nested: { deeply: { nested: { value: 42 } } },
        array: [1, 2, 3, { key: "value" }],
        unicode: "测试 🚀",
      };
      const payload = {
        task: { id: "task-123", subtasks: ["a", "b", "c"] },
      };

      db.insertMessage({
        id: "msg-001",
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Test",
        createdAt: Date.now(),
        metadata,
        payload,
      });

      const messages = db.getMessages({ toAgentId: "agent-b" });
      expect(messages[0].metadata).toEqual(metadata);
      expect(messages[0].payload).toEqual(payload);
    });
  });
});
