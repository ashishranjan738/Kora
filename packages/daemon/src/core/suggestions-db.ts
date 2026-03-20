/**
 * Global suggestions database for recent paths and CLI flags.
 * Stored at ~/.kora/suggestions.db (or ~/.kora-dev/suggestions.db for dev)
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import os from "os";

const SCHEMA_VERSION = 1;

export class SuggestionsDatabase {
  private db: Database.Database;
  private _open = true;

  get isOpen(): boolean {
    return this._open && this.db.open;
  }

  constructor(isDev: boolean = false) {
    const configDir = isDev
      ? path.join(os.homedir(), ".kora-dev")
      : path.join(os.homedir(), ".kora");

    fs.mkdirSync(configDir, { recursive: true });
    const dbPath = path.join(configDir, "suggestions.db");

    this.db = new Database(dbPath);

    // Performance settings
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -2000"); // 2MB cache
    this.db.pragma("busy_timeout = 3000");

    this.migrate();
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;

    if (version < 1) {
      this.db.exec(`
        -- Recent working directories
        CREATE TABLE IF NOT EXISTS recent_paths (
          path TEXT PRIMARY KEY,
          last_used TEXT NOT NULL,
          use_count INTEGER DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_paths_last_used ON recent_paths(last_used DESC);

        -- Recent CLI flag combinations
        CREATE TABLE IF NOT EXISTS recent_flags (
          flag_combo TEXT PRIMARY KEY,
          last_used TEXT NOT NULL,
          use_count INTEGER DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_flags_last_used ON recent_flags(last_used DESC);

        PRAGMA user_version = 1;
      `);
    }

    if (version < 2) {
      this.db.exec(`
        -- Recent provider + model combinations
        CREATE TABLE IF NOT EXISTS recent_agent_configs (
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          last_used TEXT NOT NULL,
          use_count INTEGER DEFAULT 1,
          PRIMARY KEY (provider, model)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_configs_last_used ON recent_agent_configs(last_used DESC);

        PRAGMA user_version = 2;
      `);
    }

    if (version < 3) {
      this.db.exec(`
        -- Custom personas library
        CREATE TABLE IF NOT EXISTS custom_personas (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          full_text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_personas_name ON custom_personas(name);

        PRAGMA user_version = 3;
      `);
    }
  }

  /**
   * Record a working directory path
   */
  recordPath(workingPath: string): void {
    if (!this.isOpen) {
      throw new TypeError("Database connection is not open");
    }

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO recent_paths (path, last_used, use_count)
      VALUES (?, ?, 1)
      ON CONFLICT(path) DO UPDATE SET
        last_used = excluded.last_used,
        use_count = use_count + 1
    `);
    stmt.run(workingPath, now);
  }

  /**
   * Get recent paths, limited to top N by last_used
   */
  getRecentPaths(limit: number = 10): string[] {
    if (!this.isOpen) {
      throw new TypeError("Database connection is not open");
    }

    const stmt = this.db.prepare(`
      SELECT path FROM recent_paths
      ORDER BY last_used DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  /**
   * Record a CLI flag combination (e.g., "--dangerously-skip-permissions --model gpt-4")
   */
  recordFlags(flags: string): void {
    if (!this.isOpen || !flags.trim()) {
      return;
    }

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO recent_flags (flag_combo, last_used, use_count)
      VALUES (?, ?, 1)
      ON CONFLICT(flag_combo) DO UPDATE SET
        last_used = excluded.last_used,
        use_count = use_count + 1
    `);
    stmt.run(flags.trim(), now);
  }

  /**
   * Get recent flag combinations, limited to top N by last_used
   */
  getRecentFlags(limit: number = 10): string[] {
    if (!this.isOpen) {
      throw new TypeError("Database connection is not open");
    }

    const stmt = this.db.prepare(`
      SELECT flag_combo FROM recent_flags
      ORDER BY last_used DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as Array<{ flag_combo: string }>;
    return rows.map((r) => r.flag_combo);
  }

  /**
   * Record a provider + model combination used to spawn an agent
   */
  recordAgentConfig(provider: string, model: string): void {
    if (!this.isOpen || !provider.trim()) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO recent_agent_configs (provider, model, last_used, use_count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(provider, model) DO UPDATE SET
        last_used = excluded.last_used,
        use_count = use_count + 1
    `);
    stmt.run(provider.trim(), (model || "default").trim(), now);
  }

  /**
   * Get recent provider + model combinations, ordered by last used
   */
  getRecentAgentConfigs(limit: number = 10): Array<{ provider: string; model: string; useCount: number }> {
    if (!this.isOpen) return [];
    const stmt = this.db.prepare(`
      SELECT provider, model, use_count FROM recent_agent_configs
      ORDER BY last_used DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as Array<{ provider: string; model: string; use_count: number }>;
    return rows.map(r => ({ provider: r.provider, model: r.model, useCount: r.use_count }));
  }

  // ── Custom Personas ───────────────────────────────────────

  createPersona(persona: { id: string; name: string; description: string; fullText: string }): void {
    if (!this.isOpen) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO custom_personas (id, name, description, full_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(persona.id, persona.name, persona.description, persona.fullText, now, now);
  }

  updatePersona(id: string, updates: { name?: string; description?: string; fullText?: string }): void {
    if (!this.isOpen) return;
    const now = new Date().toISOString();
    const fields: string[] = ["updated_at = ?"];
    const values: any[] = [now];
    if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
    if (updates.description !== undefined) { fields.push("description = ?"); values.push(updates.description); }
    if (updates.fullText !== undefined) { fields.push("full_text = ?"); values.push(updates.fullText); }
    values.push(id);
    this.db.prepare(`UPDATE custom_personas SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  deletePersona(id: string): void {
    if (!this.isOpen) return;
    this.db.prepare("DELETE FROM custom_personas WHERE id = ?").run(id);
  }

  getPersonas(): Array<{ id: string; name: string; description: string; fullText: string; createdAt: string }> {
    if (!this.isOpen) return [];
    const rows = this.db.prepare("SELECT id, name, description, full_text, created_at FROM custom_personas ORDER BY created_at DESC").all() as any[];
    return rows.map(r => ({ id: r.id, name: r.name, description: r.description, fullText: r.full_text, createdAt: r.created_at }));
  }

  getPersona(id: string): { id: string; name: string; description: string; fullText: string } | null {
    if (!this.isOpen) return null;
    const row = this.db.prepare("SELECT id, name, description, full_text FROM custom_personas WHERE id = ?").get(id) as any;
    if (!row) return null;
    return { id: row.id, name: row.name, description: row.description, fullText: row.full_text };
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this._open) {
      this.db.close();
      this._open = false;
    }
  }
}
