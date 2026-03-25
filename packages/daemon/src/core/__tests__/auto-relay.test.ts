/**
 * Unit tests for AutoRelay — @mention detection and message delivery.
 *
 * Tests: mention parsing, @all broadcast, rate limiting, dedup,
 * message queue integration, skip patterns, and cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AutoRelay } from "../auto-relay.js";
import type { IPtyBackend } from "../pty-backend.js";
import type { AgentState } from "@kora/shared";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockPty(): IPtyBackend {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
    killSession: vi.fn().mockResolvedValue(undefined),
    newSession: vi.fn().mockResolvedValue(undefined),
    hasSession: vi.fn().mockResolvedValue(true),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    sendRawInput: vi.fn().mockResolvedValue(undefined),
    capturePane: vi.fn().mockResolvedValue(""),
    setEnvironment: vi.fn().mockResolvedValue(undefined),
    pipePaneStart: vi.fn().mockResolvedValue(undefined),
    pipePaneStop: vi.fn().mockResolvedValue(undefined),
    getPanePID: vi.fn().mockResolvedValue(null),
    run_raw: vi.fn().mockResolvedValue(""),
    getAttachCommand: vi.fn().mockReturnValue({ command: "holdpty", args: ["attach", "x"] }),
  };
}

function createAgent(id: string, name: string): AgentState {
  return {
    id,
    status: "running",
    config: {
      name,
      sessionId: "test-session",
      role: "worker",
      cliProvider: "claude-code",
      model: "default",
      permissions: { canSpawnAgents: false, canStopAgents: false, canAccessTerminal: true, canEditFiles: true, maxSubAgents: 0 },
      persona: "",
      terminalSession: `kora-dev--test-${id}`,
      worktreeDir: "/tmp",
      extraCliArgs: [],
    },
    healthCheck: { alive: true, lastCheck: Date.now(), consecutiveFailures: 0 },
    spawnedAt: new Date().toISOString(),
    cost: { inputTokens: 0, outputTokens: 0, totalCostUsd: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  } as AgentState;
}

const mockAgentManager = {
  listAgents: vi.fn().mockReturnValue([]),
} as any;

const mockEventLog = {
  log: vi.fn().mockResolvedValue(undefined),
} as any;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AutoRelay", () => {
  let pty: IPtyBackend;
  let relay: AutoRelay;
  const agentA = createAgent("agent-a", "Architect");
  const agentB = createAgent("agent-b", "Frontend");
  const agentC = createAgent("agent-c", "Backend");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    pty = createMockPty();
    mockAgentManager.listAgents.mockReturnValue([agentA, agentB, agentC]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("mode filtering", () => {
    it("does not start monitoring in MCP mode", () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "mcp");
      relay.startMonitoring(agentA);

      vi.advanceTimersByTime(5000);
      expect(pty.capturePane).not.toHaveBeenCalled();
    });

    it("does not start monitoring in manual mode", () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "manual");
      relay.startMonitoring(agentA);

      vi.advanceTimersByTime(5000);
      expect(pty.capturePane).not.toHaveBeenCalled();
    });

    it("starts monitoring in terminal mode", () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "terminal");
      relay.startMonitoring(agentA);

      vi.advanceTimersByTime(3500);
      expect(pty.capturePane).toHaveBeenCalled();
      relay.stopAll();
    });

    it("starts monitoring when no mode is set", () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session");
      relay.startMonitoring(agentA);

      vi.advanceTimersByTime(3500);
      expect(pty.capturePane).toHaveBeenCalled();
      relay.stopAll();
    });
  });

  describe("@mention detection", () => {
    it("detects @AgentName: message pattern and delivers", async () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "terminal");

      // First poll: empty
      (pty.capturePane as any).mockResolvedValueOnce("");
      relay.startMonitoring(agentA);
      await vi.advanceTimersByTimeAsync(3000);

      // Second poll: new @mention line
      (pty.capturePane as any).mockResolvedValueOnce("@Frontend: please implement the login page");
      await vi.advanceTimersByTimeAsync(3000);

      // Should have sent to Frontend agent
      expect(pty.sendKeys).toHaveBeenCalledWith(
        agentB.config.terminalSession,
        expect.stringContaining("please implement the login page"),
        { literal: true },
      );

      relay.stopAll();
    });

    it("detects @all: message and broadcasts to all other agents", async () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "terminal");

      (pty.capturePane as any).mockResolvedValueOnce("");
      relay.startMonitoring(agentA);
      await vi.advanceTimersByTimeAsync(3000);

      (pty.capturePane as any).mockResolvedValueOnce("@all: status update — done with API");
      await vi.advanceTimersByTimeAsync(3000);

      // Should send to both Frontend and Backend (not self)
      // Each delivery = 2 sendKeys calls (literal text + Enter for Kiro compat)
      expect(pty.sendKeys).toHaveBeenCalledTimes(4);
      expect(pty.sendKeys).toHaveBeenCalledWith(
        agentB.config.terminalSession,
        expect.stringContaining("status update"),
        { literal: true },
      );
      expect(pty.sendKeys).toHaveBeenCalledWith(
        agentC.config.terminalSession,
        expect.stringContaining("status update"),
        { literal: true },
      );

      relay.stopAll();
    });

    it("matches agent name case-insensitively", async () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "terminal");

      (pty.capturePane as any).mockResolvedValueOnce("");
      relay.startMonitoring(agentA);
      await vi.advanceTimersByTimeAsync(3000);

      (pty.capturePane as any).mockResolvedValueOnce("@frontend: please help");
      await vi.advanceTimersByTimeAsync(3000);

      expect(pty.sendKeys).toHaveBeenCalledWith(
        agentB.config.terminalSession,
        expect.stringContaining("please help"),
        { literal: true },
      );

      relay.stopAll();
    });
  });

  describe("skip patterns", () => {
    it("ignores lines starting with [Message from", async () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "terminal");

      (pty.capturePane as any).mockResolvedValueOnce("");
      relay.startMonitoring(agentA);
      await vi.advanceTimersByTimeAsync(3000);

      (pty.capturePane as any).mockResolvedValueOnce("[Message from Frontend]: @Backend: test");
      await vi.advanceTimersByTimeAsync(3000);

      expect(pty.sendKeys).not.toHaveBeenCalled();
      relay.stopAll();
    });

    it("ignores lines starting with [System]", async () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "terminal");

      (pty.capturePane as any).mockResolvedValueOnce("");
      relay.startMonitoring(agentA);
      await vi.advanceTimersByTimeAsync(3000);

      (pty.capturePane as any).mockResolvedValueOnce("[System] @Frontend: message");
      await vi.advanceTimersByTimeAsync(3000);

      expect(pty.sendKeys).not.toHaveBeenCalled();
      relay.stopAll();
    });

    it("ignores empty messages after @mention", async () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "terminal");

      (pty.capturePane as any).mockResolvedValueOnce("");
      relay.startMonitoring(agentA);
      await vi.advanceTimersByTimeAsync(3000);

      // No actual message after the colon
      (pty.capturePane as any).mockResolvedValueOnce("@Frontend: ");
      await vi.advanceTimersByTimeAsync(3000);

      expect(pty.sendKeys).not.toHaveBeenCalled();
      relay.stopAll();
    });

    it("ignores lines with no @mention", async () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "terminal");

      (pty.capturePane as any).mockResolvedValueOnce("");
      relay.startMonitoring(agentA);
      await vi.advanceTimersByTimeAsync(3000);

      (pty.capturePane as any).mockResolvedValueOnce("just a regular line of output");
      await vi.advanceTimersByTimeAsync(3000);

      expect(pty.sendKeys).not.toHaveBeenCalled();
      relay.stopAll();
    });
  });

  describe("deduplication", () => {
    it("does not deliver the same message twice", async () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "terminal");

      (pty.capturePane as any).mockResolvedValueOnce("");
      relay.startMonitoring(agentA);
      await vi.advanceTimersByTimeAsync(3000);

      const mention = "@Frontend: do the thing";
      (pty.capturePane as any).mockResolvedValueOnce(mention);
      await vi.advanceTimersByTimeAsync(3000);

      // Same output again
      (pty.capturePane as any).mockResolvedValueOnce(mention);
      await vi.advanceTimersByTimeAsync(3000);

      // Should only deliver once (2 sendKeys calls: literal text + Enter)
      expect(pty.sendKeys).toHaveBeenCalledTimes(2);
      relay.stopAll();
    });
  });

  describe("rate limiting", () => {
    it("limits relay to 3 messages per 60s per agent", async () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "terminal");

      (pty.capturePane as any).mockResolvedValueOnce("");
      relay.startMonitoring(agentA);
      await vi.advanceTimersByTimeAsync(3000);

      // Send 4 unique mentions
      for (let i = 1; i <= 4; i++) {
        (pty.capturePane as any).mockResolvedValueOnce(`@Frontend: message ${i}`);
        await vi.advanceTimersByTimeAsync(3000);
      }

      // Only 3 should have been delivered (each = 2 sendKeys: text + Enter)
      expect(pty.sendKeys).toHaveBeenCalledTimes(6);
      relay.stopAll();
    });

    it("resets rate limit after 60 seconds", async () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "terminal");

      (pty.capturePane as any).mockResolvedValueOnce("");
      relay.startMonitoring(agentA);
      await vi.advanceTimersByTimeAsync(3000);

      // Send 3 mentions (hits limit)
      for (let i = 1; i <= 3; i++) {
        (pty.capturePane as any).mockResolvedValueOnce(`@Frontend: msg ${i}`);
        await vi.advanceTimersByTimeAsync(3000);
      }
      // 3 deliveries × 2 sendKeys each (text + Enter)
      expect(pty.sendKeys).toHaveBeenCalledTimes(6);

      // Advance past the 60s window
      vi.advanceTimersByTime(61000);

      // 4th message should now work
      (pty.capturePane as any).mockResolvedValueOnce("@Frontend: msg after reset");
      await vi.advanceTimersByTimeAsync(3000);

      // 4 deliveries × 2 sendKeys each
      expect(pty.sendKeys).toHaveBeenCalledTimes(8);
      relay.stopAll();
    });
  });

  describe("message queue integration", () => {
    it("uses message queue for delivery when available", async () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "terminal");

      const mockQueue = { enqueue: vi.fn() } as any;
      relay.setMessageQueue(mockQueue);

      (pty.capturePane as any).mockResolvedValueOnce("");
      relay.startMonitoring(agentA);
      await vi.advanceTimersByTimeAsync(3000);

      (pty.capturePane as any).mockResolvedValueOnce("@Frontend: use the queue");
      await vi.advanceTimersByTimeAsync(3000);

      // Should use queue instead of direct sendKeys
      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        agentB.id,
        agentB.config.terminalSession,
        expect.stringContaining("use the queue"),
        agentA.id,
      );
      expect(pty.sendKeys).not.toHaveBeenCalled();

      relay.stopAll();
    });

    it("falls back to sendKeys when no queue set", async () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "terminal");

      (pty.capturePane as any).mockResolvedValueOnce("");
      relay.startMonitoring(agentA);
      await vi.advanceTimersByTimeAsync(3000);

      (pty.capturePane as any).mockResolvedValueOnce("@Frontend: direct send");
      await vi.advanceTimersByTimeAsync(3000);

      expect(pty.sendKeys).toHaveBeenCalled();
      relay.stopAll();
    });
  });

  describe("event logging", () => {
    it("logs message-sent events for relayed messages", async () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "terminal");

      (pty.capturePane as any).mockResolvedValueOnce("");
      relay.startMonitoring(agentA);
      await vi.advanceTimersByTimeAsync(3000);

      (pty.capturePane as any).mockResolvedValueOnce("@Frontend: log this please");
      await vi.advanceTimersByTimeAsync(3000);

      expect(mockEventLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "test-session",
          type: "message-sent",
          data: expect.objectContaining({
            from: agentA.id,
            fromName: "Architect",
            to: agentB.id,
            toName: "Frontend",
            autoRelayed: true,
          }),
        }),
      );

      relay.stopAll();
    });
  });

  describe("stop monitoring", () => {
    it("stops polling for a specific agent", async () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "terminal");
      relay.startMonitoring(agentA);

      await vi.advanceTimersByTimeAsync(3000);
      expect(pty.capturePane).toHaveBeenCalledTimes(1);

      relay.stopMonitoring(agentA.id);

      await vi.advanceTimersByTimeAsync(6000);
      // Should not have been called again
      expect(pty.capturePane).toHaveBeenCalledTimes(1);
    });

    it("stopAll stops all monitoring", () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "terminal");
      relay.startMonitoring(agentA);
      relay.startMonitoring(agentB);

      relay.stopAll();

      vi.advanceTimersByTime(10000);
      expect(pty.capturePane).not.toHaveBeenCalled();
    });
  });

  describe("relay message format", () => {
    it("includes sender name with ANSI color codes", async () => {
      relay = new AutoRelay(pty, mockAgentManager, mockEventLog, "test-session", "terminal");

      (pty.capturePane as any).mockResolvedValueOnce("");
      relay.startMonitoring(agentA);
      await vi.advanceTimersByTimeAsync(3000);

      (pty.capturePane as any).mockResolvedValueOnce("@Frontend: hello there");
      await vi.advanceTimersByTimeAsync(3000);

      expect(pty.sendKeys).toHaveBeenCalledWith(
        agentB.config.terminalSession,
        expect.stringContaining("[Message from Architect]"),
        { literal: true },
      );

      relay.stopAll();
    });
  });
});
