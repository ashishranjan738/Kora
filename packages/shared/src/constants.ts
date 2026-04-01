// ============================================================
// Shared constants
// ============================================================

export const DEFAULT_PORT = 7890;
export const API_VERSION = "v1";
export const APP_VERSION = "0.1.0";

/** Terminal backend type — node-pty is the only supported backend */
export type PtyBackendType = "node-pty";
export const DEFAULT_PTY_BACKEND: PtyBackendType = "node-pty";

export const DAEMON_DIR = ".kora";
export const GLOBAL_CONFIG_DIR = "~/.kora";
export const PID_FILE = "daemon.pid";
export const PORT_FILE = "daemon.port";
export const TOKEN_FILE = "daemon.token";
export const SESSIONS_FILE = "sessions.json";
export const CONFIG_FILE = "config.json";

// Session-scoped runtime: each session gets its own subdirectory under .kora/sessions/{id}/
export const SESSIONS_SUBDIR = "sessions";

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
export const HEALTH_CHECK_INTERVAL_MS = 10_000;
export const MAX_CONSECUTIVE_FAILURES = 3;
export const DEFAULT_MAX_RESTARTS = 3;
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;
export const SPAWN_TIMEOUT_MS = 30_000;
export const MAX_AGENTS_PER_SESSION = 20;

// Session namespace — all Kora-managed terminal sessions use this prefix
export const SESSION_PREFIX = "kora--";
export const SESSION_PREFIX_DEV = "kora-dev--";
/** @deprecated Use SESSION_PREFIX */
export const TMUX_SESSION_PREFIX = SESSION_PREFIX;
/** @deprecated Use SESSION_PREFIX_DEV */
export const TMUX_SESSION_PREFIX_DEV = SESSION_PREFIX_DEV;

// Per-project runtime directory (dev mode)
export const DAEMON_DIR_DEV = ".kora-dev";

// MCP server name in agent MCP configs (always "kora" — isolation comes from port/token/config dir)
export const MCP_SERVER_NAME = "kora";

// Helper functions for runtime use
export function getRuntimeDaemonDir(isDev: boolean): string {
  return isDev ? DAEMON_DIR_DEV : DAEMON_DIR;
}

export function getSessionPrefix(isDev: boolean): string {
  return isDev ? SESSION_PREFIX_DEV : SESSION_PREFIX;
}
/** @deprecated Use getSessionPrefix */
export const getRuntimeTmuxPrefix = getSessionPrefix;

// Terminal streaming
export const TERMINAL_RING_BUFFER_LINES = 100_000;
export const MAX_TERMINAL_CONNECTIONS_PER_AGENT = 3;

// Message delivery
export const FORCE_DELIVERY_TIMEOUT_MS = 30_000;

// Cost tracking
export const COST_UPDATE_INTERVAL_MS = 15_000;

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
