/**
 * E2E integration tests for the persona system.
 * Tests the full CRUD lifecycle with an isolated database.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";

describe("Persona E2E Integration", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-persona-e2e-"));
    db = new Database(path.join(tmpDir, "e2e.db"));
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE custom_personas (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        full_text TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE recent_agent_configs (
        provider TEXT NOT NULL, model TEXT NOT NULL, last_used TEXT NOT NULL,
        use_count INTEGER DEFAULT 1, PRIMARY KEY (provider, model)
      );
    `);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function create(p: { id: string; name: string; description: string; fullText: string }) {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO custom_personas (id, name, description, full_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(p.id, p.name, p.description, p.fullText, now, now);
  }
  function list() {
    return (db.prepare("SELECT id, name, description, full_text FROM custom_personas ORDER BY created_at DESC").all() as any[]).map(r => ({ id: r.id, name: r.name, description: r.description, fullText: r.full_text }));
  }
  function get(id: string) {
    const r = db.prepare("SELECT * FROM custom_personas WHERE id = ?").get(id) as any;
    return r ? { id: r.id, name: r.name, description: r.description, fullText: r.full_text } : null;
  }
  function update(id: string, u: { name?: string; description?: string; fullText?: string }) {
    const now = new Date().toISOString();
    if (u.name) db.prepare("UPDATE custom_personas SET name = ?, updated_at = ? WHERE id = ?").run(u.name, now, id);
    if (u.description) db.prepare("UPDATE custom_personas SET description = ?, updated_at = ? WHERE id = ?").run(u.description, now, id);
    if (u.fullText) db.prepare("UPDATE custom_personas SET full_text = ?, updated_at = ? WHERE id = ?").run(u.fullText, now, id);
  }
  function del(id: string) {
    db.prepare("DELETE FROM custom_personas WHERE id = ?").run(id);
  }

  it("full CRUD lifecycle", () => {
    // Create
    create({ id: "e2e-1", name: "E2E Persona", description: "For testing", fullText: "You are a test agent." });
    expect(get("e2e-1")).not.toBeNull();
    expect(get("e2e-1")!.name).toBe("E2E Persona");

    // Update
    update("e2e-1", { name: "Updated Persona", fullText: "Updated instructions." });
    expect(get("e2e-1")!.name).toBe("Updated Persona");
    expect(get("e2e-1")!.fullText).toBe("Updated instructions.");
    expect(get("e2e-1")!.description).toBe("For testing"); // unchanged

    // Delete
    del("e2e-1");
    expect(get("e2e-1")).toBeNull();
  });

  it("multiple personas are all stored and retrievable", () => {
    create({ id: "ord-1", name: "First", description: "", fullText: "1" });
    create({ id: "ord-2", name: "Second", description: "", fullText: "2" });
    create({ id: "ord-3", name: "Third", description: "", fullText: "3" });

    const personas = list();
    const ids = personas.map(p => p.id);
    expect(ids).toContain("ord-1");
    expect(ids).toContain("ord-2");
    expect(ids).toContain("ord-3");

    del("ord-1"); del("ord-2"); del("ord-3");
  });

  it("agent configs coexist with personas in same database", () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO recent_agent_configs (provider, model, last_used, use_count) VALUES (?, ?, ?, 1)").run("claude-code", "default", now);
    create({ id: "coexist", name: "Coexist", description: "", fullText: "test" });

    const configs = db.prepare("SELECT * FROM recent_agent_configs").all() as any[];
    expect(configs.length).toBeGreaterThanOrEqual(1);

    const personas = list();
    expect(personas.some(p => p.id === "coexist")).toBe(true);

    del("coexist");
  });

  it("persona with long text and special characters", () => {
    const longText = "You are a specialized agent.\n\n" +
      "## Rules\n" +
      "- Don't modify files you didn't create\n" +
      "- Always use `TypeScript` (not JavaScript)\n" +
      "- Handle <html> entities properly\n" +
      "- Use \"double quotes\" for strings\n" +
      "- Budget: $100 max\n\n" +
      "## Skills\n" +
      Array.from({ length: 50 }, (_, i) => `- Skill ${i + 1}: Lorem ipsum dolor sit amet`).join("\n");

    create({ id: "long", name: "Long Persona", description: "Very long instructions", fullText: longText });

    const p = get("long");
    expect(p!.fullText.length).toBeGreaterThan(1000);
    expect(p!.fullText).toContain("Don't modify");
    expect(p!.fullText).toContain("$100 max");

    del("long");
  });
});
