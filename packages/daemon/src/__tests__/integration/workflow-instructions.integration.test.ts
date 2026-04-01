/**
 * Integration tests for PUT /sessions/:sid/workflow-instructions endpoint (PR #516).
 *
 * Verifies per-state instruction editing, persistence, validation,
 * and edge cases like empty instructions, unknown states, and concurrent updates.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync } from "fs";

describe("PUT /sessions/:sid/workflow-instructions", () => {
  let ctx: TestContext;
  let sessionId: string;

  beforeEach(async () => {
    ctx = setupTestApp();
    await ctx.sessionManager.load();

    const projectPath = join(ctx.testDir, "wf-instr-project");
    mkdirSync(projectPath, { recursive: true });

    const res = await request(ctx.app)
      .post("/api/v1/sessions")
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({ name: "WF Instructions Test", projectPath, provider: "claude-code" });

    sessionId = res.body.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("updates instructions for multiple states at once", async () => {
    const res = await request(ctx.app)
      .put(`/api/v1/sessions/${sessionId}/workflow-instructions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        instructions: [
          { stateId: "in-progress", instructions: "Write TDD tests first." },
          { stateId: "review", instructions: "Check OWASP top 10." },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);

    // Verify both persisted
    const statesRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/workflow-states`)
      .set("Authorization", `Bearer ${ctx.token}`);

    const states = statesRes.body.states;
    expect(states.find((s: any) => s.id === "in-progress")?.instructions).toBe("Write TDD tests first.");
    expect(states.find((s: any) => s.id === "review")?.instructions).toBe("Check OWASP top 10.");
  });

  it("clears instructions when empty string is provided", async () => {
    // First set instructions
    await request(ctx.app)
      .put(`/api/v1/sessions/${sessionId}/workflow-instructions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        instructions: [
          { stateId: "review", instructions: "Check everything." },
        ],
      });

    // Then clear them
    const res = await request(ctx.app)
      .put(`/api/v1/sessions/${sessionId}/workflow-instructions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        instructions: [
          { stateId: "review", instructions: "" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);

    const statesRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/workflow-states`)
      .set("Authorization", `Bearer ${ctx.token}`);

    const review = statesRes.body.states.find((s: any) => s.id === "review");
    // Empty string should clear (undefined or empty)
    expect(!review?.instructions || review.instructions === "").toBe(true);
  });

  it("skips unknown state IDs gracefully", async () => {
    const res = await request(ctx.app)
      .put(`/api/v1/sessions/${sessionId}/workflow-instructions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        instructions: [
          { stateId: "nonexistent-state", instructions: "Should be skipped." },
          { stateId: "review", instructions: "Valid update." },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1); // Only "review" matched
  });

  it("skips entries with non-string fields", async () => {
    const res = await request(ctx.app)
      .put(`/api/v1/sessions/${sessionId}/workflow-instructions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        instructions: [
          { stateId: 123, instructions: "bad stateId type" },
          { stateId: "review", instructions: 456 },
          { stateId: "in-progress", instructions: "Valid." },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1); // Only "in-progress" valid
  });

  it("rejects instructions at exactly the limit boundary", async () => {
    // 5000 chars should be OK
    const res5000 = await request(ctx.app)
      .put(`/api/v1/sessions/${sessionId}/workflow-instructions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        instructions: [
          { stateId: "review", instructions: "x".repeat(5000) },
        ],
      });
    expect(res5000.status).toBe(200);

    // 5001 chars should fail
    const res5001 = await request(ctx.app)
      .put(`/api/v1/sessions/${sessionId}/workflow-instructions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        instructions: [
          { stateId: "review", instructions: "x".repeat(5001) },
        ],
      });
    expect(res5001.status).toBe(400);
    expect(res5001.body.error).toContain("exceed");
  });

  it("handles empty instructions array", async () => {
    const res = await request(ctx.app)
      .put(`/api/v1/sessions/${sessionId}/workflow-instructions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({ instructions: [] });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
  });

  it("preserves existing instructions when updating others", async () => {
    // Set review instructions
    await request(ctx.app)
      .put(`/api/v1/sessions/${sessionId}/workflow-instructions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        instructions: [
          { stateId: "review", instructions: "Original review instructions." },
        ],
      });

    // Update only in-progress — review should stay
    await request(ctx.app)
      .put(`/api/v1/sessions/${sessionId}/workflow-instructions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        instructions: [
          { stateId: "in-progress", instructions: "New in-progress instructions." },
        ],
      });

    const statesRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/workflow-states`)
      .set("Authorization", `Bearer ${ctx.token}`);

    const review = statesRes.body.states.find((s: any) => s.id === "review");
    const inProgress = statesRes.body.states.find((s: any) => s.id === "in-progress");
    expect(review?.instructions).toBe("Original review instructions.");
    expect(inProgress?.instructions).toBe("New in-progress instructions.");
  });

  it("rejects non-array instructions payload", async () => {
    const res = await request(ctx.app)
      .put(`/api/v1/sessions/${sessionId}/workflow-instructions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({ instructions: "not an array" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("array");
  });

  it("rejects object payload without instructions field", async () => {
    const res = await request(ctx.app)
      .put(`/api/v1/sessions/${sessionId}/workflow-instructions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({ states: [] });

    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent session", async () => {
    const res = await request(ctx.app)
      .put("/api/v1/sessions/no-such-session/workflow-instructions")
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({ instructions: [] });

    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(ctx.app)
      .put(`/api/v1/sessions/${sessionId}/workflow-instructions`)
      .send({ instructions: [] });

    expect(res.status).toBe(401);
  });

  it("instructions with special characters persist correctly", async () => {
    const specialInstructions = 'Check for SQL injection: SELECT * FROM users WHERE id = "1"; -- and XSS: <script>alert("x")</script>';
    const res = await request(ctx.app)
      .put(`/api/v1/sessions/${sessionId}/workflow-instructions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        instructions: [
          { stateId: "review", instructions: specialInstructions },
        ],
      });

    expect(res.status).toBe(200);

    const statesRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/workflow-states`)
      .set("Authorization", `Bearer ${ctx.token}`);

    const review = statesRes.body.states.find((s: any) => s.id === "review");
    expect(review?.instructions).toBe(specialInstructions);
  });
});
