/**
 * Tests for knowledge relationship edges (task b3e46a5b).
 *
 * Verifies knowledge_edges table, CRUD operations, edge types,
 * related entries lookup, and deduplication.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AppDatabase } from "../../core/database.js";
import path from "path";
import fs from "fs";
import os from "os";

let db: AppDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-edges-test-"));
  db = new AppDatabase(tmpDir);
  // Seed knowledge entries
  db.saveKnowledge({ id: "k1", sessionId: "s1", key: "api-spec", value: "REST API specification" });
  db.saveKnowledge({ id: "k2", sessionId: "s1", key: "auth-guide", value: "Authentication guide" });
  db.saveKnowledge({ id: "k3", sessionId: "s1", key: "deploy-docs", value: "Deployment documentation" });
});

afterEach(() => {
  try { db.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("knowledge_edges table", () => {
  it("should be created by migration 19", () => {
    const version = db.db.pragma("user_version", { simple: true }) as number;
    expect(version).toBe(20);
  });
});

describe("addKnowledgeEdge", () => {
  it("should create an edge between two entries", () => {
    db.addKnowledgeEdge({ id: "e1", sessionId: "s1", fromKey: "api-spec", toKey: "auth-guide", edgeType: "references" });
    const edges = db.getKnowledgeEdges("s1", "api-spec");
    expect(edges).toHaveLength(1);
    expect(edges[0].fromKey).toBe("api-spec");
    expect(edges[0].toKey).toBe("auth-guide");
    expect(edges[0].edgeType).toBe("references");
  });

  it("should support all edge types", () => {
    const types = ["references", "supersedes", "contradicts", "extends", "related"];
    types.forEach((type, i) => {
      db.addKnowledgeEdge({ id: `e${i}`, sessionId: "s1", fromKey: "api-spec", toKey: "auth-guide", edgeType: type });
    });
    const edges = db.getKnowledgeEdges("s1", "api-spec");
    const edgeTypes = edges.map(e => e.edgeType);
    for (const type of types) {
      expect(edgeTypes).toContain(type);
    }
  });

  it("should be idempotent (INSERT OR IGNORE)", () => {
    db.addKnowledgeEdge({ id: "e1", sessionId: "s1", fromKey: "api-spec", toKey: "auth-guide", edgeType: "references" });
    db.addKnowledgeEdge({ id: "e1", sessionId: "s1", fromKey: "api-spec", toKey: "auth-guide", edgeType: "references" });
    const edges = db.getKnowledgeEdges("s1", "api-spec");
    expect(edges).toHaveLength(1);
  });
});

describe("removeKnowledgeEdge", () => {
  it("should remove an edge", () => {
    db.addKnowledgeEdge({ id: "e1", sessionId: "s1", fromKey: "api-spec", toKey: "auth-guide", edgeType: "references" });
    const removed = db.removeKnowledgeEdge("s1", "api-spec", "auth-guide");
    expect(removed).toBe(true);
    expect(db.getKnowledgeEdges("s1", "api-spec")).toHaveLength(0);
  });

  it("should return false if edge does not exist", () => {
    const removed = db.removeKnowledgeEdge("s1", "nonexistent", "also-nonexistent");
    expect(removed).toBe(false);
  });
});

describe("getKnowledgeEdges", () => {
  it("should return edges where key is from or to", () => {
    db.addKnowledgeEdge({ id: "e1", sessionId: "s1", fromKey: "api-spec", toKey: "auth-guide", edgeType: "references" });
    db.addKnowledgeEdge({ id: "e2", sessionId: "s1", fromKey: "deploy-docs", toKey: "api-spec", edgeType: "extends" });

    const edges = db.getKnowledgeEdges("s1", "api-spec");
    expect(edges).toHaveLength(2);
  });

  it("should return empty array for key with no edges", () => {
    expect(db.getKnowledgeEdges("s1", "no-edges")).toEqual([]);
  });

  it("should be session-scoped", () => {
    db.addKnowledgeEdge({ id: "e1", sessionId: "s1", fromKey: "api-spec", toKey: "auth-guide", edgeType: "references" });
    db.addKnowledgeEdge({ id: "e2", sessionId: "s2", fromKey: "api-spec", toKey: "auth-guide", edgeType: "references" });
    expect(db.getKnowledgeEdges("s1", "api-spec")).toHaveLength(1);
    expect(db.getKnowledgeEdges("s2", "api-spec")).toHaveLength(1);
  });
});

describe("getRelatedKnowledge", () => {
  it("should return related entries with edge info", () => {
    db.addKnowledgeEdge({ id: "e1", sessionId: "s1", fromKey: "api-spec", toKey: "auth-guide", edgeType: "references" });
    const related = db.getRelatedKnowledge("s1", "api-spec");
    expect(related).toHaveLength(1);
    expect(related[0].key).toBe("auth-guide");
    expect(related[0].edgeType).toBe("references");
    expect(related[0].direction).toBe("from");
  });

  it("should return entries from both directions", () => {
    db.addKnowledgeEdge({ id: "e1", sessionId: "s1", fromKey: "api-spec", toKey: "auth-guide", edgeType: "references" });
    db.addKnowledgeEdge({ id: "e2", sessionId: "s1", fromKey: "deploy-docs", toKey: "api-spec", edgeType: "extends" });

    const related = db.getRelatedKnowledge("s1", "api-spec");
    expect(related).toHaveLength(2);
    const keys = related.map(r => r.key);
    expect(keys).toContain("auth-guide");
    expect(keys).toContain("deploy-docs");
  });

  it("should skip entries that no longer exist", () => {
    db.addKnowledgeEdge({ id: "e1", sessionId: "s1", fromKey: "api-spec", toKey: "deleted-key", edgeType: "references" });
    const related = db.getRelatedKnowledge("s1", "api-spec");
    expect(related).toHaveLength(0);
  });

  it("should return empty for key with no edges", () => {
    expect(db.getRelatedKnowledge("s1", "api-spec")).toEqual([]);
  });
});

describe("persistence", () => {
  it("should survive DB close/reopen", () => {
    db.addKnowledgeEdge({ id: "e1", sessionId: "s1", fromKey: "api-spec", toKey: "auth-guide", edgeType: "references" });
    db.close();

    const db2 = new AppDatabase(tmpDir);
    const edges = db2.getKnowledgeEdges("s1", "api-spec");
    expect(edges).toHaveLength(1);
    expect(edges[0].edgeType).toBe("references");
    db2.close();
  });
});
