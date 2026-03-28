import { EventEmitter } from "events";
import * as fs from "fs/promises";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import type { AgentMessage } from "@kora/shared";
import { MESSAGES_DIR, PROCESSED_DIR } from "@kora/shared";
import { logger } from "./logger.js";
import type { AppDatabase } from "./database.js";

// ============================================================
// Constants
// ============================================================

/** Default message expiry: 7 days in milliseconds */
const MESSAGE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

// ============================================================
// Helpers
// ============================================================

/**
 * Generate a filename for a message file.
 * Format: `{timestamp}-{messageId}.json`
 */
function generateMessageFilename(messageId: string): string {
  return `${Date.now()}-${messageId}.json`;
}

/**
 * Atomically write JSON to `filePath` by first writing to a `.tmp`
 * sibling and then renaming (atomic on the same filesystem).
 */
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(tmpPath, json, "utf-8");
  await fs.rename(tmpPath, filePath);
}

// ============================================================
// MessageBus
// ============================================================

export class MessageBus extends EventEmitter {
  private watchers: Map<string, fs.FileHandle | ReturnType<typeof import("fs").watch>> = new Map();
  private fsWatchers: Map<string, ReturnType<typeof import("fs").watch>> = new Map();
  private watching = false;
  private database: AppDatabase | null = null;
  private sessionId: string | null = null;

  constructor(private runtimeDir: string) {
    super();
  }

  /** Set the database for SQLite-backed message storage */
  setDatabase(database: AppDatabase, sessionId: string): void {
    this.database = database;
    this.sessionId = sessionId;
  }

  // ----------------------------------------------------------
  // Directory helpers
  // ----------------------------------------------------------

  private inboxDir(agentId: string): string {
    return path.join(this.runtimeDir, MESSAGES_DIR, `inbox-${agentId}`);
  }

  private outboxDir(agentId: string): string {
    return path.join(this.runtimeDir, MESSAGES_DIR, `outbox-${agentId}`);
  }

  private processedDir(agentId: string, direction: "inbox" | "outbox"): string {
    const base = direction === "inbox" ? this.inboxDir(agentId) : this.outboxDir(agentId);
    return path.join(base, PROCESSED_DIR);
  }

  // ----------------------------------------------------------
  // Agent lifecycle
  // ----------------------------------------------------------

  /** Initialize inbox/outbox directories (and processed/ subdirs) for an agent. */
  async setupAgent(agentId: string): Promise<void> {
    try {
      await fs.mkdir(this.inboxDir(agentId), { recursive: true });
      await fs.mkdir(this.outboxDir(agentId), { recursive: true });
      await fs.mkdir(this.processedDir(agentId, "inbox"), { recursive: true });
      await fs.mkdir(this.processedDir(agentId, "outbox"), { recursive: true });

      // If we are already watching, start watching this new agent's outbox too
      if (this.watching) {
        this.watchOutbox(agentId);
      }
    } catch (err) {
      logger.error({ err: err }, `[MessageBus] Failed to setup agent ${agentId}:`);
    }
  }

  /** Remove inbox/outbox directories for an agent and stop its watcher. */
  async teardownAgent(agentId: string): Promise<void> {
    try {
      // Stop watching this agent's outbox
      const key = `outbox-${agentId}`;
      const watcher = this.fsWatchers.get(key);
      if (watcher) {
        watcher.close();
        this.fsWatchers.delete(key);
      }

      await fs.rm(this.inboxDir(agentId), { recursive: true, force: true });
      await fs.rm(this.outboxDir(agentId), { recursive: true, force: true });
    } catch (err) {
      logger.error({ err: err }, `[MessageBus] Failed to teardown agent ${agentId}:`);
    }
  }

  // ----------------------------------------------------------
  // Message delivery
  // ----------------------------------------------------------

  /** Write a message to an agent's inbox (SQLite primary, file fallback). */
  async deliverToInbox(agentId: string, message: AgentMessage): Promise<void> {
    // Primary: write to SQLite
    if (this.database?.isOpen && this.sessionId) {
      try {
        this.database.insertMessage({
          id: message.id,
          sessionId: this.sessionId,
          fromAgentId: message.from || "system",
          toAgentId: agentId,
          messageType: message.type || "text",
          content: message.content || JSON.stringify(message),
          createdAt: Date.now(),
          expiresAt: Date.now() + MESSAGE_EXPIRY_MS, // 7 days
        });
      } catch (err) {
        logger.error({ err }, `[MessageBus] Failed to insert message to SQLite for ${agentId}, falling back to file`);
      }
    }

    // Fallback: write to file (backward compatibility)
    try {
      const filename = generateMessageFilename(message.id);
      const filePath = path.join(this.inboxDir(agentId), filename);
      await atomicWriteJson(filePath, message);
    } catch (err) {
      logger.error({ err: err }, `[MessageBus] Failed to deliver message to inbox file of ${agentId}:`);
    }
  }

  /** Read all unprocessed messages from an agent's outbox. */
  async readOutbox(agentId: string): Promise<AgentMessage[]> {
    const messages: AgentMessage[] = [];
    try {
      const dir = this.outboxDir(agentId);
      const entries = await fs.readdir(dir);

      for (const entry of entries) {
        // Skip directories (e.g. processed/) and non-json files
        if (!entry.endsWith(".json")) continue;

        const filePath = path.join(dir, entry);
        try {
          const stat = await fs.stat(filePath);
          if (!stat.isFile()) continue;

          const raw = await fs.readFile(filePath, "utf-8");
          const message = JSON.parse(raw) as AgentMessage;
          messages.push(message);
        } catch (readErr) {
          logger.error({ err: readErr }, `[MessageBus] Failed to read outbox message ${entry}:`);
        }
      }
    } catch (err) {
      logger.error({ err: err }, `[MessageBus] Failed to read outbox for ${agentId}:`);
    }

    // Sort by timestamp embedded in the filename (prefix is Date.now())
    messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return messages;
  }

  // ----------------------------------------------------------
  // Processed handling
  // ----------------------------------------------------------

  /** Mark a message as processed by moving it to the processed/ subdirectory. */
  async markProcessed(
    agentId: string,
    direction: "inbox" | "outbox",
    filename: string,
  ): Promise<void> {
    try {
      const baseDir = direction === "inbox" ? this.inboxDir(agentId) : this.outboxDir(agentId);
      const src = path.join(baseDir, filename);
      const dest = path.join(this.processedDir(agentId, direction), filename);
      await fs.rename(src, dest);
    } catch (err) {
      logger.error({ err: err },
        `[MessageBus] Failed to mark ${direction} message ${filename} as processed for ${agentId}`,
      );
    }
  }

  // ----------------------------------------------------------
  // Watching
  // ----------------------------------------------------------

  /** Start watching all existing outbox directories for new messages. */
  startWatching(): void {
    if (this.watching) return;
    this.watching = true;

    this.discoverAndWatchOutboxes().catch((err) => {
      logger.error({ err: err }, "[MessageBus] Failed to discover outbox directories:");
    });
  }

  /** Stop all watchers. */
  stopWatching(): void {
    this.watching = false;
    for (const [key, watcher] of this.fsWatchers) {
      watcher.close();
    }
    this.fsWatchers.clear();
  }

  private async discoverAndWatchOutboxes(): Promise<void> {
    try {
      const messagesRoot = path.join(this.runtimeDir, MESSAGES_DIR);
      await fs.mkdir(messagesRoot, { recursive: true });

      const entries = await fs.readdir(messagesRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith("outbox-")) {
          const agentId = entry.name.slice("outbox-".length);
          this.watchOutbox(agentId);
        }
      }
    } catch (err) {
      logger.error({ err: err }, "[MessageBus] Error discovering outbox directories:");
    }
  }

  private watchOutbox(agentId: string): void {
    const key = `outbox-${agentId}`;
    // Don't double-watch
    if (this.fsWatchers.has(key)) return;

    const dir = this.outboxDir(agentId);

    try {
      // Use the synchronous fs.watch (from the 'fs' module, not fs/promises)
      // We import it dynamically to keep the top-level import using fs/promises.
      const nodeFs = require("fs");
      const watcher = nodeFs.watch(dir, (eventType: string, filename: string | null) => {
        if (!filename) return;
        if (!filename.endsWith(".json")) return;
        // Only care about new/renamed files
        if (eventType !== "rename") return;

        const filePath = path.join(dir, filename);
        this.handleNewOutboxFile(agentId, filePath, filename).catch((err) => {
          logger.error({ err: err }, `[MessageBus] Error handling outbox file ${filename}:`);
        });
      });

      watcher.on("error", (err: Error) => {
        logger.error({ err: err }, `[MessageBus] Watcher error for ${key}:`);
      });

      this.fsWatchers.set(key, watcher);
    } catch (err) {
      logger.error({ err: err }, `[MessageBus] Failed to watch outbox for ${agentId}:`);
    }
  }

  private async handleNewOutboxFile(
    agentId: string,
    filePath: string,
    filename: string,
  ): Promise<void> {
    try {
      // Small delay to ensure the atomic rename has completed
      await new Promise((resolve) => setTimeout(resolve, 50));

      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat || !stat.isFile()) return;

      const raw = await fs.readFile(filePath, "utf-8");
      const message = JSON.parse(raw) as AgentMessage;

      this.emit("message", message, agentId, filename);
    } catch (err) {
      // File may have been moved/deleted between event and read — that's fine
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      logger.error({ err: err }, `[MessageBus] Failed to read new outbox file ${filePath}:`);
    }
  }

  // ----------------------------------------------------------
  // Unread count
  // ----------------------------------------------------------

  /** Count unread messages for an agent (SQLite primary, file fallback) */
  async getUnreadCount(agentId: string): Promise<number> {
    // Primary: check SQLite — if available, this is the source of truth
    if (this.database?.isOpen) {
      try {
        return this.database.getUnreadMessageCount(agentId);
      } catch { /* SQLite query failed, fall through to file count */ }
    }

    // Fallback: count file-based messages (only if SQLite unavailable)
    let count = 0;

    // Count .md files in inbox (legacy MCP mode)
    try {
      const inboxEntries = await fs.readdir(this.inboxDir(agentId));
      count += inboxEntries.filter(f => f.endsWith(".md")).length;
    } catch { /* inbox may not exist */ }

    // Count .json files in mcp-pending (current MCP mode)
    try {
      const pendingDir = path.join(this.runtimeDir, "mcp-pending", agentId);
      const pendingEntries = await fs.readdir(pendingDir);
      count += pendingEntries.filter(f => f.endsWith(".json")).length;
    } catch { /* pending dir may not exist */ }

    return count;
  }

  /**
   * Migrate existing file-based inbox messages to SQLite.
   * Scans all inbox directories and imports unprocessed messages.
   * Idempotent — skips messages that already exist in SQLite.
   */
  async migrateFilesToSqlite(): Promise<number> {
    if (!this.database?.isOpen || !this.sessionId) return 0;

    let migrated = 0;
    const messagesRoot = path.join(this.runtimeDir, MESSAGES_DIR);

    try {
      const entries = await fs.readdir(messagesRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith("inbox-")) continue;

        const agentId = entry.name.slice("inbox-".length);
        const inboxPath = path.join(messagesRoot, entry.name);

        try {
          const files = await fs.readdir(inboxPath);
          const processedPath = path.join(inboxPath, PROCESSED_DIR);
          await fs.mkdir(processedPath, { recursive: true });

          for (const file of files) {
            if (!file.endsWith(".json") && !file.endsWith(".md")) continue;

            const filePath = path.join(inboxPath, file);
            try {
              const stat = await fs.stat(filePath);
              if (!stat.isFile()) continue;

              const raw = await fs.readFile(filePath, "utf-8");

              if (file.endsWith(".json")) {
                const msg = JSON.parse(raw) as AgentMessage;
                this.database!.insertMessage({
                  id: msg.id || uuidv4(),
                  sessionId: this.sessionId!,
                  fromAgentId: msg.from || "system",
                  toAgentId: agentId,
                  messageType: msg.type || "text",
                  content: msg.content || raw,
                  createdAt: new Date(msg.timestamp).getTime() || Date.now(),
                  expiresAt: Date.now() + MESSAGE_EXPIRY_MS,
                });
              } else {
                // .md files: content is the message text
                this.database!.insertMessage({
                  id: uuidv4(),
                  sessionId: this.sessionId!,
                  fromAgentId: "system",
                  toAgentId: agentId,
                  messageType: "text",
                  content: raw,
                  createdAt: stat.mtimeMs,
                  expiresAt: Date.now() + MESSAGE_EXPIRY_MS,
                });
              }

              // Move migrated file to processed/ to avoid double-counting
              try {
                await fs.rename(filePath, path.join(processedPath, file));
              } catch { /* best effort move */ }

              migrated++;
            } catch {
              // Skip malformed files or duplicate IDs (INSERT OR REPLACE handles dupes)
            }
          }
        } catch { /* inbox dir read error */ }
      }
    } catch { /* messages root may not exist */ }

    if (migrated > 0) {
      logger.info(`[MessageBus] Migrated ${migrated} file-based messages to SQLite`);
    }
    return migrated;
  }

  // ----------------------------------------------------------
  // Routing
  // ----------------------------------------------------------

  /**
   * Route a message from one agent to another.
   * Extracts the target agent ID from `message.to` and delivers to its inbox.
   */
  async routeMessage(message: AgentMessage): Promise<void> {
    try {
      // message.to is formatted as "{sessionId}:{agentId}" or "all"
      const target = message.to;

      if (target === "all") {
        // Broadcast: deliver to every agent's inbox
        const messagesRoot = path.join(this.runtimeDir, MESSAGES_DIR);
        const entries = await fs.readdir(messagesRoot, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith("inbox-")) {
            const agentId = entry.name.slice("inbox-".length);

            // Don't deliver to the sender
            const senderAgentId = message.from.includes(":")
              ? message.from.split(":")[1]
              : message.from;
            if (agentId === senderAgentId) continue;

            await this.deliverToInbox(agentId, message);
          }
        }
      } else {
        // Extract agentId from "{sessionId}:{agentId}"
        const agentId = target.includes(":") ? target.split(":")[1] : target;
        await this.deliverToInbox(agentId, message);
      }
    } catch (err) {
      logger.error({ err: err }, `[MessageBus] Failed to route message ${message.id}:`);
    }
  }
}
