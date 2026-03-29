/**
 * Integration tests for knowledge auto-surfacing in task notifications.
 * Tests that task transitions work with/without knowledge, and search relevance.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync } from "fs";

describe("Knowledge auto-surfacing", () => {
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
