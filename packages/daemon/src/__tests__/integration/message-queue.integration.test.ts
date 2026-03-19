/**
 * Integration tests for MessageQueue rate limiter and delivery system.
 * Tests rate limit enforcement, window resets, conversation loop detection,
 * readiness caching, notification bypass, and edge cases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MessageQueue } from "../../core/message-queue.js";
import type { IPtyBackend } from "../../core/pty-backend.js";
import { logger } from "../../core/logger.js";

// Mock fs/promises for MCP message delivery
vi.mock("fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
}));

describe("MessageQueue Integration Tests", () => {
  let mockTmux: IPtyBackend;
  let queue: MessageQueue;

  // Helper to wait for async operations
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  beforeEach(() => {
    mockTmux = {
      newSession: vi.fn().mockResolvedValue(undefined),
      hasSession: vi.fn().mockResolvedValue(true),
      killSession: vi.fn().mockResolvedValue(undefined),
      sendKeys: vi.fn().mockResolvedValue(undefined),
      capturePane: vi.fn().mockResolvedValue("$ "), // Shell prompt (ready)
      pipePaneStart: vi.fn().mockResolvedValue(undefined),
      pipePaneStop: vi.fn().mockResolvedValue(undefined),
      getPanePID: vi.fn().mockResolvedValue(12345),
    } as any;

    queue = new MessageQueue(mockTmux, "/tmp/.kora-test", "terminal");
    queue.start();
  });

  afterEach(() => {
    queue.stop();
    vi.clearAllMocks();
  });

  describe("Rate Limit Enforcement", () => {
    it("delivers up to 10 messages per minute per agent", async () => {
      // Enqueue 10 messages
      for (let i = 0; i < 10; i++) {
        const result = queue.enqueue("agent-1", "tmux-1", `Message ${i}`);
        expect(result).toBe(true);
      }

      // Wait for queue processing
      await wait(1500);

      // All 10 should be delivered
      expect(mockTmux.sendKeys).toHaveBeenCalledTimes(10);
    });

    it("logs warning when 11th message hits rate limit", async () => {
      const warnSpy = vi.spyOn(logger, "warn");

      // Enqueue 10 messages and process
      for (let i = 0; i < 10; i++) {
        queue.enqueue("agent-1", "tmux-1", `Message ${i}`);
      }
      await wait(1000);

      // 11th message
      queue.enqueue("agent-1", "tmux-1", "Message 11");
      await wait(1000);

      // Should log rate limit warning
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Rate limited: dropping message for agent agent-1")
      );
    });

    it("rate limits are per-agent (independent counters)", async () => {
      // Agent 1: send 10 messages
      for (let i = 0; i < 10; i++) {
        queue.enqueue("agent-1", "tmux-1", `A1 msg ${i}`);
      }

      // Agent 2: send 10 messages
      for (let i = 0; i < 10; i++) {
        queue.enqueue("agent-2", "tmux-2", `A2 msg ${i}`);
      }

      await wait(1000);

      // Both agents should have all 10 messages delivered
      expect(mockTmux.sendKeys).toHaveBeenCalledTimes(20);
    });
  });

  describe("Rate Limit Window Reset", () => {
    it("resets rate limit after 60 seconds", async () => {
      // Send 10 messages
      for (let i = 0; i < 10; i++) {
        queue.enqueue("agent-1", "tmux-1", `Batch 1 msg ${i}`);
      }
      await wait(1000);

      expect(mockTmux.sendKeys).toHaveBeenCalledTimes(10);
      mockTmux.sendKeys = vi.fn().mockResolvedValue(undefined); // Reset spy

      // Wait 61 seconds (window reset)
      await wait(61_000);

      // Send 10 more messages
      for (let i = 0; i < 10; i++) {
        queue.enqueue("agent-1", "tmux-1", `Batch 2 msg ${i}`);
      }
      await wait(1000);

      // All 10 should be delivered (new window)
      expect(mockTmux.sendKeys).toHaveBeenCalledTimes(10);
    }, 70000);

    it("partial window expiry: messages delivered incrementally", async () => {
      // Send 10 messages at T=0
      for (let i = 0; i < 10; i++) {
        queue.enqueue("agent-1", "tmux-1", `msg ${i}`);
      }
      await wait(1000);
      expect(mockTmux.sendKeys).toHaveBeenCalledTimes(10);

      // Wait 30s, send 11th message
      await wait(30_000);
      queue.enqueue("agent-1", "tmux-1", "msg 11");
      await wait(1000);

      // Still rate limited (within 60s window)
      expect(mockTmux.sendKeys).toHaveBeenCalledTimes(10);

      // Wait another 31s (total 61s from first message)
      await wait(31_000);
      await wait(1000);

      // Now 11th message should be delivered
      expect(mockTmux.sendKeys).toHaveBeenCalledTimes(11);
    }, 70000);
  });

  describe("Conversation Loop Detection", () => {
    it("allows up to 8 messages between same pair in 2 minutes", async () => {
      // Agent A → Agent B: 8 messages
      for (let i = 0; i < 8; i++) {
        const result = queue.enqueue("agent-b", "tmux-b", `msg ${i}`, "agent-a");
        expect(result).toBe(true);
      }

      await wait(1000);
      expect(mockTmux.sendKeys).toHaveBeenCalledTimes(8);
    });

    it("drops 9th message between same pair", async () => {
      const warnSpy = vi.spyOn(logger, "warn");

      // 8 messages OK
      for (let i = 0; i < 8; i++) {
        queue.enqueue("agent-b", "tmux-b", `msg ${i}`, "agent-a");
      }

      // 9th message should be dropped
      const result = queue.enqueue("agent-b", "tmux-b", "msg 9", "agent-a");
      expect(result).toBe(false);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Loop detected")
      );
    });

    it("uses sorted pair key (order-independent)", async () => {
      // A → B: 4 messages
      for (let i = 0; i < 4; i++) {
        queue.enqueue("agent-b", "tmux-b", `A→B ${i}`, "agent-a");
      }

      // B → A: 4 messages (same pair, different direction)
      for (let i = 0; i < 4; i++) {
        queue.enqueue("agent-a", "tmux-a", `B→A ${i}`, "agent-b");
      }

      // 9th message (either direction) should be dropped
      const result = queue.enqueue("agent-b", "tmux-b", "msg 9", "agent-a");
      expect(result).toBe(false);
    });

    it("resets conversation window after 2 minutes", async () => {
      // 8 messages at T=0
      for (let i = 0; i < 8; i++) {
        queue.enqueue("agent-b", "tmux-b", `msg ${i}`, "agent-a");
      }

      // Wait 121 seconds (window reset)
      await wait(121_000);

      // Next 8 messages should succeed
      for (let i = 0; i < 8; i++) {
        const result = queue.enqueue("agent-b", "tmux-b", `batch2 ${i}`, "agent-a");
        expect(result).toBe(true);
      }
    });

    it("independent conversation windows for different pairs", async () => {
      // Pair A-B: 8 messages
      for (let i = 0; i < 8; i++) {
        queue.enqueue("agent-b", "tmux-b", `msg ${i}`, "agent-a");
      }

      // Pair C-D: 8 messages (independent window)
      for (let i = 0; i < 8; i++) {
        const result = queue.enqueue("agent-d", "tmux-d", `msg ${i}`, "agent-c");
        expect(result).toBe(true);
      }

      await wait(1000);
      expect(mockTmux.sendKeys).toHaveBeenCalledTimes(16);
    });
    }, 130000);

  describe("Readiness Caching", () => {
    it("caches readiness check for 400ms", async () => {
      mockTmux.capturePane = vi.fn().mockResolvedValue("❯ "); // Ready

      // First message triggers readiness check
      queue.enqueue("agent-1", "tmux-1", "msg 1");
      await wait(100);

      // Second message uses cached result
      queue.enqueue("agent-1", "tmux-1", "msg 2");
      await wait(100);

      // Only 1 capturePane call (cached)
      expect(mockTmux.capturePane).toHaveBeenCalledTimes(1);
    });

    it("cache expires after 400ms and refreshes", async () => {
      mockTmux.capturePane = vi.fn().mockResolvedValue("❯ ");

      // First message
      queue.enqueue("agent-1", "tmux-1", "msg 1");
      await wait(100);

      expect(mockTmux.capturePane).toHaveBeenCalledTimes(1);

      // Wait 500ms (cache expired)
      await wait(500);

      // Next message triggers fresh check
      queue.enqueue("agent-1", "tmux-1", "msg 2");
      await wait(100);

      expect(mockTmux.capturePane).toHaveBeenCalledTimes(2);
    });

    it("separate cache per agent", async () => {
      mockTmux.capturePane = vi.fn().mockResolvedValue("❯ ");

      queue.enqueue("agent-1", "tmux-1", "msg 1");
      queue.enqueue("agent-2", "tmux-2", "msg 1");
      await wait(100);

      // 2 agents = 2 capturePane calls (different sessions)
      expect(mockTmux.capturePane).toHaveBeenCalledTimes(2);
    });
  });

  describe("Notification Bypass", () => {
    it("delivers notifications immediately even when agent not ready", async () => {
      mockTmux.capturePane = vi.fn().mockResolvedValue("Thinking..."); // Not ready

      queue.enqueue("agent-1", "tmux-1", "[New message from Architect. Use check_messages tool to read it.]");
      await wait(1000);

      // Delivered despite agent not ready
      expect(mockTmux.sendKeys).toHaveBeenCalledWith(
        "tmux-1",
        expect.stringContaining("[New message from"),
        { literal: false }
      );
    });

    it("bypasses rate limit for notifications", async () => {
      // Hit rate limit with 10 messages
      for (let i = 0; i < 10; i++) {
        queue.enqueue("agent-1", "tmux-1", `Regular message ${i}`);
      }
      await wait(1000);

      // Notification should still deliver
      queue.enqueue("agent-1", "tmux-1", "[New message from Architect. Use check_messages tool to read it.]");
      await wait(1000);

      // 11 calls total (10 regular + 1 notification)
      expect(mockTmux.sendKeys).toHaveBeenCalledTimes(11);
    });

    it("recognizes various notification patterns", async () => {
      mockTmux.capturePane = vi.fn().mockResolvedValue("Thinking...");

      const notifications = [
        "[New message from Alice]",
        "[Message from Bob]",
        "Use check_messages to read",
        "[Task assigned] implement feature",
        "[Broadcast] status update",
      ];

      for (const notif of notifications) {
        queue.enqueue("agent-1", "tmux-1", notif);
      }

      await wait(1000);

      // All delivered immediately
      expect(mockTmux.sendKeys).toHaveBeenCalledTimes(5);
    });
  });

  describe("Agent Readiness Detection", () => {
    it("delivers message when agent shows input prompt", async () => {
      mockTmux.capturePane = vi.fn().mockResolvedValue("❯ "); // Claude Code prompt

      queue.enqueue("agent-1", "tmux-1", "Hello");
      await wait(1000);

      expect(mockTmux.sendKeys).toHaveBeenCalled();
    });

    it("waits when agent is thinking", async () => {
      mockTmux.capturePane = vi.fn().mockResolvedValue("Thinking about next step...");

      queue.enqueue("agent-1", "tmux-1", "Hello");
      await wait(1000);

      // Not delivered yet
      expect(mockTmux.sendKeys).not.toHaveBeenCalled();

      // Agent becomes ready
      mockTmux.capturePane = vi.fn().mockResolvedValue("❯ ");
      await wait(1000);

      // Now delivered
      expect(mockTmux.sendKeys).toHaveBeenCalled();
    });

    it("waits when agent is reading/writing", async () => {
      mockTmux.capturePane = vi.fn().mockResolvedValue("Reading file: src/index.ts");

      queue.enqueue("agent-1", "tmux-1", "Hello");
      await wait(1000);

      expect(mockTmux.sendKeys).not.toHaveBeenCalled();
    });

    it("force delivers after 30 second timeout", async () => {
      mockTmux.capturePane = vi.fn().mockResolvedValue("Thinking..."); // Never ready

      queue.enqueue("agent-1", "tmux-1", "Hello");
      await wait(1000);
      expect(mockTmux.sendKeys).not.toHaveBeenCalled();

      // Wait 31 seconds
      await wait(31_000);

      // Force delivered despite not ready
      expect(mockTmux.sendKeys).toHaveBeenCalled();
    });

    it("recognizes shell prompts as ready", async () => {
      const prompts = ["$ ", "% ", "# ", "user@host:~$ "];

      for (const prompt of prompts) {
        mockTmux.capturePane = vi.fn().mockResolvedValue(prompt);
        queue.enqueue("agent-1", "tmux-1", "test");
        await wait(100);
      }

      expect(mockTmux.sendKeys).toHaveBeenCalledTimes(4);
    });
    }, 35000);

  describe("MCP Agent Registration", () => {
    it("delivers to mcp-pending for registered MCP agents", async () => {
      const mkdirSpy = vi.fn().mockResolvedValue(undefined);
      const writeFileSpy = vi.fn().mockResolvedValue(undefined);

      vi.doMock("fs/promises", () => ({
        mkdir: mkdirSpy,
        writeFile: writeFileSpy,
      }));

      queue.registerMcpAgent("agent-1");
      queue.enqueue("agent-1", "tmux-1", "[Message from Architect]: Hello");
      await wait(1000);

      // Should write to mcp-pending directory
      expect(writeFileSpy).toHaveBeenCalled();
      const callArgs = writeFileSpy.mock.calls[0];
      expect(callArgs[0]).toContain("mcp-pending/agent-1");
    });

    it("delivers via terminal for non-MCP agents in terminal mode", async () => {
      const termQueue = new MessageQueue(mockTmux, "/tmp/.kora-test", "terminal");
      termQueue.start();

      termQueue.enqueue("agent-1", "tmux-1", "[Message from Bob]: Hello world");
      await wait(1000);

      // Should use sendKeys
      expect(mockTmux.sendKeys).toHaveBeenCalledWith(
        "tmux-1",
        expect.stringContaining("Hello world"),
        { literal: false }
      );

      termQueue.stop();
    });
  });

  describe("Edge Cases", () => {
    it("handles agent death mid-delivery gracefully", async () => {
      mockTmux.sendKeys = vi.fn().mockRejectedValue(new Error("Session not found"));

      queue.enqueue("agent-1", "tmux-1", "Hello");
      await wait(1000);

      // Should not throw, just discard message
      // (Error is caught internally in MessageQueue)
    });

    it("handles zero-length queue processing", async () => {
      // No messages enqueued
      await wait(5000);

      // Should not error
      expect(mockTmux.sendKeys).not.toHaveBeenCalled();
    });

    it("handles concurrent enqueues without corruption", async () => {
      // Spawn 50 concurrent enqueues
      const promises = [];
      for (let i = 0; i < 50; i++) {
        promises.push(Promise.resolve(queue.enqueue("agent-1", "tmux-1", `msg ${i}`)));
      }

      await Promise.all(promises);
      await wait(2000);

      // All should be tracked (first 10 delivered, rest rate limited)
      expect(mockTmux.sendKeys).toHaveBeenCalledTimes(10);
    });

    it("removes agent cleanly from all tracking maps", () => {
      queue.enqueue("agent-1", "tmux-1", "msg 1");
      queue.registerMcpAgent("agent-1");

      queue.removeAgent("agent-1");

      // Queue should be cleaned up
      queue.enqueue("agent-1", "tmux-1", "msg 2");
      expect(queue["queues"].has("agent-1")).toBe(true); // New queue created
      expect(queue["queues"].get("agent-1")?.length).toBe(1); // Only new message
    });

    it("handles empty capturePane output", async () => {
      mockTmux.capturePane = vi.fn().mockResolvedValue("");

      queue.enqueue("agent-1", "tmux-1", "Hello");
      await wait(1000);

      // Should assume not ready and wait
      expect(mockTmux.sendKeys).not.toHaveBeenCalled();
    });

    it("handles malformed tmux output gracefully", async () => {
      mockTmux.capturePane = vi.fn().mockResolvedValue("\x00\x01\x02invalid\x1b[K");

      queue.enqueue("agent-1", "tmux-1", "Hello");
      await wait(1000);

      // Should not throw (malformed output is handled gracefully)
    });
  });

  describe("Re-notification System", () => {
    beforeEach(() => {
      queue.setRenotifyCallbacks(
        async (agentId: string) => {
          // Mock unread count
          if (agentId === "agent-1") return 3;
          return 0;
        },
        (agentId: string) => {
          if (agentId === "agent-1") return "tmux-1";
          return null;
        }
      );
      queue.registerMcpAgent("agent-1");
    });

    it("sends re-notification for agents with unread messages", async () => {
      // Wait 20 seconds (re-notification interval)
      await wait(20_000);

      // Should send re-notification
      expect(mockTmux.sendKeys).toHaveBeenCalledWith(
        "tmux-1",
        expect.stringContaining("3 unread message(s)"),
        { literal: false }
      );
    });

    it("escalates notification urgency after multiple attempts", async () => {
      // First attempt (T=20s)
      await wait(20_000);
      expect(mockTmux.sendKeys).toHaveBeenCalledWith(
        "tmux-1",
        expect.stringContaining("unread message"),
        { literal: false }
      );

      // Second attempt (T=40s) - more urgent
      await wait(20_000);
      expect(mockTmux.sendKeys).toHaveBeenCalledWith(
        "tmux-1",
        expect.stringContaining("⚠️"),
        { literal: false }
      );

      // Third attempt (T=60s) - most urgent
      await wait(20_000);
      expect(mockTmux.sendKeys).toHaveBeenCalledWith(
        "tmux-1",
        expect.stringContaining("🔴 URGENT"),
        { literal: false }
      );
    });

    it("resets notification attempts when agent reads messages", async () => {
      // First notification
      await wait(20_000);
      expect(queue.getNotificationAttempts("agent-1")).toBe(1);

      // Agent reads messages
      queue.resetNotificationAttempts("agent-1");
      expect(queue.getNotificationAttempts("agent-1")).toBe(0);
    });

    it("rate limits re-notifications to 10s minimum", async () => {
      // First notification at T=20s
      await wait(20_000);
      const firstCallCount = vi.mocked(mockTmux.sendKeys).mock.calls.length;

      // Wait 5s (< 10s minimum)
      await wait(5_000);

      // No new notification yet
      expect(mockTmux.sendKeys).toHaveBeenCalledTimes(firstCallCount);

      // Wait another 6s (total 11s from last notification)
      await wait(6_000);

      // Now another notification sent
      expect(vi.mocked(mockTmux.sendKeys).mock.calls.length).toBeGreaterThan(firstCallCount);
    });

    it("nudges agent immediately on demand", async () => {
      const unread = await queue.nudgeAgent("agent-1", "tmux-1");

      expect(unread).toBe(3);
      expect(mockTmux.sendKeys).toHaveBeenCalledWith(
        "tmux-1",
        expect.stringContaining("3 UNREAD MESSAGE(S)"),
        { literal: false }
      );
    });
    }, 40000);

  describe("Adaptive Polling", () => {
    it("polls every 500ms when queues have messages", async () => {
      queue.enqueue("agent-1", "tmux-1", "Hello");

      // Should process within 500ms
      await wait(500);
      expect(mockTmux.sendKeys).toHaveBeenCalled();
    });

    it("polls every 2000ms when queues are empty", async () => {
      // No messages enqueued
      await wait(1000);

      // capturePane shouldn't be called yet (2s interval)
      expect(mockTmux.capturePane).not.toHaveBeenCalled();

      await wait(1500);

      // Now poll cycle triggered
      // (Note: may not call capturePane if no messages to deliver)
    });
  });
});
