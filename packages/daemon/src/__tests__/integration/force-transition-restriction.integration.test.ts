/**
 * Integration tests for force-transition restriction (REST API path).
 *
 * Covers all 8 required test cases:
 * 1. Default (flag off): worker force → rejected
 * 2. Default (flag off): master force → rejected
 * 3. Default (flag off): human force → allowed
 * 4. Flag on: worker force → rejected (workers can NEVER force)
 * 5. Flag on: master force → allowed
 * 6. Flag on: human force → allowed
 * 7. Session without flag (backwards compat) → default off
 * 8. Toggle mid-session → takes effect immediately
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync } from "fs";

describe("Force-transition restriction (REST API)", () => {
  let ctx: TestContext;

  /** Inject mock agents into an existing orchestrator's agentManager */
  function injectAgents(sid: string, agents: Array<{ id: string; role: string }>) {
    const orch = ctx.orchestrators.get(sid);
    if (!orch) throw new Error(`No orchestrator for session ${sid}`);
    // Patch getAgent to return mock agent configs
    const agentMap = new Map<string, { config: { role: string } }>();
    for (const a of agents) {
      agentMap.set(a.id, { config: { role: a.role } });
    }
    const origGetAgent = orch.agentManager.getAgent.bind(orch.agentManager);
    orch.agentManager.getAgent = (id: string) => agentMap.get(id) || origGetAgent(id);
  }

  async function createSessionWithFlag(allowMasterForceTransition?: boolean) {
    const projectPath = join(ctx.testDir, `test-project-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(projectPath, { recursive: true });

    const body: Record<string, unknown> = {
      name: "Test",
      projectPath,
      provider: "claude-code",
    };
    if (allowMasterForceTransition !== undefined) {
      body.allowMasterForceTransition = allowMasterForceTransition;
    }

    const res = await request(ctx.app)
      .post("/api/v1/sessions")
      .set("Authorization", `Bearer ${ctx.token}`)
      .send(body);

    expect(res.status).toBe(201);
    const sid = res.body.id as string;

    // Inject mock agents
    injectAgents(sid, [
      { id: "worker-agent", role: "worker" },
      { id: "master-agent", role: "master" },
    ]);

    return sid;
  }

  async function createTask(sid: string) {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sid}/tasks`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({ sessionId: sid, title: "Test task" });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function forceTransition(
    sid: string,
    tid: string,
    status: string,
    headers?: Record<string, string>,
  ) {
    let req = request(ctx.app)
      .put(`/api/v1/sessions/${sid}/tasks/${tid}`)
      .set("Authorization", `Bearer ${ctx.token}`);
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        req = req.set(k, v);
      }
    }
    return req.send({ status, force: true });
  }

  beforeEach(async () => {
    ctx = setupTestApp();
    await ctx.sessionManager.load();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  const EXPECTED_ERROR =
    "Force transitions are restricted to humans. Enable 'Allow master force transitions' in session settings to permit master agents.";

  // Test 1: Default (flag off): worker force → rejected
  it("rejects force from worker agent when flag is off (default)", async () => {
    const sid = await createSessionWithFlag();
    const tid = await createTask(sid);

    const res = await forceTransition(sid, tid, "done", {
      "X-Agent-Id": "worker-agent",
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(EXPECTED_ERROR);
  });

  // Test 2: Default (flag off): master force → rejected
  it("rejects force from master agent when flag is off (default)", async () => {
    const sid = await createSessionWithFlag();
    const tid = await createTask(sid);

    const res = await forceTransition(sid, tid, "done", {
      "X-Agent-Id": "master-agent",
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(EXPECTED_ERROR);
  });

  // Test 3: Default (flag off): human force → allowed
  it("allows force from human (no X-Agent-Id) when flag is off", async () => {
    const sid = await createSessionWithFlag();
    const tid = await createTask(sid);

    const res = await forceTransition(sid, tid, "done");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });

  // Test 4: Flag on: worker force → rejected (workers can NEVER force)
  it("rejects force from worker agent even when flag is on", async () => {
    const sid = await createSessionWithFlag(true);
    const tid = await createTask(sid);

    const res = await forceTransition(sid, tid, "done", {
      "X-Agent-Id": "worker-agent",
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(EXPECTED_ERROR);
  });

  // Test 5: Flag on: master force → allowed
  it("allows force from master agent when flag is on", async () => {
    const sid = await createSessionWithFlag(true);
    const tid = await createTask(sid);

    const res = await forceTransition(sid, tid, "done", {
      "X-Agent-Id": "master-agent",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });

  // Test 6: Flag on: human force → allowed
  it("allows force from human (no X-Agent-Id) when flag is on", async () => {
    const sid = await createSessionWithFlag(true);
    const tid = await createTask(sid);

    const res = await forceTransition(sid, tid, "done");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });

  // Test 7: Session without flag (backwards compat) → default off
  it("treats missing flag as default off (backwards compat)", async () => {
    const sid = await createSessionWithFlag(); // no argument = no flag
    const tid = await createTask(sid);

    // Master should be rejected (flag defaults to off)
    const masterRes = await forceTransition(sid, tid, "done", {
      "X-Agent-Id": "master-agent",
    });
    expect(masterRes.status).toBe(403);
    expect(masterRes.body.error).toBe(EXPECTED_ERROR);

    // Human should still be allowed
    const humanRes = await forceTransition(sid, tid, "done");
    expect(humanRes.status).toBe(200);
  });

  // Test 8: Toggle mid-session → takes effect immediately
  it("applies flag change immediately when toggled mid-session", async () => {
    const sid = await createSessionWithFlag(false);
    const tid = await createTask(sid);

    // Master force should be rejected (flag off)
    const res1 = await forceTransition(sid, tid, "done", {
      "X-Agent-Id": "master-agent",
    });
    expect(res1.status).toBe(403);

    // Toggle flag on via session update
    const updateRes = await request(ctx.app)
      .put(`/api/v1/sessions/${sid}`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({ allowMasterForceTransition: true });
    expect(updateRes.status).toBe(200);

    // Master force should now be allowed immediately
    const res2 = await forceTransition(sid, tid, "done", {
      "X-Agent-Id": "master-agent",
    });
    expect(res2.status).toBe(200);
    expect(res2.body.status).toBe("done");
  });
});
