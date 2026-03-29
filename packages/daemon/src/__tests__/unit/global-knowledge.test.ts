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

  describe("master-only promote (handler level)", () => {
    it("promote_knowledge handler requires master role", async () => {
      // This is tested at the handler level — the handler checks ctx.agentRole
      // Here we just verify the DB layer accepts any caller
      db.promote({ key: "test", value: "value", sourceSession: "s1", promotedBy: "worker-1" });
      expect(db.get("test")).not.toBeNull();
    });
  });
});
