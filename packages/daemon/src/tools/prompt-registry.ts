/**
 * Prompt Registry — MCP prompts for persona and protocol delivery.
 * Each prompt returns structured text content via the daemon API.
 */

import type { ToolContext } from "./tool-context.js";

export interface PromptDefinition {
  name: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
  /** Fetch prompt content via daemon API */
  fetchContent: (ctx: ToolContext) => Promise<string>;
  /** CLI equivalent command */
  cli?: { command: string; description: string };
}

/**
 * Extract a named section from persona text (## Header ... next ## Header).
 */
function extractSection(persona: string, sectionName: string): string {
  const regex = new RegExp(`## ${sectionName}[\\s\\S]*?(?=\\n## |$)`, "i");
  const match = persona.match(regex);
  return match ? match[0].trim() : "";
}

export const PROMPT_DEFINITIONS: PromptDefinition[] = [
  {
    name: "persona",
    description: "Your complete role definition, instructions, and rules for this session",
    arguments: [
      { name: "section", description: "Extract a specific section (e.g. 'Identity', 'Goal', 'Constraints')", required: false },
    ],
    fetchContent: async (ctx) => {
      const resp = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/agents/${ctx.agentId}/persona`)) as { persona?: string };
      return resp.persona || "";
    },
    cli: { command: "whoami --full", description: "Show your persona and session context" },
  },
  {
    name: "communication",
    description: "How to communicate with teammates — MCP tools, @mentions, file-based messaging",
    fetchContent: async (ctx) => {
      const resp = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/agents/${ctx.agentId}/persona`)) as { persona?: string };
      return extractSection(resp.persona || "", "Communication Protocol");
    },
    cli: { command: "whoami --section communication", description: "Show communication instructions" },
  },
  {
    name: "worker-protocol",
    description: "Worker agent protocol — task handling, progress reporting, stop compliance",
    fetchContent: async (ctx) => {
      const resp = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/agents/${ctx.agentId}/persona`)) as { persona?: string };
      return extractSection(resp.persona || "", "Worker Protocol");
    },
    cli: { command: "whoami --section worker-protocol", description: "Show worker protocol" },
  },
  {
    name: "master-protocol",
    description: "Master/orchestrator protocol — delegation, planning, oversight",
    fetchContent: async (ctx) => {
      const resp = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/agents/${ctx.agentId}/persona`)) as { persona?: string };
      return extractSection(resp.persona || "", "Master Protocol");
    },
    cli: { command: "whoami --section master-protocol", description: "Show master protocol" },
  },
];

/** Get a prompt definition by name */
export function getPromptDefinition(name: string): PromptDefinition | undefined {
  return PROMPT_DEFINITIONS.find(p => p.name === name);
}

/** Get prompts filtered by role (master-protocol only for masters) */
export function getPromptsForRole(role: string): PromptDefinition[] {
  if (role === "master") return PROMPT_DEFINITIONS;
  return PROMPT_DEFINITIONS.filter(p => p.name !== "master-protocol");
}
