/**
 * ContextRefreshWatchdog — reminds agents to refresh stale context.
 *
 * Two notification types:
 * 1. Change-triggered: batched notifications when team/task/knowledge changes
 * 2. Heartbeat: periodic reminders if agent hasn't refreshed recently
 *
 * Delivery via agentManager.sendMessage() (low priority terminal notification).
 */

import { EventEmitter } from "events";
import { logger } from "./logger.js";
import type { AgentManager } from "./agent-manager.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ContextRefreshConfig {
  enabled: boolean;
  /** How often to check for stale context (default: 30 min) */
  heartbeatIntervalMs: number;
  /** Batch window for change notifications (default: 30s) */
  changeNotifyDelayMs: number;
  /** Which change types trigger notifications */
  notifyOn: ChangeType[];
}

export type ChangeType = "teamChange" | "taskAssignment" | "knowledgeUpdate";

export const DEFAULT_CONFIG: ContextRefreshConfig = {
  enabled: true,
  heartbeatIntervalMs: 30 * 60 * 1000, // 30 minutes
  changeNotifyDelayMs: 30 * 1000,       // 30 seconds batch window
  notifyOn: ["teamChange", "taskAssignment", "knowledgeUpdate"],
};

// ---------------------------------------------------------------------------
// Change descriptions for human-readable notifications
// ---------------------------------------------------------------------------

interface PendingChange {
  type: ChangeType;
  detail: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

export class ContextRefreshWatchdog extends EventEmitter {
  private config: ContextRefreshConfig;
  private agentManager: AgentManager;
  private sessionId: string;
  private messagingMode: string;

  /** Last time each agent called get_context */
  private lastRefreshTime = new Map<string, number>();
  /** Pending batched changes per agent (agentId → changes[]) */
  private pendingChanges = new Map<string, PendingChange[]>();
  /** Timers for batched change delivery */
  private batchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Heartbeat interval handle */
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(opts: {
    agentManager: AgentManager;
    sessionId: string;
    messagingMode?: string;
    config?: Partial<ContextRefreshConfig>;
  }) {
    super();
    this.agentManager = opts.agentManager;
    this.sessionId = opts.sessionId;
    this.messagingMode = opts.messagingMode || "mcp";
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  start(): void {
    if (!this.config.enabled) return;

    // Heartbeat check every minute
    this.heartbeatInterval = setInterval(() => this.checkHeartbeats(), 60_000);
    logger.info({ sessionId: this.sessionId }, "Context refresh watchdog started");
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    // Clear all batch timers
    for (const timer of this.batchTimers.values()) {
      clearTimeout(timer);
    }
    this.batchTimers.clear();
    this.pendingChanges.clear();
  }

  // ── Record refresh (called when agent uses get_context) ────────────────

  recordRefresh(agentId: string): void {
    this.lastRefreshTime.set(agentId, Date.now());
  }

  // ── Change notification (called by orchestrator/api-routes) ────────────

  /**
   * Notify that a session change occurred. Affected agents will get a
   * batched notification after the configured delay.
   *
   * @param changeType - Type of change
   * @param detail - Human-readable description (e.g. '"Dev 4" joined')
   * @param affectedAgentIds - Specific agents to notify (empty = all agents)
   */
  notifyChange(changeType: ChangeType, detail: string, affectedAgentIds?: string[]): void {
    if (!this.config.enabled) return;
    if (!this.config.notifyOn.includes(changeType)) return;

    const agents = affectedAgentIds?.length
      ? affectedAgentIds
      : this.agentManager.listAgents()
          .filter(a => a.status === "running")
          .map(a => a.id);

    const change: PendingChange = { type: changeType, detail, timestamp: Date.now() };

    for (const agentId of agents) {
      // Add to pending batch
      if (!this.pendingChanges.has(agentId)) {
        this.pendingChanges.set(agentId, []);
      }
      this.pendingChanges.get(agentId)!.push(change);

      // Start/restart batch timer
      if (this.batchTimers.has(agentId)) {
        clearTimeout(this.batchTimers.get(agentId)!);
      }
      this.batchTimers.set(agentId, setTimeout(() => {
        this.deliverBatchedChanges(agentId);
      }, this.config.changeNotifyDelayMs));
    }
  }

  // ── Heartbeat check ────────────────────────────────────────────────────

  private checkHeartbeats(): void {
    if (!this.config.enabled) return;

    const now = Date.now();
    const agents = this.agentManager.listAgents().filter(a => a.status === "running");

    for (const agent of agents) {
      const lastRefresh = this.lastRefreshTime.get(agent.id) || 0;
      const elapsed = now - lastRefresh;

      // Skip if refreshed recently (within heartbeat interval)
      if (lastRefresh > 0 && elapsed < this.config.heartbeatIntervalMs) {
        continue;
      }

      // Skip if never refreshed and agent started less than heartbeat interval ago
      if (lastRefresh === 0 && elapsed < this.config.heartbeatIntervalMs) {
        continue;
      }

      const minutesAgo = Math.round(elapsed / 60_000);
      const refreshCmd = this.messagingMode === "mcp" || this.messagingMode === "cli"
        ? 'get_context("all")'
        : 'kora-cli context all';

      const message = lastRefresh > 0
        ? `[Kora] Context refresh reminder — last updated ${minutesAgo}m ago. Run ${refreshCmd} to ensure you have the latest team, tasks, and knowledge.`
        : `[Kora] Context refresh reminder — you haven't loaded context yet. Run ${refreshCmd} to get your team, tasks, and knowledge.`;

      this.sendNotification(agent.id, message);
      this.emit("heartbeat-reminder", { agentId: agent.id, minutesAgo });
    }
  }

  // ── Delivery ───────────────────────────────────────────────────────────

  private deliverBatchedChanges(agentId: string): void {
    const changes = this.pendingChanges.get(agentId);
    if (!changes?.length) return;

    // Build summary
    const bullets = changes.map(c => {
      switch (c.type) {
        case "teamChange": return `Team changed: ${c.detail}`;
        case "taskAssignment": return `Task update: ${c.detail}`;
        case "knowledgeUpdate": return `New knowledge: ${c.detail}`;
        default: return c.detail;
      }
    });

    const refreshCmd = this.messagingMode === "mcp" || this.messagingMode === "cli"
      ? 'get_context("all")'
      : 'kora-cli context all';

    const message = [
      `[Kora] Context update available:`,
      ...bullets.map(b => `  • ${b}`),
      `Call ${refreshCmd} to refresh.`,
    ].join("\n");

    this.sendNotification(agentId, message);
    this.emit("change-notification", { agentId, changes: bullets });

    // Cleanup
    this.pendingChanges.delete(agentId);
    this.batchTimers.delete(agentId);
  }

  private sendNotification(agentId: string, message: string): void {
    try {
      // Use low-priority ANSI-colored notification
      this.agentManager.sendMessage(agentId, `\x1b[2;36m${message}\x1b[0m`);
    } catch (err) {
      logger.warn({ agentId, err }, "Failed to send context refresh notification");
    }
  }
}
