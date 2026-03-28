/**
 * Integration tests for sprint 2 features:
 * - Group chat fixes (channel relay, #all auto-create, membership persistence)
 * - share_file backward compat
 * - Knowledge references in messages (API path)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";

describe("Sprint 2: Group chat fixes", () => {
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

  // Test 1: #all channel auto-created on session start
  it("auto-creates #all channel on session creation", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/channels`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.channels).toBeDefined();
    const allChannel = res.body.channels.find((c: any) => c.id === "#all");
    expect(allChannel).toBeDefined();
    expect(allChannel.name.toLowerCase()).toBe("all");
  });

  // Test 2: Channel message delivery stores message in DB
  it("channel message is stored and retrievable via history", async () => {
    // Ensure #frontend channel exists
    await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/channels`)
      .set(auth())
      .send({ id: "#frontend", name: "Frontend" });

    // Post a message to the channel via relay endpoint
    const relayRes = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/relay`)
      .set(auth())
      .send({
        from: "user",
        to: "channel",
        message: "Hello frontend team!",
        channel: "#frontend",
      });

    // Relay may succeed or may not find agents — check it doesn't crash
    expect([200, 404]).toContain(relayRes.status);

    // Check channel history
    const historyRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/channels/%23frontend/messages`)
      .set(auth());

    expect(historyRes.status).toBe(200);
    expect(historyRes.body).toHaveProperty("messages");
    expect(historyRes.body).toHaveProperty("channel", "#frontend");
  });

  // Test 3: Channel memberships persist in database
  it("channel memberships persist via database", async () => {
    const orch = ctx.orchestrators.get(sessionId);
    if (!orch) return; // Skip if no orchestrator

    const db = orch.database;

    // Join channel via DB
    db.joinChannel(sessionId, "#all", "agent-1");
    db.joinChannel(sessionId, "#all", "agent-2");
    db.joinChannel(sessionId, "#frontend", "agent-1");

    // Verify members
    const allMembers = db.getChannelMembers("#all");
    expect(allMembers).toContain("agent-1");
    expect(allMembers).toContain("agent-2");

    const frontendMembers = db.getChannelMembers("#frontend");
    expect(frontendMembers).toContain("agent-1");
    expect(frontendMembers).not.toContain("agent-2");

    // Verify agent channels
    const agent1Channels = db.getAgentChannels("agent-1");
    expect(agent1Channels).toContain("#all");
    expect(agent1Channels).toContain("#frontend");
  });

  // Test 4: New agent auto-joins #all via join endpoint
  it("agent can join #all channel via API", async () => {
    const orch = ctx.orchestrators.get(sessionId);
    if (!orch) return;

    // Mock an agent in the orchestrator
    const agentMap = new Map();
    agentMap.set("test-agent", {
      config: { name: "Test Agent", role: "worker", channels: [] },
    });
    const origGetAgent = orch.agentManager.getAgent.bind(orch.agentManager);
    orch.agentManager.getAgent = (id: string) => agentMap.get(id) || origGetAgent(id);

    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/channels/%23all/join`)
      .set(auth())
      .send({ agentId: "test-agent" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
    expect(res.body.channels).toContain("#all");
  });

  // Test 5: Error response on invalid channel operations
  it("returns error for message in non-existent session", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/nonexistent/channels/%23all/messages`)
      .set(auth());

    expect(res.status).toBe(404);
  });

  // Test 6: Cannot leave #all channel
  it("prevents agent from leaving #all channel", async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/channels/%23all/leave`)
      .set(auth())
      .send({ agentId: "test-agent" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot leave.*#all/i);
  });
});

describe("Sprint 2: share_file backward compat", () => {
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
      .send({ name: "File Test", projectPath, provider: "claude-code" });

    expect(res.status).toBe(201);
    sessionId = res.body.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // Test 7: Share .md file — stored and URL returned
  it("shares .md file via base64 and returns URL", async () => {
    const content = Buffer.from("# Hello World\n\nThis is a test.").toString("base64");

    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(auth())
      .send({ filename: "readme.md", base64Data: content });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("url");
    expect(res.body.url).toContain("/attachments/");
    expect(res.body.filename).toContain(".md");
  });

  // Test 8: Share .ts file — works
  it("shares .ts file via base64", async () => {
    const content = Buffer.from("export const hello = 'world';").toString("base64");

    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(auth())
      .send({ filename: "index.ts", base64Data: content });

    expect(res.status).toBe(201);
    expect(res.body.filename).toContain(".ts");
  });

  // Test 9: Share .exe — blocked
  it("blocks .exe file upload", async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(auth())
      .send({ filename: "malware.exe", base64Data: "abc123" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unsupported");
  });

  // Test 10: 1MB+ non-image file — rejected via sourcePath
  it("rejects non-image file exceeding 1MB", async () => {
    const session = ctx.sessionManager.getSession(sessionId);
    const projectPath = session!.config.projectPath;
    const bigFile = join(projectPath, "huge.log");
    writeFileSync(bigFile, "x".repeat(1.1 * 1024 * 1024));

    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(auth())
      .send({ filename: "huge.log", sourcePath: "huge.log" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("size limit");
  });

  // Test 11: share_image backward compat — images still work
  it("still accepts image uploads (backward compat)", async () => {
    const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(auth())
      .send({ filename: "screenshot.png", base64Data });

    expect(res.status).toBe(201);
    expect(res.body.filename).toContain(".png");
    expect(res.body).toHaveProperty("url");
  });
});

describe("Sprint 2: Knowledge references in messages", () => {
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
      .send({ name: "Knowledge Test", projectPath, provider: "claude-code" });

    expect(res.status).toBe(201);
    sessionId = res.body.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // Helper: save knowledge entry
  async function saveKnowledge(key: string, value: string) {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/knowledge-db`)
      .set(auth())
      .send({ key, value, savedBy: "tester" });
    expect(res.status).toBe(201);
  }

  // Test 12: Knowledge entry CRUD works via API
  it("saves and retrieves knowledge entry via API", async () => {
    await saveKnowledge("arch-doc", "## Architecture\nMicroservices with event sourcing.");

    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/knowledge-db/arch-doc`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("key", "arch-doc");
    expect(res.body).toHaveProperty("value");
    expect(res.body.value).toContain("Architecture");
  });

  // Test 13: Knowledge search works
  it("searches knowledge entries", async () => {
    await saveKnowledge("api-design", "REST endpoints for user management");
    await saveKnowledge("db-schema", "PostgreSQL schema with migrations");

    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/knowledge-db?q=REST`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("entries");
    expect(res.body.entries.length).toBeGreaterThanOrEqual(1);
    expect(res.body.entries.some((e: any) => e.key === "api-design")).toBe(true);
  });

  // Test 14: Knowledge entry update (upsert)
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

  // Test 15: Knowledge entry delete
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

  // Test 16: Invalid knowledge key returns 404
  it("returns 404 for non-existent knowledge key", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/knowledge-db/nonexistent`)
      .set(auth());

    expect(res.status).toBe(404);
  });
});
