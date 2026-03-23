/**
 * Shared tool definitions — single source of truth for all 24 Kora tools.
 * Used by MCP server (JSON-RPC), CLI, and any future transport.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** All available tool names */
export const ALL_TOOL_NAMES = [
  "send_message", "check_messages", "list_agents", "broadcast",
  "list_tasks", "get_task", "update_task", "create_task",
  "spawn_agent", "remove_agent", "peek_agent", "nudge_agent",
  "prepare_pr", "report_idle", "request_task",
  "list_personas", "save_persona", "get_workflow_states",
  "share_image", "save_knowledge", "get_knowledge", "search_knowledge",
  "verify_work", "create_pr", "whoami", "get_context", "delete_task",
] as const;

export type ToolName = (typeof ALL_TOOL_NAMES)[number];

/** Tools allowed per role. Master gets everything, workers get a subset. */
export const ROLE_TOOL_ACCESS: Record<string, Set<string>> = {
  master: new Set(ALL_TOOL_NAMES),
  worker: new Set([
    "send_message", "check_messages", "list_agents", "broadcast",
    "list_tasks", "get_task", "update_task", "create_task",
    "prepare_pr", "report_idle", "request_task",
    "list_personas", "save_persona", "get_workflow_states",
    "share_image", "save_knowledge", "get_knowledge", "search_knowledge",
    "verify_work", "create_pr", "whoami", "get_context",
  ]),
};

/** Check if a given role is allowed to use a tool */
export function isToolAllowed(role: string, toolName: string): boolean {
  const allowed = ROLE_TOOL_ACCESS[role];
  if (!allowed) return ROLE_TOOL_ACCESS.worker.has(toolName); // unknown role → worker (most restrictive)
  return allowed.has(toolName);
}

/**
 * All tool definitions with MCP-compatible inputSchema.
 * These can be used directly by MCP tools/list or transformed for CLI arg parsing.
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "send_message",
    description:
      "Send a message to another agent in your team. The message will appear in their terminal.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: 'Agent name (e.g. "Worker-A") or agent ID' },
        message: { type: "string", description: "Message content to send" },
        messageType: { type: "string", description: "Optional message type: text, task-assignment, question, completion, stop, ack. Defaults to text." },
        channel: { type: "string", description: "Optional channel to broadcast to (e.g. #frontend, #backend). Alternative to 'to'." },
      },
      required: ["message"],
    },
  },
  {
    name: "check_messages",
    description: "Check for new messages from other agents. Returns unread messages.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_agents",
    description: "List all agents in the current session with their names, roles, and status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "broadcast",
    description: "Send a message to ALL other agents in the session.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to broadcast to all agents" },
      },
      required: ["message"],
    },
  },
  {
    name: "list_tasks",
    description:
      'List tasks in the current session. By default shows only YOUR active tasks in summary mode (compact). Use assignedTo: "all" to see all tasks.',
    inputSchema: {
      type: "object",
      properties: {
        assignedTo: { type: "string", description: 'Filter by assignee. Default: "me" (your tasks). Use "all" for all tasks, or an agent name/ID.' },
        status: { type: "string", description: 'Filter by status. Default: "active" (pending+in-progress+review). Or: "pending", "in-progress", "review", "done", "all".' },
        label: { type: "string", description: 'Filter by label (e.g. "bug", "frontend"). Only returns tasks with this label.' },
        due: { type: "string", description: 'Filter by due date: "overdue", "today", "week", or a specific YYYY-MM-DD date.' },
        sortBy: { type: "string", description: 'Sort order: "created" (default), "due" (by due date, nulls last), "priority" (P0 first).' },
        summary: { type: "boolean", description: "If true (default), return compact fields only (id, title, status, priority, assignedTo). Set false for full details." },
        maxTasks: { type: "number", description: "Maximum tasks to return. Default: 10 for workers, 25 for masters. Use -1 for unlimited." },
      },
    },
  },
  {
    name: "get_task",
    description: "Get full details of a single task including description, comments, and dependencies. Use this when you need the complete info on a specific task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task ID to retrieve" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "update_task",
    description: "Update a task's status, priority, title, description, labels, due date, or assignee. Also supports adding comments. Immutable fields: id, sessionId, createdBy, createdAt.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task ID" },
        status: { type: "string", description: 'New status - "pending", "in-progress", "review", "done"' },
        title: { type: "string", description: "New task title (optional)" },
        description: { type: "string", description: "New task description (optional)" },
        priority: { type: "string", description: 'Task priority - "P0" (critical), "P1" (high), "P2" (normal, default), "P3" (low)' },
        labels: { type: "array", items: { type: "string" }, description: 'Task labels (e.g. ["bug", "frontend"])' },
        dueDate: { type: "string", description: "Due date in YYYY-MM-DD format. Set to null to clear." },
        assignedTo: { type: "string", description: "Agent name or ID to reassign to (optional)" },
        comment: { type: "string", description: "A progress update or comment to add to the task" },
        force: { type: "boolean", description: "Force status transition, bypassing pipeline validation. Use when a task needs to skip states (e.g. force-close after PR merge). Master agents only." },
      },
      required: ["taskId"],
    },
  },
  {
    name: "create_task",
    description: "Create a new task on the session's task board. Use this to break down work into trackable tasks.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title" },
        description: { type: "string", description: "Task description" },
        assignedTo: { type: "string", description: "Agent name or ID to assign to (optional)" },
        priority: { type: "string", description: 'Task priority - "P0" (critical), "P1" (high), "P2" (normal, default), "P3" (low)' },
        labels: { type: "array", items: { type: "string" }, description: 'Task labels (e.g. ["bug", "frontend"])' },
        dueDate: { type: "string", description: "Due date in YYYY-MM-DD format" },
      },
      required: ["title"],
    },
  },
  {
    name: "spawn_agent",
    description:
      "Spawn a new worker agent in the session. Only available to master/orchestrator agents. " +
      "You can provide a custom persona text OR reference a persona from the library by ID (use list_personas to see available personas).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for the new agent" },
        role: { type: "string", description: '"worker" (default)' },
        persona: { type: "string", description: "Custom system prompt / persona text for the agent. If personaId is also provided, this overrides it." },
        personaId: { type: "string", description: "ID of a persona from the library (use list_personas to discover available personas). The persona's full text will be used as the agent's system prompt." },
        model: { type: "string", description: "Model to use (e.g. claude-sonnet-4-6)" },
        task: { type: "string", description: "Initial task to send after spawning (optional)" },
        extraCliArgs: { type: "array", items: { type: "string" }, description: "Extra CLI arguments to pass to the agent (e.g. ['--dangerously-skip-permissions'])" },
      },
      required: ["name", "model"],
    },
  },
  {
    name: "list_personas",
    description:
      "List all available personas from the library (both pre-built and custom). " +
      "Use this to discover persona IDs that can be passed to spawn_agent's personaId parameter. " +
      "Each persona has an id, name, description, and full instruction text.",
    inputSchema: {
      type: "object",
      properties: {
        includeFullText: { type: "boolean", description: "If true, include the full persona text in the response (default: false, only shows id/name/description)" },
      },
    },
  },
  {
    name: "save_persona",
    description:
      "Save a new custom persona to the global library. Use this to capture learnings — " +
      "when you discover an effective agent configuration or role definition, save it as a " +
      "persona so it can be reused in future sessions. The persona will be available to all " +
      "agents via list_personas and can be referenced by ID in spawn_agent.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for the persona (e.g. 'CSS Migration Expert', 'GraphQL Schema Designer')" },
        description: { type: "string", description: "Short one-line description of what this persona does" },
        fullText: { type: "string", description: "The full persona instructions — role definition, skills, rules, constraints. This becomes the agent's system prompt." },
      },
      required: ["name", "fullText"],
    },
  },
  {
    name: "get_workflow_states",
    description:
      "Get the workflow states (task pipeline) configured for this session. " +
      "Shows available statuses, their order, and valid transitions. " +
      "Use this to know which status values you can set on tasks.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "remove_agent",
    description: "Remove/stop an agent from the session.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "ID of the agent to remove" },
        reason: { type: "string", description: "Reason for removal" },
      },
      required: ["agentId"],
    },
  },
  {
    name: "peek_agent",
    description: "View the last N lines of another agent's terminal output. Use this to check if an agent is stuck, see their progress, or verify they're working.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent name or ID to peek at" },
        lines: { type: "number", description: "Number of lines to return (default 15, max 50)" },
      },
      required: ["agentId"],
    },
  },
  {
    name: "nudge_agent",
    description: "Send an instant notification to another agent, bypassing message queue delays. Use for urgent pokes like 'check your messages' or 'are you stuck?'. The notification appears immediately in their terminal.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent name or ID to nudge" },
        message: { type: "string", description: "Optional short message (default: 'You have pending messages. Run check_messages now.')" },
      },
      required: ["agentId"],
    },
  },
  {
    name: "prepare_pr",
    description: "Prepare your branch for PR: fetch latest main, rebase onto it, and force-push. Run this BEFORE creating a PR to prevent stale branch issues and merge conflicts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "verify_work",
    description: "Verify your work before reporting a task as done. Runs build, tests, and checks for unintended file changes. Call this BEFORE setting task status to 'done' or sending a completion message. If verification fails, fix the issues first.",
    inputSchema: {
      type: "object",
      properties: {
        skipTests: { type: "boolean", description: "Skip running tests (default: false). Only use for docs-only changes." },
      },
    },
  },
  {
    name: "report_idle",
    description: "Report that you are idle and available for new work. The orchestrator will update your activity status to 'idle'. Use this when you've completed your current task and are ready for more work.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Optional reason for being idle (e.g. 'task completed', 'waiting for dependencies')" },
      },
    },
  },
  {
    name: "request_task",
    description: "Request a task from the session's task board. Returns the best matching unassigned task based on your skills and availability. The task will be automatically assigned to you.",
    inputSchema: {
      type: "object",
      properties: {
        skills: { type: "array", items: { type: "string" }, description: "Your skills/specialties (e.g. ['frontend', 'react', 'css']). Used to match tasks with relevant labels." },
        priority: { type: "string", description: "Preferred task priority: 'P0' (critical), 'P1' (high), 'P2' (normal), 'P3' (low). Defaults to highest available." },
      },
    },
  },
  {
    name: "create_pr",
    description: "Create a GitHub pull request from your current branch. Automatically detects head branch, base branch defaults to main. Requires GITHUB_TOKEN env var or github.token in .kora.yml.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "PR title (required)" },
        body: { type: "string", description: "PR description/body (required)" },
        baseBranch: { type: "string", description: "Base branch to merge into (default: main)" },
        headBranch: { type: "string", description: "Head branch to merge from (default: current branch)" },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "save_knowledge",
    description: "Save a knowledge entry that persists across sessions. Optionally provide a key for SQLite-backed retrieval via get_knowledge/search_knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        entry: { type: "string", description: "Knowledge entry text (e.g. 'Express 5 uses path-to-regexp v8')" },
        key: { type: "string", description: "Optional key for structured storage (e.g. 'express-routing-pattern'). Enables get_knowledge/search_knowledge retrieval." },
      },
      required: ["entry"],
    },
  },
  {
    name: "share_image",
    description: "Share an image or screenshot with another agent. Accepts a file path or base64 data. The image is stored server-side and a message is sent to the recipient with the image URL.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Agent name or ID to share with" },
        filePath: { type: "string", description: "Path to image file on disk (png, jpg, jpeg, gif, webp)" },
        base64Data: { type: "string", description: "Base64-encoded image data (for screenshots). Mutually exclusive with filePath." },
        filename: { type: "string", description: "Filename for base64 data (e.g. 'screenshot.png'). Required when using base64Data." },
        caption: { type: "string", description: "Optional caption/description for the image" },
      },
      required: ["to"],
    },
  },
  {
    name: "get_knowledge",
    description: "Get a knowledge entry by key. Use to retrieve shared context saved by you or other agents (e.g. file paths, patterns, decisions).",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The knowledge key to look up (e.g. 'auth-module-path', 'api-pattern')" },
      },
      required: ["key"],
    },
  },
  {
    name: "search_knowledge",
    description: "Search shared knowledge entries by keyword. Returns all entries where the key or value contains the query string.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (substring match on key and value)" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "whoami",
    description: "Show your agent identity, team, workflow pipeline, and persona. Use this to understand who you are, what team you're on, and what workflow to follow.",
    inputSchema: {
      type: "object",
      properties: {
        full: { type: "boolean", description: "If true, include full persona text (default: truncated to 500 chars)" },
      },
    },
  },
  {
    name: "get_context",
    description: "Get live session context — team, workflow, knowledge, rules, or tasks. Use this to refresh your understanding of the current session state.",
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string", description: 'Which context to fetch: "team", "workflow", "knowledge", "rules", "tasks", or "all" (default: "all")' },
      },
    },
  },
  {
    name: "delete_task",
    description: "Delete a task from the board. Use for duplicate, invalid, or cancelled tasks. Master agents only.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task ID to delete" },
        reason: { type: "string", description: "Optional reason for deletion" },
      },
      required: ["taskId"],
    },
  },
];

/** Look up a tool definition by name */
export function getToolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find(t => t.name === name);
}

/** Get tool definitions filtered by role */
export function getToolsForRole(role: string): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter(t => isToolAllowed(role, t.name));
}
