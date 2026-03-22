import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Test tool access control logic extracted from agent-mcp-server.ts.
// Since agent-mcp-server.ts is a standalone script with side-effects,
// we replicate the access control logic here.
// ---------------------------------------------------------------------------

const ALL_TOOLS = [
  "send_message", "check_messages", "list_agents", "broadcast",
  "list_tasks", "get_task", "update_task", "create_task",
  "spawn_agent", "remove_agent", "peek_agent", "nudge_agent",
  "prepare_pr", "report_idle", "request_task",
] as const;

const ROLE_TOOL_ACCESS: Record<string, Set<string>> = {
  master: new Set(ALL_TOOLS),
  worker: new Set([
    "send_message", "check_messages", "list_agents", "broadcast",
    "list_tasks", "get_task", "update_task", "create_task",
    "prepare_pr", "report_idle", "request_task",
  ]),
};

function isToolAllowed(role: string, toolName: string): boolean {
  const allowed = ROLE_TOOL_ACCESS[role];
  if (!allowed) return ROLE_TOOL_ACCESS.worker.has(toolName); // unknown role — default to worker (most restrictive)
  return allowed.has(toolName);
}

// ---------------------------------------------------------------------------
// Tests — Master role
// ---------------------------------------------------------------------------

describe("Tool access control — master role", () => {
  it("master has access to ALL tools", () => {
    for (const tool of ALL_TOOLS) {
      expect(isToolAllowed("master", tool), `master should have ${tool}`).toBe(true);
    }
  });

  it("master can spawn and remove agents", () => {
    expect(isToolAllowed("master", "spawn_agent")).toBe(true);
    expect(isToolAllowed("master", "remove_agent")).toBe(true);
  });

  it("master can peek and nudge agents", () => {
    expect(isToolAllowed("master", "peek_agent")).toBe(true);
    expect(isToolAllowed("master", "nudge_agent")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — Worker role
// ---------------------------------------------------------------------------

describe("Tool access control — worker role", () => {
  it("worker can use communication tools", () => {
    expect(isToolAllowed("worker", "send_message")).toBe(true);
    expect(isToolAllowed("worker", "check_messages")).toBe(true);
    expect(isToolAllowed("worker", "list_agents")).toBe(true);
    expect(isToolAllowed("worker", "broadcast")).toBe(true);
  });

  it("worker can use task tools", () => {
    expect(isToolAllowed("worker", "list_tasks")).toBe(true);
    expect(isToolAllowed("worker", "get_task")).toBe(true);
    expect(isToolAllowed("worker", "update_task")).toBe(true);
    expect(isToolAllowed("worker", "create_task")).toBe(true);
  });

  it("worker can use workflow tools", () => {
    expect(isToolAllowed("worker", "prepare_pr")).toBe(true);
    expect(isToolAllowed("worker", "report_idle")).toBe(true);
    expect(isToolAllowed("worker", "request_task")).toBe(true);
  });

  it("worker CANNOT spawn or remove agents", () => {
    expect(isToolAllowed("worker", "spawn_agent")).toBe(false);
    expect(isToolAllowed("worker", "remove_agent")).toBe(false);
  });

  it("worker CANNOT peek or nudge agents", () => {
    expect(isToolAllowed("worker", "peek_agent")).toBe(false);
    expect(isToolAllowed("worker", "nudge_agent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests — Unknown / custom roles
// ---------------------------------------------------------------------------

describe("Tool access control — unknown roles", () => {
  it("unknown role defaults to worker permissions (most restrictive)", () => {
    expect(isToolAllowed("custom-role", "spawn_agent")).toBe(false);
    expect(isToolAllowed("custom-role", "remove_agent")).toBe(false);
    expect(isToolAllowed("custom-role", "peek_agent")).toBe(false);
    expect(isToolAllowed("custom-role", "nudge_agent")).toBe(false);
    expect(isToolAllowed("custom-role", "send_message")).toBe(true);
    expect(isToolAllowed("custom-role", "list_tasks")).toBe(true);
  });

  it("empty role string defaults to worker permissions", () => {
    expect(isToolAllowed("", "spawn_agent")).toBe(false);
    expect(isToolAllowed("", "send_message")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — Tool filtering
// ---------------------------------------------------------------------------

describe("Tool list filtering", () => {
  it("master sees all 15 tools", () => {
    const filtered = ALL_TOOLS.filter(t => isToolAllowed("master", t));
    expect(filtered).toHaveLength(15);
  });

  it("worker sees 11 tools (15 - 4 master-only)", () => {
    const filtered = ALL_TOOLS.filter(t => isToolAllowed("worker", t));
    expect(filtered).toHaveLength(11);
  });

  it("worker filtered list excludes exactly spawn_agent, remove_agent, peek_agent, nudge_agent", () => {
    const masterOnly = ALL_TOOLS.filter(t => !isToolAllowed("worker", t));
    expect(masterOnly).toEqual(["spawn_agent", "remove_agent", "peek_agent", "nudge_agent"]);
  });
});
