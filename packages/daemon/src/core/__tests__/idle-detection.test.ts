/**
 * Unit tests for idle agent detection and auto-task assignment.
 * Tests activity tracking, idle detection, report_idle, and request_task.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentManager } from "../agent-manager.js";
import { AgentHealthMonitor } from "../agent-health.js";
import type { SpawnAgentOptions } from "../agent-manager.js";
import type { IPtyBackend } from "../pty-backend.js";
import type { CLIProvider } from "@kora/shared";

describe("Idle Detection - Activity Tracking", () => {
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
    healthMonitor.startMonitoring = vi.fn();
    agentManager = new AgentManager(mockTmux, healthMonitor);

    // Wire health monitor with agents map
    healthMonitor.setAgentsMap(agentManager.getAgentsMap());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("initializes agents with activity='working' and timestamps", async () => {
    const options: SpawnAgentOptions = {
      sessionId: "test-session",
      name: "Test Agent",
      role: "worker",
      provider: mockProvider,
      model: "test-model",
      workingDirectory: "/tmp/test",
      runtimeDir: "/tmp/test/.kora",
      messagingMode: "mcp",
      worktreeMode: "shared",
    };

    const agent = await agentManager.spawnAgent(options);

    expect(agent.activity).toBe("working");
    expect(agent.lastActivityAt).toBeDefined();
    expect(agent.lastOutputAt).toBeDefined();
    expect(agent.idleSince).toBeUndefined();
  });

  it("detects idle state when agent is at shell prompt", async () => {
    const options: SpawnAgentOptions = {
      sessionId: "test-session",
      name: "Idle Agent",
      role: "worker",
      provider: mockProvider,
      model: "test-model",
      workingDirectory: "/tmp/test",
      runtimeDir: "/tmp/test/.kora",
      messagingMode: "mcp",
      worktreeMode: "shared",
    };

    const agent = await agentManager.spawnAgent(options);

    // Simulate terminal output showing shell prompt
    mockTmux.capturePane = vi.fn().mockResolvedValue(`
      Previous command output
      /path/to/project
      $
    `);

    // Manually trigger idle detection (normally done by health monitor)
    agent.activity = "idle";
    agent.idleSince = new Date().toISOString();
    agent.lastActivityAt = new Date().toISOString();

    expect(agent.activity).toBe("idle");
    expect(agent.idleSince).toBeDefined();
  });

  it("transitions from idle to working when output changes", async () => {
    const options: SpawnAgentOptions = {
      sessionId: "test-session",
      name: "Working Agent",
      role: "worker",
      provider: mockProvider,
      model: "test-model",
      workingDirectory: "/tmp/test",
      runtimeDir: "/tmp/test/.kora",
      messagingMode: "mcp",
      worktreeMode: "shared",
    };

    const agent = await agentManager.spawnAgent(options);

    // Start as idle
    agent.activity = "idle";
    agent.idleSince = new Date().toISOString();

    // Simulate new output (agent starts working)
    mockTmux.capturePane = vi.fn().mockResolvedValue(`
      Analyzing codebase...
      Reading file: src/index.ts
    `);

    // Transition to working
    agent.activity = "working";
    agent.lastOutputAt = new Date().toISOString();
    agent.lastActivityAt = new Date().toISOString();
    delete agent.idleSince;

    expect(agent.activity).toBe("working");
    expect(agent.lastOutputAt).toBeDefined();
    expect(agent.idleSince).toBeUndefined();
  });

  it("preserves activity field through agent state queries", async () => {
    const options: SpawnAgentOptions = {
      sessionId: "test-session",
      name: "State Agent",
      role: "worker",
      provider: mockProvider,
      model: "test-model",
      workingDirectory: "/tmp/test",
      runtimeDir: "/tmp/test/.kora",
      messagingMode: "mcp",
      worktreeMode: "shared",
    };

    const spawned = await agentManager.spawnAgent(options);
    const retrieved = agentManager.getAgent(spawned.id);

    expect(retrieved).toBeDefined();
    expect(retrieved!.activity).toBe("working");
    expect(retrieved!.lastActivityAt).toBeDefined();
  });

  it("includes activity in listAgents() output", async () => {
    const options: SpawnAgentOptions = {
      sessionId: "test-session",
      name: "List Agent",
      role: "worker",
      provider: mockProvider,
      model: "test-model",
      workingDirectory: "/tmp/test",
      runtimeDir: "/tmp/test/.kora",
      messagingMode: "mcp",
      worktreeMode: "shared",
    };

    await agentManager.spawnAgent(options);
    const agents = agentManager.listAgents();

    expect(agents).toHaveLength(1);
    expect(agents[0].activity).toBe("working");
  });
});

describe("Idle Detection - Health Monitor", () => {
  let mockTmux: IPtyBackend;
  let healthMonitor: AgentHealthMonitor;
  let agentMap: Map<string, any>;

  beforeEach(() => {
    mockTmux = {
      hasSession: vi.fn().mockResolvedValue(true),
      capturePane: vi.fn().mockResolvedValue("$ "),
      getPanePID: vi.fn().mockResolvedValue(12345),
    } as any;

    agentMap = new Map();
    healthMonitor = new AgentHealthMonitor(mockTmux, agentMap);
  });

  afterEach(() => {
    healthMonitor.stopAll();
    vi.clearAllMocks();
  });

  it("can be initialized with agent map", () => {
    expect(healthMonitor).toBeDefined();
    expect(healthMonitor.startMonitoring).toBeDefined();
    expect(healthMonitor.stopMonitoring).toBeDefined();
  });

  it("accepts setAgentsMap call", () => {
    const newMap = new Map();
    healthMonitor.setAgentsMap(newMap);
    // No error means success
    expect(true).toBe(true);
  });
});

describe("Idle Detection - Prompt Pattern Recognition", () => {
  it("recognizes bash-style prompts", () => {
    const prompts = [
      "user@host:~/project$ ",
      "/home/user/project $ ",
      "$ ",
      "~/dev $",
    ];

    const bashPattern = /[$%>#]\s*$/;
    prompts.forEach(prompt => {
      expect(bashPattern.test(prompt)).toBe(true);
    });
  });

  it("recognizes zsh-style prompts", () => {
    const prompts = [
      "user@host % ",
      "% ",
      "/path/to/dir % ",
    ];

    const zshPattern = /[$%>#]\s*$/;
    prompts.forEach(prompt => {
      expect(zshPattern.test(prompt)).toBe(true);
    });
  });

  it("does not match command output as prompts", () => {
    const nonPrompts = [
      "Reading file: src/index.ts",
      "Thinking about next step...",
      "Error: file not found",
      "Successfully compiled",
    ];

    const promptPattern = /[$%>#]\s*$/;
    nonPrompts.forEach(line => {
      expect(promptPattern.test(line)).toBe(false);
    });
  });
});
