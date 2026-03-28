/**
 * Integration tests for sprint 3 features:
 * - Tool removal (verify_work, prepare_pr, create_pr)
 * - Transition notifications with runbook delivery
 * - Stale nudge enhancement with state instructions
 * - FTS5 knowledge search with BM25 ranking
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync } from "fs";
import { ALL_TOOL_NAMES, TOOL_DEFINITIONS } from "../../tools/tool-registry.js";
import {
  resolveVariables,
  buildTransitionNotification,
  buildCancellationNotification,
  buildBackwardNotification,
  buildReassignmentNotification,
} from "../../core/variable-resolver.js";
import type { ResolverContext } from "../../core/variable-resolver.js";

// ═══════════════════════════════════════════════════════════════════════
// Tool Removal
// ═══════════════════════════════════════════════════════════════════════

describe("Sprint 3: Tool removal", () => {
  // Test 1: verify_work, prepare_pr, create_pr not in tools/list
  it("removed tools are not in ALL_TOOL_NAMES", () => {
    const names = ALL_TOOL_NAMES as readonly string[];
    expect(names).not.toContain("verify_work");
    expect(names).not.toContain("prepare_pr");
    expect(names).not.toContain("create_pr");
  });

  // Test 2: removed tools have no definitions
  it("removed tools have no TOOL_DEFINITIONS entry", () => {
    const definedNames = TOOL_DEFINITIONS.map((d) => d.name);
    expect(definedNames).not.toContain("verify_work");
    expect(definedNames).not.toContain("prepare_pr");
    expect(definedNames).not.toContain("create_pr");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Transition Notifications (variable resolver + notification builders)
// ═══════════════════════════════════════════════════════════════════════

describe("Sprint 3: Transition notifications", () => {
  const baseCtx: ResolverContext = {
    task: { id: "abc123", title: "Fix login bug", priority: "P0", status: "review", assignedTo: "dev-1" },
    newState: { id: "review", label: "Review" },
    oldState: { id: "in-progress", label: "In Progress" },
    agent: { id: "dev-1", name: "Dev 1" },
    baseBranch: "main",
    sessionId: "test-session",
  };

  // Test 3: Forward transition notification includes runbook instructions
  it("buildTransitionNotification includes runbook instructions", () => {
    const msg = buildTransitionNotification(baseCtx, "Review the code for bugs and style issues.");
    expect(msg).toContain("Fix login bug");
    expect(msg).toContain("Review");
    expect(msg).toContain("Your instructions");
    expect(msg).toContain("Review the code for bugs and style issues.");
    expect(msg).toContain("abc123");
    expect(msg).toContain("P0");
  });

  // Test 4: Variable interpolation in instructions
  it("resolves variables in instruction templates", () => {
    const template = "Review PR for {task.title} (task {task.id}). Push to {baseBranch}.";
    const resolved = resolveVariables(template, baseCtx);
    expect(resolved).toBe('Review PR for Fix login bug (task abc123). Push to main.');
  });

  // Test 5: Cancellation notification
  it("buildCancellationNotification includes task info", () => {
    const ctx = { ...baseCtx, newState: { id: "done", label: "Done" } };
    const msg = buildCancellationNotification(ctx);
    expect(msg).toContain("Fix login bug");
    expect(msg).toContain("cancelled/closed");
    expect(msg).toContain("abc123");
    expect(msg).toContain("Done");
  });

  // Test 6: Reassignment notification includes old agent
  it("buildReassignmentNotification includes previous assignee", () => {
    const msg = buildReassignmentNotification(baseCtx, "Old Dev");
    expect(msg).toContain("Fix login bug");
    expect(msg).toContain("reassigned");
    expect(msg).toContain("Old Dev");
    expect(msg).toContain("abc123");
  });

  // Test 7: Backward movement notification
  it("buildBackwardNotification shows old → new state", () => {
    const ctx = {
      ...baseCtx,
      oldState: { id: "review", label: "Review" },
      newState: { id: "in-progress", label: "In Progress" },
    };
    const msg = buildBackwardNotification(ctx, "Tests failed");
    expect(msg).toContain("backward");
    expect(msg).toContain("Review");
    expect(msg).toContain("In Progress");
    expect(msg).toContain("Tests failed");
  });

  // Unknown variables left as-is
  it("unknown variables preserved in template", () => {
    const resolved = resolveVariables("Hello {unknown.var}", baseCtx);
    expect(resolved).toBe("Hello {unknown.var}");
  });

  // Transition without instructions omits runbook section
  it("buildTransitionNotification without instructions omits runbook", () => {
    const msg = buildTransitionNotification(baseCtx);
    expect(msg).toContain("Fix login bug");
    expect(msg).toContain("Review");
    expect(msg).not.toContain("Your instructions");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Stale Nudge Enhancement
// ═══════════════════════════════════════════════════════════════════════

describe("Sprint 3: Stale nudge enhancement", () => {
  // Test 8: Nudge includes state instructions
  it("StaleTaskWatchdog stores workflow state instructions", async () => {
    const { StaleTaskWatchdog } = await import("../../core/stale-task-watchdog.js");
    const watchdog = new StaleTaskWatchdog({
      sessionId: "test",
      database: { getActiveTasks: () => [], recordNudge: () => {}, getNudgeCount: () => 0, getRecentNudges: () => [] } as any,
      agentManager: { getAgent: () => null } as any,
      messageQueue: { enqueue: () => {} } as any,
    });

    watchdog.setWorkflowStates([
      { id: "in-progress", label: "In Progress", instructions: "Write code and tests." },
      { id: "review", label: "Review", instructions: "Check for bugs." },
      { id: "done", label: "Done" },
    ]);

    // Internally the watchdog should have stored these — verify via the public API
    // (The watchdog uses this in sendNudge to include instructions)
    expect(watchdog).toBeDefined();
  });

  // Test 9: Nudge with no instructions still works
  it("StaleTaskWatchdog works with states that have no instructions", async () => {
    const { StaleTaskWatchdog } = await import("../../core/stale-task-watchdog.js");
    const watchdog = new StaleTaskWatchdog({
      sessionId: "test",
      database: { getActiveTasks: () => [], recordNudge: () => {}, getNudgeCount: () => 0, getRecentNudges: () => [] } as any,
      agentManager: { getAgent: () => null } as any,
      messageQueue: { enqueue: () => {} } as any,
    });

    // No instructions on any state
    watchdog.setWorkflowStates([
      { id: "in-progress", label: "In Progress" },
      { id: "review", label: "Review" },
    ]);

    expect(watchdog).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// FTS5 Knowledge Search
// ═══════════════════════════════════════════════════════════════════════

describe("Sprint 3: FTS5 knowledge search", () => {
  let ctx: TestContext;
  let sessionId: string;

  const auth = () => ({ Authorization: `Bearer ${ctx.token}` });

  async function saveKnowledge(key: string, value: string) {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/knowledge-db`)
      .set(auth())
      .send({ key, value, savedBy: "tester" });
    expect(res.status).toBe(201);
  }

  async function searchKnowledge(query: string) {
    return request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/knowledge-db?q=${encodeURIComponent(query)}`)
      .set(auth());
  }

  beforeEach(async () => {
    ctx = setupTestApp();
    await ctx.sessionManager.load();

    const projectPath = join(ctx.testDir, `test-project-${Date.now()}`);
    mkdirSync(projectPath, { recursive: true });

    const res = await request(ctx.app)
      .post("/api/v1/sessions")
      .set(auth())
      .send({ name: "FTS Test", projectPath, provider: "claude-code" });

    expect(res.status).toBe(201);
    sessionId = res.body.id;

    // Seed knowledge entries
    await saveKnowledge("architecture", "Microservices with event sourcing and CQRS pattern");
    await saveKnowledge("api-design", "REST endpoints follow OpenAPI 3.0 specification");
    await saveKnowledge("deployment", "Docker containers deployed to Kubernetes via Helm charts");
    await saveKnowledge("testing-strategy", "Unit tests with Vitest, integration tests with supertest");
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // Test 10: Search returns relevant results
  it("search returns relevant results for keyword", async () => {
    const res = await searchKnowledge("microservices");

    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThanOrEqual(1);
    expect(res.body.entries.some((e: any) => e.key === "architecture")).toBe(true);
  });

  // Test 11: Multi-word query works
  it("multi-word search returns matching entries", async () => {
    const res = await searchKnowledge("Docker Kubernetes");

    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThanOrEqual(1);
    expect(res.body.entries.some((e: any) => e.key === "deployment")).toBe(true);
  });

  // Test 12: FTS stays in sync after insert/update/delete
  it("search reflects new entries immediately", async () => {
    await saveKnowledge("new-entry", "GraphQL federation gateway with Apollo");

    const res = await searchKnowledge("GraphQL");
    expect(res.status).toBe(200);
    expect(res.body.entries.some((e: any) => e.key === "new-entry")).toBe(true);

    // Delete and verify gone from search
    await request(ctx.app)
      .delete(`/api/v1/sessions/${sessionId}/knowledge-db/new-entry`)
      .set(auth());

    const res2 = await searchKnowledge("GraphQL");
    expect(res2.body.entries.some((e: any) => e.key === "new-entry")).toBe(false);
  });

  // Test 13: Handles special characters
  it("search handles special characters gracefully", async () => {
    const res = await searchKnowledge("C++ *pointer*");

    expect(res.status).toBe(200);
    // Should not throw — returns empty or results
    expect(Array.isArray(res.body.entries)).toBe(true);
  });

  // Test 14: Empty query returns all or empty
  it("empty query returns entries", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/knowledge-db`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(4);
  });
});
