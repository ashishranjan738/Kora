/**
 * Integration tests for idle detection API endpoints:
 * POST /sessions/:sid/agents/:aid/report-idle
 * POST /sessions/:sid/agents/:aid/request-task
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Application } from "express";
import { setupTestApp } from "./test-setup.js";

describe("Idle Detection API", () => {
  let app: Application;
  let token: string;
  let cleanup: () => void;
  let sessionId: string;
  let agentId: string;

  beforeAll(async () => {
    const setup = await setupTestApp();
    app = setup.app;
    token = setup.token;
    cleanup = setup.cleanup;

    // Create a session
    const sessionRes = await request(app)
      .post("/api/v1/sessions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Idle Test Session",
        projectPath: "/tmp/idle-test",
        defaultProvider: "test-provider",
      });
    sessionId = sessionRes.body.id;

    // Spawn an agent
    const agentRes = await request(app)
      .post(`/api/v1/sessions/${sessionId}/agents`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Test Worker",
        role: "worker",
        model: "test-model",
      });
    agentId = agentRes.body.id;
  });

  afterAll(() => {
    cleanup();
  });

  describe("POST /sessions/:sid/agents/:aid/report-idle", () => {
    it("marks agent as idle with default reason", async () => {
      const res = await request(app)
        .post(`/api/v1/sessions/${sessionId}/agents/${agentId}/report-idle`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.activity).toBe("idle");
      expect(res.body.reason).toBe("task completed");

      // Verify agent state updated
      const agentRes = await request(app)
        .get(`/api/v1/sessions/${sessionId}/agents/${agentId}`)
        .set("Authorization", `Bearer ${token}`);

      expect(agentRes.body.activity).toBe("idle");
      expect(agentRes.body.idleSince).toBeDefined();
    });

    it("accepts custom idle reason", async () => {
      const res = await request(app)
        .post(`/api/v1/sessions/${sessionId}/agents/${agentId}/report-idle`)
        .set("Authorization", `Bearer ${token}`)
        .send({ reason: "waiting for code review" });

      expect(res.status).toBe(200);
      expect(res.body.reason).toBe("waiting for code review");
    });

    it("returns 404 for non-existent session", async () => {
      const res = await request(app)
        .post(`/api/v1/sessions/fake-session/agents/${agentId}/report-idle`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Session");
    });

    it("returns 404 for non-existent agent", async () => {
      const res = await request(app)
        .post(`/api/v1/sessions/${sessionId}/agents/fake-agent/report-idle`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Agent");
    });
  });

  describe("POST /sessions/:sid/agents/:aid/request-task", () => {
    beforeAll(async () => {
      // Create test tasks
      await request(app)
        .post(`/api/v1/sessions/${sessionId}/tasks`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "High priority frontend task",
          description: "Fix navbar CSS",
          priority: "P1",
          labels: ["frontend", "css", "bug"],
        });

      await request(app)
        .post(`/api/v1/sessions/${sessionId}/tasks`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "Backend API task",
          description: "Add new endpoint",
          priority: "P2",
          labels: ["backend", "api"],
        });

      await request(app)
        .post(`/api/v1/sessions/${sessionId}/tasks`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "Low priority docs",
          description: "Update README",
          priority: "P3",
          labels: ["docs"],
        });
    });

    it("assigns best matching task based on skills", async () => {
      const res = await request(app)
        .post(`/api/v1/sessions/${sessionId}/agents/${agentId}/request-task`)
        .set("Authorization", `Bearer ${token}`)
        .send({ skills: ["frontend", "css"] });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.task).toBeDefined();
      expect(res.body.task.title).toContain("frontend");
      expect(res.body.task.assignedTo).toBe(agentId);
      expect(res.body.task.status).toBe("assigned");

      // Verify agent is no longer idle
      const agentRes = await request(app)
        .get(`/api/v1/sessions/${sessionId}/agents/${agentId}`)
        .set("Authorization", `Bearer ${token}`);

      expect(agentRes.body.activity).toBe("working");
      expect(agentRes.body.idleSince).toBeUndefined();
    });

    it("respects priority preference", async () => {
      // First mark agent as idle again
      await request(app)
        .post(`/api/v1/sessions/${sessionId}/agents/${agentId}/report-idle`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      const res = await request(app)
        .post(`/api/v1/sessions/${sessionId}/agents/${agentId}/request-task`)
        .set("Authorization", `Bearer ${token}`)
        .send({ priority: "P2" });

      expect(res.status).toBe(200);
      expect(res.body.task.priority).toBe("P2");
    });

    it("assigns highest priority task when no skills match", async () => {
      // Mark agent idle
      await request(app)
        .post(`/api/v1/sessions/${sessionId}/agents/${agentId}/report-idle`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      const res = await request(app)
        .post(`/api/v1/sessions/${sessionId}/agents/${agentId}/request-task`)
        .set("Authorization", `Bearer ${token}`)
        .send({ skills: ["python", "ml"] }); // No matching labels

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.task).toBeDefined();
      // Should get highest priority available task
    });

    it("returns no task when all tasks are assigned", async () => {
      // Mark all tasks as assigned
      const tasksRes = await request(app)
        .get(`/api/v1/sessions/${sessionId}/tasks`)
        .set("Authorization", `Bearer ${token}`);

      for (const task of tasksRes.body.tasks) {
        await request(app)
          .put(`/api/v1/sessions/${sessionId}/tasks/${task.id}`)
          .set("Authorization", `Bearer ${token}`)
          .send({ assignedTo: "other-agent" });
      }

      const res = await request(app)
        .post(`/api/v1/sessions/${sessionId}/agents/${agentId}/request-task`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("No available tasks");
    });

    it("returns 404 for non-existent session", async () => {
      const res = await request(app)
        .post(`/api/v1/sessions/fake-session/agents/${agentId}/request-task`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(404);
    });

    it("returns 404 for non-existent agent", async () => {
      const res = await request(app)
        .post(`/api/v1/sessions/${sessionId}/agents/fake-agent/request-task`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(404);
    });
  });

  describe("Task Matching Algorithm", () => {
    let testSessionId: string;
    let testAgentId: string;

    beforeAll(async () => {
      // Create fresh session for algorithm tests
      const sessionRes = await request(app)
        .post("/api/v1/sessions")
        .set("Authorization", `Bearer ${token}`)
        .send({
          name: "Algorithm Test Session",
          projectPath: "/tmp/algo-test",
          defaultProvider: "test-provider",
        });
      testSessionId = sessionRes.body.id;

      const agentRes = await request(app)
        .post(`/api/v1/sessions/${testSessionId}/agents`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          name: "Algorithm Test Agent",
          role: "worker",
          model: "test-model",
        });
      testAgentId = agentRes.body.id;

      // Create tasks with different priorities and labels
      await request(app)
        .post(`/api/v1/sessions/${testSessionId}/tasks`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "Critical security bug",
          priority: "P0",
          labels: ["security", "bug"],
        });

      await request(app)
        .post(`/api/v1/sessions/${testSessionId}/tasks`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "High priority feature",
          priority: "P1",
          labels: ["frontend", "feature"],
        });

      await request(app)
        .post(`/api/v1/sessions/${testSessionId}/tasks`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "Normal refactoring",
          priority: "P2",
          labels: ["refactoring"],
        });
    });

    it("prioritizes P0 tasks over skill matches", async () => {
      const res = await request(app)
        .post(`/api/v1/sessions/${testSessionId}/agents/${testAgentId}/request-task`)
        .set("Authorization", `Bearer ${token}`)
        .send({ skills: ["frontend"] }); // Has skill match for P1

      expect(res.status).toBe(200);
      expect(res.body.task.priority).toBe("P0"); // But gets P0 critical task
      expect(res.body.task.title).toContain("Critical");
    });

    it("matches skills within same priority level", async () => {
      // Assign P0 task first
      const tasksRes = await request(app)
        .get(`/api/v1/sessions/${testSessionId}/tasks`)
        .set("Authorization", `Bearer ${token}`);

      const p0Task = tasksRes.body.tasks.find((t: any) => t.priority === "P0");
      await request(app)
        .put(`/api/v1/sessions/${testSessionId}/tasks/${p0Task.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ assignedTo: "other-agent" });

      // Now request task with frontend skill
      const res = await request(app)
        .post(`/api/v1/sessions/${testSessionId}/agents/${testAgentId}/request-task`)
        .set("Authorization", `Bearer ${token}`)
        .send({ skills: ["frontend"] });

      expect(res.status).toBe(200);
      expect(res.body.task.priority).toBe("P1");
      expect(res.body.task.labels).toContain("frontend");
    });
  });
});
