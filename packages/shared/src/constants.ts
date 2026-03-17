// ============================================================
// Shared constants
// ============================================================

export const DEFAULT_PORT = 7890;
export const API_VERSION = "v1";
export const APP_VERSION = "0.1.0";

export const DAEMON_DIR = ".kora";
export const GLOBAL_CONFIG_DIR = "~/.kora";
export const PID_FILE = "daemon.pid";
export const PORT_FILE = "daemon.port";
export const TOKEN_FILE = "daemon.token";
export const SESSIONS_FILE = "sessions.json";
export const CONFIG_FILE = "config.json";

// Per-project runtime directories
export const MESSAGES_DIR = "messages";
export const CONTROL_DIR = "control";
export const TASKS_DIR = "tasks";
export const STATE_DIR = "state";
export const EVENTS_DIR = "events";
export const ARCHIVE_DIR = "archive";
export const PERSONAS_DIR = "personas";
export const KNOWLEDGE_DIR = "knowledge";
export const PROCESSED_DIR = "processed";
export const MCP_PENDING_DIR = "mcp-pending";

// Agent health check
export const HEALTH_CHECK_INTERVAL_MS = 5_000;
export const MAX_CONSECUTIVE_FAILURES = 3;
export const DEFAULT_MAX_RESTARTS = 3;
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

// Terminal streaming
export const TERMINAL_RING_BUFFER_LINES = 1000;
export const MAX_TERMINAL_CONNECTIONS_PER_AGENT = 3;

// Cost tracking
export const COST_UPDATE_INTERVAL_MS = 5_000;

// Default permissions
export const DEFAULT_MASTER_PERMISSIONS = {
  canSpawnAgents: true,
  canRemoveAgents: true,
  canModifyFiles: true,
  maxSubAgents: 10,
} as const;

export const DEFAULT_WORKER_PERMISSIONS = {
  canSpawnAgents: false,
  canRemoveAgents: false,
  canModifyFiles: true,
  maxSubAgents: 0,
} as const;
