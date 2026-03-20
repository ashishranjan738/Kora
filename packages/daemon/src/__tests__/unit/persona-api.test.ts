/**
 * Tests for Persona CRUD in suggestions database and agent config recording.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";

// Create an isolated in-memory-like suggestions DB for testing
function createTestDb(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS recent_paths (path TEXT PRIMARY KEY, last_used TEXT NOT NULL, use_count INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS recent_flags (flag_combo TEXT PRIMARY KEY, last_used TEXT NOT NULL, use_count INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS recent_agent_configs (provider TEXT NOT NULL, model TEXT NOT NULL, last_used TEXT NOT NULL, use_count INTEGER DEFAULT 1, PRIMARY KEY (provider, model));
    CREATE TABLE IF NOT EXISTS custom_personas (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', full_text TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  return db;
}

describe("Persona CRUD", () => {
  let db: Database.Database;
  let dbPath: string;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-persona-test-"));
    dbPath = path.join(tmpDir, "test.db");
    db = createTestDb(dbPath);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createPersona(p: { id: string; name: string; description: string; fullText: string }) {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO custom_personas (id, name, description, full_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(p.id, p.name, p.description, p.fullText, now, now);
  }

  function getPersonas() {
    return (db.prepare("SELECT id, name, description, full_text, created_at FROM custom_personas ORDER BY created_at DESC").all() as any[]).map(r => ({ id: r.id, name: r.name, description: r.description, fullText: r.full_text }));
  }

  function getPersona(id: string) {
    const row = db.prepare("SELECT id, name, description, full_text FROM custom_personas WHERE id = ?").get(id) as any;
    return row ? { id: row.id, name: row.name, description: row.description, fullText: row.full_text } : null;
  }

  function updatePersona(id: string, updates: { name?: string; fullText?: string }) {
    const now = new Date().toISOString();
    if (updates.name) db.prepare("UPDATE custom_personas SET name = ?, updated_at = ? WHERE id = ?").run(updates.name, now, id);
    if (updates.fullText) db.prepare("UPDATE custom_personas SET full_text = ?, updated_at = ? WHERE id = ?").run(updates.fullText, now, id);
  }

  function deletePersona(id: string) {
    db.prepare("DELETE FROM custom_personas WHERE id = ?").run(id);
  }

  it("creates and retrieves a persona", () => {
    createPersona({ id: "t1", name: "Test Expert", description: "A test persona", fullText: "You are a testing expert." });
    const personas = getPersonas();
    expect(personas.some(p => p.id === "t1")).toBe(true);
    expect(personas.find(p => p.id === "t1")!.name).toBe("Test Expert");
  });

  it("retrieves a single persona by ID", () => {
    createPersona({ id: "t2", name: "P2", description: "Desc2", fullText: "Text2" });
    const p = getPersona("t2");
    expect(p).not.toBeNull();
    expect(p!.name).toBe("P2");
  });

  it("returns null for non-existent persona", () => {
    expect(getPersona("nonexistent")).toBeNull();
  });

  it("updates a persona", () => {
    createPersona({ id: "t3", name: "Old Name", description: "Old", fullText: "Old text" });
    updatePersona("t3", { name: "New Name", fullText: "New text" });
    const p = getPersona("t3");
    expect(p!.name).toBe("New Name");
    expect(p!.fullText).toBe("New text");
  });

  it("deletes a persona", () => {
    createPersona({ id: "t4", name: "Delete Me", description: "D", fullText: "D" });
    expect(getPersona("t4")).not.toBeNull();
    deletePersona("t4");
    expect(getPersona("t4")).toBeNull();
  });

  it("handles special characters in persona text", () => {
    createPersona({
      id: "t5",
      name: "Special",
      description: "test",
      fullText: "Rules:\n- Don't use `eval()`\n- Handle \"quotes\" and <tags>",
    });
    const p = getPersona("t5");
    expect(p!.fullText).toContain("Don't use `eval()`");
    expect(p!.fullText).toContain("<tags>");
  });
});

describe("Agent config recording", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-config-test-"));
    db = createTestDb(path.join(tmpDir, "test.db"));
  });

  afterAll(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function recordConfig(provider: string, model: string) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO recent_agent_configs (provider, model, last_used, use_count) VALUES (?, ?, ?, 1)
      ON CONFLICT(provider, model) DO UPDATE SET last_used = excluded.last_used, use_count = use_count + 1
    `).run(provider, model, now);
  }

  function getConfigs(limit: number) {
    return (db.prepare("SELECT provider, model, use_count FROM recent_agent_configs ORDER BY last_used DESC LIMIT ?").all(limit) as any[]).map(r => ({ provider: r.provider, model: r.model, useCount: r.use_count }));
  }

  it("records and retrieves agent configs", () => {
    recordConfig("claude-code", "claude-sonnet-4-6");
    recordConfig("claude-code", "default");
    const configs = getConfigs(10);
    expect(configs).toHaveLength(2);
  });

  it("increments use count on duplicate config", () => {
    recordConfig("aider", "gpt-4");
    recordConfig("aider", "gpt-4");
    recordConfig("aider", "gpt-4");
    const configs = getConfigs(10);
    const aider = configs.find(c => c.provider === "aider" && c.model === "gpt-4");
    expect(aider).toBeDefined();
    expect(aider!.useCount).toBe(3);
  });

  it("respects limit parameter", () => {
    const configs = getConfigs(1);
    expect(configs).toHaveLength(1);
  });
});
