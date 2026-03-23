/**
 * ToolContext — transport-agnostic context passed to every tool handler.
 */
export interface RateLimiter { isLimited(): boolean; record(): void; }
export interface NudgeLimiter { isLimited(targetId: string): boolean; record(targetId: string): void; }
export interface ToolContext {
  agentId: string; sessionId: string; agentRole: string; projectPath: string;
  apiCall: (method: string, urlPath: string, body?: unknown) => Promise<unknown>;
  sendRateLimiter?: RateLimiter; nudgeRateLimiter?: NudgeLimiter;
}
export type ToolArgs = Record<string, unknown>;
export interface AgentInfo {
  id: string;
  config?: { name?: string; role?: string; cliProvider?: string; model?: string; skills?: string[]; channels?: string[]; spawnedBy?: string; permissions?: { maxSubAgents?: number }; };
  status?: string; activity?: string; idleSince?: string; lastActivityAt?: string; unreadMessages?: number;
}
export interface AgentsResponse { agents?: AgentInfo[]; }
export interface TaskInfo { id: string; title: string; status: string; priority?: string; assignedTo?: string; dependencies?: string[]; blocked?: boolean; blockedReason?: string; labels?: string[]; [key: string]: unknown; }
export interface TasksResponse { tasks?: TaskInfo[]; }
export function findAgentByNameOrId(agents: AgentInfo[], search: string): AgentInfo | undefined {
  if (!search || search.trim() === "") return undefined;
  const s = search.toLowerCase();
  let t = agents.find(a => (a.config?.name || "").toLowerCase() === s); if (t) return t;
  t = agents.find(a => a.id.toLowerCase() === s); if (t) return t;
  return agents.find(a => { const n = (a.config?.name || "").toLowerCase(); return n.includes(s) || a.id.toLowerCase().includes(s); });
}
