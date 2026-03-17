// ============================================================
// Core domain types for Kora
// ============================================================

// --- Session ---

/** How agents communicate within a session */
export type MessagingMode = "mcp" | "terminal" | "manual";

export interface SessionConfig {
  id: string;
  name: string;
  projectPath: string;
  defaultProvider: string;
  defaultModel?: string;
  agents: AgentConfig[];
  createdAt: string; // ISO 8601
  status: SessionStatus;
  /** Custom models added by the user, keyed by provider ID */
  customModels?: Record<string, CustomModel[]>;
  /** How agents communicate. Default: "mcp" for claude-code, "terminal" for others */
  messagingMode?: MessagingMode;
}

export interface CustomModel {
  id: string;         // Model ID passed to the CLI (e.g. "ft:gpt-4o:my-org:custom-model:abc123")
  label: string;      // Display name (e.g. "My Fine-tuned GPT-4o")
  provider: string;   // Which provider this model is for
}

export type SessionStatus = "active" | "paused" | "stopped";

export interface SessionState {
  config: SessionConfig;
  agents: Record<string, AgentState>;
  runtimeDir: string;
}

// --- Agent ---

export interface AgentConfig {
  id: string;
  sessionId: string;
  name: string;
  role: AgentRole;
  cliProvider: string;
  persona: string;
  model: string;
  workingDirectory: string;
  allowedTools?: string[];
  extraCliArgs?: string[];
  envVars?: Record<string, string>;
  tmuxSession: string;
  spawnedBy: string;
  permissions: AgentPermissions;
  autonomyLevel: AutonomyLevel;
  restartPolicy: RestartPolicy;
  maxRestarts: number;
  budgetLimit?: number; // Max cost in dollars, undefined = no limit
}

export type AgentRole = "master" | "worker";
export type RestartPolicy = "never" | "on-crash" | "always";

export enum AutonomyLevel {
  SuggestOnly = 0,     // Agent proposes, user must approve each action
  AutoRead = 1,        // Can explore codebase, asks before editing
  AutoApply = 2,       // Edits files freely, asks before git operations
  FullAuto = 3,        // Does everything including git operations
}

export interface AgentPermissions {
  canSpawnAgents: boolean;
  canRemoveAgents: boolean;
  canModifyFiles: boolean;
  maxSubAgents: number;
}

export interface AgentHealthCheck {
  lastPingAt: string; // ISO 8601
  consecutiveFailures: number;
  restartCount: number;
}

export interface AgentState {
  id: string;
  sessionId: string;
  config: AgentConfig;
  status: AgentStatus;
  currentTask?: string;
  output: string[];
  startedAt?: string;
  lastActivityAt?: string;
  childAgents: string[];
  healthCheck: AgentHealthCheck;
  cost: AgentCost;
}

export type AgentStatus =
  | "idle"
  | "running"
  | "waiting"
  | "error"
  | "crashed"
  | "stopped";

export interface AgentCost {
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  lastUpdatedAt: string;
}

// --- Messages ---

export interface AgentMessage {
  id: string;
  from: string;   // "{sessionId}:{agentId}" or "user"
  to: string;     // "{sessionId}:{agentId}" or "all"
  type: MessageType;
  content: string;
  timestamp: string;
  metadata?: MessageMetadata;
}

export type MessageType =
  | "task"
  | "status"
  | "question"
  | "response"
  | "result"
  | "summary"
  | "user-message";

export interface MessageMetadata {
  taskId?: string;
  priority?: "low" | "normal" | "high";
  sessionId?: string;
}

// --- Control Plane ---

export type ControlCommand =
  | SpawnAgentCommand
  | RemoveAgentCommand
  | ListAgentsCommand
  | GetAgentStatusCommand;

export interface SpawnAgentCommand {
  action: "spawn-agent";
  id: string; // unique command ID for idempotency
  name: string;
  role: "worker";
  persona: string;
  cliProvider?: string;
  model: string;
  task?: string;
}

export interface RemoveAgentCommand {
  action: "remove-agent";
  id: string;
  targetAgentId: string;
  reason: string;
}

export interface ListAgentsCommand {
  action: "list-agents";
  id: string;
}

export interface GetAgentStatusCommand {
  action: "get-agent-status";
  id: string;
  targetAgentId: string;
}

export interface ControlResponse {
  commandId: string;
  status: "ok" | "error";
  data?: unknown;
  error?: string;
}

// --- Tasks ---

export interface Task {
  id: string;
  sessionId: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignedTo?: string;
  createdBy: string;
  dependencies?: string[];
  subtasks?: string[];
  result?: string;
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus =
  | "pending"
  | "assigned"
  | "in-progress"
  | "review"
  | "done"
  | "failed";

// --- Events ---

export interface OrchestratorEvent {
  id: string;
  sessionId: string;
  type: EventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export type EventType =
  | "agent-spawned"
  | "agent-removed"
  | "agent-status-changed"
  | "agent-crashed"
  | "agent-restarted"
  | "message-sent"
  | "message-received"
  | "task-created"
  | "task-updated"
  | "user-interaction"
  | "session-created"
  | "session-paused"
  | "session-resumed"
  | "session-stopped"
  | "cost-threshold-reached";
