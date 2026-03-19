/**
 * SQLite database for Kora.
 * Stores events, tasks, task comments, and agent state.
 * One database per session at {runtimeDir}/data.db
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const SCHEMA_VERSION = 3;

export class AppDatabase {
  public db: Database.Database;
  private _open = true;

  /** Check if the database connection is still open */
  get isOpen(): boolean {
    return this._open && this.db.open;
  }

  constructor(runtimeDir: string) {
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
  }

  // ─── Events ──────────────────────────────────────────────

  insertEvent(event: {
    id: string;
    sessionId: string;
    type: string;
    data: Record<string, unknown>;
    timestamp: string;
  }): void {
    if (!this.isOpen) {
      throw new TypeError("The database connection is not open");
    }
    const stmt = this.db.prepare(
      `INSERT INTO events (id, session_id, type, data, timestamp) VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run(event.id, event.sessionId, event.type, JSON.stringify(event.data), event.timestamp);
  }

  queryEvents(params: {
    sessionId?: string;
    since?: string;
    limit?: number;
    type?: string;
  }): Array<{ id: string; sessionId: string; type: string; data: any; timestamp: string }> {
    const conditions: string[] = [];
    const values: any[] = [];

    if (params.sessionId) {
      conditions.push("session_id = ?");
      values.push(params.sessionId);
    }
    if (params.since) {
      conditions.push("timestamp >= ?");
      values.push(params.since);
    }
    if (params.type) {
      conditions.push("type = ?");
      values.push(params.type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = params.limit ? `LIMIT ${params.limit}` : "";

    const rows = this.db.prepare(
      `SELECT id, session_id, type, data, timestamp FROM events ${where} ORDER BY timestamp DESC ${limitClause}`
    ).all(...values) as Array<{ id: string; session_id: string; type: string; data: string; timestamp: string }>;

    return rows.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      type: r.type,
      data: JSON.parse(r.data || "{}"),
      timestamp: r.timestamp,
    }));
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
      `INSERT INTO tasks (id, session_id, title, description, status, assigned_to, created_by, dependencies, priority, labels, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      task.id, task.sessionId, task.title, task.description, task.status,
      task.assignedTo || null, task.createdBy,
      JSON.stringify(task.dependencies || []),
      task.priority || "P2",
      JSON.stringify(task.labels || []),
      task.dueDate || null,
      task.createdAt, task.updatedAt
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
        conditions.push("status IN ('pending', 'in-progress', 'review')");
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

    this.db.prepare(
      `UPDATE tasks SET title = ?, description = ?, status = ?, assigned_to = ?, priority = ?, labels = ?, due_date = ?, updated_at = ? WHERE id = ?`
    ).run(newTitle, newDesc, newStatus, newAssigned, newPriority, newLabels, newDueDate, now, taskId);

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

  close(): void {
    this._open = false;
    this.db.close();
  }
}
