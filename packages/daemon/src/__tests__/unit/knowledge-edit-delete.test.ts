/**
 * Tests for knowledge entry edit/delete — database layer + API endpoints.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AppDatabase } from "../../core/database.js";

describe("AppDatabase — knowledge edit/delete", () => {
  let db: AppDatabase;
  let tmpDir: string;
  const sessionId = "test-session";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-knowledge-test-"));
    db = new AppDatabase(tmpDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── deleteKnowledge ──────────────────────────────────

  describe("deleteKnowledge", () => {
    it("deletes existing entry and returns true", () => {
      db.saveKnowledge({ id: "k1", sessionId, key: "test-key", value: "test-value", savedBy: "agent-1" });
      const result = db.deleteKnowledge(sessionId, "test-key");
      expect(result).toBe(true);
      expect(db.getKnowledge(sessionId, "test-key")).toBeNull();
    });

    it("returns false for non-existent key", () => {
      const result = db.deleteKnowledge(sessionId, "nonexistent-key");
      expect(result).toBe(false);
    });

    it("returns false for wrong session ID", () => {
      db.saveKnowledge({ id: "k1", sessionId, key: "test-key", value: "test-value" });
      const result = db.deleteKnowledge("other-session", "test-key");
      expect(result).toBe(false);
      expect(db.getKnowledge(sessionId, "test-key")).not.toBeNull();
    });

    it("deletes only the specified key, not others", () => {
      db.saveKnowledge({ id: "k1", sessionId, key: "keep-me", value: "value1" });
      db.saveKnowledge({ id: "k2", sessionId, key: "delete-me", value: "value2" });
      db.deleteKnowledge(sessionId, "delete-me");
      expect(db.getKnowledge(sessionId, "keep-me")).not.toBeNull();
      expect(db.getKnowledge(sessionId, "delete-me")).toBeNull();
    });

    it("handles keys with special characters", () => {
      const specialKey = "my-key/with spaces & symbols!";
      db.saveKnowledge({ id: "k1", sessionId, key: specialKey, value: "value" });
      const result = db.deleteKnowledge(sessionId, specialKey);
      expect(result).toBe(true);
      expect(db.getKnowledge(sessionId, specialKey)).toBeNull();
    });

    it("deleted entry no longer appears in search results", () => {
      db.saveKnowledge({ id: "k1", sessionId, key: "searchable-key", value: "searchable-value" });
      db.deleteKnowledge(sessionId, "searchable-key");
      const results = db.searchKnowledge(sessionId, "searchable");
      expect(results).toHaveLength(0);
    });

    it("deleted entry no longer appears in listKnowledge", () => {
      db.saveKnowledge({ id: "k1", sessionId, key: "listed-key", value: "listed-value" });
      db.deleteKnowledge(sessionId, "listed-key");
      const results = db.listKnowledge(sessionId);
      expect(results.find(r => r.key === "listed-key")).toBeUndefined();
    });
  });

  // ── saveKnowledge — edit (upsert) ──────────────────────

  describe("saveKnowledge — edit (upsert)", () => {
    it("updates existing entry value", () => {
      db.saveKnowledge({ id: "k1", sessionId, key: "my-key", value: "original", savedBy: "agent-1" });
      db.saveKnowledge({ id: "k2", sessionId, key: "my-key", value: "updated", savedBy: "agent-2" });
      const entry = db.getKnowledge(sessionId, "my-key");
      expect(entry!.value).toBe("updated");
      expect(entry!.savedBy).toBe("agent-2");
    });

    it("preserves key on upsert", () => {
      db.saveKnowledge({ id: "k1", sessionId, key: "my-key", value: "v1" });
      db.saveKnowledge({ id: "k2", sessionId, key: "my-key", value: "v2" });
      const entry = db.getKnowledge(sessionId, "my-key");
      expect(entry!.key).toBe("my-key");
    });

    it("creates new entry if key does not exist", () => {
      db.saveKnowledge({ id: "k1", sessionId, key: "new-key", value: "new-value" });
      const entry = db.getKnowledge(sessionId, "new-key");
      expect(entry).not.toBeNull();
      expect(entry!.value).toBe("new-value");
    });

    it("handles savedBy being undefined", () => {
      db.saveKnowledge({ id: "k1", sessionId, key: "my-key", value: "val" });
      const entry = db.getKnowledge(sessionId, "my-key");
      expect(entry!.savedBy).toBeNull();
    });

    it("does not affect entries in other sessions", () => {
      db.saveKnowledge({ id: "k1", sessionId: "session-a", key: "shared-key", value: "value-a" });
      db.saveKnowledge({ id: "k2", sessionId: "session-b", key: "shared-key", value: "value-b" });
      expect(db.getKnowledge("session-a", "shared-key")!.value).toBe("value-a");
      expect(db.getKnowledge("session-b", "shared-key")!.value).toBe("value-b");
    });
  });

  // ── getKnowledge ──────────────────────────────────────

  describe("getKnowledge", () => {
    it("returns null for non-existent key", () => {
      expect(db.getKnowledge(sessionId, "nope")).toBeNull();
    });

    it("returns entry with all fields", () => {
      db.saveKnowledge({ id: "k1", sessionId, key: "full-key", value: "full-value", savedBy: "tester" });
      const entry = db.getKnowledge(sessionId, "full-key");
      expect(entry).toEqual({
        key: "full-key",
        value: "full-value",
        savedBy: "tester",
        updatedAt: expect.any(String),
      });
    });
  });

  // ── Combined operations ──────────────────────────────

  describe("combined operations", () => {
    it("create → update → delete lifecycle", () => {
      // Create
      db.saveKnowledge({ id: "k1", sessionId, key: "lifecycle", value: "v1" });
      expect(db.getKnowledge(sessionId, "lifecycle")!.value).toBe("v1");

      // Update
      db.saveKnowledge({ id: "k2", sessionId, key: "lifecycle", value: "v2", savedBy: "editor" });
      expect(db.getKnowledge(sessionId, "lifecycle")!.value).toBe("v2");

      // Delete
      const deleted = db.deleteKnowledge(sessionId, "lifecycle");
      expect(deleted).toBe(true);
      expect(db.getKnowledge(sessionId, "lifecycle")).toBeNull();

      // Re-create after delete
      db.saveKnowledge({ id: "k3", sessionId, key: "lifecycle", value: "v3" });
      expect(db.getKnowledge(sessionId, "lifecycle")!.value).toBe("v3");
    });
  });
});
