/**
 * SQLite database for Kora.
 * Stores events, tasks, task comments, and agent state.
 * One database per session at {runtimeDir}/data.db
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { logger } from "./logger.js";

const SCHEMA_VERSION = 1;

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
    createdAt: string;
    updatedAt: string;
  }): void {
    const stmt = this.db.prepare(
      `INSERT INTO tasks (id, session_id, title, description, status, assigned_to, created_by, dependencies, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      task.id, task.sessionId, task.title, task.description, task.status,
      task.assignedTo || null, task.createdBy,
      JSON.stringify(task.dependencies || []),
      task.createdAt, task.updatedAt
    );
  }

  getTasks(sessionId: string): Array<any> {
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at DESC`
    ).all(sessionId) as any[];

    return rows.map(r => {
      const comments = this.getTaskComments(r.id);
      return {
        id: r.id,
        sessionId: r.session_id,
        title: r.title,
        description: r.description,
        status: r.status,
        assignedTo: r.assigned_to,
        createdBy: r.created_by,
        dependencies: JSON.parse(r.dependencies || "[]"),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        comments,
      };
    });
  }

  getTask(taskId: string): any | null {
    const r = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as any;
    if (!r) return null;
    const comments = this.getTaskComments(r.id);
    return {
      id: r.id,
      sessionId: r.session_id,
      title: r.title,
      description: r.description,
      status: r.status,
      assignedTo: r.assigned_to,
      createdBy: r.created_by,
      dependencies: JSON.parse(r.dependencies || "[]"),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      comments,
    };
  }

  updateTask(taskId: string, updates: { title?: string; description?: string; status?: string; assignedTo?: string }): any | null {
    const task = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as any;
    if (!task) return null;

    const newTitle = updates.title !== undefined ? updates.title : task.title;
    const newDesc = updates.description !== undefined ? updates.description : task.description;
    const newStatus = updates.status !== undefined ? updates.status : task.status;
    const newAssigned = updates.assignedTo !== undefined ? (updates.assignedTo || null) : task.assigned_to;
    const now = new Date().toISOString();

    this.db.prepare(
      `UPDATE tasks SET title = ?, description = ?, status = ?, assigned_to = ?, updated_at = ? WHERE id = ?`
    ).run(newTitle, newDesc, newStatus, newAssigned, now, taskId);

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
