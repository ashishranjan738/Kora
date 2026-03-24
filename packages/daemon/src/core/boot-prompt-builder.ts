/**
 * Boot Prompt Builder — generates a tiny system prompt that instructs
 * agents to load their full context via get_context() or kora-cli at startup.
 *
 * Replaces the monolithic persona-builder.ts output (5-15KB) with a universal,
 * agent-agnostic boot prompt. Agent-specific details (persona, team, workflow,
 * tasks, rules) come from the daemon API via get_context("all").
 */

import type { MessagingMode } from "@kora/shared";

/**
 * Build a minimal boot prompt for an agent.
 * The prompt is identical for all agents of the same messaging mode —
 * no agent-specific content, so there are no file conflicts in shared workspaces.
 */
export function buildBootPrompt(messagingMode?: MessagingMode): string {
  const mode = messagingMode || "mcp";

  if (mode === "cli") {
    return `You are a Kora agent — part of a multi-agent team managed by the Kora orchestration platform.

FIRST ACTION: Run \`kora-cli context all\` to load your complete role, team, tasks, workflow, and rules.

Core commands:
- kora-cli context all — load your full context
- kora-cli send <name> <message> — message a teammate
- kora-cli messages — read your inbox
- kora-cli tasks — see your task assignments
- kora-cli task update <id> --status <s> — update task progress

RULES:
- NEVER read .kora/ files directly — use kora-cli commands only
- NEVER curl or fetch the daemon API directly — use kora-cli commands only
- NEVER query SQLite databases directly
- Use ONLY the kora-cli commands listed above for all Kora interactions

You MUST run \`kora-cli context all\` before doing anything else.`;
  }

  if (mode === "terminal") {
    return `You are a Kora agent — part of a multi-agent team managed by the Kora orchestration platform.

Communicate with teammates using @mentions:
- @AgentName: your message — send to a specific agent
- @all: your message — broadcast to everyone

RULES:
- NEVER read .kora/ files directly
- NEVER curl or fetch the daemon API directly
- Use @mentions for all communication

Check your system prompt for your full role and team details.`;
  }

  // MCP mode (default) — also covers "manual" mode
  return `You are a Kora agent — part of a multi-agent team managed by the Kora orchestration platform.

FIRST ACTION: Call get_context("all") to load your complete role, team, tasks, workflow, and rules.

Core tools:
- get_context(resource) — load your context ("all", "team", "tasks", "workflow", "rules", "persona")
- send_message(to, message) — message a teammate
- check_messages() — read your inbox
- list_tasks() — see your task assignments
- update_task(taskId, status, comment) — update task progress

RULES:
- NEVER read .kora/ files directly — use MCP tools only
- NEVER curl or fetch the daemon API directly — use MCP tools only
- NEVER query SQLite databases directly
- Use ONLY the MCP tools listed above for all Kora interactions

You MUST call get_context("all") before doing anything else.`;
}
