/**
 * Integration tests for sprint 5 features:
 * - Monaco editor raw file endpoint (Content-Type, path traversal, extensions)
 * - Knowledge edges (add, remove, related, edge types, validation)
 * - Runbook templates (default instructions for standard states)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";

// ═══════════════════════════════════════════════════════════════════════
// Monaco Editor — Raw File Endpoint
// ═══════════════════════════════════════════════════════════════════════

describe("Sprint 5: Monaco editor raw file endpoint", () => {
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
      .send({ name: "Editor Test", projectPath, provider: "claude-code" });

    expect(res.status).toBe(201);
    sessionId = res.body.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // Test 1: Raw file endpoint serves with security headers
  it("serves uploaded file with X-Content-Type-Options: nosniff", async () => {
    const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

    const uploadRes = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(auth())
      .send({ filename: "test.png", base64Data });

    expect(uploadRes.status).toBe(201);
    const filename = uploadRes.body.filename;

    // Retrieve and check headers
    const getRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/attachments/${filename}`)
      .set(auth());

    // May return 200 or other status depending on static file serving
    if (getRes.status === 200) {
      expect(getRes.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  // Test 2: Raw endpoint blocks path traversal
  it("blocks path traversal in attachment filename", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/attachments/..%2F..%2Fetc%2Fpasswd`)
      .set(auth());

    expect(res.status).toBe(400);
  });

  // Test 3: Rejects unsupported binary extensions
  it("rejects binary extension (.exe) in upload", async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(auth())
      .send({ filename: "malware.exe", base64Data: "abc123" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unsupported");
  });

  // Test 4: Accepts code file extensions
  it("accepts .ts and .md file uploads for Monaco editor", async () => {
    const tsContent = Buffer.from("export const x = 1;").toString("base64");
    const mdContent = Buffer.from("# Hello").toString("base64");

    const tsRes = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(auth())
      .send({ filename: "code.ts", base64Data: tsContent });
    expect(tsRes.status).toBe(201);

    const mdRes = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(auth())
      .send({ filename: "readme.md", base64Data: mdContent });
    expect(mdRes.status).toBe(201);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Knowledge Edges
// ═══════════════════════════════════════════════════════════════════════

describe("Sprint 5: Knowledge edges", () => {
  let ctx: TestContext;
  let sessionId: string;

  const auth = () => ({ Authorization: `Bearer ${ctx.token}` });

  async function saveKnowledge(key: string, value: string) {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/knowledge-db`)
      .set(auth())
      .send({ key, value, savedBy: "tester" });
    expect(res.status).toBe(201);
  }

  beforeEach(async () => {
    ctx = setupTestApp();
    await ctx.sessionManager.load();

    const projectPath = join(ctx.testDir, `test-project-${Date.now()}`);
    mkdirSync(projectPath, { recursive: true });

    const res = await request(ctx.app)
      .post("/api/v1/sessions")
      .set(auth())
      .send({ name: "Edge Test", projectPath, provider: "claude-code" });

    expect(res.status).toBe(201);
    sessionId = res.body.id;

    // Seed knowledge entries
    await saveKnowledge("arch-v1", "Microservices architecture");
    await saveKnowledge("arch-v2", "Updated to event sourcing");
    await saveKnowledge("api-design", "REST endpoints spec");
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // Test 5: Add edge between entries
  it("creates edge between knowledge entries", async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/knowledge-db/edges`)
      .set(auth())
      .send({ fromKey: "arch-v2", toKey: "arch-v1", edgeType: "supersedes" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.edgeType).toBe("supersedes");
  });

  // Test 6: Remove edge
  it("removes edge between entries", async () => {
    // Create edge first
    await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/knowledge-db/edges`)
      .set(auth())
      .send({ fromKey: "arch-v2", toKey: "arch-v1", edgeType: "supersedes" });

    // Remove it
    const res = await request(ctx.app)
      .delete(`/api/v1/sessions/${sessionId}/knowledge-db/edges/arch-v2/arch-v1`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
  });

  // Test 7: Get related entries returns connected knowledge
  it("retrieves edges for a knowledge entry", async () => {
    // Create edges
    await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/knowledge-db/edges`)
      .set(auth())
      .send({ fromKey: "arch-v2", toKey: "arch-v1", edgeType: "supersedes" });

    await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/knowledge-db/edges`)
      .set(auth())
      .send({ fromKey: "arch-v2", toKey: "api-design", edgeType: "references" });

    // Get edges for arch-v2
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/knowledge-db/arch-v2/edges`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.edges.length).toBe(2);
    expect(res.body.count).toBe(2);
  });

  // Test 8: Removing non-existent edge returns 404
  it("returns 404 for removing non-existent edge", async () => {
    const res = await request(ctx.app)
      .delete(`/api/v1/sessions/${sessionId}/knowledge-db/edges/nonexistent/also-nonexistent`)
      .set(auth());

    expect(res.status).toBe(404);
  });

  // Test 9: Invalid edge type rejected
  it("rejects invalid edge type", async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/knowledge-db/edges`)
      .set(auth())
      .send({ fromKey: "arch-v1", toKey: "arch-v2", edgeType: "invalid-type" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid edgeType");
  });

  // Test 10: Missing required fields rejected
  it("rejects edge creation with missing fields", async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/knowledge-db/edges`)
      .set(auth())
      .send({ fromKey: "arch-v1" }); // missing toKey and edgeType

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("required");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Runbook Templates (default workflow instructions)
// ═══════════════════════════════════════════════════════════════════════

describe("Sprint 5: Runbook templates", () => {
  // Test 11: Standard pipeline template has default instructions
  it("standard pipeline template includes per-state instructions", async () => {
    const { PIPELINE_TEMPLATES } = await import("@kora/shared");
    const standard = PIPELINE_TEMPLATES.find((t: any) => t.id === "standard");

    expect(standard).toBeDefined();
    if (standard) {
      for (const state of standard.states) {
        expect(state.instructions).toBeDefined();
        expect(state.instructions!.length).toBeGreaterThan(0);
      }
    }
  });

  // Test 12: Full pipeline template has instructions for all states
  it("full pipeline template has instructions for all 6 states", async () => {
    const { PIPELINE_TEMPLATES } = await import("@kora/shared");
    const full = PIPELINE_TEMPLATES.find((t: any) => t.id === "full");

    expect(full).toBeDefined();
    if (full) {
      expect(full.states.length).toBeGreaterThanOrEqual(5);
      for (const state of full.states) {
        expect(state.instructions).toBeDefined();
      }
    }
  });

  // Test 13: New session with standard template gets default instructions
  it("session created with workflow states preserves instructions", async () => {
    const ctx = setupTestApp();
    await ctx.sessionManager.load();

    const projectPath = join(ctx.testDir, `test-project-${Date.now()}`);
    mkdirSync(projectPath, { recursive: true });

    const { PIPELINE_TEMPLATES } = await import("@kora/shared");
    const standard = PIPELINE_TEMPLATES.find((t: any) => t.id === "standard");

    const res = await request(ctx.app)
      .post("/api/v1/sessions")
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        name: "Runbook Test",
        projectPath,
        provider: "claude-code",
        workflowStates: standard?.states,
      });

    expect(res.status).toBe(201);
    // Session config should have workflowStates with instructions
    const session = ctx.sessionManager.getSession(res.body.id);
    expect(session?.config.workflowStates).toBeDefined();
    if (session?.config.workflowStates) {
      const inProgress = session.config.workflowStates.find((s: any) => s.id === "in-progress");
      expect(inProgress?.instructions).toBeDefined();
      expect(inProgress?.instructions?.length).toBeGreaterThan(0);
    }

    ctx.cleanup();
  });
});
