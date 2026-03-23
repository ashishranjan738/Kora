/**
 * Tests for shared tool registry and tool context utilities.
 */
import { describe, it, expect } from "vitest";
import {
  TOOL_DEFINITIONS,
  ALL_TOOL_NAMES,
  ROLE_TOOL_ACCESS,
  isToolAllowed,
  getToolDefinition,
  getToolsForRole,
} from "../../tools/tool-registry.js";
import { findAgentByNameOrId } from "../../tools/tool-context.js";
import { TOOL_HANDLER_MAP } from "../../tools/tool-handlers.js";

describe("Tool Registry", () => {
  it("has exactly 24 tool definitions", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(24);
  });

  it("ALL_TOOL_NAMES matches TOOL_DEFINITIONS", () => {
    const defNames = TOOL_DEFINITIONS.map(t => t.name).sort();
    const allNames = [...ALL_TOOL_NAMES].sort();
    expect(defNames).toEqual(allNames);
  });

  it("every tool definition has name, description, and inputSchema", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it("required fields reference valid properties", () => {
    for (const tool of TOOL_DEFINITIONS) {
      if (tool.inputSchema.required) {
        for (const req of tool.inputSchema.required) {
          expect(tool.inputSchema.properties).toHaveProperty(req);
        }
      }
    }
  });

  it("getToolDefinition returns correct tool", () => {
    const tool = getToolDefinition("send_message");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("send_message");
  });

  it("getToolDefinition returns undefined for unknown tool", () => {
    expect(getToolDefinition("nonexistent_tool")).toBeUndefined();
  });
});

describe("Role-Based Access Control", () => {
  it("master role has access to all tools", () => {
    for (const name of ALL_TOOL_NAMES) {
      expect(isToolAllowed("master", name)).toBe(true);
    }
  });

  it("worker role cannot access spawn_agent, remove_agent, peek_agent, nudge_agent", () => {
    expect(isToolAllowed("worker", "spawn_agent")).toBe(false);
    expect(isToolAllowed("worker", "remove_agent")).toBe(false);
    expect(isToolAllowed("worker", "peek_agent")).toBe(false);
    expect(isToolAllowed("worker", "nudge_agent")).toBe(false);
  });

  it("worker role can access messaging and task tools", () => {
    expect(isToolAllowed("worker", "send_message")).toBe(true);
    expect(isToolAllowed("worker", "check_messages")).toBe(true);
    expect(isToolAllowed("worker", "list_tasks")).toBe(true);
    expect(isToolAllowed("worker", "update_task")).toBe(true);
    expect(isToolAllowed("worker", "create_pr")).toBe(true);
  });

  it("unknown role defaults to worker permissions", () => {
    expect(isToolAllowed("unknown_role", "send_message")).toBe(true);
    expect(isToolAllowed("unknown_role", "spawn_agent")).toBe(false);
  });

  it("getToolsForRole returns filtered list", () => {
    const masterTools = getToolsForRole("master");
    const workerTools = getToolsForRole("worker");
    expect(masterTools.length).toBe(24);
    expect(workerTools.length).toBeLessThan(masterTools.length);
    expect(workerTools.every(t => isToolAllowed("worker", t.name))).toBe(true);
  });
});

describe("findAgentByNameOrId", () => {
  const agents = [
    { id: "agent-001", config: { name: "Backend", role: "worker" } },
    { id: "agent-002", config: { name: "Frontend", role: "worker" } },
    { id: "agent-003", config: { name: "Backend2", role: "worker" } },
  ];

  it("finds by exact name (case-insensitive)", () => {
    const result = findAgentByNameOrId(agents, "backend");
    expect(result?.id).toBe("agent-001");
  });

  it("finds by exact ID", () => {
    const result = findAgentByNameOrId(agents, "agent-002");
    expect(result?.id).toBe("agent-002");
  });

  it("finds by substring match as fallback", () => {
    const result = findAgentByNameOrId(agents, "Front");
    expect(result?.id).toBe("agent-002");
  });

  it("prefers exact name over substring", () => {
    // "Backend" exact match should win over "Backend2" substring
    const result = findAgentByNameOrId(agents, "Backend");
    expect(result?.id).toBe("agent-001");
  });

  it("returns undefined for empty search", () => {
    expect(findAgentByNameOrId(agents, "")).toBeUndefined();
    expect(findAgentByNameOrId(agents, "  ")).toBeUndefined();
  });

  it("returns undefined for no match", () => {
    expect(findAgentByNameOrId(agents, "nonexistent")).toBeUndefined();
  });
});

describe("Tool Handler Map", () => {
  it("has handlers for 20 extracted tools", () => {
    // 25 total - 5 MCP-specific (check_messages, prepare_pr, verify_work, create_pr, + check_messages file I/O)
    expect(Object.keys(TOOL_HANDLER_MAP).length).toBe(20);
  });

  it("every handler is a function", () => {
    for (const [name, handler] of Object.entries(TOOL_HANDLER_MAP)) {
      expect(typeof handler).toBe("function");
    }
  });

  it("handler names match tool definitions", () => {
    for (const name of Object.keys(TOOL_HANDLER_MAP)) {
      const def = getToolDefinition(name);
      expect(def).toBeDefined();
    }
  });
});
