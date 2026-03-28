/**
 * Boot Prompt Builder — generates a system prompt that instructs agents to
 * load their full context via get_context() or kora-cli at startup, and
 * includes role-specific guardrails enforced at the system prompt level.
 *
 * The boot prompt is intentionally compact (<3KB) — full agent context
 * (persona, team, workflow, tasks, rules) comes from the daemon API.
 */

import type { MessagingMode } from "@kora/shared";

export interface BootPromptOptions {
  messagingMode?: MessagingMode;
  agentName?: string;
  agentRole?: "master" | "worker";
  /** Display role name (e.g. "Product Manager", "Reviewer") */
  roleName?: string;
  worktreeMode?: "isolated" | "shared";
  sessionName?: string;
  /** Pipeline state names for transition enforcement (e.g. ["backlog", "in-progress", "review", "done"]) */
  pipelineStates?: string[];
  /** Human-authored project rules from .kora.yml rules: array */
  rules?: string[];
}

/**
 * Role-specific hard constraints. These are enforced at the system prompt level,
 * which models prioritize over conversation-level instructions.
 */
const ROLE_CONSTRAINTS: Record<string, string> = {
  master: "COORDINATOR ONLY. Delegate ALL implementation to workers. NEVER write code directly. Plan, assign, review.",
  worker: "IMPLEMENTER. Follow the orchestrator's instructions. STOP immediately when told to wait. Work silently — no progress updates unless blocked.",
  "product manager": "Define requirements and specs. Do NOT write implementation code. Create tasks, not PRs.",
  reviewer: "Review code for bugs, style, and architecture. NEVER modify implementation files directly. Approve or request changes.",
  tester: "Write and run tests. Verify features work end-to-end. NEVER write implementation code — only test code.",
  researcher: "Research, analyze, and document findings. NEVER write implementation code. Report results to the team.",
};

function getRoleConstraint(roleName?: string, agentRole?: string): string {
  if (roleName) {
    const key = roleName.toLowerCase();
    if (ROLE_CONSTRAINTS[key]) return ROLE_CONSTRAINTS[key];
  }
  if (agentRole && ROLE_CONSTRAINTS[agentRole]) return ROLE_CONSTRAINTS[agentRole];
  return ROLE_CONSTRAINTS.worker; // Default to worker constraints
}

function buildIdentitySection(opts: BootPromptOptions): string {
  const parts: string[] = [];
  if (opts.agentName && opts.agentRole) {
    const session = opts.sessionName ? ` in session "${opts.sessionName}"` : "";
    const role = opts.roleName || opts.agentRole;
    parts.push(`You are ${opts.agentName}, a ${role} agent${session}. Your role: ${opts.agentRole}.`);
  }
  return parts.join(" ");
}

function buildGuardrailSection(opts: BootPromptOptions): string {
  const lines: string[] = [];

  // Role constraint
  const constraint = getRoleConstraint(opts.roleName, opts.agentRole);
  lines.push(`ROLE CONSTRAINT: ${constraint}`);

  // Workspace rules
  if (opts.worktreeMode === "shared") {
    lines.push("WORKSPACE: Shared repo. ONLY edit files assigned to you. NEVER force-push. Commit frequently to avoid conflicts.");
  } else if (opts.worktreeMode === "isolated") {
    lines.push("WORKSPACE: Isolated git worktree. Work freely within your worktree. Create PRs when ready.");
  }

  // Pipeline rules
  if (opts.pipelineStates && opts.pipelineStates.length > 0) {
    const pipeline = opts.pipelineStates.join(" → ");
    lines.push(`PIPELINE: ${pipeline}. MUST follow allowed transitions — update_task will REJECT invalid ones. Set status to the NEXT state, not directly to the final state.`);
  }

  // Project rules from .kora.yml
  if (opts.rules && opts.rules.length > 0) {
    lines.push("PROJECT RULES: " + opts.rules.join(" | "));
  }

  // Worker protocol essentials (worker-only)
  if (opts.agentRole === "worker") {
    lines.push("PROTOCOL: Acknowledge task → set in-progress → work silently → verify_work → ONE completion message → set done → STOP.");
  }

  return lines.join("\n");
}

/**
 * Build a boot prompt for an agent with optional role-specific guardrails.
 * Backward-compatible: calling with just messagingMode still works.
 */
export function buildBootPrompt(messagingModeOrOptions?: MessagingMode | BootPromptOptions): string {
  // Backward compatibility: accept string or options object
  const opts: BootPromptOptions = typeof messagingModeOrOptions === "string"
    ? { messagingMode: messagingModeOrOptions }
    : messagingModeOrOptions || {};

  const mode = opts.messagingMode || "mcp";
  const identity = buildIdentitySection(opts);
  const guardrails = (opts.agentName || opts.agentRole) ? buildGuardrailSection(opts) : "";

  if (mode === "cli") {
    return [
      `You are a Kora agent — part of a multi-agent team managed by the Kora orchestration platform.`,
      identity ? `\n${identity}` : "",
      guardrails ? `\n${guardrails}` : "",
      `\nFIRST ACTION: Run \`kora-cli context all\` to load your complete role, team, tasks, workflow, and rules.`,
      `\nCore commands:`,
      `- kora-cli context all — load your full context`,
      `- kora-cli send <name> <message> — message a teammate`,
      `- kora-cli messages — read your inbox`,
      `- kora-cli tasks — see your task assignments`,
      `- kora-cli task update <id> --status <s> — update task progress`,
      `\nRULES:`,
      `- NEVER read .kora/ files directly — use kora-cli commands only`,
      `- NEVER curl or fetch the daemon API directly — use kora-cli commands only`,
      `- NEVER query SQLite databases directly`,
      `- Use ONLY the kora-cli commands listed above for all Kora interactions`,
      `\nYou MUST run \`kora-cli context all\` before doing anything else.`,
    ].filter(Boolean).join("\n");
  }

  if (mode === "terminal") {
    return [
      `You are a Kora agent — part of a multi-agent team managed by the Kora orchestration platform.`,
      identity ? `\n${identity}` : "",
      guardrails ? `\n${guardrails}` : "",
      `\nCommunicate with teammates using @mentions:`,
      `- @AgentName: your message — send to a specific agent`,
      `- @all: your message — broadcast to everyone`,
      `\nRULES:`,
      `- NEVER read .kora/ files directly`,
      `- NEVER curl or fetch the daemon API directly`,
      `- Use @mentions for all communication`,
      `\nCheck your system prompt for your full role and team details.`,
    ].filter(Boolean).join("\n");
  }

  // MCP mode (default) — also covers "manual" mode
  return [
    `You are a Kora agent — part of a multi-agent team managed by the Kora orchestration platform.`,
    identity ? `\n${identity}` : "",
    guardrails ? `\n${guardrails}` : "",
    `\nFIRST ACTION: Call get_context("all") to load your complete role, team, tasks, workflow, and rules.`,
    `\nCore tools:`,
    `- get_context(resource) — load your context ("all", "team", "tasks", "workflow", "rules", "persona")`,
    `- send_message(to, message) — message a teammate`,
    `- check_messages() — read your inbox`,
    `- list_tasks() — see your task assignments`,
    `- update_task(taskId, status, comment) — update task progress`,
    `\nRULES:`,
    `- NEVER read .kora/ files directly — use MCP tools only`,
    `- NEVER curl or fetch the daemon API directly — use MCP tools only`,
    `- NEVER query SQLite databases directly`,
    `- Use ONLY the MCP tools listed above for all Kora interactions`,
    `\nYou MUST call get_context("all") before doing anything else.`,
  ].filter(Boolean).join("\n");
}
