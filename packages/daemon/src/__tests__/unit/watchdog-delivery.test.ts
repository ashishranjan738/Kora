/**
 * Tests for WatchdogDeliveryManager — delivery modes, queueing, batching.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WatchdogDeliveryManager, DEFAULT_WATCHDOG_DELIVERY_CONFIG } from "../../core/watchdog-delivery";

// Mock MessageBus
function createMockBus() {
  const delivered: Array<{ agentId: string; content: string }> = [];
  return {
    deliverToInbox: vi.fn(async (agentId: string, msg: { content: string }) => {
      delivered.push({ agentId, content: msg.content });
    }),
    delivered,
  };
}

describe("WatchdogDeliveryManager", () => {
  let bus: ReturnType<typeof createMockBus>;
  let mgr: WatchdogDeliveryManager;

  beforeEach(() => {
    bus = createMockBus();
    mgr = new WatchdogDeliveryManager(bus as any, "mcp");
  });

  describe("immediate mode", () => {
    it("delivers immediately regardless of agent activity", async () => {
      mgr.updateConfig({ mode: "immediate" });
      mgr.onAgentBusy("agent-1"); // agent is working
      await mgr.deliver("agent-1", "staleTask", "inProgress", "Task stale!");
      expect(bus.delivered).toHaveLength(1);
      expect(bus.delivered[0].content).toBe("Task stale!");
    });
  });

  describe("idle-only mode", () => {
    it("queues when agent is busy", async () => {
      mgr.updateConfig({ mode: "idle-only" });
      mgr.onAgentBusy("agent-1");
      await mgr.deliver("agent-1", "contextRefresh", "teamChange", "Team updated");
      expect(bus.delivered).toHaveLength(0);
      expect(mgr.getPendingCount("agent-1")).toBe(1);
    });

    it("flushes queue when agent goes idle", async () => {
      mgr.updateConfig({ mode: "idle-only" });
      mgr.onAgentBusy("agent-1");
      await mgr.deliver("agent-1", "contextRefresh", "teamChange", "Team updated");
      await mgr.deliver("agent-1", "contextRefresh", "knowledgeUpdate", "Knowledge saved");
      expect(bus.delivered).toHaveLength(0);

      await mgr.onAgentIdle("agent-1");
      expect(bus.delivered).toHaveLength(1); // batched into one message
      expect(bus.delivered[0].content).toContain("2 updates occurred");
      expect(bus.delivered[0].content).toContain("Team updated");
      expect(bus.delivered[0].content).toContain("Knowledge saved");
      expect(mgr.getPendingCount("agent-1")).toBe(0);
    });

    it("delivers immediately if agent is already idle", async () => {
      mgr.updateConfig({ mode: "idle-only" });
      mgr.onAgentBusy("agent-1");
      await mgr.onAgentIdle("agent-1"); // agent goes idle
      await mgr.deliver("agent-1", "contextRefresh", "teamChange", "Team updated");
      expect(bus.delivered).toHaveLength(1);
      expect(bus.delivered[0].content).toBe("Team updated");
    });

    it("single queued notification delivered without batching header", async () => {
      mgr.updateConfig({ mode: "idle-only" });
      mgr.onAgentBusy("agent-1");
      await mgr.deliver("agent-1", "contextRefresh", "teamChange", "Team updated");
      await mgr.onAgentIdle("agent-1");
      expect(bus.delivered).toHaveLength(1);
      expect(bus.delivered[0].content).toBe("Team updated"); // no "X updates occurred" wrapper
    });
  });

  describe("custom mode (default config)", () => {
    it("staleTask defaults to immediate", async () => {
      mgr.onAgentBusy("agent-1");
      await mgr.deliver("agent-1", "staleTask", "inProgress", "Task stale!");
      expect(bus.delivered).toHaveLength(1);
    });

    it("contextRefresh teamChange defaults to idle-only", async () => {
      mgr.onAgentBusy("agent-1");
      await mgr.deliver("agent-1", "contextRefresh", "teamChange", "Team changed");
      expect(bus.delivered).toHaveLength(0);
      expect(mgr.getPendingCount("agent-1")).toBe(1);
    });

    it("contextRefresh taskAssignment defaults to immediate", async () => {
      mgr.onAgentBusy("agent-1");
      await mgr.deliver("agent-1", "contextRefresh", "taskAssignment", "New task!");
      expect(bus.delivered).toHaveLength(1);
    });

    it("contextRefresh personaUpdate defaults to immediate", async () => {
      mgr.onAgentBusy("agent-1");
      await mgr.deliver("agent-1", "contextRefresh", "personaUpdate", "Persona updated");
      expect(bus.delivered).toHaveLength(1);
    });
  });

  describe("getMode", () => {
    it("returns global mode for non-custom", () => {
      mgr.updateConfig({ mode: "immediate" });
      expect(mgr.getMode("staleTask")).toBe("immediate");
      expect(mgr.getMode("contextRefresh", "teamChange")).toBe("immediate");
    });

    it("returns per-watchdog override in custom mode", () => {
      expect(mgr.getMode("staleTask")).toBe("immediate");
      expect(mgr.getMode("contextRefresh")).toBe("idle-only");
    });

    it("returns per-event override in custom mode", () => {
      expect(mgr.getMode("contextRefresh", "taskAssignment")).toBe("immediate");
      expect(mgr.getMode("contextRefresh", "teamChange")).toBe("idle-only");
    });

    it("defaults to immediate for unknown watchdog", () => {
      expect(mgr.getMode("unknownWatchdog")).toBe("immediate");
    });
  });

  describe("removeAgent", () => {
    it("clears pending queue and activity state", async () => {
      mgr.updateConfig({ mode: "idle-only" });
      mgr.onAgentBusy("agent-1");
      await mgr.deliver("agent-1", "contextRefresh", "teamChange", "msg");
      expect(mgr.getPendingCount("agent-1")).toBe(1);

      mgr.removeAgent("agent-1");
      expect(mgr.getPendingCount("agent-1")).toBe(0);
    });
  });

  describe("batching format", () => {
    it("MCP mode batch includes get_context instruction", async () => {
      mgr.updateConfig({ mode: "idle-only" });
      mgr.onAgentBusy("agent-1");
      await mgr.deliver("agent-1", "a", "b", "msg1");
      await mgr.deliver("agent-1", "c", "d", "msg2");
      await mgr.onAgentIdle("agent-1");
      expect(bus.delivered[0].content).toContain('get_context("all")');
    });

    it("CLI mode batch includes kora-cli instruction", async () => {
      const cliBus = createMockBus();
      const cliMgr = new WatchdogDeliveryManager(cliBus as any, "cli");
      cliMgr.updateConfig({ mode: "idle-only" });
      cliMgr.onAgentBusy("agent-1");
      await cliMgr.deliver("agent-1", "a", "b", "msg1");
      await cliMgr.deliver("agent-1", "c", "d", "msg2");
      await cliMgr.onAgentIdle("agent-1");
      expect(cliBus.delivered[0].content).toContain("kora-cli context all");
    });
  });

  describe("DEFAULT_WATCHDOG_DELIVERY_CONFIG", () => {
    it("uses custom mode with staleTask immediate and contextRefresh idle-only", () => {
      expect(DEFAULT_WATCHDOG_DELIVERY_CONFIG.mode).toBe("custom");
      expect(DEFAULT_WATCHDOG_DELIVERY_CONFIG.overrides?.staleTask?.mode).toBe("immediate");
      expect(DEFAULT_WATCHDOG_DELIVERY_CONFIG.overrides?.contextRefresh?.mode).toBe("idle-only");
    });
  });
});
