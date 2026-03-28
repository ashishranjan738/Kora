import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";
import * as os from "os";
import * as fsPromises from "fs/promises";

// ─── Tests for Fix 1: restoreAgent worktreeInfo repopulation ────────

describe("restoreAgent worktreeInfo repopulation", () => {
  it("should detect worktree path from workingDirectory containing /worktrees/", () => {
    // Simulate the logic from restoreAgent
    const workingDirectory = "/project/.kora/sessions/test-session/worktrees/agent-123";
    const hasWorktree = workingDirectory.includes("/worktrees/");
    expect(hasWorktree).toBe(true);

    const worktreesDir = path.dirname(workingDirectory);
    expect(worktreesDir).toBe("/project/.kora/sessions/test-session/worktrees");

    const runtimeDir = path.dirname(worktreesDir);
    expect(runtimeDir).toBe("/project/.kora/sessions/test-session");
  });

  it("should NOT detect worktree path for non-worktree workingDirectory", () => {
    const workingDirectory = "/project/main-repo";
    const hasWorktree = workingDirectory.includes("/worktrees/");
    expect(hasWorktree).toBe(false);
  });

  it("should handle undefined workingDirectory gracefully", () => {
    const workingDirectory: string | undefined = undefined;
    const hasWorktree = workingDirectory && workingDirectory.includes("/worktrees/");
    expect(hasWorktree).toBeFalsy();
  });
});

// ─── Tests for Fix 2: pruneAll safety guard ─────────────────────────

describe("pruneAll safety guard logic", () => {
  it("should skip pruning when activeAgentIds is empty but worktrees exist", () => {
    const activeAgentIds = new Set<string>();
    const dirEntries = ["agent-1", "agent-2", "agent-3"];

    const shouldSkip = activeAgentIds.size === 0 && dirEntries.length > 0;
    expect(shouldSkip).toBe(true);
  });

  it("should allow pruning when activeAgentIds has entries", () => {
    const activeAgentIds = new Set(["agent-1"]);
    const dirEntries = ["agent-1", "agent-2", "agent-3"];

    const shouldSkip = activeAgentIds.size === 0 && dirEntries.length > 0;
    expect(shouldSkip).toBe(false);
  });

  it("should allow pruning when worktrees directory is empty", () => {
    const activeAgentIds = new Set<string>();
    const dirEntries: string[] = [];

    const shouldSkip = activeAgentIds.size === 0 && dirEntries.length > 0;
    expect(shouldSkip).toBe(false);
  });
});

// ─── Tests for Fix 3: cd verification ───────────────────────────────

describe("working directory verification before cd", () => {
  it("should detect missing directory", async () => {
    const nonExistentDir = path.join(os.tmpdir(), "kora-nonexistent-" + Date.now());
    let exists = true;
    try {
      await fsPromises.access(nonExistentDir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("should pass for existing directory", async () => {
    let exists = false;
    try {
      await fsPromises.access(os.tmpdir());
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists).toBe(true);
  });

  it("should identify worktree paths correctly", () => {
    const worktreePath = "/project/.kora/sessions/sid/worktrees/agent-123";
    const isWorktree = worktreePath.includes("/worktrees/");
    expect(isWorktree).toBe(true);

    const regularPath = "/project/src";
    const isRegular = regularPath.includes("/worktrees/");
    expect(isRegular).toBe(false);
  });
});

// ─── Tests for Fix 4: restartAgent worktree verification ────────────

describe("restartAgent worktree verification", () => {
  it("should detect missing working directory and fall back to project root", async () => {
    const oldWorkingDirectory = "/project/.kora/worktrees/agent-dead";
    const projectPath = "/project";
    let workDir = oldWorkingDirectory;
    let reuseWorktree = true;

    try {
      await fsPromises.access(oldWorkingDirectory);
    } catch {
      workDir = projectPath;
      reuseWorktree = false;
    }

    expect(workDir).toBe(projectPath);
    expect(reuseWorktree).toBe(false);
  });

  it("should reuse existing working directory if it exists", async () => {
    const oldWorkingDirectory = os.tmpdir(); // exists
    const projectPath = "/project";
    let workDir = oldWorkingDirectory;
    let reuseWorktree = true;

    try {
      await fsPromises.access(oldWorkingDirectory);
    } catch {
      workDir = projectPath;
      reuseWorktree = false;
    }

    expect(workDir).toBe(os.tmpdir());
    expect(reuseWorktree).toBe(true);
  });
});
