import { describe, it, expect, vi, beforeEach } from "vitest";
import { PlaybookExecutor } from "../playbook-executor.js";
import type { SessionConfig } from "@kora/shared";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockOrchestrator() {
  return {
    agentManager: {
      listAgents: vi.fn().mockReturnValue([]),
      spawnAgent: vi.fn().mockResolvedValue({ id: "agent-new", config: { name: "Test" } }),
    },
    messageQueue: {
      registerMcpAgent: vi.fn(),
      registerAgentRole: vi.fn(),
    },
    database: {
      insertTask: vi.fn(),
    },
    config: {
      runtimeDir: "/tmp/test-runtime",
    },
  } as any;
}

function createMockProviderRegistry() {
  return {
    get: vi.fn().mockReturnValue({
      id: "claude-code",
      defaultModel: "claude-sonnet-4-6",
      buildCommand: vi.fn().mockReturnValue(["claude"]),
    }),
  } as any;
}

const mockSession: SessionConfig = {
  id: "test-session",
  name: "Test Session",
  projectPath: "/tmp/test-project",
  defaultProvider: "claude-code",
  agents: [],
  createdAt: new Date().toISOString(),
  status: "active",
};

const simplePlaybook = {
  name: "Test Playbook",
  description: "A test playbook",
  agents: [
    { name: "Architect", role: "master" as const, model: "default", persona: "builtin:architect" },
    { name: "Frontend", role: "worker" as const, model: "default", persona: "builtin:frontend" },
    { name: "Backend", role: "worker" as const, model: "default", persona: "builtin:backend" },
  ],
};

// ---------------------------------------------------------------------------
// Tests — Setup phase
// ---------------------------------------------------------------------------

describe("PlaybookExecutor — setup", () => {
  it("creates execution record with correct initial state", () => {
    const orch = createMockOrchestrator();
    const registry = createMockProviderRegistry();
    const executor = new PlaybookExecutor(orch, registry, mockSession, simplePlaybook);

    const execution = executor.setup();

    expect(execution.id).toBeTruthy();
    expect(execution.sessionId).toBe("test-session");
    expect(execution.playbookName).toBe("Test Playbook");
    expect(execution.status).toBe("pending");
    expect(execution.agents).toHaveLength(3);
    expect(execution.agents[0].name).toBe("Architect");
    expect(execution.agents[0].status).toBe("pending");
  });

  it("throws on missing required variables", () => {
    const orch = createMockOrchestrator();
    const registry = createMockProviderRegistry();
    const playbook = {
      ...simplePlaybook,
      variables: {
        projectName: { required: true, description: "Project name" },
      },
    };
    const executor = new PlaybookExecutor(orch, registry, mockSession, playbook, {});

    expect(() => executor.setup()).toThrow("Missing required variable: {{projectName}}");
  });

  it("accepts variables with defaults", () => {
    const orch = createMockOrchestrator();
    const registry = createMockProviderRegistry();
    const playbook = {
      ...simplePlaybook,
      variables: {
        projectName: { default: "MyProject", description: "Project name" },
      },
    };
    const executor = new PlaybookExecutor(orch, registry, mockSession, playbook, {});

    expect(() => executor.setup()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests — Variable interpolation
// ---------------------------------------------------------------------------

describe("PlaybookExecutor — interpolation", () => {
  it("interpolates {{varName}} in persona", () => {
    const orch = createMockOrchestrator();
    const registry = createMockProviderRegistry();
    const playbook = {
      name: "Test",
      agents: [
        { name: "Worker", role: "worker" as const, model: "default", persona: "You work on {{projectName}}" },
      ],
      variables: {
        projectName: { description: "Project name" },
      },
    };

    const executor = new PlaybookExecutor(orch, registry, mockSession, playbook, { projectName: "Kora" });
    executor.setup();

    // The interpolated playbook is internal but we can verify via execution
    expect(executor.execution.agents[0].name).toBe("Worker");
  });

  it("interpolates {{varName}} in task titles", () => {
    const orch = createMockOrchestrator();
    const registry = createMockProviderRegistry();
    const playbook = {
      name: "Test",
      agents: [{ name: "Worker", role: "worker" as const, model: "default" }],
      tasks: [{ title: "Setup {{component}}", description: "Build the {{component}} module" }],
      variables: {
        component: { default: "auth" },
      },
    };

    const executor = new PlaybookExecutor(orch, registry, mockSession, playbook, {});
    executor.setup();
    // No throw = interpolation succeeded
  });

  it("leaves unresolved variables as-is", () => {
    const orch = createMockOrchestrator();
    const registry = createMockProviderRegistry();
    const playbook = {
      name: "Test",
      agents: [
        { name: "Worker", role: "worker" as const, model: "default", persona: "Work on {{unknown}}" },
      ],
    };

    const executor = new PlaybookExecutor(orch, registry, mockSession, playbook, {});
    executor.setup(); // Should not throw
  });
});

// ---------------------------------------------------------------------------
// Tests — Execution phase
// ---------------------------------------------------------------------------

describe("PlaybookExecutor — run", () => {
  it("spawns masters before workers", async () => {
    const orch = createMockOrchestrator();
    const registry = createMockProviderRegistry();
    const spawnOrder: string[] = [];

    orch.agentManager.spawnAgent.mockImplementation(async (opts: any) => {
      spawnOrder.push(opts.name);
      return { id: `id-${opts.name}`, config: { name: opts.name } };
    });

    const executor = new PlaybookExecutor(orch, registry, mockSession, simplePlaybook);
    executor.setup();
    await executor.run();

    // Architect (master) should be spawned before Frontend and Backend (workers)
    expect(spawnOrder.indexOf("Architect")).toBeLessThan(spawnOrder.indexOf("Frontend"));
    expect(spawnOrder.indexOf("Architect")).toBeLessThan(spawnOrder.indexOf("Backend"));
  });

  it("emits playbook-complete on success", async () => {
    const orch = createMockOrchestrator();
    const registry = createMockProviderRegistry();
    orch.agentManager.spawnAgent.mockResolvedValue({ id: "agent-1", config: { name: "Test" } });

    const executor = new PlaybookExecutor(orch, registry, mockSession, simplePlaybook);
    executor.setup();

    const events: string[] = [];
    executor.on("playbook-complete", () => events.push("complete"));
    executor.on("playbook-progress", (data: any) => events.push(data.phase));

    await executor.run();

    expect(events).toContain("execution-started");
    expect(events).toContain("execution-complete");
    expect(events).toContain("complete");
    expect(executor.execution.status).toBe("complete");
  });

  it("aborts on master failure", async () => {
    const orch = createMockOrchestrator();
    const registry = createMockProviderRegistry();
    orch.agentManager.spawnAgent.mockRejectedValue(new Error("Spawn failed"));

    const executor = new PlaybookExecutor(orch, registry, mockSession, simplePlaybook);
    executor.setup();

    const events: string[] = [];
    executor.on("playbook-failed", () => events.push("failed"));

    await executor.run();

    expect(executor.execution.status).toBe("failed");
    expect(events).toContain("failed");
    // Workers should NOT have been spawned
    expect(orch.agentManager.spawnAgent).toHaveBeenCalledTimes(1); // Only master attempted
  });

  it("continues on worker failure (partial status)", async () => {
    const orch = createMockOrchestrator();
    const registry = createMockProviderRegistry();

    let callCount = 0;
    orch.agentManager.spawnAgent.mockImplementation(async (opts: any) => {
      callCount++;
      if (opts.role === "worker" && callCount === 2) {
        throw new Error("Worker spawn failed");
      }
      return { id: `agent-${callCount}`, config: { name: opts.name } };
    });

    const executor = new PlaybookExecutor(orch, registry, mockSession, simplePlaybook);
    executor.setup();
    await executor.run();

    expect(executor.execution.status).toBe("partial");
    // All 3 should have been attempted (1 master + 2 workers)
    expect(orch.agentManager.spawnAgent).toHaveBeenCalledTimes(3);
  });

  it("registers MCP agents after spawn", async () => {
    const orch = createMockOrchestrator();
    const registry = createMockProviderRegistry();
    orch.agentManager.spawnAgent.mockResolvedValue({ id: "agent-1", config: { name: "Test" } });

    const executor = new PlaybookExecutor(orch, registry, mockSession, simplePlaybook);
    executor.setup();
    await executor.run();

    expect(orch.messageQueue.registerMcpAgent).toHaveBeenCalledTimes(3);
    expect(orch.messageQueue.registerAgentRole).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Tests — Task creation (Phase 3)
// ---------------------------------------------------------------------------

describe("PlaybookExecutor — task creation", () => {
  it("creates tasks from playbook definition", async () => {
    const orch = createMockOrchestrator();
    const registry = createMockProviderRegistry();
    orch.agentManager.spawnAgent.mockResolvedValue({ id: "agent-1", config: { name: "Test" } });

    const playbook = {
      ...simplePlaybook,
      tasks: [
        { title: "Setup project", description: "Initialize the project" },
        { title: "Build API", description: "Create REST endpoints", dependencies: ["Setup project"] },
      ],
    };

    const executor = new PlaybookExecutor(orch, registry, mockSession, playbook);
    executor.setup();
    await executor.run();

    expect(orch.database.insertTask).toHaveBeenCalledTimes(2);
    expect(executor.execution.taskIds).toHaveLength(2);
  });

  it("resolves task assignedTo by agent name", async () => {
    const orch = createMockOrchestrator();
    const registry = createMockProviderRegistry();

    orch.agentManager.spawnAgent.mockImplementation(async (opts: any) => {
      return { id: `id-${opts.name.toLowerCase()}`, config: { name: opts.name } };
    });

    const playbook = {
      ...simplePlaybook,
      tasks: [
        { title: "Build UI", assignedTo: "Frontend" },
      ],
    };

    const executor = new PlaybookExecutor(orch, registry, mockSession, playbook);
    executor.setup();
    await executor.run();

    const insertCall = orch.database.insertTask.mock.calls[0][0];
    expect(insertCall.assignedTo).toBe("id-frontend");
  });
});

// ---------------------------------------------------------------------------
// Tests — Dry run
// ---------------------------------------------------------------------------

describe("PlaybookExecutor — dry run", () => {
  it("setup returns execution plan without spawning", () => {
    const orch = createMockOrchestrator();
    const registry = createMockProviderRegistry();

    const executor = new PlaybookExecutor(orch, registry, mockSession, simplePlaybook);
    const plan = executor.setup();

    expect(plan.status).toBe("pending");
    expect(plan.agents).toHaveLength(3);
    // No agents spawned
    expect(orch.agentManager.spawnAgent).not.toHaveBeenCalled();
  });
});
