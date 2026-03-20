// ============================================================
// API request/response types and WebSocket event types
// ============================================================

import type {
  SessionConfig,
  SessionStatus,
  AgentConfig,
  AgentState,
  AgentMessage,
  Task,
  OrchestratorEvent,
  AutonomyLevel,
  MessagingMode,
  WorktreeMode,
} from "./types.js";
import type { ModelOption } from "./providers.js";

// --- Daemon Status ---

export interface DaemonStatusResponse {
  alive: boolean;
  version: string;
  apiVersion: string;
  uptime: number;           // seconds
  activeSessions: number;
  activeAgents: number;
}

// --- Session API ---

export interface CreateSessionRequest {
  name: string;
  projectPath: string;
  defaultProvider?: string; // defaults to "claude-code"
  autoCreateMaster?: boolean;
  masterModel?: string;
  messagingMode?: MessagingMode; // defaults to "mcp"
  worktreeMode?: WorktreeMode;   // defaults to "isolated"
  workflowStates?: import("./types.js").WorkflowState[]; // Custom pipeline states (frozen at creation)
}

export interface UpdateSessionRequest {
  name?: string;
  defaultProvider?: string;
}

export interface SessionResponse extends SessionConfig {
  agentCount: number;
  activeAgentCount: number;
  crashedAgentCount: number;
  stoppedAgentCount: number;
  totalCostUsd: number;
  /** Summary of each agent's health for the session card */
  agentSummaries: AgentSummary[];
}

export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  status: string;
  provider: string;
  model: string;
}

// --- Agent API ---

export interface SpawnAgentRequest {
  name: string;
  role: "master" | "worker";
  cliProvider?: string;     // inherits session default
  model: string;
  persona?: string;
  autonomyLevel?: AutonomyLevel;
  workingDirectory?: string; // defaults to session projectPath
  extraCliArgs?: string[];
  skipArgValidation?: boolean; // bypass CLI arg allowlist validation
  envVars?: Record<string, string>;
  initialTask?: string;     // first message sent to agent after spawn
}

export interface SendMessageRequest {
  message: string;
}

export interface ChangeModelRequest {
  model: string;
}

export interface ChangeProviderRequest {
  provider: string;
  model: string;
}

// --- Task API ---

export interface CreateTaskRequest {
  title: string;
  description: string;
  assignedTo?: string;
  dependencies?: string[];
  priority?: string;  // P0, P1, P2 (default), P3
  labels?: string[];  // e.g. ["bug", "frontend"]
  dueDate?: string;   // YYYY-MM-DD format
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  status?: string;
  assignedTo?: string;
  priority?: string;  // P0, P1, P2, P3
  labels?: string[];  // e.g. ["bug", "frontend"]
  dueDate?: string | null;  // YYYY-MM-DD format, null to clear
  result?: string;
}

// --- Events API ---

export interface EventsQueryParams {
  since?: string;   // ISO 8601 timestamp
  limit?: number;   // default 100, max 1000
  type?: string;    // filter by event type
}

// --- Provider API ---

export interface ProviderResponse {
  id: string;
  displayName: string;
  models: ModelOption[];
  supportsHotModelSwap: boolean;
}

// --- WebSocket Events ---

export interface ApprovalRequest {
  id: string;
  agentId: string;
  action: string;
  description: string;
  timestamp: number;
  status: "pending" | "approved" | "rejected";
}

export type WSEvent =
  | { event: "agent-update"; sessionId: string; agent: AgentState }
  | { event: "agent-spawned"; sessionId: string; agent: AgentState }
  | { event: "agent-removed"; sessionId: string; agentId: string; reason: string }
  | { event: "agent-health"; sessionId: string; agentId: string; status: string }
  | { event: "message"; sessionId: string; message: AgentMessage }
  | { event: "task-update"; sessionId: string; task: Task }
  | { event: "session-update"; session: SessionConfig }
  | { event: "terminal-data"; sessionId: string; agentId: string; data: string }
  | { event: "cost-update"; sessionId: string; agentId: string; costUsd: number }
  | { event: "notification"; sessionId: string; notification: { id: string; type: string; title: string; body: string; agentId?: string; timestamp: number } }
  | { event: "approval-request"; sessionId: string; request: ApprovalRequest }
  | { event: "error"; message: string };
