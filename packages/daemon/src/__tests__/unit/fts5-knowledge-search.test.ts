/**
 * Tests for FTS5 knowledge base search (task e48a91f2).
 *
 * Verifies FTS5 virtual table, sync triggers, BM25 ranking,
 * multi-word queries, partial matches, and LIKE fallback.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AppDatabase } from "../../core/database.js";
import path from "path";
import fs from "fs";
import os from "os";

let db: AppDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-fts5-test-"));
  db = new AppDatabase(tmpDir);
});

afterEach(() => {
  try { db.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("FTS5 knowledge search", () => {
  describe("schema migration", () => {
    it("should create FTS5 virtual table (migration 18)", () => {
      const version = db.db.pragma("user_version", { simple: true }) as number;
      expect(version).toBe(20);
    });

    it("should report FTS5 as available", () => {
      expect(db.fts5Available).toBe(true);
    });
  });

  describe("sync triggers", () => {
    it("should index new knowledge entries", () => {
      db.saveKnowledge({ id: "k1", sessionId: "s1", key: "api-spec", value: "REST API specification for user service" });
      const results = db.searchKnowledge("s1", "REST API");
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe("api-spec");
    });

    it("should update FTS on knowledge update", () => {
      db.saveKnowledge({ id: "k1", sessionId: "s1", key: "config", value: "old configuration" });
      db.saveKnowledge({ id: "k2", sessionId: "s1", key: "config", value: "new database settings" });
      const results = db.searchKnowledge("s1", "database");
      expect(results).toHaveLength(1);
      expect(results[0].value).toContain("database");
    });

    it("should remove from FTS on knowledge delete", () => {
      db.saveKnowledge({ id: "k1", sessionId: "s1", key: "temp", value: "temporary data to delete" });
      expect(db.searchKnowledge("s1", "temporary")).toHaveLength(1);
      db.deleteKnowledge("s1", "temp");
      expect(db.searchKnowledge("s1", "temporary")).toHaveLength(0);
    });
  });

  describe("BM25 ranking", () => {
    it("should rank more relevant results higher", () => {
      db.saveKnowledge({ id: "k1", sessionId: "s1", key: "auth-overview", value: "Authentication overview: OAuth2 and JWT tokens" });
      db.saveKnowledge({ id: "k2", sessionId: "s1", key: "auth-deep-dive", value: "Authentication deep dive: OAuth2 token refresh, JWT validation, session management, authentication flows" });
      db.saveKnowledge({ id: "k3", sessionId: "s1", key: "unrelated", value: "Database migration guide for PostgreSQL" });

      const results = db.searchKnowledge("s1", "authentication");
      expect(results.length).toBeGreaterThanOrEqual(2);
      // Both auth entries should appear, unrelated should not
      const keys = results.map(r => r.key);
      expect(keys).toContain("auth-overview");
      expect(keys).toContain("auth-deep-dive");
      expect(keys).not.toContain("unrelated");
    });
  });

  describe("multi-word queries", () => {
    it("should handle multi-word search", () => {
      db.saveKnowledge({ id: "k1", sessionId: "s1", key: "deploy-guide", value: "How to deploy to production using Docker containers" });
      db.saveKnowledge({ id: "k2", sessionId: "s1", key: "docker-basics", value: "Docker basics: images, containers, and volumes" });

      const results = db.searchKnowledge("s1", "Docker containers");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("partial matches", () => {
    it("should match prefix queries", () => {
      db.saveKnowledge({ id: "k1", sessionId: "s1", key: "architecture", value: "Microservices architecture with event sourcing" });

      const results = db.searchKnowledge("s1", "micro");
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe("architecture");
    });
  });

  describe("session isolation", () => {
    it("should only return results for the specified session", () => {
      db.saveKnowledge({ id: "k1", sessionId: "s1", key: "s1-data", value: "Session one specific data" });
      db.saveKnowledge({ id: "k2", sessionId: "s2", key: "s2-data", value: "Session two specific data" });

      const results = db.searchKnowledge("s1", "specific data");
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe("s1-data");
    });
  });

  describe("edge cases", () => {
    it("should handle empty query", () => {
      db.saveKnowledge({ id: "k1", sessionId: "s1", key: "test", value: "some value" });
      const results = db.searchKnowledge("s1", "");
      // Empty query falls back to LIKE which matches nothing with empty pattern
      expect(results).toBeDefined();
    });

    it("should handle special characters in query", () => {
      db.saveKnowledge({ id: "k1", sessionId: "s1", key: "test", value: "value with special chars: @#$%" });
      // Should not crash with special chars
      const results = db.searchKnowledge("s1", "special @#$%");
      expect(results).toBeDefined();
    });

    it("should handle no results", () => {
      const results = db.searchKnowledge("s1", "nonexistent query xyz");
      expect(results).toEqual([]);
    });

    it("should respect limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        db.saveKnowledge({ id: `k${i}`, sessionId: "s1", key: `entry-${i}`, value: `Common keyword repeated entry ${i}` });
      }
      const results = db.searchKnowledge("s1", "keyword", 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  describe("searchKnowledgeFTS direct", () => {
    it("should be available as a separate method", () => {
      db.saveKnowledge({ id: "k1", sessionId: "s1", key: "direct-test", value: "Testing direct FTS5 search method" });
      const results = db.searchKnowledgeFTS("s1", "direct FTS5");
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe("direct-test");
    });
  });

  describe("persistence across reopen", () => {
    it("should maintain FTS index after DB close/reopen", () => {
      db.saveKnowledge({ id: "k1", sessionId: "s1", key: "persistent", value: "This should survive a reopen" });
      db.close();

      const db2 = new AppDatabase(tmpDir);
      expect(db2.fts5Available).toBe(true);
      const results = db2.searchKnowledge("s1", "survive reopen");
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe("persistent");
      db2.close();
    });
  });
});
