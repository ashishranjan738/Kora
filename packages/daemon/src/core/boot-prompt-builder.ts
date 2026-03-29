/**
 * Boot Prompt Builder — generates the full system prompt for Kora agents.
 *
 * Combines identity, role constraints, core tools reference, and rules
 * into the system prompt header. When persona content is provided,
 * it's appended to create the complete ~8-10KB prompt.
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
  /** Full persona content (from buildPersona). When provided, merged into the prompt. */
  personaContent?: string;
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
  return ROLE_CONSTRAINTS.worker;
}

function buildIdentityBlock(opts: BootPromptOptions): string {
  const lines: string[] = [];

  if (opts.agentName && opts.agentRole) {
    const session = opts.sessionName ? ` in session "${opts.sessionName}"` : "";
    const role = opts.roleName || opts.agentRole;
    lines.push(`You are ${opts.agentName}, a ${role} agent${session}. Your role: ${opts.agentRole}.`);
  }

  const constraint = getRoleConstraint(opts.roleName, opts.agentRole);
  lines.push(`ROLE CONSTRAINT: ${constraint}`);

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

  if (opts.agentRole === "worker") {
    lines.push("PROTOCOL: Acknowledge task → set in-progress → work silently → ONE completion message → set done → STOP.");
  }

  return lines.join("\n");
}

function buildCoreToolsBlock(mode: MessagingMode): string {
  if (mode === "cli") {
    return [
      "Core commands:",
      "- kora-cli context all — load your full context",
      "- kora-cli send <name> <message> — message a teammate",
      "- kora-cli messages — read your inbox",
      "- kora-cli tasks — see your task assignments",
      "- kora-cli task update <id> --status <s> — update task progress",
    ].join("\n");
  }

  if (mode === "terminal") {
    return [
      "Communicate with teammates using @mentions:",
      "- @AgentName: your message — send to a specific agent",
      "- @all: your message — broadcast to everyone",
    ].join("\n");
  }

  // MCP mode
  return [
    "Core tools:",
    "- get_context(resource) — load your context (\"all\", \"team\", \"tasks\", \"workflow\", \"rules\", \"persona\")",
    "- send_message(to, message) — message a teammate",
    "- check_messages() — read your inbox",
    "- list_tasks() — see your task assignments",
    "- update_task(taskId, status, comment) — update task progress",
  ].join("\n");
}

function buildRulesBlock(mode: MessagingMode): string {
  if (mode === "cli") {
    return [
      "RULES:",
      "- NEVER read .kora/ files directly — use kora-cli commands only",
      "- NEVER curl or fetch the daemon API directly — use kora-cli commands only",
      "- NEVER query SQLite databases directly",
      "- Use ONLY the kora-cli commands listed above for all Kora interactions",
    ].join("\n");
  }

  if (mode === "terminal") {
    return [
      "RULES:",
      "- NEVER read .kora/ files directly",
      "- NEVER curl or fetch the daemon API directly",
      "- Use @mentions for all communication",
    ].join("\n");
  }

  return [
    "RULES:",
    "- NEVER read .kora/ files directly — use MCP tools only",
    "- NEVER curl or fetch the daemon API directly — use MCP tools only",
    "- NEVER query SQLite databases directly",
    "- Use ONLY the MCP tools listed above for all Kora interactions",
  ].join("\n");
}

/**
 * Build the system prompt for an agent.
 *
 * When personaContent is provided (from buildPersona()), generates a full ~8-10KB
 * prompt with all sections. Otherwise generates a compact boot prompt for backward compat.
 */
export function buildBootPrompt(messagingModeOrOptions?: MessagingMode | BootPromptOptions): string {
  const opts: BootPromptOptions = typeof messagingModeOrOptions === "string"
    ? { messagingMode: messagingModeOrOptions }
    : messagingModeOrOptions || {};

  const mode = opts.messagingMode || "mcp";
  const header = "You are a Kora agent — part of a multi-agent team managed by the Kora orchestration platform.";
  const identity = (opts.agentName || opts.agentRole) ? buildIdentityBlock(opts) : "";
  const coreTools = buildCoreToolsBlock(mode);
  const rules = buildRulesBlock(mode);

  // Full prompt: header → identity → persona content → tools → rules
  if (opts.personaContent) {
    return [
      header,
      "",
      identity,
      "",
      opts.personaContent,
      "",
      coreTools,
      "",
      rules,
    ].filter(line => line !== undefined).join("\n");
  }

  // Compact boot prompt (backward compat — no persona data provided)
  if (mode === "cli") {
    return [
      header,
      identity ? `\n${identity}` : "",
      `\nFIRST ACTION: Run \`kora-cli context all\` to load your complete role, team, tasks, workflow, and rules.`,
      `\n${coreTools}`,
      `\n${rules}`,
      `\nYou MUST run \`kora-cli context all\` before doing anything else.`,
    ].filter(Boolean).join("\n");
  }

  if (mode === "terminal") {
    return [
      header,
      identity ? `\n${identity}` : "",
      `\n${coreTools}`,
      `\n${rules}`,
      `\nCheck your system prompt for your full role and team details.`,
    ].filter(Boolean).join("\n");
  }

  // MCP compact (fallback when no persona content)
  return [
    header,
    identity ? `\n${identity}` : "",
    `\nFIRST ACTION: Call get_context("all") to load your complete role, team, tasks, workflow, and rules.`,
    `\n${coreTools}`,
    `\n${rules}`,
    `\nYou MUST call get_context("all") before doing anything else.`,
  ].filter(Boolean).join("\n");
}
