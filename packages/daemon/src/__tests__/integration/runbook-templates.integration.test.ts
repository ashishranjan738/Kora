/**
 * Integration tests for runbook templates (default workflow state instructions).
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import { setupTestApp } from "./test-setup.js";
import { join } from "path";
import { mkdirSync } from "fs";

describe("Runbook templates", () => {
  it("standard pipeline template includes per-state instructions", async () => {
    const { PIPELINE_TEMPLATES } = await import("@kora/shared");
    const standard = PIPELINE_TEMPLATES.find((t: any) => t.id === "standard");

    expect(standard).toBeDefined();
    if (standard) {
      for (const state of standard.states) {
        expect(state.instructions).toBeDefined();
        expect(state.instructions!.length).toBeGreaterThan(0);
      }
    }
  });

  it("full pipeline template has instructions for all 6 states", async () => {
    const { PIPELINE_TEMPLATES } = await import("@kora/shared");
    const full = PIPELINE_TEMPLATES.find((t: any) => t.id === "full");

    expect(full).toBeDefined();
    if (full) {
      expect(full.states.length).toBeGreaterThanOrEqual(5);
      for (const state of full.states) {
        expect(state.instructions).toBeDefined();
      }
    }
  });

  it("session created with workflow states preserves instructions", async () => {
    const ctx = setupTestApp();
    await ctx.sessionManager.load();

    const projectPath = join(ctx.testDir, `test-project-${Date.now()}`);
    mkdirSync(projectPath, { recursive: true });

    const { PIPELINE_TEMPLATES } = await import("@kora/shared");
    const standard = PIPELINE_TEMPLATES.find((t: any) => t.id === "standard");

    const res = await request(ctx.app)
      .post("/api/v1/sessions")
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({ name: "Runbook Test", projectPath, provider: "claude-code", workflowStates: standard?.states });

    expect(res.status).toBe(201);
    const session = ctx.sessionManager.getSession(res.body.id);
    expect(session?.config.workflowStates).toBeDefined();
    if (session?.config.workflowStates) {
      const inProgress = session.config.workflowStates.find((s: any) => s.id === "in-progress");
      expect(inProgress?.instructions).toBeDefined();
      expect(inProgress?.instructions?.length).toBeGreaterThan(0);
    }

    ctx.cleanup();
  });
});
