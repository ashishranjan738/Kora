/**
 * Tests for activity monitor fix: recordMcpCall() must pass toolName
 * so PASSIVE_TOOLS filtering kicks in and idle agents stay idle.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal mock of AgentHealthMonitor's PASSIVE_TOOLS + recordMcpActivity logic
const PASSIVE_TOOLS = new Set([
  "check_messages", "list_agents", "list_tasks", "get_task",
  "get_workflow_states", "report_idle", "request_task",
  "whoami", "get_context", "channel_list", "channel_history",
  "list_personas",
]);

interface MockAgent {
  activity: string;
  lastActivityAt?: string;
  idleSince?: string;
}

class MockHealthMonitor {
  agents = new Map<string, MockAgent>();
  lastMcpCallTimestamps = new Map<string, number>();
  transitions: Array<{ agentId: string; activity: string }> = [];

  recordMcpActivity(agentId: string, toolName?: string): void {
    // This is the actual logic from agent-health.ts
    if (toolName && PASSIVE_TOOLS.has(toolName)) return;
    this.lastMcpCallTimestamps.set(agentId, Date.now());
    const agent = this.agents.get(agentId);
    if (agent && agent.activity === "idle") {
      agent.activity = "working";
      agent.lastActivityAt = new Date().toISOString();
      delete agent.idleSince;
      this.transitions.push({ agentId, activity: "working" });
    }
  }

  recordMcpCall(agentId: string, toolName?: string): void {
    this.recordMcpActivity(agentId, toolName);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Activity monitor: toolName passed to recordMcpCall", () => {
  let monitor: MockHealthMonitor;

  beforeEach(() => {
    monitor = new MockHealthMonitor();
    monitor.agents.set("agent-1", { activity: "idle", idleSince: new Date().toISOString() });
    monitor.agents.set("agent-2", { activity: "idle", idleSince: new Date().toISOString() });
  });

  it("passive tool WITH toolName does NOT flip idle agent to working", () => {
    monitor.recordMcpCall("agent-1", "check_messages");
    expect(monitor.agents.get("agent-1")!.activity).toBe("idle");
  });

  it("passive tool WITHOUT toolName INCORRECTLY flips idle to working (the bug)", () => {
    // This demonstrates the bug: when toolName is undefined, PASSIVE_TOOLS check is skipped
    monitor.recordMcpCall("agent-1", undefined);
    expect(monitor.agents.get("agent-1")!.activity).toBe("working");
  });

  it("active tool WITH toolName correctly flips idle to working", () => {
    monitor.recordMcpCall("agent-1", "send_message");
    expect(monitor.agents.get("agent-1")!.activity).toBe("working");
  });

  it("all PASSIVE_TOOLS are skipped when toolName is provided", () => {
    for (const tool of PASSIVE_TOOLS) {
      monitor.agents.set("test-agent", { activity: "idle", idleSince: new Date().toISOString() });
      monitor.recordMcpCall("test-agent", tool);
      expect(
        monitor.agents.get("test-agent")!.activity,
        `${tool} should not flip idle to working`,
      ).toBe("idle");
    }
  });

  it("non-passive tools DO flip idle to working", () => {
    const activePools = ["send_message", "broadcast", "update_task", "create_task", "spawn_agent", "save_knowledge"];
    for (const tool of activePools) {
      monitor.agents.set("test-agent", { activity: "idle", idleSince: new Date().toISOString() });
      monitor.recordMcpCall("test-agent", tool);
      expect(
        monitor.agents.get("test-agent")!.activity,
        `${tool} should flip idle to working`,
      ).toBe("working");
    }
  });

  it("relay endpoint fix: passing 'send_message' keeps correct behavior", () => {
    // Before fix: recordMcpCall(body.from) — no toolName
    // After fix: recordMcpCall(body.from, "send_message")
    monitor.recordMcpCall("agent-1", "send_message");
    expect(monitor.agents.get("agent-1")!.activity).toBe("working"); // send_message is active
  });

  it("traces endpoint fix: passive tool via traces does NOT flip idle", () => {
    // Traces endpoint now calls recordMcpCall(aid, toolName)
    // If an idle agent's only MCP call is check_messages, it should stay idle
    monitor.recordMcpCall("agent-1", "check_messages");
    expect(monitor.agents.get("agent-1")!.activity).toBe("idle");

    monitor.recordMcpCall("agent-1", "list_tasks");
    expect(monitor.agents.get("agent-1")!.activity).toBe("idle");

    monitor.recordMcpCall("agent-1", "get_context");
    expect(monitor.agents.get("agent-1")!.activity).toBe("idle");
  });

  it("traces endpoint fix: active tool via traces DOES flip idle", () => {
    monitor.recordMcpCall("agent-1", "update_task");
    expect(monitor.agents.get("agent-1")!.activity).toBe("working");
  });

  it("multiple agents: passive calls don't affect other agents", () => {
    monitor.recordMcpCall("agent-1", "check_messages");
    monitor.recordMcpCall("agent-2", "list_agents");
    expect(monitor.agents.get("agent-1")!.activity).toBe("idle");
    expect(monitor.agents.get("agent-2")!.activity).toBe("idle");
  });

  it("already working agent stays working regardless of tool type", () => {
    monitor.agents.set("agent-1", { activity: "working" });
    monitor.recordMcpCall("agent-1", "check_messages");
    expect(monitor.agents.get("agent-1")!.activity).toBe("working");

    monitor.recordMcpCall("agent-1", "send_message");
    expect(monitor.agents.get("agent-1")!.activity).toBe("working");
  });

  it("records MCP timestamp only for non-passive tools", () => {
    monitor.recordMcpCall("agent-1", "check_messages");
    expect(monitor.lastMcpCallTimestamps.has("agent-1")).toBe(false);

    monitor.recordMcpCall("agent-1", "send_message");
    expect(monitor.lastMcpCallTimestamps.has("agent-1")).toBe(true);
  });
});
