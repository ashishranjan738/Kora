#!/usr/bin/env node

/**
 * kora-cli — CLI for Kora multi-agent orchestration platform.
 *
 * Config resolution (priority order):
 * 1. CLI flags: --session, --agent
 * 2. Env vars: KORA_AGENT_ID, KORA_SESSION_ID, KORA_TOKEN, KORA_DAEMON_URL
 * 3. File fallback: ~/.kora[-dev]/daemon.port + daemon.token
 */

import { Command } from "commander";
import * as http from "http";
import * as https from "https";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Config
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

function resolve(go: { session?: string; agent?: string }): Cfg {
  const d = cfgDir();
  const rawToken = process.env.KORA_TOKEN || rd(path.join(d, "daemon.token"));
  const token = rawToken ? sanitizeToken(rawToken) : "";
  const port = rd(path.join(d, "daemon.port"));
  const daemonUrl = process.env.KORA_DAEMON_URL || (port ? `http://localhost:${port}` : `http://localhost:${process.env.KORA_DEV === "1" ? 7891 : 7890}`);
  return { daemonUrl, token, agentId: go.agent || process.env.KORA_AGENT_ID || "", sessionId: go.session || process.env.KORA_SESSION_ID || "", agentRole: process.env.KORA_AGENT_ROLE || "worker" };
}

// ---------------------------------------------------------------------------
// HTTP (http + https)
// ---------------------------------------------------------------------------

function api(c: Cfg, method: string, urlPath: string, body?: unknown): Promise<unknown> {
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

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function out(data: unknown, json?: boolean): void {
  process.stdout.write((json ? JSON.stringify(data, null, 2) : typeof data === "string" ? data : JSON.stringify(data, null, 2)) + "\n");
}

function fmtAgents(a: Array<Record<string, unknown>>): string {
  if (!a.length) return "No agents found.";
  return a.map((x) => { const c = x.config as Record<string, unknown> | undefined; return `  ${x.name || x.id} (${x.role || c?.role || ""}) — ${x.status || "?"}${x.provider || c?.cliProvider ? ` [${x.provider || c?.cliProvider}]` : ""}`; }).join("\n");
}
function fmtTasks(t: Array<Record<string, unknown>>): string {
  if (!t.length) return "No tasks found.";
  return t.map((x) => `  [${(x.id as string || "").slice(0, 8)}] ${x.priority ? x.priority + " " : ""}${x.status} — ${x.title} (${x.assignedTo || "unassigned"})`).join("\n");
}
function fmtTask(t: Record<string, unknown>): string {
  const l = [`Title:       ${t.title}`, `ID:          ${t.id}`, `Status:      ${t.status}`, `Priority:    ${t.priority || "P2"}`, `Assigned To: ${t.assignedTo || "unassigned"}`];
  if (t.labels) l.push(`Labels:      ${(t.labels as string[]).join(", ")}`);
  if (t.dueDate) l.push(`Due Date:    ${t.dueDate}`);
  if (t.description) l.push(`\nDescription:\n${t.description}`);
  if (t.comments && Array.isArray(t.comments) && (t.comments as unknown[]).length > 0) {
    l.push(`\nComments (${(t.comments as unknown[]).length}):`);
    for (const c of t.comments as Array<Record<string, unknown>>) l.push(`  [${(c.createdAt as string || "").slice(0, 16)}] ${c.authorName || c.author}: ${c.text}`);
  }
  return l.join("\n");
}
function fmtMsgs(m: Array<Record<string, unknown>>): string {
  if (!m.length) return "No new messages.";
  return m.map((x) => `  [${(x.timestamp as string || "").slice(11, 19)}] ${x.from || "?"}: ${x.content}`).join("\n");
}
function fmtWf(d: Record<string, unknown>): string {
  const s = (d.states || d.workflowStates) as Array<Record<string, unknown>> | undefined;
  if (!s?.length) return "No workflow states.";
  return ["Workflow:", ...s.map((x) => `  ${x.name} (${x.id})${x.category ? ` [${x.category}]` : ""}${(x.transitions as string[] || []).length ? ` -> ${(x.transitions as string[]).join(", ")}` : ""}`)].join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function rS(c: Cfg): string { if (!c.sessionId) { process.stderr.write("Error: No session ID. Set KORA_SESSION_ID or --session.\n"); process.exit(1); } return c.sessionId; }
function rA(c: Cfg): string { if (!c.agentId) { process.stderr.write("Error: No agent ID. Set KORA_AGENT_ID or --agent.\n"); process.exit(1); } return c.agentId; }

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
let cfg: Cfg;
const prog = new Command();
prog.name("kora-cli").version(VERSION).description("CLI for Kora multi-agent orchestration platform")
  .option("--json", "JSON output").option("--session <id>", "Session ID").option("--agent <id>", "Agent ID")
  .hook("preAction", () => { const o = prog.opts(); cfg = resolve({ session: o.session, agent: o.agent }); });
const J = () => prog.opts().json as boolean | undefined;

// send
prog.command("send <to> <message>").description("Send a message to another agent")
  .option("--type <type>", "Message type", "text").option("--channel <ch>", "Channel")
  .action(async (to: string, msg: string, o: { type?: string; channel?: string }) => {
    const r = await api(cfg, "POST", `/api/v1/sessions/${rS(cfg)}/relay`, { from: cfg.agentId, to, content: msg, messageType: o.type, channel: o.channel });
    out(J() ? r : "Message sent.", J());
  });

// messages
prog.command("messages").alias("check").description("Check for new messages").action(async () => {
  const sid = rS(cfg), aid = rA(cfg);
  const r = (await api(cfg, "GET", `/api/v1/sessions/${sid}/agents/${aid}/messages?status=pending&status=delivered`)) as Record<string, unknown>;
  const m = (r.messages || []) as Array<Record<string, unknown>>;
  if (m.length) await api(cfg, "POST", `/api/v1/sessions/${sid}/agents/${aid}/messages/mark-read`, { messageIds: m.map((x) => x.id) });
  out(J() ? r : fmtMsgs(m), J());
});

// agents
prog.command("agents").alias("list-agents").description("List agents").action(async () => {
  const r = (await api(cfg, "GET", `/api/v1/sessions/${rS(cfg)}/agents`)) as Record<string, unknown>;
  out(J() ? r : fmtAgents((r.agents || []) as Array<Record<string, unknown>>), J());
});

// broadcast
prog.command("broadcast <message>").description("Broadcast to all agents").action(async (msg: string) => {
  await api(cfg, "POST", `/api/v1/sessions/${rS(cfg)}/broadcast`, { from: cfg.agentId, content: msg });
  out(J() ? { success: true } : "Broadcast sent.", J());
});

// tasks
prog.command("tasks").description("List tasks")
  .option("--assignee <a>", "Filter assignee (me/all/name)", "me").option("--status <s>", "Filter status", "active")
  .option("--label <l>", "Filter label").option("--sort <s>", "Sort: created/due/priority", "created")
  .action(async (o: { assignee?: string; status?: string; label?: string; sort?: string }) => {
    const p = new URLSearchParams();
    if (o.assignee) p.set("assignedTo", o.assignee === "me" ? cfg.agentId : o.assignee);
    if (o.status) p.set("status", o.status); if (o.label) p.set("label", o.label); if (o.sort) p.set("sortBy", o.sort);
    const r = (await api(cfg, "GET", `/api/v1/sessions/${rS(cfg)}/tasks?${p}`)) as Record<string, unknown>;
    out(J() ? r : fmtTasks((r.tasks || []) as Array<Record<string, unknown>>), J());
  });

// task get/update/create
const tCmd = prog.command("task").description("Task ops");
tCmd.command("get <id>").alias("show").description("Get task details").action(async (id: string) => {
  const r = (await api(cfg, "GET", `/api/v1/sessions/${rS(cfg)}/tasks/${id}`)) as Record<string, unknown>;
  out(J() ? r : fmtTask((r.task || r) as Record<string, unknown>), J());
});
tCmd.command("update <id>").description("Update task")
  .option("--status <s>").option("--comment <c>").option("--priority <p>").option("--assign <a>")
  .option("--title <t>").option("--labels <l>").option("--due <d>").option("--force")
  .action(async (id: string, o: Record<string, string | boolean | undefined>) => {
    const b: Record<string, unknown> = {};
    if (o.status) b.status = o.status; if (o.comment) b.comment = o.comment;
    if (o.priority) b.priority = o.priority; if (o.assign) b.assignedTo = o.assign;
    if (o.title) b.title = o.title; if (o.labels) b.labels = (o.labels as string).split(",").map((x: string) => x.trim());
    if (o.due) b.dueDate = o.due; if (o.force) b.force = true;
    const r = await api(cfg, "PUT", `/api/v1/sessions/${rS(cfg)}/tasks/${id}`, b);
    out(J() ? r : "Task updated.", J());
  });
tCmd.command("create <title>").description("Create task")
  .option("--desc <d>").option("--assign <a>").option("--priority <p>", "", "P2").option("--labels <l>").option("--due <d>")
  .action(async (title: string, o: Record<string, string | undefined>) => {
    const b: Record<string, unknown> = { title };
    if (o.desc) b.description = o.desc; if (o.assign) b.assignedTo = o.assign;
    if (o.priority) b.priority = o.priority; if (o.labels) b.labels = (o.labels as string).split(",").map((x: string) => x.trim());
    if (o.due) b.dueDate = o.due;
    const r = (await api(cfg, "POST", `/api/v1/sessions/${rS(cfg)}/tasks`, b)) as Record<string, unknown>;
    const t = (r.task || r) as Record<string, unknown>;
    out(J() ? r : `Task created: ${t.id} — ${t.title}`, J());
  });

// workflow
prog.command("workflow").description("Show workflow states").action(async () => {
  const r = (await api(cfg, "GET", `/api/v1/sessions/${rS(cfg)}/workflow-states`)) as Record<string, unknown>;
  out(J() ? r : fmtWf(r), J());
});

// agent spawn/remove/peek/nudge
const aCmd = prog.command("agent").description("Agent ops");
aCmd.command("spawn <name>").description("Spawn agent (master only)")
  .requiredOption("--model <m>").option("--role <r>", "", "worker").option("--persona <p>")
  .option("--persona-id <id>").option("--task <t>").option("--provider <p>")
  .action(async (name: string, o: Record<string, string | undefined>) => {
    const b: Record<string, unknown> = { name, model: o.model };
    if (o.role) b.role = o.role; if (o.persona) b.persona = o.persona;
    if (o.personaId) b.personaId = o.personaId; if (o.task) b.task = o.task; if (o.provider) b.cliProvider = o.provider;
    const r = (await api(cfg, "POST", `/api/v1/sessions/${rS(cfg)}/agents`, b)) as Record<string, unknown>;
    out(J() ? r : `Agent spawned: ${(r.agent as Record<string, unknown>)?.id || name}`, J());
  });
aCmd.command("remove <id>").alias("stop").description("Remove agent (master only)").option("--reason <r>")
  .action(async (id: string, o: { reason?: string }) => {
    await api(cfg, "DELETE", `/api/v1/sessions/${rS(cfg)}/agents/${id}${o.reason ? `?reason=${encodeURIComponent(o.reason)}` : ""}`);
    out(J() ? { success: true } : `Agent ${id} removed.`, J());
  });
aCmd.command("peek <id>").description("View agent terminal (master only)").option("--lines <n>", "", "15")
  .action(async (id: string, o: { lines?: string }) => {
    const n = Math.min(parseInt(o.lines || "15", 10), 50);
    const r = (await api(cfg, "GET", `/api/v1/sessions/${rS(cfg)}/agents/${id}/output?lines=${n}`)) as Record<string, unknown>;
    if (J()) { out(r, true); } else { const t = r.output; out(Array.isArray(t) ? t.join("\n") : (t || r.text || "") as string, false); }
  });
aCmd.command("nudge <id>").description("Nudge agent (master only)").option("--message <m>")
  .action(async (id: string, o: { message?: string }) => {
    const b: Record<string, unknown> = {}; if (o.message) b.message = o.message;
    await api(cfg, "POST", `/api/v1/sessions/${rS(cfg)}/agents/${id}/nudge`, b);
    out(J() ? { success: true } : `Agent ${id} nudged.`, J());
  });

// pr prepare/create (delegate to agent)
const pCmd = prog.command("pr").description("PR ops");
pCmd.command("prepare").description("Rebase + push (via agent)").action(async () => {
  await api(cfg, "POST", `/api/v1/sessions/${rS(cfg)}/agents/${rA(cfg)}/message`, { content: "Please run prepare_pr." });
  out(J() ? { success: true } : "Prepare-PR request sent.", J());
});
pCmd.command("create").description("Create PR (via agent)").requiredOption("--title <t>").requiredOption("--body <b>").option("--base <br>", "", "main")
  .action(async (o: { title: string; body: string; base?: string }) => {
    await api(cfg, "POST", `/api/v1/sessions/${rS(cfg)}/agents/${rA(cfg)}/message`, { content: `Create PR: title="${o.title}", body="${o.body}", base="${o.base}"` });
    out(J() ? { success: true } : "Create-PR request sent.", J());
  });

// verify (delegate to agent)
prog.command("verify").description("Verify work (via agent)").option("--skip-tests")
  .action(async (o: { skipTests?: boolean }) => {
    await api(cfg, "POST", `/api/v1/sessions/${rS(cfg)}/agents/${rA(cfg)}/message`, { content: o.skipTests ? "Run verify_work skipTests=true." : "Run verify_work." });
    out(J() ? { success: true } : "Verify request sent.", J());
  });

// idle
prog.command("idle").description("Report idle").option("--reason <r>").action(async (o: { reason?: string }) => {
  const b: Record<string, unknown> = {}; if (o.reason) b.reason = o.reason;
  await api(cfg, "POST", `/api/v1/sessions/${rS(cfg)}/agents/${rA(cfg)}/report-idle`, b);
  out(J() ? { success: true } : "Reported idle.", J());
});

// request-task
prog.command("request-task").description("Request next task").option("--skills <s>").option("--priority <p>")
  .action(async (o: { skills?: string; priority?: string }) => {
    const b: Record<string, unknown> = {};
    if (o.skills) b.skills = o.skills.split(",").map((x: string) => x.trim()); if (o.priority) b.priority = o.priority;
    const r = (await api(cfg, "POST", `/api/v1/sessions/${rS(cfg)}/agents/${rA(cfg)}/request-task`, b)) as Record<string, unknown>;
    const t = (r.task || r) as Record<string, unknown>;
    out(J() ? r : (t.id ? `Assigned: [${(t.id as string).slice(0, 8)}] ${t.title}` : "No tasks available."), J());
  });

// knowledge
const kCmd = prog.command("knowledge").alias("kb").description("Knowledge ops");
kCmd.command("save <entry>").description("Save knowledge").option("--key <k>").action(async (entry: string, o: { key?: string }) => {
  const sid = rS(cfg);
  if (o.key) await api(cfg, "POST", `/api/v1/sessions/${sid}/knowledge-db`, { key: o.key, value: entry });
  else await api(cfg, "POST", `/api/v1/sessions/${sid}/knowledge`, { entry });
  out(J() ? { success: true } : "Saved.", J());
});
kCmd.command("get <key>").description("Get by key").action(async (key: string) => {
  const r = (await api(cfg, "GET", `/api/v1/sessions/${rS(cfg)}/knowledge-db/${encodeURIComponent(key)}`)) as Record<string, unknown>;
  out(J() ? r : (r.entry || r.value || "Not found.") as string, J());
});
kCmd.command("search <query>").description("Search knowledge").option("--limit <n>", "", "20").action(async (q: string, o: { limit?: string }) => {
  const r = (await api(cfg, "GET", `/api/v1/sessions/${rS(cfg)}/knowledge-db?q=${encodeURIComponent(q)}&limit=${parseInt(o.limit || "20", 10)}`)) as Record<string, unknown>;
  if (J()) { out(r, true); } else { const e = (r.entries || []) as Array<Record<string, unknown>>; out(e.length ? e.map((x) => `  [${x.key || "—"}] ${x.entry || x.value}`).join("\n") : "No results.", false); }
});

// personas
prog.command("personas").description("List personas").option("--full").action(async (o: { full?: boolean }) => {
  const r = (await api(cfg, "GET", `/api/v1/personas${o.full ? "?includeFullText=true" : ""}`)) as Record<string, unknown>;
  if (J()) { out(r, true); } else { const p = (r.personas || []) as Array<Record<string, unknown>>; out(p.length ? p.map((x) => `  ${x.id} — ${x.name}${x.description ? `: ${x.description}` : ""}`).join("\n") : "No personas.", false); }
});
const psCmd = prog.command("persona").description("Persona ops");
psCmd.command("save").description("Save persona").requiredOption("--name <n>").requiredOption("--text <t>").option("--desc <d>")
  .action(async (o: { name: string; text: string; desc?: string }) => {
    const b: Record<string, unknown> = { name: o.name, fullText: o.text }; if (o.desc) b.description = o.desc;
    await api(cfg, "POST", `/api/v1/personas`, b);
    out(J() ? { success: true } : `Persona saved: ${o.name}`, J());
  });

// share-image
prog.command("share-image <to>").description("Share image").option("--file <f>").option("--caption <c>")
  .action(async (to: string, o: { file?: string; caption?: string }) => {
    const b: Record<string, unknown> = { toAgentId: to };
    if (o.file) { const f = path.resolve(o.file); b.base64Data = fs.readFileSync(f).toString("base64"); b.filename = path.basename(f); }
    if (o.caption) b.caption = o.caption;
    await api(cfg, "POST", `/api/v1/sessions/${rS(cfg)}/attachments`, b);
    out(J() ? { success: true } : "Image shared.", J());
  });

// Run
prog.parseAsync(process.argv).catch((err: Error) => { process.stderr.write(`Error: ${err.message}\n`); process.exit(1); });
