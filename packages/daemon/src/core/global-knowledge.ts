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
    if (version < 2) {
      // Add FTS5 for full-text search on global knowledge
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS global_knowledge_fts USING fts5(
            key, value, content='global_knowledge', content_rowid='rowid'
          );
          -- Populate FTS index from existing rows
          INSERT OR IGNORE INTO global_knowledge_fts(global_knowledge_fts) VALUES('rebuild');
          PRAGMA user_version = 2;
        `);
        this._fts5Available = true;
      } catch {
        // FTS5 not available — skip migration, still bump version
        this.db.exec("PRAGMA user_version = 2;");
        this._fts5Available = false;
      }
    }
    // Detect FTS5 availability for existing v2+ databases
    if (version >= 2 && this._fts5Available === undefined) {
      try {
        this.db.prepare("SELECT * FROM global_knowledge_fts LIMIT 0").run();
        this._fts5Available = true;
      } catch {
        this._fts5Available = false;
      }
    }
  }

  private _fts5Available: boolean | undefined;

  promote(entry: { key: string; value: string; sourceSession: string; promotedBy: string }): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT OR REPLACE INTO global_knowledge (key, value, source_session, promoted_by, promoted_at) VALUES (?, ?, ?, ?, ?)`
    ).run(entry.key, entry.value, entry.sourceSession, entry.promotedBy, now);
    this.syncFts(entry.key, entry.value);
  }

  create(entry: { key: string; value: string; sourceSession?: string; promotedBy?: string }): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT OR REPLACE INTO global_knowledge (key, value, source_session, promoted_by, promoted_at) VALUES (?, ?, ?, ?, ?)`
    ).run(entry.key, entry.value, entry.sourceSession || null, entry.promotedBy || null, now);
    this.syncFts(entry.key, entry.value);
  }

  update(key: string, value: string): boolean {
    const result = this.db.prepare(
      `UPDATE global_knowledge SET value = ?, promoted_at = ? WHERE key = ?`
    ).run(value, new Date().toISOString(), key);
    if (result.changes > 0) this.syncFts(key, value);
    return result.changes > 0;
  }

  search(query: string, limit = 50): GlobalKnowledgeEntry[] {
    if (this._fts5Available && query.trim()) {
      try {
        const ftsQuery = query.trim().split(/\s+/).map(w => `"${w}"`).join(" OR ");
        const rows = this.db.prepare(
          `SELECT gk.key, gk.value, gk.source_session, gk.promoted_by, gk.promoted_at
           FROM global_knowledge_fts fts
           JOIN global_knowledge gk ON gk.rowid = fts.rowid
           WHERE global_knowledge_fts MATCH ?
           ORDER BY bm25(global_knowledge_fts) LIMIT ?`
        ).all(ftsQuery, limit) as any[];
        return rows.map(r => ({ key: r.key, value: r.value, sourceSession: r.source_session, promotedBy: r.promoted_by, promotedAt: r.promoted_at }));
      } catch {
        // Fall through to LIKE search
      }
    }
    // LIKE fallback
    const pattern = `%${query.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
    const rows = this.db.prepare(
      `SELECT key, value, source_session, promoted_by, promoted_at FROM global_knowledge
       WHERE key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\'
       ORDER BY promoted_at DESC LIMIT ?`
    ).all(pattern, pattern, limit) as any[];
    return rows.map(r => ({ key: r.key, value: r.value, sourceSession: r.source_session, promotedBy: r.promoted_by, promotedAt: r.promoted_at }));
  }

  private syncFts(key: string, value: string): void {
    if (!this._fts5Available) return;
    try {
      // Get rowid for this key
      const row = this.db.prepare("SELECT rowid FROM global_knowledge WHERE key = ?").get(key) as any;
      if (row) {
        this.db.prepare("INSERT OR REPLACE INTO global_knowledge_fts(rowid, key, value) VALUES (?, ?, ?)").run(row.rowid, key, value);
      }
    } catch { /* non-fatal */ }
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
    // Remove from FTS first (need rowid before deletion)
    if (this._fts5Available) {
      try {
        const row = this.db.prepare("SELECT rowid FROM global_knowledge WHERE key = ?").get(key) as any;
        if (row) {
          this.db.prepare("DELETE FROM global_knowledge_fts WHERE rowid = ?").run(row.rowid);
        }
      } catch { /* non-fatal */ }
    }
    const result = this.db.prepare(`DELETE FROM global_knowledge WHERE key = ?`).run(key);
    return result.changes > 0;
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM global_knowledge").get() as any;
    return row?.cnt || 0;
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
