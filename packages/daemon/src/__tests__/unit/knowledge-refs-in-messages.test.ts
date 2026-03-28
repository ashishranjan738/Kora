/**
 * Tests for knowledge references in send_message and broadcast (task 7a554bbd).
 *
 * Verifies:
 * - Explicit knowledgeKeys validated and appended as footer
 * - Invalid keys rejected with clear error
 * - Auto-detection of knowledge:key patterns
 * - Deduplication of explicit + auto-detected keys
 * - Messages without knowledgeKeys unchanged
 * - broadcast supports knowledgeKeys too
 */
import { describe, it, expect, vi } from "vitest";
import type { ToolContext } from "../../tools/tool-context.js";
import { handleSendMessage, handleBroadcast } from "../../tools/tool-handlers.js";

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

describe("knowledge references in send_message", () => {
  describe("explicit knowledgeKeys", () => {
    it("should append footer when valid knowledgeKeys provided", async () => {
      const apiCall = vi.fn();
      // Knowledge validation: key exists
      apiCall.mockResolvedValueOnce({ key: "arch-doc", value: "Architecture..." });
      // GET agents
      apiCall.mockResolvedValueOnce({
        agents: [
          { id: "agent-1", config: { name: "Dev 1" } },
          { id: "agent-2", config: { name: "Dev 2" } },
        ],
      });
      // POST relay
      apiCall.mockResolvedValueOnce({ success: true });

      const ctx = makeCtx({ apiCall });
      const result = (await handleSendMessage(ctx, {
        to: "Dev 2",
        message: "Check the architecture doc",
        knowledgeKeys: ["arch-doc"],
      } as any)) as any;

      expect(result.success).toBe(true);
      expect(result.knowledgeRefs).toEqual(["arch-doc"]);
      // Verify the relay call included the footer
      const relayCall = apiCall.mock.calls.find(c => c[1].includes("/relay"));
      expect(relayCall).toBeDefined();
      expect(relayCall![2].message).toContain("📎 Attached knowledge");
      expect(relayCall![2].message).toContain("→ arch-doc");
    });

    it("should reject when explicit key does not exist", async () => {
      const apiCall = vi.fn();
      // Knowledge validation: key not found
      apiCall.mockResolvedValueOnce({ error: "Not found" });

      const ctx = makeCtx({ apiCall });
      const result = (await handleSendMessage(ctx, {
        to: "Dev 2",
        message: "Check this",
        knowledgeKeys: ["nonexistent-key"],
      } as any)) as any;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Knowledge key(s) not found: nonexistent-key");
    });

    it("should handle multiple valid keys", async () => {
      const apiCall = vi.fn();
      // Key 1 valid
      apiCall.mockResolvedValueOnce({ key: "key-1", value: "..." });
      // Key 2 valid
      apiCall.mockResolvedValueOnce({ key: "key-2", value: "..." });
      // GET agents
      apiCall.mockResolvedValueOnce({
        agents: [
          { id: "agent-1", config: { name: "Dev 1" } },
          { id: "agent-2", config: { name: "Dev 2" } },
        ],
      });
      // POST relay
      apiCall.mockResolvedValueOnce({ success: true });

      const ctx = makeCtx({ apiCall });
      const result = (await handleSendMessage(ctx, {
        to: "Dev 2",
        message: "Read these docs",
        knowledgeKeys: ["key-1", "key-2"],
      } as any)) as any;

      expect(result.success).toBe(true);
      expect(result.knowledgeRefs).toEqual(["key-1", "key-2"]);
    });
  });

  describe("auto-detection of knowledge:key patterns", () => {
    it("should auto-detect knowledge:key-name in message", async () => {
      const apiCall = vi.fn();
      // Auto-detected key validation
      apiCall.mockResolvedValueOnce({ key: "api-spec", value: "..." });
      // GET agents
      apiCall.mockResolvedValueOnce({
        agents: [
          { id: "agent-1", config: { name: "Dev 1" } },
          { id: "agent-2", config: { name: "Dev 2" } },
        ],
      });
      // POST relay
      apiCall.mockResolvedValueOnce({ success: true });

      const ctx = makeCtx({ apiCall });
      const result = (await handleSendMessage(ctx, {
        to: "Dev 2",
        message: "See knowledge:api-spec for details",
      } as any)) as any;

      expect(result.success).toBe(true);
      expect(result.knowledgeRefs).toEqual(["api-spec"]);
    });

    it("should skip auto-detected keys that don't exist (no error)", async () => {
      const apiCall = vi.fn();
      // Auto-detected key doesn't exist
      apiCall.mockRejectedValueOnce(new Error("Not found"));
      // GET agents
      apiCall.mockResolvedValueOnce({
        agents: [
          { id: "agent-1", config: { name: "Dev 1" } },
          { id: "agent-2", config: { name: "Dev 2" } },
        ],
      });
      // POST relay
      apiCall.mockResolvedValueOnce({ success: true });

      const ctx = makeCtx({ apiCall });
      const result = (await handleSendMessage(ctx, {
        to: "Dev 2",
        message: "Check knowledge:nonexistent for info",
      } as any)) as any;

      // Should succeed — auto-detected invalid keys are silently ignored
      expect(result.success).toBe(true);
      expect(result.knowledgeRefs).toBeUndefined();
    });

    it("should not capture trailing punctuation in knowledge:key patterns", async () => {
      const apiCall = vi.fn();
      // Key without trailing period
      apiCall.mockResolvedValueOnce({ key: "api-spec", value: "..." });
      // GET agents
      apiCall.mockResolvedValueOnce({
        agents: [
          { id: "agent-1", config: { name: "Dev 1" } },
          { id: "agent-2", config: { name: "Dev 2" } },
        ],
      });
      // POST relay
      apiCall.mockResolvedValueOnce({ success: true });

      const ctx = makeCtx({ apiCall });
      const result = (await handleSendMessage(ctx, {
        to: "Dev 2",
        message: "See knowledge:api-spec.",
      } as any)) as any;

      expect(result.success).toBe(true);
      expect(result.knowledgeRefs).toEqual(["api-spec"]);
      // Verify the key validated was "api-spec" not "api-spec."
      const knowledgeCall = apiCall.mock.calls.find(c => c[1].includes("/knowledge-db/"));
      expect(knowledgeCall![1]).toContain("api-spec");
      expect(knowledgeCall![1]).not.toContain("api-spec.");
    });

    it("should detect multiple knowledge:key patterns", async () => {
      const apiCall = vi.fn();
      // Key 1 valid
      apiCall.mockResolvedValueOnce({ key: "k1", value: "..." });
      // Key 2 valid
      apiCall.mockResolvedValueOnce({ key: "k2", value: "..." });
      // GET agents
      apiCall.mockResolvedValueOnce({
        agents: [
          { id: "agent-1", config: { name: "Dev 1" } },
          { id: "agent-2", config: { name: "Dev 2" } },
        ],
      });
      // POST relay
      apiCall.mockResolvedValueOnce({ success: true });

      const ctx = makeCtx({ apiCall });
      const result = (await handleSendMessage(ctx, {
        to: "Dev 2",
        message: "See knowledge:k1 and knowledge:k2",
      } as any)) as any;

      expect(result.success).toBe(true);
      expect(result.knowledgeRefs).toHaveLength(2);
    });
  });

  describe("deduplication", () => {
    it("should deduplicate explicit and auto-detected keys", async () => {
      const apiCall = vi.fn();
      // Only one validation call (deduplicated)
      apiCall.mockResolvedValueOnce({ key: "same-key", value: "..." });
      // GET agents
      apiCall.mockResolvedValueOnce({
        agents: [
          { id: "agent-1", config: { name: "Dev 1" } },
          { id: "agent-2", config: { name: "Dev 2" } },
        ],
      });
      // POST relay
      apiCall.mockResolvedValueOnce({ success: true });

      const ctx = makeCtx({ apiCall });
      const result = (await handleSendMessage(ctx, {
        to: "Dev 2",
        message: "See knowledge:same-key for details",
        knowledgeKeys: ["same-key"],
      } as any)) as any;

      expect(result.success).toBe(true);
      expect(result.knowledgeRefs).toEqual(["same-key"]);
      // Should only validate once (deduplicated)
      const knowledgeCalls = apiCall.mock.calls.filter(c => c[1].includes("/knowledge-db/"));
      expect(knowledgeCalls).toHaveLength(1);
    });
  });

  describe("no knowledge keys", () => {
    it("should not modify message when no knowledgeKeys and no patterns", async () => {
      const apiCall = vi.fn();
      // GET agents
      apiCall.mockResolvedValueOnce({
        agents: [
          { id: "agent-1", config: { name: "Dev 1" } },
          { id: "agent-2", config: { name: "Dev 2" } },
        ],
      });
      // POST relay
      apiCall.mockResolvedValueOnce({ success: true });

      const ctx = makeCtx({ apiCall });
      const result = (await handleSendMessage(ctx, {
        to: "Dev 2",
        message: "Hello!",
      } as any)) as any;

      expect(result.success).toBe(true);
      expect(result.knowledgeRefs).toBeUndefined();
      // Message should not have footer
      const relayCall = apiCall.mock.calls.find(c => c[1].includes("/relay"));
      expect(relayCall![2].message).toBe("Hello!");
    });
  });
});

describe("knowledge references in broadcast", () => {
  it("should append footer when valid knowledgeKeys provided", async () => {
    const apiCall = vi.fn();
    // Knowledge validation
    apiCall.mockResolvedValueOnce({ key: "release-notes", value: "..." });
    // POST broadcast
    apiCall.mockResolvedValueOnce({ success: true });

    const ctx = makeCtx({ apiCall });
    const result = (await handleBroadcast(ctx, {
      message: "New release notes available",
      knowledgeKeys: ["release-notes"],
    } as any)) as any;

    expect(result.success).toBe(true);
    expect(result.knowledgeRefs).toEqual(["release-notes"]);
    // Verify broadcast message includes footer
    const broadcastCall = apiCall.mock.calls.find(c => c[1].includes("/broadcast"));
    expect(broadcastCall![2].message).toContain("📎 Attached knowledge");
    expect(broadcastCall![2].message).toContain("→ release-notes");
  });

  it("should auto-detect knowledge:key in broadcast message", async () => {
    const apiCall = vi.fn();
    apiCall.mockResolvedValueOnce({ key: "ci-docs", value: "..." });
    apiCall.mockResolvedValueOnce({ success: true });

    const ctx = makeCtx({ apiCall });
    const result = (await handleBroadcast(ctx, {
      message: "Read knowledge:ci-docs for CI setup",
    } as any)) as any;

    expect(result.success).toBe(true);
    expect(result.knowledgeRefs).toEqual(["ci-docs"]);
  });

  it("should work without knowledge refs", async () => {
    const apiCall = vi.fn();
    apiCall.mockResolvedValueOnce({ success: true });

    const ctx = makeCtx({ apiCall });
    const result = (await handleBroadcast(ctx, {
      message: "Status update: all good",
    } as any)) as any;

    expect(result.success).toBe(true);
    expect(result.knowledgeRefs).toBeUndefined();
  });
});
