/**
 * Integration tests for task dependency API (visual task linking).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync } from "fs";

describe("Task dependencies", () => {
  let ctx: TestContext;
  let sessionId: string;

  const auth = () => ({ Authorization: `Bearer ${ctx.token}` });

  async function createTask(title: string, deps: string[] = []) {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/tasks`)
      .set(auth())
      .send({ sessionId, title, dependencies: deps });
    expect(res.status).toBe(201);
    return res.body;
  }

  beforeEach(async () => {
    ctx = setupTestApp();
    await ctx.sessionManager.load();

    const projectPath = join(ctx.testDir, `test-project-${Date.now()}`);
    mkdirSync(projectPath, { recursive: true });

    const res = await request(ctx.app)
      .post("/api/v1/sessions")
      .set(auth())
      .send({ name: "Link Test", projectPath, provider: "claude-code" });

    expect(res.status).toBe(201);
    sessionId = res.body.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("task created with dependencies stores them", async () => {
    const taskA = await createTask("Task A");
    const taskB = await createTask("Task B", [taskA.id]);

    const getRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/tasks/${taskB.id}`)
      .set(auth());

    expect(getRes.status).toBe(200);
    expect(getRes.body.dependencies).toContain(taskA.id);
  });

  it("task without dependencies has empty array", async () => {
    const task = await createTask("Independent Task");

    const getRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/tasks/${task.id}`)
      .set(auth());

    expect(getRes.status).toBe(200);
    expect(getRes.body.dependencies).toEqual([]);
  });

  it("task list includes dependencies field", async () => {
    const taskA = await createTask("Task A");
    await createTask("Task B", [taskA.id]);

    const listRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/tasks`)
      .set(auth());

    expect(listRes.status).toBe(200);
    const taskB = listRes.body.tasks.find((t: any) => t.title === "Task B");
    expect(taskB).toBeDefined();
    expect(taskB.dependencies).toContain(taskA.id);
  });
});
