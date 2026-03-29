/**
 * Global Knowledge Store — cross-session persistence in ~/.kora/global.db.
 *
 * Entries promoted from session-scoped knowledge are available to all
 * future sessions. Session entries take precedence on key collision.
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

export interface GlobalKnowledgeEntry {
  key: string;
  value: string;
  sourceSession: string | null;
  promotedBy: string | null;
  promotedAt: string;
}

let _instance: GlobalKnowledgeDB | null = null;

export class GlobalKnowledgeDB {
  public db: Database.Database;

  constructor(globalConfigDir: string) {
    const dbPath = path.join(globalConfigDir, "global.db");
    fs.mkdirSync(globalConfigDir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS global_knowledge (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          source_session TEXT,
          promoted_by TEXT,
          promoted_at TEXT NOT NULL
        );
        PRAGMA user_version = 1;
      `);
    }
  }

  promote(entry: { key: string; value: string; sourceSession: string; promotedBy: string }): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO global_knowledge (key, value, source_session, promoted_by, promoted_at) VALUES (?, ?, ?, ?, ?)`
    ).run(entry.key, entry.value, entry.sourceSession, entry.promotedBy, new Date().toISOString());
  }

  get(key: string): GlobalKnowledgeEntry | null {
    const row = this.db.prepare(
      `SELECT key, value, source_session, promoted_by, promoted_at FROM global_knowledge WHERE key = ?`
    ).get(key) as any;
    if (!row) return null;
    return { key: row.key, value: row.value, sourceSession: row.source_session, promotedBy: row.promoted_by, promotedAt: row.promoted_at };
  }

  list(limit = 50): GlobalKnowledgeEntry[] {
    const rows = this.db.prepare(
      `SELECT key, value, source_session, promoted_by, promoted_at FROM global_knowledge ORDER BY promoted_at DESC LIMIT ?`
    ).all(limit) as any[];
    return rows.map(r => ({ key: r.key, value: r.value, sourceSession: r.source_session, promotedBy: r.promoted_by, promotedAt: r.promoted_at }));
  }

  remove(key: string): boolean {
    const result = this.db.prepare(`DELETE FROM global_knowledge WHERE key = ?`).run(key);
    return result.changes > 0;
  }

  close(): void {
    try { this.db.close(); } catch {}
  }
}

/** Get or create the singleton global knowledge DB */
export function getGlobalKnowledgeDB(globalConfigDir: string): GlobalKnowledgeDB {
  if (!_instance) {
    _instance = new GlobalKnowledgeDB(globalConfigDir);
  }
  return _instance;
}

/** Reset singleton (for testing) */
export function resetGlobalKnowledgeDB(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
}
