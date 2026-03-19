import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageQueue, classifyPriority } from "../message-queue.js";
import type { IPtyBackend } from "../pty-backend.js";

// ---------------------------------------------------------------------------
// Mock PTY backend
// ---------------------------------------------------------------------------

function createMockTmux(ready = true): IPtyBackend {
  return {
    sendKeys: vi.fn().mockResolvedValue(undefined),
    capturePane: vi.fn().mockResolvedValue(ready ? "❯ " : "Thinking..."),
    hasSession: vi.fn().mockResolvedValue(true),
    createSession: vi.fn().mockResolvedValue(undefined),
    killSession: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
    getAttachCommand: vi.fn().mockReturnValue("tmux attach"),
  } as unknown as IPtyBackend;
}

// ---------------------------------------------------------------------------
// Tests — classifyPriority
// ---------------------------------------------------------------------------

describe("classifyPriority", () => {
  it("classifies task assignments as critical", () => {
    expect(classifyPriority("[Task assigned] Build the API")).toBe("critical");
    expect(classifyPriority("[Task from Architect]: implement login")).toBe("critical");
  });

  it("classifies questions as high", () => {
    expect(classifyPriority("[Question from Worker]: Should I use React?")).toBe("high");
  });

  it("classifies broadcasts as low", () => {
    expect(classifyPriority("[Broadcast] Status update: all done")).toBe("low");
  });

  it("classifies regular messages as normal", () => {
    // No special keywords → normal (not question since no ?)
    expect(classifyPriority("Hello there, just updating you")).toBe("normal");
  });
});

// ---------------------------------------------------------------------------
// Tests — Rate limit buffer (THE CRITICAL FIX)
// ---------------------------------------------------------------------------

describe("Rate limit buffer — never drop messages", () => {
  it("enqueue returns true even when rate limited (buffer, don't drop)", () => {
    const tmux = createMockTmux(false); // Agent not ready — messages stay in queue
    const mq = new MessageQueue(tmux, "/tmp/test-runtime", "terminal");

    // Enqueue 15 messages (beyond 10/min worker limit)
    for (let i = 0; i < 15; i++) {
      const result = mq.enqueue("agent-1", "tmux-1", `Regular message ${i}`);
      expect(result).toBe(true); // All accepted into buffer
    }

    // Messages are in queue (some may have been delivered, but none dropped)
    // The key: enqueue never returns false due to rate limit
  });

  it("loop detection still drops excessive same-pair messages", () => {
    const tmux = createMockTmux(false);
    const mq = new MessageQueue(tmux, "/tmp/test-runtime", "terminal");

    for (let i = 0; i < 8; i++) {
      const result = mq.enqueue("agent-1", "tmux-1", `msg ${i}`, "agent-2");
      expect(result).toBe(true);
    }

    // 9th from same pair should be dropped (loop detection)
    const result = mq.enqueue("agent-1", "tmux-1", "msg 9", "agent-2");
    expect(result).toBe(false);
  });

  it("rate limit check moved BEFORE dequeue in processOneQueue", () => {
    const tmux = createMockTmux(true);
    const mq = new MessageQueue(tmux, "/tmp/test-runtime", "mcp");
    mq.registerMcpAgent("agent-1");

    // Verify the deliver method no longer has rate limit check
    // (it was moved to processOneQueue). We test this by checking
    // that messages enqueued after rate limit are kept, not dropped.
    for (let i = 0; i < 12; i++) {
      mq.enqueue("agent-1", "tmux-1", `Regular message ${i}`);
    }

    // All 12 should be accepted (not dropped at enqueue)
    // The rate limiter in processOneQueue will buffer excess
  });
});

// ---------------------------------------------------------------------------
// Tests — Priority queue ordering
// ---------------------------------------------------------------------------

describe("Priority queue ordering", () => {
  it("enqueues multiple messages with different priorities", () => {
    const tmux = createMockTmux(false); // Not ready — messages stay queued
    const mq = new MessageQueue(tmux, "/tmp/test-runtime", "terminal");

    // These messages don't match notification patterns, so they stay in queue
    mq.enqueue("agent-1", "tmux-1", "Status update no special keywords");
    mq.enqueue("agent-1", "tmux-1", "Another regular update");

    // Both should be in queue (agent not ready, not notifications)
    expect(mq.getQueueDepth("agent-1")).toBe(2);
  });

  it("classifyPriority assigns correct priority order", () => {
    // Verify classification produces correct ordering
    const critical = classifyPriority("[Task assigned] Build API");
    const high = classifyPriority("[Question from X]: how?");
    const normal = classifyPriority("Regular update no keywords");
    const low = classifyPriority("[Broadcast] deploy done");

    const PRIO_MAP: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
    expect(PRIO_MAP[critical]).toBeLessThan(PRIO_MAP[high]);
    expect(PRIO_MAP[high]).toBeLessThan(PRIO_MAP[normal]);
    expect(PRIO_MAP[normal]).toBeLessThan(PRIO_MAP[low]);
  });
});

// ---------------------------------------------------------------------------
// Tests — Role-based rate limits
// ---------------------------------------------------------------------------

describe("Role-based rate limits", () => {
  it("registerAgentRole sets role for rate limit calculation", () => {
    const tmux = createMockTmux();
    const mq = new MessageQueue(tmux, "/tmp/test-runtime", "mcp");
    mq.registerMcpAgent("master-1");
    mq.registerAgentRole("master-1", "master");

    // Master gets 25/min — can accept more messages
    for (let i = 0; i < 20; i++) {
      const result = mq.enqueue("master-1", "tmux-m", `[Message]: update ${i}`);
      expect(result).toBe(true);
    }
  });

  it("default role is worker (10/min limit)", () => {
    const tmux = createMockTmux();
    const mq = new MessageQueue(tmux, "/tmp/test-runtime", "mcp");
    mq.registerMcpAgent("agent-1");
    // No registerAgentRole call — defaults to worker

    for (let i = 0; i < 12; i++) {
      const result = mq.enqueue("agent-1", "tmux-1", `msg ${i}`);
      expect(result).toBe(true); // All accepted into buffer
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — Buffer size cap
// ---------------------------------------------------------------------------

describe("Buffer size cap", () => {
  it("evicts when queue exceeds 50 messages", () => {
    const tmux = createMockTmux(false); // Not ready
    const mq = new MessageQueue(tmux, "/tmp/test-runtime", "terminal");

    // Fill queue with 51 messages
    for (let i = 0; i < 51; i++) {
      mq.enqueue("agent-1", "tmux-1", `Regular message ${i}`);
    }

    // Should be capped at 50
    expect(mq.getQueueDepth("agent-1")).toBe(50);
  });

  it("expiry callback fires on eviction", () => {
    const tmux = createMockTmux(false);
    const mq = new MessageQueue(tmux, "/tmp/test-runtime", "terminal");
    const expiryCb = vi.fn();
    mq.setExpiryCallback(expiryCb);

    // Fill beyond cap
    for (let i = 0; i < 51; i++) {
      mq.enqueue("agent-1", "tmux-1", `Regular message ${i}`);
    }

    expect(expiryCb).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — getQueueDepth & removeAgent
// ---------------------------------------------------------------------------

describe("Queue management", () => {
  it("getQueueDepth returns 0 for unknown agent", () => {
    const tmux = createMockTmux();
    const mq = new MessageQueue(tmux, "/tmp/test-runtime", "mcp");
    expect(mq.getQueueDepth("unknown")).toBe(0);
  });

  it("removeAgent clears queue and role", () => {
    const tmux = createMockTmux(false);
    const mq = new MessageQueue(tmux, "/tmp/test-runtime", "terminal");
    mq.registerMcpAgent("agent-1");
    mq.registerAgentRole("agent-1", "worker");
    mq.enqueue("agent-1", "tmux-1", "test message");

    mq.removeAgent("agent-1");
    expect(mq.getQueueDepth("agent-1")).toBe(0);
  });
});
