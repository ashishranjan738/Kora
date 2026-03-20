// ============================================================
// Session manager — create, list, pause, stop sessions
// ============================================================

import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile, access, stat, rename, cp } from "fs/promises";
import path from "path";
import type {
  SessionConfig,
  SessionState,
  SessionStatus,
  MessagingMode,
  WorktreeMode,
} from "@kora/shared";
import {
  DAEMON_DIR,
  getRuntimeDaemonDir,
  SESSIONS_SUBDIR,
  SESSIONS_FILE,
  MESSAGES_DIR,
  CONTROL_DIR,
  TASKS_DIR,
  STATE_DIR,
  EVENTS_DIR,
  ARCHIVE_DIR,
  PERSONAS_DIR,
  KNOWLEDGE_DIR,
  DEFAULT_WORKFLOW_STATES,
} from "@kora/shared";
import { EventLog } from "./event-log.js";
import { logger } from "./logger.js";

/** Subdirectories created inside each session's runtime dir */
const SESSION_SUBDIRS = [
  MESSAGES_DIR,
  CONTROL_DIR,
  TASKS_DIR,
  STATE_DIR,
  EVENTS_DIR,
  ARCHIVE_DIR,
  PERSONAS_DIR,
  KNOWLEDGE_DIR,
];

export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private sessionsFile: string;

  constructor(private globalConfigDir: string) {
    this.sessionsFile = path.join(globalConfigDir, SESSIONS_FILE);
  }

  /** Load sessions registry from disk */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.sessionsFile, "utf-8");
      const configs: SessionConfig[] = JSON.parse(raw);
      const isDev = process.env.KORA_DEV === "1";
      for (const config of configs) {
        const runtimeDir = path.join(config.projectPath, getRuntimeDaemonDir(isDev), SESSIONS_SUBDIR, config.id);

        // Migrate from flat .kora/ layout if session dir doesn't exist yet
        await this.migrateFromFlatLayout(config.projectPath, config.id, isDev);

        // Ensure workflow states exist (migration for pre-workflow sessions)
        if (!config.workflowStates || config.workflowStates.length === 0) {
          config.workflowStates = [...DEFAULT_WORKFLOW_STATES];
        }

        this.sessions.set(config.id, {
          config,
          agents: {},
          runtimeDir,
        });
      }
    } catch (err: unknown) {
      // File may not exist on first run — start with an empty registry
      if (isNodeError(err) && err.code === "ENOENT") {
        return;
      }
      // Empty or corrupt JSON — log warning and start fresh
      if (err instanceof SyntaxError) {
        logger.warn(`[SessionManager] Corrupt sessions file — starting with empty registry`);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load sessions registry: ${message}`);
    }
  }

  /** Save sessions registry to disk */
  async save(): Promise<void> {
    const configs = Array.from(this.sessions.values()).map((s) => s.config);
    try {
      await mkdir(path.dirname(this.sessionsFile), { recursive: true });
      await writeFile(
        this.sessionsFile,
        JSON.stringify(configs, null, 2),
        "utf-8",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to save sessions registry: ${message}`);
    }
  }

  /** Create a new session */
  async createSession(config: {
    name: string;
    projectPath: string;
    defaultProvider?: string;
    messagingMode?: MessagingMode;
    worktreeMode?: WorktreeMode;
  }): Promise<SessionConfig> {
    const id = slugify(config.name);

    if (this.sessions.has(id)) {
      throw new Error(`Session with id "${id}" already exists`);
    }

    const runtimeDir = path.join(config.projectPath, getRuntimeDaemonDir(process.env.KORA_DEV === "1"), SESSIONS_SUBDIR, id);

    // 1. Create the runtime directory and all subdirectories
    for (const sub of SESSION_SUBDIRS) {
      await mkdir(path.join(runtimeDir, sub), { recursive: true });
    }

    // 2. Build session config
    const sessionConfig: SessionConfig = {
      id,
      name: config.name,
      projectPath: config.projectPath,
      defaultProvider: config.defaultProvider ?? "claude-code",
      agents: [],
      createdAt: new Date().toISOString(),
      status: "active" as SessionStatus,
      messagingMode: config.messagingMode ?? "mcp",
      worktreeMode: config.worktreeMode ?? "isolated",
      workflowStates: [...DEFAULT_WORKFLOW_STATES],
    };

    // 3. Write session.json inside the runtime dir
    await writeFile(
      path.join(runtimeDir, "session.json"),
      JSON.stringify(sessionConfig, null, 2),
      "utf-8",
    );

    // 4. Auto-add .kora/ to .gitignore if in a git repo
    await this.addToGitignore(config.projectPath);

    // 5. Register in memory
    const sessionState: SessionState = {
      config: sessionConfig,
      agents: {},
      runtimeDir,
    };
    this.sessions.set(id, sessionState);

    // 6. Save registry to disk
    await this.save();

    // 7. Log session-created event
    try {
      const eventLog = new EventLog(runtimeDir);
      await eventLog.log({
        sessionId: id,
        type: "session-created",
        data: { name: config.name, projectPath: config.projectPath },
      });
    } catch {
      // Non-fatal: event logging failure should not block session creation
    }

    return sessionConfig;
  }

  /** List all sessions */
  listSessions(): SessionConfig[] {
    return Array.from(this.sessions.values()).map((s) => s.config);
  }

  /** Get a single session */
  getSession(id: string): SessionState | undefined {
    return this.sessions.get(id);
  }

  /** Pause session */
  async pauseSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session "${id}" not found`);
    }
    if (session.config.status === "stopped") {
      throw new Error(`Cannot pause a stopped session "${id}"`);
    }

    session.config.status = "paused";
    await this.save();

    try {
      const eventLog = new EventLog(session.runtimeDir);
      await eventLog.log({
        sessionId: id,
        type: "session-paused",
        data: {},
      });
    } catch {
      // Non-fatal
    }
  }

  /** Resume session */
  async resumeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session "${id}" not found`);
    }
    if (session.config.status !== "paused") {
      throw new Error(
        `Cannot resume session "${id}" — current status is "${session.config.status}"`,
      );
    }

    session.config.status = "active";
    await this.save();

    try {
      const eventLog = new EventLog(session.runtimeDir);
      await eventLog.log({
        sessionId: id,
        type: "session-resumed",
        data: {},
      });
    } catch {
      // Non-fatal
    }
  }

  /** Stop and remove session */
  async stopSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session "${id}" not found`);
    }

    session.config.status = "stopped";

    try {
      const eventLog = new EventLog(session.runtimeDir);
      await eventLog.log({
        sessionId: id,
        type: "session-stopped",
        data: {},
      });
    } catch {
      // Non-fatal
    }

    this.sessions.delete(id);
    await this.save();
  }

  /** Update session config */
  async updateSession(
    id: string,
    updates: Partial<SessionConfig>,
  ): Promise<SessionConfig> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session "${id}" not found`);
    }

    // Prevent changing the id
    const { id: _ignoreId, ...safeUpdates } = updates;
    Object.assign(session.config, safeUpdates);

    // Persist updated session.json inside the runtime dir
    try {
      await writeFile(
        path.join(session.runtimeDir, "session.json"),
        JSON.stringify(session.config, null, 2),
        "utf-8",
      );
    } catch {
      // Non-fatal for the runtime copy
    }

    await this.save();
    return session.config;
  }

  // ----- Private helpers -----

  /**
   * Migrate from legacy flat .kora/ layout to session-scoped .kora/sessions/{id}/.
   * If the new session dir doesn't exist but the old flat dir has per-session data
   * (data.db, state/, messages/, etc.), move it into the new session-scoped path.
   * Only migrates if exactly one session uses this projectPath (safe single-session case).
   */
  private async migrateFromFlatLayout(projectPath: string, sessionId: string, isDev: boolean): Promise<void> {
    const daemonDir = getRuntimeDaemonDir(isDev);
    const flatDir = path.join(projectPath, daemonDir);
    const sessionDir = path.join(flatDir, SESSIONS_SUBDIR, sessionId);

    // Skip if session dir already exists (already migrated or new session)
    try {
      await access(sessionDir);
      return; // Already exists, nothing to migrate
    } catch {
      // Session dir doesn't exist — check if flat layout has data
    }

    // Check if the flat layout has session data (data.db is the strongest signal)
    const flatDbPath = path.join(flatDir, "data.db");
    try {
      await access(flatDbPath);
    } catch {
      // No data.db in flat layout — nothing to migrate, just create fresh dirs
      return;
    }

    // Only migrate for single-session case to avoid ambiguity
    const sessionsUsingThisPath = Array.from(this.sessions.values())
      .filter(s => s.config.projectPath === projectPath).length;
    // Note: current session isn't in the map yet during load(), so check count
    // If there are already other sessions using this path, skip migration
    if (sessionsUsingThisPath > 0) {
      logger.warn(`[SessionManager] Multiple sessions share projectPath "${projectPath}" — skipping auto-migration for "${sessionId}". Manual migration required.`);
      return;
    }

    logger.info(`[SessionManager] Migrating session "${sessionId}" from flat .kora/ to .kora/sessions/${sessionId}/`);

    // Create the session directory
    await mkdir(sessionDir, { recursive: true });

    // Move per-session subdirectories and files
    const itemsToMigrate = [
      ...SESSION_SUBDIRS, // messages, control, tasks, state, events, archive, personas, knowledge
      "data.db",
      "data.db-wal",
      "data.db-shm",
      "session.json",
      "mcp",
      "worktrees",
    ];

    for (const item of itemsToMigrate) {
      const src = path.join(flatDir, item);
      const dst = path.join(sessionDir, item);
      try {
        await access(src);
        await rename(src, dst);
        logger.info(`[SessionManager] Migrated ${item} → sessions/${sessionId}/${item}`);
      } catch {
        // Item doesn't exist in flat layout — skip
      }
    }

    // Also move agent log files (*.log) and persona files
    try {
      const { readdir } = await import("fs/promises");
      const entries = await readdir(flatDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".log")) {
          const src = path.join(flatDir, entry.name);
          const dst = path.join(sessionDir, entry.name);
          try {
            await rename(src, dst);
          } catch {
            // Non-fatal
          }
        }
      }
    } catch {
      // Non-fatal
    }

    logger.info(`[SessionManager] Migration complete for session "${sessionId}"`);
  }

  /** Add .kora/ to .gitignore if project is a git repo */
  private async addToGitignore(projectPath: string): Promise<void> {
    const gitDir = path.join(projectPath, ".git");
    try {
      const stats = await stat(gitDir);
      if (!stats.isDirectory()) {
        return;
      }
    } catch {
      // Not a git repo
      return;
    }

    const gitignorePath = path.join(projectPath, ".gitignore");
    const entries = [`${DAEMON_DIR}/`, `${getRuntimeDaemonDir(true)}/`];

    let content = "";
    try {
      content = await readFile(gitignorePath, "utf-8");
    } catch {
      // .gitignore doesn't exist yet — we'll create it
    }

    // Check which entries are missing and append them
    const lines = content.split("\n");
    const missing = entries.filter(entry => !lines.some((line) => line.trim() === entry));
    if (missing.length === 0) {
      return;
    }

    // Append missing entries, ensuring there's a newline before them
    const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    await writeFile(
      gitignorePath,
      content + separator + missing.join("\n") + "\n",
      "utf-8",
    );
  }
}

// ----- Utility functions -----

/** Convert a session name to a URL-safe slug */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Type guard for Node.js system errors with a code property */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
