/**
 * Dashboard-specific API response types.
 *
 * These extend the shared @kora/shared types with extra fields
 * that the REST API adds on top of the core domain types.
 */

import type {
  AgentConfig,
  AgentStatus,
  AgentActivity,
  AgentCost,
  AgentHealthCheck,
  SessionConfig,
  SessionStatus,
  Task as SharedTask,
  TaskPriority,
  OrchestratorEvent,
  WorkflowState,
} from "@kora/shared";

// Re-export shared types that are used as-is
export type { WorkflowState, OrchestratorEvent, SessionConfig, TaskPriority };

// ---- Agent ----

/** Agent as returned by GET /sessions/:id/agents */
export interface AgentResponse {
  id: string;
  sessionId: string;
  config: AgentConfig;
  status: AgentStatus;
  activity: AgentActivity;
  /** Flattened from config for convenience */
  name: string;
  role: string;
  provider: string;
  model: string;
  /** Cost tracking */
  cost: AgentCost;
  /** Alternative token usage shape (from usage-monitor polling) */
  tokenUsage?: {
    input?: number;
    output?: number;
    cost?: number;
  };
  /** Legacy token fields */
  tokensIn?: number;
  tokensOut?: number;
  tokens_in?: number;
  tokens_out?: number;
  /** Activity details */
  subActivity?: string;
  currentTask?: string | { id: string; title: string };
  idleSince?: string;
  availableForWork?: boolean;
  /** Terminal timing */
  lastOutputAt?: string;
  lastActivityAt?: string;
  startedAt?: string;
  /** Messaging */
  unreadMessages?: number;
  /** Capacity for workload calculation */
  capacity?: number;
  /** Health */
  healthCheck?: AgentHealthCheck;
  childAgents?: string[];
}

// ---- Session ----

/** Session as returned by GET /sessions/:id */
export interface SessionResponse extends Omit<SessionConfig, "worktreeMode"> {
  agentCount: number;
  activeAgentCount: number;
  crashedAgentCount: number;
  stoppedAgentCount: number;
  totalCostUsd: number;
  cost?: number;
  providers?: string[];
  /** API may return worktreeMode as a plain string */
  worktreeMode?: string;
  agentSummaries?: AgentSummary[];
  /** Budget limit (from session config, flattened by some API paths) */
  budgetLimit?: number;
  /** Some API paths nest config — fallback access pattern */
  config?: Partial<SessionConfig>;
  /** Feature flags for optional capabilities */
  features?: { groupChat?: boolean };
}

export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  status: string;
  provider: string;
  model: string;
}

// ---- Task ----

/** Task with comments as returned by GET /sessions/:id/tasks */
export interface TaskResponse extends SharedTask {
  comments?: TaskComment[];
  blocked?: boolean;
  blockedReason?: string;
}

export interface TaskComment {
  id: string;
  text: string;
  author: string;
  authorName?: string;
  createdAt: string;
}

// ---- Session list (home page) ----

/** Session summary for the home page list */
export interface SessionListItem {
  id: string;
  name: string;
  projectPath?: string;
  status: SessionStatus;
  agentCount?: number;
  activeAgentCount?: number;
  crashedAgentCount?: number;
  stoppedAgentCount?: number;
  cost?: number;
  providers?: string[];
  worktreeMode?: string;
  agentSummaries?: AgentSummary[];
}
