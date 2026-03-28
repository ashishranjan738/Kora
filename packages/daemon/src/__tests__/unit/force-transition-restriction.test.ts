/**
 * Tests for force-transition restriction (task 83848953).
 *
 * By default, only humans (no X-Agent-Id header) can force-transition tasks.
 * If session has allowMasterForceTransition: true, master agents can also force.
 * Workers can NEVER force regardless of session config.
 */
import { describe, it, expect, vi } from "vitest";
import type { ToolContext } from "../../tools/tool-context.js";
import { handleUpdateTask } from "../../tools/tool-handlers.js";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: "test-agent",
    sessionId: "test-session",
    agentRole: "worker",
    projectPath: "/tmp/test",
    apiCall: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

const EXPECTED_ERROR =
  "Force transitions are restricted to humans. Enable 'Allow master force transitions' in session settings to permit master agents.";

describe("force-transition restriction (MCP tool handler)", () => {
  describe("worker agents", () => {
    it("should reject force from worker agent", async () => {
      const ctx = makeCtx({ agentRole: "worker" });
      const result = (await handleUpdateTask(ctx, {
        taskId: "task-1",
        status: "done",
        force: "true",
      })) as any;

      expect(result.success).toBe(false);
      expect(result.error).toBe(EXPECTED_ERROR);
      // Should not make any API calls — rejected immediately
      expect(ctx.apiCall).not.toHaveBeenCalled();
    });

    it("should reject force from worker even if session allows master force", async () => {
      const ctx = makeCtx({
        agentRole: "worker",
        apiCall: vi.fn().mockResolvedValue({
          config: { allowMasterForceTransition: true },
        }),
      });
      const result = (await handleUpdateTask(ctx, {
        taskId: "task-1",
        status: "done",
        force: "true",
      })) as any;

      expect(result.success).toBe(false);
      expect(result.error).toBe(EXPECTED_ERROR);
    });
  });

  describe("master agents", () => {
    it("should reject force from master when session flag is not set", async () => {
      const ctx = makeCtx({
        agentRole: "master",
        apiCall: vi.fn().mockResolvedValue({
          config: { allowMasterForceTransition: false },
        }),
      });
      const result = (await handleUpdateTask(ctx, {
        taskId: "task-1",
        status: "done",
        force: "true",
      })) as any;

      expect(result.success).toBe(false);
      expect(result.error).toBe(EXPECTED_ERROR);
    });

    it("should reject force from master when session config is missing the flag", async () => {
      const ctx = makeCtx({
        agentRole: "master",
        apiCall: vi.fn().mockResolvedValue({
          config: {},
        }),
      });
      const result = (await handleUpdateTask(ctx, {
        taskId: "task-1",
        status: "done",
        force: "true",
      })) as any;

      expect(result.success).toBe(false);
      expect(result.error).toBe(EXPECTED_ERROR);
    });

    it("should allow force from master when session flag is enabled", async () => {
      const apiCall = vi.fn();
      // First call: session config check
      apiCall.mockResolvedValueOnce({
        config: { allowMasterForceTransition: true },
      });
      // Second call: PUT task update
      apiCall.mockResolvedValueOnce({ id: "task-1", status: "done" });

      const ctx = makeCtx({ agentRole: "master", apiCall });
      const result = (await handleUpdateTask(ctx, {
        taskId: "task-1",
        status: "done",
        force: "true",
      })) as any;

      // Should have made an API call to update the task
      expect(result.success).not.toBe(false);
    });

    it("should reject force from master when session API call fails", async () => {
      const ctx = makeCtx({
        agentRole: "master",
        apiCall: vi.fn().mockRejectedValue(new Error("API error")),
      });
      const result = (await handleUpdateTask(ctx, {
        taskId: "task-1",
        status: "done",
        force: "true",
      })) as any;

      expect(result.success).toBe(false);
      expect(result.error).toBe(EXPECTED_ERROR);
    });
  });

  describe("non-force transitions", () => {
    it("should allow normal status updates without force for any role", async () => {
      const apiCall = vi.fn();
      // Workflow validation: session config
      apiCall.mockResolvedValueOnce({ config: {} });
      // GET current task
      apiCall.mockResolvedValueOnce({ status: "in-progress" });
      // PUT task update
      apiCall.mockResolvedValueOnce({ id: "task-1", status: "review" });

      const ctx = makeCtx({ agentRole: "worker", apiCall });
      const result = (await handleUpdateTask(ctx, {
        taskId: "task-1",
        status: "review",
      })) as any;

      // Should not be rejected by force restriction
      expect(result.error).not.toBe(EXPECTED_ERROR);
    });
  });

  describe("session config field", () => {
    it("should read allowMasterForceTransition from nested config", async () => {
      const apiCall = vi.fn();
      apiCall.mockResolvedValueOnce({
        config: { allowMasterForceTransition: true },
      });
      apiCall.mockResolvedValueOnce({ id: "task-1", status: "done" });

      const ctx = makeCtx({ agentRole: "master", apiCall });
      const result = (await handleUpdateTask(ctx, {
        taskId: "task-1",
        status: "done",
        force: "true",
      })) as any;

      expect(result.success).not.toBe(false);
      expect(apiCall).toHaveBeenCalledWith(
        "GET",
        "/api/v1/sessions/test-session",
      );
    });

    it("should read allowMasterForceTransition from flat response", async () => {
      const apiCall = vi.fn();
      // Session response with flat structure (no nested config)
      apiCall.mockResolvedValueOnce({
        allowMasterForceTransition: true,
      });
      apiCall.mockResolvedValueOnce({ id: "task-1", status: "done" });

      const ctx = makeCtx({ agentRole: "master", apiCall });
      const result = (await handleUpdateTask(ctx, {
        taskId: "task-1",
        status: "done",
        force: "true",
      })) as any;

      expect(result.success).not.toBe(false);
    });
  });
});
