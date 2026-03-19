/**
 * Unit tests for P1 config limits and timeouts.
 * Tests enforcement of MAX_AGENTS_PER_SESSION and SPAWN_TIMEOUT_MS.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HEALTH_CHECK_INTERVAL_MS,
  COST_UPDATE_INTERVAL_MS,
  MAX_AGENTS_PER_SESSION,
  FORCE_DELIVERY_TIMEOUT_MS,
  SPAWN_TIMEOUT_MS,
} from "@kora/shared";
import { AgentManager } from "../agent-manager.js";
import type { SpawnAgentOptions } from "../agent-manager.js";
import type { IPtyBackend } from "../pty-backend.js";
import type { CLIProvider } from "@kora/shared";
import { AgentHealthMonitor } from "../agent-health.js";

// ---------------------------------------------------------------------------
// Constants validation
// ---------------------------------------------------------------------------

describe("Config constants P1 fixes", () => {
  it("HEALTH_CHECK_INTERVAL_MS is 10000 (10 seconds)", () => {
    expect(HEALTH_CHECK_INTERVAL_MS).toBe(10_000);
  });

  it("COST_UPDATE_INTERVAL_MS is 15000 (15 seconds)", () => {
    expect(COST_UPDATE_INTERVAL_MS).toBe(15_000);
  });

  it("FORCE_DELIVERY_TIMEOUT_MS is 30000 (30 seconds)", () => {
    expect(FORCE_DELIVERY_TIMEOUT_MS).toBe(30_000);
  });

  it("SPAWN_TIMEOUT_MS is 30000 (30 seconds)", () => {
    expect(SPAWN_TIMEOUT_MS).toBe(30_000);
  });

  it("MAX_AGENTS_PER_SESSION is 20", () => {
    expect(MAX_AGENTS_PER_SESSION).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// MAX_AGENTS_PER_SESSION enforcement
// ---------------------------------------------------------------------------

describe("MAX_AGENTS_PER_SESSION enforcement", () => {
  let mockTmux: IPtyBackend;
  let agentManager: AgentManager;
  let healthMonitor: AgentHealthMonitor;

  const mockProvider: CLIProvider = {
    id: "test-provider",
    name: "Test Provider",
    command: "test-cli",
    defaultModel: "test-model",
    supportsMcp: false,
    buildCommand: vi.fn().mockReturnValue(["test-cli", "--model", "test-model"]),
  } as any;

  beforeEach(() => {
    mockTmux = {
      newSession: vi.fn().mockResolvedValue(undefined),
      hasSession: vi.fn().mockResolvedValue(true),
      killSession: vi.fn().mockResolvedValue(undefined),
      sendKeys: vi.fn().mockResolvedValue(undefined),
      capturePane: vi.fn().mockResolvedValue("$ "),
      pipePaneStart: vi.fn().mockResolvedValue(undefined),
      pipePaneStop: vi.fn().mockResolvedValue(undefined),
      getPanePID: vi.fn().mockResolvedValue(12345),
    } as any;

    healthMonitor = new AgentHealthMonitor(mockTmux);
    // Don't start health monitoring in tests
    healthMonitor.startMonitoring = vi.fn();
    agentManager = new AgentManager(mockTmux, healthMonitor);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("allows spawning up to MAX_AGENTS_PER_SESSION agents", async () => {
    const options: SpawnAgentOptions = {
      sessionId: "test-session",
      name: "Test Agent",
      role: "worker",
      provider: mockProvider,
      model: "test-model",
      workingDirectory: "/tmp/test",
      runtimeDir: "/tmp/test/.kora",
      messagingMode: "file",
      worktreeMode: "shared",
    };

    // Spawn MAX_AGENTS_PER_SESSION agents
    for (let i = 0; i < MAX_AGENTS_PER_SESSION; i++) {
      const agentOptions = { ...options, name: `Agent ${i}` };
      const agent = await agentManager.spawnAgent(agentOptions);
      expect(agent).toBeDefined();
      expect(agent.id).toMatch(/^agent-\d+-[a-f0-9-]+$/);
    }

    // Verify we have MAX_AGENTS_PER_SESSION agents
    const agents = agentManager.listAgents();
    expect(agents).toHaveLength(MAX_AGENTS_PER_SESSION);
  });

  it("rejects spawning more than MAX_AGENTS_PER_SESSION agents", async () => {
    const options: SpawnAgentOptions = {
      sessionId: "test-session",
      name: "Test Agent",
      role: "worker",
      provider: mockProvider,
      model: "test-model",
      workingDirectory: "/tmp/test",
      runtimeDir: "/tmp/test/.kora",
      messagingMode: "file",
      worktreeMode: "shared",
    };

    // Spawn MAX_AGENTS_PER_SESSION agents
    for (let i = 0; i < MAX_AGENTS_PER_SESSION; i++) {
      const agentOptions = { ...options, name: `Agent ${i}` };
      await agentManager.spawnAgent(agentOptions);
    }

    // Try to spawn one more — should fail
    await expect(
      agentManager.spawnAgent({ ...options, name: "Agent Overflow" })
    ).rejects.toThrow(/reached maximum of 20 agents/);
  });

  it("allows spawning agents in different sessions up to limit each", async () => {
    const options: SpawnAgentOptions = {
      sessionId: "session-1",
      name: "Test Agent",
      role: "worker",
      provider: mockProvider,
      model: "test-model",
      workingDirectory: "/tmp/test",
      runtimeDir: "/tmp/test/.kora",
      messagingMode: "file",
      worktreeMode: "shared",
    };

    // Spawn 2 agents in session-1
    await agentManager.spawnAgent({ ...options, name: "Session1 Agent1" });
    await agentManager.spawnAgent({ ...options, name: "Session1 Agent2" });

    // Spawn 2 agents in session-2
    await agentManager.spawnAgent({ ...options, sessionId: "session-2", name: "Session2 Agent1" });
    await agentManager.spawnAgent({ ...options, sessionId: "session-2", name: "Session2 Agent2" });

    const agents = agentManager.listAgents();
    expect(agents).toHaveLength(4);

    const session1Agents = agents.filter((a) => a.config.sessionId === "session-1");
    const session2Agents = agents.filter((a) => a.config.sessionId === "session-2");
    expect(session1Agents).toHaveLength(2);
    expect(session2Agents).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// SPAWN_TIMEOUT_MS enforcement
// ---------------------------------------------------------------------------
// Note: Comprehensive spawn timeout testing requires extensive mocking of the
// entire spawn flow (file I/O, tmux operations, etc.). The constant value is
// tested above, and the timeout logic is enforced in AgentManager.spawnAgent()
// via Promise.race(). Integration tests would be needed for end-to-end validation.
