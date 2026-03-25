import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockUuidV4 = vi.fn()
  .mockReturnValueOnce("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
  .mockReturnValueOnce("11111111-2222-3333-4444-555555555555")
  .mockReturnValue("99999999-8888-7777-6666-555555555555");

vi.mock("uuid", () => ({
  v4: (...args: any[]) => mockUuidV4(...args),
}));

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("7890"),
    readdir: vi.fn().mockResolvedValue([]),
    rm: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockCreateWorktree = vi.fn();
const mockIsGitRepo = vi.fn();
const mockRemoveWorktree = vi.fn();

vi.mock("../worktree.js", () => ({
  WorktreeManager: class MockWorktreeManager {
    createWorktree = mockCreateWorktree;
    isGitRepo = mockIsGitRepo;
    removeWorktree = mockRemoveWorktree;
  },
}));

const mockNewSession = vi.fn().mockResolvedValue(undefined);
const mockSendKeys = vi.fn().mockResolvedValue(undefined);
const mockCapturePane = vi.fn().mockResolvedValue("$ ");
const mockHasSession = vi.fn().mockResolvedValue(false);
const mockKillSession = vi.fn().mockResolvedValue(undefined);
const mockPipePaneStart = vi.fn().mockResolvedValue(undefined);
const mockPipePaneStop = vi.fn().mockResolvedValue(undefined);
const mockSetEnvironment = vi.fn().mockResolvedValue(undefined);

vi.mock("../tmux-controller.js", () => ({
  TmuxController: class MockTmuxController {
    newSession = mockNewSession;
    sendKeys = mockSendKeys;
    capturePane = mockCapturePane;
    hasSession = mockHasSession;
    killSession = mockKillSession;
    pipePaneStart = mockPipePaneStart;
    pipePaneStop = mockPipePaneStop;
    setEnvironment = mockSetEnvironment;
  },
}));

const mockStartMonitoring = vi.fn();
const mockStopMonitoring = vi.fn();

vi.mock("../agent-health.js", () => ({
  AgentHealthMonitor: class MockAgentHealthMonitor {
    startMonitoring = mockStartMonitoring;
    stopMonitoring = mockStopMonitoring;
    on = vi.fn();
    emit = vi.fn();
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { AgentManager, SpawnAgentOptions } from "../agent-manager.js";
import { TmuxController } from "../tmux-controller.js";
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

describe("Restart vs Replace agent lifecycle", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUuidV4.mockReset();
    mockUuidV4
      .mockReturnValueOnce("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
      .mockReturnValueOnce("11111111-2222-3333-4444-555555555555")
      .mockReturnValue("99999999-8888-7777-6666-555555555555");

    const tmux = new TmuxController();
    const health = new AgentHealthMonitor({} as any);
    const wt = new WorktreeManager();
    manager = new AgentManager(tmux, health, wt);

    mockIsGitRepo.mockResolvedValue(true);
    mockCreateWorktree.mockResolvedValue("/projects/myapp/.kora/worktrees/test-agent-aaaaaaaa");
  });

  // ─── forceAgentId ─────────────────────────────────────────────

  describe("forceAgentId option in spawnAgent", () => {
    it("uses the forced agent ID instead of generating a new one", async () => {
      const agent = await manager.spawnAgent(makeOptions({
        forceAgentId: "my-custom-agent-id",
      }));

      expect(agent.id).toBe("my-custom-agent-id");
    });

    it("generates a new ID when forceAgentId is not provided", async () => {
      const agent = await manager.spawnAgent(makeOptions());

      expect(agent.id).toMatch(/^test-agent-[a-f0-9]{8}$/);
    });

    it("preserves forced ID in the agent config", async () => {
      const agent = await manager.spawnAgent(makeOptions({
        forceAgentId: "preserved-id-12345678",
      }));

      expect(agent.config.terminalSession).toContain("preserved-id-12345678");
    });
  });

  // ─── skipWorktreeRemoval ──────────────────────────────────────

  describe("skipWorktreeRemoval option in stopAgent", () => {
    it("removes worktree by default when stopping an agent", async () => {
      const agent = await manager.spawnAgent(makeOptions());

      mockHasSession.mockResolvedValue(false);
      await manager.stopAgent(agent.id, "test stop");

      expect(mockRemoveWorktree).toHaveBeenCalled();
    });

    it("preserves worktree when skipWorktreeRemoval is true", async () => {
      const agent = await manager.spawnAgent(makeOptions());

      mockHasSession.mockResolvedValue(false);
      await manager.stopAgent(agent.id, "restart mode", undefined, { skipWorktreeRemoval: true });

      expect(mockRemoveWorktree).not.toHaveBeenCalled();
    });

    it("still kills the terminal session when skipWorktreeRemoval is true", async () => {
      const agent = await manager.spawnAgent(makeOptions());

      mockHasSession.mockResolvedValue(false);
      await manager.stopAgent(agent.id, "restart", undefined, { skipWorktreeRemoval: true });

      expect(mockKillSession).toHaveBeenCalled();
    });

    it("still stops health monitoring when skipWorktreeRemoval is true", async () => {
      const agent = await manager.spawnAgent(makeOptions());

      mockHasSession.mockResolvedValue(false);
      await manager.stopAgent(agent.id, "restart", undefined, { skipWorktreeRemoval: true });

      expect(mockStopMonitoring).toHaveBeenCalledWith(agent.id);
    });

    it("removes agent from internal map when skipWorktreeRemoval is true", async () => {
      const agent = await manager.spawnAgent(makeOptions());

      mockHasSession.mockResolvedValue(false);
      await manager.stopAgent(agent.id, "restart", undefined, { skipWorktreeRemoval: true });

      expect(manager.getAgent(agent.id)).toBeUndefined();
    });
  });

  // ─── Restart flow (same ID, preserved worktree) ────────────────

  describe("restart flow — same ID preserved", () => {
    it("can spawn a new agent with the same ID after stop with skipWorktreeRemoval", async () => {
      const originalAgent = await manager.spawnAgent(makeOptions());
      const originalId = originalAgent.id;

      // Stop but preserve worktree
      mockHasSession.mockResolvedValue(false);
      await manager.stopAgent(originalId, "restart", undefined, { skipWorktreeRemoval: true });

      // Re-spawn with same ID
      mockCreateWorktree.mockResolvedValue("/projects/myapp/.kora/worktrees/" + originalId);
      const restartedAgent = await manager.spawnAgent(makeOptions({
        forceAgentId: originalId,
        worktreeMode: "shared",
      }));

      expect(restartedAgent.id).toBe(originalId);
      expect(restartedAgent.status).toBe("running");
    });

    it("restarted agent gets new health monitoring", async () => {
      const agent = await manager.spawnAgent(makeOptions());
      const agentId = agent.id;

      mockHasSession.mockResolvedValue(false);
      await manager.stopAgent(agentId, "restart", undefined, { skipWorktreeRemoval: true });

      vi.clearAllMocks(); // Clear to isolate restart monitoring

      await manager.spawnAgent(makeOptions({
        forceAgentId: agentId,
        worktreeMode: "shared",
      }));

      expect(mockStartMonitoring).toHaveBeenCalledWith(agentId, expect.any(String));
    });
  });

  // ─── Replace flow (new ID, worktree deleted) ──────────────────

  describe("replace flow — new ID, clean slate", () => {
    it("stopAgent without skipWorktreeRemoval removes the worktree", async () => {
      const agent = await manager.spawnAgent(makeOptions());

      mockHasSession.mockResolvedValue(false);
      await manager.stopAgent(agent.id, "replaced");

      expect(mockRemoveWorktree).toHaveBeenCalled();
    });

    it("spawning after replace generates a new agent ID", async () => {
      const originalAgent = await manager.spawnAgent(makeOptions());
      const originalId = originalAgent.id;

      mockHasSession.mockResolvedValue(false);
      await manager.stopAgent(originalId, "replaced");

      // Spawn fresh (no forceAgentId)
      mockCreateWorktree.mockResolvedValue("/projects/myapp/.kora/worktrees/test-agent-11111111");
      const replacedAgent = await manager.spawnAgent(makeOptions());

      expect(replacedAgent.id).not.toBe(originalId);
      expect(replacedAgent.id).toMatch(/^test-agent-[a-f0-9]{8}$/);
    });
  });

  // ─── restart-all endpoint behavior ────────────────────────────

  describe("restart-all — all agents keep IDs", () => {
    it("can restart multiple agents preserving their IDs", async () => {
      // Spawn two agents
      mockUuidV4.mockReset();
      mockUuidV4
        .mockReturnValueOnce("aaaa1111-0000-0000-0000-000000000000")
        .mockReturnValueOnce("bbbb2222-0000-0000-0000-000000000000")
        .mockReturnValue("cccc3333-0000-0000-0000-000000000000");

      mockCreateWorktree
        .mockResolvedValueOnce("/projects/myapp/.kora/worktrees/agent-a-aaaa1111")
        .mockResolvedValueOnce("/projects/myapp/.kora/worktrees/agent-b-bbbb2222");

      const agentA = await manager.spawnAgent(makeOptions({ name: "Agent A" }));
      const agentB = await manager.spawnAgent(makeOptions({ name: "Agent B" }));

      const idA = agentA.id;
      const idB = agentB.id;

      // Restart both (stop with skipWorktreeRemoval, respawn with forceAgentId)
      mockHasSession.mockResolvedValue(false);
      await manager.stopAgent(idA, "restart-all", undefined, { skipWorktreeRemoval: true });
      await manager.stopAgent(idB, "restart-all", undefined, { skipWorktreeRemoval: true });

      mockCreateWorktree
        .mockResolvedValueOnce("/projects/myapp/.kora/worktrees/" + idA)
        .mockResolvedValueOnce("/projects/myapp/.kora/worktrees/" + idB);

      const restartedA = await manager.spawnAgent(makeOptions({
        name: "Agent A",
        forceAgentId: idA,
        worktreeMode: "shared",
      }));
      const restartedB = await manager.spawnAgent(makeOptions({
        name: "Agent B",
        forceAgentId: idB,
        worktreeMode: "shared",
      }));

      expect(restartedA.id).toBe(idA);
      expect(restartedB.id).toBe(idB);
      expect(restartedA.status).toBe("running");
      expect(restartedB.status).toBe("running");

      // Worktrees should NOT have been removed
      expect(mockRemoveWorktree).not.toHaveBeenCalled();
    });
  });
});
