/**
 * E2E-ready tests for Rate Limit Buffer (PR #67).
 *
 * Tests message buffering under load, rate limit enforcement,
 * window recovery, conversation loop detection, and force delivery.
 * Uses fake timers for deterministic timing control.
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
// Tests — Rate Limit Buffering
// ---------------------------------------------------------------------------

describe("Rate Limit Buffer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockCapturePane.mockResolvedValue("❯ ");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("burst message buffering", () => {
    it("delivers first 10 messages within rate window", async () => {
      const queue = createQueue("terminal");

      for (let i = 0; i < 10; i++) {
        queue.enqueue("agent-1", "tmux-1", `Burst message ${i}`);
        await vi.advanceTimersByTimeAsync(100);
      }

      // All 10 should have triggered sendKeys
      expect(mockSendKeys.mock.calls.length).toBeGreaterThanOrEqual(10);
    });

    it("drops messages beyond rate limit (10/60s) with warning", async () => {
      const queue = createQueue("terminal");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Deliver 10 messages to hit the limit
      for (let i = 0; i < 10; i++) {
        queue.enqueue("agent-1", "tmux-1", `Msg ${i}`);
        await vi.advanceTimersByTimeAsync(100);
      }

      const callsAtLimit = mockSendKeys.mock.calls.length;

      // 11th-15th messages should be enqueued but dropped during delivery
      for (let i = 10; i < 15; i++) {
        queue.enqueue("agent-1", "tmux-1", `Msg ${i}`);
        await vi.advanceTimersByTimeAsync(100);
      }

      // sendKeys should NOT have increased by 5 more (rate limited)
      expect(mockSendKeys.mock.calls.length).toBeLessThan(callsAtLimit + 5);

      warnSpy.mockRestore();
    });

    it("rate limits are per-agent (agent-2 unaffected by agent-1 limit)", async () => {
      const queue = createQueue("terminal");

      // Hit rate limit for agent-1
      for (let i = 0; i < 10; i++) {
        queue.enqueue("agent-1", "tmux-1", `Msg ${i}`);
        await vi.advanceTimersByTimeAsync(100);
      }

      const callsBefore = mockSendKeys.mock.calls.length;

      // agent-2 should still be deliverable
      queue.enqueue("agent-2", "tmux-2", "Hello from agent-2");
      await vi.advanceTimersByTimeAsync(100);

      expect(mockSendKeys.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  describe("rate window recovery", () => {
    it("allows delivery again after 60-second window expires", async () => {
      const queue = createQueue("terminal");
      queue.start();

      // Hit rate limit
      for (let i = 0; i < 10; i++) {
        queue.enqueue("agent-1", "tmux-1", `Msg ${i}`);
        await vi.advanceTimersByTimeAsync(100);
      }

      // Advance past the 60-second rate window
      await vi.advanceTimersByTimeAsync(61000);

      const callsBefore = mockSendKeys.mock.calls.length;

      // New message should now be deliverable
      queue.enqueue("agent-1", "tmux-1", "After window reset");
      await vi.advanceTimersByTimeAsync(500);

      expect(mockSendKeys.mock.calls.length).toBeGreaterThan(callsBefore);

      queue.stop();
    });
  });

  describe("conversation loop detection", () => {
    it("allows up to 8 messages between same agent pair in 2 minutes", () => {
      const queue = createQueue();

      for (let i = 0; i < 8; i++) {
        const result = queue.enqueue("agent-b", "tmux-b", `Msg ${i}`, "agent-a");
        expect(result).toBe(true);
      }
    });

    it("drops 9th message between same pair (loop detected)", () => {
      const queue = createQueue();

      for (let i = 0; i < 8; i++) {
        queue.enqueue("agent-b", "tmux-b", `Msg ${i}`, "agent-a");
      }

      const result = queue.enqueue("agent-b", "tmux-b", "Msg 9 (dropped)", "agent-a");
      expect(result).toBe(false);
    });

    it("resets conversation counter after 2-minute window", async () => {
      const queue = createQueue();

      // Fill up the window
      for (let i = 0; i < 8; i++) {
        queue.enqueue("agent-b", "tmux-b", `Msg ${i}`, "agent-a");
      }

      // Should be blocked
      expect(queue.enqueue("agent-b", "tmux-b", "Blocked", "agent-a")).toBe(false);

      // Advance past 2-minute window
      await vi.advanceTimersByTimeAsync(121000);

      // Should be allowed again
      const result = queue.enqueue("agent-b", "tmux-b", "After reset", "agent-a");
      expect(result).toBe(true);
    });

    it("counts bidirectional messages (a->b and b->a share same counter)", () => {
      const queue = createQueue();

      // 4 from a->b
      for (let i = 0; i < 4; i++) {
        queue.enqueue("agent-b", "tmux-b", `Forward ${i}`, "agent-a");
      }
      // 4 from b->a
      for (let i = 0; i < 4; i++) {
        queue.enqueue("agent-a", "tmux-a", `Reply ${i}`, "agent-b");
      }

      // 9th in either direction should be blocked
      expect(queue.enqueue("agent-b", "tmux-b", "Too many", "agent-a")).toBe(false);
    });

    it("different agent pairs have independent counters", () => {
      const queue = createQueue();

      // Fill a<->b
      for (let i = 0; i < 8; i++) {
        queue.enqueue("agent-b", "tmux-b", `Msg ${i}`, "agent-a");
      }

      // a<->c should still work
      const result = queue.enqueue("agent-c", "tmux-c", "Hello c", "agent-a");
      expect(result).toBe(true);
    });
  });

  describe("force delivery timeout", () => {
    it("force-delivers after FORCE_DELIVERY_TIMEOUT_MS even if agent is busy", async () => {
      mockCapturePane.mockResolvedValue("Running long task...");
      const queue = createQueue("terminal");
      queue.start();

      queue.enqueue("agent-1", "tmux-1", "Urgent message");

      // Advance past 30-second force delivery timeout
      await vi.advanceTimersByTimeAsync(31000);

      expect(mockSendKeys).toHaveBeenCalled();
      queue.stop();
    });

    it("does not force-deliver before timeout", async () => {
      mockCapturePane.mockResolvedValue("Thinking deeply...");
      const queue = createQueue("terminal");
      queue.start();

      queue.enqueue("agent-1", "tmux-1", "Non-urgent message");

      // Only advance 10 seconds (well before 30s timeout)
      await vi.advanceTimersByTimeAsync(10000);

      // Message should still be queued, not force-delivered
      // (agent is "busy" and not at prompt)
      const deliveredToAgent = mockSendKeys.mock.calls.filter(
        (call: unknown[]) => typeof call[1] === "string" && call[1].includes("Non-urgent")
      );
      expect(deliveredToAgent.length).toBe(0);

      queue.stop();
    });
  });

  describe("notification instant delivery", () => {
    it("delivers notification messages instantly without readiness check", async () => {
      mockCapturePane.mockResolvedValue("Thinking...");
      const queue = createQueue("mcp");

      queue.enqueue("agent-1", "tmux-1", "[New message from Architect. Use check_messages tool to read it.]");
      await vi.advanceTimersByTimeAsync(100);

      // Notifications bypass readiness check — should be delivered even though agent is "busy"
      expect(mockSendKeys).toHaveBeenCalled();
    });

    it("delivers broadcast notifications instantly", async () => {
      mockCapturePane.mockResolvedValue("Running tests...");
      const queue = createQueue("mcp");

      queue.enqueue("agent-1", "tmux-1", "[Broadcast] All agents: stand by");
      await vi.advanceTimersByTimeAsync(100);

      expect(mockSendKeys).toHaveBeenCalled();
    });
  });

  describe("manual mode", () => {
    it("does not auto-deliver in manual mode", async () => {
      const queue = createQueue("manual");
      queue.enqueue("agent-1", "tmux-1", "Hello");
      await vi.advanceTimersByTimeAsync(1000);

      // Manual mode: deliver() is a no-op for "manual" messaging mode
      // sendKeys should not be called for actual message content
      // (only MCP or terminal modes deliver)
      const contentCalls = mockSendKeys.mock.calls.filter(
        (call: unknown[]) => typeof call[1] === "string" && call[1].includes("Hello")
      );
      expect(contentCalls.length).toBe(0);
    });
  });
});
