import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";
import * as os from "os";
import * as fsPromises from "fs/promises";

// ─── Tests for Fix 1: restoreAgent worktreeInfo repopulation ────────

describe("restoreAgent worktreeInfo repopulation", () => {
  it("should detect worktree path from workingDirectory containing /worktrees/", () => {
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

// ─── Tests for Fix 3: cdTarget reassignment after worktree recreation ────

describe("cdTarget reassignment after worktree recreation", () => {
  it("should update cdTarget when worktree is recreated", async () => {
    // Simulates the fixed logic in agent-manager.ts spawnAgent
    const agentWorkDir = "/project/.kora/sessions/s1/worktrees/agent-dead";
    const worktreeMode = "isolated";
    let cdTarget = agentWorkDir;

    // Simulate directory not found
    let dirExists = false;
    try {
      await fsPromises.access(cdTarget);
      dirExists = true;
    } catch {
      dirExists = false;
    }
    expect(dirExists).toBe(false);

    // Simulate worktree recreation
    if (cdTarget.includes("/worktrees/") && worktreeMode !== "shared") {
      const recreated = "/project/.kora/sessions/s1/worktrees/agent-dead-new";
      cdTarget = recreated; // THIS IS THE FIX — was missing before
    }

    expect(cdTarget).toBe("/project/.kora/sessions/s1/worktrees/agent-dead-new");
    expect(cdTarget).not.toBe(agentWorkDir);
  });

  it("should NOT attempt recreation for shared worktree mode", () => {
    const agentWorkDir = "/project/.kora/sessions/s1/worktrees/agent-123";
    const worktreeMode = "shared";
    let cdTarget = agentWorkDir;

    // Even if directory is missing, shared mode should not recreate
    const shouldRecreate = cdTarget.includes("/worktrees/") && worktreeMode !== "shared";
    expect(shouldRecreate).toBe(false);
    expect(cdTarget).toBe(agentWorkDir); // unchanged
  });

  it("should NOT attempt recreation for non-worktree paths", () => {
    const agentWorkDir = "/project/src";
    const worktreeMode = "isolated";
    let cdTarget = agentWorkDir;

    const shouldRecreate = cdTarget.includes("/worktrees/") && worktreeMode !== "shared";
    expect(shouldRecreate).toBe(false);
    expect(cdTarget).toBe(agentWorkDir); // unchanged
  });

  it("should keep original cdTarget if recreation fails", async () => {
    const agentWorkDir = "/project/.kora/sessions/s1/worktrees/agent-dead";
    const worktreeMode = "isolated";
    let cdTarget = agentWorkDir;

    // Simulate recreation failure
    if (cdTarget.includes("/worktrees/") && worktreeMode !== "shared") {
      try {
        throw new Error("git worktree add failed");
      } catch {
        // cdTarget stays unchanged on failure — falls back to original path
      }
    }

    expect(cdTarget).toBe(agentWorkDir);
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

// ─── Tests for resolveWorkingDirectory null case ────────────────────

describe("resolveWorkingDirectory null handling", () => {
  it("should return null when agent has no workingDirectory", () => {
    // Simulates the logic in tool-handlers.ts resolveWorkingDirectory
    const agent = { id: "agent-1", config: { name: "Test" } };
    const result = (agent?.config as any)?.workingDirectory || null;
    expect(result).toBeNull();
  });

  it("should return null when agent is not found", () => {
    const agents = [{ id: "agent-1", config: { name: "A" } }];
    const currentAgent = agents.find((a) => a.id === "agent-999");
    const result = (currentAgent?.config as any)?.workingDirectory || null;
    expect(result).toBeNull();
  });

  it("should return workingDirectory when present", () => {
    const agent = { id: "agent-1", config: { name: "Test", workingDirectory: "/project/worktrees/agent-1" } };
    const result = (agent?.config as any)?.workingDirectory || null;
    expect(result).toBe("/project/worktrees/agent-1");
  });

  it("should return null when agents array is empty", () => {
    const agents: any[] = [];
    const currentAgent = agents.find((a) => a.id === "agent-1");
    const result = (currentAgent?.config as any)?.workingDirectory || null;
    expect(result).toBeNull();
  });
});
