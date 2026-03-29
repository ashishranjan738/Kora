/**
 * Integration tests for FTS5 knowledge search via REST API.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync } from "fs";

describe("FTS5 knowledge search", () => {
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

  async function searchKnowledge(query: string) {
    return request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/knowledge-db?q=${encodeURIComponent(query)}`)
      .set(auth());
  }

  beforeEach(async () => {
    ctx = setupTestApp();
    await ctx.sessionManager.load();

    const projectPath = join(ctx.testDir, `test-project-${Date.now()}`);
    mkdirSync(projectPath, { recursive: true });

    const res = await request(ctx.app)
      .post("/api/v1/sessions")
      .set(auth())
      .send({ name: "FTS Test", projectPath, provider: "claude-code" });

    expect(res.status).toBe(201);
    sessionId = res.body.id;

    await saveKnowledge("architecture", "Microservices with event sourcing and CQRS pattern");
    await saveKnowledge("api-design", "REST endpoints follow OpenAPI 3.0 specification");
    await saveKnowledge("deployment", "Docker containers deployed to Kubernetes via Helm charts");
    await saveKnowledge("testing-strategy", "Unit tests with Vitest, integration tests with supertest");
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("search returns relevant results for keyword", async () => {
    const res = await searchKnowledge("microservices");
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThanOrEqual(1);
    expect(res.body.entries.some((e: any) => e.key === "architecture")).toBe(true);
  });

  it("multi-word search returns matching entries", async () => {
    const res = await searchKnowledge("Docker Kubernetes");
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThanOrEqual(1);
    expect(res.body.entries.some((e: any) => e.key === "deployment")).toBe(true);
  });

  it("search reflects new entries immediately", async () => {
    await saveKnowledge("new-entry", "GraphQL federation gateway with Apollo");

    const res = await searchKnowledge("GraphQL");
    expect(res.status).toBe(200);
    expect(res.body.entries.some((e: any) => e.key === "new-entry")).toBe(true);

    await request(ctx.app)
      .delete(`/api/v1/sessions/${sessionId}/knowledge-db/new-entry`)
      .set(auth());

    const res2 = await searchKnowledge("GraphQL");
    expect(res2.body.entries.some((e: any) => e.key === "new-entry")).toBe(false);
  });

  it("search handles special characters gracefully", async () => {
    const res = await searchKnowledge("C++ *pointer*");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
  });

  it("empty query returns entries", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/knowledge-db`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(4);
  });
});
