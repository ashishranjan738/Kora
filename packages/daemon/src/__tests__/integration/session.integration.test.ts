/**
 * Integration tests for session CRUD operations.
 * Tests session creation, listing, retrieval, update, and deletion.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync, realpathSync } from "fs";

describe("Session CRUD integration", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = setupTestApp();
    await ctx.sessionManager.load();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  describe("POST /api/v1/sessions", () => {
    it("creates a new session with valid data", async () => {
      const projectPath = join(ctx.testDir, "test-project");
      mkdirSync(projectPath, { recursive: true });
      // Resolve symlinks (macOS /var → /private/var) to match API response
      const resolvedPath = realpathSync(projectPath);

      const res = await request(ctx.app)
        .post("/api/v1/sessions")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          name: "Test Session",
          projectPath,
          provider: "claude-code",
        });

      if (res.status !== 201) {
        console.log("Error response:", res.status, res.body);
      }

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body).toHaveProperty("name", "Test Session");
      expect(res.body).toHaveProperty("projectPath", resolvedPath);
      expect(res.body).toHaveProperty("defaultProvider", "claude-code");
      expect(res.body).toHaveProperty("status", "active");
      expect(res.body).toHaveProperty("agentCount", 0);
    });

    it("rejects session with missing name", async () => {
      const res = await request(ctx.app)
        .post("/api/v1/sessions")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          projectPath: "/tmp/test",
          provider: "claude-code",
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("rejects session with non-existent projectPath", async () => {
      const res = await request(ctx.app)
        .post("/api/v1/sessions")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          name: "Test",
          projectPath: "/nonexistent/path/xyz",
          provider: "claude-code",
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });
  });

  describe("GET /api/v1/sessions", () => {
    it("returns empty list initially", async () => {
      const res = await request(ctx.app)
        .get("/api/v1/sessions")
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sessions: [] });
    });

    it("returns created sessions", async () => {
      const projectPath = join(ctx.testDir, "test-project");
      mkdirSync(projectPath, { recursive: true });

      // Create session
      const createRes = await request(ctx.app)
        .post("/api/v1/sessions")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ name: "Test", projectPath, provider: "claude-code" });

      // List sessions
      const listRes = await request(ctx.app)
        .get("/api/v1/sessions")
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(listRes.status).toBe(200);
      expect(listRes.body).toHaveProperty("sessions");
      expect(listRes.body.sessions).toHaveLength(1);
      expect(listRes.body.sessions[0]).toHaveProperty("id", createRes.body.id);
      expect(listRes.body.sessions[0]).toHaveProperty("name", "Test");
    });
  });

  describe("GET /api/v1/sessions/:sid", () => {
    it("returns session details", async () => {
      const projectPath = join(ctx.testDir, "test-project");
      mkdirSync(projectPath, { recursive: true });

      const createRes = await request(ctx.app)
        .post("/api/v1/sessions")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ name: "Test", projectPath, provider: "claude-code" });

      const sessionId = createRes.body.id;

      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id", sessionId);
      expect(res.body).toHaveProperty("name", "Test");
      expect(res.body).toHaveProperty("agentCount", 0);
    });

    it("returns 404 for non-existent session", async () => {
      const res = await request(ctx.app)
        .get("/api/v1/sessions/nonexistent")
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty("error");
    });
  });

  describe("PUT /api/v1/sessions/:sid", () => {
    it("updates session name", async () => {
      const projectPath = join(ctx.testDir, "test-project");
      mkdirSync(projectPath, { recursive: true });

      const createRes = await request(ctx.app)
        .post("/api/v1/sessions")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ name: "Old Name", projectPath, provider: "claude-code" });

      const sessionId = createRes.body.id;

      const updateRes = await request(ctx.app)
        .put(`/api/v1/sessions/${sessionId}`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ name: "New Name" });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body).toHaveProperty("name", "New Name");
    });

    it("updates allowMasterForceTransition flag", async () => {
      const projectPath = join(ctx.testDir, "test-project-force");
      mkdirSync(projectPath, { recursive: true });

      const createRes = await request(ctx.app)
        .post("/api/v1/sessions")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ name: "Force Test", projectPath, provider: "claude-code" });

      const sessionId = createRes.body.id;

      // Default should be undefined/false
      expect(createRes.body.allowMasterForceTransition).toBeFalsy();

      // Enable the flag
      const updateRes = await request(ctx.app)
        .put(`/api/v1/sessions/${sessionId}`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ allowMasterForceTransition: true });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body).toHaveProperty("allowMasterForceTransition", true);

      // Verify it persists on GET
      const getRes = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(getRes.body).toHaveProperty("allowMasterForceTransition", true);
    });
  });

  describe("allowMasterForceTransition", () => {
    it("defaults to falsy when not provided at creation", async () => {
      const projectPath = join(ctx.testDir, "test-project-default");
      mkdirSync(projectPath, { recursive: true });

      const res = await request(ctx.app)
        .post("/api/v1/sessions")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ name: "Default Test", projectPath, provider: "claude-code" });

      expect(res.status).toBe(201);
      expect(res.body.allowMasterForceTransition).toBeFalsy();
    });

    it("can be set to true at session creation", async () => {
      const projectPath = join(ctx.testDir, "test-project-create-flag");
      mkdirSync(projectPath, { recursive: true });

      const res = await request(ctx.app)
        .post("/api/v1/sessions")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          name: "Flag Test",
          projectPath,
          provider: "claude-code",
          allowMasterForceTransition: true,
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("allowMasterForceTransition", true);
    });

    it("can be toggled from true to false", async () => {
      const projectPath = join(ctx.testDir, "test-project-toggle");
      mkdirSync(projectPath, { recursive: true });

      const createRes = await request(ctx.app)
        .post("/api/v1/sessions")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          name: "Toggle Test",
          projectPath,
          provider: "claude-code",
          allowMasterForceTransition: true,
        });

      const sessionId = createRes.body.id;

      const updateRes = await request(ctx.app)
        .put(`/api/v1/sessions/${sessionId}`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ allowMasterForceTransition: false });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body).toHaveProperty("allowMasterForceTransition", false);
    });
  });

  describe("DELETE /api/v1/sessions/:sid", () => {
    it("deletes a session", async () => {
      const projectPath = join(ctx.testDir, "test-project");
      mkdirSync(projectPath, { recursive: true });

      const createRes = await request(ctx.app)
        .post("/api/v1/sessions")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ name: "Test", projectPath, provider: "claude-code" });

      const sessionId = createRes.body.id;

      const deleteRes = await request(ctx.app)
        .delete(`/api/v1/sessions/${sessionId}`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(deleteRes.status).toBe(204);

      // Verify it's gone
      const getRes = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(getRes.status).toBe(404);
    });
  });
});
