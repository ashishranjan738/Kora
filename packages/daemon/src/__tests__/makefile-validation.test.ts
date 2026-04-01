import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

describe("Makefile validation", () => {
  // In git worktrees, __dirname points to the worktree which may not have node_modules.
  // Find the main repo root where node_modules actually lives.
  const worktreeRoot = path.resolve(__dirname, "../../../../");
  const repoRoot = (() => {
    // Check if worktree root has real npm packages (not just .vite cache)
    if (fs.existsSync(path.join(worktreeRoot, "node_modules", "vitest"))) return worktreeRoot;
    try {
      // In a git worktree, git-common-dir points to the main repo's .git
      const commonDir = execSync("git rev-parse --git-common-dir", {
        cwd: worktreeRoot,
        encoding: "utf-8",
      }).trim();
      const mainRoot = path.resolve(worktreeRoot, commonDir, "..");
      if (fs.existsSync(path.join(mainRoot, "node_modules"))) return mainRoot;
    } catch { /* ignore */ }
    return worktreeRoot;
  })();

  // Test 1: Verify Makefile has install target
  it("has install target", () => {
    const makefilePath = path.join(repoRoot, "Makefile");

    expect(fs.existsSync(makefilePath)).toBe(true);

    const makefileContent = fs.readFileSync(makefilePath, "utf-8");

    // Verify install target exists
    expect(makefileContent).toContain("install:");
    expect(makefileContent).toContain("npm install");
  });

  // Test 2: Verify node-pty is available at top level
  it("has node-pty available at top level after make install", () => {
    const topLevelNodePtyPath = path.join(
      repoRoot,
      "node_modules",
      "node-pty"
    );

    // node-pty should be installed at the top level
    const topLevelExists = fs.existsSync(topLevelNodePtyPath);

    expect(topLevelExists).toBe(true);
  });
});
