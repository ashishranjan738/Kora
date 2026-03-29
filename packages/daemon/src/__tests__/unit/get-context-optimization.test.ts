/**
 * Tests for get_context("all") optimization (task 04202703).
 *
 * Verifies that "all" skips persona and communication (already in system prompt),
 * while individual resource requests still work.
 */
import { describe, it, expect, vi } from "vitest";
import type { ToolContext } from "../../tools/tool-context.js";
import { handleGetContext } from "../../tools/tool-handlers.js";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: "agent-1",
    sessionId: "test-session",
    agentRole: "worker",
    projectPath: "/tmp/test",
    apiCall: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe("get_context optimization", () => {
  describe("get_context('all')", () => {
    it("should NOT include persona in 'all' response", async () => {
      const ctx = makeCtx();
      const result = (await handleGetContext(ctx, { resource: "all" })) as Record<string, unknown>;
      expect(result).not.toHaveProperty("persona");
    });

    it("should NOT include communication in 'all' response", async () => {
      const ctx = makeCtx();
      const result = (await handleGetContext(ctx, { resource: "all" })) as Record<string, unknown>;
      expect(result).not.toHaveProperty("communication");
    });

    it("should include team in 'all' response", async () => {
      const ctx = makeCtx();
      const result = (await handleGetContext(ctx, { resource: "all" })) as Record<string, unknown>;
      expect(result).toHaveProperty("team");
    });

    it("should include workflow in 'all' response", async () => {
      const ctx = makeCtx();
      const result = (await handleGetContext(ctx, { resource: "all" })) as Record<string, unknown>;
      expect(result).toHaveProperty("workflow");
    });

    it("should include knowledge in 'all' response", async () => {
      const ctx = makeCtx();
      const result = (await handleGetContext(ctx, { resource: "all" })) as Record<string, unknown>;
      expect(result).toHaveProperty("knowledge");
    });

    it("should include tasks in 'all' response", async () => {
      const ctx = makeCtx();
      const result = (await handleGetContext(ctx, { resource: "all" })) as Record<string, unknown>;
      expect(result).toHaveProperty("tasks");
    });

    it("should include rules in 'all' response", async () => {
      const ctx = makeCtx();
      const result = (await handleGetContext(ctx, { resource: "all" })) as Record<string, unknown>;
      expect(result).toHaveProperty("rules");
    });

    it("should include workspace in 'all' response", async () => {
      const ctx = makeCtx();
      const result = (await handleGetContext(ctx, { resource: "all" })) as Record<string, unknown>;
      expect(result).toHaveProperty("workspace");
    });
  });

  describe("individual resource requests still work", () => {
    it("get_context('persona') should still return persona", async () => {
      const apiCall = vi.fn().mockResolvedValue({ persona: "You are a developer" });
      const ctx = makeCtx({ apiCall });
      const result = (await handleGetContext(ctx, { resource: "persona" })) as any;
      expect(result).toBeDefined();
      // Should have called the persona API
      expect(apiCall).toHaveBeenCalledWith("GET", expect.stringContaining("/persona"));
    });

    it("get_context('communication') should still return communication", async () => {
      const apiCall = vi.fn().mockResolvedValue({ persona: "## Communication Protocol\nUse send_message()" });
      const ctx = makeCtx({ apiCall });
      const result = (await handleGetContext(ctx, { resource: "communication" })) as any;
      expect(result).toBeDefined();
    });

    it("get_context('team') should return team data", async () => {
      const apiCall = vi.fn().mockResolvedValue({ agents: [{ id: "a1", config: { name: "Dev 1" } }] });
      const ctx = makeCtx({ apiCall });
      const result = (await handleGetContext(ctx, { resource: "team" })) as any;
      expect(result).toBeDefined();
    });
  });

  describe("validation", () => {
    it("should reject invalid resource names", async () => {
      const ctx = makeCtx();
      const result = (await handleGetContext(ctx, { resource: "invalid" })) as any;
      expect(result.error).toContain("Invalid resource");
    });

    it("should default to 'all' when no resource specified", async () => {
      const ctx = makeCtx();
      const result = (await handleGetContext(ctx, {})) as Record<string, unknown>;
      // Should return dynamic resources, not persona
      expect(result).toHaveProperty("team");
      expect(result).not.toHaveProperty("persona");
    });
  });
});
