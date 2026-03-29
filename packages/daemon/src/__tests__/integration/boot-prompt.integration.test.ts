/**
 * Integration tests for boot prompt builder.
 * Tests persona content, messaging modes, role constraints.
 */

import { describe, it, expect } from "vitest";
import { buildBootPrompt } from "../../core/boot-prompt-builder.js";

describe("Boot prompt builder", () => {
  it("boot prompt includes identity, core tools, and rules sections", () => {
    const prompt = buildBootPrompt({
      agentName: "Dev 1", agentId: "dev-1-abc", agentRole: "worker",
      sessionName: "test-session", messagingMode: "mcp",
    });

    expect(prompt).toContain("Dev 1");
    expect(prompt).toContain("worker");
    expect(prompt).toContain("test-session");
    expect(prompt).toContain("get_context");
    expect(prompt).toContain("send_message");
    expect(prompt).toContain("check_messages");
  });

  it("boot prompt includes persona content when provided", () => {
    const prompt = buildBootPrompt({
      agentName: "Tester", agentId: "tester-xyz", agentRole: "worker",
      sessionName: "test-session", messagingMode: "mcp",
      personaContent: "## Identity\nYou are a testing specialist.\n\n## Goal\nEnsure code quality.",
    });

    expect(prompt).toContain("testing specialist");
    expect(prompt).toContain("Ensure code quality");
  });

  it("CLI mode boot prompt includes kora-cli instructions", () => {
    const prompt = buildBootPrompt({
      agentName: "Dev CLI", agentId: "dev-cli", agentRole: "worker",
      sessionName: "test-session", messagingMode: "cli",
    });

    expect(prompt).toContain("kora-cli");
  });

  it("master role includes coordinator constraint", () => {
    const prompt = buildBootPrompt({
      agentName: "EM", agentId: "em-1", agentRole: "master",
      sessionName: "test-session", messagingMode: "mcp",
    });

    expect(prompt.toLowerCase()).toContain("master");
  });

  it("worker role includes worker protocol", () => {
    const prompt = buildBootPrompt({
      agentName: "Dev", agentId: "dev-1", agentRole: "worker",
      sessionName: "test-session", messagingMode: "mcp",
    });

    expect(prompt.toLowerCase()).toContain("worker");
  });

  it("boot prompt without persona is shorter than with persona", () => {
    const opts = { agentName: "Dev", agentId: "dev-1", agentRole: "worker", sessionName: "test-session", messagingMode: "mcp" as const };
    const shortPrompt = buildBootPrompt(opts);
    const longPrompt = buildBootPrompt({ ...opts, personaContent: "A".repeat(5000) });

    expect(longPrompt.length).toBeGreaterThan(shortPrompt.length);
  });
});
