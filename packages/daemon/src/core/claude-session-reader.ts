/**
 * Claude Code JSONL session reader.
 * Reads agent observability data from Claude Code's internal session files:
 * - ~/.claude/sessions/{PID}.json → maps PID to sessionId
 * - ~/.claude/projects/{project-path}/{sessionId}.jsonl → conversation history
 *
 * Supports incremental reading (tracks file offset, reads only new lines).
 */

import fs from "fs";
import path from "path";
import os from "os";
import { logger } from "./logger.js";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const SESSIONS_DIR = path.join(CLAUDE_DIR, "sessions");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  model?: string;
}

export interface ClaudeToolCall {
  name: string;
  timestamp?: string;
  turnIndex: number;
}

export interface ClaudeActivity {
  type: string;
  model?: string;
  turnIndex: number;
  timestamp?: string;
  contentPreview?: string;
}

/** Per-session reader state for incremental reading */
interface ReaderState {
  sessionId: string;
  jsonlPath: string;
  fileOffset: number;
  usage: ClaudeUsage;
  toolCalls: ClaudeToolCall[];
  filesModified: Set<string>;
  turnCount: number;
  lastActivity: ClaudeActivity | null;
  lastModel: string | null;
}

export class ClaudeSessionReader {
  private readers = new Map<string, ReaderState>(); // agentId → ReaderState

  /**
   * Initialize reader for an agent by finding its Claude session via cwd matching.
   * Scans ~/.claude/sessions/*.json to find a session whose cwd matches the agent's
   * working directory. This is more robust than PID lookup since holdpty's PID differs
   * from the actual Claude Code child process PID.
   *
   * @param agentId - Kora agent ID
   * @param workingDirectory - The agent's working directory
   */
  initAgent(agentId: string, _pidOrUnused: number, workingDirectory: string): boolean {
    try {
      // Step 1: Scan all session files, find one matching agent's cwd
      if (!fs.existsSync(SESSIONS_DIR)) {
        logger.debug({ agentId }, "[ClaudeSessionReader] Sessions directory not found");
        return false;
      }

      const sessionFiles = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
      let sessionId: string | null = null;

      // Sort by mtime descending — prefer most recent session for this cwd
      const filesWithMtime = sessionFiles.map(f => {
        const fullPath = path.join(SESSIONS_DIR, f);
        try {
          return { file: f, mtime: fs.statSync(fullPath).mtimeMs };
        } catch { return { file: f, mtime: 0 }; }
      }).sort((a, b) => b.mtime - a.mtime);

      // Resolve symlinks for comparison (macOS: /tmp → /private/tmp)
      let resolvedWorkDir = workingDirectory;
      try { resolvedWorkDir = fs.realpathSync(workingDirectory); } catch { /* use original */ }

      for (const { file } of filesWithMtime) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8"));
          // Resolve session cwd symlinks too
          let sessionCwd = data.cwd || "";
          try { sessionCwd = fs.realpathSync(sessionCwd); } catch { /* use original */ }
          // Match if cwd equals or is a parent of the agent's working directory
          if (data.sessionId && sessionCwd && (
            resolvedWorkDir === sessionCwd ||
            resolvedWorkDir.startsWith(sessionCwd + "/")
          )) {
            sessionId = data.sessionId;
            break;
          }
        } catch { /* skip malformed */ }
      }

      if (!sessionId) {
        logger.debug({ agentId, workingDirectory }, "[ClaudeSessionReader] No session found matching cwd");
        return false;
      }

      // Step 2: Find the JSONL file for this session
      const jsonlPath = this.findJsonlPath(sessionId);
      if (!jsonlPath) {
        logger.debug({ agentId, sessionId }, "[ClaudeSessionReader] JSONL file not found");
        return false;
      }

      this.readers.set(agentId, {
        sessionId,
        jsonlPath,
        fileOffset: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 },
        toolCalls: [],
        filesModified: new Set(),
        turnCount: 0,
        lastActivity: null,
        lastModel: null,
      });

      logger.info({ agentId, sessionId, jsonlPath }, "[ClaudeSessionReader] Initialized agent reader");
      return true;
    } catch (err) {
      logger.debug({ err, agentId, workingDirectory }, "[ClaudeSessionReader] Init failed");
      return false;
    }
  }

  /** Find JSONL file by scanning project directories */
  private findJsonlPath(sessionId: string): string | null {
    try {
      if (!fs.existsSync(PROJECTS_DIR)) return null;
      const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
      for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue;
        const candidate = path.join(PROJECTS_DIR, dir.name, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch { /* non-fatal */ }
    return null;
  }

  /**
   * Read new JSONL entries since last read (incremental).
   * Updates cumulative usage, tool calls, files modified, etc.
   */
  readNewEntries(agentId: string): boolean {
    const state = this.readers.get(agentId);
    if (!state) return false;

    try {
      const stats = fs.statSync(state.jsonlPath);
      if (stats.size <= state.fileOffset) return false; // No new data

      // Read only new bytes from the offset
      const fd = fs.openSync(state.jsonlPath, "r");
      try {
        const newBytes = stats.size - state.fileOffset;
        const buf = Buffer.alloc(newBytes);
        fs.readSync(fd, buf, 0, newBytes, state.fileOffset);
        fs.closeSync(fd);

        state.fileOffset = stats.size;

        // Parse new lines
        const newContent = buf.toString("utf-8");
        const lines = newContent.split("\n").filter(l => l.trim());

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            this.processEntry(state, entry);
          } catch {
            // Malformed line — skip
          }
        }

        return true;
      } catch (readErr) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        throw readErr;
      }
    } catch (err) {
      logger.debug({ err, agentId }, "[ClaudeSessionReader] Read failed");
      return false;
    }
  }

  /** Process a single JSONL entry and update state */
  private processEntry(state: ReaderState, entry: any): void {
    const type = entry.type;

    if (type === "assistant") {
      state.turnCount++;

      // Extract usage from message.usage
      const usage = entry.message?.usage;
      if (usage) {
        state.usage.inputTokens += usage.input_tokens || 0;
        state.usage.outputTokens += usage.output_tokens || 0;
        state.usage.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
        state.usage.cacheReadTokens += usage.cache_read_input_tokens || 0;
        state.usage.totalTokens = state.usage.inputTokens + state.usage.outputTokens;
      }

      // Extract model
      const model = entry.message?.model;
      if (model) state.lastModel = model;

      // Extract tool use from content blocks
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use") {
            state.toolCalls.push({
              name: block.name,
              turnIndex: state.turnCount,
            });

            // Track file modifications from tool calls
            if (block.name === "Write" || block.name === "Edit") {
              const filePath = block.input?.file_path || block.input?.path;
              if (filePath) state.filesModified.add(filePath);
            }
          }
        }
      }

      // Update last activity
      const preview = Array.isArray(content)
        ? content.find((b: any) => b.type === "text")?.text?.substring(0, 100)
        : undefined;
      state.lastActivity = {
        type: "assistant",
        model: model || state.lastModel || undefined,
        turnIndex: state.turnCount,
        contentPreview: preview,
      };
    } else if (type === "human" || type === "user") {
      state.lastActivity = {
        type: "human",
        turnIndex: state.turnCount,
      };
    }
  }

  /** Get cumulative token usage for an agent */
  getUsage(agentId: string): ClaudeUsage | null {
    this.readNewEntries(agentId); // Auto-read new data
    const state = this.readers.get(agentId);
    return state ? { ...state.usage, model: state.lastModel || undefined } : null;
  }

  /** Get tool calls made by an agent */
  getToolCalls(agentId: string): ClaudeToolCall[] {
    this.readNewEntries(agentId);
    return this.readers.get(agentId)?.toolCalls || [];
  }

  /** Get latest activity for an agent */
  getLatestActivity(agentId: string): ClaudeActivity | null {
    this.readNewEntries(agentId);
    return this.readers.get(agentId)?.lastActivity || null;
  }

  /** Get files modified by an agent */
  getFilesModified(agentId: string): string[] {
    this.readNewEntries(agentId);
    return [...(this.readers.get(agentId)?.filesModified || [])];
  }

  /** Get conversation turn count */
  getTurnCount(agentId: string): number {
    this.readNewEntries(agentId);
    return this.readers.get(agentId)?.turnCount || 0;
  }

  /** Remove reader for an agent */
  removeAgent(agentId: string): void {
    this.readers.delete(agentId);
  }

  /** Check if reader is initialized for an agent */
  hasAgent(agentId: string): boolean {
    return this.readers.has(agentId);
  }
}
