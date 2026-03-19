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
   * Close the database connection
   */
  close(): void {
    if (this._open) {
      this.db.close();
      this._open = false;
    }
  }
}
