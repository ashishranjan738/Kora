import { describe, it, expect } from "vitest";

/**
 * Tests for agent name resolution algorithm in agent-mcp-server.ts
 *
 * Bug context: send_message(to="Backend") was incorrectly routing to "Backend2"
 * when Backend2 appeared first in the agents array, due to substring matching
 * taking precedence over exact matching.
 *
 * Fix: Prioritized matching (exact name → ID → substring) to prevent ambiguity.
 */

// Mock agent type
interface AgentInfo {
  id: string;
  config?: {
    name?: string;
    role?: string;
  };
}

/**
 * Exact copy of findAgentByNameOrId from agent-mcp-server.ts
 * (Duplicated here for unit testing purposes)
 */
function findAgentByNameOrId(
  agents: AgentInfo[],
  search: string
): AgentInfo | undefined {
  // Return undefined for empty search string
  if (!search || search.trim() === "") {
    return undefined;
  }

  const searchLower = search.toLowerCase();

  // Priority 1: Exact name match
  let target = agents.find(a =>
    (a.config?.name || "").toLowerCase() === searchLower
  );
  if (target) return target;

  // Priority 2: Exact ID match
  target = agents.find(a =>
    a.id.toLowerCase() === searchLower
  );
  if (target) return target;

  // Priority 3: Substring match (fallback)
  target = agents.find(a => {
    const name = (a.config?.name || "").toLowerCase();
    return name.includes(searchLower) ||
           a.id.toLowerCase().includes(searchLower);
  });

  return target;
}

describe("findAgentByNameOrId - Priority 1: Exact name match", () => {
  const agents: AgentInfo[] = [
    { id: "backend2-abc123", config: { name: "Backend2" } },
    { id: "backend-def456", config: { name: "Backend" } },
    { id: "frontend-ghi789", config: { name: "Frontend" } },
  ];

  it("should match 'Backend' to Backend agent (not Backend2) despite array order", () => {
    const result = findAgentByNameOrId(agents, "Backend");
    expect(result?.id).toBe("backend-def456");
    expect(result?.config?.name).toBe("Backend");
  });

  it("should match 'Backend2' to Backend2 agent", () => {
    const result = findAgentByNameOrId(agents, "Backend2");
    expect(result?.id).toBe("backend2-abc123");
    expect(result?.config?.name).toBe("Backend2");
  });

  it("should match 'Frontend' exactly", () => {
    const result = findAgentByNameOrId(agents, "Frontend");
    expect(result?.id).toBe("frontend-ghi789");
    expect(result?.config?.name).toBe("Frontend");
  });

  it("should be case-insensitive for exact matches", () => {
    const result = findAgentByNameOrId(agents, "backend");
    expect(result?.id).toBe("backend-def456");
    expect(result?.config?.name).toBe("Backend");
  });

  it("should handle UPPERCASE input", () => {
    const result = findAgentByNameOrId(agents, "BACKEND");
    expect(result?.id).toBe("backend-def456");
  });

  it("should handle MixedCase input", () => {
    const result = findAgentByNameOrId(agents, "BaCkEnD");
    expect(result?.id).toBe("backend-def456");
  });
});

describe("findAgentByNameOrId - Priority 2: Exact ID match", () => {
  const agents: AgentInfo[] = [
    { id: "backend-abc123", config: { name: "Backend" } },
    { id: "frontend-def456", config: { name: "Frontend" } },
  ];

  it("should match exact ID when no name matches", () => {
    const result = findAgentByNameOrId(agents, "backend-abc123");
    expect(result?.id).toBe("backend-abc123");
    expect(result?.config?.name).toBe("Backend");
  });

  it("should match ID case-insensitively", () => {
    const result = findAgentByNameOrId(agents, "BACKEND-ABC123");
    expect(result?.id).toBe("backend-abc123");
  });

  it("should prefer exact name match over ID substring", () => {
    // If searching "backend" - should match name "Backend" exactly,
    // not ID "backend-abc123" by substring
    const result = findAgentByNameOrId(agents, "backend");
    expect(result?.config?.name).toBe("Backend");
  });
});

describe("findAgentByNameOrId - Priority 3: Substring fallback", () => {
  const agents: AgentInfo[] = [
    { id: "architect-xyz789", config: { name: "Architect" } },
    { id: "backend-abc123", config: { name: "Backend" } },
    { id: "frontend-def456", config: { name: "Frontend" } },
  ];

  it("should match 'Back' to Backend via substring", () => {
    const result = findAgentByNameOrId(agents, "Back");
    expect(result?.config?.name).toBe("Backend");
  });

  it("should match 'Front' to Frontend via substring", () => {
    const result = findAgentByNameOrId(agents, "Front");
    expect(result?.config?.name).toBe("Frontend");
  });

  it("should match 'Arch' to Architect via substring", () => {
    const result = findAgentByNameOrId(agents, "Arch");
    expect(result?.config?.name).toBe("Architect");
  });

  it("should match ID substring when no name substring matches", () => {
    const result = findAgentByNameOrId(agents, "xyz789");
    expect(result?.id).toBe("architect-xyz789");
  });

  it("should be case-insensitive for substrings", () => {
    const result = findAgentByNameOrId(agents, "back");
    expect(result?.config?.name).toBe("Backend");
  });
});

describe("findAgentByNameOrId - Edge cases", () => {
  const agents: AgentInfo[] = [
    { id: "backend-abc123", config: { name: "Backend" } },
    { id: "backend2-def456", config: { name: "Backend2" } },
    { id: "backend3-ghi789", config: { name: "Backend3" } },
  ];

  it("should return undefined for non-existent agent", () => {
    const result = findAgentByNameOrId(agents, "NonExistent");
    expect(result).toBeUndefined();
  });

  it("should return undefined for empty search string", () => {
    const result = findAgentByNameOrId(agents, "");
    expect(result).toBeUndefined();
  });

  it("should handle agents with no config", () => {
    const agentsNoConfig: AgentInfo[] = [
      { id: "backend-abc123" },
      { id: "frontend-def456" },
    ];
    const result = findAgentByNameOrId(agentsNoConfig, "backend-abc123");
    expect(result?.id).toBe("backend-abc123");
  });

  it("should handle agents with no name in config", () => {
    const agentsNoName: AgentInfo[] = [
      { id: "backend-abc123", config: {} },
      { id: "frontend-def456", config: {} },
    ];
    const result = findAgentByNameOrId(agentsNoName, "backend-abc123");
    expect(result?.id).toBe("backend-abc123");
  });

  it("should handle empty agents array", () => {
    const result = findAgentByNameOrId([], "Backend");
    expect(result).toBeUndefined();
  });

  it("should handle whitespace in search string", () => {
    const result = findAgentByNameOrId(agents, "  Backend  ");
    // Should not match due to leading/trailing spaces
    expect(result).toBeUndefined();
  });
});

describe("findAgentByNameOrId - Priority ordering validation", () => {
  it("should prefer exact name over substring in all cases", () => {
    const agents: AgentInfo[] = [
      { id: "backend2-abc", config: { name: "Backend2" } },
      { id: "backend-def", config: { name: "Backend" } },
      { id: "backend3-ghi", config: { name: "Backend3" } },
    ];

    // Even though Backend2 comes first and contains "Backend",
    // should match "Backend" exactly
    const result = findAgentByNameOrId(agents, "Backend");
    expect(result?.config?.name).toBe("Backend");
    expect(result?.id).not.toBe("backend2-abc");
  });

  it("should prefer exact ID over substring", () => {
    const agents: AgentInfo[] = [
      { id: "backend-123abc", config: { name: "Backend" } },
      { id: "abc", config: { name: "Frontend" } },
    ];

    // Search for "abc" - should match ID "abc" exactly, not substring in "123abc"
    const result = findAgentByNameOrId(agents, "abc");
    expect(result?.id).toBe("abc");
    expect(result?.config?.name).toBe("Frontend");
  });

  it("should only use substring as last resort", () => {
    const agents: AgentInfo[] = [
      { id: "test-backend", config: { name: "TestBackend" } },
      { id: "backend-main", config: { name: "Backend" } },
    ];

    // Exact match should win over substring
    const result1 = findAgentByNameOrId(agents, "Backend");
    expect(result1?.config?.name).toBe("Backend");

    // Substring should work when no exact match
    const result2 = findAgentByNameOrId(agents, "Test");
    expect(result2?.config?.name).toBe("TestBackend");
  });
});

describe("findAgentByNameOrId - Bug reproduction", () => {
  /**
   * This test reproduces the exact bug scenario:
   *
   * Setup: Backend2 spawned before Backend (common scenario)
   * Issue: send_message(to="Backend") routed to Backend2
   * Root cause: .find() with substring match returns first match
   *
   * Expected: "Backend" should match Backend exactly, not Backend2 by substring
   */
  it("should NOT route 'Backend' to 'Backend2' when Backend2 appears first", () => {
    const agents: AgentInfo[] = [
      { id: "backend2-early", config: { name: "Backend2", role: "worker" } },
      { id: "backend-late", config: { name: "Backend", role: "worker" } },
    ];

    const result = findAgentByNameOrId(agents, "Backend");

    // CRITICAL ASSERTION: Must route to Backend, not Backend2
    expect(result?.config?.name).toBe("Backend");
    expect(result?.id).toBe("backend-late");
    expect(result?.id).not.toBe("backend2-early");
  });

  it("should handle similar names with numbers correctly", () => {
    const agents: AgentInfo[] = [
      { id: "worker1", config: { name: "Worker1" } },
      { id: "worker2", config: { name: "Worker2" } },
      { id: "worker", config: { name: "Worker" } },
    ];

    const result1 = findAgentByNameOrId(agents, "Worker");
    expect(result1?.config?.name).toBe("Worker");

    const result2 = findAgentByNameOrId(agents, "Worker1");
    expect(result2?.config?.name).toBe("Worker1");

    const result3 = findAgentByNameOrId(agents, "Worker2");
    expect(result3?.config?.name).toBe("Worker2");
  });
});
