/**
 * Shared formatting utilities for the dashboard.
 * Consolidates duplicate implementations from SessionDetail, MultiAgentView, AgentView, and SettingsPage.
 */

/**
 * Format cost in USD with dollar sign and 2 decimal places.
 * @param cost - Cost value (may be undefined)
 * @returns Formatted string like "$1.23" or "$0.00"
 */
export function formatCost(cost: number | undefined): string {
  if (cost == null || cost === 0) return "$0.00";
  return "$" + cost.toFixed(2);
}

/**
 * Format token count with k/M suffixes for readability.
 * @param tokens - Token count (may be undefined)
 * @returns Formatted string like "1.2M", "45.3k", or "123"
 */
export function formatTokens(tokens: number | undefined): string {
  if (typeof tokens !== "number") return "--";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

/**
 * Format uptime from an ISO timestamp string.
 * Shows full breakdown: days, hours, minutes, seconds.
 * @param startedAt - ISO timestamp string (may be undefined)
 * @returns Formatted string like "2d 5h", "3h 45m", "12m 30s", or "45s"
 */
export function formatUptime(startedAt: string | undefined): string {
  if (!startedAt) return "--";
  const diff = Date.now() - new Date(startedAt).getTime();
  if (diff < 0 || isNaN(diff)) return "--";

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Format uptime from a duration in seconds.
 * @param seconds - Duration in seconds
 * @returns Formatted string like "5h 32m 18s"
 */
export function formatUptimeSeconds(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

/**
 * Format a "last seen" relative timestamp from an ISO date string.
 * Shows how long ago the last terminal output change was detected.
 * @param timestamp - ISO timestamp string (may be undefined)
 * @returns Formatted string like "just now", "2m ago", "1h ago", or "--"
 */
export function formatLastSeen(timestamp: string | undefined): string {
  if (!timestamp) return "--";
  const diff = Date.now() - new Date(timestamp).getTime();
  if (diff < 0 || isNaN(diff)) return "--";

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 30) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}
