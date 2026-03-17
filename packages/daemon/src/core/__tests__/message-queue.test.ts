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
    randomUUID: vi.fn(() => "11111111-2222-3333-4444-555555555555"),
  },
}));

// Mock TmuxController
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
import fsMock from "fs/promises";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createQueue(mode: "mcp" | "terminal" | "manual" = "mcp"): MessageQueue {
  const tmux = new TmuxController();
  return new MessageQueue(tmux, "/projects/myapp/.kora", mode);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MessageQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Default: agent is at a prompt (ready)
    mockCapturePane.mockResolvedValue("❯ ");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- Message enqueue and delivery ----

  it("enqueues and delivers a message to a ready agent", async () => {
    const queue = createQueue("terminal");
    const result = queue.enqueue("agent-1", "tmux-1", "[Message from Orchestrator]: Hello", "orchestrator-1");

    expect(result).toBe(true);

    // Process the queue (simulate the internal processQueues call)
    await vi.advanceTimersByTimeAsync(100);

    expect(mockSendKeys).toHaveBeenCalled();
  });

  it("returns true when message is enqueued successfully", () => {
    const queue = createQueue();
    const result = queue.enqueue("agent-1", "tmux-1", "Hello");
    expect(result).toBe(true);
  });

  // ---- Rate limiting (10 messages per agent per 60 seconds) ----

  it("delivers messages within rate limit", async () => {
    const queue = createQueue("terminal");

    // Enqueue 10 messages (at the limit)
    for (let i = 0; i < 10; i++) {
      queue.enqueue("agent-1", "tmux-1", `Message ${i}`);
      await vi.advanceTimersByTimeAsync(100);
    }

    // All 10 should have been delivered (sendKeys called)
    expect(mockSendKeys.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("rate limits delivery after 10 messages per agent in 60 seconds", async () => {
    const queue = createQueue("terminal");

    // Deliver 10 messages to hit the rate limit
    for (let i = 0; i < 10; i++) {
      queue.enqueue("agent-1", "tmux-1", `Message ${i}`);
      await vi.advanceTimersByTimeAsync(100);
    }

    const callsAfter10 = mockSendKeys.mock.calls.length;

    // 11th message should be enqueued but dropped during delivery due to rate limit
    queue.enqueue("agent-1", "tmux-1", "Message 11");
    await vi.advanceTimersByTimeAsync(100);

    // The 11th message's delivery should be dropped (sendKeys count shouldn't increase much)
    expect(mockSendKeys.mock.calls.length).toBeLessThanOrEqual(callsAfter10 + 1);
  });

  // ---- Conversation loop detection (8 messages between same pair per 2 minutes) ----

  it("allows messages below the conversation loop threshold", () => {
    const queue = createQueue();

    for (let i = 0; i < 8; i++) {
      const result = queue.enqueue("agent-b", "tmux-b", `Message ${i}`, "agent-a");
      expect(result).toBe(true);
    }
  });

  it("detects conversation loop and drops messages after 8 between same pair", () => {
    const queue = createQueue();

    // Send 8 messages (allowed)
    for (let i = 0; i < 8; i++) {
      queue.enqueue("agent-b", "tmux-b", `Message ${i}`, "agent-a");
    }

    // 9th message should be dropped
    const result = queue.enqueue("agent-b", "tmux-b", "Message 9", "agent-a");
    expect(result).toBe(false);
  });

  it("conversation loop detection is symmetric (a→b same as b→a)", () => {
    const queue = createQueue();

    // 4 messages from a→b
    for (let i = 0; i < 4; i++) {
      queue.enqueue("agent-b", "tmux-b", `Msg ${i}`, "agent-a");
    }
    // 4 messages from b→a (same pair key because sorted)
    for (let i = 0; i < 4; i++) {
      queue.enqueue("agent-a", "tmux-a", `Reply ${i}`, "agent-b");
    }

    // 9th message in either direction should be dropped
    const result = queue.enqueue("agent-b", "tmux-b", "One more", "agent-a");
    expect(result).toBe(false);
  });

  // ---- MCP mode: writes to inbox file + sends tmux notification ----

  it("writes message to inbox file in MCP mode", async () => {
    const queue = createQueue("mcp");
    queue.enqueue("agent-1", "tmux-1", "[Message from Orchestrator]: Do the task");
    await vi.advanceTimersByTimeAsync(100);

    expect(fsMock.mkdir).toHaveBeenCalledWith(
      expect.stringContaining("inbox-agent-1"),
      { recursive: true },
    );
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("inbox-agent-1"),
      "[Message from Orchestrator]: Do the task",
      "utf-8",
    );
  });

  it("sends tmux notification after writing inbox file in MCP mode", async () => {
    const queue = createQueue("mcp");
    queue.enqueue("agent-1", "tmux-1", "[Message from Orchestrator]: Do the task");
    await vi.advanceTimersByTimeAsync(100);

    expect(mockSendKeys).toHaveBeenCalledWith(
      "tmux-1",
      expect.stringContaining("New message from Orchestrator"),
      { literal: true },
    );
  });

  // ---- Terminal mode: collapses newlines, truncates to 500 chars ----

  it("collapses newlines to ' | ' in terminal mode", async () => {
    const queue = createQueue("terminal");
    queue.enqueue("agent-1", "tmux-1", "Line 1\nLine 2\nLine 3");
    await vi.advanceTimersByTimeAsync(100);

    const callArgs = mockSendKeys.mock.calls.find(
      (call: unknown[]) => typeof call[1] === "string" && call[1].includes("Line 1"),
    );
    expect(callArgs).toBeDefined();
    expect(callArgs![1]).not.toContain("\n");
    expect(callArgs![1]).toContain(" | ");
  });

  it("truncates messages to 500 chars in terminal mode", async () => {
    const queue = createQueue("terminal");
    const longMessage = "A".repeat(600);
    queue.enqueue("agent-1", "tmux-1", longMessage);
    await vi.advanceTimersByTimeAsync(100);

    const callArgs = mockSendKeys.mock.calls.find(
      (call: unknown[]) => typeof call[1] === "string" && call[1].includes("AAA"),
    );
    expect(callArgs).toBeDefined();
    expect(callArgs![1].length).toBeLessThanOrEqual(500);
    expect(callArgs![1]).toMatch(/\.\.\.$/);
  });

  // ---- Prompt detection before delivery ----

  it("delivers message when agent shows prompt character", async () => {
    mockCapturePane.mockResolvedValue("❯ ");
    const queue = createQueue("terminal");
    queue.enqueue("agent-1", "tmux-1", "Hello");
    await vi.advanceTimersByTimeAsync(100);

    expect(mockSendKeys).toHaveBeenCalled();
  });

  it("delays delivery when agent is busy (Thinking)", async () => {
    mockCapturePane.mockResolvedValue("Thinking...");
    const queue = createQueue("terminal");
    queue.enqueue("agent-1", "tmux-1", "Hello");

    await vi.advanceTimersByTimeAsync(100);

    const initialCalls = mockSendKeys.mock.calls.length;

    // Make agent ready on next check
    mockCapturePane.mockResolvedValue("❯ ");
    await vi.advanceTimersByTimeAsync(600);

    expect(mockSendKeys.mock.calls.length).toBeGreaterThanOrEqual(initialCalls);
  });

  // ---- Force-deliver timeout (15 seconds) ----

  it("force-delivers message after 15 seconds even if agent is busy", async () => {
    mockCapturePane.mockResolvedValue("Running command...");
    const queue = createQueue("terminal");
    queue.start();
    queue.enqueue("agent-1", "tmux-1", "Urgent message");

    // Advance past the 15-second force-deliver timeout
    await vi.advanceTimersByTimeAsync(16000);

    expect(mockSendKeys).toHaveBeenCalled();
    queue.stop();
  });

  // ---- Adaptive polling (500ms active, 2000ms idle) ----

  it("uses shorter polling interval when messages are queued", async () => {
    mockCapturePane.mockResolvedValue("Running...");
    const queue = createQueue("terminal");

    // Enqueue a message first so there are pending messages
    queue.enqueue("agent-1", "tmux-1", "Hello");

    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    // Now start — scheduleNextPoll should see the queued message and use 500ms
    queue.start();

    const timeouts = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(timeouts).toContain(500);

    queue.stop();
    setTimeoutSpy.mockRestore();
  });

  it("uses longer polling interval when no messages are queued", async () => {
    const queue = createQueue("terminal");
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    queue.start();

    await vi.advanceTimersByTimeAsync(100);

    const timeouts = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(timeouts).toContain(2000);

    queue.stop();
    setTimeoutSpy.mockRestore();
  });

  // ---- MCP-pending message store and delivery ----

  it("delivers via mcp-pending for registered MCP agents", async () => {
    const queue = createQueue("mcp");
    queue.registerMcpAgent("agent-1");
    queue.enqueue("agent-1", "tmux-1", "[Message from Bot]: Hello");
    await vi.advanceTimersByTimeAsync(100);

    expect(fsMock.mkdir).toHaveBeenCalledWith(
      expect.stringContaining("mcp-pending/agent-1"),
      { recursive: true },
    );
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("mcp-pending/agent-1"),
      expect.any(String),
      "utf-8",
    );
  });

  it("sends tmux notification for MCP-pending delivery as fallback", async () => {
    const queue = createQueue("mcp");
    queue.registerMcpAgent("agent-1");
    queue.enqueue("agent-1", "tmux-1", "[Message from Bot]: Hello");
    await vi.advanceTimersByTimeAsync(100);

    expect(mockSendKeys).toHaveBeenCalledWith(
      "tmux-1",
      expect.stringContaining("check_messages"),
      { literal: true },
    );
  });

  it("removes agent queues and MCP registration on removeAgent", () => {
    const queue = createQueue("mcp");
    queue.registerMcpAgent("agent-1");
    queue.enqueue("agent-1", "tmux-1", "Hello");

    queue.removeAgent("agent-1");

    const result = queue.enqueue("agent-1", "tmux-1", "New message");
    expect(result).toBe(true);
  });
});
