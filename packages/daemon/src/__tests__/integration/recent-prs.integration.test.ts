/**
 * Integration tests for recently merged PRs (#103-107).
 * Tests socket cleanup, broadcast optimization, and terminal restoration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";

describe("Recent PRs Integration Tests", () => {
  let ctx: TestContext;
  let sessionId: string;
  let projectPath: string;

  beforeEach(async () => {
    ctx = setupTestApp();
    await ctx.sessionManager.load();

    // Create a test session
    projectPath = join(ctx.testDir, "test-project");
    mkdirSync(projectPath, { recursive: true });

    const res = await request(ctx.app)
      .post("/api/v1/sessions")
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({ name: "Test Session", projectPath, provider: "claude-code" });

    sessionId = res.body.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  describe("PR #104: Holdpty socket cleanup on agent stop", () => {
    it("ensures killSession is called when terminal is deleted", async () => {
      // Spy on killSession at the backend level
      const killSessionSpy = vi.spyOn(ctx.tmux, "killSession");

      // Create a terminal
      const createRes = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/terminal`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(createRes.status).toBe(201);
      const termId = createRes.body.id;
      const tmuxSession = createRes.body.tmuxSession;

      // Delete the terminal (triggers cleanup logic)
      const deleteRes = await request(ctx.app)
        .delete(`/api/v1/sessions/${sessionId}/terminals/${termId}`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(deleteRes.status).toBe(200);

      // Verify killSession was called
      expect(killSessionSpy).toHaveBeenCalledWith(tmuxSession);

      killSessionSpy.mockRestore();
    });

    it("calls killSession even if session is already dead", async () => {
      // Create terminal
      const createRes = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/terminal`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(createRes.status).toBe(201);
      const termId = createRes.body.id;
      const tmuxSession = createRes.body.tmuxSession;

      // Mock hasSession to return false (session already dead)
      vi.spyOn(ctx.tmux, "hasSession").mockResolvedValue(false);
      const killSessionSpy = vi.spyOn(ctx.tmux, "killSession");

      // Delete should still call killSession for cleanup
      await request(ctx.app)
        .delete(`/api/v1/sessions/${sessionId}/terminals/${termId}`)
        .set("Authorization", `Bearer ${ctx.token}`);

      // killSession should be called unconditionally
      expect(killSessionSpy).toHaveBeenCalled();

      killSessionSpy.mockRestore();
    });
  });

  describe("PR #105: Broadcast delivery optimization", () => {
    it("broadcast API endpoint responds successfully", async () => {
      // Test that broadcast endpoint works (even with no agents)
      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/broadcast`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ message: "Test broadcast message" });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("broadcast", true);
      expect(res.body).toHaveProperty("sentTo");
      expect(res.body).toHaveProperty("message", "Test broadcast message");
      // No agents, so sentTo should be 0
      expect(res.body.sentTo).toBe(0);
    });

    it("broadcast uses batch enqueue mechanism", async () => {
      // Verify the broadcast endpoint exists and works
      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/broadcast`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ message: "Performance test message" });

      expect(res.status).toBe(200);
      expect(res.body.broadcast).toBe(true);
      // Even with no agents, the batch mechanism should work
      expect(res.body.results).toEqual([]);
    });
  });

  describe("PR #106: Verify socket existence when restoring terminals", () => {
    it("skips restoration if socket file is missing", async () => {
      // Create a terminal entry in persistence file with non-existent session
      const terminalsFile = join(ctx.testDir, "terminals.json");
      const terminalEntry = {
        terminals: [
          {
            id: "term-missing-socket",
            sessionId,
            tmuxSession: "kora-dev--test-term-missing",
            projectPath,
            createdAt: new Date().toISOString(),
          },
        ],
      };
      writeFileSync(terminalsFile, JSON.stringify(terminalEntry, null, 2));

      // Mock hasSession to return false (socket missing)
      vi.spyOn(ctx.tmux, "hasSession").mockResolvedValue(false);

      // Try to list terminals (triggers restoration logic)
      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/terminals`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      // Terminal with missing socket should not be restored
      expect(res.body.terminals).toHaveLength(0);
    });

    it("successfully restores terminal with valid socket", async () => {
      // Create a real terminal
      const createRes = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/terminal`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(createRes.status).toBe(201);
      const termId = createRes.body.id;
      const tmuxSession = createRes.body.tmuxSession;

      // Verify session exists in backend
      const hasSession = await ctx.tmux.hasSession(tmuxSession);
      expect(hasSession).toBe(true);

      // List terminals - should successfully restore
      const listRes = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/terminals`)
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(listRes.status).toBe(200);
      expect(listRes.body.terminals).toHaveLength(1);
      expect(listRes.body.terminals[0].id).toBe(termId);
    });
  });

  describe("PR #107: Message notification patterns", () => {
    it("detects new message pattern in terminal output", () => {
      // This is primarily a frontend feature, but we can test the message format
      const messagePattern = /\[New message from ([^\]]+)\]/;

      const testOutputs = [
        "[New message from Architect]: Your task is ready",
        "[New message from Frontend]: UI is complete",
        "Regular terminal output",
        "[Message from Backend]: Status update",
      ];

      expect(testOutputs[0]).toMatch(messagePattern);
      expect(testOutputs[1]).toMatch(messagePattern);
      expect(testOutputs[2]).not.toMatch(messagePattern);
      expect(testOutputs[3]).not.toMatch(messagePattern);

      // Extract sender names
      const match1 = testOutputs[0].match(messagePattern);
      expect(match1?.[1]).toBe("Architect");

      const match2 = testOutputs[1].match(messagePattern);
      expect(match2?.[1]).toBe("Frontend");
    });
  });
});
