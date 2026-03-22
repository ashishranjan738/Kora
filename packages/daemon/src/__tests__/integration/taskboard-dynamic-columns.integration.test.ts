/**
 * Integration tests for TaskBoard dynamic workflow columns (task 3d6c3002).
 *
 * Validates that the task API correctly handles dynamic workflow states:
 * - Default 4-column board backward compatibility (TC-1)
 * - Full Pipeline 6-column workflow (TC-2)
 * - Custom states visibility — tasks in e2e-testing, staging (TC-3)
 * - Drag-and-drop transition validation — valid/invalid transitions (TC-4)
 * - Task counts per dynamic status for session reports (TC-5)
 * - Category-based grouping — not-started, active, closed (TC-6)
 * - Simple 3-column template (TC-8)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync } from "fs";
import { PIPELINE_TEMPLATES, type WorkflowState } from "@kora/shared";

describe("TaskBoard dynamic workflow columns (E2E)", () => {
  let ctx: TestContext;

  const auth = () => ({ Authorization: `Bearer ${ctx.token}` });

  beforeEach(async () => {
    ctx = setupTestApp();
    await ctx.sessionManager.load();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // ─── Helpers ────────────────────────────────────────────

  async function createSessionWithWorkflow(name: string, workflowStates?: WorkflowState[]) {
    const projectPath = join(ctx.testDir, `project-${Date.now()}`);
    mkdirSync(projectPath, { recursive: true });

    const body: Record<string, any> = { name, projectPath, provider: "claude-code" };
    if (workflowStates) {
      body.workflowStates = workflowStates;
    }

    return request(ctx.app)
      .post("/api/v1/sessions")
      .set(auth())
      .send(body);
  }

  async function createTask(sessionId: string, title: string, extra: Record<string, any> = {}) {
    return request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/tasks`)
      .set(auth())
      .send({ sessionId, title, ...extra });
  }

  async function updateTaskStatus(sessionId: string, taskId: string, status: string) {
    return request(ctx.app)
      .put(`/api/v1/sessions/${sessionId}/tasks/${taskId}`)
      .set(auth())
      .send({ status });
  }

  async function getTasks(sessionId: string, query = "") {
    return request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/tasks${query}`)
      .set(auth());
  }

  // ─── TC-1: Default 4-column board (backward compat) ─────

  describe("TC-1: Default 4-column board (backward compatibility)", () => {
    let sessionId: string;

    beforeEach(async () => {
      const res = await createSessionWithWorkflow("Default Session");
      expect(res.status).toBe(201);
      sessionId = res.body.id;
    });

    it("creates tasks with default pending status", async () => {
      const task = await createTask(sessionId, "Default Task");
      expect(task.status).toBe(201);
      expect(task.body.status).toBe("pending");
    });

    it("moves task through all 4 default statuses", async () => {
      const task = await createTask(sessionId, "Flow Task");
      const taskId = task.body.id;

      let res = await updateTaskStatus(sessionId, taskId, "in-progress");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("in-progress");

      res = await updateTaskStatus(sessionId, taskId, "review");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("review");

      res = await updateTaskStatus(sessionId, taskId, "done");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("done");
    });

    it("lists all tasks across default statuses", async () => {
      await createTask(sessionId, "Task A");
      const taskB = await createTask(sessionId, "Task B");
      await updateTaskStatus(sessionId, taskB.body.id, "in-progress");
      const taskC = await createTask(sessionId, "Task C");
      await updateTaskStatus(sessionId, taskC.body.id, "done");

      const res = await getTasks(sessionId);
      expect(res.status).toBe(200);
      expect(res.body.tasks).toHaveLength(3);
    });
  });

  // ─── TC-2: Full Pipeline (6 columns) ───────────────────

  describe("TC-2: Full Pipeline (6 columns)", () => {
    let sessionId: string;
    const fullPipeline = PIPELINE_TEMPLATES.find(t => t.id === "full")!;

    beforeEach(async () => {
      const res = await createSessionWithWorkflow("Full Pipeline Session", fullPipeline.states);
      expect(res.status).toBe(201);
      sessionId = res.body.id;
    });

    it("session stores 6 workflow states", async () => {
      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}`)
        .set(auth());

      expect(res.status).toBe(200);
      const states = res.body.config?.workflowStates || res.body.workflowStates;
      expect(states).toHaveLength(6);

      const ids = states.map((s: any) => s.id);
      expect(ids).toEqual(["backlog", "in-progress", "review", "e2e-testing", "staging", "done"]);
    });

    it("moves task through full 6-stage pipeline", async () => {
      const task = await createTask(sessionId, "Full Flow Task", { status: "backlog" });
      const taskId = task.body.id;

      for (const nextStatus of ["in-progress", "review", "e2e-testing", "staging", "done"]) {
        const res = await updateTaskStatus(sessionId, taskId, nextStatus);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe(nextStatus);
      }
    });

    it("task is visible in e2e-testing column after update", async () => {
      const task = await createTask(sessionId, "Column Check", { status: "backlog" });
      await updateTaskStatus(sessionId, task.body.id, "in-progress");
      await updateTaskStatus(sessionId, task.body.id, "review");
      await updateTaskStatus(sessionId, task.body.id, "e2e-testing");

      const res = await getTasks(sessionId, "?status=e2e-testing");
      expect(res.status).toBe(200);
      expect(res.body.tasks).toHaveLength(1);
      expect(res.body.tasks[0].status).toBe("e2e-testing");
    });
  });

  // ─── TC-3: Custom states visibility ─────────────────────

  describe("TC-3: Custom states visibility", () => {
    let sessionId: string;
    const fullPipeline = PIPELINE_TEMPLATES.find(t => t.id === "full")!;

    beforeEach(async () => {
      const res = await createSessionWithWorkflow("Visibility Session", fullPipeline.states);
      sessionId = res.body.id;
    });

    it("task in e2e-testing is visible when filtered", async () => {
      const task = await createTask(sessionId, "E2E Task", { status: "backlog" });
      await updateTaskStatus(sessionId, task.body.id, "in-progress");
      await updateTaskStatus(sessionId, task.body.id, "review");
      await updateTaskStatus(sessionId, task.body.id, "e2e-testing");

      const res = await getTasks(sessionId, "?status=e2e-testing");
      expect(res.body.tasks).toHaveLength(1);
      expect(res.body.tasks[0].title).toBe("E2E Task");
    });

    it("task in staging is visible when filtered", async () => {
      const task = await createTask(sessionId, "Staging Task", { status: "backlog" });
      await updateTaskStatus(sessionId, task.body.id, "in-progress");
      await updateTaskStatus(sessionId, task.body.id, "review");
      await updateTaskStatus(sessionId, task.body.id, "e2e-testing");
      await updateTaskStatus(sessionId, task.body.id, "staging");

      const res = await getTasks(sessionId, "?status=staging");
      expect(res.body.tasks).toHaveLength(1);
      expect(res.body.tasks[0].title).toBe("Staging Task");
    });

    it("no tasks are invisible — one task per column, all visible", async () => {
      const statuses = ["backlog", "in-progress", "review", "e2e-testing", "staging", "done"];
      const tasks = [];
      for (let i = 0; i < 6; i++) {
        const t = await createTask(sessionId, `Task-${statuses[i]}`, { status: "backlog" });
        tasks.push(t.body);
      }

      // Move each to target
      await updateTaskStatus(sessionId, tasks[1].id, "in-progress");
      await updateTaskStatus(sessionId, tasks[2].id, "in-progress");
      await updateTaskStatus(sessionId, tasks[2].id, "review");
      await updateTaskStatus(sessionId, tasks[3].id, "in-progress");
      await updateTaskStatus(sessionId, tasks[3].id, "review");
      await updateTaskStatus(sessionId, tasks[3].id, "e2e-testing");
      await updateTaskStatus(sessionId, tasks[4].id, "in-progress");
      await updateTaskStatus(sessionId, tasks[4].id, "review");
      await updateTaskStatus(sessionId, tasks[4].id, "e2e-testing");
      await updateTaskStatus(sessionId, tasks[4].id, "staging");
      await updateTaskStatus(sessionId, tasks[5].id, "in-progress");
      await updateTaskStatus(sessionId, tasks[5].id, "review");
      await updateTaskStatus(sessionId, tasks[5].id, "e2e-testing");
      await updateTaskStatus(sessionId, tasks[5].id, "staging");
      await updateTaskStatus(sessionId, tasks[5].id, "done");

      // All 6 visible
      const all = await getTasks(sessionId);
      expect(all.body.tasks).toHaveLength(6);

      // Each status has exactly 1
      for (const s of statuses) {
        const filtered = await getTasks(sessionId, `?status=${s}`);
        expect(filtered.body.tasks).toHaveLength(1);
      }
    });
  });

  // ─── TC-4: Transition validation ────────────────────────

  describe("TC-4: Transition validation", () => {
    let sessionId: string;
    const fullPipeline = PIPELINE_TEMPLATES.find(t => t.id === "full")!;

    beforeEach(async () => {
      const res = await createSessionWithWorkflow("Transition Session", fullPipeline.states);
      sessionId = res.body.id;
    });

    it("rejects backlog -> done (skip required states)", async () => {
      const task = await createTask(sessionId, "Skip Task", { status: "backlog" });
      const res = await updateTaskStatus(sessionId, task.body.id, "done");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid transition/i);
    });

    it("rejects backlog -> review", async () => {
      const task = await createTask(sessionId, "Skip Task 2", { status: "backlog" });
      const res = await updateTaskStatus(sessionId, task.body.id, "review");
      expect(res.status).toBe(400);
    });

    it("accepts backlog -> in-progress", async () => {
      const task = await createTask(sessionId, "Valid Task", { status: "backlog" });
      const res = await updateTaskStatus(sessionId, task.body.id, "in-progress");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("in-progress");
    });

    it("allows skipping skippable states (review -> done)", async () => {
      const task = await createTask(sessionId, "Skippable", { status: "backlog" });
      await updateTaskStatus(sessionId, task.body.id, "in-progress");
      await updateTaskStatus(sessionId, task.body.id, "review");

      const res = await updateTaskStatus(sessionId, task.body.id, "done");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("done");
    });

    it("rejects invalid status not in workflow", async () => {
      const task = await createTask(sessionId, "Bad Status", { status: "backlog" });
      const res = await updateTaskStatus(sessionId, task.body.id, "nonexistent");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/status must be one of/i);
    });

    it("error message includes valid next states", async () => {
      const task = await createTask(sessionId, "Error Info", { status: "backlog" });
      const res = await updateTaskStatus(sessionId, task.body.id, "done");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("in-progress");
    });
  });

  // ─── TC-5: Dynamic status counts ────────────────────────

  describe("TC-5: Dynamic status counts for reports", () => {
    let sessionId: string;
    const fullPipeline = PIPELINE_TEMPLATES.find(t => t.id === "full")!;

    beforeEach(async () => {
      const res = await createSessionWithWorkflow("Report Session", fullPipeline.states);
      sessionId = res.body.id;
    });

    it("task counts include e2e-testing and staging", async () => {
      const t1 = await createTask(sessionId, "Backlog", { status: "backlog" });
      const t2 = await createTask(sessionId, "E2E", { status: "backlog" });
      const t3 = await createTask(sessionId, "Staging", { status: "backlog" });

      await updateTaskStatus(sessionId, t2.body.id, "in-progress");
      await updateTaskStatus(sessionId, t2.body.id, "review");
      await updateTaskStatus(sessionId, t2.body.id, "e2e-testing");

      await updateTaskStatus(sessionId, t3.body.id, "in-progress");
      await updateTaskStatus(sessionId, t3.body.id, "review");
      await updateTaskStatus(sessionId, t3.body.id, "e2e-testing");
      await updateTaskStatus(sessionId, t3.body.id, "staging");

      expect((await getTasks(sessionId, "?status=backlog")).body.tasks).toHaveLength(1);
      expect((await getTasks(sessionId, "?status=e2e-testing")).body.tasks).toHaveLength(1);
      expect((await getTasks(sessionId, "?status=staging")).body.tasks).toHaveLength(1);
      expect((await getTasks(sessionId)).body.tasks).toHaveLength(3);
    });

    it("sum of per-status counts equals total", async () => {
      const t1 = await createTask(sessionId, "T1", { status: "backlog" });
      const t2 = await createTask(sessionId, "T2", { status: "backlog" });
      const t3 = await createTask(sessionId, "T3", { status: "backlog" });

      await updateTaskStatus(sessionId, t1.body.id, "in-progress");
      await updateTaskStatus(sessionId, t1.body.id, "review");
      await updateTaskStatus(sessionId, t1.body.id, "e2e-testing");

      await updateTaskStatus(sessionId, t2.body.id, "in-progress");
      await updateTaskStatus(sessionId, t2.body.id, "review");
      await updateTaskStatus(sessionId, t2.body.id, "e2e-testing");
      await updateTaskStatus(sessionId, t2.body.id, "staging");

      let total = 0;
      for (const s of ["backlog", "in-progress", "review", "e2e-testing", "staging", "done"]) {
        total += (await getTasks(sessionId, `?status=${s}`)).body.tasks.length;
      }
      expect(total).toBe(3);
    });
  });

  // ─── TC-8: Simple template (3 columns) ──────────────────

  describe("TC-8: Simple template (3 columns)", () => {
    let sessionId: string;
    const simpleTemplate = PIPELINE_TEMPLATES.find(t => t.id === "simple")!;

    beforeEach(async () => {
      const res = await createSessionWithWorkflow("Simple Session", simpleTemplate.states);
      expect(res.status).toBe(201);
      sessionId = res.body.id;
    });

    it("session has 3 workflow states", async () => {
      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}`)
        .set(auth());

      const states = res.body.config?.workflowStates || res.body.workflowStates;
      expect(states).toHaveLength(3);
      expect(states.map((s: any) => s.id)).toEqual(["todo", "in-progress", "done"]);
    });

    it("moves task through all 3 simple states", async () => {
      const task = await createTask(sessionId, "Simple Task", { status: "todo" });

      let res = await updateTaskStatus(sessionId, task.body.id, "in-progress");
      expect(res.status).toBe(200);

      res = await updateTaskStatus(sessionId, task.body.id, "done");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("done");
    });

    it("rejects statuses not in simple template", async () => {
      const task = await createTask(sessionId, "Invalid", { status: "todo" });
      const res = await updateTaskStatus(sessionId, task.body.id, "review");
      expect(res.status).toBe(400);
    });
  });
});
