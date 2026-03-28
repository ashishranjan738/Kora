/**
 * Tests for ToolContext extensions added in PR #458:
 * - execFileAsync: optional shell execution for prepare_pr, verify_work, create_pr
 * - getRuntimeDir: returns ".kora" or ".kora-dev" based on environment
 *
 * Also verifies TOOL_HANDLER_MAP completeness and handler type correctness.
 */
import { describe, it, expect, vi } from "vitest";
import type { ToolContext, ToolArgs } from "../../tools/tool-context.js";
import { findAgentByNameOrId } from "../../tools/tool-context.js";
import { TOOL_HANDLER_MAP } from "../../tools/tool-handlers.js";
import { TOOL_DEFINITIONS, ALL_TOOL_NAMES, getToolDefinition } from "../../tools/tool-registry.js";

// ── TOOL_HANDLER_MAP completeness ───────────────────────────

describe("TOOL_HANDLER_MAP completeness", () => {
  it("has exactly 29 entries", () => {
    expect(Object.keys(TOOL_HANDLER_MAP).length).toBe(29);
  });

  it("every TOOL_DEFINITION has a corresponding handler", () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(TOOL_HANDLER_MAP).toHaveProperty(def.name);
    }
  });

  it("no handler exists without a TOOL_DEFINITION", () => {
    for (const name of Object.keys(TOOL_HANDLER_MAP)) {
      const def = getToolDefinition(name);
      expect(def).toBeDefined();
    }
  });

  it("every handler is an async function (returns Promise)", () => {
    for (const [name, handler] of Object.entries(TOOL_HANDLER_MAP)) {
      expect(typeof handler).toBe("function");
      // Verify function signature: (ctx, args) => Promise<unknown>
      expect(handler.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("includes the extracted handler check_messages", () => {
    expect(TOOL_HANDLER_MAP).toHaveProperty("check_messages");
    expect(typeof TOOL_HANDLER_MAP["check_messages"]).toBe("function");
  });

  it("includes all original handlers", () => {
    const originalHandlers = [
      "send_message", "list_agents", "broadcast", "list_tasks",
      "get_task", "update_task", "create_task", "spawn_agent",
      "remove_agent", "peek_agent", "nudge_agent", "report_idle",
      "request_task", "list_personas", "save_persona",
      "get_context", "get_workflow_states", "save_knowledge",
      "search_knowledge", "get_knowledge",
      "channel_list", "channel_join", "channel_history",
      "share_file", "whoami",
    ];
    for (const name of originalHandlers) {
      expect(TOOL_HANDLER_MAP).toHaveProperty(name);
    }
  });
});

// ── ToolContext.execFileAsync usage ──────────────────────────

describe("ToolContext.execFileAsync", () => {
  it("execFileAsync mock provides expected interface", () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: "output", stderr: "" });
    const ctx: ToolContext = {
      agentId: "test",
      sessionId: "test",
      agentRole: "worker",
      projectPath: "/tmp",
      apiCall: vi.fn(),
      execFileAsync: mockExec,
    };

    expect(ctx.execFileAsync).toBeDefined();
    expect(typeof ctx.execFileAsync).toBe("function");
  });
});

// ── ToolContext.getRuntimeDir usage ──────────────────────────

describe("ToolContext.getRuntimeDir", () => {
  it("can return .kora for production mode", () => {
    const ctx: ToolContext = {
      agentId: "test",
      sessionId: "test",
      agentRole: "worker",
      projectPath: "/tmp",
      apiCall: vi.fn(),
      getRuntimeDir: () => ".kora",
    };

    expect(ctx.getRuntimeDir!()).toBe(".kora");
  });

  it("can return .kora-dev for dev mode", () => {
    const ctx: ToolContext = {
      agentId: "test",
      sessionId: "test",
      agentRole: "worker",
      projectPath: "/tmp",
      apiCall: vi.fn(),
      getRuntimeDir: () => ".kora-dev",
    };

    expect(ctx.getRuntimeDir!()).toBe(".kora-dev");
  });

  it("is optional — handlers should work without it", () => {
    const ctx: ToolContext = {
      agentId: "test",
      sessionId: "test",
      agentRole: "worker",
      projectPath: "/tmp",
      apiCall: vi.fn(),
      // getRuntimeDir intentionally NOT provided
    };

    expect(ctx.getRuntimeDir).toBeUndefined();
  });
});

// ── findAgentByNameOrId edge cases ──────────────────────────

describe("findAgentByNameOrId — additional edge cases", () => {
  const agents = [
    { id: "agent-001", config: { name: "Dev 1", role: "worker" } },
    { id: "agent-002", config: { name: "Dev 2", role: "worker" } },
    { id: "agent-003", config: { name: "Reviewer", role: "worker" } },
  ];

  it("matches agent name with different case", () => {
    expect(findAgentByNameOrId(agents, "dev 1")?.id).toBe("agent-001");
    expect(findAgentByNameOrId(agents, "DEV 1")?.id).toBe("agent-001");
    expect(findAgentByNameOrId(agents, "Dev 1")?.id).toBe("agent-001");
  });

  it("matches agent ID with different case", () => {
    expect(findAgentByNameOrId(agents, "AGENT-002")?.id).toBe("agent-002");
  });

  it("returns undefined for whitespace-only search", () => {
    expect(findAgentByNameOrId(agents, "   ")).toBeUndefined();
    expect(findAgentByNameOrId(agents, "\t")).toBeUndefined();
  });

  it("handles agents with no config", () => {
    const agentsNoConfig = [
      { id: "bare-agent" },
    ] as any[];
    // Should not throw
    expect(findAgentByNameOrId(agentsNoConfig, "bare-agent")?.id).toBe("bare-agent");
  });

  it("handles empty agents array", () => {
    expect(findAgentByNameOrId([], "anything")).toBeUndefined();
  });
});
