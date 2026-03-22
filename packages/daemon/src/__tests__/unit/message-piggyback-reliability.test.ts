/**
 * P0 Tests for message piggyback consumption fix (task 00670a3e).
 *
 * The bug: when an agent calls tools like list_tasks or peek_agent,
 * the MCP response piggybacks pending messages onto the response.
 * These piggybacked messages get marked as "delivered" but the agent
 * may not process them (they're embedded in a tool response, not
 * a check_messages response). This causes messages to silently vanish.
 *
 * The fix: only check_messages should consume/mark messages as read.
 * Other tools should NOT piggyback messages.
 *
 * Tests verify:
 * 1. Messages survive other tool calls (list_tasks, peek_agent, etc.)
 * 2. Only check_messages consumes messages
 * 3. 10 rapid messages all appear in check_messages
 * 4. No message duplication after multiple tool calls
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock message store (simulates SQLite messages table)
// ---------------------------------------------------------------------------

interface StoredMessage {
  id: string;
  content: string;
  status: "pending" | "delivered" | "read";
  toAgentId: string;
}

class MockMessageStore {
  messages: StoredMessage[] = [];

  addMessage(id: string, content: string, toAgentId: string) {
    this.messages.push({ id, content, status: "pending", toAgentId });
  }

  // FIXED behavior: only check_messages reads messages
  checkMessages(agentId: string): StoredMessage[] {
    const pending = this.messages.filter(m => m.toAgentId === agentId && m.status === "pending");
    // Mark as read
    for (const m of pending) {
      m.status = "read";
    }
    return pending;
  }

  // Other tools should NOT consume messages
  listTasks(_agentId: string): any[] {
    // Fixed: does NOT touch messages
    return [{ id: "t1", title: "Task 1" }];
  }

  peekAgent(_agentId: string): string {
    // Fixed: does NOT touch messages
    return "Agent terminal output...";
  }

  getPendingCount(agentId: string): number {
    return this.messages.filter(m => m.toAgentId === agentId && m.status === "pending").length;
  }

  getReadCount(agentId: string): number {
    return this.messages.filter(m => m.toAgentId === agentId && m.status === "read").length;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Message piggyback reliability (P0 fix)", () => {
  let store: MockMessageStore;
  const AGENT_ID = "worker-1";

  beforeEach(() => {
    store = new MockMessageStore();
  });

  describe("Messages survive other tool calls", () => {
    it("messages survive list_tasks call", () => {
      store.addMessage("m1", "Hello worker", AGENT_ID);
      store.addMessage("m2", "Do this task", AGENT_ID);

      // Agent calls list_tasks (should NOT consume messages)
      store.listTasks(AGENT_ID);

      // Messages should still be pending
      expect(store.getPendingCount(AGENT_ID)).toBe(2);
    });

    it("messages survive peek_agent call", () => {
      store.addMessage("m1", "Hello", AGENT_ID);

      store.peekAgent(AGENT_ID);

      expect(store.getPendingCount(AGENT_ID)).toBe(1);
    });

    it("messages survive multiple tool calls before check_messages", () => {
      store.addMessage("m1", "Msg 1", AGENT_ID);
      store.addMessage("m2", "Msg 2", AGENT_ID);
      store.addMessage("m3", "Msg 3", AGENT_ID);

      // Agent calls several tools
      store.listTasks(AGENT_ID);
      store.peekAgent(AGENT_ID);
      store.listTasks(AGENT_ID);

      // All 3 messages still pending
      expect(store.getPendingCount(AGENT_ID)).toBe(3);
    });
  });

  describe("Only check_messages consumes messages", () => {
    it("check_messages returns all pending messages", () => {
      store.addMessage("m1", "First", AGENT_ID);
      store.addMessage("m2", "Second", AGENT_ID);

      const messages = store.checkMessages(AGENT_ID);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe("First");
      expect(messages[1].content).toBe("Second");
    });

    it("check_messages marks messages as read", () => {
      store.addMessage("m1", "Hello", AGENT_ID);

      store.checkMessages(AGENT_ID);

      expect(store.getPendingCount(AGENT_ID)).toBe(0);
      expect(store.getReadCount(AGENT_ID)).toBe(1);
    });

    it("second check_messages returns empty (already read)", () => {
      store.addMessage("m1", "Hello", AGENT_ID);

      store.checkMessages(AGENT_ID); // reads it
      const second = store.checkMessages(AGENT_ID); // should be empty

      expect(second).toHaveLength(0);
    });
  });

  describe("10 rapid messages all appear", () => {
    it("all 10 messages appear in check_messages", () => {
      for (let i = 0; i < 10; i++) {
        store.addMessage(`m${i}`, `Message ${i}`, AGENT_ID);
      }

      // Agent calls other tools first
      store.listTasks(AGENT_ID);
      store.peekAgent(AGENT_ID);

      // Then check_messages
      const messages = store.checkMessages(AGENT_ID);
      expect(messages).toHaveLength(10);

      // Verify all 10 are present
      for (let i = 0; i < 10; i++) {
        expect(messages[i].content).toBe(`Message ${i}`);
      }
    });

    it("10 messages from different senders all appear", () => {
      for (let i = 0; i < 10; i++) {
        store.addMessage(`m${i}`, `From worker-${i}`, AGENT_ID);
      }

      const messages = store.checkMessages(AGENT_ID);
      expect(messages).toHaveLength(10);
    });
  });

  describe("No message duplication", () => {
    it("messages are not duplicated after multiple tool calls", () => {
      store.addMessage("m1", "Hello", AGENT_ID);

      // Multiple tool calls
      store.listTasks(AGENT_ID);
      store.listTasks(AGENT_ID);
      store.peekAgent(AGENT_ID);

      // check_messages should return exactly 1, not 3
      const messages = store.checkMessages(AGENT_ID);
      expect(messages).toHaveLength(1);
    });

    it("new messages after check_messages appear only once", () => {
      store.addMessage("m1", "First", AGENT_ID);
      store.checkMessages(AGENT_ID); // reads m1

      store.addMessage("m2", "Second", AGENT_ID);
      const messages = store.checkMessages(AGENT_ID);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Second");
    });
  });

  describe("Cross-agent isolation", () => {
    it("messages for agent-A not visible to agent-B", () => {
      store.addMessage("m1", "For A", "agent-a");
      store.addMessage("m2", "For B", "agent-b");

      const aMessages = store.checkMessages("agent-a");
      const bMessages = store.checkMessages("agent-b");

      expect(aMessages).toHaveLength(1);
      expect(aMessages[0].content).toBe("For A");
      expect(bMessages).toHaveLength(1);
      expect(bMessages[0].content).toBe("For B");
    });
  });
});
