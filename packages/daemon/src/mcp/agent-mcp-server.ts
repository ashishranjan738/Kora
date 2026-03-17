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
  try {
    const path = require("path");
    const port = fs.readFileSync(path.join(getConfigDir(), "daemon.port"), "utf-8").trim();
    return `http://localhost:${port}`;
  } catch {
    return getArg("daemon-url") || "http://localhost:7890";
  }
}

function getToken(): string {
  try {
    const path = require("path");
    return fs.readFileSync(path.join(getConfigDir(), "daemon.token"), "utf-8").trim();
  } catch {
    return getArg("token");
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

function countUnreadMessages(): number {
  if (!PROJECT_PATH) return 0;
  let count = 0;
  try {
    const inboxDir = nodePath.join(PROJECT_PATH, ".kora", "messages", `inbox-${AGENT_ID}`);
    const files = fs.readdirSync(inboxDir);
    count += files.filter((f: string) => f.endsWith(".md")).length;
  } catch { /* inbox may not exist */ }
  try {
    const pendingDir = nodePath.join(PROJECT_PATH, ".kora", "mcp-pending", AGENT_ID);
    const files = fs.readdirSync(pendingDir);
    count += files.filter((f: string) => f.endsWith(".json")).length;
  } catch { /* pending dir may not exist */ }
  return count;
}

function readAndConsumePendingMessages(): Array<{ from: string; content: string; timestamp: string }> {
  if (!PROJECT_PATH) return [];

  const pendingDir = nodePath.join(PROJECT_PATH, ".kora", "mcp-pending", AGENT_ID);
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

function apiCall(method: string, urlPath: string, body?: unknown): Promise<unknown> {
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
      "List tasks in the current session. Shows tasks assigned to you and unassigned tasks.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "update_task",
    description:
      "Update a task's status or add a comment/update. Use this to report progress on assigned tasks.",
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
        const inboxDir = nodePath.join(PROJECT_PATH, ".kora", "messages", `inbox-${AGENT_ID}`);
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
      const response = (await apiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/tasks`,
      )) as { tasks?: Array<{ id: string; title: string; status: string; dependencies?: string[]; [key: string]: unknown }> };

      // Enhance tasks with dependency blocking info
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

    case "update_task": {
      const { taskId, status, comment } = toolArgs;
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

      // Update status if provided
      if (status) {
        results.statusUpdate = await apiCall(
          "PUT",
          `/api/v1/sessions/${SESSION_ID}/tasks/${taskId}`,
          { status },
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
      });
      return result;
    }

    case "remove_agent": {
      await apiCall("DELETE", `/api/v1/sessions/${SESSION_ID}/agents/${toolArgs.agentId}`);
      return { success: true, removed: toolArgs.agentId, reason: toolArgs.reason };
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
        sendResponse(id, { tools: TOOL_DEFINITIONS });
        break;

      case "tools/call": {
        const toolName = msg.params?.name as string;
        const toolArgs = (msg.params?.arguments || {}) as Record<string, string>;

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
