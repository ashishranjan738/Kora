#!/usr/bin/env node

/**
 * MCP Server for Kora inter-agent messaging.
 *
 * Each Claude Code agent connects to this via --mcp-config.
 * The server provides tools for sending/receiving messages
 * and communicates with the daemon via HTTP API.
 *
 * Usage: node agent-mcp-server.js --agent-id <id> --session-id <id> --daemon-url http://localhost:7890 --token <token>
 */

import * as readline from "readline";
import * as http from "http";
import * as fs from "fs";
import * as nodePath from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getPromptDefinition, getPromptsForRole } from "../tools/prompt-registry.js";
import { RESOURCE_DEFINITIONS, getResourceDefinition } from "../tools/resource-registry.js";
import { TOOL_HANDLER_MAP } from "../tools/tool-handlers.js";

// Track resource subscriptions for live update notifications
const resourceSubscriptions = new Set<string>();

const execFileAsync = promisify(execFile);

// Import registries for MCP prompts + resources
import { PROMPT_DEFINITIONS } from "../tools/prompt-registry.js";

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(name: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : "";
}

const AGENT_ID = getArg("agent-id");
const SESSION_ID = getArg("session-id");
let PROJECT_PATH = getArg("project-path");
let AGENT_ROLE = getArg("agent-role") || "worker";

// Self-bootstrap: fetch role and projectPath from daemon API if not in CLI args
async function selfBootstrap(): Promise<void> {
  if (getArg("agent-role") && PROJECT_PATH) return;
  try {
    const resp = await apiCallOnce("GET", `/api/v1/sessions/${SESSION_ID}/agents/${AGENT_ID}`) as any;
    if (resp?.config) {
      if (!getArg("agent-role")) AGENT_ROLE = resp.config.role || "worker";
      if (!getArg("project-path")) PROJECT_PATH = resp.config.projectPath || resp.config.workingDirectory || "";
    }
  } catch { /* Non-fatal: use CLI args/defaults */ }
}
const bootstrapPromise = (AGENT_ID && SESSION_ID) ? selfBootstrap() : Promise.resolve(); // default to worker (most restrictive)

// ---------------------------------------------------------------------------
// Tool access control — restrict which MCP tools each role can use.
// Tools not in the allow list for a role are hidden from tools/list
// and rejected in tools/call.
// ---------------------------------------------------------------------------

/** All available tool names */
const ALL_TOOLS = [
  "send_message", "check_messages", "list_agents", "broadcast",
  "list_tasks", "get_task", "update_task", "create_task",
  "spawn_agent", "remove_agent", "peek_agent", "nudge_agent",
  "prepare_pr", "report_idle", "request_task",
  "list_personas", "save_persona", "get_workflow_states",
  "share_image", "save_knowledge", "get_knowledge", "search_knowledge",
  "verify_work", "create_pr", "whoami", "get_context", "delete_task",
  "channel_list", "channel_join", "channel_history",
] as const;

/** Tools allowed per role. Master gets everything, workers get subsets. */
const ROLE_TOOL_ACCESS: Record<string, Set<string>> = {
  master: new Set(ALL_TOOLS),
  worker: new Set([
    "send_message", "check_messages", "list_agents", "broadcast",
    "list_tasks", "get_task", "update_task", "create_task",
    "prepare_pr", "report_idle", "request_task",
    "list_personas", "save_persona", "get_workflow_states",
    "share_image", "save_knowledge", "get_knowledge", "search_knowledge",
    "verify_work", "create_pr", "whoami", "get_context",
    "channel_list", "channel_join", "channel_history",
  ]),
  // Deny: spawn_agent, remove_agent, peek_agent, nudge_agent, delete_task (master-only)
};

/** Check if the current agent role is allowed to use a tool */
function isToolAllowed(toolName: string): boolean {
  const allowed = ROLE_TOOL_ACCESS[AGENT_ROLE];
  if (!allowed) return ROLE_TOOL_ACCESS.worker.has(toolName); // unknown role — default to worker (most restrictive)
  return allowed.has(toolName);
}

// Read daemon URL + token dynamically from files (survives daemon restarts)
function getConfigDir(): string {
  const os = require("os");
  const path = require("path");
  const envDir = process.env.KORA_CONFIG_DIR;
  const isDev = process.env.KORA_DEV === "1";
  const suffix = isDev ? "-dev" : "";
  return envDir || path.join(os.homedir(), `.kora${suffix}`);
}

function getDaemonUrl(): string {
  // CLI args take priority (always correct for the daemon that spawned us)
  const cliUrl = getArg("daemon-url");
  if (cliUrl) return cliUrl;
  // Filesystem fallback
  try {
    const path = require("path");
    const port = fs.readFileSync(path.join(getConfigDir(), "daemon.port"), "utf-8").trim();
    return `http://localhost:${port}`;
  } catch {
    const isDev = process.env.KORA_DEV === "1";
    return `http://localhost:${isDev ? 7891 : 7890}`;
  }
}

function getToken(): string {
  // CLI args take priority (always correct for the daemon that spawned us)
  const cliToken = getArg("token");
  if (cliToken) return cliToken;
  // Filesystem fallback
  try {
    const path = require("path");
    return fs.readFileSync(path.join(getConfigDir(), "daemon.token"), "utf-8").trim();
  } catch {
    return "";
  }
}

function getRuntimeDir(): string {
  const isDev = process.env.KORA_DEV === "1";
  return isDev ? ".kora-dev" : ".kora";
}

// ---------------------------------------------------------------------------
// Resource subscriptions — track which resources this agent subscribes to
// ---------------------------------------------------------------------------


/** Send MCP notification for a subscribed resource change */
function notifyResourceChanged(uri: string): void {
  if (resourceSubscriptions.has(uri)) {
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri },
    });
    process.stdout.write(notification + "\n");
  }
}

// If called with no args, print usage and exit (serves as a --help check)
if (!AGENT_ID && !SESSION_ID) {
  process.stderr.write(
    "Usage: agent-mcp-server --agent-id <id> --session-id <id> [--daemon-url URL] [--token TOKEN]\n",
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Unread message counter for piggyback notifications
// ---------------------------------------------------------------------------

async function countUnreadMessages(): Promise<number> {
  if (!PROJECT_PATH) return 0;
  let count = 0;

  // Try SQLite via daemon API first (primary source)
  try {
    const response = await apiCallOnce("GET", `/api/v1/sessions/${SESSION_ID}/agents/${AGENT_ID}/messages/unread-count`) as any;
    if (response && typeof response === 'object' && 'count' in response) {
      count += response.count;
    }
  } catch { /* SQLite may not be available */ }

  // Fall back to file counting (backward compat) — only if API returned 0
  if (count === 0) {
    try {
      const inboxDir = nodePath.join(PROJECT_PATH, getRuntimeDir(), "messages", `inbox-${AGENT_ID}`);
      const files = fs.readdirSync(inboxDir);
      count += files.filter((f: string) => f.endsWith(".md")).length;
    } catch { /* inbox may not exist */ }
    try {
      const pendingDir = nodePath.join(PROJECT_PATH, getRuntimeDir(), "mcp-pending", AGENT_ID);
      const files = fs.readdirSync(pendingDir);
      count += files.filter((f: string) => f.endsWith(".json")).length;
    } catch { /* pending dir may not exist */ }
  }
  return count;
}

/** Read messages from SQLite (primary source) */
async function readSqliteMessages(): Promise<Array<{ id: string; from: string; content: string; timestamp: string; channel?: string | null }>> {
  try {
    const response = (await apiCall(
      "GET",
      `/api/v1/sessions/${SESSION_ID}/agents/${AGENT_ID}/messages?status=pending&status=delivered`,
    )) as any;

    if (response.messages && Array.isArray(response.messages)) {
      // Mark as read in SQLite
      const messageIds = response.messages.map((m: any) => m.id);
      if (messageIds.length > 0) {
        await apiCall("POST", `/api/v1/sessions/${SESSION_ID}/agents/${AGENT_ID}/messages/mark-read`, {
          messageIds,
        });
      }

      return response.messages.map((m: any) => ({
        id: m.id,
        from: m.fromName || m.fromAgentId || 'system',
        content: m.content,
        timestamp: new Date(m.createdAt).toISOString(),
        channel: m.channel || null,
      }));
    }
    return [];
  } catch {
    // SQLite not available, fall back to files
    return [];
  }
}

/**
 * Non-destructive count of pending messages. Used for piggyback notifications
 * ("You have N unread messages") without consuming the actual content.
 * Only check_messages should consume messages via readAndConsumePendingMessages().
 */
function countPendingMessages(): number {
  if (!PROJECT_PATH) return 0;
  const pendingDir = nodePath.join(PROJECT_PATH, getRuntimeDir(), "mcp-pending", AGENT_ID);
  try {
    const files = fs.readdirSync(pendingDir);
    return files.filter((f: string) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function readAndConsumePendingMessages(): Array<{ from: string; content: string; timestamp: string }> {
  if (!PROJECT_PATH) return [];

  const pendingDir = nodePath.join(PROJECT_PATH, getRuntimeDir(), "mcp-pending", AGENT_ID);
  const processedDir = nodePath.join(pendingDir, "processed");

  try {
    const files = fs.readdirSync(pendingDir);
    const jsonFiles = files.filter((f: string) => f.endsWith(".json"));
    if (jsonFiles.length === 0) return [];

    // Ensure processed dir exists
    fs.mkdirSync(processedDir, { recursive: true });

    const messages: Array<{ from: string; content: string; timestamp: string }> = [];

    for (const file of jsonFiles) {
      const filePath = nodePath.join(pendingDir, file);
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const msg = JSON.parse(raw);
        messages.push(msg);
        // Move to processed
        fs.renameSync(filePath, nodePath.join(processedDir, file));
      } catch {
        // Skip malformed files
      }
    }

    return messages;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// HTTP helper to call daemon API
// ---------------------------------------------------------------------------

const API_RETRY_MAX = 3;
const API_RETRY_BASE_MS = 2000; // 2s, 4s, 8s exponential backoff

function apiCallOnce(method: string, urlPath: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, getDaemonUrl());
    const options: http.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        Authorization: `Bearer ${getToken()}`,
        "Content-Type": "application/json",
        "X-Agent-Id": AGENT_ID,
        "X-Agent-Role": AGENT_ROLE,
      },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Retryable connection errors (daemon temporarily down) */
function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return msg.includes("ECONNREFUSED") || msg.includes("ECONNRESET") || msg.includes("EPIPE");
}

/** API call with automatic retry on connection failures (daemon restart resilience) */
async function apiCall(method: string, urlPath: string, body?: unknown): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= API_RETRY_MAX; attempt++) {
    try {
      return await apiCallOnce(method, urlPath, body);
    } catch (err) {
      lastError = err;
      if (attempt < API_RETRY_MAX && isRetryableError(err)) {
        const delayMs = API_RETRY_BASE_MS * Math.pow(2, attempt); // 2s, 4s, 8s
        process.stderr.write(`[MCP] Daemon connection failed (attempt ${attempt + 1}/${API_RETRY_MAX + 1}), retrying in ${delayMs / 1000}s...\n`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

/**
 * Find an agent by name or ID with prioritized matching to avoid ambiguity.
 *
 * Priority order:
 * 1. Exact name match (case-insensitive) - "Backend" matches "Backend", not "Backend2"
 * 2. Exact ID match (case-insensitive) - "backend-0b927a3d" matches agent by ID
 * 3. Substring match (fallback) - "Back" matches "Backend" as partial name
 *
 * @param agents - Array of agent objects to search
 * @param search - Name or ID to search for
 * @returns Matching agent or undefined if not found
 */
function findAgentByNameOrId(
  agents: AgentInfo[],
  search: string
): AgentInfo | undefined {
  // Return undefined for empty search string
  if (!search || search.trim() === "") {
    return undefined;
  }

  const searchLower = search.toLowerCase();

  // Priority 1: Exact name match
  let target = agents.find(a =>
    (a.config?.name || "").toLowerCase() === searchLower
  );
  if (target) return target;

  // Priority 2: Exact ID match
  target = agents.find(a =>
    a.id.toLowerCase() === searchLower
  );
  if (target) return target;

  // Priority 3: Substring match (fallback)
  target = agents.find(a => {
    const name = (a.config?.name || "").toLowerCase();
    return name.includes(searchLower) ||
           a.id.toLowerCase().includes(searchLower);
  });

  return target;
}

// ---------------------------------------------------------------------------
// MCP Protocol — JSON-RPC over stdio
// ---------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function sendResponse(id: string | number | null, result: unknown): void {
  const response = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(response + "\n");
}

function sendError(id: string | number | null, code: number, message: string): void {
  const response = JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
  process.stdout.write(response + "\n");
}

// Tool definitions shared between tools/list and initialization
const TOOL_DEFINITIONS = [
  {
    name: "send_message",
    description:
      "Send a message to another agent in your team. The message will appear in their terminal.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: {
          type: "string",
          description: 'Agent name (e.g. "Worker-A") or agent ID',
        },
        message: {
          type: "string",
          description: "Message content to send",
        },
        messageType: {
          type: "string",
          description: "Optional message type: text, task-assignment, question, completion, stop, ack. Defaults to text.",
        },
        channel: {
          type: "string",
          description: "Optional channel to broadcast to (e.g. #frontend, #backend). Alternative to 'to'.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "check_messages",
    description:
      "Check for new messages from other agents. Returns unread messages.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "list_agents",
    description:
      "List all agents in the current session with their names, roles, and status.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "broadcast",
    description: "Send a message to ALL other agents in the session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description: "Message to broadcast to all agents",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "list_tasks",
    description:
      "List tasks in the current session. By default shows only YOUR active tasks in summary mode (compact). Use assignedTo: \"all\" to see all tasks.",
    inputSchema: {
      type: "object" as const,
      properties: {
        assignedTo: {
          type: "string",
          description: 'Filter by assignee. Default: "me" (your tasks). Use "all" for all tasks, or an agent name/ID.',
        },
        status: {
          type: "string",
          description: 'Filter by status. Default: "active" (pending+in-progress+review). Or: "pending", "in-progress", "review", "done", "all".',
        },
        label: {
          type: "string",
          description: 'Filter by label (e.g. "bug", "frontend"). Only returns tasks with this label.',
        },
        due: {
          type: "string",
          description: 'Filter by due date: "overdue", "today", "week", or a specific YYYY-MM-DD date.',
        },
        sortBy: {
          type: "string",
          description: 'Sort order: "created" (default), "due" (by due date, nulls last), "priority" (P0 first).',
        },
        summary: {
          type: "boolean",
          description: "If true (default), return compact fields only (id, title, status, priority, assignedTo). Set false for full details.",
        },
        maxTasks: {
          type: "number",
          description: "Maximum tasks to return. Default: 10 for workers, 25 for masters. Use -1 for unlimited.",
        },
      },
    },
  },
  {
    name: "get_task",
    description:
      "Get full details of a single task including description, comments, and dependencies. Use this when you need the complete info on a specific task.",
    inputSchema: {
      type: "object" as const,
      properties: {
        taskId: {
          type: "string",
          description: "The task ID to retrieve",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "update_task",
    description:
      "Update a task's status, priority, title, description, labels, due date, or assignee. Also supports adding comments. Immutable fields: id, sessionId, createdBy, createdAt.",
    inputSchema: {
      type: "object" as const,
      properties: {
        taskId: {
          type: "string",
          description: "The task ID",
        },
        status: {
          type: "string",
          description: 'New status - "pending", "in-progress", "review", "done"',
        },
        title: {
          type: "string",
          description: "New task title (optional)",
        },
        description: {
          type: "string",
          description: "New task description (optional)",
        },
        priority: {
          type: "string",
          description: 'Task priority - "P0" (critical), "P1" (high), "P2" (normal, default), "P3" (low)',
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: 'Task labels (e.g. ["bug", "frontend"])',
        },
        dueDate: {
          type: "string",
          description: "Due date in YYYY-MM-DD format. Set to null to clear.",
        },
        assignedTo: {
          type: "string",
          description: "Agent name or ID to reassign to (optional)",
        },
        comment: {
          type: "string",
          description: "A progress update or comment to add to the task",
        },
        force: {
          type: "boolean",
          description: "Force status transition, bypassing pipeline validation. Use when a task needs to skip states (e.g. force-close after PR merge). Master agents only.",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "create_task",
    description:
      "Create a new task on the session's task board. Use this to break down work into trackable tasks.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Task title",
        },
        description: {
          type: "string",
          description: "Task description",
        },
        assignedTo: {
          type: "string",
          description: "Agent name or ID to assign to (optional)",
        },
        priority: {
          type: "string",
          description: 'Task priority - "P0" (critical), "P1" (high), "P2" (normal, default), "P3" (low)',
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: 'Task labels (e.g. ["bug", "frontend"])',
        },
        dueDate: {
          type: "string",
          description: "Due date in YYYY-MM-DD format",
        },
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
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Name for the new agent",
        },
        role: {
          type: "string",
          description: '"worker" (default)',
        },
        persona: {
          type: "string",
          description: "Custom system prompt / persona text for the agent. If personaId is also provided, this overrides it.",
        },
        personaId: {
          type: "string",
          description: "ID of a persona from the library (use list_personas to discover available personas). The persona's full text will be used as the agent's system prompt.",
        },
        model: {
          type: "string",
          description: "Model to use (e.g. claude-sonnet-4-6)",
        },
        task: {
          type: "string",
          description: "Initial task to send after spawning (optional)",
        },
        extraCliArgs: {
          type: "array",
          items: { type: "string" },
          description: "Extra CLI arguments to pass to the agent (e.g. ['--dangerously-skip-permissions'])",
        },
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
      type: "object" as const,
      properties: {
        includeFullText: {
          type: "boolean",
          description: "If true, include the full persona text in the response (default: false, only shows id/name/description)",
        },
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
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Name for the persona (e.g. 'CSS Migration Expert', 'GraphQL Schema Designer')",
        },
        description: {
          type: "string",
          description: "Short one-line description of what this persona does",
        },
        fullText: {
          type: "string",
          description: "The full persona instructions — role definition, skills, rules, constraints. This becomes the agent's system prompt.",
        },
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
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "remove_agent",
    description: "Remove/stop an agent from the session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "ID of the agent to remove",
        },
        reason: {
          type: "string",
          description: "Reason for removal",
        },
      },
      required: ["agentId"],
    },
  },
  {
    name: "peek_agent",
    description:
      "View the last N lines of another agent's terminal output. Use this to check if an agent is stuck, see their progress, or verify they're working.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent name or ID to peek at",
        },
        lines: {
          type: "number",
          description: "Number of lines to return (default 15, max 50)",
        },
      },
      required: ["agentId"],
    },
  },
  {
    name: "nudge_agent",
    description:
      "Send an instant notification to another agent, bypassing message queue delays. Use for urgent pokes like 'check your messages' or 'are you stuck?'. The notification appears immediately in their terminal.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Agent name or ID to nudge",
        },
        message: {
          type: "string",
          description:
            "Optional short message (default: 'You have pending messages. Run check_messages now.')",
        },
      },
      required: ["agentId"],
    },
  },
  {
    name: "prepare_pr",
    description:
      "Prepare your branch for PR: fetch latest main, rebase onto it, and force-push. Run this BEFORE creating a PR to prevent stale branch issues and merge conflicts.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "verify_work",
    description:
      "Verify your work before reporting a task as done. Runs build, tests, and checks for unintended file changes. Call this BEFORE setting task status to 'done' or sending a completion message. If verification fails, fix the issues first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        skipTests: {
          type: "boolean",
          description: "Skip running tests (default: false). Only use for docs-only changes.",
        },
      },
    },
  },
  {
    name: "report_idle",
    description:
      "Report that you are idle and available for new work. The orchestrator will update your activity status to 'idle'. Use this when you've completed your current task and are ready for more work.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "Optional reason for being idle (e.g. 'task completed', 'waiting for dependencies')",
        },
      },
    },
  },
  {
    name: "request_task",
    description:
      "Request a task from the session's task board. Returns the best matching unassigned task based on your skills and availability. The task will be automatically assigned to you.",
    inputSchema: {
      type: "object" as const,
      properties: {
        skills: {
          type: "array",
          items: { type: "string" },
          description: "Your skills/specialties (e.g. ['frontend', 'react', 'css']). Used to match tasks with relevant labels.",
        },
        priority: {
          type: "string",
          description: "Preferred task priority: 'P0' (critical), 'P1' (high), 'P2' (normal), 'P3' (low). Defaults to highest available.",
        },
      },
    },
  },
  {
    name: "create_pr",
    description:
      "Create a GitHub pull request from your current branch. Automatically detects head branch, base branch defaults to main. Requires GITHUB_TOKEN env var or github.token in .kora.yml.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "PR title (required)",
        },
        body: {
          type: "string",
          description: "PR description/body (required)",
        },
        baseBranch: {
          type: "string",
          description: "Base branch to merge into (default: main)",
        },
        headBranch: {
          type: "string",
          description: "Head branch to merge from (default: current branch)",
        },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "save_knowledge",
    description:
      "Save a knowledge entry that persists across sessions. Optionally provide a key for SQLite-backed retrieval via get_knowledge/search_knowledge.",
    inputSchema: {
      type: "object" as const,
      properties: {
        entry: {
          type: "string",
          description: "Knowledge entry text (e.g. 'Express 5 uses path-to-regexp v8')",
        },
        key: {
          type: "string",
          description: "Optional key for structured storage (e.g. 'express-routing-pattern'). Enables get_knowledge/search_knowledge retrieval.",
        },
      },
      required: ["entry"],
    },
  },
  {
    name: "share_image",
    description:
      "Share an image or screenshot with another agent. Accepts a file path or base64 data. The image is stored server-side and a message is sent to the recipient with the image URL.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: {
          type: "string",
          description: "Agent name or ID to share with",
        },
        filePath: {
          type: "string",
          description: "Path to image file on disk (png, jpg, jpeg, gif, webp)",
        },
        base64Data: {
          type: "string",
          description: "Base64-encoded image data (for screenshots). Mutually exclusive with filePath.",
        },
        filename: {
          type: "string",
          description: "Filename for base64 data (e.g. 'screenshot.png'). Required when using base64Data.",
        },
        caption: {
          type: "string",
          description: "Optional caption/description for the image",
        },
      },
      required: ["to"],
    },
  },
  {
    name: "get_knowledge",
    description:
      "Get a knowledge entry by key. Use to retrieve shared context saved by you or other agents (e.g. file paths, patterns, decisions).",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description: "The knowledge key to look up (e.g. 'auth-module-path', 'api-pattern')",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "search_knowledge",
    description:
      "Search shared knowledge entries by keyword. Returns all entries where the key or value contains the query string.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (substring match on key and value)",
        },
        limit: {
          type: "number",
          description: "Max results (default 20)",
        },
      },
      required: ["query"],
    },
  },
];

// ---------------------------------------------------------------------------
// Handle individual tool calls
// ---------------------------------------------------------------------------

interface AgentInfo {
  id: string;
  config?: {
    name?: string;
    role?: string;
    cliProvider?: string;
    model?: string;
  };
  status?: string;
}

interface AgentsResponse {
  agents?: AgentInfo[];
}

// Circuit breaker: track send_message calls per agent
const sendMessageLog: { timestamp: number }[] = [];
const CIRCUIT_BREAKER_MAX = 10;
const CIRCUIT_BREAKER_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

// Rate limiter for nudge_agent: 5 per minute per target agent
const nudgeRateLimit = new Map<string, { count: number; windowStart: number }>();

function isSendRateLimited(): boolean {
  const now = Date.now();
  // Remove entries outside the window
  while (sendMessageLog.length > 0 && now - sendMessageLog[0].timestamp > CIRCUIT_BREAKER_WINDOW_MS) {
    sendMessageLog.shift();
  }
  return sendMessageLog.length >= CIRCUIT_BREAKER_MAX;
}

function recordSendMessage(): void {
  sendMessageLog.push({ timestamp: Date.now() });
}

async function handleToolCall(
  toolName: string,
  toolArgs: Record<string, string>,
): Promise<unknown> {
  switch (toolName) {
    case "send_message": {
      // Validate: either 'to' or 'channel' must be provided
      if (!toolArgs.to && !toolArgs.channel) {
        return { success: false, error: "Either 'to' or 'channel' must be provided" };
      }

      // Circuit breaker: if the agent has sent too many messages, reject
      if (isSendRateLimited()) {
        return {
          success: false,
          error: "Rate limited: you have sent too many messages. Focus on completing your task instead of messaging.",
        };
      }

      const agents = (await apiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/agents`,
      )) as AgentsResponse;

      // Channel-based routing: send to all agents subscribed to the channel
      if (toolArgs.channel) {
        const subscribers = (agents.agents || []).filter((a) => {
          const channels = (a.config as any)?.channels || [];
          return channels.includes(toolArgs.channel) && a.id !== AGENT_ID;
        });

        if (subscribers.length === 0) {
          return { success: false, error: `No agents subscribed to channel "${toolArgs.channel}"` };
        }

        for (const sub of subscribers) {
          await apiCall("POST", `/api/v1/sessions/${SESSION_ID}/relay`, {
            from: AGENT_ID,
            to: sub.id,
            message: `[${toolArgs.channel}] ${toolArgs.message}`,
            messageType: toolArgs.messageType || "text",
          });
        }

        recordSendMessage();
        return { success: true, channel: toolArgs.channel, sentTo: subscribers.map((s) => s.config?.name || s.id) };
      }

      // Direct routing: find target agent by name or ID
      const target = findAgentByNameOrId(agents.agents || [], toolArgs.to || "");

      if (!target) {
        return { success: false, error: `Agent "${toolArgs.to}" not found` };
      }

      await apiCall("POST", `/api/v1/sessions/${SESSION_ID}/relay`, {
        from: AGENT_ID,
        to: target.id,
        message: toolArgs.message,
        messageType: toolArgs.messageType || "text",
      });

      recordSendMessage();

      // If message looks like a completion, remind about stale tasks
      const msgLower = (toolArgs.message || "").toLowerCase();
      const isCompletion = ["task complete", "pr merged", "done", "shipped", "standing by", "ready for"].some(kw => msgLower.includes(kw));
      if (isCompletion) {
        try {
          const tasksResp = (await apiCall("GET",
            `/api/v1/sessions/${SESSION_ID}/tasks?assignedTo=${AGENT_ID}&status=active&summary=true`
          )) as any;
          const staleTasks = (tasksResp.tasks || []).filter((t: any) =>
            t.status === "in-progress" || t.status === "review"
          );
          if (staleTasks.length > 0) {
            return {
              success: true,
              sentTo: target.config?.name || target.id,
              reminder: `You have ${staleTasks.length} task(s) still in-progress/review. Remember to update_task to mark them done.`,
              staleTasks: staleTasks.map((t: any) => ({ id: t.id, title: t.title, status: t.status })),
            };
          }
        } catch { /* non-fatal */ }
      }

      return { success: true, sentTo: target.config?.name || target.id };
    }

    case "check_messages": {
      // Tier 1: Read from SQLite (primary source)
      const sqliteMessages = await readSqliteMessages();

      // Tier 2: Read from mcp-pending (backward compat)
      const pendingMessages = readAndConsumePendingMessages();

      // Tier 3: Read from inbox files (backward compat)
      const inboxMessages: Array<{ from: string; content: string; timestamp: string }> = [];

      if (PROJECT_PATH) {
        const inboxDir = nodePath.join(PROJECT_PATH, getRuntimeDir(), "messages", `inbox-${AGENT_ID}`);
        try {
          const files = fs.readdirSync(inboxDir);
          const messageFiles = files.filter((f: string) => f.endsWith(".md"));
          for (const file of messageFiles) {
            const filePath = nodePath.join(inboxDir, file);
            const content = fs.readFileSync(filePath, "utf-8");
            const timestamp = file.split("-")[0];
            // Strip ANSI codes before matching sender
            const cleanContent = content.replace(/\x1b\[[0-9;]*m/g, "");
            const senderMatch = cleanContent.match(/\[(?:Message|Task|DONE|Question|Broadcast|System)[^\]]*from (.+?)\]/)
              || cleanContent.match(/\[From (.+?)\]/);
            const from = senderMatch?.[1] || "system";
            inboxMessages.push({ from, content, timestamp });

            // Move to processed
            const processedDir = nodePath.join(inboxDir, "processed");
            try {
              fs.mkdirSync(processedDir, { recursive: true });
              fs.renameSync(filePath, nodePath.join(processedDir, file));
            } catch { /* best effort */ }
          }
        } catch { /* inbox may not exist */ }
      }

      // Combine (SQLite first, then pending, then inbox, deduplicate by content)
      const seen = new Set<string>();
      const allMessages: Array<{ from: string; content: string; timestamp: string; channel?: string | null }> = [];

      for (const sm of sqliteMessages) {
        const key = `${sm.from}:${sm.content.substring(0, 100)}`;
        if (!seen.has(key)) {
          seen.add(key);
          allMessages.push(sm);
        }
      }

      for (const pm of pendingMessages) {
        const key = `${pm.from}:${pm.content.substring(0, 100)}`;
        if (!seen.has(key)) {
          seen.add(key);
          allMessages.push(pm);
        }
      }

      for (const im of inboxMessages) {
        const key = `${im.from}:${im.content.substring(0, 100)}`;
        if (!seen.has(key)) {
          seen.add(key);
          allMessages.push(im);
        }
      }

      // Notify daemon that agent has read messages (resets re-notification attempts)
      if (allMessages.length > 0 || pendingMessages.length > 0 || inboxMessages.length > 0 || sqliteMessages.length > 0) {
        apiCall("POST", `/api/v1/sessions/${SESSION_ID}/agents/${AGENT_ID}/ack-read`).catch(() => {});
      }

      // Return whatever messages we found (may be empty — that's correct)
      return { messages: allMessages, count: allMessages.length };
    }

    case "list_agents": {
      const agents = (await apiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/agents`,
      )) as AgentsResponse;

      // Fetch tasks to compute currentTask and availableForWork
      let allTasks: Array<{ id: string; title: string; status: string; assignedTo?: string }> = [];
      try {
        const tasksResp = (await apiCall("GET", `/api/v1/sessions/${SESSION_ID}/tasks?status=active&summary=true`)) as any;
        allTasks = tasksResp.tasks || [];
      } catch { /* non-fatal */ }

      return {
        agents: (agents.agents || []).map((a) => {
          const agentState = a as any;
          // Find in-progress task assigned to this agent
          const inProgressTask = allTasks.find(t =>
            (t.assignedTo === a.id || t.assignedTo === a.config?.name) && t.status === "in-progress"
          );
          const activeTasks = allTasks.filter(t =>
            t.assignedTo === a.id || t.assignedTo === a.config?.name
          );
          const idleSinceMs = agentState.idleSince ? new Date(agentState.idleSince).getTime() : 0;
          const idleDurationMs = idleSinceMs > 0 ? Date.now() - idleSinceMs : 0;

          return {
            name: a.config?.name,
            id: a.id,
            role: a.config?.role,
            status: a.status,
            activity: agentState.activity || a.status,
            provider: a.config?.cliProvider,
            model: a.config?.model,
            isMe: a.id === AGENT_ID,
            // Enriched fields
            idleSince: agentState.idleSince || null,
            lastActivityAt: agentState.lastActivityAt || null,
            currentTask: inProgressTask ? inProgressTask.title : null,
            currentTaskId: inProgressTask ? inProgressTask.id : null,
            activeTasks: activeTasks.length,
            pendingMessages: agentState.unreadMessages || 0,
            skills: (a.config as any)?.skills || [],
            availableForWork: (
              agentState.activity === "idle" &&
              !inProgressTask &&
              a.config?.role !== "master" &&
              idleDurationMs > 0
            ),
          };
        }),
      };
    }

    case "broadcast": {
      // Circuit breaker applies to broadcast as well
      if (isSendRateLimited()) {
        return {
          success: false,
          error: "Rate limited: you have sent too many messages. Focus on completing your task instead of messaging.",
        };
      }

      await apiCall("POST", `/api/v1/sessions/${SESSION_ID}/broadcast`, {
        message: `[From ${AGENT_ID}]: ${toolArgs.message}`,
        from: AGENT_ID,
      });
      recordSendMessage();
      return { success: true, broadcast: true };
    }

    case "list_tasks": {
      // Build query params for filtering
      const params = new URLSearchParams();

      // assignedTo: default "me" → resolve to AGENT_ID; "all" → no filter
      const assignedToArg = toolArgs.assignedTo || "me";
      if (assignedToArg === "me") {
        params.set("assignedTo", AGENT_ID);
      } else if (assignedToArg !== "all") {
        // Resolve agent name to ID
        const agents = (await apiCall(
          "GET",
          `/api/v1/sessions/${SESSION_ID}/agents`,
        )) as AgentsResponse;
        const target = findAgentByNameOrId(agents.agents || [], assignedToArg);
        if (target) {
          params.set("assignedTo", target.id);
        } else {
          params.set("assignedTo", assignedToArg);
        }
      }

      // status: default "active" unless "all"
      const statusArg = toolArgs.status || "active";
      if (statusArg !== "all") {
        params.set("status", statusArg);
      }

      // label filter
      if (toolArgs.label) {
        params.set("label", toolArgs.label);
      }

      // due date filter
      if (toolArgs.due) {
        params.set("due", toolArgs.due);
      }

      // sort order
      if (toolArgs.sortBy) {
        params.set("sortBy", toolArgs.sortBy);
      }

      // summary: default true
      const summaryArg = toolArgs.summary === "false" ? "false" : "true";
      params.set("summary", summaryArg);

      const queryString = params.toString();
      const response = (await apiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/tasks?${queryString}`,
      )) as { tasks?: Array<{ id: string; title: string; status: string; dependencies?: string[]; [key: string]: unknown }> };

      // Enhance tasks with dependency blocking info (only if full details returned)
      const tasks = response.tasks || [];
      const taskMap = new Map(tasks.map((t) => [t.id, t]));

      for (const task of tasks) {
        if (task.dependencies && task.dependencies.length > 0) {
          const incompleteDeps = task.dependencies
            .map((depId: string) => taskMap.get(depId))
            .filter((dep) => dep && dep.status !== "done");
          if (incompleteDeps.length > 0) {
            (task as any).blocked = true;
            (task as any).blockedReason = `Waiting for: ${incompleteDeps.map((d) => d!.title).join(", ")}`;
          }
        }
      }

      // Sort by priority (P0 first) before any capping
      const priorityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
      tasks.sort((a, b) => {
        const pa = priorityOrder[(a as any).priority] ?? 2;
        const pb = priorityOrder[(b as any).priority] ?? 2;
        return pa - pb;
      });

      // Cap response size: default 10 for workers, 25 for masters
      const maxTasksRaw = toolArgs.maxTasks != null ? Number(toolArgs.maxTasks) : (AGENT_ROLE === "master" ? 25 : 10);
      const maxTasks = isNaN(maxTasksRaw) ? 10 : maxTasksRaw;
      const totalMatching = tasks.length;
      const truncated = maxTasks > 0 && tasks.length > maxTasks;
      const cappedTasks = maxTasks > 0 ? tasks.slice(0, maxTasks) : tasks;

      // In summary mode (default), return compact fields with priority to save context tokens
      if (summaryArg === "true") {
        const result: any = {
          tasks: cappedTasks.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            priority: (t as any).priority || "P2",
            ...(t.assignedTo ? { assignedTo: t.assignedTo } : {}),
            ...((t as any).blocked ? { blocked: true, blockedReason: (t as any).blockedReason } : {}),
          })),
        };
        if (truncated) {
          result.totalMatching = totalMatching;
          result.truncated = true;
          result.hint = `Showing ${cappedTasks.length} of ${totalMatching} tasks (sorted by priority). Use get_task(id) for details.`;
        }
        return result;
      }

      // Full mode — still cap and add truncation info
      const fullResult: any = { tasks: cappedTasks };
      if (truncated) {
        fullResult.totalMatching = totalMatching;
        fullResult.truncated = true;
        fullResult.hint = `Showing ${cappedTasks.length} of ${totalMatching} tasks. Use get_task(id) for details.`;
      }
      return fullResult;
    }

    case "get_task": {
      if (!toolArgs.taskId) {
        return { error: "taskId is required" };
      }
      const taskResp = (await apiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/tasks/${toolArgs.taskId}`,
      )) as any;

      if (taskResp.error) {
        return { error: taskResp.error };
      }

      return { task: taskResp };
    }

    case "update_task": {
      const { taskId, status, comment, title, description, priority, assignedTo, dueDate, force } = toolArgs;
      const labels = (toolArgs as any).labels; // array type from MCP
      const results: { statusUpdate?: unknown; commentAdded?: unknown } = {};

      // If setting to "in-progress", check dependency gating first
      if (status === "in-progress") {
        const allTasks = (await apiCall(
          "GET",
          `/api/v1/sessions/${SESSION_ID}/tasks`,
        )) as { tasks?: Array<{ id: string; title: string; status: string; dependencies?: string[] }> };

        const tasks = allTasks.tasks || [];
        const taskMap = new Map(tasks.map((t) => [t.id, t]));
        const thisTask = taskMap.get(taskId);

        if (thisTask?.dependencies && thisTask.dependencies.length > 0) {
          const incompleteDeps = thisTask.dependencies
            .map((depId: string) => taskMap.get(depId))
            .filter((dep) => dep && dep.status !== "done");
          if (incompleteDeps.length > 0) {
            return {
              success: false,
              error: `Cannot start — blocked by incomplete dependencies: ${incompleteDeps.map((d) => d!.title).join(", ")}`,
            };
          }
        }
      }

      // Workflow transition enforcement: validate status change against pipeline (skip if force mode)
      if (status && !force) {
        try {
          const sessionRes = (await apiCall("GET", `/api/v1/sessions/${SESSION_ID}`)) as any;
          const workflowStates = sessionRes?.config?.workflowStates || sessionRes?.workflowStates;
          if (workflowStates && Array.isArray(workflowStates)) {
            // Get current task to check current status
            const currentTask = (await apiCall("GET", `/api/v1/sessions/${SESSION_ID}/tasks/${taskId}`)) as any;
            const currentStatus = currentTask?.status;
            if (currentStatus && currentStatus !== status) {
              const currentState = workflowStates.find((s: any) => s.id === currentStatus);
              if (currentState?.transitions?.length) {
                // Build effective transitions: skippable expansion is NON-RECURSIVE
                // to prevent pipeline bypass (e.g. backlog→done via chained skips)
                const effectiveTransitions = new Set<string>(currentState.transitions);
                for (const t of currentState.transitions) {
                  const ts = workflowStates.find((s: any) => s.id === t);
                  if (ts?.skippable && ts.transitions?.length) {
                    for (const skipTarget of ts.transitions) {
                      // Only add non-closed targets — prevents skip chains reaching "done"
                      const skipTargetState = workflowStates.find((s: any) => s.id === skipTarget);
                      if (skipTargetState && skipTargetState.category !== "closed") {
                        effectiveTransitions.add(skipTarget);
                      }
                    }
                  }
                }
                // Always allow closed-category states as direct targets
                for (const s of workflowStates) {
                  if ((s as any).category === "closed") effectiveTransitions.add(s.id);
                }

                if (!effectiveTransitions.has(status)) {
                  const validStates = [...effectiveTransitions].map((t: string) => {
                    const s = workflowStates.find((ws: any) => ws.id === t);
                    return s ? `"${s.label}" (${t})` : `"${t}"`;
                  }).join(", ");
                  return {
                    success: false,
                    error: `Invalid transition: "${currentStatus}" cannot move directly to "${status}". Valid next states: ${validStates}. Follow the pipeline: ${workflowStates.map((s: any) => s.id).join(" → ")}`,
                  };
                }
              }
            }
            // Also validate the status is a known workflow state
            const validIds = workflowStates.map((s: any) => s.id);
            if (!validIds.includes(status)) {
              return {
                success: false,
                error: `Unknown status "${status}". Available states: ${validIds.join(", ")}`,
              };
            }
          }
        } catch {
          // Non-fatal: if we can't fetch session config, skip validation
        }
      }

      // Build update payload with all editable fields
      const updatePayload: Record<string, unknown> = {};
      if (status) updatePayload.status = status;
      if (title) updatePayload.title = title;
      if (description !== undefined) updatePayload.description = description;
      if (priority) updatePayload.priority = priority;
      if (assignedTo !== undefined) updatePayload.assignedTo = assignedTo;
      if (labels !== undefined) updatePayload.labels = labels;
      if (dueDate !== undefined) updatePayload.dueDate = dueDate || null;
      if (force) updatePayload.force = true;

      // Send update if any fields to update
      if (Object.keys(updatePayload).length > 0) {
        results.statusUpdate = await apiCall(
          "PUT",
          `/api/v1/sessions/${SESSION_ID}/tasks/${taskId}`,
          updatePayload,
        );
      }

      // Add comment if provided
      if (comment) {
        results.commentAdded = await apiCall(
          "POST",
          `/api/v1/sessions/${SESSION_ID}/tasks/${taskId}/comments`,
          { text: comment, author: AGENT_ID, authorName: "agent" },
        );
      }

      return {
        success: true,
        ...results,
      };
    }

    case "create_task": {
      const result = await apiCall("POST", `/api/v1/sessions/${SESSION_ID}/tasks`, {
        title: toolArgs.title,
        description: toolArgs.description || "",
        assignedTo: toolArgs.assignedTo || undefined,
        priority: toolArgs.priority || undefined,
        labels: (toolArgs as any).labels || undefined,
        dueDate: toolArgs.dueDate || undefined,
      });
      return result;
    }

    case "spawn_agent": {
      // Enforce per-agent sub-agent limit before spawning
      try {
        const agentsResp = (await apiCall("GET", `/api/v1/sessions/${SESSION_ID}/agents`)) as any;
        const allAgents = agentsResp?.agents || [];
        const myChildren = allAgents.filter((a: any) => a.config?.spawnedBy === AGENT_ID);
        const myAgent = allAgents.find((a: any) => a.id === AGENT_ID);
        const maxSub = myAgent?.config?.permissions?.maxSubAgents ?? 5;
        if (myChildren.length >= maxSub) {
          return { success: false, error: `Max sub-agents (${maxSub}) reached. You have ${myChildren.length} active sub-agents.` };
        }
      } catch { /* non-fatal — proceed with spawn, session limit still applies */ }

      // Resolve persona: explicit text takes priority, then personaId from library
      let persona = toolArgs.persona || "";
      if (!persona && toolArgs.personaId) {
        try {
          const personasResp = (await apiCall("GET", "/api/v1/personas")) as { personas?: Array<{ id: string; fullText: string }> };
          const match = personasResp.personas?.find(p => p.id === toolArgs.personaId);
          if (match) {
            persona = match.fullText;
          } else {
            // Try builtin persona reference (e.g. "builtin:backend")
            persona = `builtin:${toolArgs.personaId}`;
          }
        } catch {
          // Fallback: use personaId as builtin reference
          persona = `builtin:${toolArgs.personaId}`;
        }
      }

      const result = await apiCall("POST", `/api/v1/sessions/${SESSION_ID}/agents`, {
        name: toolArgs.name,
        role: toolArgs.role || "worker",
        model: toolArgs.model,
        persona,
        initialTask: toolArgs.task,
        extraCliArgs: toolArgs.extraCliArgs,
      });
      return result;
    }

    case "list_personas": {
      const personasResp = (await apiCall("GET", "/api/v1/personas")) as {
        personas?: Array<{ id: string; name: string; description: string; fullText: string }>;
      };
      const customPersonas = (personasResp.personas || []).map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        type: "custom",
        ...(toolArgs.includeFullText ? { fullText: p.fullText } : {}),
      }));

      // Add built-in persona references
      const builtinPersonas = [
        { id: "architect", name: "Architect", description: "Master coordinator and system architect", type: "builtin" },
        { id: "backend", name: "Backend Developer", description: "Node.js, APIs, databases, server-side logic", type: "builtin" },
        { id: "frontend", name: "Frontend Developer", description: "React, UI/UX, component development", type: "builtin" },
        { id: "tester", name: "QA Tester", description: "Testing, test plans, bug finding", type: "builtin" },
        { id: "reviewer", name: "Code Reviewer", description: "Code quality, architecture review", type: "builtin" },
        { id: "researcher", name: "Researcher", description: "Investigation, analysis, documentation", type: "builtin" },
      ];

      return {
        personas: [...customPersonas, ...builtinPersonas],
        total: customPersonas.length + builtinPersonas.length,
        hint: "Use the 'id' field as personaId when calling spawn_agent. Custom personas use their full text; builtin personas are resolved server-side.",
      };
    }

    case "save_persona": {
      if (!toolArgs.name?.trim() || !toolArgs.fullText?.trim()) {
        return { error: "name and fullText are required" };
      }
      const saved = await apiCall("POST", "/api/v1/personas", {
        name: toolArgs.name.trim(),
        description: (toolArgs.description || toolArgs.name).trim(),
        fullText: toolArgs.fullText.trim(),
      });
      return {
        success: true,
        ...(saved as any),
        hint: "Persona saved to the global library. It can now be referenced by ID in spawn_agent's personaId parameter, and will appear in the dashboard's Persona Library.",
      };
    }

    case "get_workflow_states": {
      try {
        const sessionRes = (await apiCall("GET", `/api/v1/sessions/${SESSION_ID}`)) as any;
        const states = sessionRes?.config?.workflowStates || sessionRes?.workflowStates;
        if (states && Array.isArray(states) && states.length > 0) {
          return {
            states: states.map((s: any) => ({
              id: s.id,
              label: s.label,
              category: s.category,
              transitions: s.transitions || [],
              skippable: s.skippable ?? false,
              instructions: s.instructions || undefined,
            })),
            pipeline: states.map((s: any) => s.id).join(" → "),
            hint: "Use these state IDs when calling update_task. If transitions are defined, only valid next states are allowed.",
          };
        }
        // Fallback: default states
        return {
          states: [
            { id: "pending", label: "Pending", category: "not-started", transitions: [] },
            { id: "in-progress", label: "In Progress", category: "active", transitions: [] },
            { id: "review", label: "Review", category: "active", transitions: [] },
            { id: "done", label: "Done", category: "closed", transitions: [] },
          ],
          pipeline: "pending → in-progress → review → done",
          hint: "Default workflow. No transition enforcement.",
        };
      } catch {
        return { error: "Could not fetch workflow states" };
      }
    }

    case "remove_agent": {
      await apiCall("DELETE", `/api/v1/sessions/${SESSION_ID}/agents/${toolArgs.agentId}`);
      return { success: true, removed: toolArgs.agentId, reason: toolArgs.reason };
    }

    case "peek_agent": {
      // Resolve agent name → ID
      const agents = (await apiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/agents`,
      )) as AgentsResponse;

      const target = findAgentByNameOrId(agents.agents || [], toolArgs.agentId || "");

      if (!target) {
        return { error: `Agent "${toolArgs.agentId}" not found` };
      }

      const lines = Math.min(parseInt(toolArgs.lines) || 15, 50);
      const outputResp = (await apiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/agents/${target.id}/output?lines=${lines}`,
      )) as { output?: string[] };

      return {
        agentName: target.config?.name || target.id,
        agentStatus: target.status,
        lines: lines,
        output: (outputResp.output || []).join("\n"),
      };
    }

    case "nudge_agent": {
      // Rate limit: 5 nudges per minute
      const nudgeNow = Date.now();
      const nudgeWindow = nudgeRateLimit.get(toolArgs.agentId);
      if (nudgeWindow && nudgeNow - nudgeWindow.windowStart < 60000 && nudgeWindow.count >= 5) {
        return { success: false, error: "Rate limited: max 5 nudges per minute per agent" };
      }

      // Resolve agent name → ID
      const agents2 = (await apiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/agents`,
      )) as AgentsResponse;

      const search2 = (toolArgs.agentId || "").toLowerCase();
      const target2 = (agents2.agents || []).find((a) => {
        const name = (a.config?.name || "").toLowerCase();
        return name === search2 || name.includes(search2) || a.id.toLowerCase().includes(search2);
      });

      if (!target2) {
        return { success: false, error: `Agent "${toolArgs.agentId}" not found` };
      }

      // Get sender name for reply path
      const selfAgents = (await apiCall("GET", `/api/v1/sessions/${SESSION_ID}/agents`)) as AgentsResponse;
      const selfAgent = (selfAgents.agents || []).find(a => a.id === AGENT_ID);
      const senderName = selfAgent?.config?.name || AGENT_ID;

      const baseMsg = toolArgs.message || "You have pending messages. Run check_messages now.";
      const msg = `[Nudge from ${senderName}]: ${baseMsg}\n↳ Reply using: send_message(to="${senderName}", message="your response")`;
      await apiCall("POST", `/api/v1/sessions/${SESSION_ID}/agents/${target2.id}/nudge`, {
        message: msg,
      });

      // Track nudge rate limit
      if (!nudgeWindow || nudgeNow - nudgeWindow.windowStart > 60000) {
        nudgeRateLimit.set(toolArgs.agentId, { count: 1, windowStart: nudgeNow });
      } else {
        nudgeWindow.count++;
      }

      return { success: true, nudged: target2.config?.name || target2.id };
    }

    case "prepare_pr": {
      // Get the calling agent's working directory
      const agentsResp = (await apiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/agents`,
      )) as AgentsResponse;

      const currentAgent = (agentsResp.agents || []).find((a) => a.id === AGENT_ID);
      if (!currentAgent || !(currentAgent.config as any)?.workingDirectory) {
        return { success: false, error: "Could not determine your working directory" };
      }

      const workDir = (currentAgent.config as any).workingDirectory;

      try {
        // Step 1: Fetch latest main
        const { stdout: fetchOut, stderr: fetchErr } = await execFileAsync("git", ["fetch", "origin", "main"], { cwd: workDir });

        // Step 2: Check how many commits behind main
        let commitsBehind = 0;
        try {
          const { stdout: revListOut } = await execFileAsync("git", ["rev-list", "--count", "HEAD..origin/main"], { cwd: workDir });
          commitsBehind = parseInt(revListOut.trim(), 10) || 0;
        } catch {
          // Ignore errors (might be on detached HEAD or orphan branch)
        }

        // Step 3: Rebase onto origin/main
        const { stdout: rebaseOut, stderr: rebaseErr } = await execFileAsync("git", ["rebase", "origin/main"], { cwd: workDir });

        // Step 4: Force-push (with lease to prevent accidental overwrites)
        const { stdout: pushOut, stderr: pushErr } = await execFileAsync("git", ["push", "origin", "HEAD", "--force-with-lease"], { cwd: workDir });

        // Auto-transition: move agent's in-progress tasks to "review" after successful PR
        let autoTransitioned: string[] = [];
        try {
          const tasksResp = (await apiCall("GET",
            `/api/v1/sessions/${SESSION_ID}/tasks?assignedTo=${AGENT_ID}&status=in-progress&summary=true`
          )) as any;
          for (const task of (tasksResp.tasks || [])) {
            try {
              await apiCall("PUT", `/api/v1/sessions/${SESSION_ID}/tasks/${task.id}`, {
                status: "review",
              });
              autoTransitioned.push(task.title || task.id);
            } catch { /* non-fatal — task may not allow this transition */ }
          }
        } catch { /* non-fatal */ }

        return {
          success: true,
          commitsBehind,
          message: commitsBehind > 0
            ? `Rebased successfully! Your branch was ${commitsBehind} commit(s) behind main.`
            : "Already up to date with main. Branch pushed.",
          autoTransitioned: autoTransitioned.length > 0
            ? `Moved ${autoTransitioned.length} task(s) to review: ${autoTransitioned.join(", ")}`
            : undefined,
          reminder: "MANDATORY: Update your task status now. Call update_task(taskId, status: 'done') after PR is merged. Never go idle with a completed task still in-progress.",
          output: {
            fetch: fetchOut + fetchErr,
            rebase: rebaseOut + rebaseErr,
            push: pushOut + pushErr,
          },
        };
      } catch (err: unknown) {
        const error = err as { stdout?: string; stderr?: string; message?: string };
        const stderr = error.stderr || "";
        const stdout = error.stdout || "";

        // Check if it's a rebase conflict — abort to leave worktree clean
        if (stderr.includes("CONFLICT") || stdout.includes("CONFLICT") || stderr.includes("could not apply")) {
          try {
            await execFileAsync("git", ["rebase", "--abort"], { cwd: workDir });
          } catch { /* may not be in rebase state */ }
          return {
            success: false,
            error: "Rebase conflict detected. Rebase aborted to keep worktree clean. Resolve conflicts manually: git fetch origin main && git rebase origin/main, fix conflicts, then git rebase --continue && git push --force-with-lease.",
            conflicts: true,
            output: stdout + "\n" + stderr,
          };
        }

        return {
          success: false,
          error: error.message || "Git operation failed",
          output: stdout + "\n" + stderr,
        };
      }
    }

    case "verify_work": {
      // Get the calling agent's working directory
      const verifyAgentsResp = (await apiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/agents`,
      )) as AgentsResponse;

      const verifyAgent = (verifyAgentsResp.agents || []).find((a) => a.id === AGENT_ID);
      if (!verifyAgent || !(verifyAgent.config as any)?.workingDirectory) {
        return { passed: false, error: "Could not determine your working directory" };
      }

      const verifyWorkDir = (verifyAgent.config as any).workingDirectory;
      const skipTests = toolArgs?.skipTests === "true";
      const results: {
        passed: boolean;
        build: "pass" | "fail" | "skipped";
        tests: "pass" | "fail" | "skipped";
        buildOutput?: string;
        testOutput?: string;
        unintendedChanges: string[];
      } = {
        passed: true,
        build: "skipped",
        tests: "skipped",
        unintendedChanges: [],
      };

      // Step 1: Run make build (type-check)
      try {
        const { stdout: buildOut, stderr: buildErr } = await execFileAsync(
          "make", ["build"],
          { cwd: verifyWorkDir, timeout: 120_000 },
        );
        results.build = "pass";
        results.buildOutput = (buildOut + buildErr).slice(-500); // Last 500 chars
      } catch (err: unknown) {
        const error = err as { stdout?: string; stderr?: string; message?: string };
        results.build = "fail";
        results.passed = false;
        results.buildOutput = ((error.stdout || "") + (error.stderr || "")).slice(-1000);
      }

      // Step 2: Run make test (unless skipped)
      if (!skipTests) {
        try {
          const { stdout: testOut, stderr: testErr } = await execFileAsync(
            "make", ["test"],
            { cwd: verifyWorkDir, timeout: 300_000 },
          );
          results.tests = "pass";
          results.testOutput = (testOut + testErr).slice(-500);
        } catch (err: unknown) {
          const error = err as { stdout?: string; stderr?: string; message?: string };
          results.tests = "fail";
          results.passed = false;
          results.testOutput = ((error.stdout || "") + (error.stderr || "")).slice(-1000);
        }
      }

      // Step 3: Check git diff --stat for unintended changes
      try {
        const { stdout: diffOut } = await execFileAsync(
          "git", ["diff", "--stat"],
          { cwd: verifyWorkDir },
        );
        if (diffOut.trim()) {
          // There are unstaged changes — could be unintended
          const changedFiles = diffOut.trim().split("\n")
            .filter(line => line.includes("|"))
            .map(line => line.split("|")[0].trim());
          results.unintendedChanges = changedFiles;
        }
      } catch {
        // Ignore git errors
      }

      return results;
    }

    case "create_pr": {
      // Get the calling agent's working directory
      const agentsResp = (await apiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/agents`,
      )) as AgentsResponse;

      const currentAgent = (agentsResp.agents || []).find((a) => a.id === AGENT_ID);
      if (!currentAgent || !(currentAgent.config as any)?.workingDirectory) {
        return { success: false, error: "Could not determine your working directory" };
      }

      const workDir = (currentAgent.config as any).workingDirectory;

      try {
        // Step 1: Get current branch name if not specified
        let headBranch = toolArgs.headBranch;
        if (!headBranch) {
          const { stdout: branchOut } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workDir });
          headBranch = branchOut.trim();
        }

        // Step 2: Get repository information from git remote
        const { stdout: remoteOut } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: workDir });
        const remoteUrl = remoteOut.trim();

        // Parse owner/repo from remote URL
        // Supports: git@github.com:owner/repo.git and https://github.com/owner/repo.git
        let owner: string;
        let repo: string;

        if (remoteUrl.startsWith("git@github.com:")) {
          const match = remoteUrl.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
          if (!match) {
            return { success: false, error: `Could not parse GitHub remote URL: ${remoteUrl}` };
          }
          owner = match[1];
          repo = match[2];
        } else if (remoteUrl.includes("github.com")) {
          const match = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
          if (!match) {
            return { success: false, error: `Could not parse GitHub remote URL: ${remoteUrl}` };
          }
          owner = match[1];
          repo = match[2];
        } else {
          return { success: false, error: `Remote URL is not a GitHub repository: ${remoteUrl}` };
        }

        // Step 3: Get GitHub token from environment or .kora.yml
        let githubToken = process.env.GITHUB_TOKEN;

        if (!githubToken && PROJECT_PATH) {
          // Try to load from .kora.yml
          try {
            const configPath = nodePath.join(PROJECT_PATH, ".kora.yml");
            const { readFile } = await import("fs/promises");
            const configRaw = await readFile(configPath, "utf-8");
            // Simple YAML parse for github.token
            const tokenMatch = configRaw.match(/github:\s*\n\s*token:\s*['"]?([^\s'"]+)['"]?/);
            if (tokenMatch) {
              githubToken = tokenMatch[1];
            }
          } catch {
            // Config file doesn't exist or can't be read
          }
        }

        if (!githubToken) {
          return {
            success: false,
            error: "GitHub token not found. Set GITHUB_TOKEN env var or add github.token to .kora.yml",
          };
        }

        // Step 4: Create PR via GitHub API
        const baseBranch = toolArgs.baseBranch || "main";
        const prPayload = {
          title: toolArgs.title,
          body: toolArgs.body,
          head: headBranch,
          base: baseBranch,
        };

        const prResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
          method: "POST",
          headers: {
            "Accept": "application/vnd.github+json",
            "Authorization": `Bearer ${githubToken}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(prPayload),
        });

        if (!prResponse.ok) {
          const errorBody = await prResponse.text();
          return {
            success: false,
            error: `GitHub API error (${prResponse.status}): ${errorBody}`,
            statusCode: prResponse.status,
          };
        }

        const prData = await prResponse.json() as { html_url: string; number: number };

        return {
          success: true,
          prUrl: prData.html_url,
          prNumber: prData.number,
          head: headBranch,
          base: baseBranch,
          repository: `${owner}/${repo}`,
        };
      } catch (err: unknown) {
        const error = err as { message?: string };
        return {
          success: false,
          error: error.message || "Failed to create PR",
        };
      }
    }

    case "report_idle": {
      const reason = toolArgs.reason || "task completed";

      // Check for stale in-progress tasks before allowing idle
      let staleTasks: Array<{ id: string; title: string; status: string }> = [];
      try {
        const tasksResp = (await apiCall("GET",
          `/api/v1/sessions/${SESSION_ID}/tasks?assignedTo=${AGENT_ID}&status=active&summary=true`
        )) as any;
        staleTasks = (tasksResp.tasks || []).filter((t: any) =>
          t.status === "in-progress" || t.status === "review"
        );
      } catch { /* non-fatal */ }

      const result = await apiCall("POST", `/api/v1/sessions/${SESSION_ID}/agents/${AGENT_ID}/report-idle`, {
        reason,
      }) as Record<string, unknown>;

      if (staleTasks.length > 0) {
        const taskList = staleTasks.map(t => `- "${t.title}" (${t.id}) — status: ${t.status}`).join("\n");
        return {
          success: true,
          activity: "idle",
          reason,
          ...result,
          warning: `You have ${staleTasks.length} task(s) still in-progress/review. Update their status before going idle:`,
          staleTasks: staleTasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
        };
      }

      return { success: true, activity: "idle", reason, ...result };
    }

    case "request_task": {
      const skills = (toolArgs as any).skills || [];
      const priority = toolArgs.priority;
      const result = await apiCall("POST", `/api/v1/sessions/${SESSION_ID}/agents/${AGENT_ID}/request-task`, {
        skills,
        priority,
      });
      return result;
    }

    case "save_knowledge": {
      if (!toolArgs.entry || !toolArgs.entry.trim()) {
        return { error: "entry is required (non-empty string)" };
      }

      // Get agent name for attribution
      const agents3 = (await apiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/agents`,
      )) as AgentsResponse;
      const self = (agents3.agents || []).find((a) => a.id === AGENT_ID);
      const agentName = self?.config?.name || AGENT_ID;

      // Save to file-based knowledge (existing)
      await apiCall("POST", `/api/v1/sessions/${SESSION_ID}/knowledge`, {
        entry: toolArgs.entry.trim(),
        agentName,
      });

      // Also save to SQLite knowledge DB if key provided
      if (toolArgs.key) {
        await apiCall("POST", `/api/v1/sessions/${SESSION_ID}/knowledge-db`, {
          key: toolArgs.key,
          value: toolArgs.entry.trim(),
          savedBy: agentName,
        });
      }

      return { success: true, saved: toolArgs.entry.trim(), key: toolArgs.key || null };
    }

    case "get_knowledge": {
      if (!toolArgs.key) return { error: "key is required" };
      const entry = await apiCall("GET", `/api/v1/sessions/${SESSION_ID}/knowledge-db/${encodeURIComponent(toolArgs.key)}`);
      return entry;
    }

    case "search_knowledge": {
      if (!toolArgs.query) return { error: "query is required" };
      const limit = toolArgs.limit || 20;
      const results = await apiCall("GET",
        `/api/v1/sessions/${SESSION_ID}/knowledge-db?q=${encodeURIComponent(toolArgs.query)}&limit=${limit}`
      );
      return results;
    }

    case "share_image": {
      if (!toolArgs.to) return { error: "to is required" };
      if (!toolArgs.filePath && !toolArgs.base64Data) return { error: "Either filePath or base64Data is required" };

      // Resolve target agent
      const agentsImg = (await apiCall("GET", `/api/v1/sessions/${SESSION_ID}/agents`)) as AgentsResponse;
      const targetImg = findAgentByNameOrId(agentsImg.agents || [], toolArgs.to);
      if (!targetImg) return { error: `Agent "${toolArgs.to}" not found` };

      // Determine filename
      const imgFilename = toolArgs.filename || (toolArgs.filePath ? nodePath.basename(toolArgs.filePath) : "screenshot.png");

      // Upload attachment
      const uploadResult = (await apiCall("POST", `/api/v1/sessions/${SESSION_ID}/attachments`, {
        filename: imgFilename,
        base64Data: toolArgs.base64Data || undefined,
        sourcePath: toolArgs.filePath || undefined,
        toAgentId: targetImg.id,
      })) as { filename?: string; url?: string; error?: string };

      if (uploadResult.error) return { error: uploadResult.error };

      // Send message with image reference
      const caption = toolArgs.caption || `Shared image: ${imgFilename}`;
      await apiCall("POST", `/api/v1/sessions/${SESSION_ID}/relay`, {
        from: AGENT_ID,
        to: targetImg.id,
        message: `[Image] ${caption}\nView: ${uploadResult.url}`,
        messageType: "image",
      });

      recordSendMessage();
      return { success: true, sentTo: targetImg.config?.name || targetImg.id, url: uploadResult.url, filename: uploadResult.filename };
    }

    default: {
      // Fallback: delegate to shared TOOL_HANDLER_MAP for tools not in the switch
      const sharedHandler = TOOL_HANDLER_MAP[toolName];
      if (sharedHandler) {
        const ctx = { agentId: AGENT_ID, sessionId: SESSION_ID, agentRole: AGENT_ROLE, projectPath: PROJECT_PATH, apiCall };
        return await sharedHandler(ctx, toolArgs);
      }
      return { error: `Unknown tool: ${toolName}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Main message handler
// ---------------------------------------------------------------------------

rl.on("line", async (line: string) => {
  let msg: {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
  };

  try {
    msg = JSON.parse(line);
  } catch {
    // Ignore non-JSON lines
    return;
  }

  const id = msg.id ?? null;

  try {
    switch (msg.method) {
      case "initialize":
        sendResponse(id, {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
            prompts: { listChanged: true },
            resources: { subscribe: true, listChanged: true },
          },
          serverInfo: {
            name: "kora-mcp",
            version: "0.1.0",
          },
        });
        break;

      case "notifications/initialized":
        // Client acknowledged initialization — no response needed
        break;

      // ── Prompts ─────────────────────────────────────────────
      case "prompts/list":
        sendResponse(id, {
          prompts: PROMPT_DEFINITIONS
            .filter(p => AGENT_ROLE === "master" || !p.name.startsWith("master"))
            .map(p => ({ name: p.name, description: p.description, arguments: p.arguments })),
        });
        break;

      case "prompts/get": {
        const promptName = msg.params?.name as string;
        const promptDef = PROMPT_DEFINITIONS.find(p => p.name === promptName);
        if (!promptDef) {
          sendError(id, -32602, `Prompt not found: ${promptName}`);
          break;
        }
        const promptCtx = { agentId: AGENT_ID, sessionId: SESSION_ID, agentRole: AGENT_ROLE, projectPath: PROJECT_PATH, apiCall };
        const promptContent = await promptDef.fetchContent(promptCtx);
        // Apply section filter if argument provided
        const sectionArg = (msg.params?.arguments as Record<string, unknown>)?.section as string | undefined;
        let finalContent = promptContent;
        if (sectionArg && promptContent) {
          const regex = new RegExp(`## ${sectionArg}[\\s\\S]*?(?=\\n## |$)`, "i");
          const match = promptContent.match(regex);
          finalContent = match ? match[0].trim() : `Section "${sectionArg}" not found.`;
        }
        sendResponse(id, {
          messages: [{ role: "user", content: { type: "text", text: finalContent } }],
        });
        break;
      }

      // ── Resources ───────────────────────────────────────────
      case "resources/list":
        sendResponse(id, {
          resources: RESOURCE_DEFINITIONS.map(r => ({
            uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType,
          })),
        });
        break;

      case "resources/read": {
        const uri = msg.params?.uri as string;
        const resDef = getResourceDefinition(uri);
        if (!resDef) {
          sendError(id, -32602, `Resource not found: ${uri}`);
          break;
        }
        const resCtx = { agentId: AGENT_ID, sessionId: SESSION_ID, agentRole: AGENT_ROLE, projectPath: PROJECT_PATH, apiCall };
        const resContent = await resDef.fetchContent(resCtx);
        sendResponse(id, {
          contents: [{ uri, mimeType: resDef.mimeType, text: resContent }],
        });
        break;
      }

      case "resources/subscribe": {
        const subUri = msg.params?.uri as string;
        resourceSubscriptions.add(subUri);
        sendResponse(id, {});
        break;
      }

      case "resources/unsubscribe": {
        const unsubUri = msg.params?.uri as string;
        resourceSubscriptions.delete(unsubUri);
        sendResponse(id, {});
        break;
      }

      case "tools/list":
        // Filter tools based on agent role permissions
        sendResponse(id, { tools: TOOL_DEFINITIONS.filter(t => isToolAllowed(t.name)) });
        break;

      case "tools/call": {
        await bootstrapPromise;
        const toolName = msg.params?.name as string;
        const toolArgs = (msg.params?.arguments || {}) as Record<string, string>;

        // Enforce tool access control
        if (!isToolAllowed(toolName)) {
          sendResponse(id, {
            content: [{ type: "text", text: JSON.stringify({
              error: `Tool "${toolName}" is not available for ${AGENT_ROLE} agents. This tool is restricted to master/orchestrator roles.`,
            }) }],
          });
          break;
        }

        try {
          const traceStart = Date.now();
          const result = await handleToolCall(toolName, toolArgs);
          const traceDuration = Date.now() - traceStart;

          // Fire-and-forget trace logging (don't block tool response)
          apiCall("POST", `/api/v1/sessions/${SESSION_ID}/agents/${AGENT_ID}/traces`, {
            toolName, inputArgs: JSON.stringify(toolArgs),
            outputResult: JSON.stringify(result).slice(0, 10240),
            durationMs: traceDuration, success: true,
          }).catch(() => {}); // non-fatal

          // === MCP PUSH: Non-destructive notification of pending messages ===
          // Single unified unread count to avoid duplicate notifications.
          // Uses countUnreadMessages() which checks API + file fallback.
          // Only check_messages should consume messages — this only counts.
          const content: Array<{ type: string; text: string }> = [];

          if (toolName !== "check_messages") {
            try {
              const unread = await countUnreadMessages();
              if (unread > 0) {
                content.push({
                  type: "text",
                  text: `[System: You have ${unread} unread message(s). Use check_messages tool to read them.]`,
                });
              }
            } catch { /* non-fatal — don't block tool response */ }
          }

          content.push(
            { type: "text", text: JSON.stringify(result, null, 2) },
          );

          sendResponse(id, { content });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // Log failed trace
          apiCall("POST", `/api/v1/sessions/${SESSION_ID}/agents/${AGENT_ID}/traces`, {
            toolName, inputArgs: JSON.stringify(toolArgs),
            outputResult: errMsg, durationMs: 0, success: false,
          }).catch(() => {});
          sendResponse(id, {
            content: [{ type: "text", text: `Error: ${errMsg}` }],
            isError: true,
          });
        }
        break;
      }

      default:
        if (id !== null) {
          sendError(id, -32601, `Method not found: ${msg.method}`);
        }
        break;
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (id !== null) {
      sendError(id, -32603, `Internal error: ${errMsg}`);
    }
  }
});

// Keep process alive
process.stdin.resume();
