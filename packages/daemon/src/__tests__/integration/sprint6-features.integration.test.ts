/**
 * Integration tests for sprint 6 features:
 * - Semantic embeddings (cosine similarity, serialization — no model download)
 * - Auto-surfacing knowledge in task notifications
 * - Cross-session global knowledge store
 * - Crash.log periodic rotation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync, writeFileSync, statSync } from "fs";

// ═══════════════════════════════════════════════════════════════════════
// Semantic Embeddings (unit-level — no model download needed)
// ═══════════════════════════════════════════════════════════════════════

describe("Sprint 6: Semantic embeddings", () => {
  // Test 1: Cosine similarity computation is correct
  it("cosineSimilarity returns 1.0 for identical vectors", async () => {
    const { cosineSimilarity } = await import("../../core/embeddings.js");
    const vec = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 5);
  });

  // Test 2: Cosine similarity returns 0 for orthogonal vectors
  it("cosineSimilarity returns 0 for orthogonal vectors", async () => {
    const { cosineSimilarity } = await import("../../core/embeddings.js");
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  // Test 3: Embedding serialization round-trip preserves data
  it("serialize/deserialize round-trip preserves embedding", async () => {
    const { serializeEmbedding, deserializeEmbedding } = await import("../../core/embeddings.js");
    const original = new Float32Array([0.1, 0.2, 0.3, -0.5, 0.99]);
    const serialized = serializeEmbedding(original);
    const restored = deserializeEmbedding(serialized);

    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  // Test 4: Model is not loaded at import (lazy-load check)
  it("isModelLoaded returns false before first embed() call", async () => {
    const { isModelLoaded } = await import("../../core/embeddings.js");
    expect(isModelLoaded()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Auto-Surfacing Knowledge
// ═══════════════════════════════════════════════════════════════════════

describe("Sprint 6: Auto-surfacing knowledge", () => {
  let ctx: TestContext;
  let sessionId: string;

  const auth = () => ({ Authorization: `Bearer ${ctx.token}` });

  beforeEach(async () => {
    ctx = setupTestApp();
    await ctx.sessionManager.load();

    const projectPath = join(ctx.testDir, `test-project-${Date.now()}`);
    mkdirSync(projectPath, { recursive: true });

    const res = await request(ctx.app)
      .post("/api/v1/sessions")
      .set(auth())
      .send({ name: "Surface Test", projectPath, provider: "claude-code" });

    expect(res.status).toBe(201);
    sessionId = res.body.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // Test 5: Task transition succeeds with no knowledge entries
  it("task transition succeeds when no knowledge entries exist", async () => {
    const taskRes = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/tasks`)
      .set(auth())
      .send({ sessionId, title: "Test task" });
    expect(taskRes.status).toBe(201);

    const updateRes = await request(ctx.app)
      .put(`/api/v1/sessions/${sessionId}/tasks/${taskRes.body.id}`)
      .set(auth())
      .send({ status: "in-progress" });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.status).toBe("in-progress");
  });

  // Test 6: Knowledge entries persist for potential surfacing
  it("knowledge entries persist for auto-surfacing", async () => {
    await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/knowledge-db`)
      .set(auth())
      .send({ key: "auth-design", value: "JWT tokens with refresh rotation" });

    const getRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/knowledge-db/auth-design`)
      .set(auth());

    expect(getRes.status).toBe(200);
    expect(getRes.body.value).toContain("JWT");
  });

  // Test 7: Knowledge search finds relevant entries for surfacing context
  it("knowledge search finds entries relevant to task context", async () => {
    await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/knowledge-db`)
      .set(auth())
      .send({ key: "api-auth", value: "Authentication uses JWT tokens with 15-minute expiry" });

    await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/knowledge-db`)
      .set(auth())
      .send({ key: "db-schema", value: "PostgreSQL with users, sessions, tokens tables" });

    const searchRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/knowledge-db?q=authentication JWT`)
      .set(auth());

    expect(searchRes.status).toBe(200);
    expect(searchRes.body.entries.some((e: any) => e.key === "api-auth")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Cross-Session Global Knowledge
// ═══════════════════════════════════════════════════════════════════════

describe("Sprint 6: Cross-session global knowledge", () => {
  let globalDb: any;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join("/tmp", `kora-global-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const { GlobalKnowledgeDB } = await import("../../core/global-knowledge.js");
    globalDb = new GlobalKnowledgeDB(tmpDir);
  });

  afterEach(() => {
    try { globalDb.db.close(); } catch {}
  });

  // Test 8: Promote knowledge to global store
  it("promotes knowledge entry to global store", () => {
    globalDb.promote({ key: "global-arch", value: "Microservices architecture", sourceSession: "test", promotedBy: "master-1" });
    const entry = globalDb.get("global-arch");
    expect(entry).not.toBeNull();
    expect(entry.value).toBe("Microservices architecture");
    expect(entry.promotedBy).toBe("master-1");
  });

  // Test 9: Global entries retrievable
  it("retrieves promoted global knowledge entry", () => {
    globalDb.promote({ key: "global-api", value: "REST API design guide", sourceSession: "test", promotedBy: "master-1" });
    const entry = globalDb.get("global-api");
    expect(entry).not.toBeNull();
    expect(entry.value).toContain("REST API");
    expect(entry.sourceSession).toBe("test");
  });

  // Test 10: Global knowledge list
  it("lists all global knowledge entries", () => {
    globalDb.promote({ key: "g1", value: "Entry 1", sourceSession: "s1", promotedBy: "master" });
    globalDb.promote({ key: "g2", value: "Entry 2", sourceSession: "s1", promotedBy: "master" });

    const entries = globalDb.list(50);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.some((e: any) => e.key === "g1")).toBe(true);
    expect(entries.some((e: any) => e.key === "g2")).toBe(true);
  });

  // Test 11: Delete global knowledge entry
  it("deletes global knowledge entry", () => {
    globalDb.promote({ key: "delete-me", value: "Temporary", sourceSession: "test", promotedBy: "master" });
    expect(globalDb.get("delete-me")).not.toBeNull();

    const deleted = globalDb.remove("delete-me");
    expect(deleted).toBe(true);
    expect(globalDb.get("delete-me")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Crash.log Rotation
// ═══════════════════════════════════════════════════════════════════════

describe("Sprint 6: Crash.log rotation", () => {
  // Test 12: Rotation truncates file exceeding max size
  it("rotateFileBySize truncates file exceeding max size", async () => {
    const { rotateFileBySize } = await import("../../core/log-rotation.js");
    const tmpDir = join("/tmp", `kora-rotation-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const logFile = join(tmpDir, "test.log");
    // Write 100KB of data
    writeFileSync(logFile, "x".repeat(100 * 1024));

    // Rotate with 50KB max, keep 10KB
    await rotateFileBySize(logFile, 50 * 1024, 10 * 1024);

    const stat = statSync(logFile);
    expect(stat.size).toBeLessThanOrEqual(15 * 1024); // Tolerance
    expect(stat.size).toBeGreaterThan(0);
  });

  // Test 13: File under threshold is not rotated
  it("rotateFileBySize does not touch file under max size", async () => {
    const { rotateFileBySize } = await import("../../core/log-rotation.js");
    const tmpDir = join("/tmp", `kora-rotation-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const logFile = join(tmpDir, "small.log");
    const content = "small file content\n";
    writeFileSync(logFile, content);

    // Rotate with 1MB max — file is tiny, should be untouched
    await rotateFileBySize(logFile, 1024 * 1024, 100 * 1024);

    const stat = statSync(logFile);
    expect(stat.size).toBe(content.length);
  });
});
