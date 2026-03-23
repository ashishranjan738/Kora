/**
 * ToolContext — transport-agnostic context passed to every tool handler.
 * Instantiated per-agent (MCP process or CLI session).
 */

export interface ToolContext {
  /** Agent ID of the caller */
  agentId: string;
  /** Session ID the agent belongs to */
  sessionId: string;
  /** Agent role: "master" or "worker" */
  agentRole: string;
  /** Project path (may be empty if not set) */
  projectPath: string;
  /** Make an HTTP call to the daemon API. Handles auth, retries, etc. */
  apiCall: (method: string, urlPath: string, body?: unknown) => Promise<unknown>;
}

/** Agent info as returned by the agents API */
export interface AgentInfo {
  id: string;
  config?: {
    name?: string;
    role?: string;
    cliProvider?: string;
    model?: string;
  };
  status?: string;
}

export interface AgentsResponse {
  agents?: AgentInfo[];
}

/**
 * Find an agent by name or ID with prioritized matching.
 *
 * Priority order:
 * 1. Exact name match (case-insensitive)
 * 2. Exact ID match (case-insensitive)
 * 3. Substring match (fallback)
 */
export function findAgentByNameOrId(
  agents: AgentInfo[],
  search: string,
): AgentInfo | undefined {
  if (!search || search.trim() === "") return undefined;

  const searchLower = search.toLowerCase();

  // Priority 1: Exact name match
  let target = agents.find(a =>
    (a.config?.name || "").toLowerCase() === searchLower,
  );
  if (target) return target;

  // Priority 2: Exact ID match
  target = agents.find(a => a.id.toLowerCase() === searchLower);
  if (target) return target;

  // Priority 3: Substring match (fallback)
  target = agents.find(a => {
    const name = (a.config?.name || "").toLowerCase();
    return name.includes(searchLower) || a.id.toLowerCase().includes(searchLower);
  });

  return target;
}
