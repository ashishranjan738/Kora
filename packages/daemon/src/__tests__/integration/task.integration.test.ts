/**
 * Integration tests for task CRUD operations and filtering.
 * Tests task creation, updates, listing with filters, get, and deletion.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync } from "fs";

describe("Task CRUD integration", () => {
  let ctx: TestContext;
  let sessionId: string;

  beforeEach(async () => {
    ctx = setupTestApp();
    await ctx.sessionManager.load();

    // Create a test session
    const projectPath = join(ctx.testDir, "test-project");
    mkdirSync(projectPath, { recursive: true });

    const res = await request(ctx.app)
      .post("/api/v1/sessions")
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({ name: "Test", projectPath, provider: "claude-code" });

    sessionId = res.body.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  describe("POST /api/v1/tasks", () => {
    it("creates a task with all fields", async () => {
      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/tasks`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          sessionId,
          title: "Test Task",
          description: "Test description",
          priority: "P1",
          labels: ["bug", "frontend"],
          dueDate: "2026-12-31",
          assignedTo: "agent-1",
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body).toHaveProperty("title", "Test Task");
      expect(res.body).toHaveProperty("description", "Test description");
      expect(res.body).toHaveProperty("priority", "P1");
      expect(res.body).toHaveProperty("labels");
      expect(res.body.labels).toEqual(["bug", "frontend"]);
      expect(res.body).toHaveProperty("dueDate", "2026-12-31");
      expect(res.body).toHaveProperty("assignedTo", "agent-1");
      expect(res.body).toHaveProperty("status", "pending");
    });

    it("creates task with minimal fields", async () => {
      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/tasks`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          sessionId,
          title: "Minimal Task",
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("title", "Minimal Task");
      expect(res.body).toHaveProperty("priority", "P2"); // default
      expect(res.body).toHaveProperty("labels");
      expect(res.body.labels).toEqual([]);
    });

    it("rejects task without title", async () => {
      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/tasks`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ sessionId });

      expect(res.status).toBe(400);
    });
  });

  describe("PUT /api/v1/tasks/:id", () => {
    let taskId: string;

    beforeEach(async () => {
      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/tasks`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          sessionId,
          title: "Original",
          priority: "P2",
        });
      taskId = res.body.id;
    });

    it("updates task title and description", async () => {
      const res = await request(ctx.app)
        .put(`/api/v1/sessions/${sessionId}/tasks/${taskId}`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          title: "Updated Title",
          description: "Updated description",
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("title", "Updated Title");
      expect(res.body).toHaveProperty("description", "Updated description");
    });

    it("updates task status", async () => {
      const res = await request(ctx.app)
        .put(`/api/v1/sessions/${sessionId}/tasks/${taskId}`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ status: "in-progress" });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status", "in-progress");
    });

    it("updates task priority", async () => {
      const res = await request(ctx.app)
        .put(`/api/v1/sessions/${sessionId}/tasks/${taskId}`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ priority: "P0" });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("priority", "P0");
    });

    it("updates task labels", async () => {
      const res = await request(ctx.app)
        .put(`/api/v1/sessions/${sessionId}/tasks/${taskId}`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ labels: ["urgent", "backend"] });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("labels");
      expect(res.body.labels).toEqual(["urgent", "backend"]);
    });

    it("updates task due date", async () => {
      const res = await request(ctx.app)
        .put(`/api/v1/sessions/${sessionId}/tasks/${taskId}`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ dueDate: "2026-06-15" });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("dueDate", "2026-06-15");
    });

    it("updates assignedTo", async () => {
      const res = await request(ctx.app)
        .put(`/api/v1/sessions/${sessionId}/tasks/${taskId}`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ assignedTo: "agent-2" });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("assignedTo", "agent-2");
    });
  });

  describe("GET /api/v1/tasks filtering", () => {
    beforeEach(async () => {
      // Create test tasks (all start as "pending")
      const task1Res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/tasks`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          sessionId,
          title: "Bug fix",
          priority: "P0",
          labels: ["bug", "frontend"],
          assignedTo: "agent-1",
          dueDate: "2026-06-01",
        });
      // Keep task1 as "pending"

      const task2Res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/tasks`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          sessionId,
          title: "Feature request",
          priority: "P2",
          labels: ["feature", "backend"],
          assignedTo: "agent-2",
          dueDate: "2026-12-31",
        });
      // Update task2 to "in-progress"
      await request(ctx.app)
        .put(`/api/v1/sessions/${sessionId}/tasks/${task2Res.body.id}`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ status: "in-progress" });

      const task3Res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/tasks`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          sessionId,
          title: "Documentation",
          priority: "P3",
          labels: ["docs"],
        });
      // Update task3 to "done"
      await request(ctx.app)
        .put(`/api/v1/sessions/${sessionId}/tasks/${task3Res.body.id}`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ status: "done" });
    });

    it("lists all tasks without filters", async () => {
      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/tasks`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body.tasks).toHaveLength(3);
    });

    it("filters by status", async () => {
      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/tasks?status=pending`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body.tasks).toHaveLength(1);
      expect(res.body.tasks[0]).toHaveProperty("title", "Bug fix");
    });

    it("filters by assignedTo", async () => {
      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/tasks?assignedTo=agent-1`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body.tasks).toHaveLength(1);
      expect(res.body.tasks[0]).toHaveProperty("assignedTo", "agent-1");
    });

    it("filters by label", async () => {
      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/tasks?label=bug`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body.tasks).toHaveLength(1);
      expect(res.body.tasks[0].labels).toContain("bug");
    });

    it.skip("filters by due date (before)", async () => {
      // TODO: API doesn't support dueBefore/dueAfter yet, only due=overdue
      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/tasks?dueBefore=2026-07-01`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body.tasks).toHaveLength(1);
      expect(res.body.tasks[0]).toHaveProperty("dueDate", "2026-06-01");
    });

    it.skip("filters by due date (after)", async () => {
      // TODO: API doesn't support dueBefore/dueAfter yet, only due=overdue
      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/tasks?dueAfter=2026-07-01`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body.tasks).toHaveLength(1);
      expect(res.body.tasks[0]).toHaveProperty("dueDate", "2026-12-31");
    });

    it("sorts by priority", async () => {
      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/tasks?sortBy=priority`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body.tasks[0]).toHaveProperty("priority", "P0");
      expect(res.body.tasks[2]).toHaveProperty("priority", "P3");
    });

    it("returns summary mode (title + id only)", async () => {
      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/tasks?summary=true`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body.tasks[0]).toHaveProperty("id");
      expect(res.body.tasks[0]).toHaveProperty("title");
      expect(res.body.tasks[0]).not.toHaveProperty("description");
    });
  });

  describe("GET /api/v1/tasks/:id", () => {
    it("returns task by ID", async () => {
      const createRes = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/tasks`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          sessionId,
          title: "Get me",
        });

      const taskId = createRes.body.id;

      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/tasks/${taskId}`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id", taskId);
      expect(res.body).toHaveProperty("title", "Get me");
    });

    it("returns 404 for non-existent task", async () => {
      const res = await request(ctx.app)
        .get("/api/v1/tasks/nonexistent")
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/v1/tasks/:id", () => {
    it("deletes a task", async () => {
      const createRes = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/tasks`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          sessionId,
          title: "Delete me",
        });

      const taskId = createRes.body.id;

      const deleteRes = await request(ctx.app)
        .delete(`/api/v1/sessions/${sessionId}/tasks/${taskId}`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body).toHaveProperty("deleted", true);

      // Verify it's gone
      const getRes = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/tasks/${taskId}`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(getRes.status).toBe(404);
    });
  });
});
