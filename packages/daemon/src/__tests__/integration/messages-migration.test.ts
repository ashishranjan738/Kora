import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AppDatabase } from "../../core/database.js";
import { MessageQueue } from "../../core/message-queue.js";
import { HoldptyController } from "../../core/holdpty-controller.js";
import fs from "fs";
import path from "path";
import os from "os";
import request from "supertest";
import express, { type Express } from "express";

describe("Messages SQLite Migration - Integration", () => {
  let db: AppDatabase;
  let testDir: string;
  let messageQueue: MessageQueue;
  let terminal: HoldptyController;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-test-migration-"));
    db = new AppDatabase(testDir);

    // Create holdpty controller with test socket dir
    const socketDir = path.join(testDir, "holdpty-sockets");
    fs.mkdirSync(socketDir, { recursive: true });
    terminal = new HoldptyController(socketDir);

    messageQueue = new MessageQueue(terminal, testDir, "mcp");
    messageQueue.setDeliveryTracking(db, "test-session");
  });

  afterEach(async () => {
    messageQueue.stop();
    db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe("Dual-Write: SQLite + File Fallback", () => {
    it("should write to both SQLite and file system", async () => {
      const agentId = "test-agent";
      const terminalSession = "test-session";
      const message = "[Message from SenderAgent]: Test dual write";

      // Create agent directories
      const inboxDir = path.join(testDir, "messages", `inbox-${agentId}`);
      const pendingDir = path.join(testDir, "mcp-pending", agentId);
      fs.mkdirSync(inboxDir, { recursive: true });
      fs.mkdirSync(pendingDir, { recursive: true });

      // Register as MCP agent
      messageQueue.registerMcpAgent(agentId);

      // Enqueue message
      messageQueue.enqueue(agentId, terminalSession, message, "sender-agent");

      // Wait for delivery
      await new Promise(resolve => setTimeout(resolve, 100));

      // Check SQLite
      const sqliteMessages = db.getMessages({
        toAgentId: agentId,
        sessionId: "test-session",
      });
      expect(sqliteMessages.length).toBeGreaterThan(0);
      expect(sqliteMessages[0].content).toBe(message);

      // Check file system (mcp-pending)
      const pendingFiles = fs.readdirSync(pendingDir);
      const jsonFiles = pendingFiles.filter(f => f.endsWith(".json"));
      expect(jsonFiles.length).toBeGreaterThan(0);

      const fileContent = JSON.parse(
        fs.readFileSync(path.join(pendingDir, jsonFiles[0]), "utf-8")
      );
      expect(fileContent.content).toBe(message);
    });

    it("should fall back to file system if SQLite insert fails", async () => {
      const agentId = "test-agent";
      const terminalSession = "test-session";
      const message = "[Message from SenderAgent]: Fallback test";

      // Create agent directories
      const pendingDir = path.join(testDir, "mcp-pending", agentId);
      fs.mkdirSync(pendingDir, { recursive: true });

      // Register as MCP agent
      messageQueue.registerMcpAgent(agentId);

      // Close database to simulate failure
      db.close();

      // Enqueue message (should fall back to files)
      messageQueue.enqueue(agentId, terminalSession, message, "sender-agent");

      // Wait for delivery
      await new Promise(resolve => setTimeout(resolve, 100));

      // Check file system still works
      const pendingFiles = fs.readdirSync(pendingDir);
      const jsonFiles = pendingFiles.filter(f => f.endsWith(".json"));
      expect(jsonFiles.length).toBeGreaterThan(0);

      const fileContent = JSON.parse(
        fs.readFileSync(path.join(pendingDir, jsonFiles[0]), "utf-8")
      );
      expect(fileContent.content).toBe(message);
    });
  });

  describe("Message Lifecycle", () => {
    it("should track message lifecycle: pending → delivered → read", async () => {
      const messageId = "msg-lifecycle-test";
      const agentId = "test-agent";

      // Insert message (pending)
      db.insertMessage({
        id: messageId,
        sessionId: "test-session",
        fromAgentId: "sender",
        toAgentId: agentId,
        messageType: "text",
        content: "Lifecycle test",
        createdAt: Date.now(),
      });

      let messages = db.getMessages({ toAgentId: agentId });
      expect(messages[0].status).toBe("pending");
      expect(messages[0].deliveredAt).toBeNull();
      expect(messages[0].readAt).toBeNull();

      // Mark as delivered
      db.markMessageDelivered(messageId);
      messages = db.getMessages({ toAgentId: agentId });
      expect(messages[0].status).toBe("delivered");
      expect(messages[0].deliveredAt).toBeGreaterThan(0);
      expect(messages[0].readAt).toBeNull();

      // Mark as read
      db.markMessageRead(messageId);
      messages = db.getMessages({ toAgentId: agentId });
      expect(messages[0].status).toBe("read");
      expect(messages[0].deliveredAt).toBeGreaterThan(0);
      expect(messages[0].readAt).toBeGreaterThan(0);
    });

    it("should handle expired messages correctly", async () => {
      const messageId = "msg-expired-test";
      const agentId = "test-agent";
      const now = Date.now();
      const thirtyOneDaysAgo = now - (31 * 24 * 60 * 60 * 1000);

      // Insert message with expiry in the past (old enough to be deleted)
      db.insertMessage({
        id: messageId,
        sessionId: "test-session",
        fromAgentId: "sender",
        toAgentId: agentId,
        messageType: "text",
        content: "This will expire",
        createdAt: thirtyOneDaysAgo,
        expiresAt: thirtyOneDaysAgo + 1000,
      });

      // Initially pending
      let messages = db.getMessages({ toAgentId: agentId });
      expect(messages).toHaveLength(1);
      expect(messages[0].status).toBe("pending");

      // Run cleanup - should mark as expired and delete
      const deleted = db.cleanupExpiredMessages();
      expect(deleted).toBeGreaterThan(0);

      // Message should be deleted
      messages = db.getMessages({ toAgentId: agentId });
      expect(messages).toHaveLength(0);
    });
  });

  describe("Pagination and Filtering", () => {
    beforeEach(() => {
      const now = Date.now();
      for (let i = 0; i < 50; i++) {
        db.insertMessage({
          id: `msg-${i}`,
          sessionId: "test-session",
          fromAgentId: i % 2 === 0 ? "agent-a" : "agent-b",
          toAgentId: "recipient",
          messageType: i % 3 === 0 ? "task" : "text",
          content: `Message ${i}`,
          priority: i % 4 === 0 ? "critical" : "normal",
          createdAt: now - (50 - i) * 1000,
          channel: i % 5 === 0 ? "#backend" : undefined,
        });
      }
    });

    it("should paginate messages with limit and offset", () => {
      const page1 = db.getMessages({ toAgentId: "recipient", limit: 10, offset: 0 });
      const page2 = db.getMessages({ toAgentId: "recipient", limit: 10, offset: 10 });

      expect(page1).toHaveLength(10);
      expect(page2).toHaveLength(10);
      expect(page1[0].id).not.toBe(page2[0].id);
    });

    it("should filter by message type", () => {
      const taskMessages = db.getMessages({ toAgentId: "recipient" }).filter(
        m => m.messageType === "task"
      );
      expect(taskMessages.length).toBeGreaterThan(0);
      expect(taskMessages.every(m => m.messageType === "task")).toBe(true);
    });

    it("should filter by priority", () => {
      const criticalMessages = db.getMessages({ toAgentId: "recipient" }).filter(
        m => m.priority === "critical"
      );
      expect(criticalMessages.length).toBeGreaterThan(0);
      expect(criticalMessages.every(m => m.priority === "critical")).toBe(true);
    });

    it("should filter by channel", () => {
      const backendMessages = db.getMessages({ toAgentId: "recipient", channel: "#backend" });
      expect(backendMessages.length).toBeGreaterThan(0);
      expect(backendMessages.every(m => m.channel === "#backend")).toBe(true);
    });

    it("should filter by sender", () => {
      const fromAgentA = db.getMessages({ toAgentId: "recipient", fromAgentId: "agent-a" });
      expect(fromAgentA.length).toBeGreaterThan(0);
      expect(fromAgentA.every(m => m.fromAgentId === "agent-a")).toBe(true);
    });

    it("should filter by time range (since)", () => {
      const now = Date.now();
      const recentMessages = db.getMessages({
        toAgentId: "recipient",
        since: now - 30 * 1000,
      });
      expect(recentMessages.length).toBeLessThan(50);
      expect(recentMessages.length).toBeGreaterThan(0);
    });
  });

  describe("Concurrent Operations", () => {
    it("should handle concurrent inserts without data loss", async () => {
      const promises = [];
      const count = 100;

      for (let i = 0; i < count; i++) {
        const promise = Promise.resolve().then(() => {
          db.insertMessage({
            id: `msg-${i}`,
            sessionId: "test-session",
            fromAgentId: "sender",
            toAgentId: "recipient",
            messageType: "text",
            content: `Concurrent message ${i}`,
            createdAt: Date.now(),
          });
        });
        promises.push(promise);
      }

      await Promise.all(promises);

      const messages = db.getMessages({ toAgentId: "recipient" });
      expect(messages).toHaveLength(count);
    });

    it("should handle concurrent reads without blocking", async () => {
      // Insert some messages first
      for (let i = 0; i < 10; i++) {
        db.insertMessage({
          id: `msg-${i}`,
          sessionId: "test-session",
          fromAgentId: "sender",
          toAgentId: "recipient",
          messageType: "text",
          content: `Message ${i}`,
          createdAt: Date.now(),
        });
      }

      // Read concurrently
      const promises = [];
      for (let i = 0; i < 20; i++) {
        const promise = Promise.resolve().then(() => {
          return db.getMessages({ toAgentId: "recipient" });
        });
        promises.push(promise);
      }

      const results = await Promise.all(promises);
      expect(results).toHaveLength(20);
      expect(results.every(r => r.length === 10)).toBe(true);
    });

    it("should handle concurrent mark-read operations", async () => {
      // Insert messages
      const messageIds = [];
      for (let i = 0; i < 10; i++) {
        const id = `msg-${i}`;
        messageIds.push(id);
        db.insertMessage({
          id,
          sessionId: "test-session",
          fromAgentId: "sender",
          toAgentId: "recipient",
          messageType: "text",
          content: `Message ${i}`,
          createdAt: Date.now(),
        });
      }

      // Mark read concurrently
      const promises = messageIds.map(id =>
        Promise.resolve().then(() => db.markMessageRead(id))
      );

      await Promise.all(promises);

      const messages = db.getMessages({ toAgentId: "recipient" });
      expect(messages.every(m => m.status === "read")).toBe(true);
    });
  });

  describe("Retention Policy", () => {
    it("should delete old read messages after 30 days", () => {
      const thirtyOneDaysAgo = Date.now() - (31 * 24 * 60 * 60 * 1000);
      const twentyNineDaysAgo = Date.now() - (29 * 24 * 60 * 60 * 1000);

      // Insert old message
      db.insertMessage({
        id: "msg-old",
        sessionId: "test-session",
        fromAgentId: "sender",
        toAgentId: "recipient",
        messageType: "text",
        content: "Old message",
        createdAt: thirtyOneDaysAgo,
      });
      db.markMessageRead("msg-old");

      // Insert recent message
      db.insertMessage({
        id: "msg-recent",
        sessionId: "test-session",
        fromAgentId: "sender",
        toAgentId: "recipient",
        messageType: "text",
        content: "Recent message",
        createdAt: twentyNineDaysAgo,
      });
      db.markMessageRead("msg-recent");

      const deleted = db.cleanupExpiredMessages();

      const messages = db.getMessages({ toAgentId: "recipient" });
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg-recent");
      expect(deleted).toBe(1);
    });

    it("should delete old pending/delivered messages after 7 days", () => {
      const eightDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000);
      const sixDaysAgo = Date.now() - (6 * 24 * 60 * 60 * 1000);

      // Insert old pending message
      db.insertMessage({
        id: "msg-old-pending",
        sessionId: "test-session",
        fromAgentId: "sender",
        toAgentId: "recipient",
        messageType: "text",
        content: "Old pending",
        createdAt: eightDaysAgo,
      });

      // Insert recent pending message
      db.insertMessage({
        id: "msg-recent-pending",
        sessionId: "test-session",
        fromAgentId: "sender",
        toAgentId: "recipient",
        messageType: "text",
        content: "Recent pending",
        createdAt: sixDaysAgo,
      });

      const deleted = db.cleanupExpiredMessages();

      const messages = db.getMessages({ toAgentId: "recipient" });
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg-recent-pending");
      expect(deleted).toBe(1);
    });

    it("should handle mixed retention policies correctly", () => {
      const now = Date.now();
      const oldTimestamp = now - (32 * 24 * 60 * 60 * 1000);
      const mediumTimestamp = now - (10 * 24 * 60 * 60 * 1000);
      const recentTimestamp = now - (1 * 24 * 60 * 60 * 1000);

      // Old read (should be deleted)
      db.insertMessage({
        id: "msg-1",
        sessionId: "test-session",
        fromAgentId: "sender",
        toAgentId: "recipient",
        messageType: "text",
        content: "Old read",
        createdAt: oldTimestamp,
      });
      db.markMessageRead("msg-1");

      // Old pending (should be deleted)
      db.insertMessage({
        id: "msg-2",
        sessionId: "test-session",
        fromAgentId: "sender",
        toAgentId: "recipient",
        messageType: "text",
        content: "Old pending",
        createdAt: mediumTimestamp,
      });

      // Recent read (should be kept)
      db.insertMessage({
        id: "msg-3",
        sessionId: "test-session",
        fromAgentId: "sender",
        toAgentId: "recipient",
        messageType: "text",
        content: "Recent read",
        createdAt: recentTimestamp,
      });
      db.markMessageRead("msg-3");

      // Recent pending (should be kept)
      db.insertMessage({
        id: "msg-4",
        sessionId: "test-session",
        fromAgentId: "sender",
        toAgentId: "recipient",
        messageType: "text",
        content: "Recent pending",
        createdAt: recentTimestamp,
      });

      const deleted = db.cleanupExpiredMessages();

      const messages = db.getMessages({ toAgentId: "recipient" });
      expect(messages).toHaveLength(2);
      expect(messages.map(m => m.id).sort()).toEqual(["msg-3", "msg-4"]);
      expect(deleted).toBe(2);
    });
  });

  describe("Message Threading", () => {
    it("should support parent_message_id for threading", () => {
      db.insertMessage({
        id: "msg-parent",
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "question",
        content: "What is the status?",
        createdAt: Date.now(),
      });

      db.insertMessage({
        id: "msg-reply",
        sessionId: "test-session",
        fromAgentId: "agent-b",
        toAgentId: "agent-a",
        messageType: "response",
        content: "All good!",
        createdAt: Date.now(),
        parentMessageId: "msg-parent",
      });

      const messages = db.getMessages({ toAgentId: "agent-a" });
      expect(messages).toHaveLength(1);
      expect(messages[0].parentMessageId).toBe("msg-parent");
    });

    it("should allow querying message threads", () => {
      const parentId = "msg-parent";

      db.insertMessage({
        id: parentId,
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "question",
        content: "Parent message",
        createdAt: Date.now() - 3000,
      });

      for (let i = 0; i < 3; i++) {
        db.insertMessage({
          id: `msg-reply-${i}`,
          sessionId: "test-session",
          fromAgentId: "agent-b",
          toAgentId: "agent-a",
          messageType: "response",
          content: `Reply ${i}`,
          createdAt: Date.now() - (2 - i) * 1000,
          parentMessageId: parentId,
        });
      }

      // Get all messages
      const allMessages = db.getMessages({ sessionId: "test-session" });
      const replies = allMessages.filter(m => m.parentMessageId === parentId);

      expect(replies).toHaveLength(3);
    });
  });

  describe("Channel Broadcasts", () => {
    it("should support channel field for broadcasts", () => {
      db.insertMessage({
        id: "msg-broadcast",
        sessionId: "test-session",
        fromAgentId: "coordinator",
        toAgentId: "broadcast",
        messageType: "broadcast",
        content: "All agents: please report status",
        createdAt: Date.now(),
        channel: "#all",
      });

      const messages = db.getMessages({ channel: "#all" });
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain("report status");
    });

    it("should filter messages by channel", () => {
      const channels = ["#frontend", "#backend", "#all"];

      channels.forEach((channel, i) => {
        db.insertMessage({
          id: `msg-${i}`,
          sessionId: "test-session",
          fromAgentId: "coordinator",
          toAgentId: "broadcast",
          messageType: "broadcast",
          content: `Message for ${channel}`,
          createdAt: Date.now(),
          channel,
        });
      });

      const frontendMessages = db.getMessages({ channel: "#frontend" });
      const backendMessages = db.getMessages({ channel: "#backend" });
      const allMessages = db.getMessages({ channel: "#all" });

      expect(frontendMessages).toHaveLength(1);
      expect(backendMessages).toHaveLength(1);
      expect(allMessages).toHaveLength(1);
    });
  });

  describe("Metadata and Payload", () => {
    it("should store and retrieve complex metadata", () => {
      const metadata = {
        priority: "urgent",
        tags: ["bug", "blocker"],
        context: {
          file: "src/app.ts",
          line: 42,
          error: "TypeError: Cannot read property 'x' of undefined",
        },
      };

      db.insertMessage({
        id: "msg-with-metadata",
        sessionId: "test-session",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        messageType: "text",
        content: "Check this error",
        createdAt: Date.now(),
        metadata,
      });

      const messages = db.getMessages({ toAgentId: "agent-b" });
      expect(messages[0].metadata).toEqual(metadata);
    });

    it("should store and retrieve typed payloads", () => {
      const payload = {
        messageType: "task-assignment",
        title: "Fix critical bug",
        description: "User login is broken",
        files: ["src/auth.ts", "src/login.ts"],
        acceptanceCriteria: ["Users can log in", "No errors in console"],
      };

      db.insertMessage({
        id: "msg-with-payload",
        sessionId: "test-session",
        fromAgentId: "master",
        toAgentId: "worker",
        messageType: "task",
        content: "Task assigned",
        createdAt: Date.now(),
        payload,
      });

      const messages = db.getMessages({ toAgentId: "worker" });
      expect(messages[0].payload).toEqual(payload);
    });
  });
});
