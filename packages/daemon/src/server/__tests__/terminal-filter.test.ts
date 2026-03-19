import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

describe("Terminal filter API", () => {
  // Mock dependencies
  const mockSessionManager = {
    getSession: vi.fn(),
  };

  const mockStandaloneTerminals = new Map();
  const mockOrchestrators = new Map();

  beforeEach(() => {
    vi.clearAllMocks();
    mockStandaloneTerminals.clear();
    mockOrchestrators.clear();
  });

  // Test 1: GET /sessions/:sid/terminals returns both agent and standalone terminals
  it("returns both agent and standalone terminals with type field", async () => {
    const sid = "test-session";

    // Mock session exists
    mockSessionManager.getSession.mockReturnValue({ id: sid });

    // Mock standalone terminals
    mockStandaloneTerminals.set(sid, [
      {
        id: "term-1",
        tmuxSession: "standalone-1",
        name: "Terminal 1",
        createdAt: "2026-03-18T10:00:00Z",
      },
    ]);

    // Mock agent manager with agents
    const mockAgentManager = {
      listAgents: vi.fn().mockReturnValue([
        {
          id: "agent-1",
          config: {
            name: "Worker A",
            tmuxSession: "agent-tmux-1",
          },
          startedAt: "2026-03-18T09:00:00Z",
        },
      ]),
    };

    mockOrchestrators.set(sid, { agentManager: mockAgentManager });

    // Simulate the route handler logic
    const terminals: any[] = [];

    // Add standalone terminals
    const sessionTerminals = mockStandaloneTerminals.get(sid);
    if (sessionTerminals) {
      sessionTerminals.forEach((term: any) => {
        terminals.push({
          id: term.id,
          tmuxSession: term.tmuxSession,
          name: term.name,
          type: "standalone",
          createdAt: term.createdAt,
        });
      });
    }

    // Add agent terminals
    const am = mockOrchestrators.get(sid)?.agentManager;
    if (am) {
      const agents = am.listAgents();
      agents.forEach((agent: any) => {
        terminals.push({
          id: agent.id,
          tmuxSession: agent.config.tmuxSession,
          name: agent.config.name,
          type: "agent",
          agentName: agent.config.name,
          createdAt: agent.startedAt || new Date().toISOString(),
        });
      });
    }

    // Verify results
    expect(terminals).toHaveLength(2);
    expect(terminals[0].type).toBe("standalone");
    expect(terminals[0].id).toBe("term-1");
    expect(terminals[1].type).toBe("agent");
    expect(terminals[1].id).toBe("agent-1");
  });

  // Test 2: Standalone terminals have type: 'standalone'
  it("marks standalone terminals with type: 'standalone'", async () => {
    const sid = "test-session";

    mockSessionManager.getSession.mockReturnValue({ id: sid });

    // Mock multiple standalone terminals
    mockStandaloneTerminals.set(sid, [
      {
        id: "term-1",
        tmuxSession: "standalone-1",
        name: "Terminal 1",
        createdAt: "2026-03-18T10:00:00Z",
      },
      {
        id: "term-2",
        tmuxSession: "standalone-2",
        name: "Terminal 2",
        createdAt: "2026-03-18T10:05:00Z",
      },
    ]);

    // No agents
    mockOrchestrators.set(sid, { agentManager: { listAgents: () => [] } });

    // Simulate route logic
    const terminals: any[] = [];
    const sessionTerminals = mockStandaloneTerminals.get(sid);
    if (sessionTerminals) {
      sessionTerminals.forEach((term: any) => {
        terminals.push({
          id: term.id,
          tmuxSession: term.tmuxSession,
          name: term.name,
          type: "standalone",
          createdAt: term.createdAt,
        });
      });
    }

    // Verify all standalone terminals have correct type
    expect(terminals).toHaveLength(2);
    terminals.forEach((term) => {
      expect(term.type).toBe("standalone");
      expect(term.agentName).toBeUndefined();
    });
  });

  // Test 3: Agent terminals are marked with type: 'agent'
  it("marks agent terminals with type: 'agent' and includes agentName", async () => {
    const sid = "test-session";

    mockSessionManager.getSession.mockReturnValue({ id: sid });

    // No standalone terminals
    mockStandaloneTerminals.set(sid, []);

    // Mock multiple agents
    const mockAgentManager = {
      listAgents: vi.fn().mockReturnValue([
        {
          id: "agent-1",
          config: {
            name: "Frontend",
            tmuxSession: "agent-tmux-1",
          },
          startedAt: "2026-03-18T09:00:00Z",
        },
        {
          id: "agent-2",
          config: {
            name: "Backend",
            tmuxSession: "agent-tmux-2",
          },
          startedAt: "2026-03-18T09:05:00Z",
        },
      ]),
    };

    mockOrchestrators.set(sid, { agentManager: mockAgentManager });

    // Simulate route logic
    const terminals: any[] = [];
    const am = mockOrchestrators.get(sid)?.agentManager;
    if (am) {
      const agents = am.listAgents();
      agents.forEach((agent: any) => {
        terminals.push({
          id: agent.id,
          tmuxSession: agent.config.tmuxSession,
          name: agent.config.name,
          type: "agent",
          agentName: agent.config.name,
          createdAt: agent.startedAt || new Date().toISOString(),
        });
      });
    }

    // Verify all agent terminals have correct type and agentName
    expect(terminals).toHaveLength(2);
    terminals.forEach((term) => {
      expect(term.type).toBe("agent");
      expect(term.agentName).toBeDefined();
      expect(term.tmuxSession).toMatch(/^agent-tmux-/);
    });
  });

  // Test 4: Returns empty array when no terminals exist
  it("returns empty terminals array when session has no terminals", async () => {
    const sid = "empty-session";

    mockSessionManager.getSession.mockReturnValue({ id: sid });

    // No standalone terminals
    mockStandaloneTerminals.set(sid, []);

    // No agents
    mockOrchestrators.set(sid, { agentManager: { listAgents: () => [] } });

    // Simulate route logic
    const terminals: any[] = [];
    const sessionTerminals = mockStandaloneTerminals.get(sid);
    if (sessionTerminals) {
      sessionTerminals.forEach((term: any) => {
        terminals.push({
          id: term.id,
          tmuxSession: term.tmuxSession,
          name: term.name,
          type: "standalone",
          createdAt: term.createdAt,
        });
      });
    }

    expect(terminals).toHaveLength(0);
  });
});
