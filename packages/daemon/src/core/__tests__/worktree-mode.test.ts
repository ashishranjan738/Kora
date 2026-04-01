import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// Mock uuid
vi.mock("uuid", () => ({
  v4: vi.fn(() => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
}));

// Mock fs/promises
vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("7890"),
    readdir: vi.fn().mockResolvedValue([]),
    rm: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock WorktreeManager
const mockCreateWorktree = vi.fn();
const mockIsGitRepo = vi.fn();
const mockRemoveWorktree = vi.fn();

vi.mock("../worktree.js", () => {
  return {
    WorktreeManager: class MockWorktreeManager {
      createWorktree = mockCreateWorktree;
      isGitRepo = mockIsGitRepo;
      removeWorktree = mockRemoveWorktree;
    },
  };
});

// Mock pty backend
const mockNewSession = vi.fn().mockResolvedValue(undefined);
const mockSendKeys = vi.fn().mockResolvedValue(undefined);
const mockCapturePane = vi.fn().mockResolvedValue("$ ");
const mockHasSession = vi.fn().mockResolvedValue(false);
const mockKillSession = vi.fn().mockResolvedValue(undefined);
const mockPipePaneStart = vi.fn().mockResolvedValue(undefined);
const mockPipePaneStop = vi.fn().mockResolvedValue(undefined);
const mockSetEnvironment = vi.fn().mockResolvedValue(undefined);

// Mock AgentHealthMonitor
const mockStartMonitoring = vi.fn();
const mockStopMonitoring = vi.fn();

vi.mock("../agent-health.js", () => {
  return {
    AgentHealthMonitor: class MockAgentHealthMonitor {
      startMonitoring = mockStartMonitoring;
      stopMonitoring = mockStopMonitoring;
      on = vi.fn();
      emit = vi.fn();
    },
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { AgentManager, SpawnAgentOptions } from "../agent-manager.js";
import { MockPtyBackend } from "../../testing/mock-pty-backend.js";
import { AgentHealthMonitor } from "../agent-health.js";
import { WorktreeManager } from "../worktree.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOptions(overrides: Partial<SpawnAgentOptions> = {}): SpawnAgentOptions {
  return {
    sessionId: "test-session",
    name: "Test Agent",
    role: "worker",
    provider: {
      id: "claude-code",
      displayName: "Claude Code",
      supportsMcp: true,
      supportsHotModelSwap: false,
      buildCommand: () => ["claude"],
      buildSendInput: (msg: string) => msg,
      buildExitCommand: () => "/exit",
      parseOutput: (raw: string) => ({}),
      getModels: () => [],
      allowedExtraArgs: [],
    },
    model: "claude-sonnet-4-6",
    workingDirectory: "/projects/myapp",
    runtimeDir: "/projects/myapp/.kora",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentManager — worktree mode", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.clearAllMocks();
    const backend = new MockPtyBackend();
    backend.newSession = mockNewSession;
    backend.sendKeys = mockSendKeys;
    backend.capturePane = mockCapturePane;
    backend.hasSession = mockHasSession;
    backend.killSession = mockKillSession;
    backend.pipePaneStart = mockPipePaneStart;
    backend.pipePaneStop = mockPipePaneStop;
    backend.setEnvironment = mockSetEnvironment;
    const health = new AgentHealthMonitor({} as any);
    const wt = new WorktreeManager();
    manager = new AgentManager(backend, health, wt);

    // Default: git repo, worktree creation succeeds
    mockIsGitRepo.mockResolvedValue(true);
    mockCreateWorktree.mockResolvedValue("/projects/myapp/.kora/worktrees/test-agent-aaaaaaaa");
  });

  // ---- Default behavior (worktreeMode undefined) ----

  it("creates a worktree when worktreeMode is undefined (default)", async () => {
    const agent = await manager.spawnAgent(makeOptions());

    expect(mockIsGitRepo).toHaveBeenCalledWith("/projects/myapp");
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      "/projects/myapp",
      "/projects/myapp/.kora",
      expect.stringContaining("test-agent-"),
    );
    expect(agent.config.workingDirectory).toBe("/projects/myapp/.kora/worktrees/test-agent-aaaaaaaa");
  });

  it("generates agent ID from slugified name + uuid prefix", async () => {
    const agent = await manager.spawnAgent(makeOptions({ name: "CSS Expert" }));
    expect(agent.id).toMatch(/^css-expert-[a-f0-9]{8}$/);
  });

  it("sets agent status to running after spawn", async () => {
    const agent = await manager.spawnAgent(makeOptions());
    expect(agent.status).toBe("running");
  });

  it("starts health monitoring after spawn", async () => {
    const agent = await manager.spawnAgent(makeOptions());
    expect(mockStartMonitoring).toHaveBeenCalledWith(agent.id, agent.config.terminalSession);
  });

  it("creates a tmux session with correct name", async () => {
    const agent = await manager.spawnAgent(makeOptions());
    expect(mockNewSession).toHaveBeenCalledWith(`kora--test-session-${agent.id}`);
  });

  it("starts pipe-pane for terminal logging", async () => {
    const agent = await manager.spawnAgent(makeOptions());
    expect(mockPipePaneStart).toHaveBeenCalledWith(
      agent.config.terminalSession,
      expect.stringContaining(`${agent.id}.log`),
    );
  });

  it("assigns default worker permissions for worker role", async () => {
    const agent = await manager.spawnAgent(makeOptions({ role: "worker" }));
    expect(agent.config.permissions.canSpawnAgents).toBe(false);
    expect(agent.config.permissions.canRemoveAgents).toBe(false);
  });

  it("assigns master permissions for master role", async () => {
    const agent = await manager.spawnAgent(makeOptions({ role: "master" }));
    expect(agent.config.permissions.canSpawnAgents).toBe(true);
    expect(agent.config.permissions.canRemoveAgents).toBe(true);
  });

  // ---- Explicit worktreeMode "isolated" ----

  it("creates a worktree when worktreeMode is 'isolated'", async () => {
    const agent = await manager.spawnAgent(makeOptions({ worktreeMode: "isolated" }));

    expect(mockCreateWorktree).toHaveBeenCalled();
    expect(agent.config.workingDirectory).toBe("/projects/myapp/.kora/worktrees/test-agent-aaaaaaaa");
  });

  // ---- worktreeMode "shared" ----

  it("does NOT create a worktree when worktreeMode is 'shared'", async () => {
    const agent = await manager.spawnAgent(makeOptions({ worktreeMode: "shared" }));

    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(agent.config.workingDirectory).toBe("/projects/myapp");
  });

  it("multiple agents in shared mode all get the same working directory", async () => {
    const agent1 = await manager.spawnAgent(makeOptions({ worktreeMode: "shared", name: "Agent A" }));
    const agent2 = await manager.spawnAgent(makeOptions({ worktreeMode: "shared", name: "Agent B" }));

    expect(agent1.config.workingDirectory).toBe("/projects/myapp");
    expect(agent2.config.workingDirectory).toBe("/projects/myapp");
    expect(agent1.config.workingDirectory).toBe(agent2.config.workingDirectory);
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  // ---- Non-git repo handling ----

  it("falls back to project directory when not a git repo", async () => {
    mockIsGitRepo.mockResolvedValue(false);

    const agent = await manager.spawnAgent(makeOptions());

    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(agent.config.workingDirectory).toBe("/projects/myapp");
  });

  // ---- Worktree creation failure fallback ----

  it("falls back to project directory when worktree creation fails", async () => {
    mockCreateWorktree.mockRejectedValue(new Error("git worktree add failed"));

    const agent = await manager.spawnAgent(makeOptions());

    expect(mockCreateWorktree).toHaveBeenCalled();
    expect(agent.config.workingDirectory).toBe("/projects/myapp");
  });

  it("still spawns the agent successfully when worktree creation fails", async () => {
    mockCreateWorktree.mockRejectedValue(new Error("git worktree add failed"));

    const agent = await manager.spawnAgent(makeOptions());

    expect(agent.status).toBe("running");
    expect(mockNewSession).toHaveBeenCalled();
    expect(mockStartMonitoring).toHaveBeenCalled();
  });

  // ---- SessionConfig worktreeMode serialization ----

  it("persists worktreeMode in agent config via workingDirectory (isolated)", async () => {
    const agent = await manager.spawnAgent(makeOptions({ worktreeMode: "isolated" }));
    // Agent's workingDirectory should be the worktree path (not project root)
    expect(agent.config.workingDirectory).toContain(".kora/worktrees/");
  });

  it("persists worktreeMode in agent config via workingDirectory (shared)", async () => {
    const agent = await manager.spawnAgent(makeOptions({ worktreeMode: "shared" }));
    // Agent's workingDirectory should be the project root
    expect(agent.config.workingDirectory).toBe("/projects/myapp");
    expect(agent.config.workingDirectory).not.toContain("worktrees");
  });

  // ---- SpawnAgentOptions worktreeMode passthrough ----

  it("passes worktreeMode through SpawnAgentOptions correctly", async () => {
    const opts = makeOptions({ worktreeMode: "shared" });
    expect(opts.worktreeMode).toBe("shared");

    await manager.spawnAgent(opts);
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  it("accepts undefined worktreeMode in SpawnAgentOptions", async () => {
    const opts = makeOptions();
    expect(opts.worktreeMode).toBeUndefined();

    const agent = await manager.spawnAgent(opts);
    // Undefined defaults to isolated behavior
    expect(mockCreateWorktree).toHaveBeenCalled();
    expect(agent.config.workingDirectory).toBe("/projects/myapp/.kora/worktrees/test-agent-aaaaaaaa");
  });

  // ---- Agent listing and retrieval ----

  it("stores spawned agent in internal map and retrieves it", async () => {
    const agent = await manager.spawnAgent(makeOptions());

    const retrieved = manager.getAgent(agent.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(agent.id);
  });

  it("lists all spawned agents", async () => {
    await manager.spawnAgent(makeOptions({ name: "Agent A" }));
    await manager.spawnAgent(makeOptions({ name: "Agent B" }));

    const agents = manager.listAgents();
    expect(agents).toHaveLength(2);
  });
});
