/**
 * Tests for check_messages stale message bug (#36afe2db).
 *
 * ROOT CAUSE: When SQLite messages are all read and mcp-pending/inbox are empty,
 * check_messages falls through to an events API fallback that returns ALL historical
 * message-sent events (which are never marked as read), causing stale messages.
 *
 * These tests verify:
 * 1. Database markMessagesRead correctly updates status
 * 2. getMessages with status filter excludes read messages
 * 3. After mark-read, getMessages returns empty (no stale messages)
 * 4. getUnreadMessageCount returns 0 after mark-read
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AppDatabase } from "../../core/database.js";
import fs from "fs";
import os from "os";
import path from "path";

describe("check_messages stale message bug", () => {
  let db: AppDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-stale-test-"));
    db = new AppDatabase(tmpDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("SQLite message read tracking (Tier 1)", () => {
    it("marks messages as read and excludes them from subsequent queries", () => {
      // Insert a message (simulating send_message delivery)
      db.insertMessage({
        id: "msg-001",
        sessionId: "test-session",
        fromAgentId: "architect-abc",
        toAgentId: "tests-xyz",
        messageType: "text",
        content: "Please review the PR",
        priority: "normal",
        status: "pending",
        createdAt: Date.now(),
        expiresAt: Date.now() + 180000,
      });

      // First check: message should appear with status pending
      const firstCheck = db.getMessages({
        toAgentId: "tests-xyz",
        sessionId: "test-session",
        status: ["pending", "delivered"],
      });
      expect(firstCheck).toHaveLength(1);
      expect(firstCheck[0].content).toBe("Please review the PR");

      // Mark as read (what readSqliteMessages does after fetching)
      db.markMessagesRead(["msg-001"]);

      // Second check: message should NOT appear anymore
      const secondCheck = db.getMessages({
        toAgentId: "tests-xyz",
        sessionId: "test-session",
        status: ["pending", "delivered"],
      });
      expect(secondCheck).toHaveLength(0);
    });

    it("getUnreadMessageCount returns 0 after mark-read", () => {
      db.insertMessage({
        id: "msg-002",
        sessionId: "test-session",
        fromAgentId: "architect-abc",
        toAgentId: "tests-xyz",
        messageType: "text",
        content: "Task assigned to you",
        priority: "normal",
        status: "pending",
        createdAt: Date.now(),
        expiresAt: Date.now() + 180000,
      });

      // Before read
      expect(db.getUnreadMessageCount("tests-xyz")).toBe(1);

      // Mark as read
      db.markMessagesRead(["msg-002"]);

      // After read
      expect(db.getUnreadMessageCount("tests-xyz")).toBe(0);
    });

    it("message status changes from pending to read", () => {
      db.insertMessage({
        id: "msg-003",
        sessionId: "test-session",
        fromAgentId: "architect-abc",
        toAgentId: "tests-xyz",
        messageType: "text",
        content: "Check the build",
        priority: "normal",
        status: "pending",
        createdAt: Date.now(),
        expiresAt: Date.now() + 180000,
      });

      db.markMessagesRead(["msg-003"]);

      // Query without status filter — should return with status "read"
      const all = db.getMessages({
        toAgentId: "tests-xyz",
        sessionId: "test-session",
      });
      expect(all).toHaveLength(1);
      expect(all[0].status).toBe("read");
      expect(all[0].readAt).toBeGreaterThan(0);
    });

    it("handles multiple messages correctly — only marks specified ones", () => {
      const now = Date.now();
      db.insertMessage({
        id: "msg-a",
        sessionId: "s1",
        fromAgentId: "from1",
        toAgentId: "to1",
        messageType: "text",
        content: "Message A",
        priority: "normal",
        status: "pending",
        createdAt: now,
        expiresAt: now + 180000,
      });
      db.insertMessage({
        id: "msg-b",
        sessionId: "s1",
        fromAgentId: "from2",
        toAgentId: "to1",
        messageType: "text",
        content: "Message B",
        priority: "normal",
        status: "pending",
        createdAt: now + 1,
        expiresAt: now + 180000,
      });

      // Only mark first as read
      db.markMessagesRead(["msg-a"]);

      const pending = db.getMessages({
        toAgentId: "to1",
        sessionId: "s1",
        status: ["pending", "delivered"],
      });
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe("msg-b");
    });
  });

  describe("repeated check_messages simulation", () => {
    it("returns empty on second call after mark-read (no stale messages)", () => {
      const now = Date.now();
      // Simulate: Architect sends a message
      db.insertMessage({
        id: "msg-from-architect",
        sessionId: "karodev",
        fromAgentId: "architect-abc",
        toAgentId: "tests-xyz",
        messageType: "text",
        content: "E2E test the PR please",
        priority: "normal",
        status: "pending",
        createdAt: now,
        expiresAt: now + 180000,
      });

      // Simulate first check_messages: readSqliteMessages()
      const call1 = db.getMessages({
        toAgentId: "tests-xyz",
        sessionId: "karodev",
        status: ["pending", "delivered"],
      });
      expect(call1).toHaveLength(1);

      // Mark as read
      const ids = call1.map(m => m.id);
      db.markMessagesRead(ids);

      // Simulate second check_messages: should return empty
      const call2 = db.getMessages({
        toAgentId: "tests-xyz",
        sessionId: "karodev",
        status: ["pending", "delivered"],
      });
      expect(call2).toHaveLength(0);

      // Simulate third check_messages: still empty
      const call3 = db.getMessages({
        toAgentId: "tests-xyz",
        sessionId: "karodev",
        status: ["pending", "delivered"],
      });
      expect(call3).toHaveLength(0);

      // Unread count should be 0
      expect(db.getUnreadMessageCount("tests-xyz")).toBe(0);
    });

    /**
     * BUG DOCUMENTATION: The events API fallback in agent-mcp-server.ts
     * (lines 914-935) queries message-sent events which are NEVER marked
     * as read. When SQLite returns empty (all messages read), the fallback
     * returns stale historical messages.
     *
     * This test documents that the database layer works correctly —
     * the bug is in the MCP server's fallback logic, not in SQLite.
     *
     * FIX: Remove or gate the events API fallback in agent-mcp-server.ts
     * check_messages handler. SQLite is the primary message store and
     * the fallback is no longer needed.
     */
    it("database correctly tracks read status — bug is in events API fallback", () => {
      const now = Date.now();
      // Insert message AND an event (simulating dual-write)
      db.insertMessage({
        id: "msg-dual",
        sessionId: "karodev",
        fromAgentId: "architect-abc",
        toAgentId: "tests-xyz",
        messageType: "text",
        content: "Review the code",
        priority: "normal",
        status: "pending",
        createdAt: now,
        expiresAt: now + 180000,
      });
      db.insertEvent({
        sessionId: "karodev",
        type: "message-sent",
        timestamp: new Date().toISOString(),
        data: {
          from: "architect-abc",
          fromName: "Architect",
          to: "tests-xyz",
          toName: "Tests",
          content: "Review the code",
        },
      });

      // Read and mark message as read
      const msgs = db.getMessages({
        toAgentId: "tests-xyz",
        sessionId: "karodev",
        status: ["pending", "delivered"],
      });
      db.markMessagesRead(msgs.map(m => m.id));

      // Messages: correctly empty
      const afterRead = db.getMessages({
        toAgentId: "tests-xyz",
        sessionId: "karodev",
        status: ["pending", "delivered"],
      });
      expect(afterRead).toHaveLength(0);

      // Events: still present (events are logs, not messages)
      const events = db.queryEvents({ sessionId: "karodev", type: "message-sent", limit: 20 });
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].data.content).toBe("Review the code");

      // ^^^ This is the bug: check_messages falls back to events when messages
      // are empty, returning stale "Review the code" from the event log.
    });
  });
});
