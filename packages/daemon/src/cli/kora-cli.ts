#!/usr/bin/env node

/**
 * kora-cli — CLI for Kora multi-agent orchestration platform.
 *
 * AUTO-GENERATED from MCP tool definitions via mcp-cli-bridge.
 * Tool commands derived from tool-registry.ts — single source of truth.
 * Manual commands: context (from resource-registry), config/infra.
 */

import { Command } from "commander";
import * as http from "http";
import * as https from "https";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { getToolDefinitionsWithCliMeta, ROLE_TOOL_ACCESS, type ToolDefinition, type ToolCliMeta } from "../tools/tool-registry.js";
import { RESOURCE_DEFINITIONS } from "../tools/resource-registry.js";
import { registerToolsAsCli } from "./mcp-cli-bridge.js";

const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

interface Cfg { daemonUrl: string; token: string; agentId: string; sessionId: string; agentRole: string; }

function cfgDir(): string {
  const e = process.env.KORA_CONFIG_DIR;
  return e || path.join(os.homedir(), `.kora${process.env.KORA_DEV === "1" ? "-dev" : ""}`);
}

function rd(p: string): string { try { return fs.readFileSync(p, "utf-8").trim(); } catch { return ""; } }

function sanitizeToken(raw: string): string {
  const c = raw.replace(/[\r\n]/g, "").trim();
  if (c && !/^[a-zA-Z0-9_-]+$/.test(c)) { process.stderr.write("Error: Invalid token format.\n"); process.exit(1); }
  return c;
}

function resolveConfig(go: { session?: string; agent?: string }): Cfg {
  const d = cfgDir();
  const rawToken = process.env.KORA_TOKEN || rd(path.join(d, "daemon.token"));
  const token = rawToken ? sanitizeToken(rawToken) : "";
  const port = rd(path.join(d, "daemon.port"));
  const daemonUrl = process.env.KORA_DAEMON_URL || (port ? `http://localhost:${port}` : `http://localhost:${process.env.KORA_DEV === "1" ? 7891 : 7890}`);
  return { daemonUrl, token, agentId: go.agent || process.env.KORA_AGENT_ID || "", sessionId: go.session || process.env.KORA_SESSION_ID || "", agentRole: process.env.KORA_AGENT_ROLE || "worker" };
}

// ---------------------------------------------------------------------------
// HTTP client with retry
// ---------------------------------------------------------------------------

function apiCall(c: Cfg, method: string, urlPath: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, c.daemonUrl);
    const tls = url.protocol === "https:";
    const t = tls ? https : http;
    const req = t.request({ method, hostname: url.hostname, port: url.port || (tls ? 443 : 80), path: url.pathname + url.search, headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json", ...(c.agentId ? { "X-Agent-Id": c.agentId } : {}), ...(c.agentRole ? { "X-Agent-Role": c.agentRole } : {}) } }, (res) => {
      let data = ""; res.on("data", (ch: Buffer) => { data += ch.toString(); });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) { try { const p = JSON.parse(data); reject(new Error(p.error || p.message || `HTTP ${res.statusCode}`)); } catch { reject(new Error(`HTTP ${res.statusCode}: ${data}`)); } return; }
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on("error", (err) => { reject((err as NodeJS.ErrnoException).code === "ECONNREFUSED" ? new Error("Cannot connect to Kora daemon. Is it running?") : err); });
    if (body) req.write(JSON.stringify(body)); req.end();
  });
}

async function api(c: Cfg, method: string, urlPath: string, body?: unknown, maxRetries = 2): Promise<unknown> {
  for (let i = 0; i <= maxRetries; i++) {
    try { return await apiCall(c, method, urlPath, body); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (i === maxRetries || !msg.includes("Cannot connect")) throw err;
      process.stderr.write(`Connection failed (attempt ${i + 1}/${maxRetries + 1}), retrying in ${i + 1}s...\n`);
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error("Unreachable");
}

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

const MASTER_ONLY = new Set(
  Object.keys(ROLE_TOOL_ACCESS.master || {}).length
    ? [...(ROLE_TOOL_ACCESS.master || new Set())].filter(t => !(ROLE_TOOL_ACCESS.worker || new Set()).has(t))
    : ["spawn_agent", "remove_agent", "peek_agent", "nudge_agent", "delete_task"]
);

function requireMaster(toolName: string): void {
  const role = process.env.KORA_AGENT_ROLE;
  if (role && role !== "master" && MASTER_ONLY.has(toolName)) {
    process.stderr.write(`Error: "${toolName}" is restricted to master/orchestrator agents. Your role: ${role}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function out(data: unknown, json?: boolean): void {
  process.stdout.write((json ? JSON.stringify(data, null, 2) : typeof data === "string" ? data : JSON.stringify(data, null, 2)) + "\n");
}

// ---------------------------------------------------------------------------
// Tool handler — maps tool calls to daemon API
// ---------------------------------------------------------------------------

let cfg: Cfg;

/** Universal tool handler: routes tool calls to the daemon REST API */
async function toolHandler(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  requireMaster(toolName);
  const sid = cfg.sessionId;
  const aid = cfg.agentId;
  if (!sid) { process.stderr.write("Error: No session ID. Set KORA_SESSION_ID or --session.\n"); process.exit(1); }

  // Route to appropriate API endpoint based on tool name
  switch (toolName) {
    case "send_message": return api(cfg, "POST", `/api/v1/sessions/${sid}/relay`, { from: aid, to: args.to, message: args.message, messageType: args.messageType, channel: args.channel });
    case "check_messages": {
      const r = (await api(cfg, "GET", `/api/v1/sessions/${sid}/agents/${aid}/messages?status=pending&status=delivered`)) as Record<string, unknown>;
      const msgs = (r.messages || []) as Array<Record<string, unknown>>;
      if (msgs.length) await api(cfg, "POST", `/api/v1/sessions/${sid}/agents/${aid}/messages/mark-read`, { messageIds: msgs.map(m => m.id) });
      return r;
    }
    case "list_agents": return api(cfg, "GET", `/api/v1/sessions/${sid}/agents`);
    case "broadcast": return api(cfg, "POST", `/api/v1/sessions/${sid}/broadcast`, { from: aid, message: args.message });
    case "list_tasks": {
      const p = new URLSearchParams();
      if (args.assignedTo) p.set("assignedTo", args.assignedTo === "me" ? aid : args.assignedTo as string);
      if (args.status) p.set("status", args.status as string);
      if (args.label) p.set("label", args.label as string);
      if (args.sortBy) p.set("sortBy", args.sortBy as string);
      if (args.due) p.set("due", args.due as string);
      if (args.summary === false) p.set("summary", "false");
      if (args.maxTasks) p.set("maxTasks", String(args.maxTasks));
      return api(cfg, "GET", `/api/v1/sessions/${sid}/tasks?${p}`);
    }
    case "get_task": return api(cfg, "GET", `/api/v1/sessions/${sid}/tasks/${args.taskId}`);
    case "update_task": { const b: Record<string, unknown> = {}; for (const [k, v] of Object.entries(args)) { if (k !== "taskId" && v !== undefined) b[k] = v; } return api(cfg, "PUT", `/api/v1/sessions/${sid}/tasks/${args.taskId}`, b); }
    case "create_task": return api(cfg, "POST", `/api/v1/sessions/${sid}/tasks`, args);
    case "delete_task": return api(cfg, "DELETE", `/api/v1/sessions/${sid}/tasks/${args.taskId}`);
    case "spawn_agent": return api(cfg, "POST", `/api/v1/sessions/${sid}/agents`, { ...args, cliProvider: args.provider });
    case "remove_agent": return api(cfg, "DELETE", `/api/v1/sessions/${sid}/agents/${args.agentId}${args.reason ? `?reason=${encodeURIComponent(args.reason as string)}` : ""}`);
    case "peek_agent": return api(cfg, "GET", `/api/v1/sessions/${sid}/agents/${args.agentId}/output?lines=${Math.min(parseInt(String(args.lines || 15)), 50)}`);
    case "nudge_agent": return api(cfg, "POST", `/api/v1/sessions/${sid}/agents/${args.agentId}/nudge`, args.message ? { message: args.message } : {});
    case "report_idle": return api(cfg, "POST", `/api/v1/sessions/${sid}/agents/${aid}/report-idle`, args.reason ? { reason: args.reason } : {});
    case "request_task": return api(cfg, "POST", `/api/v1/sessions/${sid}/agents/${aid}/request-task`, args);
    case "get_workflow_states": return api(cfg, "GET", `/api/v1/sessions/${sid}/workflow-states`);
    case "list_personas": return api(cfg, "GET", `/api/v1/personas${args.includeFullText ? "?includeFullText=true" : ""}`);
    case "save_persona": return api(cfg, "POST", `/api/v1/personas`, { name: args.name, fullText: args.fullText, description: args.description });
    case "save_knowledge": return args.key ? api(cfg, "POST", `/api/v1/sessions/${sid}/knowledge-db`, { key: args.key, value: args.entry }) : api(cfg, "POST", `/api/v1/sessions/${sid}/knowledge`, { entry: args.entry });
    case "get_knowledge": return api(cfg, "GET", `/api/v1/sessions/${sid}/knowledge-db/${encodeURIComponent(args.key as string)}`);
    case "search_knowledge": return api(cfg, "GET", `/api/v1/sessions/${sid}/knowledge-db?q=${encodeURIComponent(args.query as string)}&limit=${args.limit || 20}`);
    case "share_file": { const b: Record<string, unknown> = { toAgentId: args.to }; if (args.filePath) { const f = path.resolve(args.filePath as string); b.base64Data = fs.readFileSync(f).toString("base64"); b.filename = path.basename(f); } if (args.caption) b.caption = args.caption; return api(cfg, "POST", `/api/v1/sessions/${sid}/attachments`, b); }
    case "whoami": { const [pr, ar, wr] = await Promise.all([api(cfg, "GET", `/api/v1/sessions/${sid}/agents/${aid}/persona`), api(cfg, "GET", `/api/v1/sessions/${sid}/agents`), api(cfg, "GET", `/api/v1/sessions/${sid}/workflow-states`)]); return { ...(pr as object), agents: (ar as Record<string, unknown>).agents, workflow: (wr as Record<string, unknown>).states }; }
    case "get_context": return api(cfg, "GET", `/api/v1/sessions/${sid}/agents/${aid}/context`);
    case "channel_list": return api(cfg, "GET", `/api/v1/sessions/${sid}/channels`);
    case "channel_join": return api(cfg, "POST", `/api/v1/sessions/${sid}/channels/${encodeURIComponent(args.channel as string)}/join`, { agentId: aid });
    case "channel_history": return api(cfg, "GET", `/api/v1/sessions/${sid}/channels/${encodeURIComponent(args.channel as string)}/messages?limit=${Math.min(parseInt(String(args.limit || 20)), 100)}`);
    default: return { error: `Unknown tool: ${toolName}` };
  }
}

// ---------------------------------------------------------------------------
// CLI program — auto-generated from tool definitions
// ---------------------------------------------------------------------------

const prog = new Command();
prog.name("kora-cli").version(VERSION).description("CLI for Kora multi-agent orchestration platform")
  .option("--json", "JSON output").option("--session <id>", "Session ID").option("--agent <id>", "Agent ID")
  .hook("preAction", () => { const o = prog.opts(); cfg = resolveConfig({ session: o.session, agent: o.agent }); });

// Auto-register all 30 MCP tools as CLI commands from tool-registry
const toolDefs = getToolDefinitionsWithCliMeta();

// Separate grouped tools from direct tools
const groups = new Map<string, Array<ToolDefinition & { _originalName: string }>>();
const directTools: ToolDefinition[] = [];

for (const tool of toolDefs) {
  const meta = tool.cliMeta as ToolCliMeta | undefined;
  if (meta?.group && meta?.subcommand) {
    if (!groups.has(meta.group)) groups.set(meta.group, []);
    groups.get(meta.group)!.push({
      ...tool,
      _originalName: tool.name,
      name: meta.subcommand,
      cliMeta: { positionalArgs: meta.positionalArgs, aliases: meta.aliases },
    });
  } else {
    directTools.push(tool);
  }
}

// Register direct tools on program
registerToolsAsCli(prog, directTools, toolHandler);

// Register grouped tools as subcommands
for (const [groupName, tools] of groups) {
  const groupCmd = prog.command(groupName).description(`${groupName} operations`);
  registerToolsAsCli(groupCmd, tools, (subName, args) => {
    const tool = tools.find(t => t.name === subName);
    return toolHandler((tool as any)?._originalName || subName, args);
  });
}

// Manual: context commands (auto-registered from resource registry)
const ctxCmd = prog.command("context").description("Read session context");
for (const res of RESOURCE_DEFINITIONS) {
  const name = res.uri.replace("kora://", "");
  ctxCmd.command(name).description(res.description).action(async () => {
    const sid = cfg.sessionId; const aid = cfg.agentId;
    if (!sid) { process.stderr.write("Error: No session ID.\n"); process.exit(1); }
    const result = await api(cfg, "GET", `/api/v1/sessions/${sid}/agents/${aid}/context`);
    out(prog.opts().json ? { uri: res.uri, data: (result as Record<string, unknown>)[name] } : JSON.stringify((result as Record<string, unknown>)[name], null, 2), prog.opts().json);
  });
}
ctxCmd.command("all").description("Show all context").action(async () => {
  const sid = cfg.sessionId; const aid = cfg.agentId;
  if (!sid) { process.stderr.write("Error: No session ID.\n"); process.exit(1); }
  const result = await api(cfg, "GET", `/api/v1/sessions/${sid}/agents/${aid}/context`);
  out(result, prog.opts().json);
});

// Run
prog.parseAsync(process.argv).catch((err: Error) => { process.stderr.write(`Error: ${err.message}\n`); process.exit(1); });
