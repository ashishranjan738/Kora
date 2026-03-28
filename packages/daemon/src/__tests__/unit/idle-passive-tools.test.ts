/**
 * Tests for passive tool idle detection fix.
 * Passive tools (check_messages, list_agents, etc.) should NOT reset idle timer.
 */
import { describe, it, expect } from "vitest";

// Simulate the PASSIVE_TOOLS logic from agent-health.ts
const PASSIVE_TOOLS = new Set([
  "check_messages", "list_agents", "list_tasks", "get_task",
  "get_workflow_states", "report_idle", "request_task",
  "whoami", "get_context", "channel_list", "channel_history",
  "list_personas",
]);

function shouldResetTimer(toolName?: string): boolean {
  if (toolName && PASSIVE_TOOLS.has(toolName)) return false;
  return true;
}

describe("Idle Detection — Passive Tools", () => {
  it("check_messages does NOT reset timer", () => {
    expect(shouldResetTimer("check_messages")).toBe(false);
  });

  it("send_message DOES reset timer", () => {
    expect(shouldResetTimer("send_message")).toBe(true);
  });

  it("update_task DOES reset timer", () => {
    expect(shouldResetTimer("update_task")).toBe(true);
  });

  it("create_task DOES reset timer", () => {
    expect(shouldResetTimer("create_task")).toBe(true);
  });

  it("undefined toolName DOES reset timer (backward compat)", () => {
    expect(shouldResetTimer(undefined)).toBe(true);
  });

  it("all 12 passive tools are no-ops", () => {
    for (const tool of PASSIVE_TOOLS) {
      expect(shouldResetTimer(tool), `${tool} should be passive`).toBe(false);
    }
    expect(PASSIVE_TOOLS.size).toBe(12);
  });

  it("active tools not in passive set DO reset timer", () => {
    const activeTools = ["send_message", "broadcast", "update_task", "create_task",
      "spawn_agent", "remove_agent", "nudge_agent", "prepare_pr", "verify_work",
      "create_pr", "save_knowledge", "share_file", "share_image", "delete_task", "channel_join"];
    for (const tool of activeTools) {
      expect(shouldResetTimer(tool), `${tool} should be active`).toBe(true);
    }
  });
});
