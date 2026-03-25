/**
 * Integration tests for terminal API.
 * Tests terminal creation, listing, and deletion using MockPtyBackend.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync } from "fs";

describe("Terminal API integration", () => {
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

  describe("POST /api/v1/sessions/:sid/terminal", () => {
    it("creates a new standalone terminal", async () => {
      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/terminal`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.id).toMatch(/^term-/);
      expect(res.body).toHaveProperty("terminalSession");
      expect(res.body).toHaveProperty("projectPath");

      // Verify backend session was created
      const sessions = await ctx.tmux.listSessions();
      expect(sessions).toContain(res.body.terminalSession);
    });

    it("returns 404 for non-existent session", async () => {
      const res = await request(ctx.app)
        .post("/api/v1/sessions/nonexistent/terminal")
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/v1/sessions/:sid/terminals", () => {
    it("returns empty list initially", async () => {
      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/terminals`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("terminals");
      expect(res.body.terminals).toEqual([]);
    });

    it("returns created terminals", async () => {
      // Create terminal
      const createRes = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/terminal`)
        .set("Authorization", `Bearer ${ctx.token}`);

      const termId = createRes.body.id;

      // List terminals
      const listRes = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/terminals`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(listRes.status).toBe(200);
      expect(listRes.body).toHaveProperty("terminals");
      expect(listRes.body.terminals).toHaveLength(1);
      expect(listRes.body.terminals[0]).toHaveProperty("id", termId);
      expect(listRes.body.terminals[0]).toHaveProperty("type", "standalone");
      expect(listRes.body.terminals[0]).toHaveProperty("name");
    });
  });

  describe("DELETE /api/v1/sessions/:sid/terminals/:tid", () => {
    it("deletes a terminal", async () => {
      // Create terminal
      const createRes = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/terminal`)
        .set("Authorization", `Bearer ${ctx.token}`);

      const termId = createRes.body.id;
      const terminalSession = createRes.body.terminalSession;

      // Delete terminal
      const deleteRes = await request(ctx.app)
        .delete(`/api/v1/sessions/${sessionId}/terminals/${termId}`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body).toHaveProperty("deleted", true);

      // Verify backend session was killed
      const sessions = await ctx.tmux.listSessions();
      expect(sessions).not.toContain(terminalSession);

      // Verify it's removed from list
      const listRes = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/terminals`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(listRes.body).toHaveProperty("terminals");
      expect(listRes.body.terminals).toHaveLength(0);
    });

    it("returns 404 for non-existent terminal", async () => {
      const res = await request(ctx.app)
        .delete(`/api/v1/sessions/${sessionId}/terminals/nonexistent`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(404);
    });
  });

  describe("terminal persistence", () => {
    it("persists terminal state to disk", async () => {
      // Create terminal
      const createRes = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/terminal`)
        .set("Authorization", `Bearer ${ctx.token}`);

      const termId = createRes.body.id;

      // Wait a bit for async persistence to complete
      await new Promise(r => setTimeout(r, 100));

      // Verify persistence file exists
      const session = ctx.sessionManager.getSession(sessionId);
      expect(session).toBeDefined();

      const { readFileSync } = await import("fs");
      const { join } = await import("path");

      const persistFile = join(session!.runtimeDir, "state", "terminals.json");
      const content = JSON.parse(readFileSync(persistFile, "utf-8"));

      expect(content).toHaveLength(1);
      expect(content[0]).toHaveProperty("id", termId);
    });
  });
});
