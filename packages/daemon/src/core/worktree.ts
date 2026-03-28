import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

export class WorktreeManager {
  /**
   * Check if a directory is inside a git repository.
   */
  async isGitRepo(dir: string): Promise<boolean> {
    try {
      await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a git worktree for an agent.
   * Creates a new branch and worktree at: {runtimeDir}/worktrees/{agentId}
   * Branch name: agent/{agentId}
   * Returns the worktree path.
   */
  async createWorktree(projectPath: string, runtimeDir: string, agentId: string): Promise<string> {
    const worktreesDir = path.join(runtimeDir, "worktrees");
    await fs.mkdir(worktreesDir, { recursive: true });

    const worktreePath = path.join(worktreesDir, agentId);
    const branchName = `agent/${agentId}`;

    await execFileAsync("git", ["worktree", "add", worktreePath, "-b", branchName], {
      cwd: projectPath,
    });

    return path.resolve(worktreePath);
  }

  /**
   * Remove a git worktree for an agent.
   * Removes the worktree and deletes the branch.
   */
  async removeWorktree(projectPath: string, runtimeDir: string, agentId: string): Promise<void> {
    const worktreePath = path.join(runtimeDir, "worktrees", agentId);
    const branchName = `agent/${agentId}`;

    try {
      await execFileAsync("git", ["worktree", "remove", worktreePath, "--force"], {
        cwd: projectPath,
      });
    } catch {
      // Worktree might not exist; ignore errors
    }

    try {
      await execFileAsync("git", ["branch", "-D", branchName], {
        cwd: projectPath,
      });
    } catch {
      // Branch might not exist; ignore errors
    }
  }

  /**
   * List all agent worktrees in a project.
   */
  async listWorktrees(projectPath: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
        cwd: projectPath,
      });

      const worktrees: string[] = [];
      for (const line of stdout.split("\n")) {
        if (line.startsWith("worktree ")) {
          const worktreePath = line.slice("worktree ".length).trim();
          worktrees.push(worktreePath);
        }
      }

      return worktrees;
    } catch {
      return [];
    }
  }

  /**
   * Prune ALL stale worktrees and branches for a project.
   * Uses filesystem scan as source of truth (not in-memory maps).
   * Safe: skips worktrees with uncommitted changes.
   *
   * @param projectPath - Root git project path
   * @param runtimeDir - Session runtime directory containing worktrees/
   * @param activeAgentIds - Set of agent IDs that are currently running (won't be pruned)
   */
  async pruneAll(projectPath: string, runtimeDir: string, activeAgentIds: Set<string>): Promise<{
    removedWorktrees: string[];
    removedBranches: string[];
    skippedDirty: string[];
    prunedGit: boolean;
  }> {
    const result = {
      removedWorktrees: [] as string[],
      removedBranches: [] as string[],
      skippedDirty: [] as string[],
      prunedGit: false,
    };

    // 1. Scan worktrees directory for orphaned directories
    const worktreesDir = path.join(runtimeDir, "worktrees");
    try {
      const entries = await fs.readdir(worktreesDir, { withFileTypes: true });
      const dirEntries = entries.filter(e => e.isDirectory());

      // Safety guard: if activeAgentIds is empty but worktrees exist, skip pruning.
      // This prevents a race condition where orchestrators haven't registered yet,
      // causing all worktrees to be incorrectly pruned.
      if (activeAgentIds.size === 0 && dirEntries.length > 0) {
        logger.warn(
          `[worktree] Skipping worktree prune — activeIds empty but ${dirEntries.length} worktrees exist (possible race)`,
        );
        return result;
      }

      for (const entry of dirEntries) {
        const agentId = entry.name;

        // Skip active agents
        if (activeAgentIds.has(agentId)) continue;

        // Safety: check for uncommitted changes before removing
        const worktreePath = path.join(worktreesDir, agentId);
        try {
          const { stdout: diffOutput } = await execFileAsync(
            "git", ["diff", "--stat"],
            { cwd: worktreePath },
          );
          if (diffOutput.trim().length > 0) {
            result.skippedDirty.push(agentId);
            continue; // Don't remove worktrees with uncommitted changes
          }
        } catch {
          // If git diff fails (e.g. corrupt worktree), proceed with removal
        }

        // Remove worktree + branch
        try {
          await this.removeWorktree(projectPath, runtimeDir, agentId);
          result.removedWorktrees.push(agentId);
        } catch {
          // Best effort — try to remove the directory directly as fallback
          try {
            await fs.rm(worktreePath, { recursive: true, force: true });
            result.removedWorktrees.push(agentId);
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      // worktrees dir may not exist — that's fine
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    // 2. Run git worktree prune (cleans git's internal tracking)
    try {
      await execFileAsync("git", ["worktree", "prune"], { cwd: projectPath });
      result.prunedGit = true;
    } catch { /* non-fatal */ }

    // 3. Clean stale agent/* branches that don't match active agents
    try {
      const { stdout } = await execFileAsync(
        "git", ["branch", "--list", "agent/*"],
        { cwd: projectPath },
      );
      const branches = stdout.split("\n").map(b => b.trim().replace(/^\*\s*/, "")).filter(Boolean);
      for (const branch of branches) {
        const agentId = branch.replace("agent/", "");
        if (!activeAgentIds.has(agentId)) {
          try {
            await execFileAsync("git", ["branch", "-D", branch], { cwd: projectPath });
            result.removedBranches.push(branch);
          } catch { /* branch may be checked out — skip */ }
        }
      }
    } catch { /* non-fatal */ }

    return result;
  }
}

export const worktreeManager = new WorktreeManager();
