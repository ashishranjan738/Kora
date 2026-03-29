/**
 * Shared tool definitions — single source of truth for all 24 Kora tools.
 * Used by MCP server (JSON-RPC), CLI, and any future transport.
 */

/** CLI metadata for auto-generating CLI commands from tool definitions */
export interface ToolCliMeta {
  positionalArgs?: string[];
  aliases?: string[];
  group?: string;
  subcommand?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  cliMeta?: ToolCliMeta;
}

/** All available tool names */
export const ALL_TOOL_NAMES = [
  "send_message", "check_messages", "list_agents", "broadcast",
  "list_tasks", "get_task", "update_task", "create_task",
  "spawn_agent", "remove_agent", "peek_agent", "nudge_agent",
  "report_idle", "request_task",
  "list_personas", "save_persona", "get_workflow_states",
  "share_file", "save_knowledge", "get_knowledge", "search_knowledge",
  "update_knowledge", "delete_knowledge", "link_knowledge", "unlink_knowledge",
  "whoami", "get_context", "delete_task",
  "channel_list", "channel_join", "channel_history",
] as const;

export type ToolName = (typeof ALL_TOOL_NAMES)[number];

/** Tools allowed per role. Master gets everything, workers get a subset. */
export const ROLE_TOOL_ACCESS: Record<string, Set<string>> = {
  master: new Set(ALL_TOOL_NAMES),
  worker: new Set([
    "send_message", "check_messages", "list_agents", "broadcast",
    "list_tasks", "get_task", "update_task", "create_task",
    "report_idle", "request_task",
    "list_personas", "save_persona", "get_workflow_states",
    "share_file", "save_knowledge", "get_knowledge", "search_knowledge",
    "update_knowledge", "delete_knowledge", "link_knowledge", "unlink_knowledge",
    "whoami", "get_context",
    "channel_list", "channel_join", "channel_history",
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
        knowledgeKeys: { type: "array", items: { type: "string" }, description: "Optional knowledge keys to attach as references. Recipient can use get_knowledge to read them." },
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
        knowledgeKeys: { type: "array", items: { type: "string" }, description: "Optional knowledge keys to attach as references." },
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
    name: "share_file",
    description: "Share a file with another agent. Supports code, markdown, JSON, logs, diffs, configs, and images. The file is stored server-side and a message is sent to the recipient with the file URL. 1MB limit for non-image files.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Agent name or ID to share with" },
        filePath: { type: "string", description: "Path to file on disk (.md, .ts, .json, .log, .diff, .py, .png, etc.)" },
        base64Data: { type: "string", description: "Base64-encoded file data. Mutually exclusive with filePath." },
        filename: { type: "string", description: "Filename for base64 data (e.g. 'output.log'). Required when using base64Data." },
        caption: { type: "string", description: "Optional caption/description for the file" },
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
    name: "update_knowledge",
    description: "Update an existing knowledge entry by key. The key must already exist (use save_knowledge to create new entries).",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The knowledge key to update" },
        value: { type: "string", description: "New value for the entry" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "delete_knowledge",
    description: "Delete a knowledge entry by key. Returns success if deleted, error if key not found.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The knowledge key to delete" },
      },
      required: ["key"],
    },
  },
  {
    name: "link_knowledge",
    description: "Create a typed relationship edge between two knowledge entries. Edge types: references, supersedes, contradicts, extends, related.",
    inputSchema: {
      type: "object",
      properties: {
        fromKey: { type: "string", description: "Source knowledge key" },
        toKey: { type: "string", description: "Target knowledge key" },
        edgeType: { type: "string", description: "Edge type: references, supersedes, contradicts, extends, related", enum: ["references", "supersedes", "contradicts", "extends", "related"] },
      },
      required: ["fromKey", "toKey", "edgeType"],
    },
  },
  {
    name: "unlink_knowledge",
    description: "Remove a relationship edge between two knowledge entries.",
    inputSchema: {
      type: "object",
      properties: {
        fromKey: { type: "string", description: "Source knowledge key" },
        toKey: { type: "string", description: "Target knowledge key" },
      },
      required: ["fromKey", "toKey"],
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
    description: "Get live session context — team, workflow, knowledge, rules, tasks, persona, communication, or workspace. Use this to refresh your understanding of the current session state.",
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string", description: 'Which context to fetch: "team", "workflow", "knowledge", "rules", "tasks", "persona", "communication", "workspace", or "all" (default: "all")' },
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
  {
    name: "channel_list",
    description: "List available channels in the session with member counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "channel_join",
    description: "Join a channel to receive its messages. Use channel_list to see available channels.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID (e.g. #frontend)" },
      },
      required: ["channel"],
    },
  },
  {
    name: "channel_history",
    description: "Read recent message history in a channel. Use this to catch up on a conversation.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID (e.g. #frontend)" },
        limit: { type: "number", description: "Number of messages to return (default: 20, max: 100)" },
      },
      required: ["channel"],
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

/** CLI metadata map — merged with TOOL_DEFINITIONS for auto-CLI generation */
export const CLI_META: Record<string, ToolCliMeta> = {
  send_message: { positionalArgs: ["to", "message"], aliases: ["send"] },
  check_messages: { aliases: ["messages", "check"] },
  list_agents: { aliases: ["agents", "list-agents"] },
  broadcast: { positionalArgs: ["message"] },
  list_tasks: { aliases: ["tasks"] },
  get_workflow_states: { aliases: ["workflow"] },
  list_personas: { aliases: ["personas"] },
  report_idle: { aliases: ["idle"] },
  request_task: { aliases: ["request-task"] },
  whoami: {},
  share_file: { positionalArgs: ["to"], aliases: ["share-file", "share", "share-image"] },
  get_task: { group: "task", subcommand: "get", positionalArgs: ["taskId"], aliases: ["show"] },
  update_task: { group: "task", subcommand: "update", positionalArgs: ["taskId"] },
  create_task: { group: "task", subcommand: "create", positionalArgs: ["title"] },
  delete_task: { group: "task", subcommand: "delete", positionalArgs: ["taskId"] },
  spawn_agent: { group: "agent", subcommand: "spawn", positionalArgs: ["name"] },
  remove_agent: { group: "agent", subcommand: "remove", positionalArgs: ["agentId"], aliases: ["stop"] },
  peek_agent: { group: "agent", subcommand: "peek", positionalArgs: ["agentId"] },
  nudge_agent: { group: "agent", subcommand: "nudge", positionalArgs: ["agentId"] },
  save_knowledge: { group: "knowledge", subcommand: "save", positionalArgs: ["entry"] },
  get_knowledge: { group: "knowledge", subcommand: "get", positionalArgs: ["key"] },
  search_knowledge: { group: "knowledge", subcommand: "search", positionalArgs: ["query"] },
  update_knowledge: { group: "knowledge", subcommand: "update", positionalArgs: ["key", "value"] },
  delete_knowledge: { group: "knowledge", subcommand: "delete", positionalArgs: ["key"] },
  link_knowledge: { group: "knowledge", subcommand: "link", positionalArgs: ["fromKey", "toKey"] },
  unlink_knowledge: { group: "knowledge", subcommand: "unlink", positionalArgs: ["fromKey", "toKey"] },
  save_persona: { group: "persona", subcommand: "save" },
  channel_list: { group: "channel", subcommand: "list" },
  channel_join: { group: "channel", subcommand: "join", positionalArgs: ["channel"] },
  channel_history: { group: "channel", subcommand: "history", positionalArgs: ["channel"] },
  get_context: {},  // No alias — "context" is manually registered with resource subcommands
};

/** Get tool definitions enriched with CLI metadata */
export function getToolDefinitionsWithCliMeta(): ToolDefinition[] {
  return TOOL_DEFINITIONS.map(t => ({ ...t, cliMeta: CLI_META[t.name] || t.cliMeta }));
}
