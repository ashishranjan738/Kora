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

export class AppDatabase extends EventEmitter {
  public db: Database.Database;
  private _open = true;

  /** Check if the database connection is still open */
  get isOpen(): boolean {
    return this._open && this.db.open;
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
    if (params.search) { conditions.push("data LIKE ?"); values.push(`%${params.search}%`); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = params.order === "asc" ? "ASC" : "DESC";
    const limitClause = params.limit ? `LIMIT ${params.limit}` : "";
    const offsetClause = params.offset ? `OFFSET ${params.offset}` : "";

    const rows = this.db.prepare(
      `SELECT id, session_id, type, data, timestamp, agent_id FROM events ${where} ORDER BY timestamp ${order} ${limitClause} ${offsetClause}`
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
    if (params.search) { conditions.push("data LIKE ?"); values.push(`%${params.search}%`); }

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

  getTasks(sessionId: string): Array<any> {
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at DESC`
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

    // Emit task-completed event if status changed to "done"
    const wasCompleted = task.status !== "done" && newStatus === "done";
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
    return this.db.prepare(
      `SELECT * FROM tasks WHERE session_id = ? AND status IN (${placeholders}) AND status != 'done' AND status != 'pending' AND COALESCE(status_changed_at, created_at) < ? ORDER BY COALESCE(status_changed_at, created_at) ASC`
    ).all(sessionId, ...statuses, cutoff) as any[];
  }

  /** Clean up old delivery records (keep last 7 days) */
  cleanupOldDeliveries(daysToKeep = 7): number {
    const cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
    const result = this.db.prepare(
      `DELETE FROM message_deliveries WHERE enqueued_at < ?`
    ).run(cutoff);
    return result.changes;
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

  close(): void {
    this._open = false;
    this.db.close();
  }
}
