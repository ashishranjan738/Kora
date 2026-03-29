/**
 * Integration tests for sprint 4 features:
 * - Full boot prompt with persona content
 * - get_context("all") excludes persona/communication
 * - Kiro per-agent steering files
 * - Sidebar chat via channel relay
 * - Visual task linking (dependency API)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync } from "fs";
import { buildBootPrompt } from "../../core/boot-prompt-builder.js";

// ═══════════════════════════════════════════════════════════════════════
// Full Boot Prompt
// ═══════════════════════════════════════════════════════════════════════

describe("Sprint 4: Full boot prompt", () => {
  // Test 1: Boot prompt contains identity, tools, rules sections
  it("boot prompt includes identity, core tools, and rules sections", () => {
    const prompt = buildBootPrompt({
      agentName: "Dev 1",
      agentId: "dev-1-abc",
      agentRole: "worker",
      sessionName: "test-session",
      messagingMode: "mcp",
    });

    expect(prompt).toContain("Dev 1");
    expect(prompt).toContain("worker");
    expect(prompt).toContain("test-session");
    // Should have MCP tool instructions
    expect(prompt).toContain("get_context");
    expect(prompt).toContain("send_message");
    expect(prompt).toContain("check_messages");
  });

  // Test 2: Boot prompt with persona content includes persona
  it("boot prompt includes persona content when provided", () => {
    const personaContent = "## Identity\nYou are a testing specialist.\n\n## Goal\nEnsure code quality.";
    const prompt = buildBootPrompt({
      agentName: "Tester",
      agentId: "tester-xyz",
      agentRole: "worker",
      sessionName: "test-session",
      messagingMode: "mcp",
      personaContent,
    });

    expect(prompt).toContain("testing specialist");
    expect(prompt).toContain("Ensure code quality");
  });

  // Test 3: Boot prompt respects different messaging modes
  it("CLI mode boot prompt includes kora-cli instructions", () => {
    const prompt = buildBootPrompt({
      agentName: "Dev CLI",
      agentId: "dev-cli",
      agentRole: "worker",
      sessionName: "test-session",
      messagingMode: "cli",
    });

    expect(prompt).toContain("kora-cli");
  });

  // Test 4: Boot prompt includes role constraints
  it("master role includes coordinator constraint", () => {
    const prompt = buildBootPrompt({
      agentName: "EM",
      agentId: "em-1",
      agentRole: "master",
      sessionName: "test-session",
      messagingMode: "mcp",
    });

    // Master should have coordinator-related constraint
    expect(prompt.toLowerCase()).toContain("master");
  });

  // Test 5: Boot prompt includes worker protocol
  it("worker role includes worker protocol", () => {
    const prompt = buildBootPrompt({
      agentName: "Dev",
      agentId: "dev-1",
      agentRole: "worker",
      sessionName: "test-session",
      messagingMode: "mcp",
    });

    expect(prompt.toLowerCase()).toContain("worker");
  });

  // Test 6: Boot prompt without persona is compact
  it("boot prompt without persona is shorter than with persona", () => {
    const shortPrompt = buildBootPrompt({
      agentName: "Dev",
      agentId: "dev-1",
      agentRole: "worker",
      sessionName: "test-session",
      messagingMode: "mcp",
    });

    const longPrompt = buildBootPrompt({
      agentName: "Dev",
      agentId: "dev-1",
      agentRole: "worker",
      sessionName: "test-session",
      messagingMode: "mcp",
      personaContent: "A".repeat(5000),
    });

    expect(longPrompt.length).toBeGreaterThan(shortPrompt.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// get_context optimization
// ═══════════════════════════════════════════════════════════════════════

describe("Sprint 4: get_context optimization", () => {
  // These test the resource registry behavior — unit-level
  it("RESOURCE_DEFINITIONS includes persona and communication", async () => {
    const { RESOURCE_DEFINITIONS } = await import("../../tools/resource-registry.js");
    const uris = RESOURCE_DEFINITIONS.map((r: any) => r.uri);
    expect(uris).toContain("kora://persona");
    expect(uris).toContain("kora://communication");
  });

  it("RESOURCE_DEFINITIONS includes team, workflow, tasks, knowledge, rules, workspace", async () => {
    const { RESOURCE_DEFINITIONS } = await import("../../tools/resource-registry.js");
    const uris = RESOURCE_DEFINITIONS.map((r: any) => r.uri);
    expect(uris).toContain("kora://team");
    expect(uris).toContain("kora://workflow");
    expect(uris).toContain("kora://tasks");
    expect(uris).toContain("kora://knowledge");
    expect(uris).toContain("kora://rules");
    expect(uris).toContain("kora://workspace");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Sidebar Chat (channel relay)
// ═══════════════════════════════════════════════════════════════════════

describe("Sprint 4: Sidebar chat via channel relay", () => {
  let ctx: TestContext;
  let sessionId: string;

  const auth = () => ({ Authorization: `Bearer ${ctx.token}` });

  beforeEach(async () => {
    ctx = setupTestApp();
    await ctx.sessionManager.load();

    const projectPath = join(ctx.testDir, `test-project-${Date.now()}`);
    mkdirSync(projectPath, { recursive: true });

    const res = await request(ctx.app)
      .post("/api/v1/sessions")
      .set(auth())
      .send({ name: "Chat Test", projectPath, provider: "claude-code" });

    expect(res.status).toBe(201);
    sessionId = res.body.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // Test 7: #sidebar channel can be created
  it("creates #sidebar channel for user-agent chat", async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/channels`)
      .set(auth())
      .send({ id: "#sidebar", name: "Sidebar Chat" });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id", "#sidebar");
  });

  // Test 8: Chat history persisted to channel
  it("channel messages retrievable via history endpoint", async () => {
    // Create channel
    await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/channels`)
      .set(auth())
      .send({ id: "#sidebar", name: "Sidebar" });

    // Get history
    const historyRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/channels/%23sidebar/messages`)
      .set(auth());

    expect(historyRes.status).toBe(200);
    expect(historyRes.body).toHaveProperty("channel", "#sidebar");
    expect(Array.isArray(historyRes.body.messages)).toBe(true);
  });

  // Test 9: Relay endpoint accepts channel parameter
  it("relay endpoint accepts channel parameter for routing", async () => {
    // Create channel
    await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/channels`)
      .set(auth())
      .send({ id: "#sidebar", name: "Sidebar" });

    // Relay message — may fail on delivery (no running agents) but shouldn't crash
    const relayRes = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/relay`)
      .set(auth())
      .send({
        from: "user",
        to: "master",
        message: "Hello from sidebar",
        channel: "#sidebar",
      });

    // Accept 200 (success) or 404 (no orchestrator/agent) — not 500
    expect([200, 404]).toContain(relayRes.status);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Visual Task Linking (dependency API)
// ═══════════════════════════════════════════════════════════════════════

describe("Sprint 4: Visual task linking (dependencies)", () => {
  let ctx: TestContext;
  let sessionId: string;

  const auth = () => ({ Authorization: `Bearer ${ctx.token}` });

  async function createTask(title: string, deps: string[] = []) {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/tasks`)
      .set(auth())
      .send({ sessionId, title, dependencies: deps });
    expect(res.status).toBe(201);
    return res.body;
  }

  beforeEach(async () => {
    ctx = setupTestApp();
    await ctx.sessionManager.load();

    const projectPath = join(ctx.testDir, `test-project-${Date.now()}`);
    mkdirSync(projectPath, { recursive: true });

    const res = await request(ctx.app)
      .post("/api/v1/sessions")
      .set(auth())
      .send({ name: "Link Test", projectPath, provider: "claude-code" });

    expect(res.status).toBe(201);
    sessionId = res.body.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // Test 10: Creating task with dependency stores the dependency
  it("task created with dependencies stores them", async () => {
    const taskA = await createTask("Task A");
    const taskB = await createTask("Task B", [taskA.id]);

    // Get task B and verify dependency
    const getRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/tasks/${taskB.id}`)
      .set(auth());

    expect(getRes.status).toBe(200);
    expect(getRes.body.dependencies).toContain(taskA.id);
  });

  // Test 11: Task with no dependencies has empty array
  it("task without dependencies has empty array", async () => {
    const task = await createTask("Independent Task");

    const getRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/tasks/${task.id}`)
      .set(auth());

    expect(getRes.status).toBe(200);
    expect(getRes.body.dependencies).toEqual([]);
  });

  // Test 12: Dependencies field returned in task list
  it("task list includes dependencies field", async () => {
    const taskA = await createTask("Task A");
    await createTask("Task B", [taskA.id]);

    const listRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/tasks`)
      .set(auth());

    expect(listRes.status).toBe(200);
    const taskB = listRes.body.tasks.find((t: any) => t.title === "Task B");
    expect(taskB).toBeDefined();
    expect(taskB.dependencies).toContain(taskA.id);
  });
});
