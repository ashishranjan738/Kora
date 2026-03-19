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

const execFileAsync = promisify(execFile);

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
const PROJECT_PATH = getArg("project-path");
const AGENT_ROLE = getArg("agent-role") || "worker"; // default to worker (most restrictive)

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
] as const;

/** Tools allowed per role. Master gets everything, workers get subsets. */
const ROLE_TOOL_ACCESS: Record<string, Set<string>> = {
  master: new Set(ALL_TOOLS),
  worker: new Set([
    "send_message", "check_messages", "list_agents", "broadcast",
    "list_tasks", "get_task", "update_task", "create_task",
    "prepare_pr", "report_idle", "request_task",
  ]),
  // Deny: spawn_agent, remove_agent, peek_agent, nudge_agent (master-only)
};

/** Check if the current agent role is allowed to use a tool */
function isToolAllowed(toolName: string): boolean {
  const allowed = ROLE_TOOL_ACCESS[AGENT_ROLE];
  if (!allowed) return true; // unknown role — allow all (safe default for custom roles)
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
    return "http://localhost:7890";
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

function countUnreadMessages(): number {
  if (!PROJECT_PATH) return 0;
  let count = 0;
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
  return count;
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
          description: "If true (default), return compact fields only (id, title, status, assignedTo, priority, labels, dueDate). Set false for full details.",
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
      "Spawn a new worker agent in the session. Only available to master/orchestrator agents.",
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
          description: "System prompt / persona for the agent",
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
    name: "save_knowledge",
    description:
      "Save a knowledge entry that persists across sessions. Use this to record important findings, patterns, or decisions that future agents should know about. Entries are injected into all agent personas at spawn.",
    inputSchema: {
      type: "object" as const,
      properties: {
        entry: {
          type: "string",
          description: "Knowledge entry to save (e.g. 'Express 5 uses path-to-regexp v8 — no * wildcard for SPA fallback')",
        },
      },
      required: ["entry"],
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

interface EventData {
  to?: string;
  toName?: string;
  from?: string;
  fromName?: string;
  content?: string;
}

interface EventEntry {
  data?: EventData;
  timestamp?: string;
}

interface EventsResponse {
  events?: EventEntry[];
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
      const search = (toolArgs.to || "").toLowerCase();
      const target = (agents.agents || []).find((a) => {
        const name = (a.config?.name || "").toLowerCase();
        return (
          name === search ||
          name.includes(search) ||
          a.id.toLowerCase().includes(search)
        );
      });

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
      return { success: true, sentTo: target.config?.name || target.id };
    }

    case "check_messages": {
      // Read from mcp-pending (primary for MCP agents)
      const pendingMessages = readAndConsumePendingMessages();

      // Also read from inbox files (backward compat)
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
            const senderMatch = content.match(/\[(?:Message|Task|DONE|Question|Broadcast|System)[^\]]*from (.+?)\]/);
            const from = senderMatch?.[1] || "unknown";
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

      // Combine (pending first, then inbox, deduplicate by content)
      const seen = new Set<string>();
      const allMessages: Array<{ from: string; content: string; timestamp: string }> = [];

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
      if (allMessages.length > 0 || pendingMessages.length > 0 || inboxMessages.length > 0) {
        apiCall("POST", `/api/v1/sessions/${SESSION_ID}/agents/${AGENT_ID}/ack-read`).catch(() => {});
      }

      // Skip events API fallback if we have messages from either source
      if (allMessages.length > 0) {
        return { messages: allMessages, count: allMessages.length };
      }

      // Fallback: query events API for agents with no inbox/pending
      const events = (await apiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/events?limit=20&type=message-sent`,
      )) as EventsResponse;

      const incoming = (events.events || []).filter(
        (e) => e.data?.to === AGENT_ID || e.data?.toName === AGENT_ID,
      );

      const apiMessages = incoming.map((e) => ({
        from: e.data?.fromName || e.data?.from || "unknown",
        content: e.data?.content || "",
        timestamp: e.timestamp || "",
      }));

      // Also ack-read on fallback path
      if (apiMessages.length > 0) {
        apiCall("POST", `/api/v1/sessions/${SESSION_ID}/agents/${AGENT_ID}/ack-read`).catch(() => {});
      }

      return { messages: apiMessages, count: apiMessages.length };
    }

    case "list_agents": {
      const agents = (await apiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/agents`,
      )) as AgentsResponse;

      return {
        agents: (agents.agents || []).map((a) => ({
          name: a.config?.name,
          id: a.id,
          role: a.config?.role,
          status: a.status,
          activity: (a as any).activity || a.status,
          provider: a.config?.cliProvider,
          model: a.config?.model,
          isMe: a.id === AGENT_ID,
        })),
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
        const search = assignedToArg.toLowerCase();
        const target = (agents.agents || []).find((a) => {
          const name = (a.config?.name || "").toLowerCase();
          return name === search || name.includes(search) || a.id.toLowerCase().includes(search);
        });
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

      return response;
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
      const { taskId, status, comment, title, description, priority, assignedTo, dueDate } = toolArgs;
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

      // Build update payload with all editable fields
      const updatePayload: Record<string, unknown> = {};
      if (status) updatePayload.status = status;
      if (title) updatePayload.title = title;
      if (description !== undefined) updatePayload.description = description;
      if (priority) updatePayload.priority = priority;
      if (assignedTo !== undefined) updatePayload.assignedTo = assignedTo;
      if (labels !== undefined) updatePayload.labels = labels;
      if (dueDate !== undefined) updatePayload.dueDate = dueDate || null;

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
      const result = await apiCall("POST", `/api/v1/sessions/${SESSION_ID}/agents`, {
        name: toolArgs.name,
        role: toolArgs.role || "worker",
        model: toolArgs.model,
        persona: toolArgs.persona || "",
        initialTask: toolArgs.task,
        extraCliArgs: toolArgs.extraCliArgs,
      });
      return result;
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

      const search = (toolArgs.agentId || "").toLowerCase();
      const target = (agents.agents || []).find((a) => {
        const name = (a.config?.name || "").toLowerCase();
        return name === search || name.includes(search) || a.id.toLowerCase().includes(search);
      });

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

      const msg = toolArgs.message || "You have pending messages. Run check_messages now.";
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

        return {
          success: true,
          commitsBehind,
          message: commitsBehind > 0
            ? `Rebased successfully! Your branch was ${commitsBehind} commit(s) behind main.`
            : "Already up to date with main. Branch pushed.",
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

        // Check if it's a rebase conflict
        if (stderr.includes("CONFLICT") || stdout.includes("CONFLICT")) {
          return {
            success: false,
            error: "Rebase conflict detected. You need to resolve conflicts manually.",
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
            const configRaw = fs.readFileSync(configPath, "utf-8");
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
      const result = await apiCall("POST", `/api/v1/sessions/${SESSION_ID}/agents/${AGENT_ID}/report-idle`, {
        reason,
      }) as Record<string, unknown>;
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

      await apiCall("POST", `/api/v1/sessions/${SESSION_ID}/knowledge`, {
        entry: toolArgs.entry.trim(),
        agentName,
      });

      return { success: true, saved: toolArgs.entry.trim() };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
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
          capabilities: { tools: {} },
          serverInfo: {
            name: "kora-mcp",
            version: "0.1.0",
          },
        });
        break;

      case "notifications/initialized":
        // Client acknowledged initialization — no response needed
        break;

      case "tools/list":
        // Filter tools based on agent role permissions
        sendResponse(id, { tools: TOOL_DEFINITIONS.filter(t => isToolAllowed(t.name)) });
        break;

      case "tools/call": {
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
          const result = await handleToolCall(toolName, toolArgs);

          // === MCP PUSH: Inject pending messages into response ===
          const pendingMessages = (toolName !== "check_messages") ? readAndConsumePendingMessages() : [];
          const content: Array<{ type: string; text: string }> = [];

          // Prepend pending messages so agent sees them BEFORE the tool result
          if (pendingMessages.length > 0) {
            for (const pm of pendingMessages) {
              content.push({
                type: "text",
                text: `[Message from ${pm.from}]: ${pm.content}`,
              });
            }
          }

          content.push(
            { type: "text", text: JSON.stringify(result, null, 2) },
          );

          // Piggyback unread message notifications (except for check_messages itself)
          if (toolName !== "check_messages") {
            const unread = countUnreadMessages();
            if (unread > 0) {
              content.push({
                type: "text",
                text: `\n[System: You have ${unread} unread message(s). Use check_messages tool to read them.]`,
              });
            }
          }

          sendResponse(id, { content });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
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
