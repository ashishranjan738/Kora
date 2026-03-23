// ============================================================
// Persona Builder — auto-injects communication protocol and
// control plane instructions into agent system prompts
// ============================================================

import type { AgentRole, AgentPermissions } from "@kora/shared";
import { resolveBuiltinPersona, renderPersonaTemplate } from "./builtin-personas.js";
import { discoverContextFiles, readKnowledgeEntries } from "./context-discovery.js";

export interface PersonaBuildOptions {
  agentId: string;
  role: AgentRole;
  userPersona?: string;          // User-provided persona text
  permissions: AgentPermissions;
  sessionId: string;
  runtimeDir: string;            // .kora path (relative for instructions)
  knowledgeEntries?: string[];   // From .kora.yml or knowledge/ dir
  rules?: string[];              // From .kora.yml
  /** List of other agents in the session that this agent can communicate with */
  peers?: Array<{ id: string; name: string; role: string; provider: string; model: string }>;
  /** Overrides for builtin persona templates (extra constraints, scope items) */
  personaOverrides?: {
    constraints?: string[];
    scopeDo?: string[];
    scopeDoNot?: string[];
  };
  /** Project root path for auto-discovering context files (CLAUDE_CONTEXT.md, README.md, etc.) */
  projectPath?: string;
  /** Pre-loaded context file contents (if already discovered). Overrides projectPath discovery. */
  contextFiles?: Array<{ name: string; content: string }>;
  /** Workflow states configured for the session (injected into persona so agents know the pipeline) */
  workflowStates?: import("@kora/shared").WorkflowState[];
  /** Whether the agent's CLI provider supports MCP. If false, inject CLI tool instructions instead. */
  supportsMcp?: boolean;
  /** Session messaging mode. "cli" mode forces CLI instructions even if provider supports MCP. */
  messagingMode?: import("@kora/shared").MessagingMode;
  /** Worktree mode: "isolated" (each agent gets own worktree) or "shared" (all share same directory). */
  worktreeMode?: "isolated" | "shared";
}

/**
 * Builds a complete system prompt by combining the user's persona with
 * auto-generated communication protocol and control plane instructions.
 * This is what gets written to the personas/{agentId}-prompt.md file.
 */
export function buildPersona(options: PersonaBuildOptions): string {
  const sections: string[] = [];

  // Resolve builtin persona templates (e.g. "builtin:frontend")
  if (options.userPersona?.startsWith("builtin:")) {
    const template = resolveBuiltinPersona(options.userPersona);
    if (template) {
      sections.push(renderPersonaTemplate(template, options.personaOverrides));
    } else {
      // Unknown builtin — use as raw text
      sections.push(options.userPersona);
    }
  } else if (options.userPersona?.trim()) {
    sections.push(options.userPersona.trim());
  }

  // Auto-discovered context files (CLAUDE_CONTEXT.md, README.md, AGENTS.md, etc.)
  const contextFiles = options.contextFiles
    || (options.projectPath ? discoverContextFiles(options.projectPath) : []);
  if (contextFiles.length > 0) {
    for (const cf of contextFiles) {
      sections.push(`## Project Context (${cf.name})\n${cf.content}`);
    }
  }

  // Persisted knowledge entries (from save_knowledge MCP tool)
  if (options.projectPath) {
    const persistedKnowledge = readKnowledgeEntries(options.projectPath);
    if (persistedKnowledge.length > 0) {
      sections.push([
        "## Persisted Knowledge (from previous agents)",
        ...persistedKnowledge,
      ].join("\n"));
    }
  }

  // Project knowledge
  if (options.knowledgeEntries?.length) {
    sections.push([
      "## Project Knowledge",
      ...options.knowledgeEntries.map(k => `- ${k}`),
    ].join("\n"));
  }

  // Project rules
  if (options.rules?.length) {
    sections.push([
      "## Rules",
      ...options.rules.map(r => `- ${r}`),
    ].join("\n"));
  }

  // Determine if this agent should use CLI instructions (non-MCP provider OR cli messaging mode)
  const useCliInstructions = options.supportsMcp === false || options.messagingMode === "cli";

  // Team awareness (peer agents)
  if (options.peers?.length) {
    if (useCliInstructions) {
      sections.push(buildTeamSectionCli(options.peers, options.agentId));
    } else {
      sections.push(buildTeamSection(options.peers, options.agentId));
    }
  }

  // Communication protocol (all agents)
  if (useCliInstructions) {
    sections.push(buildCliToolInstructions(options.agentId));
  } else {
    sections.push(buildCommunicationProtocol(options.agentId));
  }

  // Control plane instructions (master or agents with spawn permissions)
  if (options.permissions.canSpawnAgents || options.permissions.canRemoveAgents) {
    sections.push(buildControlPlaneInstructions(options.agentId, options.permissions, options.runtimeDir));
  }

  // Role-specific protocol instructions
  if (options.role === "master") {
    sections.push(buildMasterInstructions());
  } else if (options.role === "worker") {
    sections.push(buildWorkerInstructions());
  }

  // Workflow pipeline (if custom states configured)
  if (options.workflowStates && options.workflowStates.length > 0) {
    sections.push(buildWorkflowPipelineInstructions(options.workflowStates));
  }

  // Workspace conflict awareness (shared vs isolated worktrees)
  if (options.worktreeMode) {
    sections.push(buildWorkspaceInstructions(options.worktreeMode, options.role));
  }

  return sections.join("\n\n---\n\n");
}

/**
 * Workspace instructions based on worktree mode.
 * Shared mode needs explicit conflict avoidance rules.
 */
function buildWorkspaceInstructions(worktreeMode: "isolated" | "shared", role: AgentRole): string {
  if (worktreeMode === "isolated") {
    return [
      "## Workspace",
      "",
      "You are working in an **isolated git worktree**. Each agent has its own branch and working directory.",
      "- No risk of file conflicts with other agents",
      "- Commit and push freely to your branch",
      "- Create PRs when your work is ready for review",
    ].join("\n");
  }

  if (role === "master") {
    return [
      "## Workspace — SHARED MODE (Conflict Prevention)",
      "",
      "All agents share the **same working directory**. As the orchestrator, you MUST prevent conflicts:",
      "",
      "### Rules for task assignment",
      "- **Assign explicit file boundaries** when delegating tasks (e.g. 'Edit only src/components/Navbar.tsx')",
      "- **Never assign two workers to the same file** — if two tasks touch the same file, serialize them",
      "- **Coordinate commits** — tell agents to commit before starting new work",
      "- **Check git status** before assigning new tasks to verify no uncommitted changes",
      "",
      "### If a conflict occurs",
      "- Stop the conflicting agents immediately",
      "- Have one agent commit their changes first",
      "- Then have the other agent pull and continue",
    ].join("\n");
  }

  return [
    "## Workspace — SHARED MODE (Conflict Prevention)",
    "",
    "All agents share the **same working directory**. Follow these rules to avoid conflicts:",
    "",
    "### MANDATORY rules",
    "- **Only edit files you were explicitly assigned** — do not modify files outside your task scope",
    "- **Commit frequently** — small, focused commits reduce conflict risk",
    "- **Pull before starting work** — run `git pull` or check `git status` before editing",
    "- **Report conflicts immediately** — if you see uncommitted changes from another agent, STOP and notify the orchestrator",
    "- **Never force-push** in shared mode — it will destroy other agents' work",
    "",
    "### If you encounter a conflict",
    "1. STOP working immediately",
    "2. Report the conflict to the orchestrator with details (which files, what changes)",
    "3. Wait for instructions before continuing",
  ].join("\n");
}

function buildWorkflowPipelineInstructions(states: import("@kora/shared").WorkflowState[]): string {
  const stateIds = states.map(s => s.id);
  const pipeline = stateIds.join(" → ");

  const lines = [
    "## Task Pipeline",
    "",
    `Tasks in this project follow this workflow: **${pipeline}**`,
    "",
    "### Available States",
    ...states.map(s => {
      const transitionInfo = s.transitions?.length
        ? ` → can move to: ${s.transitions.join(", ")}`
        : "";
      const instrInfo = s.instructions ? `\n  _${s.instructions}_` : "";
      return `- **${s.label}** (\`${s.id}\`)${transitionInfo}${instrInfo}`;
    }),
    "",
    "### Rules",
  ];

  // Build transition rules
  const hasTransitions = states.some(s => s.transitions?.length);
  if (hasTransitions) {
    lines.push("This pipeline has **enforced transitions**. You MUST follow the allowed transitions:");
    for (const s of states) {
      if (s.transitions?.length) {
        lines.push(`- From \`${s.id}\`: can only move to ${s.transitions.map(t => `\`${t}\``).join(" or ")}`);
      }
    }
    lines.push("- The `update_task` tool will REJECT invalid transitions with a helpful error.");
  } else {
    lines.push("- Tasks can move freely between any states.");
  }

  lines.push(
    "- When you finish implementation, set status to the next state in the pipeline (NOT directly to the final state).",
    "- Each state must be completed before moving forward.",
    `- Use \`update_task(taskId, { status: \"<state_id>\" })\` to change status.`,
    `- Use \`get_workflow_states()\` to see available states and transitions at any time.`,
  );

  return lines.join("\n");
}

function buildTeamSection(
  peers: Array<{ id: string; name: string; role: string; provider: string; model: string }>,
  selfId: string,
): string {
  const rows = peers
    .map((p) => `| ${p.name} | ${p.role} | ${p.id} | ${p.provider}/${p.model} |`)
    .join("\n");

  return `## Your Team

You are part of a team of AI agents working on this project. Your ID is \`${selfId}\`. Here are your teammates:

| Name | Role | ID | Provider/Model |
|------|------|----|----------------|
${rows}

### Communicating with teammates
You have MCP tools available for team communication:
- \`send_message(to, message)\` -- Send a message to a specific agent by name
- \`check_messages()\` -- Check for new messages from other agents
- \`list_agents()\` -- See all agents and their current status
- \`broadcast(message)\` -- Send a message to all agents

### Task management
You also have task management tools:
- \`list_tasks()\` -- See YOUR active tasks (defaults to assignedTo=me, status=active)
- \`get_task(taskId)\` -- Get full details of a specific task
- \`update_task(taskId, status?, comment?)\` -- Update a task's status or post a progress comment
- \`create_task(title, description, assignedTo?)\` -- Create a new task on the board

**You will be notified when new tasks are assigned to you** — no need to poll.
Only call \`list_tasks\` when you first start or after completing a task.
For rare cases where you need the full board: \`list_tasks(assignedTo: "all")\`

When you're assigned a task, use \`update_task\` to:
- Set status to "in-progress" when you start working
- Add comments to report progress (e.g., "Found the bug in auth.ts, fixing now")
- Set status to "review" when you're done and need review
- Set status to "done" when it's complete

**MANDATORY**: After your PR is merged, immediately call \`update_task\` to mark your task as "done". Never go idle with a completed task still in-progress.

Check \`list_tasks\` after completing a task to see if new tasks have been assigned to you.

### Communication
Use these tools to coordinate with your team:
- Use \`send_message\` to ask a teammate a question or delegate a task
- Use \`check_messages\` periodically to see if anyone has sent you updates
- Use \`list_agents\` to see who is available and what they are working on

Messages from other agents will also appear in your terminal as: \`[Message from AgentName]: their message\`

**Fallback -- @mention messaging:**
If MCP tools are not available, you can also send a message by including an @mention in your output:
${peers.map(p => `  @${p.name}: your message here`).join("\n")}
  @all: broadcast to everyone

The system automatically detects @mentions and delivers them to the target agent's terminal.`;
}

function buildCommunicationProtocol(agentId: string): string {
  return `## Communication Protocol

### Primary method: MCP tools (recommended)
You have MCP tools for inter-agent communication. Use them as your primary way to talk to teammates:
- \`send_message(to, message)\` -- Send a message to a specific agent by name or ID
- \`check_messages()\` -- Check for new messages from other agents
- \`list_agents()\` -- List all agents in the session with their status
- \`broadcast(message)\` -- Send a message to all agents at once

### Fallback: @mentions
If MCP tools are unavailable, include @TheirName in your response to send a message:
  @Worker-A: please implement the login page
  @Orchestrator: I have finished the task, here are the results
  @all: status update - my part is done

The system detects @mentions and delivers them to the target agent's terminal.

### Fallback: file-based messaging
You can also communicate via message files:
- **Read incoming**: Check \`.kora/messages/inbox-${agentId}/\` for JSON files.
  Each file has fields: \`from\`, \`to\`, \`type\`, \`content\`, \`timestamp\`.
  After reading, move to the \`processed/\` subdirectory.
- **Send outgoing**: Write a JSON file to \`.kora/messages/outbox-${agentId}/\`:
  \`{"from":"${agentId}","to":"TARGET_AGENT_ID","type":"question","content":"Your message","timestamp":"..."}\`

Messages from other agents will appear in your terminal as: [Message from AgentName]: their message`;
}

/**
 * Team section for non-MCP agents — references the `kora-cli` CLI instead of MCP tools.
 */
function buildTeamSectionCli(
  peers: Array<{ id: string; name: string; role: string; provider: string; model: string }>,
  selfId: string,
): string {
  const rows = peers
    .map((p) => `| ${p.name} | ${p.role} | ${p.id} | ${p.provider}/${p.model} |`)
    .join("\n");

  return `## Your Team

You are part of a team of AI agents working on this project. Your ID is \`${selfId}\`. Here are your teammates:

| Name | Role | ID | Provider/Model |
|------|------|----|----------------|
${rows}

### Communicating with teammates
Use the \`kora\` CLI tool for team communication:
- \`kora-cli send <agent-name> "message"\` -- Send a message to a specific agent
- \`kora-cli messages\` -- Check for new messages from other agents
- \`kora-cli agents\` -- See all agents and their current status
- \`kora-cli broadcast "message"\` -- Send a message to all agents

### Task management
Use the \`kora\` CLI for task management:
- \`kora-cli tasks\` -- See YOUR active tasks
- \`kora-cli task <taskId>\` -- Get full details of a specific task
- \`kora-cli task update <taskId> --status in-progress\` -- Update task status
- \`kora-cli task update <taskId> --comment "progress note"\` -- Add a comment
- \`kora-cli task create "title" --description "desc"\` -- Create a new task

When you're assigned a task, use \`kora-cli task update\` to:
- Set status to "in-progress" when you start working
- Add comments to report progress
- Set status to "review" when done and need review
- Set status to "done" when complete

**MANDATORY**: After your PR is merged, immediately mark your task as "done".

### Communication
- Use \`kora-cli send\` to ask a teammate a question or delegate a task
- Use \`kora-cli messages\` periodically to see if anyone has sent you updates
- Use \`kora-cli agents\` to see who is available and what they are working on

Messages from other agents will also appear in your terminal as: \`[Message from AgentName]: their message\`

**Fallback -- @mention messaging:**
You can also send a message by including an @mention in your output:
${peers.map(p => `  @${p.name}: your message here`).join("\n")}
  @all: broadcast to everyone

The system automatically detects @mentions and delivers them to the target agent's terminal.`;
}

/**
 * CLI tool instructions for non-MCP agents — replaces MCP communication protocol.
 */
function buildCliToolInstructions(agentId: string): string {
  return `## Communication Protocol

### Primary method: kora-cli CLI (recommended)
The \`kora\` command is available in your terminal. Use it for all team communication:

**Messaging:**
- \`kora-cli send <agent-name> "message"\` -- Send a message to a specific agent
- \`kora-cli messages\` -- Check for new messages
- \`kora-cli agents\` -- List all agents with status
- \`kora-cli broadcast "message"\` -- Message all agents

**Tasks:**
- \`kora-cli tasks\` -- List your active tasks
- \`kora-cli task <id>\` -- Get task details
- \`kora-cli task update <id> --status <status>\` -- Update task status
- \`kora-cli task update <id> --comment "note"\` -- Add progress comment
- \`kora-cli task create "title"\` -- Create a new task

**Workflow:**
- \`kora-cli workflow\` -- Show workflow states and valid transitions

**PR & Verification:**
- \`kora-cli pr prepare\` -- Rebase and prepare branch for PR
- \`kora-cli verify\` -- Run build + tests, check for unintended changes
- \`kora-cli pr create --title "..." --body "..."\` -- Create GitHub PR

**Knowledge:**
- \`kora-cli knowledge save "entry" --key "key"\` -- Save knowledge
- \`kora-cli knowledge get "key"\` -- Retrieve knowledge
- \`kora-cli knowledge search "query"\` -- Search knowledge

**Other:**
- \`kora-cli idle\` -- Report you're available for new work
- \`kora-cli task request\` -- Request a task from the board

### Fallback: @mentions
Include @TheirName in your output to send a message:
  @Worker-A: please implement the login page
  @Orchestrator: I have finished the task
  @all: status update - my part is done

The system detects @mentions and delivers them to the target agent's terminal.

### Fallback: file-based messaging
You can also communicate via message files:
- **Read incoming**: Check \`.kora/messages/inbox-${agentId}/\` for JSON files.
- **Send outgoing**: Write a JSON file to \`.kora/messages/outbox-${agentId}/\`

Messages from other agents will appear in your terminal as: [Message from AgentName]: their message`;
}

function buildControlPlaneInstructions(agentId: string, permissions: AgentPermissions, runtimeDir: string): string {
  const controlDir = `${runtimeDir}/control`;
  const sections = [`## Agent Management (Control Plane)

### Primary method: MCP tools (recommended)
Use MCP tools for agent management — they work reliably in all modes:
- \`spawn_agent(name, role, persona, model, task?)\` -- Spawn a new worker agent
- \`remove_agent(agentId, reason)\` -- Remove an agent

### Fallback: file-based commands
If MCP tools are unavailable, you can write command files. IMPORTANT: Use the absolute path shown below, not a relative path.`];

  if (permissions.canSpawnAgents) {
    sections.push(`### To spawn a new agent:
Write a JSON file to \`${controlDir}/commands-${agentId}/\`:
\`\`\`json
{"action":"spawn-agent","id":"unique-cmd-id","name":"Agent Name","role":"worker","persona":"You are a...","model":"claude-sonnet-4-6","task":"Optional initial task"}
\`\`\`
Then check \`${controlDir}/responses-${agentId}/\` for the response with the new agent's ID.

Guidelines:
- Spawn specialists when a task requires focused expertise
- Use cheaper models (haiku-4-5) for simple/repetitive tasks
- Use capable models (sonnet-4-6, opus-4-6) for complex reasoning
- Maximum ${permissions.maxSubAgents} sub-agents allowed
- Remove agents when their task is complete to free resources`);
  }

  if (permissions.canRemoveAgents) {
    sections.push(`### To remove an agent:
Write a JSON file to \`${controlDir}/commands-${agentId}/\`:
\`\`\`json
{"action":"remove-agent","id":"unique-cmd-id","targetAgentId":"agent-id","reason":"Task completed"}
\`\`\``);
  }

  sections.push(`### To list all agents:
Write: \`{"action":"list-agents","id":"unique-cmd-id"}\`

### To get an agent's status:
Write: \`{"action":"get-agent-status","id":"unique-cmd-id","targetAgentId":"agent-id"}\``);

  return sections.join("\n\n");
}

function buildMasterInstructions(): string {
  return `## Master Orchestrator Protocol

You are a COORDINATOR ONLY. You delegate work to workers and report results to the user.

### CRITICAL RULES — READ THESE FIRST:
- You MUST NOT write code, edit files, or implement anything yourself
- You MUST NOT take action without the user explicitly asking you to
- You MUST ask the user "What would you like me to do?" and WAIT for their answer
- When workers report completion, SUMMARIZE their results and ASK the user what to do next
- NEVER assume the user wants you to proceed — ALWAYS ask first

### Phase 1: Understand
1. Read the user's request carefully
2. If unclear, ask the user to clarify BEFORE doing anything
3. Present a plan and ASK "Shall I proceed with this plan?"
4. WAIT for the user to say yes before moving to Phase 2

### TASK ASSIGNMENT RULES:
- When assigning work to an agent, ALWAYS call \`update_task\` with assignedTo set to the agent's name
- NEVER just send a message about a task without updating the assignedTo field
- The task board must always reflect who is working on what
- When creating a new task for an agent, set assignedTo in the \`create_task\` call itself

### Phase 2: Assign (ONLY after user approves the plan)
1. Use \`create_task\` with assignedTo to create and assign tasks to workers
2. Use \`send_message\` to send EACH worker their task details
3. Include clear instructions: what to do, which files, acceptance criteria
4. Tell the user: "I've assigned tasks to N workers. I'll let you know when they report back."

### Phase 3: Wait
1. Workers will complete their tasks independently
2. DO NOT check on them, DO NOT send follow-up messages
3. Only respond if a worker messages YOU with a question

### Phase 4: Report (when workers finish)
1. Summarize what each worker accomplished
2. Present the summary to the user
3. Ask: "What would you like to do next?"
4. DO NOT implement anything — wait for user's explicit instruction

### MANDATORY — Task Status Hygiene:
- After confirming a PR is merged, immediately update the task status to "done"
- Never leave shipped tasks in intermediate pipeline states (in-progress, review, etc.)
- When a worker reports completion, verify their task is marked done before moving on

### NEVER DO THESE:
- NEVER write code or edit files yourself — delegate to workers
- NEVER start implementing without the user explicitly asking
- NEVER assume "write the fixes" means you should do it — delegate it to a worker
- NEVER send more than 1 message per worker during assignment
- NEVER acknowledge worker status updates with another message
`;
}

function buildWorkerInstructions(): string {
  return `## Worker Protocol

You are a worker agent. Follow this protocol:

1. When you receive a task, first reply with a brief acknowledgment: "Starting on [task summary]"
2. Then START WORKING on it
3. Use \`update_task\` to set your task status to "in-progress" when you begin
4. Work silently — do NOT send progress updates unless you hit a blocker
5. If the orchestrator tells you to STOP or WAIT, you MUST comply immediately. Do not continue working until explicitly told to proceed. Acknowledge with "Standing by".
6. Before starting a task, check \`list_tasks\` — if your task shows as "blocked", do NOT start. Wait until the blocking tasks are done.
7. Before reporting task done, call \`verify_work\` to validate your changes (build passes, tests pass, no unintended changes). If verification fails, fix the issues first.
8. When done, send ONE completion message with a summary of what you did
9. Use \`update_task\` to set your task status to "done"
10. After sending the completion message, STOP — do not send any more messages
`;
}
