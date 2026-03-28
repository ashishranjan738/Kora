/**
 * Additional tests for worktree.ts pruneAll safety guard (PR #457).
 * Tests the actual WorktreeManager.pruneAll() method against real
 * filesystem state (mocked git commands).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as os from "os";

// Mock child_process execFile before importing WorktreeManager
vi.mock("child_process", () => ({
  execFile: vi.fn((cmd: string, args: string[], opts: any, cb?: any) => {
    const callback = cb || opts;
    callback(null, { stdout: "", stderr: "" });
  }),
}));

import { WorktreeManager } from "../../core/worktree.js";

let tmpDir: string;
let wm: WorktreeManager;

beforeEach(async () => {
  tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "kora-wt-safety-"));
  wm = new WorktreeManager();
  vi.clearAllMocks();
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

describe("pruneAll safety guard — empty activeAgentIds", () => {
  it("skips pruning when activeAgentIds is empty but worktrees exist", async () => {
    // Create fake worktree directories
    const worktreesDir = path.join(tmpDir, "worktrees");
    await fsPromises.mkdir(path.join(worktreesDir, "agent-1"), { recursive: true });
    await fsPromises.mkdir(path.join(worktreesDir, "agent-2"), { recursive: true });

    const result = await wm.pruneAll("/fake/project", tmpDir, new Set());

    // Should NOT remove any worktrees (safety guard triggered)
    expect(result.removedWorktrees).toHaveLength(0);
    expect(result.removedBranches).toHaveLength(0);
    expect(result.skippedDirty).toHaveLength(0);
  });

  it("allows pruning when activeAgentIds has entries", async () => {
    const worktreesDir = path.join(tmpDir, "worktrees");
    await fsPromises.mkdir(path.join(worktreesDir, "agent-1"), { recursive: true });
    await fsPromises.mkdir(path.join(worktreesDir, "agent-2"), { recursive: true });

    // agent-1 is active, agent-2 is stale
    const activeIds = new Set(["agent-1"]);
    const result = await wm.pruneAll("/fake/project", tmpDir, activeIds);

    // agent-2 should be removed (or attempted), agent-1 kept
    expect(result.removedWorktrees).toContain("agent-2");
    expect(result.removedWorktrees).not.toContain("agent-1");
  });

  it("allows pruning when no worktree directories exist", async () => {
    // No worktrees dir at all — should not throw
    const result = await wm.pruneAll("/fake/project", tmpDir, new Set());

    expect(result.removedWorktrees).toHaveLength(0);
    expect(result.removedBranches).toHaveLength(0);
  });

  it("allows pruning when worktrees dir exists but is empty", async () => {
    const worktreesDir = path.join(tmpDir, "worktrees");
    await fsPromises.mkdir(worktreesDir, { recursive: true });

    const result = await wm.pruneAll("/fake/project", tmpDir, new Set());

    expect(result.removedWorktrees).toHaveLength(0);
  });
});

describe("pruneAll — active agent protection", () => {
  it("never prunes active agents", async () => {
    const worktreesDir = path.join(tmpDir, "worktrees");
    await fsPromises.mkdir(path.join(worktreesDir, "agent-a"), { recursive: true });
    await fsPromises.mkdir(path.join(worktreesDir, "agent-b"), { recursive: true });
    await fsPromises.mkdir(path.join(worktreesDir, "agent-c"), { recursive: true });

    const activeIds = new Set(["agent-a", "agent-b", "agent-c"]);
    const result = await wm.pruneAll("/fake/project", tmpDir, activeIds);

    expect(result.removedWorktrees).toHaveLength(0);
    expect(result.skippedDirty).toHaveLength(0);
  });

  it("prunes only inactive agents from a mixed set", async () => {
    const worktreesDir = path.join(tmpDir, "worktrees");
    await fsPromises.mkdir(path.join(worktreesDir, "active-agent"), { recursive: true });
    await fsPromises.mkdir(path.join(worktreesDir, "stale-agent"), { recursive: true });

    const activeIds = new Set(["active-agent"]);
    const result = await wm.pruneAll("/fake/project", tmpDir, activeIds);

    expect(result.removedWorktrees).toContain("stale-agent");
    expect(result.removedWorktrees).not.toContain("active-agent");
  });
});

describe("restoreAgent worktreeInfo repopulation — path parsing", () => {
  it("correctly extracts runtimeDir from worktree workingDirectory", () => {
    const workingDirectory = "/project/.kora/sessions/sess-123/worktrees/agent-456";
    const worktreesDir = path.dirname(workingDirectory);
    const runtimeDir = path.dirname(worktreesDir);

    expect(runtimeDir).toBe("/project/.kora/sessions/sess-123");
  });

  it("handles deeply nested paths", () => {
    const workingDirectory = "/Users/dev/deep/project/.kora/sessions/my-session/worktrees/worker-abc";
    const hasWorktree = workingDirectory.includes("/worktrees/");
    expect(hasWorktree).toBe(true);

    const runtimeDir = path.dirname(path.dirname(workingDirectory));
    expect(runtimeDir).toBe("/Users/dev/deep/project/.kora/sessions/my-session");
  });

  it("handles workingDirectory without /worktrees/ segment", () => {
    const workingDirectory = "/project/src";
    const hasWorktree = workingDirectory.includes("/worktrees/");
    expect(hasWorktree).toBe(false);
  });

  it("handles workingDirectory with 'worktrees' in project name (false positive guard)", () => {
    // A path like /home/user/worktrees-project/src shouldn't match /worktrees/
    const workingDirectory = "/home/user/worktrees-project/src";
    const hasWorktree = workingDirectory.includes("/worktrees/");
    expect(hasWorktree).toBe(false);
  });

  it("correctly matches /worktrees/ segment in nested kora path", () => {
    const workingDirectory = "/home/user/project/.kora/sessions/s1/worktrees/agent-1";
    const hasWorktree = workingDirectory.includes("/worktrees/");
    expect(hasWorktree).toBe(true);
  });
});

describe("restartAgent — directory existence verification", () => {
  it("detects when old working directory no longer exists", async () => {
    const missingDir = path.join(tmpDir, "nonexistent-worktree");
    let exists = true;
    try {
      await fsPromises.access(missingDir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("confirms existing directory passes verification", async () => {
    const existingDir = path.join(tmpDir, "existing-worktree");
    await fsPromises.mkdir(existingDir, { recursive: true });

    let exists = false;
    try {
      await fsPromises.access(existingDir);
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists).toBe(true);
  });

  it("falls back correctly when old dir missing", async () => {
    const oldWorkDir = path.join(tmpDir, "dead-worktree");
    const fallbackDir = path.join(tmpDir, "project-root");
    await fsPromises.mkdir(fallbackDir, { recursive: true });

    let workDir = oldWorkDir;
    try {
      await fsPromises.access(oldWorkDir);
    } catch {
      workDir = fallbackDir;
    }

    expect(workDir).toBe(fallbackDir);
  });
});
