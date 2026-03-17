// ============================================================
// Session manager — create, list, pause, stop sessions
// ============================================================

import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile, access, stat } from "fs/promises";
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
  SESSIONS_FILE,
  MESSAGES_DIR,
  CONTROL_DIR,
  TASKS_DIR,
  STATE_DIR,
  EVENTS_DIR,
  ARCHIVE_DIR,
  PERSONAS_DIR,
  KNOWLEDGE_DIR,
} from "@kora/shared";
import { EventLog } from "./event-log.js";

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
      for (const config of configs) {
        this.sessions.set(config.id, {
          config,
          agents: {},
          runtimeDir: path.join(config.projectPath, getRuntimeDaemonDir(process.env.KORA_DEV === "1")),
        });
      }
    } catch (err: unknown) {
      // File may not exist on first run — start with an empty registry
      if (isNodeError(err) && err.code === "ENOENT") {
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

    const runtimeDir = path.join(config.projectPath, getRuntimeDaemonDir(process.env.KORA_DEV === "1"));

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
