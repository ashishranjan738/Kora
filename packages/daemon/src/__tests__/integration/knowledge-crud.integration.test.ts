/**
 * Integration tests for knowledge CRUD via REST API.
 * Tests save, retrieve, search, update, delete operations.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync } from "fs";

describe("Knowledge CRUD (REST API)", () => {
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
      .send({ name: "Knowledge Test", projectPath, provider: "claude-code" });

    expect(res.status).toBe(201);
    sessionId = res.body.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("saves and retrieves knowledge entry via API", async () => {
    await saveKnowledge("arch-doc", "## Architecture\nMicroservices with event sourcing.");

    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/knowledge-db/arch-doc`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("key", "arch-doc");
    expect(res.body.value).toContain("Architecture");
  });

  it("searches knowledge entries", async () => {
    await saveKnowledge("api-design", "REST endpoints for user management");
    await saveKnowledge("db-schema", "PostgreSQL schema with migrations");

    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/knowledge-db?q=REST`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThanOrEqual(1);
    expect(res.body.entries.some((e: any) => e.key === "api-design")).toBe(true);
  });

  it("updates existing knowledge entry", async () => {
    await saveKnowledge("my-key", "original value");

    const updateRes = await request(ctx.app)
      .put(`/api/v1/sessions/${sessionId}/knowledge-db/my-key`)
      .set(auth())
      .send({ value: "updated value", savedBy: "editor" });

    expect(updateRes.status).toBe(200);

    const getRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/knowledge-db/my-key`)
      .set(auth());

    expect(getRes.body.value).toBe("updated value");
  });

  it("deletes knowledge entry via API", async () => {
    await saveKnowledge("delete-me", "temporary data");

    const deleteRes = await request(ctx.app)
      .delete(`/api/v1/sessions/${sessionId}/knowledge-db/delete-me`)
      .set(auth());

    expect(deleteRes.status).toBe(200);

    const getRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/knowledge-db/delete-me`)
      .set(auth());

    expect(getRes.status).toBe(404);
  });

  it("returns 404 for non-existent knowledge key", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/knowledge-db/nonexistent`)
      .set(auth());

    expect(res.status).toBe(404);
  });
});
