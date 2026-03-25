/**
 * Unit tests for holdpty stale session auto-cleanup.
 *
 * Tests orphaned session detection, killing, prefix filtering,
 * error handling, and edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanupOrphanedSessions } from "../holdpty-cleanup.js";
import type { IPtyBackend } from "../pty-backend.js";
import type { AgentState } from "@kora/shared";

// ---------------------------------------------------------------------------
// Mock PTY backend
// ---------------------------------------------------------------------------

function createMockPty(sessions: string[]): IPtyBackend {
  return {
    listSessions: vi.fn().mockResolvedValue(sessions),
    killSession: vi.fn().mockResolvedValue(undefined),
    newSession: vi.fn().mockResolvedValue(undefined),
    hasSession: vi.fn().mockResolvedValue(true),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    sendRawInput: vi.fn().mockResolvedValue(undefined),
    capturePane: vi.fn().mockResolvedValue(""),
    setEnvironment: vi.fn().mockResolvedValue(undefined),
    pipePaneStart: vi.fn().mockResolvedValue(undefined),
    pipePaneStop: vi.fn().mockResolvedValue(undefined),
    getPanePID: vi.fn().mockResolvedValue(null),
    run_raw: vi.fn().mockResolvedValue(""),
    getAttachCommand: vi.fn().mockReturnValue({ command: "holdpty", args: ["attach", "x"] }),
  };
}

function createAgent(terminalSession: string): AgentState {
  return {
    id: `agent-${Math.random().toString(36).slice(2, 8)}`,
    status: "running",
    config: {
      name: "Test Agent",
      sessionId: "test-session",
      role: "worker",
      cliProvider: "claude-code",
      model: "claude-sonnet-4-6",
      permissions: { canSpawnAgents: false, canStopAgents: false, canAccessTerminal: true, canEditFiles: true, maxSubAgents: 0 },
      persona: "",
      terminalSession,
      worktreeDir: "/tmp",
      extraCliArgs: [],
    },
    healthCheck: {
      alive: true,
      lastCheck: Date.now(),
      consecutiveFailures: 0,
    },
    spawnedAt: new Date().toISOString(),
    cost: { inputTokens: 0, outputTokens: 0, totalCostUsd: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  } as AgentState;
}

const PREFIX = "kora-dev--";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cleanupOrphanedSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("no orphans", () => {
    it("returns zero cleanup when no sessions exist", async () => {
      const pty = createMockPty([]);

      const result = await cleanupOrphanedSessions(pty, [], PREFIX);

      expect(result.totalSessions).toBe(0);
      expect(result.orphanedKilled).toBe(0);
      expect(result.killedNames).toEqual([]);
      expect(pty.killSession).not.toHaveBeenCalled();
    });

    it("returns zero cleanup when all sessions have matching agents", async () => {
      const sessions = [
        "kora-dev--session1-agent-abc123",
        "kora-dev--session1-agent-def456",
      ];
      const agents = [
        createAgent("kora-dev--session1-agent-abc123"),
        createAgent("kora-dev--session1-agent-def456"),
      ];
      const pty = createMockPty(sessions);

      const result = await cleanupOrphanedSessions(pty, agents, PREFIX);

      expect(result.totalSessions).toBe(2);
      expect(result.knownSessions).toBe(2);
      expect(result.orphanedKilled).toBe(0);
      expect(pty.killSession).not.toHaveBeenCalled();
    });
  });

  describe("orphan detection and killing", () => {
    it("kills sessions with no matching agent", async () => {
      const sessions = [
        "kora-dev--session1-agent-abc123",
        "kora-dev--session1-agent-orphan1",
        "kora-dev--session1-agent-orphan2",
      ];
      const agents = [
        createAgent("kora-dev--session1-agent-abc123"),
      ];
      const pty = createMockPty(sessions);

      const result = await cleanupOrphanedSessions(pty, agents, PREFIX);

      expect(result.totalSessions).toBe(3);
      expect(result.knownSessions).toBe(1);
      expect(result.orphanedKilled).toBe(2);
      expect(result.killedNames).toContain("kora-dev--session1-agent-orphan1");
      expect(result.killedNames).toContain("kora-dev--session1-agent-orphan2");
      expect(pty.killSession).toHaveBeenCalledTimes(2);
    });

    it("kills all sessions when no agents exist", async () => {
      const sessions = [
        "kora-dev--session1-agent-abc123",
        "kora-dev--session1-agent-def456",
      ];
      const pty = createMockPty(sessions);

      const result = await cleanupOrphanedSessions(pty, [], PREFIX);

      expect(result.orphanedKilled).toBe(2);
      expect(pty.killSession).toHaveBeenCalledTimes(2);
    });
  });

  describe("prefix filtering", () => {
    it("ignores sessions without the kora prefix", async () => {
      const sessions = [
        "kora-dev--session1-agent-abc123",
        "some-other-session",
        "my-tmux-window",
        "kora-dev--orphan",
      ];
      const agents = [
        createAgent("kora-dev--session1-agent-abc123"),
      ];
      const pty = createMockPty(sessions);

      const result = await cleanupOrphanedSessions(pty, agents, PREFIX);

      // Only 2 kora-prefixed sessions
      expect(result.totalSessions).toBe(2);
      // Only the orphaned one killed
      expect(result.orphanedKilled).toBe(1);
      expect(result.killedNames).toEqual(["kora-dev--orphan"]);
      // Non-kora sessions untouched
      expect(pty.killSession).not.toHaveBeenCalledWith("some-other-session");
      expect(pty.killSession).not.toHaveBeenCalledWith("my-tmux-window");
    });

    it("uses prod prefix correctly", async () => {
      const sessions = [
        "kora--prod-agent-1",
        "kora-dev--dev-agent-1",
      ];
      const pty = createMockPty(sessions);

      // Using prod prefix — only kora-- sessions should be considered
      const result = await cleanupOrphanedSessions(pty, [], "kora--");

      expect(result.totalSessions).toBe(1);
      expect(result.orphanedKilled).toBe(1);
      expect(result.killedNames).toEqual(["kora--prod-agent-1"]);
    });

    it("dev prefix does not match prod sessions", async () => {
      const sessions = [
        "kora--prod-agent-1",
        "kora-dev--dev-agent-1",
      ];
      const pty = createMockPty(sessions);

      const result = await cleanupOrphanedSessions(pty, [], "kora-dev--");

      expect(result.totalSessions).toBe(1);
      expect(result.killedNames).toEqual(["kora-dev--dev-agent-1"]);
    });
  });

  describe("error handling", () => {
    it("handles listSessions failure gracefully", async () => {
      const pty = createMockPty([]);
      (pty.listSessions as any).mockRejectedValue(new Error("socket error"));

      const result = await cleanupOrphanedSessions(pty, [], PREFIX);

      expect(result.totalSessions).toBe(0);
      expect(result.orphanedKilled).toBe(0);
    });

    it("continues killing other orphans if one killSession fails", async () => {
      const sessions = [
        "kora-dev--orphan1",
        "kora-dev--orphan2",
        "kora-dev--orphan3",
      ];
      const pty = createMockPty(sessions);
      (pty.killSession as any)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("kill failed"))
        .mockResolvedValueOnce(undefined);

      const result = await cleanupOrphanedSessions(pty, [], PREFIX);

      // Still attempted all 3
      expect(pty.killSession).toHaveBeenCalledTimes(3);
      // 2 succeeded, 1 failed (but we count the attempt)
      expect(result.orphanedKilled).toBe(2);
    });
  });

  describe("mixed sessions (known + orphaned + non-kora)", () => {
    it("correctly handles a realistic mix", async () => {
      const sessions = [
        "kora-dev--main-test-architect-abc123",  // known
        "kora-dev--main-test-frontend-def456",   // known
        "kora-dev--main-test-backend-ghi789",    // orphaned (no agent)
        "kora-dev--old-session-agent-zzz000",    // orphaned (old session)
        "user-tmux-window",                       // non-kora (ignored)
        "dev-tools",                              // non-kora (ignored)
      ];
      const agents = [
        createAgent("kora-dev--main-test-architect-abc123"),
        createAgent("kora-dev--main-test-frontend-def456"),
      ];
      const pty = createMockPty(sessions);

      const result = await cleanupOrphanedSessions(pty, agents, PREFIX);

      expect(result.totalSessions).toBe(4);     // 4 kora-prefixed
      expect(result.knownSessions).toBe(2);      // 2 matched agents
      expect(result.orphanedKilled).toBe(2);     // 2 orphaned killed
      expect(result.killedNames).toContain("kora-dev--main-test-backend-ghi789");
      expect(result.killedNames).toContain("kora-dev--old-session-agent-zzz000");
    });
  });

  describe("dead agents still count as known", () => {
    it("does not kill sessions for crashed agents (they might be restarted)", async () => {
      const sessions = [
        "kora-dev--session1-agent-abc123",
      ];
      const agent = createAgent("kora-dev--session1-agent-abc123");
      agent.status = "crashed";
      const pty = createMockPty(sessions);

      const result = await cleanupOrphanedSessions(pty, [agent], PREFIX);

      expect(result.knownSessions).toBe(1);
      expect(result.orphanedKilled).toBe(0);
      expect(pty.killSession).not.toHaveBeenCalled();
    });

    it("does not kill sessions for stopped agents", async () => {
      const sessions = [
        "kora-dev--session1-agent-abc123",
      ];
      const agent = createAgent("kora-dev--session1-agent-abc123");
      agent.status = "stopped";
      const pty = createMockPty(sessions);

      const result = await cleanupOrphanedSessions(pty, [agent], PREFIX);

      expect(result.knownSessions).toBe(1);
      expect(result.orphanedKilled).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Second test suite: HoldptyController killSession cleanup
// ---------------------------------------------------------------------------

import { HoldptyController } from "../holdpty-controller.js";
import fs from "fs";
import os from "os";
import path from "path";

describe("HoldptyController — killSession cleanup", () => {
  let controller: HoldptyController;
  let tmpDir: string;
  let sessionName: string;

  beforeEach(() => {
    controller = new HoldptyController();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "holdpty-cleanup-test-"));
    sessionName = `test-session-${Math.random().toString(36).slice(2, 10)}`;

    // Set HOLDPTY_DIR to use tmpDir for this test
    process.env.HOLDPTY_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.HOLDPTY_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Cleanup best-effort
    }
  });

  it("should clean up socket and metadata files after killSession", async () => {
    // First, create a real holdpty session so socket files exist
    await controller.newSession(sessionName);

    // Get the actual socket path that holdpty uses
    const platform = await import("holdpty/dist/platform.js");
    const sessionDir = platform.getSessionDir();
    const socketPath = platform.socketPath(sessionDir, sessionName);
    const metadataPath = socketPath.replace(/\.sock$/, ".json");

    // Verify session was created and files exist
    expect(fs.existsSync(socketPath)).toBe(true);

    // Kill session (will call holdpty stop + manual cleanup)
    await controller.killSession(sessionName);

    // Verify files are deleted
    expect(fs.existsSync(socketPath)).toBe(false);
    if (fs.existsSync(metadataPath)) {
      // Metadata might not exist depending on holdpty version
      expect(fs.existsSync(metadataPath)).toBe(false);
    }
  });

  it("should not throw if socket files don't exist", async () => {
    // killSession should handle missing files gracefully
    await expect(controller.killSession(sessionName)).resolves.not.toThrow();
  });

  it("should log debug messages during cleanup", async () => {
    // Create a real holdpty session
    await controller.newSession(sessionName);

    // Get actual paths
    const platform = await import("holdpty/dist/platform.js");
    const sessionDir = platform.getSessionDir();
    const socketPath = platform.socketPath(sessionDir, sessionName);

    // Spy on logger to verify messages
    const { logger } = await import("../logger.js");
    const debugSpy = vi.spyOn(logger, "debug");

    await controller.killSession(sessionName);

    // Verify debug logs were called
    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName }),
      expect.stringContaining("Attempting manual cleanup")
    );

    // Note: holdpty stop might have already deleted the files, so we might see
    // either "Deleted" or "Failed to delete" (ENOENT)
    const calls = debugSpy.mock.calls.map(c => c[1]);
    const hasSocketLog = calls.some(msg =>
      typeof msg === "string" &&
      (msg.includes("Deleted socket file") || msg.includes("Failed to delete socket file"))
    );
    expect(hasSocketLog).toBe(true);

    debugSpy.mockRestore();
  });

  it("should log error if socket deletion fails", async () => {
    const socketPath = path.join(tmpDir, `${sessionName}.sock`);

    // Create socket with read-only parent directory to force deletion failure
    const readOnlyDir = path.join(tmpDir, "readonly");
    fs.mkdirSync(readOnlyDir);
    const readOnlySocket = path.join(readOnlyDir, `${sessionName}.sock`);
    fs.writeFileSync(readOnlySocket, "");
    fs.chmodSync(readOnlyDir, 0o444); // read-only

    // Override HOLDPTY_DIR to point to readonly dir
    process.env.HOLDPTY_DIR = readOnlyDir;

    const { logger } = await import("../logger.js");
    const debugSpy = vi.spyOn(logger, "debug");

    await controller.killSession(sessionName);

    // Verify error was logged
    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName }),
      expect.stringContaining("Failed to delete socket file")
    );

    debugSpy.mockRestore();

    // Cleanup
    fs.chmodSync(readOnlyDir, 0o755);
    delete process.env.HOLDPTY_DIR;
  });

  it("should handle getSocketPath failure gracefully", async () => {
    // Corrupt HOLDPTY_DIR to make getSocketPath fail
    process.env.HOLDPTY_DIR = "/nonexistent/invalid/path";

    const { logger } = await import("../logger.js");
    const warnSpy = vi.spyOn(logger, "warn");

    // Should not throw even if getSocketPath fails
    await expect(controller.killSession(sessionName)).resolves.not.toThrow();

    // Verify warning was logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName }),
      expect.stringContaining("getSocketPath failed during cleanup")
    );

    warnSpy.mockRestore();
  });
});
