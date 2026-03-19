/**
 * Integration tests for YAML Playbook CRUD (PR #68).
 *
 * Tests all playbook endpoints: list, get, create (upload), delete.
 * Verifies JSON playbook format persistence and error handling.
 * When YAML support lands, extend with YAML-specific upload/parse tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";

describe("Playbook CRUD integration", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = setupTestApp();
    await ctx.sessionManager.load();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // ---- List playbooks ----

  describe("GET /api/v1/playbooks", () => {
    it("returns empty list initially (before builtin seeding)", async () => {
      // Note: test app may or may not seed builtins depending on setup
      const res = await request(ctx.app)
        .get("/api/v1/playbooks")
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("playbooks");
      expect(Array.isArray(res.body.playbooks)).toBe(true);
    });

    it("lists playbooks after creation", async () => {
      // Create a playbook
      await request(ctx.app)
        .post("/api/v1/playbooks")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          name: "My Custom Team",
          description: "A test playbook",
          agents: [
            { name: "Lead", role: "master", model: "claude-sonnet-4-6", persona: "You are a lead." },
            { name: "Dev", role: "worker", model: "claude-sonnet-4-6", persona: "You are a dev." },
          ],
        });

      const res = await request(ctx.app)
        .get("/api/v1/playbooks")
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body.playbooks).toContain("my-custom-team");
    });
  });

  // ---- Get single playbook ----

  describe("GET /api/v1/playbooks/:name", () => {
    it("returns 404 for non-existent playbook", async () => {
      const res = await request(ctx.app)
        .get("/api/v1/playbooks/does-not-exist")
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(404);
    });

    it("returns playbook details by name", async () => {
      // Create a playbook first
      await request(ctx.app)
        .post("/api/v1/playbooks")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          name: "API Test Team",
          description: "For API testing",
          agents: [
            { name: "Architect", role: "master", model: "claude-sonnet-4-6", persona: "You lead." },
            { name: "Worker", role: "worker", model: "claude-sonnet-4-6", persona: "You work." },
          ],
        });

      const res = await request(ctx.app)
        .get("/api/v1/playbooks/api-test-team")
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("name", "API Test Team");
      expect(res.body).toHaveProperty("description", "For API testing");
      expect(res.body).toHaveProperty("agents");
      expect(res.body.agents).toHaveLength(2);
    });

    it("returns correct agent roles", async () => {
      await request(ctx.app)
        .post("/api/v1/playbooks")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          name: "Role Check",
          agents: [
            { name: "Boss", role: "master", model: "claude-sonnet-4-6", persona: "Lead" },
            { name: "Dev1", role: "worker", model: "claude-sonnet-4-6", persona: "Dev" },
            { name: "Dev2", role: "worker", model: "claude-sonnet-4-6", persona: "Dev" },
          ],
        });

      const res = await request(ctx.app)
        .get("/api/v1/playbooks/role-check")
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      const masters = res.body.agents.filter((a: any) => a.role === "master");
      const workers = res.body.agents.filter((a: any) => a.role === "worker");
      expect(masters).toHaveLength(1);
      expect(workers).toHaveLength(2);
    });
  });

  // ---- Create (upload) playbook ----

  describe("POST /api/v1/playbooks", () => {
    it("creates a valid JSON playbook", async () => {
      const res = await request(ctx.app)
        .post("/api/v1/playbooks")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          name: "New Playbook",
          description: "Created via API",
          agents: [
            { name: "Agent", role: "worker", model: "claude-sonnet-4-6", persona: "You work." },
          ],
        });

      expect(res.status).toBe(201);
    });

    it("rejects playbook without name", async () => {
      const res = await request(ctx.app)
        .post("/api/v1/playbooks")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          agents: [
            { name: "Agent", role: "worker", model: "claude-sonnet-4-6", persona: "Hi" },
          ],
        });

      expect(res.status).toBe(400);
    });

    it("rejects playbook without agents", async () => {
      const res = await request(ctx.app)
        .post("/api/v1/playbooks")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          name: "Empty Playbook",
        });

      expect(res.status).toBe(400);
    });

    it("accepts playbook with empty agents array", async () => {
      const res = await request(ctx.app)
        .post("/api/v1/playbooks")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          name: "No Agents",
          agents: [],
        });

      // API currently accepts empty agents (no validation)
      expect(res.status).toBe(201);
    });

    it("persists playbook and can be retrieved", async () => {
      await request(ctx.app)
        .post("/api/v1/playbooks")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          name: "Persist Test",
          description: "Should persist",
          agents: [
            { name: "Solo", role: "master", model: "claude-sonnet-4-6", persona: "You lead." },
          ],
        });

      const res = await request(ctx.app)
        .get("/api/v1/playbooks/persist-test")
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Persist Test");
      expect(res.body.description).toBe("Should persist");
    });
  });

  // ---- YAML upload (PR #68 specific) ----
  // These tests are placeholders for when YAML support lands.
  // They test the expected behavior of uploading YAML content.

  describe("POST /api/v1/playbooks (YAML format — future)", () => {
    it.skip("accepts valid YAML playbook with Content-Type application/yaml", async () => {
      const yamlContent = `
name: YAML Team
description: Created from YAML
agents:
  - name: Lead
    role: master
    model: claude-sonnet-4-6
    persona: You are the lead.
  - name: Dev
    role: worker
    model: claude-sonnet-4-6
    persona: You are a developer.
`;
      const res = await request(ctx.app)
        .post("/api/v1/playbooks")
        .set("Authorization", `Bearer ${ctx.token}`)
        .set("Content-Type", "application/yaml")
        .send(yamlContent);

      expect(res.status).toBe(200);

      // Verify it was stored correctly
      const getRes = await request(ctx.app)
        .get("/api/v1/playbooks/yaml-team")
        .set("Authorization", `Bearer ${ctx.token}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.agents).toHaveLength(2);
    });

    it.skip("rejects invalid YAML syntax with 400", async () => {
      const badYaml = `
name: Bad YAML
agents:
  - name: Missing closing
    role: master
      indentation: wrong
`;
      const res = await request(ctx.app)
        .post("/api/v1/playbooks")
        .set("Authorization", `Bearer ${ctx.token}`)
        .set("Content-Type", "application/yaml")
        .send(badYaml);

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it.skip("rejects YAML with missing required fields", async () => {
      const incompleteYaml = `
description: Missing name field
agents:
  - role: worker
`;
      const res = await request(ctx.app)
        .post("/api/v1/playbooks")
        .set("Authorization", `Bearer ${ctx.token}`)
        .set("Content-Type", "application/yaml")
        .send(incompleteYaml);

      expect(res.status).toBe(400);
    });
  });

  // ---- Playbook execution via session ----

  describe("POST /api/v1/sessions/:sid/playbook (execution)", () => {
    it("returns 400 when playbook name is missing", async () => {
      // Create a session first
      const { mkdirSync } = await import("fs");
      const { join } = await import("path");
      const projectPath = join(ctx.testDir, "test-project");
      mkdirSync(projectPath, { recursive: true });

      const sessionRes = await request(ctx.app)
        .post("/api/v1/sessions")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ name: "PlaybookExec", projectPath, provider: "claude-code" });

      const sessionId = sessionRes.body.id;

      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/playbook`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 404 when playbook does not exist", async () => {
      const { mkdirSync } = await import("fs");
      const { join } = await import("path");
      const projectPath = join(ctx.testDir, "test-project-2");
      mkdirSync(projectPath, { recursive: true });

      const sessionRes = await request(ctx.app)
        .post("/api/v1/sessions")
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ name: "PlaybookExec2", projectPath, provider: "claude-code" });

      const sessionId = sessionRes.body.id;

      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/playbook`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({ playbook: "nonexistent-playbook" });

      expect(res.status).toBe(404);
    });
  });
});
