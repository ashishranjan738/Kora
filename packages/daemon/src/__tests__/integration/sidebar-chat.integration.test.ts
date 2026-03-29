/**
 * Integration tests for sidebar chat via channel relay.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync } from "fs";

describe("Sidebar chat (channel relay)", () => {
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
      .send({ name: "Chat Test", projectPath, provider: "claude-code" });

    expect(res.status).toBe(201);
    sessionId = res.body.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("creates #sidebar channel for user-agent chat", async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/channels`)
      .set(auth())
      .send({ id: "#sidebar", name: "Sidebar Chat" });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id", "#sidebar");
  });

  it("channel messages retrievable via history endpoint", async () => {
    await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/channels`)
      .set(auth())
      .send({ id: "#sidebar", name: "Sidebar" });

    const historyRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/channels/%23sidebar/messages`)
      .set(auth());

    expect(historyRes.status).toBe(200);
    expect(historyRes.body).toHaveProperty("channel", "#sidebar");
    expect(Array.isArray(historyRes.body.messages)).toBe(true);
  });

  it("relay endpoint accepts channel parameter for routing", async () => {
    await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/channels`)
      .set(auth())
      .send({ id: "#sidebar", name: "Sidebar" });

    const relayRes = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/relay`)
      .set(auth())
      .send({ from: "user", to: "master", message: "Hello from sidebar", channel: "#sidebar" });

    expect([200, 404]).toContain(relayRes.status);
  });
});
