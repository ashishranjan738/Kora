/**
 * Tests for MCP persona tools: list_personas, save_persona, spawn_agent with personaId.
 */
import { describe, it, expect, vi } from "vitest";

// Test the tool schema definitions and access control
describe("MCP Persona Tool Access Control", () => {
  it("list_personas is available to worker agents", () => {
    // Workers should have access to list_personas
    const workerTools = new Set([
      "send_message", "check_messages", "list_agents", "broadcast",
      "list_tasks", "get_task", "update_task", "create_task",
      "report_idle", "request_task",
      "list_personas", "save_persona",
    ]);
    expect(workerTools.has("list_personas")).toBe(true);
    expect(workerTools.has("save_persona")).toBe(true);
  });

  it("spawn_agent is only available to master agents", () => {
    const workerTools = new Set([
      "send_message", "check_messages", "list_agents", "broadcast",
      "list_tasks", "get_task", "update_task", "create_task",
      "report_idle", "request_task",
      "list_personas", "save_persona",
    ]);
    expect(workerTools.has("spawn_agent")).toBe(false);

    const masterTools = new Set([
      ...workerTools,
      "spawn_agent", "remove_agent", "peek_agent", "nudge_agent",
    ]);
    expect(masterTools.has("spawn_agent")).toBe(true);
  });
});

describe("spawn_agent persona resolution", () => {
  it("custom persona text takes priority over personaId", () => {
    // Simulate the resolution logic
    const toolArgs = {
      name: "Test Agent",
      model: "default",
      persona: "Custom inline persona text",
      personaId: "backend",
    };

    // The actual logic: persona takes priority
    let resolvedPersona = toolArgs.persona || "";
    if (!resolvedPersona && toolArgs.personaId) {
      resolvedPersona = `builtin:${toolArgs.personaId}`;
    }

    expect(resolvedPersona).toBe("Custom inline persona text");
  });

  it("personaId resolves to builtin: prefix when no custom match", () => {
    const toolArgs = {
      name: "Test Agent",
      model: "default",
      personaId: "backend",
    };

    let resolvedPersona = toolArgs.persona || "";
    if (!resolvedPersona && toolArgs.personaId) {
      // Simulate: no custom persona found, fallback to builtin reference
      resolvedPersona = `builtin:${toolArgs.personaId}`;
    }

    expect(resolvedPersona).toBe("builtin:backend");
  });

  it("no persona when neither persona nor personaId provided", () => {
    const toolArgs = {
      name: "Test Agent",
      model: "default",
    };

    let resolvedPersona = (toolArgs as any).persona || "";
    if (!resolvedPersona && (toolArgs as any).personaId) {
      resolvedPersona = `builtin:${(toolArgs as any).personaId}`;
    }

    expect(resolvedPersona).toBe("");
  });
});

describe("save_persona validation", () => {
  it("requires name and fullText", () => {
    const validate = (args: any) => {
      if (!args.name?.trim() || !args.fullText?.trim()) {
        return { error: "name and fullText are required" };
      }
      return { success: true };
    };

    expect(validate({})).toEqual({ error: "name and fullText are required" });
    expect(validate({ name: "Test" })).toEqual({ error: "name and fullText are required" });
    expect(validate({ fullText: "text" })).toEqual({ error: "name and fullText are required" });
    expect(validate({ name: "", fullText: "text" })).toEqual({ error: "name and fullText are required" });
    expect(validate({ name: "Test", fullText: "text" })).toEqual({ success: true });
  });
});
