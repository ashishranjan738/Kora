/**
 * Resource Registry — MCP resources for live context delivery.
 * Each resource is fetchable via daemon API and optionally subscribable for live updates.
 */

import type { ToolContext, AgentInfo, TaskInfo } from "./tool-context.js";

export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  /** Can agents subscribe for live updates? */
  subscribable: boolean;
  /** Fetch resource content via daemon API */
  fetchContent: (ctx: ToolContext) => Promise<string>;
  /** Return structured data (for tool/JSON responses) */
  fetchData: (ctx: ToolContext) => Promise<unknown>;
  /** CLI equivalent command */
  cli?: { command: string; description: string };
}

function formatTeamMarkdown(agents: AgentInfo[], selfId: string): string {
  if (!agents.length) return "No agents in session.";
  const lines = ["| Name | Role | Status | ID |", "|------|------|--------|-----|"];
  for (const a of agents) {
    const marker = a.id === selfId ? " (you)" : "";
    lines.push(`| ${a.config?.name || a.id}${marker} | ${a.config?.role || "?"} | ${a.status || "?"} | ${a.id} |`);
  }
  return lines.join("\n");
}

function formatWorkflowMarkdown(states: Array<{ id: string; label: string; transitions?: string[]; instructions?: string }>): string {
  if (!states.length) return "No custom workflow configured (using defaults).";
  const pipeline = states.map(s => s.label || s.id).join(" → ");
  const details = states.map(s => {
    const line = `- **${s.label || s.id}** (${s.id}) → ${(s.transitions || []).join(", ") || "none"}`;
    return s.instructions ? `${line}\n  ${s.instructions}` : line;
  });
  return `Pipeline: ${pipeline}\n\n${details.join("\n")}`;
}

function formatKnowledgeMarkdown(entries: Array<{ key?: string; entry?: string; value?: string; author?: string }>): string {
  if (!entries.length) return "No knowledge entries yet.";
  return entries.map(e => {
    const key = e.key ? `**${e.key}**: ` : "";
    const val = e.entry || e.value || "";
    const author = e.author ? ` _(${e.author})_` : "";
    return `- ${key}${val}${author}`;
  }).join("\n");
}

function formatRulesMarkdown(rules: string[] | undefined): string {
  if (!rules?.length) return "No project rules configured.";
  return rules.map(r => `- ${r}`).join("\n");
}

function formatTasksMarkdown(tasks: TaskInfo[]): string {
  if (!tasks.length) return "No active tasks assigned to you.";
  return tasks.map(t => `- **${t.title}** (${t.id}) — ${t.status}${t.priority ? ` [${t.priority}]` : ""}`).join("\n");
}

export const RESOURCE_DEFINITIONS: ResourceDefinition[] = [
  {
    uri: "kora://team",
    name: "Team",
    description: "All agents in your session with roles, status, and skills",
    mimeType: "text/markdown",
    subscribable: true,
    fetchContent: async (ctx) => {
      const resp = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/agents`)) as { agents?: AgentInfo[] };
      return formatTeamMarkdown(resp.agents || [], ctx.agentId);
    },
    fetchData: async (ctx) => {
      const resp = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/agents`)) as { agents?: AgentInfo[] };
      return { agents: (resp.agents || []).map(a => ({ id: a.id, name: a.config?.name, role: a.config?.role, status: a.status, isMe: a.id === ctx.agentId })) };
    },
    cli: { command: "agents", description: "List agents" },
  },
  {
    uri: "kora://workflow",
    name: "Workflow",
    description: "Task pipeline states and valid transitions",
    mimeType: "text/markdown",
    subscribable: false,
    fetchContent: async (ctx) => {
      const resp = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/workflow-states`)) as { states?: Array<{ id: string; label: string; transitions?: string[] }> };
      return formatWorkflowMarkdown(resp.states || []);
    },
    fetchData: async (ctx) => {
      return await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/workflow-states`);
    },
    cli: { command: "workflow", description: "Show workflow states" },
  },
  {
    uri: "kora://knowledge",
    name: "Knowledge Base",
    description: "Project knowledge entries saved by agents and users",
    mimeType: "text/markdown",
    subscribable: true,
    fetchContent: async (ctx) => {
      const resp = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/knowledge`)) as { entries?: Array<{ key?: string; entry?: string; value?: string; author?: string }> };
      return formatKnowledgeMarkdown(resp.entries || []);
    },
    fetchData: async (ctx) => {
      return await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/knowledge`);
    },
    cli: { command: "knowledge search ''", description: "Search knowledge" },
  },
  {
    uri: "kora://rules",
    name: "Project Rules",
    description: "Rules and constraints from .kora.yml",
    mimeType: "text/markdown",
    subscribable: false,
    fetchContent: async (ctx) => {
      const resp = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}`)) as { config?: { rules?: string[] } };
      return formatRulesMarkdown(resp.config?.rules);
    },
    fetchData: async (ctx) => {
      const resp = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}`)) as { config?: { rules?: string[] } };
      return { rules: resp.config?.rules || [] };
    },
    cli: { command: "context rules", description: "Show project rules" },
  },
  {
    uri: "kora://tasks",
    name: "Active Tasks",
    description: "Your currently assigned tasks",
    mimeType: "text/markdown",
    subscribable: true,
    fetchContent: async (ctx) => {
      const resp = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/tasks?assignedTo=${ctx.agentId}&status=active`)) as { tasks?: TaskInfo[] };
      return formatTasksMarkdown(resp.tasks || []);
    },
    fetchData: async (ctx) => {
      return await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/tasks?assignedTo=${ctx.agentId}&status=active`);
    },
    cli: { command: "tasks", description: "List your tasks" },
  },
  {
    uri: "kora://persona",
    name: "Persona",
    description: "Your custom role definition, instructions, and project context",
    mimeType: "text/markdown",
    subscribable: false,
    fetchContent: async (ctx) => {
      const resp = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/agents/${ctx.agentId}/persona`)) as { persona?: string };
      return resp.persona || "No persona configured.";
    },
    fetchData: async (ctx) => {
      return await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/agents/${ctx.agentId}/persona`);
    },
    cli: { command: "whoami --full", description: "Show your persona" },
  },
  {
    uri: "kora://communication",
    name: "Communication Protocol",
    description: "How to communicate with teammates — tools, @mentions, file-based messaging",
    mimeType: "text/markdown",
    subscribable: false,
    fetchContent: async (ctx) => {
      const resp = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/agents/${ctx.agentId}/persona`)) as { persona?: string };
      const persona = resp.persona || "";
      const match = persona.match(/## Communication Protocol[\s\S]*?(?=\n## |$)/i);
      return match ? match[0].trim() : "Use send_message() or @mentions to communicate with teammates.";
    },
    fetchData: async (ctx) => {
      const resp = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/agents/${ctx.agentId}/persona`)) as { persona?: string };
      const persona = resp.persona || "";
      const match = persona.match(/## Communication Protocol[\s\S]*?(?=\n## |$)/i);
      return { protocol: match ? match[0].trim() : null };
    },
    cli: { command: "whoami --section communication", description: "Show communication protocol" },
  },
  {
    uri: "kora://workspace",
    name: "Workspace",
    description: "Workspace mode, working directory, and conflict prevention rules",
    mimeType: "text/markdown",
    subscribable: false,
    fetchContent: async (ctx) => {
      const session = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}`)) as { config?: { worktreeMode?: string; projectPath?: string } };
      const agent = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/agents/${ctx.agentId}`)) as { config?: { workingDirectory?: string; projectPath?: string } };
      const mode = session.config?.worktreeMode || "isolated";
      const lines = [`Workspace mode: **${mode}**`, `Project root: ${session.config?.projectPath || "unknown"}`, `Working directory: ${agent.config?.workingDirectory || "unknown"}`];
      if (mode === "shared") {
        lines.push("", "⚠️ **SHARED WORKSPACE** — All agents share the same directory.", "- Only edit files explicitly assigned to you", "- Check with teammates before modifying shared files", "- Use git branches to isolate your changes");
      }
      return lines.join("\n");
    },
    fetchData: async (ctx) => {
      const session = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}`)) as { config?: { worktreeMode?: string; projectPath?: string } };
      const agent = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/agents/${ctx.agentId}`)) as { config?: { workingDirectory?: string; projectPath?: string } };
      return { worktreeMode: session.config?.worktreeMode || "isolated", projectPath: session.config?.projectPath, workingDirectory: agent.config?.workingDirectory, isShared: session.config?.worktreeMode === "shared" };
    },
    cli: { command: "context workspace", description: "Show workspace info" },
  },
];

/** Get a resource definition by URI */
export function getResourceDefinition(uri: string): ResourceDefinition | undefined {
  return RESOURCE_DEFINITIONS.find(r => r.uri === uri);
}

/** Get all subscribable resources */
export function getSubscribableResources(): ResourceDefinition[] {
  return RESOURCE_DEFINITIONS.filter(r => r.subscribable);
}
