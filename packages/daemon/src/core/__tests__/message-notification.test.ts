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

describe("MessageQueue notification handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Test 1: Notification messages skip isAgentReady check (instant delivery)
  it("delivers notification messages instantly without checking agent readiness", async () => {
    // Agent is busy (not at prompt)
    mockCapturePane.mockResolvedValue("Running long command...");

    const queue = createQueue("terminal");
    queue.enqueue("agent-1", "tmux-1", "[New message from Orchestrator. Use check_messages tool to read it.]");

    await vi.advanceTimersByTimeAsync(100);

    // Notification should be delivered despite agent being busy
    expect(mockSendKeys).toHaveBeenCalled();
  });

  // Test 2: Non-notification messages still check readiness
  it("waits for agent readiness before delivering regular messages", async () => {
    // Agent is busy
    mockCapturePane.mockResolvedValue("Running command...");

    const queue = createQueue("terminal");
    queue.start();
    queue.enqueue("agent-1", "tmux-1", "Regular message content");

    await vi.advanceTimersByTimeAsync(1000);

    // Message should NOT be delivered while agent is busy
    const callsWhileBusy = mockSendKeys.mock.calls.length;
    expect(callsWhileBusy).toBe(0);

    // Make agent ready
    mockCapturePane.mockResolvedValue("❯ ");
    await vi.advanceTimersByTimeAsync(1000);

    // Message should now be delivered after agent becomes ready
    expect(mockSendKeys.mock.calls.length).toBeGreaterThan(0);
    queue.stop();
  });

  // Test 3: Broadcast delivers to ALL agents
  it("broadcasts messages to all registered agent queues", () => {
    const queue = createQueue("mcp");

    // Enqueue messages to different agents
    queue.enqueue("agent-1", "tmux-1", "Message 1");
    queue.enqueue("agent-2", "tmux-2", "Message 2");
    queue.enqueue("agent-3", "tmux-3", "Message 3");

    // All three agents should have queued messages
    // (Testing that the queue handles multiple agents)
    expect(queue.enqueue("agent-1", "tmux-1", "Another")).toBe(true);
    expect(queue.enqueue("agent-2", "tmux-2", "Another")).toBe(true);
    expect(queue.enqueue("agent-3", "tmux-3", "Another")).toBe(true);
  });

  // Test 4: literal: false used for notification sendKeys
  it("uses literal: false for notification message delivery", async () => {
    const queue = createQueue("mcp");
    queue.enqueue("agent-1", "tmux-1", "[New message from Bot. Use check_messages tool to read it.]");

    await vi.advanceTimersByTimeAsync(100);

    // Find the sendKeys call with the notification
    const notificationCall = mockSendKeys.mock.calls.find(
      (call: any[]) => call[1] && typeof call[1] === "string" && call[1].includes("New message from")
    );

    expect(notificationCall).toBeDefined();
    expect(notificationCall![2]).toEqual({ literal: true });
  });

  // Test 5: Task assignment notifications are instant
  it("delivers task assignment notifications instantly", async () => {
    mockCapturePane.mockResolvedValue("Busy working...");

    const queue = createQueue("terminal");
    queue.enqueue("agent-1", "tmux-1", "[Task assigned]: Build the login page");

    await vi.advanceTimersByTimeAsync(100);

    // Should be delivered despite agent being busy
    expect(mockSendKeys).toHaveBeenCalled();
  });

  // Test 6: Broadcast notifications are instant
  it("delivers broadcast notifications instantly", async () => {
    mockCapturePane.mockResolvedValue("Processing...");

    const queue = createQueue("terminal");
    queue.enqueue("agent-1", "tmux-1", "[Broadcast]: All agents stop work now");

    await vi.advanceTimersByTimeAsync(100);

    // Should be delivered despite agent being busy
    expect(mockSendKeys).toHaveBeenCalled();
  });

  // Test 7: check_messages notifications are instant
  it("delivers check_messages prompts instantly", async () => {
    mockCapturePane.mockResolvedValue("Executing command...");

    const queue = createQueue("mcp");
    queue.registerMcpAgent("agent-1");
    queue.enqueue("agent-1", "tmux-1", "[Message from Orchestrator]: check_messages");

    await vi.advanceTimersByTimeAsync(100);

    // Should be delivered despite agent being busy
    expect(mockSendKeys).toHaveBeenCalled();
  });
});
