// ============================================================
// Persona Builder — auto-injects communication protocol and
// control plane instructions into agent system prompts
// ============================================================

import type { AgentRole, AgentPermissions } from "@kora/shared";

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
}

/**
 * Builds a complete system prompt by combining the user's persona with
 * auto-generated communication protocol and control plane instructions.
 * This is what gets written to the personas/{agentId}-prompt.md file.
 */
export function buildPersona(options: PersonaBuildOptions): string {
  const sections: string[] = [];

  // User-provided persona (if any)
  if (options.userPersona?.trim()) {
    sections.push(options.userPersona.trim());
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

  // Team awareness (peer agents)
  if (options.peers?.length) {
    sections.push(buildTeamSection(options.peers, options.agentId));
  }

  // Communication protocol (all agents)
  sections.push(buildCommunicationProtocol(options.agentId));

  // Control plane instructions (master or agents with spawn permissions)
  if (options.permissions.canSpawnAgents || options.permissions.canRemoveAgents) {
    sections.push(buildControlPlaneInstructions(options.agentId, options.permissions));
  }

  // Role-specific protocol instructions
  if (options.role === "master") {
    sections.push(buildMasterInstructions());
  } else if (options.role === "worker") {
    sections.push(buildWorkerInstructions());
  }

  return sections.join("\n\n---\n\n");
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
- \`list_tasks()\` -- See all tasks in the session, including ones assigned to you
- \`update_task(taskId, status?, comment?)\` -- Update a task's status or post a progress comment

When you're assigned a task, use \`update_task\` to:
- Set status to "in-progress" when you start working
- Add comments to report progress (e.g., "Found the bug in auth.ts, fixing now")
- Set status to "review" when you're done and need review
- Set status to "done" when it's complete

Check \`list_tasks\` periodically to see if new tasks have been assigned to you.

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

function buildControlPlaneInstructions(agentId: string, permissions: AgentPermissions): string {
  const sections = ["## Agent Management (Control Plane)\n\nYou can manage other agents by writing command files."];

  if (permissions.canSpawnAgents) {
    sections.push(`### To spawn a new agent:
Write a JSON file to \`.kora/control/commands-${agentId}/\`:
\`\`\`json
{"action":"spawn-agent","id":"unique-cmd-id","name":"Agent Name","role":"worker","persona":"You are a...","model":"claude-sonnet-4-6","task":"Optional initial task"}
\`\`\`
Then check \`.kora/control/responses-${agentId}/\` for the response with the new agent's ID.

Guidelines:
- Spawn specialists when a task requires focused expertise
- Use cheaper models (haiku-4-5) for simple/repetitive tasks
- Use capable models (sonnet-4-6, opus-4-6) for complex reasoning
- Maximum ${permissions.maxSubAgents} sub-agents allowed
- Remove agents when their task is complete to free resources`);
  }

  if (permissions.canRemoveAgents) {
    sections.push(`### To remove an agent:
Write a JSON file to \`.kora/control/commands-${agentId}/\`:
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

### Phase 2: Assign (ONLY after user approves the plan)
1. Use \`send_message\` to send EACH worker ONE specific task
2. Include clear instructions: what to do, which files, acceptance criteria
3. Tell the user: "I've assigned tasks to N workers. I'll let you know when they report back."

### Phase 3: Wait
1. Workers will complete their tasks independently
2. DO NOT check on them, DO NOT send follow-up messages
3. Only respond if a worker messages YOU with a question

### Phase 4: Report (when workers finish)
1. Summarize what each worker accomplished
2. Present the summary to the user
3. Ask: "What would you like to do next?"
4. DO NOT implement anything — wait for user's explicit instruction

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

1. When you receive a task, START WORKING on it immediately
2. DO NOT acknowledge the task — just do it
3. DO NOT send status updates — focus on completing the work
4. Only send a message to the orchestrator when:
   - You have a SPECIFIC QUESTION that blocks your work
   - You have COMPLETED the task (send a brief summary of what you did)
5. When done, send ONE completion message: "@Orchestrator: DONE - [brief summary of what was completed]"
6. After sending the completion message, STOP — do not send any more messages
`;
}
