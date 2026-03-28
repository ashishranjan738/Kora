/**
 * SQLite database for Kora.
 * Stores events, tasks, task comments, and agent state.
 * One database per session at {runtimeDir}/data.db
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { EventEmitter } from "events";

const SCHEMA_VERSION = 6;

/** Escape SQL LIKE wildcards (%, _) in user-provided search strings */
function escapeLike(str: string): string {
  return str.replace(/[%_]/g, '\\$&');
}

export class AppDatabase extends EventEmitter {
  public db: Database.Database;
  private _open = true;
  /** Closed-category status IDs from workflow states. Used for task-completed events. Default: ["done"] */
  private closedStatuses = new Set<string>(["done"]);
  /** First (initial) status ID from workflow states. Used for stale task exclusion. Default: "pending" */
  private firstStatus = "pending";

  /** Check if the database connection is still open */
  get isOpen(): boolean {
    return this._open && this.db.open;
  }

  /** Configure workflow-aware status sets. Call after session config is loaded. */
  setWorkflowStatuses(states: Array<{ id: string; category: string }>): void {
    const closed = states.filter(s => s.category === "closed").map(s => s.id);
    if (closed.length > 0) this.closedStatuses = new Set(closed);
    const first = states.find(s => s.category === "not-started");
    if (first) this.firstStatus = first.id;
  }

  /** Check if a status is a closed-category workflow state */
  isClosedStatus(status: string): boolean {
    return this.closedStatuses.has(status);
  }

  /** Get the first (not-started) workflow status */
  getFirstStatus(): string {
    return this.firstStatus;
  }

  constructor(runtimeDir: string) {
    super();
    const dbPath = path.join(runtimeDir, "data.db");
    fs.mkdirSync(runtimeDir, { recursive: true });

    this.db = new Database(dbPath);

    // Performance settings
    this.db.pragma("journal_mode = WAL");     // Write-ahead logging for concurrent reads
    this.db.pragma("synchronous = NORMAL");   // Faster writes, still safe with WAL
    this.db.pragma("cache_size = -8000");     // 8MB cache
    this.db.pragma("busy_timeout = 5000");    // Wait up to 5s if DB is locked
    this.db.pragma("foreign_keys = ON");     // Enable cascade deletes (tasks → comments)

    this.migrate();
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;

    if (version < 1) {
      this.db.exec(`
        -- Events table (replaces JSONL files)
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          data TEXT DEFAULT '{}',
          timestamp TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_session_time ON events(session_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

        -- Tasks table (replaces tasks.json)
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT DEFAULT '',
          status TEXT DEFAULT 'pending',
          assigned_to TEXT,
          created_by TEXT DEFAULT 'user',
          dependencies TEXT DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);

        -- Task comments table (replaces comments array in tasks.json)
        CREATE TABLE IF NOT EXISTS task_comments (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          text TEXT NOT NULL,
          author TEXT NOT NULL,
          author_name TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id);

        PRAGMA user_version = 1;
      `);
    }

    if (version < 2) {
      // Migration 2: Add priority column to tasks
      this.db.exec(`
        ALTER TABLE tasks ADD COLUMN priority TEXT DEFAULT 'P2';
        CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
        UPDATE tasks SET priority = 'P2' WHERE priority IS NULL;
        PRAGMA user_version = 2;
      `);
    }

    if (version < 3) {
      // Migration 3: Add labels (JSON array) and due_date columns
      this.db.exec(`
        ALTER TABLE tasks ADD COLUMN labels TEXT DEFAULT '[]';
        ALTER TABLE tasks ADD COLUMN due_date TEXT;
        CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
        PRAGMA user_version = 3;
      `);
    }

    if (version < 4) {
      this.db.exec(`
        ALTER TABLE events ADD COLUMN agent_id TEXT;
        CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id);
        PRAGMA user_version = 4;
      `);
    }

    if (version < 5) {
      // Migration 5: Add message_deliveries table for Tier 3 routing metrics
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS message_deliveries (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('sent', 'delivered', 'read')),
          enqueued_at INTEGER NOT NULL,
          delivered_at INTEGER,
          read_at INTEGER,
          latency_ms INTEGER,
          message_size_bytes INTEGER,
          priority TEXT CHECK(priority IN ('critical', 'high', 'normal', 'low'))
        );
        CREATE INDEX IF NOT EXISTS idx_message_deliveries_agent ON message_deliveries(agent_id, status);
        CREATE INDEX IF NOT EXISTS idx_message_deliveries_latency ON message_deliveries(latency_ms);
        CREATE INDEX IF NOT EXISTS idx_message_deliveries_session ON message_deliveries(session_id);
        PRAGMA user_version = 5;
      `);
    }

    if (version < 6) {
      // Migration 6: Add messages table for message content storage
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          from_agent_id TEXT NOT NULL,
          to_agent_id TEXT NOT NULL,
          message_type TEXT NOT NULL,
          content TEXT NOT NULL,
          priority TEXT CHECK(priority IN ('critical', 'high', 'normal', 'low')) DEFAULT 'normal',
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'read', 'expired')),
          created_at INTEGER NOT NULL,
          delivered_at INTEGER,
          read_at INTEGER,
          expires_at INTEGER,
          channel TEXT,
          parent_message_id TEXT,
          metadata TEXT DEFAULT '{}',
          payload TEXT DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_messages_recipient_status ON messages(to_agent_id, status);
        CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(from_agent_id);
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
        CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at);
        CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
        PRAGMA user_version = 6;
      `);
    }

    if (version < 7) {
      this.db.exec(`
        -- Add status_changed_at to tasks (tracks when status last changed)
        ALTER TABLE tasks ADD COLUMN status_changed_at TEXT;
        -- Backfill: set status_changed_at = updated_at for existing tasks
        UPDATE tasks SET status_changed_at = updated_at WHERE status_changed_at IS NULL;

        -- Task nudge history table
        CREATE TABLE IF NOT EXISTS task_nudges (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          status_at_nudge TEXT NOT NULL,
          target_agent_id TEXT,
          target_type TEXT NOT NULL,
          nudge_count INTEGER NOT NULL DEFAULT 1,
          is_escalation INTEGER NOT NULL DEFAULT 0,
          message TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_task_nudges_task ON task_nudges(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_nudges_session ON task_nudges(session_id);

        PRAGMA user_version = 7;
      `);
    }

    if (version < 8) {
      this.db.exec(`
        -- Add archived_at to tasks (NULL = not archived)
        ALTER TABLE tasks ADD COLUMN archived_at TEXT;
        CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived_at);
        PRAGMA user_version = 8;
      `);
    }

    if (version < 9) {
      this.db.exec(`
        -- Task state transition history for cycle time analytics
        CREATE TABLE IF NOT EXISTS task_state_transitions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          from_status TEXT,
          to_status TEXT NOT NULL,
          changed_by TEXT,
          changed_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_transitions_task ON task_state_transitions(task_id, changed_at);
        CREATE INDEX IF NOT EXISTS idx_transitions_session ON task_state_transitions(session_id);
        PRAGMA user_version = 9;
      `);
    }

    if (version < 10) {
      this.db.exec(`
        -- Custom per-agent reminders (nudge on condition)
        CREATE TABLE IF NOT EXISTS agent_reminders (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          target_agent_id TEXT NOT NULL,
          message TEXT NOT NULL,
          condition TEXT NOT NULL CHECK(condition IN ('when-idle', 'when-has-unread', 'when-no-task', 'always')),
          interval_minutes INTEGER NOT NULL DEFAULT 5,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_fired_at TEXT,
          created_at TEXT NOT NULL,
          created_by TEXT DEFAULT 'user'
        );
        CREATE INDEX IF NOT EXISTS idx_reminders_session ON agent_reminders(session_id);
        CREATE INDEX IF NOT EXISTS idx_reminders_agent ON agent_reminders(target_agent_id);
        PRAGMA user_version = 10;
      `);
    }

    if (version < 11) {
      this.db.exec(`
        -- Knowledge base: key-value entries shared between agents
        CREATE TABLE IF NOT EXISTS knowledge_entries (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          saved_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_session ON knowledge_entries(session_id);
        CREATE INDEX IF NOT EXISTS idx_knowledge_key ON knowledge_entries(session_id, key);
        PRAGMA user_version = 11;
      `);
    }

    if (version < 12) {
      this.db.exec(`
        -- Cron session schedules
        CREATE TABLE IF NOT EXISTS session_schedules (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          cron_expression TEXT NOT NULL,
          timezone TEXT NOT NULL DEFAULT 'system',
          playbook_id TEXT,
          session_config TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run_at TEXT,
          next_run_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON session_schedules(next_run_at, enabled);
        PRAGMA user_version = 12;
      `);
    }

    if (version < 13) {
      this.db.exec(`
        -- Agent tool call traces for replay/debug
        CREATE TABLE IF NOT EXISTS agent_traces (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          input_args TEXT,
          output_result TEXT,
          duration_ms INTEGER,
          success INTEGER NOT NULL DEFAULT 1,
          timestamp TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_traces_agent ON agent_traces(session_id, agent_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_traces_tool ON agent_traces(tool_name);
        PRAGMA user_version = 13;
      `);
    }

    if (version < 14) {
      this.db.exec(`
        -- Webhook triggers for external event-driven session spawning
        CREATE TABLE IF NOT EXISTS webhooks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          secret TEXT NOT NULL,
          playbook_id TEXT,
          session_config TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS webhook_events (
          id TEXT PRIMARY KEY,
          webhook_id TEXT NOT NULL,
          payload_hash TEXT,
          session_spawned TEXT,
          status TEXT NOT NULL DEFAULT 'success',
          timestamp TEXT NOT NULL,
          FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_webhook_events_webhook ON webhook_events(webhook_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_webhook_events_hash ON webhook_events(payload_hash, timestamp);
        PRAGMA user_version = 14;
      `);
    }

    if (version < 15) {
      this.db.exec(`
        -- Inline code comments (linked to files, lines, and optionally tasks)
        CREATE TABLE IF NOT EXISTS code_comments (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER,
          selected_text TEXT,
          commit_hash TEXT,
          comment TEXT NOT NULL,
          created_by TEXT NOT NULL DEFAULT 'user',
          created_at TEXT NOT NULL,
          task_id TEXT,
          resolved INTEGER NOT NULL DEFAULT 0,
          resolved_at TEXT,
          resolved_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_code_comments_session ON code_comments(session_id);
        CREATE INDEX IF NOT EXISTS idx_code_comments_file ON code_comments(session_id, file_path);
        CREATE INDEX IF NOT EXISTS idx_code_comments_task ON code_comments(task_id);
        CREATE INDEX IF NOT EXISTS idx_code_comments_resolved ON code_comments(session_id, resolved);
        PRAGMA user_version = 15;
      `);
    }

    if (version < 16) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS channels (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          created_by TEXT,
          created_at INTEGER NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_channels_session ON channels(session_id);
        PRAGMA user_version = 16;
      `);
    }

    if (version < 17) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS channel_members (
          channel_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          joined_at INTEGER NOT NULL,
          PRIMARY KEY (channel_id, agent_id)
        );
        CREATE INDEX IF NOT EXISTS idx_channel_members_session ON channel_members(session_id);
        CREATE INDEX IF NOT EXISTS idx_channel_members_agent ON channel_members(agent_id);
        PRAGMA user_version = 17;
      `);
    }
  }

  // ─── Channels ──────────────────────────────────────────────

  createChannel(channel: { id: string; sessionId: string; name: string; description?: string; createdBy?: string; isDefault?: boolean }): void {
    this.db.prepare(`INSERT OR IGNORE INTO channels (id, session_id, name, description, created_by, created_at, is_default) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(channel.id, channel.sessionId, channel.name, channel.description || null, channel.createdBy || null, Date.now(), channel.isDefault ? 1 : 0);
  }

  getChannels(sessionId: string): Array<{ id: string; name: string; description: string | null; createdBy: string | null; createdAt: number; isDefault: boolean }> {
    const rows = this.db.prepare(`SELECT id, name, description, created_by, created_at, is_default FROM channels WHERE session_id = ? ORDER BY is_default DESC, name ASC`).all(sessionId) as any[];
    return rows.map(r => ({ id: r.id, name: r.name, description: r.description, createdBy: r.created_by, createdAt: r.created_at, isDefault: !!r.is_default }));
  }

  deleteChannel(channelId: string): boolean {
    const result = this.db.prepare(`DELETE FROM channels WHERE id = ? AND is_default = 0`).run(channelId);
    return result.changes > 0;
  }

  // ─── Channel Memberships ────────────────────────────────

  joinChannel(sessionId: string, channelId: string, agentId: string): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO channel_members (channel_id, agent_id, session_id, joined_at) VALUES (?, ?, ?, ?)`
    ).run(channelId, agentId, sessionId, Date.now());
  }

  leaveChannel(channelId: string, agentId: string): boolean {
    const result = this.db.prepare(
      `DELETE FROM channel_members WHERE channel_id = ? AND agent_id = ?`
    ).run(channelId, agentId);
    return result.changes > 0;
  }

  getChannelMembers(channelId: string): string[] {
    const rows = this.db.prepare(
      `SELECT agent_id FROM channel_members WHERE channel_id = ? ORDER BY joined_at ASC`
    ).all(channelId) as any[];
    return rows.map(r => r.agent_id);
  }

  getAgentChannels(agentId: string): string[] {
    const rows = this.db.prepare(
      `SELECT channel_id FROM channel_members WHERE agent_id = ? ORDER BY joined_at ASC`
    ).all(agentId) as any[];
    return rows.map(r => r.channel_id);
  }

  getChannelMessages(channel: string, limit = 50, before?: string): Array<{ id: string; from: string; content: string; timestamp: string; channel: string }> {
    let sql = `SELECT id, from_agent_id as "from", content, created_at as timestamp, channel FROM messages WHERE channel = ?`;
    const params: unknown[] = [channel];
    if (before) { sql += ` AND created_at < ?`; params.push(before); }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(Math.min(limit, 100));
    return this.db.prepare(sql).all(...params) as any[];
  }

  // ─── Events ──────────────────────────────────────────────

  insertEvent(event: {
    id: string;
    sessionId: string;
    type: string;
    data: Record<string, unknown>;
    timestamp: string;
    agentId?: string;
  }): void {
    if (!this.isOpen) {
      throw new TypeError("The database connection is not open");
    }
    const stmt = this.db.prepare(
      `INSERT INTO events (id, session_id, type, data, timestamp, agent_id) VALUES (?, ?, ?, ?, ?, ?)`
    );
    stmt.run(event.id, event.sessionId, event.type, JSON.stringify(event.data), event.timestamp, event.agentId || null);
  }

  queryEvents(params: {
    sessionId?: string;
    since?: string;
    until?: string;
    before?: string;
    limit?: number;
    offset?: number;
    type?: string;
    types?: string[];
    agentId?: string;
    search?: string;
    order?: "asc" | "desc";
  }): Array<{ id: string; sessionId: string; type: string; data: any; timestamp: string; agentId?: string }> {
    const conditions: string[] = [];
    const values: any[] = [];

    if (params.sessionId) { conditions.push("session_id = ?"); values.push(params.sessionId); }
    if (params.since) { conditions.push("timestamp >= ?"); values.push(params.since); }
    if (params.until) { conditions.push("timestamp <= ?"); values.push(params.until); }
    if (params.before) { conditions.push("timestamp < ?"); values.push(params.before); }
    if (params.type) { conditions.push("type = ?"); values.push(params.type); }
    if (params.types && params.types.length > 0) {
      const placeholders = params.types.map(() => "?").join(", ");
      conditions.push(`type IN (${placeholders})`);
      values.push(...params.types);
    }
    if (params.agentId) { conditions.push("agent_id = ?"); values.push(params.agentId); }
    if (params.search) { conditions.push("data LIKE ? ESCAPE '\\'"); values.push(`%${escapeLike(params.search)}%`); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = params.order === "asc" ? "ASC" : "DESC";

    // Use parameterized LIMIT/OFFSET to prevent SQL injection
    let limitOffsetClause = "";
    if (params.limit) { limitOffsetClause += " LIMIT ?"; values.push(params.limit); }
    if (params.offset) {
      if (!params.limit) { limitOffsetClause += " LIMIT ?"; values.push(999999); }
      limitOffsetClause += " OFFSET ?"; values.push(params.offset);
    }

    const rows = this.db.prepare(
      `SELECT id, session_id, type, data, timestamp, agent_id FROM events ${where} ORDER BY timestamp ${order}${limitOffsetClause}`
    ).all(...values) as Array<{ id: string; session_id: string; type: string; data: string; timestamp: string; agent_id: string | null }>;

    return rows.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      type: r.type,
      data: JSON.parse(r.data || "{}"),
      timestamp: r.timestamp,
      agentId: r.agent_id || undefined,
    }));
  }

  countEvents(params: {
    sessionId?: string;
    since?: string;
    until?: string;
    before?: string;
    type?: string;
    types?: string[];
    agentId?: string;
    search?: string;
  }): number {
    const conditions: string[] = [];
    const values: any[] = [];

    if (params.sessionId) { conditions.push("session_id = ?"); values.push(params.sessionId); }
    if (params.since) { conditions.push("timestamp >= ?"); values.push(params.since); }
    if (params.until) { conditions.push("timestamp <= ?"); values.push(params.until); }
    if (params.before) { conditions.push("timestamp < ?"); values.push(params.before); }
    if (params.type) { conditions.push("type = ?"); values.push(params.type); }
    if (params.types && params.types.length > 0) {
      const placeholders = params.types.map(() => "?").join(", ");
      conditions.push(`type IN (${placeholders})`);
      values.push(...params.types);
    }
    if (params.agentId) { conditions.push("agent_id = ?"); values.push(params.agentId); }
    if (params.search) { conditions.push("data LIKE ? ESCAPE '\\'"); values.push(`%${escapeLike(params.search)}%`); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM events ${where}`).get(...values) as { count: number };
    return row.count;
  }

  // ─── Tasks ───────────────────────────────────────────────

  insertTask(task: {
    id: string;
    sessionId: string;
    title: string;
    description: string;
    status: string;
    assignedTo?: string;
    createdBy: string;
    dependencies?: string[];
    priority?: string;
    labels?: string[];
    dueDate?: string;
    createdAt: string;
    updatedAt: string;
  }): void {
    const stmt = this.db.prepare(
      `INSERT INTO tasks (id, session_id, title, description, status, assigned_to, created_by, dependencies, priority, labels, due_date, created_at, updated_at, status_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      task.id, task.sessionId, task.title, task.description, task.status,
      task.assignedTo || null, task.createdBy,
      JSON.stringify(task.dependencies || []),
      task.priority || "P2",
      JSON.stringify(task.labels || []),
      task.dueDate || null,
      task.createdAt, task.updatedAt,
      task.createdAt, // status_changed_at = createdAt for new tasks (prevents false stale alerts)
    );
  }

  getTasks(sessionId: string, includeArchived = false): Array<any> {
    const archiveFilter = includeArchived ? "" : " AND archived_at IS NULL";
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE session_id = ?${archiveFilter} ORDER BY created_at DESC`
    ).all(sessionId) as any[];

    return rows.map(r => this.mapTaskRow(r, true));
  }

  /**
   * Query tasks with optional filters.
   * @param sessionId - Session ID
   * @param filters.assignedTo - Filter by assigned agent (optional, null = all)
   * @param filters.status - Filter by status or "active" shortcut (pending+in-progress+review)
   * @param filters.priority - Filter by priority (P0, P1, P2, P3)
   * @param filters.label - Filter by label (tasks containing this label)
   * @param filters.due - Filter by due date: "overdue", "today", "week", or YYYY-MM-DD
   * @param filters.sortBy - Sort: "created" (default), "due" (by due_date ASC NULLS LAST), "priority"
   * @param filters.summary - If true, return compact fields only (no description, comments, dependencies)
   */
  getFilteredTasks(sessionId: string, filters: {
    assignedTo?: string | null;
    status?: string | null;
    activeStatuses?: string[]; // When status="active", use these IDs instead of hardcoded defaults
    priority?: string | null;
    label?: string | null;
    due?: string | null;
    sortBy?: string | null;
    summary?: boolean;
  } = {}): Array<any> {
    const conditions: string[] = ["session_id = ?"];
    const values: any[] = [sessionId];

    if (filters.assignedTo) {
      conditions.push("assigned_to = ?");
      values.push(filters.assignedTo);
    }

    if (filters.status) {
      if (filters.status === "active") {
        // "active" shortcut: match all non-closed statuses.
        // Use activeStatuses if provided (from session workflow states),
        // otherwise fall back to default statuses for backward compat.
        const activeList = filters.activeStatuses && filters.activeStatuses.length > 0
          ? filters.activeStatuses
          : ["pending", "in-progress", "review"];
        const placeholders = activeList.map(() => "?").join(", ");
        conditions.push(`status IN (${placeholders})`);
        values.push(...activeList);
      } else {
        conditions.push("status = ?");
        values.push(filters.status);
      }
    }

    if (filters.priority) {
      conditions.push("priority = ?");
      values.push(filters.priority);
    }

    if (filters.label) {
      // Use json_each to match labels within the JSON array
      conditions.push("EXISTS (SELECT 1 FROM json_each(labels) WHERE json_each.value = ?)");
      values.push(filters.label);
    }

    if (filters.due) {
      const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
      if (filters.due === "overdue") {
        conditions.push("due_date IS NOT NULL AND due_date < ?");
        values.push(today);
      } else if (filters.due === "today") {
        conditions.push("due_date = ?");
        values.push(today);
      } else if (filters.due === "week") {
        const weekFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
        conditions.push("due_date IS NOT NULL AND due_date <= ?");
        values.push(weekFromNow);
      } else {
        // Exact date match
        conditions.push("due_date = ?");
        values.push(filters.due);
      }
    }

    const where = conditions.join(" AND ");

    // Sort order
    let orderBy = "created_at DESC";
    if (filters.sortBy === "due") {
      orderBy = "CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC, created_at DESC";
    } else if (filters.sortBy === "priority") {
      orderBy = "CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END, created_at DESC";
    }

    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE ${where} ORDER BY ${orderBy}`
    ).all(...values) as any[];

    const isSummary = filters.summary !== false; // default true
    return rows.map(r => this.mapTaskRow(r, !isSummary));
  }

  /** Map a raw DB row to a task object */
  private mapTaskRow(r: any, includeDetails: boolean): any {
    const base: any = {
      id: r.id,
      sessionId: r.session_id,
      title: r.title,
      status: r.status,
      assignedTo: r.assigned_to,
      priority: r.priority || "P2",
      labels: JSON.parse(r.labels || "[]"),
      dueDate: r.due_date || null,
    };

    if (includeDetails) {
      base.description = r.description;
      base.createdBy = r.created_by;
      base.dependencies = JSON.parse(r.dependencies || "[]");
      base.createdAt = r.created_at;
      base.updatedAt = r.updated_at;
      base.comments = this.getTaskComments(r.id);
    }

    return base;
  }

  getTask(taskId: string): any | null {
    const r = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as any;
    if (!r) return null;
    return this.mapTaskRow(r, true);
  }

  updateTask(taskId: string, updates: {
    title?: string;
    description?: string;
    status?: string;
    assignedTo?: string;
    priority?: string;
    labels?: string[];
    dueDate?: string | null;
  }): any | null {
    const task = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as any;
    if (!task) return null;

    const newTitle = updates.title !== undefined ? updates.title : task.title;
    const newDesc = updates.description !== undefined ? updates.description : task.description;
    const newStatus = updates.status !== undefined ? updates.status : task.status;
    const newAssigned = updates.assignedTo !== undefined ? (updates.assignedTo || null) : task.assigned_to;
    const newPriority = updates.priority !== undefined ? updates.priority : (task.priority || "P2");
    const newLabels = updates.labels !== undefined ? JSON.stringify(updates.labels) : (task.labels || "[]");
    const newDueDate = updates.dueDate !== undefined ? (updates.dueDate || null) : task.due_date;
    const now = new Date().toISOString();

    // Track when status actually changed (for stale task detection)
    const statusChanged = task.status !== newStatus;
    const statusChangedAt = statusChanged ? now : (task.status_changed_at || now);

    this.db.prepare(
      `UPDATE tasks SET title = ?, description = ?, status = ?, assigned_to = ?, priority = ?, labels = ?, due_date = ?, updated_at = ?, status_changed_at = ? WHERE id = ?`
    ).run(newTitle, newDesc, newStatus, newAssigned, newPriority, newLabels, newDueDate, now, statusChangedAt, taskId);

    // Record state transition for cycle time analytics
    if (statusChanged) {
      try {
        const { randomUUID } = require("crypto");
        this.insertTransition({
          id: randomUUID().slice(0, 12),
          taskId,
          sessionId: task.session_id,
          fromStatus: task.status,
          toStatus: newStatus,
          changedBy: newAssigned || undefined,
          changedAt: now,
        });
      } catch { /* non-fatal */ }
    }

    // Emit task-completed event if status changed to any closed-category state
    const wasCompleted = !this.closedStatuses.has(task.status) && this.closedStatuses.has(newStatus);
    if (wasCompleted) {
      this.emit("task-completed", { taskId, title: newTitle, assignedTo: newAssigned });
    }

    return this.getTask(taskId);
  }

  deleteTask(taskId: string): boolean {
    const result = this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);
    return result.changes > 0;
  }

  // ─── Task Comments ───────────────────────────────────────

  addTaskComment(comment: {
    id: string;
    taskId: string;
    text: string;
    author: string;
    authorName?: string;
    createdAt: string;
  }): void {
    this.db.prepare(
      `INSERT INTO task_comments (id, task_id, text, author, author_name, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(comment.id, comment.taskId, comment.text, comment.author, comment.authorName || null, comment.createdAt);

    // Also update the task's updated_at
    this.db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(comment.createdAt, comment.taskId);
  }

  getTaskComments(taskId: string): Array<any> {
    const rows = this.db.prepare(
      `SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC`
    ).all(taskId) as any[];

    return rows.map(r => ({
      id: r.id,
      text: r.text,
      author: r.author,
      authorName: r.author_name,
      createdAt: r.created_at,
    }));
  }

  // ─── Message Deliveries (Tier 3 Event Routing) ────────────────

  /** Track a message delivery (Tier 3 routing metrics) */
  trackMessageDelivery(delivery: {
    id: string;
    sessionId: string;
    messageId: string;
    agentId: string;
    status: 'sent' | 'delivered' | 'read';
    enqueuedAt: number;
    deliveredAt?: number;
    readAt?: number;
    messageSizeBytes?: number;
    priority?: 'critical' | 'high' | 'normal' | 'low';
  }): void {
    const latencyMs = delivery.deliveredAt ? delivery.deliveredAt - delivery.enqueuedAt : null;

    this.db.prepare(`
      INSERT OR REPLACE INTO message_deliveries
      (id, session_id, message_id, agent_id, status, enqueued_at, delivered_at, read_at, latency_ms, message_size_bytes, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      delivery.id,
      delivery.sessionId,
      delivery.messageId,
      delivery.agentId,
      delivery.status,
      delivery.enqueuedAt,
      delivery.deliveredAt || null,
      delivery.readAt || null,
      latencyMs,
      delivery.messageSizeBytes || null,
      delivery.priority || null
    );
  }

  /** Update message delivery status */
  updateMessageDeliveryStatus(messageId: string, agentId: string, status: 'sent' | 'delivered' | 'read'): void {
    const now = Date.now();
    const updateField = status === 'delivered' ? 'delivered_at' : status === 'read' ? 'read_at' : null;

    if (updateField) {
      // Update timestamp and recalculate latency if delivered
      const stmt = this.db.prepare(`
        UPDATE message_deliveries
        SET status = ?, ${updateField} = ?,
            latency_ms = CASE WHEN ? = 'delivered' THEN (? - enqueued_at) ELSE latency_ms END
        WHERE message_id = ? AND agent_id = ?
      `);
      stmt.run(status, now, status, now, messageId, agentId);
    } else {
      this.db.prepare(`
        UPDATE message_deliveries SET status = ? WHERE message_id = ? AND agent_id = ?
      `).run(status, messageId, agentId);
    }
  }

  /** Get delivery metrics for an agent */
  getDeliveryMetrics(agentId: string, since?: number): {
    avgLatencyMs: number;
    successRate: number;
    failureCount: number;
    totalMessages: number;
    queueDepth: number;
  } {
    // Validate input to prevent SQL injection
    if (since !== undefined && (isNaN(since) || since < 0)) {
      throw new TypeError('Invalid since parameter: must be a positive number');
    }

    const now = Date.now();
    // Build params in order of SQL placeholders: now (failure calc), agentId (WHERE), since (optional AND)
    const params: (string | number)[] = [now, agentId];
    let sinceClause = '';

    if (since !== undefined) {
      sinceClause = 'AND enqueued_at >= ?';
      params.push(since);
    }

    const stats = this.db.prepare(`
      SELECT
        AVG(latency_ms) as avg_latency,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'delivered' OR status = 'read' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN status = 'sent' AND (? - enqueued_at) > 60000 THEN 1 ELSE 0 END) as failed
      FROM message_deliveries
      WHERE agent_id = ? ${sinceClause}
    `).get(...params) as any;

    return {
      avgLatencyMs: stats.avg_latency || 0,
      successRate: stats.total > 0 ? (stats.delivered / stats.total) * 100 : 100,
      failureCount: stats.failed || 0,
      totalMessages: stats.total || 0,
      queueDepth: 0, // This will be filled from MessageQueue.getQueueDepth()
    };
  }

  /** Get recent delivery failures for an agent */
  getRecentDeliveryFailures(agentId: string, limit = 10): Array<{
    messageId: string;
    enqueuedAt: number;
    priority: string;
  }> {
    const now = Date.now();
    const rows = this.db.prepare(`
      SELECT message_id, enqueued_at, priority
      FROM message_deliveries
      WHERE agent_id = ?
        AND status = 'sent'
        AND (? - enqueued_at) > 60000
      ORDER BY enqueued_at DESC
      LIMIT ?
    `).all(agentId, now, limit) as any[];

    return rows.map(r => ({
      messageId: r.message_id,
      enqueuedAt: r.enqueued_at,
      priority: r.priority,
    }));
  }

  // ─── Task Nudges (Stale Task Watchdog) ─────────────────────

  insertNudge(nudge: {
    id: string;
    taskId: string;
    sessionId: string;
    statusAtNudge: string;
    targetAgentId?: string;
    targetType: string;
    nudgeCount: number;
    isEscalation: boolean;
    message?: string;
  }): void {
    this.db.prepare(
      `INSERT INTO task_nudges (id, task_id, session_id, status_at_nudge, target_agent_id, target_type, nudge_count, is_escalation, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(nudge.id, nudge.taskId, nudge.sessionId, nudge.statusAtNudge, nudge.targetAgentId || null, nudge.targetType, nudge.nudgeCount, nudge.isEscalation ? 1 : 0, nudge.message || null, new Date().toISOString());
  }

  getNudgeCount(taskId: string, status: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM task_nudges WHERE task_id = ? AND status_at_nudge = ?`
    ).get(taskId, status) as any;
    return row?.count ?? 0;
  }

  getNudgeHistory(taskId: string, limit = 20): any[] {
    return this.db.prepare(
      `SELECT * FROM task_nudges WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(taskId, limit) as any[];
  }

  getSessionNudgeHistory(sessionId: string, limit = 50): any[] {
    return this.db.prepare(
      `SELECT n.*, t.title as task_title, t.assigned_to FROM task_nudges n JOIN tasks t ON n.task_id = t.id WHERE n.session_id = ? ORDER BY n.created_at DESC LIMIT ?`
    ).all(sessionId, limit) as any[];
  }

  /** Get stale tasks — tasks where status hasn't changed in more than `thresholdMinutes` */
  getStaleTasks(sessionId: string, statuses: string[], thresholdMinutes: number): any[] {
    const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();
    const placeholders = statuses.map(() => "?").join(", ");
    // Exclude closed-category and first (not-started) statuses dynamically
    const excludeStatuses = [...this.closedStatuses, this.firstStatus];
    const excludePlaceholders = excludeStatuses.map(() => "?").join(", ");
    return this.db.prepare(
      `SELECT * FROM tasks WHERE session_id = ? AND status IN (${placeholders}) AND status NOT IN (${excludePlaceholders}) AND COALESCE(status_changed_at, created_at) < ? ORDER BY COALESCE(status_changed_at, created_at) ASC`
    ).all(sessionId, ...statuses, ...excludeStatuses, cutoff) as any[];
  }

  // ─── Task State Transitions ─────────────────────────────────

  /** Record a task state transition */
  insertTransition(transition: {
    id: string;
    taskId: string;
    sessionId: string;
    fromStatus: string | null;
    toStatus: string;
    changedBy?: string;
    changedAt: string;
  }): void {
    this.db.prepare(
      `INSERT INTO task_state_transitions (id, task_id, session_id, from_status, to_status, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      transition.id, transition.taskId, transition.sessionId,
      transition.fromStatus, transition.toStatus,
      transition.changedBy || null, transition.changedAt,
    );
  }

  /** Get state transition history for a task */
  getTransitions(taskId: string, limit = 50): Array<{
    id: string;
    taskId: string;
    fromStatus: string | null;
    toStatus: string;
    changedBy: string | null;
    changedAt: string;
  }> {
    const rows = this.db.prepare(
      `SELECT * FROM task_state_transitions WHERE task_id = ? ORDER BY changed_at ASC LIMIT ?`
    ).all(taskId, limit) as any[];

    return rows.map(r => ({
      id: r.id,
      taskId: r.task_id,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      changedBy: r.changed_by,
      changedAt: r.changed_at,
    }));
  }

  /** Get time spent in each status for a task (cycle time breakdown) */
  getStatusDurations(taskId: string): Record<string, number> {
    const transitions = this.getTransitions(taskId, 1000);
    const durations: Record<string, number> = {};

    for (let i = 0; i < transitions.length; i++) {
      const t = transitions[i];
      const nextTime = i + 1 < transitions.length
        ? new Date(transitions[i + 1].changedAt).getTime()
        : Date.now();
      const duration = nextTime - new Date(t.changedAt).getTime();
      const status = t.toStatus;
      durations[status] = (durations[status] || 0) + duration;
    }

    return durations;
  }

  /** Clean up old delivery records (keep last 7 days) */
  cleanupOldDeliveries(daysToKeep = 7): number {
    const cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
    const result = this.db.prepare(
      `DELETE FROM message_deliveries WHERE enqueued_at < ?`
    ).run(cutoff);
    return result.changes;
  }

  // ─── Agent Traces (Replay/Debug) ─────────────────────────────

  /** Insert a tool call trace */
  insertTrace(trace: {
    id: string; sessionId: string; agentId: string; toolName: string;
    inputArgs?: string; outputResult?: string; durationMs?: number;
    success: boolean; timestamp: string;
  }): void {
    // Truncate large results to 10KB
    const maxLen = 10240;
    const input = trace.inputArgs && trace.inputArgs.length > maxLen ? trace.inputArgs.slice(0, maxLen) + "...[truncated]" : trace.inputArgs;
    const output = trace.outputResult && trace.outputResult.length > maxLen ? trace.outputResult.slice(0, maxLen) + "...[truncated]" : trace.outputResult;
    this.db.prepare(
      `INSERT INTO agent_traces (id, session_id, agent_id, tool_name, input_args, output_result, duration_ms, success, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(trace.id, trace.sessionId, trace.agentId, trace.toolName, input || null, output || null, trace.durationMs || null, trace.success ? 1 : 0, trace.timestamp);
  }

  /** Get traces for an agent with optional filters */
  getTraces(sessionId: string, agentId: string, filters?: {
    toolName?: string; success?: boolean; limit?: number; before?: string;
  }): any[] {
    const conditions = ["session_id = ?", "agent_id = ?"];
    const values: any[] = [sessionId, agentId];
    if (filters?.toolName) { conditions.push("tool_name = ?"); values.push(filters.toolName); }
    if (filters?.success !== undefined) { conditions.push("success = ?"); values.push(filters.success ? 1 : 0); }
    if (filters?.before) { conditions.push("timestamp < ?"); values.push(filters.before); }
    const limit = filters?.limit || 100;
    return this.db.prepare(
      `SELECT * FROM agent_traces WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC LIMIT ?`
    ).all(...values, limit) as any[];
  }

  /** Cleanup old traces (24h retention) */
  cleanupOldTraces(hoursToKeep = 24): number {
    const cutoff = new Date(Date.now() - hoursToKeep * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`DELETE FROM agent_traces WHERE timestamp < ?`).run(cutoff);
    return result.changes;
  }

  // ─── Webhooks ──────────────────────────────────────────────────

  insertWebhook(wh: { id: string; name: string; secret: string; playbookId?: string; sessionConfig?: any; enabled?: boolean }): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO webhooks (id, name, secret, playbook_id, session_config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(wh.id, wh.name, wh.secret, wh.playbookId || null, wh.sessionConfig ? JSON.stringify(wh.sessionConfig) : null, wh.enabled !== false ? 1 : 0, now, now);
  }

  getWebhooks(): any[] {
    return (this.db.prepare(`SELECT * FROM webhooks ORDER BY created_at DESC`).all() as any[]).map(w => ({
      ...w, enabled: !!w.enabled, sessionConfig: w.session_config ? JSON.parse(w.session_config) : null,
    }));
  }

  getWebhook(id: string): any | undefined {
    const w = this.db.prepare(`SELECT * FROM webhooks WHERE id = ?`).get(id) as any;
    if (!w) return undefined;
    return { ...w, enabled: !!w.enabled, sessionConfig: w.session_config ? JSON.parse(w.session_config) : null };
  }

  updateWebhook(id: string, updates: { name?: string; secret?: string; enabled?: boolean; sessionConfig?: any }): any | undefined {
    const wh = this.getWebhook(id);
    if (!wh) return undefined;
    const name = updates.name ?? wh.name;
    const secret = updates.secret ?? wh.secret;
    const enabled = updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : (wh.enabled ? 1 : 0);
    const config = updates.sessionConfig !== undefined ? JSON.stringify(updates.sessionConfig) : wh.session_config;
    this.db.prepare(`UPDATE webhooks SET name = ?, secret = ?, enabled = ?, session_config = ?, updated_at = ? WHERE id = ?`).run(name, secret, enabled, config, new Date().toISOString(), id);
    return this.getWebhook(id);
  }

  deleteWebhook(id: string): boolean {
    const r = this.db.prepare(`DELETE FROM webhooks WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  insertWebhookEvent(evt: { id: string; webhookId: string; payloadHash?: string; sessionSpawned?: string; status?: string }): void {
    this.db.prepare(
      `INSERT INTO webhook_events (id, webhook_id, payload_hash, session_spawned, status, timestamp) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(evt.id, evt.webhookId, evt.payloadHash || null, evt.sessionSpawned || null, evt.status || "success", new Date().toISOString());
  }

  getWebhookEvents(webhookId: string, limit = 20): any[] {
    return this.db.prepare(`SELECT * FROM webhook_events WHERE webhook_id = ? ORDER BY timestamp DESC LIMIT ?`).all(webhookId, limit) as any[];
  }

  /** Check if same payload was received within dedup window (60s) */
  isWebhookDuplicate(webhookId: string, payloadHash: string, windowSeconds = 60): boolean {
    const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString();
    const row = this.db.prepare(`SELECT 1 FROM webhook_events WHERE webhook_id = ? AND payload_hash = ? AND timestamp > ? LIMIT 1`).get(webhookId, payloadHash, cutoff) as any;
    return !!row;
  }

  // ─── Agent Reminders ─────────────────────────────────────────

  insertReminder(reminder: {
    id: string;
    sessionId: string;
    targetAgentId: string;
    message: string;
    condition: "when-idle" | "when-has-unread" | "when-no-task" | "always";
    intervalMinutes?: number;
    enabled?: boolean;
    createdBy?: string;
  }): void {
    this.db.prepare(
      `INSERT INTO agent_reminders (id, session_id, target_agent_id, message, condition, interval_minutes, enabled, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      reminder.id, reminder.sessionId, reminder.targetAgentId,
      reminder.message, reminder.condition,
      reminder.intervalMinutes ?? 5, reminder.enabled !== false ? 1 : 0,
      new Date().toISOString(), reminder.createdBy || "user",
    );
  }

  getReminders(sessionId: string): Array<any> {
    return this.db.prepare(
      `SELECT * FROM agent_reminders WHERE session_id = ? ORDER BY created_at ASC`
    ).all(sessionId) as any[];
  }

  getRemindersForAgent(sessionId: string, agentId: string): Array<any> {
    return this.db.prepare(
      `SELECT * FROM agent_reminders WHERE session_id = ? AND target_agent_id = ? AND enabled = 1 ORDER BY created_at ASC`
    ).all(sessionId, agentId) as any[];
  }

  updateReminder(id: string, updates: { message?: string; condition?: string; intervalMinutes?: number; enabled?: boolean }): boolean {
    const reminder = this.db.prepare(`SELECT * FROM agent_reminders WHERE id = ?`).get(id) as any;
    if (!reminder) return false;
    this.db.prepare(
      `UPDATE agent_reminders SET message = ?, condition = ?, interval_minutes = ?, enabled = ? WHERE id = ?`
    ).run(
      updates.message ?? reminder.message,
      updates.condition ?? reminder.condition,
      updates.intervalMinutes ?? reminder.interval_minutes,
      updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : reminder.enabled,
      id,
    );
    return true;
  }

  deleteReminder(id: string): boolean {
    return this.db.prepare(`DELETE FROM agent_reminders WHERE id = ?`).run(id).changes > 0;
  }

  updateReminderFiredAt(id: string): void {
    this.db.prepare(`UPDATE agent_reminders SET last_fired_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  // ─── Knowledge Base ──────────────────────────────────────────

  saveKnowledge(entry: { id: string; sessionId: string; key: string; value: string; savedBy?: string }): void {
    const now = new Date().toISOString();
    // Upsert: if key exists for this session, update value
    const existing = this.db.prepare(
      `SELECT id FROM knowledge_entries WHERE session_id = ? AND key = ?`
    ).get(entry.sessionId, entry.key) as any;

    if (existing) {
      this.db.prepare(
        `UPDATE knowledge_entries SET value = ?, saved_by = ?, updated_at = ? WHERE id = ?`
      ).run(entry.value, entry.savedBy || null, now, existing.id);
    } else {
      this.db.prepare(
        `INSERT INTO knowledge_entries (id, session_id, key, value, saved_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(entry.id, entry.sessionId, entry.key, entry.value, entry.savedBy || null, now, now);
    }
  }

  getKnowledge(sessionId: string, key: string): { key: string; value: string; savedBy: string | null; updatedAt: string } | null {
    const row = this.db.prepare(
      `SELECT key, value, saved_by, updated_at FROM knowledge_entries WHERE session_id = ? AND key = ?`
    ).get(sessionId, key) as any;
    if (!row) return null;
    return { key: row.key, value: row.value, savedBy: row.saved_by, updatedAt: row.updated_at };
  }

  searchKnowledge(sessionId: string, query: string, limit = 20): Array<{ key: string; value: string; savedBy: string | null; updatedAt: string }> {
    const pattern = `%${escapeLike(query)}%`;
    const rows = this.db.prepare(
      `SELECT key, value, saved_by, updated_at FROM knowledge_entries WHERE session_id = ? AND (key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT ?`
    ).all(sessionId, pattern, pattern, limit) as any[];
    return rows.map(r => ({ key: r.key, value: r.value, savedBy: r.saved_by, updatedAt: r.updated_at }));
  }

  deleteKnowledge(sessionId: string, key: string): boolean {
    const result = this.db.prepare(
      `DELETE FROM knowledge_entries WHERE session_id = ? AND key = ?`
    ).run(sessionId, key);
    return result.changes > 0;
  }

  listKnowledge(sessionId: string, limit = 50): Array<{ key: string; value: string; savedBy: string | null; updatedAt: string }> {
    const rows = this.db.prepare(
      `SELECT key, value, saved_by, updated_at FROM knowledge_entries WHERE session_id = ? ORDER BY updated_at DESC LIMIT ?`
    ).all(sessionId, limit) as any[];
    return rows.map(r => ({ key: r.key, value: r.value, savedBy: r.saved_by, updatedAt: r.updated_at }));
  }

  // ─── Task Archival ────────────────────────────────────────────

  /** Archive done tasks older than `daysOld` days. Returns count of archived tasks. */
  archiveDoneTasks(sessionId: string, daysOld = 7): number {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `UPDATE tasks SET archived_at = ? WHERE session_id = ? AND status = 'done' AND archived_at IS NULL AND updated_at < ?`
    ).run(now, sessionId, cutoff);
    return result.changes;
  }

  /** Get count of archived tasks in a session */
  getArchivedCount(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM tasks WHERE session_id = ? AND archived_at IS NOT NULL`
    ).get(sessionId) as any;
    return row?.count ?? 0;
  }

  /** Unarchive a task */
  unarchiveTask(taskId: string): void {
    this.db.prepare(`UPDATE tasks SET archived_at = NULL WHERE id = ?`).run(taskId);
  }

  // ─── Task Import (Cross-Session Copy) ────────────────────────

  /**
   * Import tasks from another session's database.
   * @param targetSessionId - The new session to copy tasks INTO
   * @param sourceDb - The source session's database
   * @param sourceSessionId - The source session ID
   * @param mode - "active" (skip done/archived), "all" (everything including done)
   * @returns Number of tasks imported
   */
  importTasks(targetSessionId: string, sourceDb: AppDatabase, sourceSessionId: string, mode: "active" | "all"): number {
    const { randomUUID } = require("crypto");
    const now = new Date().toISOString();

    // Get tasks from source based on mode
    const sourceTasks = mode === "active"
      ? sourceDb.getTasks(sourceSessionId, false).filter((t: any) => t.status !== "done")
      : sourceDb.getTasks(sourceSessionId, true);

    if (sourceTasks.length === 0) return 0;

    const insert = this.db.prepare(
      `INSERT INTO tasks (id, session_id, title, description, status, assigned_to, created_by, dependencies, priority, labels, due_date, created_at, updated_at, status_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const insertMany = this.db.transaction((tasks: any[]) => {
      let count = 0;
      for (const t of tasks) {
        const newId = randomUUID().slice(0, 8);
        insert.run(
          newId, targetSessionId, t.title, t.description || "",
          mode === "active" ? t.status : t.status, // preserve status
          null, // unassign — agents are different in new session
          "imported",
          JSON.stringify([]), // clear dependencies — IDs won't match
          t.priority || "P2",
          JSON.stringify(t.labels || []),
          t.dueDate || null,
          now, now, now,
        );
        count++;
      }
      return count;
    });

    return insertMany(sourceTasks);
  }

  // ─── Messages (Inter-Agent Communication) ────────────────────

  /** Insert a new message */
  insertMessage(message: {
    id: string;
    sessionId: string;
    fromAgentId: string;
    toAgentId: string;
    messageType: string;
    content: string;
    priority?: 'critical' | 'high' | 'normal' | 'low';
    createdAt: number;
    expiresAt?: number;
    channel?: string;
    parentMessageId?: string;
    metadata?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO messages (
        id, session_id, from_agent_id, to_agent_id, message_type, content,
        priority, status, created_at, expires_at, channel, parent_message_id,
        metadata, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.sessionId,
      message.fromAgentId,
      message.toAgentId,
      message.messageType,
      message.content,
      message.priority || 'normal',
      message.createdAt,
      message.expiresAt || null,
      message.channel || null,
      message.parentMessageId || null,
      JSON.stringify(message.metadata || {}),
      JSON.stringify(message.payload || {})
    );
  }

  /** Get messages for a recipient with optional filters */
  getMessages(params: {
    toAgentId?: string;
    fromAgentId?: string;
    sessionId?: string;
    status?: 'pending' | 'delivered' | 'read' | 'expired' | Array<'pending' | 'delivered' | 'read' | 'expired'>;
    channel?: string;
    since?: number;
    limit?: number;
    offset?: number;
  }): Array<{
    id: string;
    sessionId: string;
    fromAgentId: string;
    toAgentId: string;
    messageType: string;
    content: string;
    priority: string;
    status: string;
    createdAt: number;
    deliveredAt: number | null;
    readAt: number | null;
    expiresAt: number | null;
    channel: string | null;
    parentMessageId: string | null;
    metadata: any;
    payload: any;
  }> {
    const conditions: string[] = [];
    const values: any[] = [];

    if (params.toAgentId) {
      conditions.push("to_agent_id = ?");
      values.push(params.toAgentId);
    }
    if (params.fromAgentId) {
      conditions.push("from_agent_id = ?");
      values.push(params.fromAgentId);
    }
    if (params.sessionId) {
      conditions.push("session_id = ?");
      values.push(params.sessionId);
    }
    if (params.status) {
      if (Array.isArray(params.status)) {
        const placeholders = params.status.map(() => '?').join(',');
        conditions.push(`status IN (${placeholders})`);
        values.push(...params.status);
      } else {
        conditions.push("status = ?");
        values.push(params.status);
      }
    }
    if (params.channel) {
      conditions.push("channel = ?");
      values.push(params.channel);
    }
    if (params.since) {
      conditions.push("created_at >= ?");
      values.push(params.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Build LIMIT and OFFSET clauses with parameterized queries to prevent SQL injection
    let query = `SELECT * FROM messages ${where} ORDER BY created_at DESC`;
    if (params.limit !== undefined) {
      query += ` LIMIT ?`;
      values.push(params.limit);
    } else if (params.offset !== undefined) {
      // SQLite requires LIMIT when using OFFSET
      query += ` LIMIT ?`;
      values.push(999999);
    }
    if (params.offset !== undefined) {
      query += ` OFFSET ?`;
      values.push(params.offset);
    }

    const rows = this.db.prepare(query).all(...values) as any[];

    return rows.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      fromAgentId: r.from_agent_id,
      toAgentId: r.to_agent_id,
      messageType: r.message_type,
      content: r.content,
      priority: r.priority,
      status: r.status,
      createdAt: r.created_at,
      deliveredAt: r.delivered_at,
      readAt: r.read_at,
      expiresAt: r.expires_at,
      channel: r.channel,
      parentMessageId: r.parent_message_id,
      metadata: JSON.parse(r.metadata || '{}'),
      payload: JSON.parse(r.payload || '{}'),
    }));
  }

  /** Mark a message as delivered */
  markMessageDelivered(messageId: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE messages
      SET status = 'delivered', delivered_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(now, messageId);
  }

  /** Mark a message as read */
  markMessageRead(messageId: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE messages
      SET status = 'read', read_at = ?
      WHERE id = ? AND (status = 'pending' OR status = 'delivered')
    `).run(now, messageId);
  }

  /** Mark multiple messages as read */
  markMessagesRead(messageIds: string[]): void {
    if (messageIds.length === 0) return;

    // Validate input to prevent SQL injection
    if (!Array.isArray(messageIds)) {
      throw new TypeError('messageIds must be an array');
    }
    for (const id of messageIds) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new TypeError('All messageIds must be non-empty strings');
      }
    }

    const now = Date.now();
    const placeholders = messageIds.map(() => '?').join(',');
    this.db.prepare(`
      UPDATE messages
      SET status = 'read', read_at = ?
      WHERE id IN (${placeholders}) AND (status = 'pending' OR status = 'delivered')
    `).run(now, ...messageIds);
  }

  /** Get unread message count for an agent */
  getUnreadMessageCount(agentId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE to_agent_id = ? AND status IN ('pending', 'delivered')
    `).get(agentId) as { count: number };
    return row.count;
  }

  /**
   * Clean up expired messages and return count of deleted messages.
   *
   * Two-phase cleanup process:
   * 1. Mark messages as expired if they have passed their expires_at timestamp
   * 2. Delete old messages based on two-tier retention policy:
   *    - read/expired messages: 30 days (long retention for audit trail)
   *    - pending/delivered messages: 7 days (shorter retention to flag delivery issues)
   *
   * Rationale: Undelivered messages older than 7 days likely indicate a problem
   * (agent crashed, inbox corruption, etc.) and should be investigated. Read messages
   * can be kept longer for debugging and analysis.
   */
  cleanupExpiredMessages(): number {
    const now = Date.now();

    // Phase 1: Mark messages as expired based on their expires_at timestamp
    this.db.prepare(`
      UPDATE messages SET status = 'expired'
      WHERE expires_at IS NOT NULL AND expires_at < ? AND status != 'expired'
    `).run(now);

    // Phase 2: Delete old messages using two-tier retention policy
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);  // 30 days in milliseconds
    const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);    // 7 days in milliseconds

    const result1 = this.db.prepare(`
      DELETE FROM messages
      WHERE (status IN ('read', 'expired') AND created_at < ?)
         OR (status IN ('pending', 'delivered') AND created_at < ?)
    `).run(thirtyDaysAgo, sevenDaysAgo);

    return result1.changes;
  }

  // ─── Code Comments ──────────────────────────────────────────

  insertCodeComment(comment: {
    id: string; sessionId: string; filePath: string; startLine: number;
    endLine?: number; selectedText?: string; commitHash?: string;
    comment: string; createdBy: string; createdAt: string; taskId?: string;
  }): void {
    this.db.prepare(
      `INSERT INTO code_comments (id, session_id, file_path, start_line, end_line, selected_text, commit_hash, comment, created_by, created_at, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      comment.id, comment.sessionId, comment.filePath, comment.startLine,
      comment.endLine || null, comment.selectedText || null, comment.commitHash || null,
      comment.comment, comment.createdBy, comment.createdAt, comment.taskId || null,
    );
  }

  getCodeComments(sessionId: string, filters?: {
    filePath?: string; resolved?: boolean; taskId?: string; limit?: number;
  }): any[] {
    const conditions = ["session_id = ?"];
    const values: any[] = [sessionId];
    if (filters?.filePath) { conditions.push("file_path = ?"); values.push(filters.filePath); }
    if (filters?.resolved !== undefined) { conditions.push("resolved = ?"); values.push(filters.resolved ? 1 : 0); }
    if (filters?.taskId) { conditions.push("task_id = ?"); values.push(filters.taskId); }
    const limit = filters?.limit || 200;
    const rows = this.db.prepare(
      `SELECT * FROM code_comments WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`
    ).all(...values, limit) as any[];
    return rows.map(r => ({
      id: r.id, sessionId: r.session_id, filePath: r.file_path,
      startLine: r.start_line, endLine: r.end_line, selectedText: r.selected_text,
      commitHash: r.commit_hash, comment: r.comment, createdBy: r.created_by,
      createdAt: r.created_at, taskId: r.task_id, resolved: !!r.resolved,
      resolvedAt: r.resolved_at, resolvedBy: r.resolved_by,
    }));
  }

  getCodeCommentFileCounts(sessionId: string, resolved?: boolean): Array<{ filePath: string; count: number }> {
    const conditions = ["session_id = ?"];
    const values: any[] = [sessionId];
    if (resolved !== undefined) { conditions.push("resolved = ?"); values.push(resolved ? 1 : 0); }
    return this.db.prepare(
      `SELECT file_path, COUNT(*) as count FROM code_comments WHERE ${conditions.join(" AND ")} GROUP BY file_path ORDER BY count DESC`
    ).all(...values) as Array<{ file_path: string; count: number }> as any;
  }

  updateCodeComment(id: string, updates: { comment?: string; resolved?: boolean; resolvedBy?: string }): boolean {
    const comment = this.db.prepare(`SELECT * FROM code_comments WHERE id = ?`).get(id) as any;
    if (!comment) return false;
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE code_comments SET comment = ?, resolved = ?, resolved_at = ?, resolved_by = ? WHERE id = ?`
    ).run(
      updates.comment ?? comment.comment,
      updates.resolved !== undefined ? (updates.resolved ? 1 : 0) : comment.resolved,
      updates.resolved ? now : comment.resolved_at,
      updates.resolvedBy ?? comment.resolved_by,
      id,
    );
    return true;
  }

  deleteCodeComment(id: string): boolean {
    return this.db.prepare(`DELETE FROM code_comments WHERE id = ?`).run(id).changes > 0;
  }

  close(): void {
    this._open = false;
    this.db.close();
  }
}
