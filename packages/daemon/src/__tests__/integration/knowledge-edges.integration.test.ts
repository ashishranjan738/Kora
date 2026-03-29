/**
 * Integration tests for knowledge relationship edges via REST API.
 * Tests add, remove, get related, validation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync } from "fs";

describe("Knowledge edges", () => {
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

    await saveKnowledge("arch-v1", "Microservices architecture");
    await saveKnowledge("arch-v2", "Updated to event sourcing");
    await saveKnowledge("api-design", "REST endpoints spec");
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("creates edge between knowledge entries", async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/knowledge-db/edges`)
      .set(auth())
      .send({ fromKey: "arch-v2", toKey: "arch-v1", edgeType: "supersedes" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.edgeType).toBe("supersedes");
  });

  it("removes edge between entries", async () => {
    await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/knowledge-db/edges`)
      .set(auth())
      .send({ fromKey: "arch-v2", toKey: "arch-v1", edgeType: "supersedes" });

    const res = await request(ctx.app)
      .delete(`/api/v1/sessions/${sessionId}/knowledge-db/edges/arch-v2/arch-v1`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
  });

  it("retrieves edges for a knowledge entry", async () => {
    await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/knowledge-db/edges`)
      .set(auth())
      .send({ fromKey: "arch-v2", toKey: "arch-v1", edgeType: "supersedes" });

    await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/knowledge-db/edges`)
      .set(auth())
      .send({ fromKey: "arch-v2", toKey: "api-design", edgeType: "references" });

    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/knowledge-db/arch-v2/edges`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.edges.length).toBe(2);
    expect(res.body.count).toBe(2);
  });

  it("returns 404 for removing non-existent edge", async () => {
    const res = await request(ctx.app)
      .delete(`/api/v1/sessions/${sessionId}/knowledge-db/edges/nonexistent/also-nonexistent`)
      .set(auth());

    expect(res.status).toBe(404);
  });

  it("rejects invalid edge type", async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/knowledge-db/edges`)
      .set(auth())
      .send({ fromKey: "arch-v1", toKey: "arch-v2", edgeType: "invalid-type" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid edgeType");
  });

  it("rejects edge creation with missing fields", async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/knowledge-db/edges`)
      .set(auth())
      .send({ fromKey: "arch-v1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("required");
  });
});
