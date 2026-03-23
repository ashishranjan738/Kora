/**
 * Unified Watchdog Delivery Manager — handles immediate, idle-only, and custom
 * delivery modes for all watchdog notifications (stale task, context refresh, etc.)
 *
 * When mode is "idle-only", notifications are queued and batched into a single
 * message when the agent transitions to idle.
 */

import { randomUUID } from "crypto";
import type { MessageBus } from "./message-bus.js";

export type DeliveryMode = "immediate" | "idle-only" | "custom";

export interface WatchdogOverride {
  mode: DeliveryMode;
  perEvent?: Record<string, DeliveryMode>;
}

export interface WatchdogDeliveryConfig {
  mode: DeliveryMode;
  overrides?: Record<string, WatchdogOverride>;
}

interface QueuedNotification {
  watchdog: string;
  eventType: string;
  message: string;
  timestamp: string;
}

/** Sensible default config — stale tasks immediate, context refresh idle-only */
export const DEFAULT_WATCHDOG_DELIVERY_CONFIG: WatchdogDeliveryConfig = {
  mode: "custom",
  overrides: {
    staleTask: { mode: "immediate" },
    contextRefresh: {
      mode: "idle-only",
      perEvent: {
        taskAssignment: "immediate",
        personaUpdate: "immediate",
        instructionsUpdate: "immediate",
        teamChange: "idle-only",
        knowledgeUpdate: "idle-only",
      },
    },
  },
};

export class WatchdogDeliveryManager {
  private config: WatchdogDeliveryConfig;
  private pendingQueue = new Map<string, QueuedNotification[]>();
  private agentActivity = new Map<string, "idle" | "working">();

  constructor(
    private messageBus: MessageBus,
    private messagingMode: string = "mcp",
    config?: WatchdogDeliveryConfig,
  ) {
    this.config = config || { ...DEFAULT_WATCHDOG_DELIVERY_CONFIG };
  }

  /** Update config at runtime (e.g. from dashboard settings) */
  updateConfig(config: WatchdogDeliveryConfig): void {
    this.config = config;
  }

  /** Get current config */
  getConfig(): WatchdogDeliveryConfig {
    return this.config;
  }

  /** Determine effective delivery mode for a specific watchdog + event */
  getMode(watchdogName: string, eventType?: string): DeliveryMode {
    if (this.config.mode !== "custom") return this.config.mode;

    const override = this.config.overrides?.[watchdogName];
    if (!override) return "immediate"; // default for unknown watchdogs

    if (eventType && override.perEvent?.[eventType]) {
      return override.perEvent[eventType];
    }
    return override.mode;
  }

  /**
   * Deliver a watchdog notification — immediately or queued based on mode.
   */
  async deliver(
    agentId: string,
    watchdogName: string,
    eventType: string,
    message: string,
  ): Promise<void> {
    const mode = this.getMode(watchdogName, eventType);
    const activity = this.agentActivity.get(agentId) || "working";

    if (mode === "immediate" || activity === "idle") {
      // Deliver immediately
      await this.deliverToAgent(agentId, message);
    } else {
      // Queue for delivery when agent goes idle
      const queue = this.pendingQueue.get(agentId) || [];
      queue.push({ watchdog: watchdogName, eventType, message, timestamp: new Date().toISOString() });
      this.pendingQueue.set(agentId, queue);
    }
  }

  /** Called when agent transitions to idle — flush queued notifications */
  async onAgentIdle(agentId: string): Promise<void> {
    this.agentActivity.set(agentId, "idle");

    const queue = this.pendingQueue.get(agentId);
    if (!queue || queue.length === 0) return;

    // Batch all queued notifications into one message
    const batched = this.batchNotifications(queue);
    await this.deliverToAgent(agentId, batched);

    this.pendingQueue.delete(agentId);
  }

  /** Called when agent starts working — hold new notifications */
  onAgentBusy(agentId: string): void {
    this.agentActivity.set(agentId, "working");
  }

  /** Remove agent from tracking */
  removeAgent(agentId: string): void {
    this.pendingQueue.delete(agentId);
    this.agentActivity.delete(agentId);
  }

  /** Get pending notification count for an agent */
  getPendingCount(agentId: string): number {
    return this.pendingQueue.get(agentId)?.length || 0;
  }

  /** Batch multiple notifications into a single readable message */
  private batchNotifications(queue: QueuedNotification[]): string {
    if (queue.length === 1) return queue[0].message;

    const refreshCmd = this.messagingMode === "cli"
      ? "Run `kora-cli context all` to refresh everything at once."
      : 'Call get_context("all") to refresh everything at once.';

    const bullets = queue.map(n => `  • ${n.message.replace(/\x1b\[[0-9;]*m/g, "").trim()}`);
    return `\x1b[1;33m[System]\x1b[0m While you were working, ${queue.length} updates occurred:\n${bullets.join("\n")}\n${refreshCmd}`;
  }

  /** Deliver a message to agent via message bus */
  private async deliverToAgent(agentId: string, content: string): Promise<void> {
    try {
      await this.messageBus.deliverToInbox(agentId, {
        id: randomUUID(),
        from: "system",
        to: agentId,
        type: "status",
        content,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Non-fatal — agent may be dead
    }
  }
}
