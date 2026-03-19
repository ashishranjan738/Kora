/**
 * SQLite database for playbooks.
 * Global database at {globalConfigDir}/playbooks.db
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const SCHEMA_VERSION = 1;

export interface Playbook {
  id: string;
  name: string;
  description: string;
  yamlContent: string;
  createdAt: string;
  updatedAt: string;
}

export class PlaybookDatabase {
  public db: Database.Database;
  private _open = true;

  /** Check if the database connection is still open */
  get isOpen(): boolean {
    return this._open && this.db.open;
  }

  constructor(globalConfigDir: string) {
    const dbPath = path.join(globalConfigDir, "playbooks.db");
    fs.mkdirSync(globalConfigDir, { recursive: true });

    this.db = new Database(dbPath);

    // Performance settings
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -8000");
    this.db.pragma("busy_timeout = 5000");

    this.migrate();
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;

    if (version < 1) {
      this.db.exec(`
        -- Playbooks table
        CREATE TABLE IF NOT EXISTS playbooks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          description TEXT DEFAULT '',
          yaml_content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_playbooks_name ON playbooks(name);
        CREATE INDEX IF NOT EXISTS idx_playbooks_created ON playbooks(created_at DESC);

        PRAGMA user_version = 1;
      `);
    }
  }

  // ─── Playbooks ───────────────────────────────────────────

  insertPlaybook(playbook: {
    id: string;
    name: string;
    description: string;
    yamlContent: string;
    createdAt: string;
    updatedAt: string;
  }): void {
    if (!this.isOpen) {
      throw new TypeError("The database connection is not open");
    }
    const stmt = this.db.prepare(
      `INSERT INTO playbooks (id, name, description, yaml_content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      playbook.id,
      playbook.name,
      playbook.description,
      playbook.yamlContent,
      playbook.createdAt,
      playbook.updatedAt
    );
  }

  listPlaybooks(params: {
    limit?: number;
    offset?: number;
  } = {}): Array<Playbook> {
    const limit = params.limit || 100;
    const offset = params.offset || 0;

    const rows = this.db.prepare(
      `SELECT id, name, description, yaml_content, created_at, updated_at
       FROM playbooks
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    ).all(limit, offset) as Array<{
      id: string;
      name: string;
      description: string;
      yaml_content: string;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      yamlContent: r.yaml_content,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  getPlaybook(id: string): Playbook | null {
    const row = this.db.prepare(
      `SELECT id, name, description, yaml_content, created_at, updated_at
       FROM playbooks
       WHERE id = ?`
    ).get(id) as {
      id: string;
      name: string;
      description: string;
      yaml_content: string;
      created_at: string;
      updated_at: string;
    } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      yamlContent: row.yaml_content,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getPlaybookByName(name: string): Playbook | null {
    const row = this.db.prepare(
      `SELECT id, name, description, yaml_content, created_at, updated_at
       FROM playbooks
       WHERE name = ?`
    ).get(name) as {
      id: string;
      name: string;
      description: string;
      yaml_content: string;
      created_at: string;
      updated_at: string;
    } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      yamlContent: row.yaml_content,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  updatePlaybook(id: string, updates: {
    name?: string;
    description?: string;
    yamlContent?: string;
  }): Playbook | null {
    const playbook = this.getPlaybook(id);
    if (!playbook) return null;

    const newName = updates.name !== undefined ? updates.name : playbook.name;
    const newDesc = updates.description !== undefined ? updates.description : playbook.description;
    const newContent = updates.yamlContent !== undefined ? updates.yamlContent : playbook.yamlContent;
    const now = new Date().toISOString();

    this.db.prepare(
      `UPDATE playbooks
       SET name = ?, description = ?, yaml_content = ?, updated_at = ?
       WHERE id = ?`
    ).run(newName, newDesc, newContent, now, id);

    return this.getPlaybook(id);
  }

  deletePlaybook(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM playbooks WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  countPlaybooks(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM playbooks`).get() as { count: number };
    return row.count;
  }

  close(): void {
    this._open = false;
    this.db.close();
  }
}
