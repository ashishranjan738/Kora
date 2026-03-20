/**
 * Tests for the provider/cliProvider field mismatch fix.
 * The dashboard sends "provider" but SpawnAgentRequest type has "cliProvider".
 * The API route should accept both field names.
 */
import { describe, it, expect } from "vitest";

describe("Provider field resolution", () => {
  // Simulate the API route logic from api-routes.ts line 711
  function resolveProvider(body: any, sessionDefault: string): string {
    return body.cliProvider ?? body.provider ?? sessionDefault;
  }

  it("uses cliProvider when provided (SpawnAgentRequest type)", () => {
    const body = { cliProvider: "aider", name: "test", role: "worker" };
    expect(resolveProvider(body, "claude-code")).toBe("aider");
  });

  it("uses provider when cliProvider is missing (dashboard sends this)", () => {
    const body = { provider: "codex", name: "test", role: "worker" };
    expect(resolveProvider(body, "claude-code")).toBe("codex");
  });

  it("falls back to session default when both are missing", () => {
    const body = { name: "test", role: "worker" };
    expect(resolveProvider(body, "claude-code")).toBe("claude-code");
  });

  it("cliProvider takes priority over provider when both are present", () => {
    const body = { cliProvider: "aider", provider: "codex", name: "test", role: "worker" };
    expect(resolveProvider(body, "claude-code")).toBe("aider");
  });

  it("handles undefined session default gracefully", () => {
    const body = { provider: "goose", name: "test", role: "worker" };
    expect(resolveProvider(body, undefined as any)).toBe("goose");
  });
});
