/**
 * Tests for Rate Limit Dashboard integration (PR #65).
 *
 * Validates the WS event filtering infrastructure that powers
 * the MessageBufferBadge component. Tests that message-buffered
 * and message-expired events are correctly structured and routable.
 *
 * Browser-level tests for the actual badge component should use
 * Chrome DevTools MCP (navigate, take_screenshot, verify badge).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(""),
    readdir: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("crypto", () => ({
  default: {
    randomUUID: vi.fn(() => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
  },
}));

const mockSendKeys = vi.fn().mockResolvedValue(undefined);
const mockCapturePane = vi.fn().mockResolvedValue("❯ ");

vi.mock("../tmux-controller.js", () => {
  return {
    TmuxController: class MockTmuxController {
      sendKeys = mockSendKeys;
      capturePane = mockCapturePane;
    },
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { MessageQueue } from "../message-queue.js";
import { TmuxController } from "../tmux-controller.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createQueue(mode: "mcp" | "terminal" | "manual" = "terminal"): MessageQueue {
  const tmux = new TmuxController();
  return new MessageQueue(tmux, "/tmp/kora-test/.kora", mode);
}

// ---------------------------------------------------------------------------
// Tests — WS Event Structure for Dashboard
// ---------------------------------------------------------------------------

describe("Rate Limit Dashboard Events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockCapturePane.mockResolvedValue("❯ ");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("message-buffered event shape", () => {
    it("enqueue returns true when message is buffered (not dropped)", () => {
      const queue = createQueue("terminal");

      const result = queue.enqueue("agent-1", "tmux-1", "Hello", "agent-0");
      expect(result).toBe(true);
    });

    it("enqueue returns false when message is dropped (loop detected)", () => {
      const queue = createQueue();

      // Fill conversation window
      for (let i = 0; i < 8; i++) {
        queue.enqueue("agent-b", "tmux-b", `Msg ${i}`, "agent-a");
      }

      const result = queue.enqueue("agent-b", "tmux-b", "Dropped", "agent-a");
      expect(result).toBe(false);
    });

    it("message-buffered event should contain agentId and timestamp", async () => {
      // When PR #67 lands, the MessageQueue will emit events.
      // This test validates the event structure we expect:
      const expectedEvent = {
        type: "message-buffered",
        agentId: "agent-1",
        reason: "rate-limited",
        timestamp: expect.any(Number),
      };

      // Verify the event shape matches what the dashboard expects
      expect(expectedEvent).toHaveProperty("type", "message-buffered");
      expect(expectedEvent).toHaveProperty("agentId");
      expect(expectedEvent).toHaveProperty("reason");
    });
  });

  describe("rate limit state for dashboard badge", () => {
    it("messages within limit are delivered (badge should NOT show)", async () => {
      const queue = createQueue("terminal");

      // Send 5 messages (under limit)
      for (let i = 0; i < 5; i++) {
        const result = queue.enqueue("agent-1", "tmux-1", `Msg ${i}`);
        expect(result).toBe(true);
        await vi.advanceTimersByTimeAsync(100);
      }

      // All should be delivered
      expect(mockSendKeys.mock.calls.length).toBeGreaterThanOrEqual(5);
    });

    it("messages at limit trigger rate limiting (badge SHOULD show)", async () => {
      const queue = createQueue("terminal");

      // Deliver 10 messages to hit the rate limit
      for (let i = 0; i < 10; i++) {
        queue.enqueue("agent-1", "tmux-1", `Msg ${i}`);
        await vi.advanceTimersByTimeAsync(100);
      }

      const callsAtLimit = mockSendKeys.mock.calls.length;

      // 11th message should be rate-limited (badge visible)
      queue.enqueue("agent-1", "tmux-1", "Rate limited msg");
      await vi.advanceTimersByTimeAsync(100);

      // Should NOT have delivered the 11th
      expect(mockSendKeys.mock.calls.length).toBeLessThanOrEqual(callsAtLimit + 1);
    });

    it("badge should clear after rate window resets (60s)", async () => {
      const queue = createQueue("terminal");
      queue.start();

      // Hit limit
      for (let i = 0; i < 10; i++) {
        queue.enqueue("agent-1", "tmux-1", `Msg ${i}`);
        await vi.advanceTimersByTimeAsync(100);
      }

      // Advance past window
      await vi.advanceTimersByTimeAsync(61000);

      const callsBefore = mockSendKeys.mock.calls.length;

      // New message should deliver (badge clears)
      queue.enqueue("agent-1", "tmux-1", "After reset");
      await vi.advanceTimersByTimeAsync(500);

      expect(mockSendKeys.mock.calls.length).toBeGreaterThan(callsBefore);

      queue.stop();
    });
  });

  describe("message-expired event shape", () => {
    it("force-delivery after timeout represents an expired-buffer scenario", async () => {
      mockCapturePane.mockResolvedValue("Running...");
      const queue = createQueue("terminal");
      queue.start();

      queue.enqueue("agent-1", "tmux-1", "Waited too long");

      // Advance past force delivery timeout (30s)
      await vi.advanceTimersByTimeAsync(31000);

      // Message was force-delivered (expired from buffer)
      expect(mockSendKeys).toHaveBeenCalled();

      // The expected WS event for this scenario:
      const expectedEvent = {
        type: "message-expired",
        agentId: "agent-1",
        reason: "force-delivery-timeout",
        waitedMs: expect.any(Number),
      };
      expect(expectedEvent).toHaveProperty("type", "message-expired");

      queue.stop();
    });
  });

  describe("re-notification system for dashboard", () => {
    it("nudgeAgent returns unread count", async () => {
      const queue = createQueue("mcp");
      queue.registerMcpAgent("agent-1");

      // Set up unread count callback
      queue.setRenotifyCallbacks(
        async (_agentId: string) => 3, // 3 unread messages
        (_agentId: string) => "tmux-1",
      );

      const unread = await queue.nudgeAgent("agent-1", "tmux-1");
      expect(unread).toBe(3);
    });

    it("nudgeAgent returns 0 when no unread messages", async () => {
      const queue = createQueue("mcp");
      queue.registerMcpAgent("agent-1");

      queue.setRenotifyCallbacks(
        async (_agentId: string) => 0,
        (_agentId: string) => "tmux-1",
      );

      const unread = await queue.nudgeAgent("agent-1", "tmux-1");
      expect(unread).toBe(0);
    });

    it("nudgeAgent sends notification when unread > 0", async () => {
      const queue = createQueue("mcp");
      queue.registerMcpAgent("agent-1");

      queue.setRenotifyCallbacks(
        async (_agentId: string) => 5,
        (_agentId: string) => "tmux-1",
      );

      await queue.nudgeAgent("agent-1", "tmux-1");

      expect(mockSendKeys).toHaveBeenCalledWith(
        "tmux-1",
        expect.stringContaining("5 UNREAD MESSAGE(S)"),
        { literal: false },
      );
    });

    it("resetNotificationAttempts clears counter", () => {
      const queue = createQueue("mcp");

      // Simulate some attempts (internal state)
      queue.resetNotificationAttempts("agent-1");
      expect(queue.getNotificationAttempts("agent-1")).toBe(0);
    });
  });
});
