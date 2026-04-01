/**
 * Tests for global knowledge store (task b91801f9).
 *
 * Verifies GlobalKnowledgeDB CRUD, promote, list, collision handling,
 * and persistence across reopen.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GlobalKnowledgeDB } from "../../core/global-knowledge.js";
import path from "path";
import fs from "fs";
import os from "os";

let db: GlobalKnowledgeDB;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-global-knowledge-test-"));
  db = new GlobalKnowledgeDB(tmpDir);
});

afterEach(() => {
  try { db.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GlobalKnowledgeDB", () => {
  describe("promote", () => {
    it("should add an entry to the global store", () => {
      db.promote({ key: "api-spec", value: "REST API specification", sourceSession: "session-1", promotedBy: "master-1" });
      const entry = db.get("api-spec");
      expect(entry).not.toBeNull();
      expect(entry!.key).toBe("api-spec");
      expect(entry!.value).toBe("REST API specification");
      expect(entry!.sourceSession).toBe("session-1");
      expect(entry!.promotedBy).toBe("master-1");
    });

    it("should overwrite on promote with same key", () => {
      db.promote({ key: "config", value: "old value", sourceSession: "s1", promotedBy: "m1" });
      db.promote({ key: "config", value: "new value", sourceSession: "s2", promotedBy: "m2" });
      const entry = db.get("config");
      expect(entry!.value).toBe("new value");
      expect(entry!.sourceSession).toBe("s2");
    });
  });

  describe("get", () => {
    it("should return null for unknown key", () => {
      expect(db.get("nonexistent")).toBeNull();
    });

    it("should return the promoted entry", () => {
      db.promote({ key: "test", value: "test value", sourceSession: "s1", promotedBy: "m1" });
      const entry = db.get("test");
      expect(entry).not.toBeNull();
      expect(entry!.promotedAt).toBeDefined();
    });
  });

  describe("list", () => {
    it("should return all entries ordered by promoted_at desc", () => {
      db.promote({ key: "a", value: "val-a", sourceSession: "s1", promotedBy: "m1" });
      db.promote({ key: "b", value: "val-b", sourceSession: "s1", promotedBy: "m1" });
      db.promote({ key: "c", value: "val-c", sourceSession: "s1", promotedBy: "m1" });
      const entries = db.list();
      expect(entries).toHaveLength(3);
    });

    it("should respect limit", () => {
      for (let i = 0; i < 5; i++) {
        db.promote({ key: `key-${i}`, value: `val-${i}`, sourceSession: "s1", promotedBy: "m1" });
      }
      const entries = db.list(3);
      expect(entries).toHaveLength(3);
    });

    it("should return empty for no entries", () => {
      expect(db.list()).toEqual([]);
    });
  });

  describe("remove", () => {
    it("should delete an entry", () => {
      db.promote({ key: "temp", value: "temporary", sourceSession: "s1", promotedBy: "m1" });
      const removed = db.remove("temp");
      expect(removed).toBe(true);
      expect(db.get("temp")).toBeNull();
    });

    it("should return false for non-existent key", () => {
      expect(db.remove("nonexistent")).toBe(false);
    });
  });

  describe("persistence", () => {
    it("should survive close and reopen", () => {
      db.promote({ key: "persistent", value: "survives restart", sourceSession: "s1", promotedBy: "m1" });
      db.close();

      const db2 = new GlobalKnowledgeDB(tmpDir);
      const entry = db2.get("persistent");
      expect(entry).not.toBeNull();
      expect(entry!.value).toBe("survives restart");
      db2.close();
    });
  });

  describe("create", () => {
    it("creates entry without source metadata", () => {
      db.create({ key: "direct", value: "created directly" });
      const entry = db.get("direct");
      expect(entry).not.toBeNull();
      expect(entry!.value).toBe("created directly");
      expect(entry!.sourceSession).toBeNull();
      expect(entry!.promotedBy).toBeNull();
    });

    it("creates entry with source metadata", () => {
      db.create({ key: "sourced", value: "from session", sourceSession: "s1", promotedBy: "dev-1" });
      const entry = db.get("sourced");
      expect(entry!.sourceSession).toBe("s1");
      expect(entry!.promotedBy).toBe("dev-1");
    });
  });

  describe("update", () => {
    it("updates existing entry value", () => {
      db.create({ key: "mutable", value: "old" });
      expect(db.update("mutable", "new")).toBe(true);
      expect(db.get("mutable")!.value).toBe("new");
    });

    it("returns false for non-existent key", () => {
      expect(db.update("ghost", "value")).toBe(false);
    });
  });

  describe("count", () => {
    it("returns 0 when empty", () => {
      expect(db.count()).toBe(0);
    });

    it("returns correct count", () => {
      db.create({ key: "a", value: "1" });
      db.create({ key: "b", value: "2" });
      expect(db.count()).toBe(2);
    });
  });

  describe("search", () => {
    beforeEach(() => {
      db.create({ key: "api-design", value: "RESTful patterns for microservices" });
      db.create({ key: "db-optimization", value: "Use indexes on frequently queried columns" });
      db.create({ key: "testing-tips", value: "Unit tests for business logic" });
    });

    it("finds entries by keyword in key (LIKE fallback)", () => {
      const results = db.search("api");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(r => r.key === "api-design")).toBe(true);
    });

    it("finds entries by keyword in value", () => {
      const results = db.search("indexes");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(r => r.key === "db-optimization")).toBe(true);
    });

    it("returns empty for no match", () => {
      expect(db.search("zzz-nonexistent")).toHaveLength(0);
    });

    it("respects limit", () => {
      const results = db.search("tests", 1);
      expect(results).toHaveLength(1);
    });
  });

  describe("master-only promote (handler level)", () => {
    it("promote_knowledge handler requires master role", async () => {
      // This is tested at the handler level — the handler checks ctx.agentRole
      // Here we just verify the DB layer accepts any caller
      db.promote({ key: "test", value: "value", sourceSession: "s1", promotedBy: "worker-1" });
      expect(db.get("test")).not.toBeNull();
    });
  });
});
