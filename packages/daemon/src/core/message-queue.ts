import type { IPtyBackend } from "./pty-backend.js";
import type { MessagingMode } from "@kora/shared";
import { FORCE_DELIVERY_TIMEOUT_MS } from "@kora/shared";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { logger } from "./logger.js";

// ─── Priority system ──────────────────────────────────────────

export type MessagePriority = "critical" | "high" | "normal" | "low";

const PRIORITY_ORDER: Record<MessagePriority, number> = {
  critical: 0, high: 1, normal: 2, low: 3,
};

/** TTL in milliseconds by priority */
const PRIORITY_TTL: Record<MessagePriority, number> = {
  critical: 10 * 60 * 1000,  // 10 min
  high: 5 * 60 * 1000,       // 5 min
  normal: 3 * 60 * 1000,     // 3 min
  low: 1 * 60 * 1000,        // 1 min
};

/** Rate limits by role (messages per 60s) */
const ROLE_RATE_LIMITS: Record<string, number> = {
  master: 25,
  worker: 10,
};

const MAX_QUEUE_SIZE = 50;

interface QueuedMessage {
  agentId: string;
  terminalSession: string;
  message: string;
  timestamp: number;
  priority: MessagePriority;
  ttl: number;  // absolute expiry timestamp (ms)
  fromAgentId?: string;
  targetAgentId?: string;  // Tier 3: If set, only deliver to this agent (targeted message). If undefined, broadcast to all.
  sqlitePersisted?: boolean; // If true, message was already written to SQLite by relayMessage() — skip duplicate write in deliverViaMcpPending
}

/** Auto-classify message priority based on content patterns */
export function classifyPriority(message: string): MessagePriority {
  if (message.includes("[Task assigned]") || message.includes("[Task from"))
    return "critical";
  if (message.includes("[Question from") || message.includes("?"))
    return "high";
  if (message.includes("[Broadcast]") || message.includes("[System"))
    return "low";
  return "normal";
}

/** Extract sender name from a message string, handling various formats.
 *  Strips ANSI escape codes before matching.
 */
/** Build mode-aware notification text for new messages */
function buildNewMessageNotification(senderName: string, mode: MessagingMode): string {
  switch (mode) {
    case "cli": return `[New message from ${senderName}. Run kora-cli messages to read it.]`;
    case "terminal": return `[New message from ${senderName}.]`;
    default: return `[New message from ${senderName}. Use check_messages tool to read it.]`;
  }
}

/** Build mode-aware notification text for unread reminders */
function buildUnreadReminder(count: number, mode: MessagingMode, level: "normal" | "warning" | "urgent" | "critical", elapsedSec?: number): string {
  const cmd = mode === "cli" ? "kora-cli messages" : "check_messages";
  const elapsed = elapsedSec ? ` waiting ${elapsedSec}s` : "";
  switch (level) {
    case "normal": return `\n[Reminder: You have ${count} unread message(s). Run ${cmd} when ready.]\n`;
    case "warning": return `[You have ${count} unread message(s)${elapsed}. Run ${cmd} to read.]`;
    case "urgent": return `\n🔴 URGENT: ${count} unread message(s)${elapsed}! Run ${cmd} NOW.\n`;
    case "critical": return `\n🚨 CRITICAL: ${count} unread message(s)${elapsed}! Run ${cmd} IMMEDIATELY.\n`;
  }
}

function extractSenderName(message: string, fromAgentId?: string): string {
  // Strip ANSI escape codes for cleaner matching
  const clean = message.replace(/\x1b\[[0-9;]*m/g, "");

  // Format: [Message from AgentName]: content
  const match1 = clean.match(/\[(?:Message|Task|DONE|Question|Broadcast|System)[^\]]*from (.+?)\]/);
  if (match1) return match1[1];

  // Format: [From agent-id]: content (broadcast via MCP)
  const match2 = clean.match(/\[From (.+?)\]/);
  if (match2) return match2[1];

  // Use fromAgentId if available (strip UUID suffix for readability)
  if (fromAgentId && fromAgentId !== 'system') {
    // Convert "architect-abc123" to "Architect" (capitalize, strip suffix)
    const name = fromAgentId.replace(/-[a-f0-9]{6,}$/, "");
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  return "teammate";
}

export class MessageQueue {
  private queues = new Map<string, QueuedMessage[]>();
  private deliveryInterval: ReturnType<typeof setTimeout> | null = null;
  private messageCountWindow = new Map<string, { count: number; windowStart: number }>();
  /** Track recent messages to detect loops — key: "from:to", value: count in window */
  private conversationWindow = new Map<string, { count: number; windowStart: number }>();
  /** Cache agent readiness to avoid redundant capture-pane calls */
  private readinessCache = new Map<string, { ready: boolean; checkedAt: number }>();
  private readonly READINESS_CACHE_TTL = 400; // ms
  /** Agent IDs that support MCP — get mcp-pending delivery */
  private mcpAgents = new Set<string>();
  /** Agent roles for role-based rate limits */
  private agentRoles = new Map<string, string>();
  /** Callback for TTL expiry events */
  private onExpiry: ((agentId: string, message: string, priority: MessagePriority) => void) | null = null;
  /** Callback to broadcast WebSocket events (message-buffered, message-expired) */
  private broadcastFn: ((event: Record<string, unknown>) => void) | null = null;

  // ─── Re-notification state ──────────────────────────────
  /** Notification attempt counters per agent (reset when agent reads messages) */
  private notificationAttempts = new Map<string, number>();
  /** Last notification timestamp per agent (rate limiting) */
  private lastNotificationTime = new Map<string, number>();
  /** Timestamp when unread messages first appeared for each agent (for time-based escalation) */
  private firstUnreadTime = new Map<string, number>();
  /** Track whether architect has been alerted for an agent (avoid repeated alerts) */
  private architectAlerted = new Set<string>();
  /** Track recovery state for escalated agents */
  private recoveryState = new Map<string, "escalated" | "partial-recovery" | "recovered">();
  /** Callback to check if agent is alive (running) — skip terminal delivery for crashed/stopped agents */
  private isAgentAliveFn: ((agentId: string) => boolean) | null = null;
  /** Callback to check if agent has recent MCP activity (from AgentHealthMonitor) */
  private hasMcpActivityFn: ((agentId: string) => boolean) | null = null;
  private renotifyInterval: ReturnType<typeof setTimeout> | null = null;
  /** Callback to get unread count for an agent — set by orchestrator */
  private getUnreadCountFn: ((agentId: string) => Promise<number>) | null = null;
  /** Callback to get agent terminal session — set by orchestrator */
  private getAgentTerminalSessionFn: ((agentId: string) => string | null) | null = null;
  /** Callback to alert orchestrator/architect when messages go unread too long */
  private onEscalationFn: ((agentId: string, unreadCount: number, elapsedMs: number) => void) | null = null;

  /** Configurable escalation thresholds (milliseconds) */
  private escalationThresholds = {
    /** First re-notification with ⚠️ prefix */
    warning: 30_000,
    /** Urgent re-notification with 🔴 prefix */
    urgent: 60_000,
    /** Alert architect / log critical warning */
    critical: 120_000,
  };

  // ─── Tier 3: Delivery tracking ──────────────────────────────
  private database: any | null = null;
  private sessionId: string | null = null;
  private metricsInterval: ReturnType<typeof setTimeout> | null = null;
  /** Enable SQLite message storage (dual-write with file fallback) */
  private enableSqliteMessages = true;

  constructor(
    private terminal: IPtyBackend,
    private runtimeDir: string = "",
    private messagingMode: MessagingMode = "mcp",
  ) {}

  /** Set database and sessionId for delivery tracking (Tier 3) */
  setDeliveryTracking(database: any, sessionId: string): void {
    this.database = database;
    this.sessionId = sessionId;
    this.startMetricsBroadcast();
  }

  /** Start periodic metrics broadcast with dynamic interval based on agent count */
  private startMetricsBroadcast(): void {
    if (this.metricsInterval || !this.broadcastFn) return;
    this.scheduleMetricsBroadcast();
  }

  /** Schedule the next metrics broadcast with adaptive interval */
  private scheduleMetricsBroadcast(): void {
    // Dynamic interval: scale up for large sessions to reduce WS event volume
    const agentCount = this.mcpAgents.size;
    const interval = agentCount > 20 ? 60_000 : agentCount > 10 ? 30_000 : 10_000;

    this.metricsInterval = setTimeout(() => {
      try {
        // Only broadcast metrics for agents that have actual message activity
        for (const agentId of this.mcpAgents) {
          const metrics = this.getDeliveryMetrics(agentId);
          if (metrics && metrics.totalMessages > 0 && this.broadcastFn) {
            this.broadcastFn({
              event: "delivery-metrics-updated",
              agentId,
              metrics,
              timestamp: Date.now(),
            });
          }
        }
      } catch (err) {
        logger.warn({ err }, "[MessageQueue] Metrics broadcast error");
      }

      // Reschedule if not stopped
      if (this.metricsInterval) {
        this.scheduleMetricsBroadcast();
      }
    }, interval);
  }

  /** Stop periodic metrics broadcast */
  private stopMetricsBroadcast(): void {
    if (this.metricsInterval) {
      clearTimeout(this.metricsInterval);
      this.metricsInterval = null;
    }
  }

  /** Get the rate limit for an agent based on their role */
  private getRateLimit(agentId: string): number {
    const role = this.agentRoles.get(agentId) || "worker";
    return ROLE_RATE_LIMITS[role] || 10;
  }

  /** Check if an agent has exceeded the rate limit */
  private isRateLimited(agentId: string): boolean {
    const now = Date.now();
    const window = this.messageCountWindow.get(agentId);

    // Reset window every 60 seconds
    if (!window || now - window.windowStart > 60000) {
      this.messageCountWindow.set(agentId, { count: 0, windowStart: now });
      return false;
    }

    return window.count >= this.getRateLimit(agentId);
  }

  /** Increment the message count for an agent */
  private incrementMessageCount(agentId: string): void {
    const now = Date.now();
    const window = this.messageCountWindow.get(agentId);
    if (!window || now - window.windowStart > 60000) {
      this.messageCountWindow.set(agentId, { count: 1, windowStart: now });
    } else {
      window.count++;
    }
  }

  /** Register an agent's role for role-based rate limits */
  registerAgentRole(agentId: string, role: string): void {
    this.agentRoles.set(agentId, role);
  }

  /** Set callback for message TTL expiry events */
  setExpiryCallback(cb: (agentId: string, message: string, priority: MessagePriority) => void): void {
    this.onExpiry = cb;
  }

  /** Set callback to broadcast WebSocket events to dashboard */
  setBroadcastCallback(cb: (event: Record<string, unknown>) => void): void {
    this.broadcastFn = cb;
  }

  /** Set callback to check if agent is alive (running). Used to skip terminal delivery for crashed/stopped agents. */
  setAgentAliveCheck(cb: (agentId: string) => boolean): void {
    this.isAgentAliveFn = cb;
  }

  /** Batch-enqueue messages without triggering processQueues for each one.
   *  Call flushQueues() after batch to trigger single delivery pass. */
  enqueueBatch(agentId: string, terminalSession: string, message: string, fromAgentId?: string, targetAgentId?: string): boolean {
    return this._enqueue(agentId, terminalSession, message, fromAgentId, targetAgentId, false);
  }

  /** Trigger a single delivery pass for all queues. Call after enqueueBatch(). */
  flushQueues(): void {
    this.processQueues().catch((err) => {
      logger.debug({ err }, "[MessageQueue] flushQueues error");
    });
  }

  /** Queue a message for delivery to an agent. Returns false if dropped (loop). */
  enqueue(agentId: string, terminalSession: string, message: string, fromAgentId?: string, targetAgentId?: string, options?: { sqlitePersisted?: boolean }): boolean {
    return this._enqueue(agentId, terminalSession, message, fromAgentId, targetAgentId, true, options);
  }

  private _enqueue(agentId: string, terminalSession: string, message: string, fromAgentId: string | undefined, targetAgentId: string | undefined, immediateFlush: boolean, options?: { sqlitePersisted?: boolean }): boolean {
    // Conversation loop detection — max 8 messages between same pair in 2 minutes
    if (fromAgentId) {
      const pairKey = [fromAgentId, agentId].sort().join(":");
      const now = Date.now();
      const conv = this.conversationWindow.get(pairKey);
      if (!conv || now - conv.windowStart > 120000) {
        this.conversationWindow.set(pairKey, { count: 1, windowStart: now });
      } else {
        conv.count++;
        if (conv.count > 8) {
          logger.warn({ conversationKey: pairKey, count: conv.count }, "[MessageQueue] Loop detected — dropping");
          return false;
        }
      }
    }

    const priority = classifyPriority(message);
    const now = Date.now();

    // Tier 3: Critical messages bypass queue via direct delivery
    if (priority === "critical") {
      this.deliverDirect(agentId, terminalSession, message, fromAgentId, targetAgentId).catch((err) => {
        logger.warn({ agentId, err }, "[MessageQueue] Direct delivery failed for critical message");
      });
      return true;
    }

    if (!this.queues.has(agentId)) this.queues.set(agentId, []);
    const queue = this.queues.get(agentId)!;

    // Buffer size cap — evict lowest-priority oldest when full
    if (queue.length >= MAX_QUEUE_SIZE) {
      // Sort by priority (worst first), then oldest first
      queue.sort((a, b) => {
        const pDiff = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
        if (pDiff !== 0) return pDiff;
        return a.timestamp - b.timestamp;
      });
      const evicted = queue.pop()!;
      logger.warn({ agentId, evictedPriority: evicted.priority }, "[MessageQueue] Queue full, evicted lowest-priority message");
      if (this.onExpiry) {
        this.onExpiry(agentId, evicted.message, evicted.priority);
      }
      if (this.broadcastFn) {
        this.broadcastFn({ event: "message-expired", agentId, priority: evicted.priority });
      }
    }

    queue.push({
      agentId,
      terminalSession,
      message,
      timestamp: now,
      priority,
      ttl: now + PRIORITY_TTL[priority],
      fromAgentId,
      targetAgentId,
      sqlitePersisted: options?.sqlitePersisted,
    });

    // Sort queue by priority (highest first), then by timestamp (oldest first)
    queue.sort((a, b) => {
      const pDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (pDiff !== 0) return pDiff;
      return a.timestamp - b.timestamp;
    });

    // Try to deliver immediately (skip for batch mode — caller will call flushQueues)
    if (immediateFlush) {
      this.processQueues().catch((err) => {
        logger.debug({ err }, "[MessageQueue] processQueues error");
      });
    }
    return true;
  }

  /** Start the delivery loop with adaptive polling */
  start(): void {
    if (this.deliveryInterval) return;
    this.scheduleNextPoll();
    this.startRenotifyLoop();
  }

  /** Schedule the next poll with adaptive interval */
  private scheduleNextPoll(): void {
    const hasMessages = Array.from(this.queues.values()).some(q => q.length > 0);
    const interval = hasMessages ? 500 : 2000;
    this.deliveryInterval = setTimeout(() => {
      this.processQueues().catch(() => {}).finally(() => {
        if (this.deliveryInterval) this.scheduleNextPoll();
      });
    }, interval);
  }

  /** Stop the delivery loop */
  stop(): void {
    if (this.deliveryInterval) {
      clearTimeout(this.deliveryInterval);
      this.deliveryInterval = null;
    }
    this.stopRenotifyLoop();
    this.stopMetricsBroadcast();
  }

  /** Process all queues — deliver messages to agents that are ready (parallel) */
  private async processQueues(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [_agentId, queue] of this.queues) {
      if (queue.length === 0) continue;
      promises.push(this.processOneQueue(queue));
    }
    await Promise.all(promises);
  }

  /** Process a single agent's queue */
  private async processOneQueue(queue: QueuedMessage[]): Promise<void> {
    // First, expire any TTL'd messages
    const now = Date.now();
    while (queue.length > 0 && queue[0].ttl < now) {
      // Check if oldest high-priority message expired (shouldn't happen often)
      // Actually scan for expired messages at any position
      break; // We'll handle TTL below
    }

    // Remove expired messages
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].ttl < now) {
        const expired = queue.splice(i, 1)[0];
        logger.warn({ agentId: expired.agentId, priority: expired.priority }, "[MessageQueue] Message expired (TTL)");
        if (this.onExpiry) {
          this.onExpiry(expired.agentId, expired.message, expired.priority);
        }
        if (this.broadcastFn) {
          this.broadcastFn({ event: "message-expired", agentId: expired.agentId, priority: expired.priority });
        }
      }
    }

    if (queue.length === 0) return;

    const msg = queue[0]; // Highest priority, oldest

    // ─── THE CRITICAL FIX ───
    // Check rate limit BEFORE dequeuing. If over limit, KEEP in queue for next cycle.
    if (this.isRateLimited(msg.agentId)) {
      logger.debug({ agentId: msg.agentId }, "[MessageQueue] Rate limited — keeping in queue for next cycle");
      if (this.broadcastFn) {
        this.broadcastFn({ event: "message-buffered", agentId: msg.agentId, queueSize: queue.length });
      }
      return; // Don't dequeue, don't drop. Will retry on next poll.
    }

    // OPTIMIZATION: Broadcasts and notifications skip readiness check (non-disruptive)
    const isBroadcast = msg.message.includes("[Broadcast]");
    const isNotification = msg.message.includes("[New message from") || msg.message.includes("[Message from")
      || msg.message.includes("check_messages") || msg.message.includes("[Task assigned]")
      || isBroadcast;

    if (isNotification) {
      queue.shift();
      const startTime = Date.now();
      await this.deliver(msg);
      const duration = Date.now() - startTime;

      // Log delivery timing for performance monitoring
      if (duration > 500 || isBroadcast) {
        logger.debug({ agentId: msg.agentId, deliveryTimeMs: duration, isBroadcast }, "[MessageQueue] Delivery completed");
      }

      // Broadcast delivery metrics to dashboard
      if (this.broadcastFn && isBroadcast) {
        this.broadcastFn({
          event: "delivery-timing",
          agentId: msg.agentId,
          durationMs: duration,
          isBroadcast: true,
          timestamp: Date.now(),
        });
      }
      return;
    }

    const ready = await this.isAgentReady(msg.terminalSession);
    if (ready) {
      queue.shift();
      await this.deliver(msg);
    } else if (Date.now() - msg.timestamp > FORCE_DELIVERY_TIMEOUT_MS) {
      // Force deliver after timeout to avoid stuck messages
      queue.shift();
      await this.deliver(msg);
    }
  }

  /** Check if the agent's terminal is at an input prompt (with caching) */
  private async isAgentReady(terminalSession: string): Promise<boolean> {
    const cached = this.readinessCache.get(terminalSession);
    if (cached && Date.now() - cached.checkedAt < this.READINESS_CACHE_TTL) {
      return cached.ready;
    }

    const ready = await this.checkAgentReady(terminalSession);
    this.readinessCache.set(terminalSession, { ready, checkedAt: Date.now() });
    return ready;
  }

  /** Actually check agent readiness via terminal capture-pane */
  private async checkAgentReady(terminalSession: string): Promise<boolean> {
    try {
      const output = await this.terminal.capturePane(terminalSession, 5, false);
      const lines = output
        .trim()
        .split("\n")
        .filter((l) => l.trim());
      const lastLine = lines[lines.length - 1] || "";

      // Claude Code prompt patterns
      if (lastLine.includes("\u276F")) return true; // Claude Code input prompt
      if (lastLine.includes("> ")) return true; // Generic prompt
      if (lastLine.match(/[$%#]\s*$/)) return true; // Shell prompt (agent hasn't started yet)
      if (lastLine.includes("? for shortcuts")) return true; // Claude Code ready state

      // NOT ready patterns
      if (lastLine.includes("Thinking") || lastLine.includes("oking"))
        return false; // Thinking/Cooking
      if (lastLine.includes("Reading") || lastLine.includes("Writing"))
        return false;
      if (lastLine.includes("Running")) return false;
      if (lastLine.includes("Do you want to proceed")) return false; // Tool approval
      if (lastLine.includes("Enter to confirm")) return false;

      // Default: assume not ready if we can't tell
      return false;
    } catch {
      return false;
    }
  }

  /** Actually deliver the message (rate limit already checked in processOneQueue) */
  private async deliver(msg: QueuedMessage): Promise<void> {
    try {
      const isBroadcast = msg.message.includes("[Broadcast]");
      if (isBroadcast) {
        const isMcpAgent = this.mcpAgents.has(msg.agentId);
        logger.info({
          agentId: msg.agentId,
          isMcpAgent,
          messagingMode: this.messagingMode,
          mcpAgentCount: this.mcpAgents.size,
        }, "[MessageQueue] Broadcast routing decision");
      }
      if (this.mcpAgents.has(msg.agentId)) {
        // MCP agent: write to pending store + send terminal notification as fallback
        await this.deliverViaMcpPending(msg);
      } else if (this.messagingMode === "mcp" || this.messagingMode === "cli") {
        // MCP/CLI mode: inbox file + terminal notification (CLI agents read via kora-agent messages)
        await this.deliverViaMcp(msg);
      } else if (this.messagingMode === "terminal") {
        // Terminal mode: send directly via terminal (500 char limit)
        await this.deliverViaTerminal(msg);
      }
      // "manual" mode: don't deliver automatically

      this.incrementMessageCount(msg.agentId);
    } catch {
      // Agent may be dead, discard
    }
  }

  /**
   * Tier 3: Direct delivery channel — bypasses queue for critical/high-priority messages.
   * Returns true if delivery succeeded, false otherwise.
   * Implements automatic retry with exponential backoff for critical/high priority messages.
   */
  async deliverDirect(
    agentId: string,
    terminalSession: string,
    message: string,
    fromAgentId?: string,
    targetAgentId?: string,
  ): Promise<boolean> {
    const priority = classifyPriority(message);
    const maxRetries = priority === "critical" ? 3 : priority === "high" ? 2 : 0;
    const messageId = crypto.randomUUID();
    const enqueuedAt = Date.now();
    const messageSizeBytes = Buffer.byteLength(message, 'utf8');
    let lastError: unknown;

    // Track: message sent (queued)
    if (this.database && this.sessionId) {
      try {
        this.database.trackMessageDelivery({
          id: crypto.randomUUID(),
          sessionId: this.sessionId,
          messageId,
          agentId,
          status: 'sent',
          enqueuedAt,
          messageSizeBytes,
          priority,
        });
      } catch (err) {
        logger.warn({ err, agentId, messageId }, "[MessageQueue] Delivery tracking failed — sent status not recorded");
      }
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const msg: QueuedMessage = {
          agentId,
          terminalSession,
          message,
          timestamp: Date.now(),
          priority,
          ttl: Date.now() + PRIORITY_TTL[priority],
          fromAgentId,
          targetAgentId,
        };

        if (this.mcpAgents.has(agentId)) {
          await this.deliverViaMcpPending(msg);
        } else if (this.messagingMode === "mcp" || this.messagingMode === "cli") {
          await this.deliverViaMcp(msg);
        } else if (this.messagingMode === "terminal") {
          await this.deliverViaTerminal(msg);
        }

        this.incrementMessageCount(agentId);

        // Track: message delivered
        if (this.database && this.sessionId) {
          try {
            this.database.updateMessageDeliveryStatus(messageId, agentId, 'delivered');
          } catch (err) {
            logger.warn({ err, agentId: msg.agentId, messageId }, "[MessageQueue] Delivery tracking failed — delivered status not recorded");
          }
        }

        logger.debug({ agentId, priority, attempt }, "[MessageQueue] Direct delivery succeeded");
        return true;
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
          logger.debug({ agentId, priority, attempt, delayMs }, "[MessageQueue] Direct delivery failed, retrying");
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    logger.error({ agentId, priority, maxRetries, err: lastError }, "[MessageQueue] Direct delivery failed after retries");

    // Emit failure event for dashboard
    if (this.broadcastFn) {
      this.broadcastFn({ event: "delivery-failed", agentId, priority, messageId });
    }

    return false;
  }

  /** MCP mode: write full message to inbox file, send short terminal notification */
  private async deliverViaMcp(msg: QueuedMessage): Promise<void> {
    // Skip terminal delivery for crashed/stopped agents (still persisted in SQLite)
    if (this.isAgentAliveFn && !this.isAgentAliveFn(msg.agentId)) {
      logger.debug({ agentId: msg.agentId }, "[MessageQueue] Skipping MCP delivery — agent not alive");
      return;
    }
    const messageId = crypto.randomUUID();
    const senderName = extractSenderName(msg.message, msg.fromAgentId);
    const isBroadcast = msg.message.includes("[Broadcast]");
    const cleanMsg = msg.message.replace(/\x1b\[[0-9;]*m/g, "");

    if (isBroadcast) {
      logger.info({
        agentId: msg.agentId,
        hasDb: !!this.database,
        hasSessionId: !!this.sessionId,
        sqlitePersisted: !!msg.sqlitePersisted,
        enableSqlite: this.enableSqliteMessages,
        deliveryMode: "mcp",
        contentLen: msg.message.length,
      }, "[MessageQueue] Broadcast delivery via MCP — diagnostics");
    }

    // Always persist to SQLite (broadcasts included — they may be long)
    if (this.enableSqliteMessages && this.database && this.sessionId && !msg.sqlitePersisted) {
      try {
        const expiresAt = msg.ttl || (Date.now() + 7 * 24 * 60 * 60 * 1000);
        this.database.insertMessage({
          id: messageId,
          sessionId: this.sessionId,
          fromAgentId: msg.fromAgentId || 'system',
          toAgentId: msg.agentId,
          messageType: this.classifyMessageType(msg.message),
          content: msg.message,
          priority: msg.priority,
          createdAt: msg.timestamp,
          expiresAt,
          channel: isBroadcast ? '#broadcast' : (msg.targetAgentId ? null : undefined),
        });
      } catch (err) {
        logger.debug({ err }, "[MessageQueue] Failed to insert message to SQLite, falling back to file");
      }
    }

    // Write full message to inbox file (backward compatibility)
    if (!msg.sqlitePersisted) {
      const inboxDir = path.join(this.runtimeDir, "messages", `inbox-${msg.agentId}`);
      await fs.mkdir(inboxDir, { recursive: true });
      const filename = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.md`;
      await fs.writeFile(path.join(inboxDir, filename), msg.message, "utf-8");
    }

    // Send terminal notification — short notification pointing to check_messages
    // (broadcasts included — full content is now in SQLite/inbox)
    if (isBroadcast && cleanMsg.length <= 500) {
      // Short broadcasts: send content directly for convenience
      await this.terminal.sendKeys(msg.terminalSession, cleanMsg.slice(0, 500), { literal: true });
      await this.terminal.sendKeys(msg.terminalSession, '', { literal: false });
    } else {
      const notification = buildNewMessageNotification(senderName, this.messagingMode);
      await this.terminal.sendKeys(msg.terminalSession, notification, { literal: true });
      await this.terminal.sendKeys(msg.terminalSession, '', { literal: false });
    }
  }

  /** MCP pending mode: write to mcp-pending store + send terminal notification */
  private async deliverViaMcpPending(msg: QueuedMessage): Promise<void> {
    if (this.isAgentAliveFn && !this.isAgentAliveFn(msg.agentId)) {
      logger.debug({ agentId: msg.agentId }, "[MessageQueue] Skipping MCP-pending delivery — agent not alive");
      return;
    }
    const messageId = crypto.randomUUID();
    const senderName = extractSenderName(msg.message, msg.fromAgentId);
    const isBroadcast = msg.message.includes("[Broadcast]");
    const cleanMsg = msg.message.replace(/\x1b\[[0-9;]*m/g, "");

    if (isBroadcast) {
      logger.info({
        agentId: msg.agentId,
        hasDb: !!this.database,
        hasSessionId: !!this.sessionId,
        sqlitePersisted: !!msg.sqlitePersisted,
        enableSqlite: this.enableSqliteMessages,
        contentLen: msg.message.length,
      }, "[MessageQueue] Broadcast delivery — diagnostics");
    }

    // Always persist to SQLite (broadcasts included — they may be long)
    if (this.enableSqliteMessages && this.database && this.sessionId && !msg.sqlitePersisted) {
      try {
        const expiresAt = msg.ttl || (Date.now() + 7 * 24 * 60 * 60 * 1000);
        this.database.insertMessage({
          id: messageId,
          sessionId: this.sessionId,
          fromAgentId: msg.fromAgentId || 'system',
          toAgentId: msg.agentId,
          messageType: this.classifyMessageType(msg.message),
          content: msg.message,
          priority: msg.priority,
          createdAt: msg.timestamp,
          expiresAt,
          channel: isBroadcast ? '#broadcast' : (msg.targetAgentId ? null : undefined),
        });
      } catch (err) {
        logger.debug({ err }, "[MessageQueue] Failed to insert message to SQLite, falling back to file");
      }
    }

    // Write to mcp-pending store (backward compatibility)
    if (!msg.sqlitePersisted) {
      const pendingDir = path.join(this.runtimeDir, "mcp-pending", msg.agentId);
      await fs.mkdir(pendingDir, { recursive: true });
      const filename = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`;
      const payload = {
        from: senderName,
        content: msg.message,
        timestamp: new Date().toISOString(),
      };
      await fs.writeFile(path.join(pendingDir, filename), JSON.stringify(payload), "utf-8");
    }

    // Send terminal notification — short notification pointing to check_messages
    if (isBroadcast && cleanMsg.length <= 500) {
      // Short broadcasts: send content directly for convenience
      await this.terminal.sendKeys(msg.terminalSession, cleanMsg.slice(0, 500), { literal: true });
      await this.terminal.sendKeys(msg.terminalSession, '', { literal: false });
    } else {
      const notification = buildNewMessageNotification(senderName, this.messagingMode);
      await this.terminal.sendKeys(msg.terminalSession, notification, { literal: true });
      await this.terminal.sendKeys(msg.terminalSession, '', { literal: false });
    }
  }

  /** Terminal mode: send directly via terminal with 500 char limit */
  private async deliverViaTerminal(msg: QueuedMessage): Promise<void> {
    if (this.isAgentAliveFn && !this.isAgentAliveFn(msg.agentId)) {
      logger.debug({ agentId: msg.agentId }, "[MessageQueue] Skipping terminal delivery — agent not alive");
      return;
    }
    // Strip ANSI codes (they don't work with -l flag)
    let cleanMsg = msg.message.replace(/\x1b\[[0-9;]*m/g, "");

    // Add structured prefix based on message content patterns
    cleanMsg = this.addStructuredPrefix(cleanMsg);

    // Collapse multi-line messages into a single line to avoid triggering
    // Claude Code's "Pasted text" paste detection. Replace newlines with " | "
    // so the message stays readable but doesn't trigger multi-line paste mode.
    cleanMsg = cleanMsg.replace(/\n+/g, " | ").replace(/\s+/g, " ").trim();

    // Truncate very long messages to prevent terminal issues (max ~500 chars)
    if (cleanMsg.length > 500) {
      cleanMsg = cleanMsg.substring(0, 497) + "...";
    }

    await this.terminal.sendKeys(msg.terminalSession, cleanMsg, { literal: true });
    await this.terminal.sendKeys(msg.terminalSession, '', { literal: false });
  }

  /** Classify message type based on content patterns */
  private classifyMessageType(message: string): string {
    if (message.includes("[Task assigned]") || message.includes("[Task from")) return "task";
    if (message.includes("[Question from") || message.includes("?")) return "question";
    if (message.includes("[DONE from") || message.includes("completed")) return "result";
    if (message.includes("[Broadcast]")) return "broadcast";
    if (message.includes("[System")) return "system";
    return "text";
  }

  /** Add structured prefix to relay messages based on content patterns */
  private addStructuredPrefix(message: string): string {
    // Extract the sender name from [Message from X]: pattern
    const relayMatch = message.match(/^\[Message from (.+?)\]:\s*(.+)/);
    if (!relayMatch) return message;

    const senderName = relayMatch[1];
    const content = relayMatch[2];

    // Detect completion messages
    if (/^DONE\b/i.test(content) || /\bcompleted?\b/i.test(content) && /\btask\b/i.test(content)) {
      return `[DONE from ${senderName}]: ${content}`;
    }

    // Detect questions
    if (/\?\s*$/.test(content) || /^(should|can|how|what|where|which|do|does|is|are)\b/i.test(content)) {
      return `[Question from ${senderName}]: ${content}`;
    }

    // Detect task assignments (from orchestrator-like agents)
    if (/\b(implement|create|build|fix|update|write|add|remove|refactor|test)\b/i.test(content) &&
        /\b(file|component|module|function|page|api|endpoint)\b/i.test(content)) {
      return `[Task from ${senderName}]: ${content}`;
    }

    // Default: keep original format
    return `[Message from ${senderName}]: ${content}`;
  }

  /** Register an agent as MCP-capable */
  registerMcpAgent(agentId: string): void {
    this.mcpAgents.add(agentId);
  }

  /** Remove all queued messages and escalation state for an agent */
  removeAgent(agentId: string): void {
    this.queues.delete(agentId);
    this.mcpAgents.delete(agentId);
    this.agentRoles.delete(agentId);
    this.notificationAttempts.delete(agentId);
    this.lastNotificationTime.delete(agentId);
    this.firstUnreadTime.delete(agentId);
    this.architectAlerted.delete(agentId);
  }

  /** Get queue depth for an agent (for monitoring) */
  getQueueDepth(agentId: string): number {
    return this.queues.get(agentId)?.length || 0;
  }

  /** Get delivery metrics for an agent (Tier 3) */
  getDeliveryMetrics(agentId: string, since?: number): {
    avgLatencyMs: number;
    successRate: number;
    failureCount: number;
    totalMessages: number;
    queueDepth: number;
  } | null {
    if (!this.database) {
      return null;
    }

    try {
      const metrics = this.database.getDeliveryMetrics(agentId, since);
      metrics.queueDepth = this.getQueueDepth(agentId);
      return metrics;
    } catch (err) {
      logger.debug({ err }, "[MessageQueue] Failed to get delivery metrics");
      return null;
    }
  }

  // ─── Re-notification system ──────────────────────────────

  /** Set callbacks needed by the re-notification loop */
  setRenotifyCallbacks(
    getUnreadCount: (agentId: string) => Promise<number>,
    getAgentTerminalSession: (agentId: string) => string | null,
    onEscalation?: (agentId: string, unreadCount: number, elapsedMs: number) => void,
  ): void {
    this.getUnreadCountFn = getUnreadCount;
    this.getAgentTerminalSessionFn = getAgentTerminalSession;
    if (onEscalation) this.onEscalationFn = onEscalation;
  }

  /** Set MCP activity checker for recovery detection */
  setMcpActivityChecker(fn: (agentId: string) => boolean): void {
    this.hasMcpActivityFn = fn;
  }

  /** Configure escalation thresholds (in milliseconds). Partial updates supported. */
  setEscalationThresholds(thresholds: Partial<typeof this.escalationThresholds>): void {
    Object.assign(this.escalationThresholds, thresholds);
  }

  /** Reset notification attempts for an agent (called when agent reads messages) */
  resetNotificationAttempts(agentId: string): void {
    this.notificationAttempts.delete(agentId);
    this.lastNotificationTime.delete(agentId);
    this.firstUnreadTime.delete(agentId);
    this.architectAlerted.delete(agentId);
  }

  /** Get notification attempts count for an agent */
  getNotificationAttempts(agentId: string): number {
    return this.notificationAttempts.get(agentId) || 0;
  }

  /** Send an immediate nudge notification to an agent. Returns unread count. */
  async nudgeAgent(agentId: string, terminalSession: string): Promise<number> {
    if (!this.getUnreadCountFn) return 0;
    const unread = await this.getUnreadCountFn(agentId);
    if (unread === 0) return 0;

    const notification = `>>> 📬 YOU HAVE ${unread} UNREAD MESSAGE(S) — run check_messages NOW <<<`;

    // Deliver nudge directly via terminal — send text then Enter separately
    // (literal mode doesn't interpret \n as Enter)
    try {
      await this.terminal.sendKeys(terminalSession, notification, { literal: true });
      await this.terminal.sendKeys(terminalSession, '', { literal: false }); // Press Enter
    } catch (err) {
      logger.warn({ err, agentId }, "Failed to deliver nudge notification");
    }

    return unread;
  }

  /** Start the re-notification loop (every 20 seconds) */
  private startRenotifyLoop(): void {
    if (this.renotifyInterval) return;
    this.renotifyInterval = setInterval(async () => {
      await this.processRenotifications();
    }, 20_000);
  }

  /** Stop the re-notification loop */
  private stopRenotifyLoop(): void {
    if (this.renotifyInterval) {
      clearInterval(this.renotifyInterval);
      this.renotifyInterval = null;
    }
  }

  /** Process re-notifications for all MCP agents with unread messages.
   *  Uses time-based escalation: normal → ⚠️ (30s) → 🔴 (60s) → architect alert (120s) */
  private async processRenotifications(): Promise<void> {
    if (!this.getUnreadCountFn || !this.getAgentTerminalSessionFn) return;

    const now = Date.now();

    for (const agentId of this.mcpAgents) {
      try {
        const unread = await this.getUnreadCountFn(agentId);
        if (unread === 0) {
          // Clear all escalation + recovery state when messages are read
          const wasEscalated = this.recoveryState.has(agentId);
          this.notificationAttempts.delete(agentId);
          this.lastNotificationTime.delete(agentId);
          this.firstUnreadTime.delete(agentId);
          this.architectAlerted.delete(agentId);
          this.recoveryState.delete(agentId);

          // Log recovery + clear dashboard alert
          if (wasEscalated) {
            logger.info({ agentId }, "[MessageQueue] Agent recovered — messages read");
            if (this.broadcastFn) {
              this.broadcastFn({
                event: "message-escalation",
                agentId,
                unreadCount: 0,
                elapsedMs: 0,
                tier: "recovered",
                timestamp: Date.now(),
              });
            }
          }
          continue;
        }

        // Track when unread messages first appeared
        if (!this.firstUnreadTime.has(agentId)) {
          this.firstUnreadTime.set(agentId, now);
        }

        // Rate limit: skip if last notification was <10s ago
        const lastTime = this.lastNotificationTime.get(agentId) || 0;
        if (now - lastTime < 10_000) continue;

        const terminalSession = this.getAgentTerminalSessionFn(agentId);
        if (!terminalSession) continue;

        const elapsedMs = now - this.firstUnreadTime.get(agentId)!;
        const attempts = this.notificationAttempts.get(agentId) || 0;
        const hasMcpActivity = this.hasMcpActivityFn ? this.hasMcpActivityFn(agentId) : false;
        let notification: string;

        // Recovery detection: if agent was escalated but now has MCP activity,
        // they're partially recovered (using tools but haven't read messages yet)
        const currentRecovery = this.recoveryState.get(agentId);
        if (currentRecovery === "escalated" && hasMcpActivity) {
          this.recoveryState.set(agentId, "partial-recovery");
          notification = buildUnreadReminder(unread, this.messagingMode, "normal");
          // Downgrade dashboard alert
          if (this.broadcastFn) {
            this.broadcastFn({
              event: "message-escalation",
              agentId,
              unreadCount: unread,
              elapsedMs,
              tier: "partial-recovery",
              timestamp: now,
            });
          }
          await this.terminal.sendKeys(terminalSession, notification, { literal: false });
          this.lastNotificationTime.set(agentId, now);
          continue;
        }

        if (elapsedMs < this.escalationThresholds.warning) {
          // Tier 0: Normal notification (< 30s)
          notification = buildUnreadReminder(unread, this.messagingMode, "warning");
        } else if (elapsedMs < this.escalationThresholds.urgent) {
          // Tier 1: Warning escalation (30s - 60s)
          notification = buildUnreadReminder(unread, this.messagingMode, "warning", Math.round(elapsedMs / 1000));
        } else if (elapsedMs < this.escalationThresholds.critical) {
          // Tier 2: Urgent escalation (60s - 120s)
          notification = buildUnreadReminder(unread, this.messagingMode, "urgent", Math.round(elapsedMs / 1000));
        } else {
          // Tier 3: Critical — alert architect/dashboard (120s+)
          this.recoveryState.set(agentId, "escalated");

          // Auto-nudge at 5+ min (300s): forceful terminal sendKeys
          if (elapsedMs > 300_000) {
            notification = buildUnreadReminder(unread, this.messagingMode, "urgent", Math.round(elapsedMs / 1000));
          } else {
            notification = buildUnreadReminder(unread, this.messagingMode, "critical", Math.round(elapsedMs / 1000));
          }

          // Alert architect once per escalation cycle
          if (!this.architectAlerted.has(agentId)) {
            this.architectAlerted.add(agentId);
            logger.warn(
              { agentId, unreadCount: unread, elapsedMs, attempts },
              "[MessageQueue] Agent has not read messages for >120s — escalating",
            );

            // Notify orchestrator/architect via callback
            if (this.onEscalationFn) {
              try {
                this.onEscalationFn(agentId, unread, elapsedMs);
              } catch (err) {
                logger.warn({ err, agentId }, "[MessageQueue] Escalation callback failed");
              }
            }

            // Broadcast escalation event for dashboard (WebSocket toast)
            if (this.broadcastFn) {
              this.broadcastFn({
                event: "message-escalation",
                agentId,
                unreadCount: unread,
                elapsedMs,
                tier: "critical",
                timestamp: now,
              });
            }
          }

          // Re-escalate at 10+ min if still no activity
          if (elapsedMs > 600_000 && !hasMcpActivity) {
            this.architectAlerted.delete(agentId); // Allow re-alert
          }
        }

        await this.terminal.sendKeys(terminalSession, notification, { literal: false });
        this.notificationAttempts.set(agentId, attempts + 1);
        this.lastNotificationTime.set(agentId, now);
      } catch {
        // Agent may be dead — ignore
      }
    }
  }
}
