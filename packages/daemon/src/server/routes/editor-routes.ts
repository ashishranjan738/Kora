import { randomUUID } from "crypto";
import fs from "fs";
import fsPromises from "fs/promises";
import os from "os";
import path from "path";
import type { RouteDeps, Router, Request, Response } from "./route-deps.js";
import { getRuntimeTmuxPrefix as getSessionPrefix } from "@kora/shared";
import { validateProjectPath, isHiddenDirectory } from "../../core/path-validation.js";
import { logger } from "../../core/logger.js";

export function registerEditorRoutes(router: Router, deps: RouteDeps): void {
  const { sessionManager, orchestrators, terminal, suggestionsDb, broadcastEvent, standaloneTerminals, persistTerminalsForSession } = deps;
  const backend = terminal;

  function getDb(sid: string) {
    const orch = orchestrators.get(sid);
    return orch?.database || null;
  }

  // Open the session's project path in VS Code
  router.post("/sessions/:sid/open-vscode", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      await promisify(execFile)("code", [session.config.projectPath]);
      res.json({ opened: true, path: session.config.projectPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Git (Changes) ──────────────────────────────────────────────

  // Get git status (changed files + branch) — supports nested git repos
  router.get("/sessions/:sid/git/status", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const nodePath = await import("path");
      const nodeFs = await import("fs/promises");
      const exec = promisify(execFile);
      const projectRoot = session.config.projectPath;

      // Per-agent git: if agentId provided, show committed diffs vs main in agent's worktree
      const agentId = req.query.agentId as string | undefined;
      if (agentId) {
        const orch = orchestrators.get(sid);
        const agent = orch?.agentManager.getAgent(agentId);
        if (!agent) {
          res.status(404).json({ error: `Agent "${agentId}" not found` });
          return;
        }
        const workDir = agent.config.workingDirectory;
        try {
          let branch = "";
          try {
            const { stdout } = await exec("git", ["branch", "--show-current"], { cwd: workDir });
            branch = stdout.trim();
          } catch {}

          // Get committed changes vs main (shows what the agent's branch added)
          let committedChanges: Array<{ status: string; file: string; statusLabel: string }> = [];
          try {
            const { stdout } = await exec("git", ["diff", "--name-status", "origin/main...HEAD"], { cwd: workDir });
            const statusMap: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed" };
            committedChanges = stdout.trim().split("\n").filter(Boolean).map(line => {
              const [status, ...fileParts] = line.split("\t");
              const file = fileParts.join("\t");
              return { status: status.charAt(0), file, statusLabel: statusMap[status.charAt(0)] || status };
            });
          } catch {}

          // Also get uncommitted changes
          let uncommittedChanges: Array<{ status: string; file: string; statusLabel: string }> = [];
          try {
            const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: workDir });
            const statusMap: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", "??": "Untracked", R: "Renamed" };
            uncommittedChanges = stdout.trim().split("\n").filter(Boolean).map(line => {
              const status = line.substring(0, 2).trim();
              const file = line.substring(3);
              return { status, file, statusLabel: statusMap[status] || status };
            });
          } catch {}

          // Count commits ahead of main
          let commitsAhead = 0;
          try {
            const { stdout } = await exec("git", ["rev-list", "--count", "origin/main..HEAD"], { cwd: workDir });
            commitsAhead = parseInt(stdout.trim(), 10) || 0;
          } catch {}

          res.json({
            agentId,
            branch,
            workingDirectory: workDir,
            commitsAhead,
            committedChanges,
            uncommittedChanges,
            totalChanges: committedChanges.length + uncommittedChanges.length,
          });
        } catch (err) {
          res.status(500).json({ error: String(err) });
        }
        return;
      }

      const statusMap: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", "??": "Untracked", R: "Renamed" };

      // Discover all git repos: root + nested (max 3 levels deep)
      const gitRepos: Array<{ repoPath: string; repoName: string }> = [];

      async function findGitRepos(dir: string, depth: number) {
        if (depth > 3) return;
        try {
          await nodeFs.access(nodePath.join(dir, ".git"));
          const relPath = nodePath.relative(projectRoot, dir);
          gitRepos.push({
            repoPath: dir,
            repoName: relPath || ".",
          });
        } catch {
          // Not a git repo at this level
        }

        // Scan subdirectories for nested repos (skip known non-repo dirs)
        if (depth < 3) {
          try {
            const entries = await nodeFs.readdir(dir, { withFileTypes: true });
            const skipDirs = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__", ".venv", "vendor"]);
            for (const entry of entries) {
              if (entry.isDirectory() && !skipDirs.has(entry.name) && (!entry.name.startsWith(".") || entry.name === ".kora")) {
                await findGitRepos(nodePath.join(dir, entry.name), depth + 1);
              }
            }
          } catch {}
        }
      }

      await findGitRepos(projectRoot, 0);

      // If no git repos found, try root anyway
      if (gitRepos.length === 0) {
        gitRepos.push({ repoPath: projectRoot, repoName: "." });
      }

      // Gather status from all repos
      const repos: Array<{
        name: string;
        branch: string;
        changes: Array<{ status: string; file: string; statusLabel: string; repo: string }>;
      }> = [];
      let allChanges: Array<{ status: string; file: string; statusLabel: string; repo: string }> = [];
      let primaryBranch = "";

      for (const { repoPath, repoName } of gitRepos) {
        let branch = "";
        let changes: Array<{ status: string; file: string; statusLabel: string; repo: string }> = [];

        try {
          const branchResult = await exec("git", ["branch", "--show-current"], { cwd: repoPath });
          branch = branchResult.stdout.trim();
        } catch {}

        try {
          const statusResult = await exec("git", ["status", "--porcelain"], { cwd: repoPath });
          changes = statusResult.stdout.trim().split("\n").filter(Boolean).map(line => {
            const status = line.substring(0, 2).trim();
            const file = line.substring(3);
            // Prefix file path with repo name for nested repos
            const displayFile = repoName === "." ? file : `${repoName}/${file}`;
            return { status, file: displayFile, statusLabel: statusMap[status] || status, repo: repoName };
          });
        } catch {}

        if (repoName === ".") primaryBranch = branch;

        if (changes.length > 0 || repoName === ".") {
          repos.push({ name: repoName, branch, changes });
          allChanges = allChanges.concat(changes);
        }
      }

      res.json({
        branch: primaryBranch,
        changes: allChanges,
        repos,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Get git diff for a specific file — handles nested repos
  router.get("/sessions/:sid/git/diff", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const filePath = String(req.query.path || "");
      const repo = String(req.query.repo || ".");
      const agentIdDiff = req.query.agentId as string | undefined;
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const nodePath = await import("path");
      const exec = promisify(execFile);

      // Per-agent diff: show committed diff vs main for a specific file
      if (agentIdDiff) {
        const orch = orchestrators.get(sid);
        const agent = orch?.agentManager.getAgent(agentIdDiff);
        if (!agent) { res.status(404).json({ error: `Agent "${agentIdDiff}" not found` }); return; }
        const workDir = agent.config.workingDirectory;

        try {
          // Get original from main
          let original = "";
          try {
            const { stdout } = await exec("git", ["show", `origin/main:${filePath}`], { cwd: workDir });
            original = stdout;
          } catch { /* new file */ }

          // Get current from agent branch
          let modified = "";
          try {
            const fullPath = nodePath.resolve(workDir, filePath);
            const fsP = await import("fs/promises");
            modified = await fsP.readFile(fullPath, "utf-8");
          } catch { /* deleted */ }

          let diff = "";
          try {
            const { stdout } = await exec("git", ["diff", "origin/main...HEAD", "--", filePath], { cwd: workDir });
            diff = stdout;
          } catch {}

          res.json({ original, modified, diff, path: filePath, agentId: agentIdDiff });
        } catch (err) {
          res.json({ original: "", modified: "", diff: "", path: filePath, agentId: agentIdDiff, error: String(err) });
        }
        return;
      }

      // Resolve the repo directory
      const repoDir = repo === "." ? session.config.projectPath : nodePath.resolve(session.config.projectPath, repo);

      // Security: ensure resolved path is within project
      if (!repoDir.startsWith(nodePath.resolve(session.config.projectPath))) {
        res.status(400).json({ error: "Invalid repo path" });
        return;
      }

      // Strip repo prefix from file path to get the path relative to the repo
      const repoFile = repo === "." ? filePath : filePath.replace(`${repo}/`, "");

      try {
        // Get original content (from HEAD)
        let original = "";
        try {
          const { stdout } = await exec("git", ["show", `HEAD:${repoFile}`], { cwd: repoDir });
          original = stdout;
        } catch {
          // File doesn't exist in HEAD (new file)
          original = "";
        }

        // Get current content (modified version)
        let modified = "";
        try {
          const fullPath = nodePath.resolve(repoDir, repoFile);
          const fs = await import("fs/promises");
          modified = await fs.readFile(fullPath, "utf-8");
        } catch {
          // File may be deleted
          modified = "";
        }

        // Also keep the raw diff for fallback
        let diff = "";
        try {
          const { stdout } = await exec("git", ["diff", "HEAD", "--", repoFile], { cwd: repoDir });
          diff = stdout;
          if (!diff.trim() && modified) {
            // For untracked files, create a synthetic diff
            const { stdout: syntacticDiff } = await exec("git", ["diff", "--no-index", "/dev/null", repoFile], { cwd: repoDir }).catch(() => ({ stdout: "" }));
            diff = syntacticDiff;
          }
        } catch {
          diff = "";
        }

        res.json({ original, modified, diff, path: filePath, repo });
      } catch {
        res.json({ original: "", modified: "", diff: "", path: filePath, repo, error: "Could not get diff" });
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── File System (Editor) ─────────────────────────────────────────

  // List files/directories in a path
  router.get("/sessions/:sid/files", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const subpath = String(req.query.path || "");
      const fullPath = path.join(session.config.projectPath, subpath);

      // Security: ensure path is within project directory
      const resolved = path.resolve(fullPath);
      if (!resolved.startsWith(path.resolve(session.config.projectPath))) {
        res.status(403).json({ error: "Access denied: path outside project" });
        return;
      }

      const fsModule = await import("fs/promises");
      const entries = await fsModule.readdir(resolved, { withFileTypes: true });
      const items = entries
        .filter(e => e.name !== 'node_modules' && e.name !== '.git') // hide node_modules and .git
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? "directory" : "file",
          path: path.join(subpath, e.name),
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      res.json({ items, currentPath: subpath });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Read a file
  router.get("/sessions/:sid/files/read", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const filePath = String(req.query.path || "");
      const fullPath = path.resolve(session.config.projectPath, filePath);

      if (!fullPath.startsWith(path.resolve(session.config.projectPath))) {
        res.status(403).json({ error: "Access denied" }); return;
      }

      const fsModule = await import("fs/promises");
      const content = await fsModule.readFile(fullPath, "utf-8");
      const ext = path.extname(filePath).slice(1);

      res.json({ content, path: filePath, language: extToLanguage(ext) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** Serve raw file content with correct Content-Type (for binary files: images, PDFs, etc.) */
  router.get("/sessions/:sid/files/raw", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const filePath = String(req.query.path || "");
      if (!filePath) { res.status(400).json({ error: "path query parameter required" }); return; }

      const projectRoot = path.resolve(session.config.projectPath);
      const fullPath = path.resolve(projectRoot, filePath);

      // Path traversal protection
      if (!fullPath.startsWith(projectRoot + path.sep) && fullPath !== projectRoot) {
        res.status(403).json({ error: "Access denied — path outside project directory" }); return;
      }

      const fsSync = require("fs");
      if (!fsSync.existsSync(fullPath) || !fsSync.statSync(fullPath).isFile()) {
        res.status(404).json({ error: "File not found" }); return;
      }

      // Determine Content-Type from extension
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
        ".pdf": "application/pdf", ".ico": "image/x-icon",
        ".json": "application/json", ".xml": "application/xml",
        ".html": "text/html", ".css": "text/css",
        ".js": "text/javascript", ".ts": "text/plain",
        ".md": "text/markdown", ".txt": "text/plain",
      };
      const contentType = mimeTypes[ext] || "application/octet-stream";

      // Security: force download for executable/script types, inline for safe types
      const safeInlineTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);
      const disposition = safeInlineTypes.has(contentType) ? "inline" : "attachment";

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `${disposition}; filename="${path.basename(filePath)}"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (!safeInlineTypes.has(contentType)) {
        res.setHeader("Content-Security-Policy", "default-src 'none'");
      }
      res.sendFile(fullPath);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Write a file
  router.put("/sessions/:sid/files/write", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const { path: filePath, content } = req.body;
      const fullPath = path.resolve(session.config.projectPath, filePath);

      if (!fullPath.startsWith(path.resolve(session.config.projectPath))) {
        res.status(403).json({ error: "Access denied" }); return;
      }

      const fsModule = await import("fs/promises");
      await fsModule.writeFile(fullPath, content, "utf-8");
      res.json({ saved: true, path: filePath });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Attachments (Image Sharing) ──────────────────────────────────

  const ALLOWED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
  const ALLOWED_FILE_EXTS = new Set([
    // Images
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
    // Text / docs
    ".md", ".txt", ".log", ".csv", ".rst",
    // Config / data
    ".json", ".yaml", ".yml", ".toml", ".xml", ".env.example",
    // Code
    ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".sh", ".bash", ".zsh",
    ".c", ".cpp", ".h", ".hpp", ".css", ".html", ".sql",
    // Diffs / patches
    ".diff", ".patch",
  ]);
  const MAX_BASE64_SIZE = 10 * 1024 * 1024; // 10MB cap for base64 (images)
  const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB cap for non-image files

  /** Serve attachment files with auth + security headers */
  router.get("/sessions/:sid/attachments/:filename", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const filename = String(req.params.filename);

      // Security: reject path traversal attempts
      if (filename.includes("/") || filename.includes("..") || filename.includes("\\")) {
        res.status(400).json({ error: "Invalid filename" });
        return;
      }

      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const safeFilename = path.basename(filename);
      const ext = path.extname(safeFilename).toLowerCase();
      if (!ALLOWED_FILE_EXTS.has(ext)) {
        res.status(400).json({ error: `Unsupported format: ${ext}. Allowed: ${[...ALLOWED_FILE_EXTS].join(", ")}` });
        return;
      }

      const attachDir = path.join(session.runtimeDir, "attachments");
      const filePath = path.join(attachDir, safeFilename);

      // Verify file is within attachments dir (double-check path traversal)
      if (!filePath.startsWith(attachDir)) {
        res.status(400).json({ error: "Invalid path" });
        return;
      }

      const fsSync = require("fs");
      if (!fsSync.existsSync(filePath)) {
        res.status(404).json({ error: "Attachment not found" });
        return;
      }

      // Security headers — force download for non-image files to prevent XSS via .html/.svg
      const isServableImage = ALLOWED_IMAGE_EXTS.has(ext) && ext !== ".svg";
      const disposition = isServableImage ? "inline" : "attachment";
      res.setHeader("Content-Disposition", `${disposition}; filename="${safeFilename}"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (!isServableImage) {
        res.setHeader("Content-Security-Policy", "default-src 'none'");
      }
      res.sendFile(filePath);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** Upload attachment (used by share_file MCP tool) */
  router.post("/sessions/:sid/attachments", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const { filename, base64Data, sourcePath, toAgentId } = req.body;
      if (!filename) { res.status(400).json({ error: "filename required" }); return; }

      const ext = path.extname(filename).toLowerCase();
      if (!ALLOWED_FILE_EXTS.has(ext)) {
        res.status(400).json({ error: `Unsupported format: ${ext}. Allowed: ${[...ALLOWED_FILE_EXTS].join(", ")}` });
        return;
      }

      // Validate receiver if specified
      if (toAgentId) {
        const orch = orchestrators.get(sid);
        const agent = orch?.agentManager.getAgent(toAgentId);
        if (!agent) {
          res.status(404).json({ error: `Agent "${toAgentId}" not found` });
          return;
        }
      }

      const fsSync = require("fs");
      const attachDir = path.join(session.runtimeDir, "attachments");
      fsSync.mkdirSync(attachDir, { recursive: true });

      const safeFilename = `${Date.now()}-${path.basename(filename)}`;
      const destPath = path.join(attachDir, safeFilename);

      if (base64Data) {
        // Base64 input (from Chrome DevTools screenshots)
        if (base64Data.length > MAX_BASE64_SIZE) {
          res.status(400).json({ error: `Base64 data exceeds ${MAX_BASE64_SIZE / 1024 / 1024}MB limit` });
          return;
        }
        const buffer = Buffer.from(base64Data, "base64");
        fsSync.writeFileSync(destPath, buffer);
      } else if (sourcePath) {
        // File path input — copy file (SECURITY: restrict to project directory)
        const projectRoot = path.resolve(session.config.projectPath);
        const resolvedSource = path.resolve(projectRoot, sourcePath);
        if (!resolvedSource.startsWith(projectRoot + path.sep) && resolvedSource !== projectRoot) {
          res.status(403).json({ error: "sourcePath must be within the project directory" });
          return;
        }
        if (!fsSync.existsSync(resolvedSource)) {
          res.status(404).json({ error: `Source file not found: ${sourcePath}` });
          return;
        }
        // Enforce size limit: 1MB for non-image files, 10MB for images
        const sourceSize = fsSync.statSync(resolvedSource).size;
        const isImage = ALLOWED_IMAGE_EXTS.has(ext);
        const sizeLimit = isImage ? MAX_BASE64_SIZE : MAX_FILE_SIZE;
        if (sourceSize > sizeLimit) {
          const limitMB = sizeLimit / 1024 / 1024;
          res.status(400).json({ error: `File exceeds ${limitMB}MB size limit (${(sourceSize / 1024 / 1024).toFixed(1)}MB)` });
          return;
        }
        fsSync.copyFileSync(resolvedSource, destPath);
      } else {
        res.status(400).json({ error: "Either base64Data or sourcePath required" });
        return;
      }

      const url = `/api/v1/sessions/${sid}/attachments/${safeFilename}`;
      res.status(201).json({ filename: safeFilename, url, size: fsSync.statSync(destPath).size });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Plain Terminal (bare shell, no agent) ─────────────────────────

  router.post("/sessions/:sid/terminal", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const termId = `term-${randomUUID().slice(0, 8)}`;
      const terminalSessionName = `${getSessionPrefix(process.env.KORA_DEV === "1")}${sid}-${termId}`;

      await backend.newSession(terminalSessionName);

      // Wait for shell prompt before sending cd (shell may not be ready yet)
      const maxWait = 3000;
      const pollInterval = 200;
      let waited = 0;
      while (waited < maxWait) {
        try {
          const output = await backend.capturePane(terminalSessionName, 5);
          const lastLine = output.trim().split('\n').pop() || '';
          if (lastLine.match(/[$%>❯]\s*$/)) break;
        } catch { /* pane may not be ready */ }
        await new Promise(r => setTimeout(r, pollInterval));
        waited += pollInterval;
      }

      // cd to the project directory
      await backend.sendKeys(terminalSessionName, `cd ${session.config.projectPath}`, { literal: false });

      // Track this standalone terminal
      if (!standaloneTerminals.has(sid)) {
        standaloneTerminals.set(sid, new Map());
      }
      standaloneTerminals.get(sid)!.set(termId, {
        id: termId,
        terminalSession: terminalSessionName,
        name: `Terminal ${(standaloneTerminals.get(sid)?.size || 0) + 1}`,
        createdAt: new Date().toISOString(),
        projectPath: session.config.projectPath,
      });

      // Persist terminal state to disk (survives daemon restart)
      await persistTerminalsForSession(sid);

      res.status(201).json({ id: termId, terminalSession: terminalSessionName, projectPath: session.config.projectPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // List all terminals (agent + standalone) for a session
  router.get("/sessions/:sid/terminals", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const terminals: any[] = [];

      // Add standalone terminals
      const sessionTerminals = standaloneTerminals.get(sid);
      if (sessionTerminals) {
        sessionTerminals.forEach((term) => {
          terminals.push({
            id: term.id,
            terminalSession: term.terminalSession,
            name: term.name,
            type: "standalone",
            createdAt: term.createdAt,
          });
        });
      }

      // Add agent terminals
      const am = orchestrators.get(sid)?.agentManager;
      if (am) {
        const agents = am.listAgents();
        agents.forEach((agent: any) => {
          terminals.push({
            id: agent.id,
            terminalSession: agent.config.terminalSession,
            name: agent.config.name,
            type: "agent",
            agentName: agent.config.name,
            createdAt: agent.startedAt || new Date().toISOString(),
          });
        });
      }

      res.status(200).json({ terminals });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // DELETE /sessions/:sid/terminals/:tid — close a standalone terminal
  router.delete("/sessions/:sid/terminals/:tid", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const tid = String(req.params.tid);

      const terminals = standaloneTerminals.get(sid);
      const termInfo = terminals?.get(tid);
      if (!termInfo) {
        res.status(404).json({ error: `Terminal "${tid}" not found` });
        return;
      }

      // Kill the terminal session
      try { await backend.killSession(termInfo.terminalSession); } catch { /* may already be dead */ }

      // Remove from tracking
      terminals!.delete(tid);

      // Persist updated state
      await persistTerminalsForSession(sid);

      res.json({ deleted: true, id: tid });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Suggestions (Recent Paths & CLI Flags) ──────────────────────────

  router.get("/suggestions/paths", (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const paths = suggestionsDb.getRecentPaths(limit);
      res.json({ paths });
    } catch (err) {
      logger.error({ err: err }, "[api] GET /suggestions/paths error");
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/suggestions/flags", (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const flags = suggestionsDb.getRecentFlags(limit);
      res.json({ flags });
    } catch (err) {
      logger.error({ err: err }, "[api] GET /suggestions/flags error");
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/suggestions/agent-configs", (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const configs = suggestionsDb.getRecentAgentConfigs(limit);
      res.json({ configs });
    } catch (err) {
      logger.error({ err: err }, "[api] GET /suggestions/agent-configs error");
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Code Comments ──────────────────────────────────────────────

  router.post("/sessions/:sid/code-comments", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      const { filePath, startLine, endLine, selectedText, commitHash, comment, createdBy, taskId, createTask } = req.body;
      if (!filePath || startLine === undefined || !comment) {
        res.status(400).json({ error: "filePath, startLine, and comment are required" });
        return;
      }

      const { randomUUID } = require("crypto");
      const id = randomUUID().slice(0, 12);
      const now = new Date().toISOString();

      // Optionally create a linked task
      let linkedTaskId = taskId;
      if (createTask && !taskId) {
        const taskIdGen = randomUUID().slice(0, 8);
        db.insertTask({
          id: taskIdGen, sessionId: sid,
          title: `Code review: ${filePath}:${startLine}`,
          description: `${comment}\n\nFile: ${filePath}, lines ${startLine}${endLine ? `-${endLine}` : ""}`,
          status: "pending", createdBy: createdBy || "user",
          createdAt: now, updatedAt: now,
        });
        linkedTaskId = taskIdGen;
        broadcastEvent({ event: "task-created", sessionId: sid, taskId: taskIdGen });
      }

      db.insertCodeComment({
        id, sessionId: sid, filePath, startLine, endLine, selectedText,
        commitHash, comment, createdBy: createdBy || "user", createdAt: now,
        taskId: linkedTaskId,
      });

      broadcastEvent({ event: "code-comment-created", sessionId: sid, commentId: id, filePath });
      res.status(201).json(db.getCodeComments(sid, { filePath })[0] || { id });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get("/sessions/:sid/code-comments", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      const filePath = req.query.file as string | undefined;
      const resolved = req.query.resolved === "true" ? true : req.query.resolved === "false" ? false : undefined;
      const taskId = req.query.taskId as string | undefined;

      const comments = db.getCodeComments(sid, { filePath, resolved, taskId });
      res.json({ comments, count: comments.length });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get("/sessions/:sid/code-comments/files", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      const resolved = req.query.resolved === "true" ? true : req.query.resolved === "false" ? false : undefined;
      const fileCounts = db.getCodeCommentFileCounts(sid, resolved);
      res.json({ files: fileCounts });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.put("/sessions/:sid/code-comments/:cid", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const cid = String(req.params.cid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      const updated = db.updateCodeComment(cid, req.body);
      if (!updated) { res.status(404).json({ error: "Comment not found" }); return; }

      broadcastEvent({ event: "code-comment-updated", sessionId: sid, commentId: cid });
      res.json({ updated: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.delete("/sessions/:sid/code-comments/:cid", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const cid = String(req.params.cid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      const deleted = db.deleteCodeComment(cid);
      if (!deleted) { res.status(404).json({ error: "Comment not found" }); return; }

      broadcastEvent({ event: "code-comment-deleted", sessionId: sid, commentId: cid });
      res.json({ deleted: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── Browse Directories ──────────────────────────────────

  router.get("/browse/directories", async (req: Request, res: Response) => {
    try {
      const homeDir = os.homedir();
      const rawPath = typeof req.query.path === "string" && req.query.path.trim()
        ? req.query.path.trim()
        : homeDir;
      const showHidden = req.query.showHidden === "true";

      // Validate the target path with symlink resolution and boundary enforcement
      const validation = validateProjectPath(rawPath, { enforceBoundary: true });
      if (!validation.valid) {
        const status = validation.error === "Path does not exist" ? 404
          : validation.error?.startsWith("Access denied") ? 403
          : 400;
        res.status(status).json({ error: validation.error });
        return;
      }
      const resolved = validation.resolved;

      let entries;
      try {
        entries = await fsPromises.readdir(resolved, { withFileTypes: true });
      } catch {
        res.status(403).json({ error: "Cannot read directory" });
        return;
      }

      const directories: Array<{ name: string; path: string; isGitRepo: boolean }> = [];

      for (const entry of entries) {
        // Handle symlinks: resolve target and validate it's within boundary
        if (entry.isSymbolicLink()) {
          try {
            const realTarget = fs.realpathSync(path.join(resolved, entry.name));
            const targetStat = fs.statSync(realTarget);
            if (!targetStat.isDirectory() || !realTarget.startsWith(homeDir)) continue;
          } catch {
            continue; // broken symlink — skip
          }
        } else if (!entry.isDirectory()) {
          continue;
        }

        // Filter hidden directories unless showHidden is true
        if (!showHidden && isHiddenDirectory(entry.name)) continue;

        const dirPath = path.join(resolved, entry.name);

        // Check if it's a git repo (has .git inside)
        let isGitRepo = false;
        try {
          const gitStat = await fsPromises.stat(path.join(dirPath, ".git"));
          isGitRepo = gitStat.isDirectory() || gitStat.isFile(); // .git can be a file (worktree)
        } catch {
          // not a git repo — that's fine
        }

        directories.push({ name: entry.name, path: dirPath, isGitRepo });
      }

      // Sort alphabetically
      directories.sort((a, b) => a.name.localeCompare(b.name));

      const parent = path.dirname(resolved) !== resolved ? path.dirname(resolved) : null;

      // Response includes both "path" (frontend compat) and "currentPath" (original)
      res.json({ path: resolved, currentPath: resolved, parent, directories, homeDir, isGitRepo: validation.isGitRepo });
    } catch (err) {
      logger.error({ err }, "[api] GET /browse/directories error");
      res.status(500).json({ error: "Internal server error" });
    }
  });
}

// Helper: map file extension to Monaco language
function extToLanguage(ext: string): string {
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
    py: "python", rs: "rust", go: "go", rb: "ruby", java: "java",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
    html: "html", css: "css", scss: "scss", less: "less",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    md: "markdown", txt: "plaintext", sh: "shell", bash: "shell",
    sql: "sql", graphql: "graphql", xml: "xml", svg: "xml",
    dockerfile: "dockerfile", makefile: "makefile",
  };
  return map[ext.toLowerCase()] || "plaintext";
}
