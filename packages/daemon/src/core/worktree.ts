import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";

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
}

export const worktreeManager = new WorktreeManager();
