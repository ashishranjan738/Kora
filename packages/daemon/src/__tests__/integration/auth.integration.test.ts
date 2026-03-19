/**
 * Integration tests for authentication middleware.
 * Verifies that all API endpoints require valid Bearer token.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";

describe("Auth integration", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = setupTestApp();
    await ctx.sessionManager.load();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("accepts requests with valid Bearer token", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/status")
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("alive", true);
  });

  it("rejects requests with invalid token", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/sessions")
      .set("Authorization", "Bearer invalid-token");

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Unauthorized");
  });

  it("rejects requests without Authorization header", async () => {
    const res = await request(ctx.app).get("/api/v1/sessions");

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Unauthorized");
  });

  it("rejects requests with malformed Authorization header", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/sessions")
      .set("Authorization", ctx.token); // Missing "Bearer " prefix

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Unauthorized");
  });

  describe("protected endpoints require auth", () => {
    it("GET /api/v1/sessions requires auth", async () => {
      const res = await request(ctx.app).get("/api/v1/sessions");
      expect(res.status).toBe(401);
    });

    it("POST /api/v1/sessions requires auth", async () => {
      const res = await request(ctx.app)
        .post("/api/v1/sessions")
        .send({ name: "test", projectPath: "/tmp/test", provider: "claude-code" });
      expect(res.status).toBe(401);
    });

    it("GET /api/v1/providers requires auth", async () => {
      const res = await request(ctx.app).get("/api/v1/providers");
      expect(res.status).toBe(401);
    });
  });
});
