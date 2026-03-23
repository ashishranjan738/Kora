/**
 * Tests for GET /browse/directories endpoint logic and validateProjectPath utility.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { validateProjectPath, isHiddenDirectory, DEFAULT_HIDDEN_PATTERNS } from "../../core/path-validation.js";

describe("validateProjectPath", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-validate-path-"));
    fs.mkdirSync(path.join(tmpDir, "project"));
    fs.mkdirSync(path.join(tmpDir, "git-project", ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello");
    fs.mkdirSync(path.join(tmpDir, "worktree-project"));
    fs.writeFileSync(path.join(tmpDir, "worktree-project", ".git"), "gitdir: /some/path");
    try {
      fs.symlinkSync(path.join(tmpDir, "project"), path.join(tmpDir, "link-to-project"));
    } catch {
      // symlink creation may fail on some systems
    }
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("validates a valid directory", () => {
    const result = validateProjectPath(path.join(tmpDir, "project"));
    expect(result.valid).toBe(true);
    expect(result.resolved).toBe(fs.realpathSync(path.join(tmpDir, "project")));
    expect(result.isGitRepo).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("detects git repo with .git directory", () => {
    const result = validateProjectPath(path.join(tmpDir, "git-project"));
    expect(result.valid).toBe(true);
    expect(result.isGitRepo).toBe(true);
  });

  it("detects git worktree with .git file", () => {
    const result = validateProjectPath(path.join(tmpDir, "worktree-project"));
    expect(result.valid).toBe(true);
    expect(result.isGitRepo).toBe(true);
  });

  it("rejects non-existent path", () => {
    const result = validateProjectPath("/non/existent/path/xyz");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Path does not exist");
  });

  it("rejects file path (not directory)", () => {
    const result = validateProjectPath(path.join(tmpDir, "file.txt"));
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Path is not a directory");
  });

  it("rejects empty string", () => {
    const result = validateProjectPath("");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Path is required");
  });

  it("rejects whitespace-only string", () => {
    const result = validateProjectPath("   ");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Path is required");
  });

  it("resolves relative paths to absolute", () => {
    const result = validateProjectPath(".");
    expect(result.valid).toBe(true);
    expect(path.isAbsolute(result.resolved)).toBe(true);
  });

  it("resolves .. sequences", () => {
    const result = validateProjectPath(path.join(tmpDir, "project", ".."));
    expect(result.valid).toBe(true);
    expect(result.resolved).toBe(fs.realpathSync(tmpDir));
  });

  it("resolves symlinks via realpathSync", () => {
    const linkPath = path.join(tmpDir, "link-to-project");
    if (!fs.existsSync(linkPath)) return; // skip if symlink not created
    const result = validateProjectPath(linkPath);
    expect(result.valid).toBe(true);
    expect(result.resolved).toBe(fs.realpathSync(path.join(tmpDir, "project")));
  });

  describe("enforceBoundary option", () => {
    it("allows paths within home directory", () => {
      const result = validateProjectPath(os.homedir(), { enforceBoundary: true });
      expect(result.valid).toBe(true);
    });

    it("rejects paths outside home directory when boundary enforced", () => {
      const realTmp = fs.realpathSync("/tmp");
      if (!realTmp.startsWith(os.homedir())) {
        const result = validateProjectPath("/tmp", { enforceBoundary: true });
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Access denied: path outside home directory");
      }
    });

    it("allows paths outside home when boundary not enforced (default)", () => {
      const result = validateProjectPath("/tmp");
      expect(result.valid).toBe(true);
    });
  });
});

describe("isHiddenDirectory", () => {
  it("returns true for dot-prefixed dirs", () => {
    expect(isHiddenDirectory(".git")).toBe(true);
    expect(isHiddenDirectory(".cache")).toBe(true);
    expect(isHiddenDirectory(".hidden")).toBe(true);
  });

  it("returns true for known hidden patterns", () => {
    expect(isHiddenDirectory("node_modules")).toBe(true);
    expect(isHiddenDirectory("__pycache__")).toBe(true);
  });

  it("returns false for regular directories", () => {
    expect(isHiddenDirectory("src")).toBe(false);
    expect(isHiddenDirectory("packages")).toBe(false);
    expect(isHiddenDirectory("my-project")).toBe(false);
  });

  it("DEFAULT_HIDDEN_PATTERNS contains expected entries", () => {
    expect(DEFAULT_HIDDEN_PATTERNS.has("node_modules")).toBe(true);
    expect(DEFAULT_HIDDEN_PATTERNS.has(".git")).toBe(true);
    expect(DEFAULT_HIDDEN_PATTERNS.has(".next")).toBe(true);
  });
});

describe("Browse Directories (endpoint logic)", () => {
  let tmpDir: string;
  let realTmpDir: string;
  const homeDir = os.homedir();

  beforeAll(() => {
    // Create test dirs inside home to pass boundary check
    tmpDir = fs.mkdtempSync(path.join(homeDir, ".kora-browse-test-"));
    realTmpDir = fs.realpathSync(tmpDir);

    fs.mkdirSync(path.join(tmpDir, "projectA"));
    fs.mkdirSync(path.join(tmpDir, "projectB"));
    fs.mkdirSync(path.join(tmpDir, ".hidden-dir"));
    fs.mkdirSync(path.join(tmpDir, "node_modules"));
    fs.mkdirSync(path.join(tmpDir, "git-repo", ".git"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "worktree-repo"));
    fs.writeFileSync(path.join(tmpDir, "worktree-repo", ".git"), "gitdir: /some/path");
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Mimics the endpoint logic for testability.
   */
  async function browseDirectories(rawPath?: string, showHidden = false) {
    const fsp = fs.promises;
    const targetPath = rawPath?.trim() || homeDir;

    const validation = validateProjectPath(targetPath, { enforceBoundary: true });
    if (!validation.valid) {
      const status = validation.error === "Path does not exist" ? 404
        : validation.error?.startsWith("Access denied") ? 403
        : 400;
      return { status, body: { error: validation.error } };
    }
    const resolved = validation.resolved;

    let entries;
    try {
      entries = await fsp.readdir(resolved, { withFileTypes: true });
    } catch {
      return { status: 403, body: { error: "Cannot read directory" } };
    }

    const directories: Array<{ name: string; path: string; isGitRepo: boolean }> = [];

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        try {
          const realTarget = fs.realpathSync(path.join(resolved, entry.name));
          const targetStat = fs.statSync(realTarget);
          if (!targetStat.isDirectory() || !realTarget.startsWith(homeDir)) continue;
        } catch {
          continue;
        }
      } else if (!entry.isDirectory()) {
        continue;
      }

      if (!showHidden && isHiddenDirectory(entry.name)) continue;

      const dirPath = path.join(resolved, entry.name);
      let isGitRepo = false;
      try {
        const gitStat = await fsp.stat(path.join(dirPath, ".git"));
        isGitRepo = gitStat.isDirectory() || gitStat.isFile();
      } catch {
        // not a git repo
      }
      directories.push({ name: entry.name, path: dirPath, isGitRepo });
    }

    directories.sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(resolved) !== resolved ? path.dirname(resolved) : null;
    return { status: 200, body: { path: resolved, currentPath: resolved, parent, directories, homeDir } };
  }

  it("returns subdirectories sorted alphabetically, hiding hidden dirs by default", async () => {
    const result = await browseDirectories(tmpDir);
    expect(result.status).toBe(200);
    const body = result.body as { path: string; currentPath: string; parent: string | null; homeDir: string; directories: Array<{ name: string }> };

    expect(body.path).toBe(realTmpDir);
    expect(body.currentPath).toBe(realTmpDir);
    expect(body.homeDir).toBe(homeDir);

    const names = body.directories.map(d => d.name);
    expect(names).not.toContain(".hidden-dir");
    expect(names).not.toContain("node_modules");
    expect(names).toContain("projectA");
    expect(names).toContain("projectB");
    expect(names).not.toContain("file.txt");
  });

  it("shows hidden dirs when showHidden=true", async () => {
    const result = await browseDirectories(tmpDir, true);
    expect(result.status).toBe(200);
    const body = result.body as { directories: Array<{ name: string }> };
    const names = body.directories.map(d => d.name);
    expect(names).toContain(".hidden-dir");
    expect(names).toContain("node_modules");
  });

  it("detects git repos (directory .git)", async () => {
    const result = await browseDirectories(tmpDir);
    const body = result.body as { directories: Array<{ name: string; isGitRepo: boolean }> };

    const gitRepo = body.directories.find(d => d.name === "git-repo");
    expect(gitRepo).toBeDefined();
    expect(gitRepo!.isGitRepo).toBe(true);

    const projectA = body.directories.find(d => d.name === "projectA");
    expect(projectA!.isGitRepo).toBe(false);
  });

  it("detects git worktree repos (.git is a file)", async () => {
    const result = await browseDirectories(tmpDir);
    const body = result.body as { directories: Array<{ name: string; isGitRepo: boolean }> };

    const worktreeRepo = body.directories.find(d => d.name === "worktree-repo");
    expect(worktreeRepo!.isGitRepo).toBe(true);
  });

  it("defaults to home directory when no path provided", async () => {
    const result = await browseDirectories(undefined);
    expect(result.status).toBe(200);
    const body = result.body as { currentPath: string; path: string };
    expect(body.currentPath).toBe(homeDir);
    expect(body.path).toBe(homeDir);
  });

  it("returns 404 for non-existent path", async () => {
    const result = await browseDirectories(path.join(homeDir, "nonexistent-xyz-123"));
    expect(result.status).toBe(404);
  });

  it("returns 400 for path pointing to a file", async () => {
    const result = await browseDirectories(path.join(tmpDir, "file.txt"));
    expect(result.status).toBe(400);
  });

  it("response includes both 'path' and 'currentPath' for frontend compat", async () => {
    const result = await browseDirectories(homeDir);
    expect(result.status).toBe(200);
    const body = result.body as { path: string; currentPath: string; homeDir: string };
    expect(body.path).toBeDefined();
    expect(body.currentPath).toBeDefined();
    expect(body.path).toBe(body.currentPath);
    expect(body.homeDir).toBe(homeDir);
  });

  it("returns full absolute paths for each directory entry", async () => {
    const result = await browseDirectories(homeDir);
    expect(result.status).toBe(200);
    const body = result.body as { directories: Array<{ name: string; path: string }> };

    for (const dir of body.directories) {
      expect(path.isAbsolute(dir.path)).toBe(true);
    }
  });

  it("rejects paths outside home directory with 403", async () => {
    const etcPath = "/etc";
    if (fs.existsSync(etcPath) && !fs.realpathSync(etcPath).startsWith(homeDir)) {
      const result = await browseDirectories(etcPath);
      expect(result.status).toBe(403);
    }
  });
});
