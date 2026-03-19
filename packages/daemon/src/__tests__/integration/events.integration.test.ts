/**
 * Integration tests for events API.
 * Tests event logging and querying with filters.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync } from "fs";

describe("Events API integration", () => {
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

  describe("GET /api/v1/events", () => {
    it("returns empty list initially", async () => {
      const res = await request(ctx.app)
        .get(`/api/v1/events?sessionId=${sessionId}`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("events");
      expect(res.body.events).toEqual([]);
      expect(res.body).toHaveProperty("total", 0);
    });

    it("logs event on session creation", async () => {
      // Query events
      const res = await request(ctx.app)
        .get(`/api/v1/events?sessionId=${sessionId}`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(1);
      expect(res.body.events[0]).toHaveProperty("type", "session-created");
      expect(res.body.events[0]).toHaveProperty("sessionId", sessionId);
    });

    it("logs event on task creation", async () => {
      // Create task
      await request(ctx.app)
        .post("/api/v1/tasks")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          sessionId,
          title: "Test Task",
        });

      // Query events
      const res = await request(ctx.app)
        .get(`/api/v1/events?sessionId=${sessionId}`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body.events.length).toBeGreaterThan(1);

      const taskEvent = res.body.events.find((e: any) => e.type === "task-created");
      expect(taskEvent).toBeDefined();
      expect(taskEvent.data).toHaveProperty("title", "Test Task");
    });

    it("filters events by type", async () => {
      // Create task
      await request(ctx.app)
        .post("/api/v1/tasks")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ sessionId, title: "Test" });

      // Filter by task-created
      const res = await request(ctx.app)
        .get(`/api/v1/events?sessionId=${sessionId}&type=task-created`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(1);
      expect(res.body.events[0]).toHaveProperty("type", "task-created");
    });

    it("filters events by timestamp (since)", async () => {
      // Wait a moment
      await new Promise(r => setTimeout(r, 100));
      const since = new Date().toISOString();

      // Create task after timestamp
      await request(ctx.app)
        .post("/api/v1/tasks")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ sessionId, title: "New Task" });

      // Query with since filter
      const res = await request(ctx.app)
        .get(`/api/v1/events?sessionId=${sessionId}&since=${since}`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(1);
      expect(res.body.events[0]).toHaveProperty("type", "task-created");
    });

    it("limits event count", async () => {
      // Create multiple tasks
      for (let i = 0; i < 5; i++) {
        await request(ctx.app)
          .post("/api/v1/tasks")
          .set("Authorization", `Bearer ${ctx.token}`)
          .send({ sessionId, title: `Task ${i}` });
      }

      // Query with limit
      const res = await request(ctx.app)
        .get(`/api/v1/events?sessionId=${sessionId}&limit=3`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(3);
    });

    it("returns total count", async () => {
      // Create multiple tasks
      for (let i = 0; i < 3; i++) {
        await request(ctx.app)
          .post("/api/v1/tasks")
          .set("Authorization", `Bearer ${ctx.token}`)
          .send({ sessionId, title: `Task ${i}` });
      }

      // Query with limit but expect total count
      const res = await request(ctx.app)
        .get(`/api/v1/events?sessionId=${sessionId}&limit=2`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(2);
      expect(res.body.total).toBeGreaterThanOrEqual(4); // session-created + 3 task-created
    });
  });

  describe("event data integrity", () => {
    it("includes full event data", async () => {
      // Create task with all fields
      await request(ctx.app)
        .post("/api/v1/tasks")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          sessionId,
          title: "Full Task",
          description: "Full description",
          priority: "P1",
          labels: ["test"],
        });

      // Query events
      const res = await request(ctx.app)
        .get(`/api/v1/events?sessionId=${sessionId}&type=task-created`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      const event = res.body.events[0];

      expect(event).toHaveProperty("id");
      expect(event).toHaveProperty("timestamp");
      expect(event).toHaveProperty("sessionId", sessionId);
      expect(event).toHaveProperty("type", "task-created");
      expect(event).toHaveProperty("data");
      expect(event.data).toHaveProperty("title", "Full Task");
      expect(event.data).toHaveProperty("priority", "P1");
    });
  });
});
