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

  /**
   * Ensure built-in playbooks are present in the database.
   * This is idempotent and will not duplicate existing playbooks.
   */
  ensureBuiltinPlaybooks(): void {
    const builtins = [
      {
        name: "Solo Agent",
        description: "Single master agent for simple tasks",
        yaml: `name: Solo Agent
description: Single master agent for simple tasks
defaults:
  provider: claude-code
  model: default
agents:
  - name: Agent
    role: master
    persona: You are a helpful coding assistant.
`,
      },
      {
        name: "Master + 2 Workers",
        description: "One master that delegates to two workers",
        yaml: `name: Master + 2 Workers
description: One master that delegates to two workers
defaults:
  provider: claude-code
  model: default
agents:
  - name: Orchestrator
    role: master
    persona: builtin:architect
  - name: Worker A
    role: worker
    persona: builtin:backend
  - name: Worker B
    role: worker
    persona: builtin:frontend
`,
      },
      {
        name: "Full Stack Team",
        description: "Architect + Frontend + Backend + Tests + Reviewer",
        yaml: `name: Full Stack Team
description: Architect + Frontend + Backend + Tests + Reviewer
defaults:
  provider: claude-code
  model: default
agents:
  - name: Architect
    role: master
    persona: builtin:architect
  - name: Frontend
    role: worker
    persona: builtin:frontend
  - name: Backend
    role: worker
    persona: builtin:backend
  - name: Tests
    role: worker
    persona: builtin:tester
  - name: Reviewer
    role: worker
    persona: builtin:reviewer
`,
      },
      {
        name: "Research Team",
        description: "Architect + Researcher + Backend + Frontend",
        yaml: `name: Research Team
description: Architect + Researcher + Backend + Frontend
defaults:
  provider: claude-code
  model: default
agents:
  - name: Architect
    role: master
    persona: builtin:architect
  - name: Researcher
    role: worker
    persona: builtin:researcher
  - name: Backend
    role: worker
    persona: builtin:backend
  - name: Frontend
    role: worker
    persona: builtin:frontend
`,
      },
      {
        name: "Two-Pizza Team",
        description: "Full product team: Engineering Manager, Product Manager, Researcher, 3 Devs, Tester, Reviewer",
        yaml: `name: Two-Pizza Team
description: "Full product team: EM, PM, Researcher, 3 Devs, Tester, Reviewer"
defaults:
  provider: claude-code
  model: default
agents:
  - name: Engineering Manager
    role: master
    persona: "Engineering Manager — coordinates work, breaks down tasks, assigns to engineers, unblocks team. Does NOT write code."
  - name: Product Manager
    role: worker
    persona: "Product Manager — defines requirements, writes user stories, clarifies acceptance criteria, reviews from product perspective. Does NOT write code."
  - name: Researcher
    role: worker
    persona: builtin:researcher
  - name: Dev 1
    role: worker
    persona: builtin:backend
  - name: Dev 2
    role: worker
    persona: builtin:frontend
  - name: Dev 3
    role: worker
    persona: "Full-stack developer — works on both frontend and backend tasks. Picks up overflow work as needed."
  - name: Tester
    role: worker
    persona: builtin:tester
  - name: Reviewer
    role: worker
    persona: builtin:reviewer
`,
      },
    ];

    const now = new Date().toISOString();

    for (const builtin of builtins) {
      // Check if playbook already exists
      const existing = this.getPlaybookByName(builtin.name);
      if (existing) {
        // Update existing playbook to pick up fixes
        this.updatePlaybook(existing.id, {
          description: builtin.description,
          yamlContent: builtin.yaml,
        });
      } else {
        // Insert new playbook
        const id = require("crypto").randomUUID();
        try {
          this.insertPlaybook({
            id,
            name: builtin.name,
            description: builtin.description,
            yamlContent: builtin.yaml,
            createdAt: now,
            updatedAt: now,
          });
        } catch (err) {
          // Ignore UNIQUE constraint violations (race condition)
          const errMsg = err instanceof Error ? err.message : String(err);
          if (!errMsg.includes("UNIQUE") && !errMsg.includes("unique")) {
            throw err;
          }
        }
      }
    }
  }
}
