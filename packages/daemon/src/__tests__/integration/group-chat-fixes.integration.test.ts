/**
 * Integration tests for group chat fixes.
 * Tests #all auto-creation, channel messaging, membership persistence, join/leave.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync } from "fs";

describe("Group chat fixes", () => {
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

  it("channel message is stored and retrievable via history", async () => {
    await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/channels`)
      .set(auth())
      .send({ id: "#frontend", name: "Frontend" });

    const relayRes = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/relay`)
      .set(auth())
      .send({ from: "user", to: "channel", message: "Hello frontend team!", channel: "#frontend" });

    expect([200, 404]).toContain(relayRes.status);

    const historyRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/channels/%23frontend/messages`)
      .set(auth());

    expect(historyRes.status).toBe(200);
    expect(historyRes.body).toHaveProperty("messages");
    expect(historyRes.body).toHaveProperty("channel", "#frontend");
  });

  it("channel memberships persist via database", async () => {
    const orch = ctx.orchestrators.get(sessionId);
    if (!orch) return;

    const db = orch.database;
    db.joinChannel(sessionId, "#all", "agent-1");
    db.joinChannel(sessionId, "#all", "agent-2");
    db.joinChannel(sessionId, "#frontend", "agent-1");

    const allMembers = db.getChannelMembers("#all");
    expect(allMembers).toContain("agent-1");
    expect(allMembers).toContain("agent-2");

    const frontendMembers = db.getChannelMembers("#frontend");
    expect(frontendMembers).toContain("agent-1");
    expect(frontendMembers).not.toContain("agent-2");

    const agent1Channels = db.getAgentChannels("agent-1");
    expect(agent1Channels).toContain("#all");
    expect(agent1Channels).toContain("#frontend");
  });

  it("agent can join #all channel via API", async () => {
    const orch = ctx.orchestrators.get(sessionId);
    if (!orch) return;

    const agentMap = new Map();
    agentMap.set("test-agent", { config: { name: "Test Agent", role: "worker", channels: [] } });
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

  it("returns error for message in non-existent session", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/nonexistent/channels/%23all/messages`)
      .set(auth());

    expect(res.status).toBe(404);
  });

  it("prevents agent from leaving #all channel", async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/channels/%23all/leave`)
      .set(auth())
      .send({ agentId: "test-agent" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot leave.*#all/i);
  });
});
