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
  tmuxSession: string;
  message: string;
  timestamp: number;
  priority: MessagePriority;
  ttl: number;  // absolute expiry timestamp (ms)
  fromAgentId?: string;
  targetAgentId?: string;  // Tier 3: If set, only deliver to this agent (targeted message). If undefined, broadcast to all.
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

export class MessageQueue {
  private queues = new Map<string, QueuedMessage[]>();
  private deliveryInterval: ReturnType<typeof setTimeout> | null = null;
  private messageCountWindow = new Map<string, { count: number; windowStart: number }>();
  /** Track recent messages to detect loops — key: "from:to", value: count in window */
  private conversationWindow = new Map<string, { count: number; windowStart: number }>();
  /** Cache agent readiness to avoid redundant tmux capture-pane calls */
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
  private renotifyInterval: ReturnType<typeof setTimeout> | null = null;
  /** Callback to get unread count for an agent — set by orchestrator */
  private getUnreadCountFn: ((agentId: string) => Promise<number>) | null = null;
  /** Callback to get agent tmux session — set by orchestrator */
  private getAgentTmuxSessionFn: ((agentId: string) => string | null) | null = null;

  // ─── Tier 3: Delivery tracking ──────────────────────────────
  private database: any | null = null;
  private sessionId: string | null = null;
  private metricsInterval: ReturnType<typeof setTimeout> | null = null;
  /** Enable SQLite message storage (dual-write with file fallback) */
  private enableSqliteMessages = true;

  constructor(
    private tmux: IPtyBackend,
    private runtimeDir: string = "",
    private messagingMode: MessagingMode = "mcp",
  ) {}

  /** Set database and sessionId for delivery tracking (Tier 3) */
  setDeliveryTracking(database: any, sessionId: string): void {
    this.database = database;
    this.sessionId = sessionId;
    this.startMetricsBroadcast();
  }

  /** Start periodic metrics broadcast (every 10 seconds) */
  private startMetricsBroadcast(): void {
    if (this.metricsInterval || !this.broadcastFn) return;

    this.metricsInterval = setInterval(() => {
      try {
        // Broadcast metrics for all agents with messages
        for (const agentId of this.mcpAgents) {
          const metrics = this.getDeliveryMetrics(agentId);
          if (metrics && this.broadcastFn) {
            this.broadcastFn({
              event: "delivery-metrics-updated",
              agentId,
              metrics,
              timestamp: Date.now(),
            });
          }
        }
      } catch (err) {
        logger.debug({ err }, "[MessageQueue] Metrics broadcast error");
      }
    }, 10_000); // Every 10 seconds
  }

  /** Stop periodic metrics broadcast */
  private stopMetricsBroadcast(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
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

  /** Batch-enqueue messages without triggering processQueues for each one.
   *  Call flushQueues() after batch to trigger single delivery pass. */
  enqueueBatch(agentId: string, tmuxSession: string, message: string, fromAgentId?: string, targetAgentId?: string): boolean {
    return this._enqueue(agentId, tmuxSession, message, fromAgentId, targetAgentId, false);
  }

  /** Trigger a single delivery pass for all queues. Call after enqueueBatch(). */
  flushQueues(): void {
    this.processQueues().catch((err) => {
      logger.debug({ err }, "[MessageQueue] flushQueues error");
    });
  }

  /** Queue a message for delivery to an agent. Returns false if dropped (loop). */
  enqueue(agentId: string, tmuxSession: string, message: string, fromAgentId?: string, targetAgentId?: string): boolean {
    return this._enqueue(agentId, tmuxSession, message, fromAgentId, targetAgentId, true);
  }

  private _enqueue(agentId: string, tmuxSession: string, message: string, fromAgentId: string | undefined, targetAgentId: string | undefined, immediateFlush: boolean): boolean {
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
      this.deliverDirect(agentId, tmuxSession, message, fromAgentId, targetAgentId).catch((err) => {
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
      tmuxSession,
      message,
      timestamp: now,
      priority,
      ttl: now + PRIORITY_TTL[priority],
      fromAgentId,
      targetAgentId,
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

    // Notifications (MCP inbox/pending alerts) are small non-disruptive text — deliver immediately
    const isNotification = msg.message.includes("[New message from") || msg.message.includes("[Message from")
      || msg.message.includes("check_messages") || msg.message.includes("[Task assigned]")
      || msg.message.includes("[Broadcast]");

    if (isNotification) {
      queue.shift();
      await this.deliver(msg);
      return;
    }

    const ready = await this.isAgentReady(msg.tmuxSession);
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
  private async isAgentReady(tmuxSession: string): Promise<boolean> {
    const cached = this.readinessCache.get(tmuxSession);
    if (cached && Date.now() - cached.checkedAt < this.READINESS_CACHE_TTL) {
      return cached.ready;
    }

    const ready = await this.checkAgentReady(tmuxSession);
    this.readinessCache.set(tmuxSession, { ready, checkedAt: Date.now() });
    return ready;
  }

  /** Actually check agent readiness via tmux capture-pane */
  private async checkAgentReady(tmuxSession: string): Promise<boolean> {
    try {
      const output = await this.tmux.capturePane(tmuxSession, 5, false);
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
      if (this.mcpAgents.has(msg.agentId)) {
        // MCP agent: write to pending store + send tmux notification as fallback
        await this.deliverViaMcpPending(msg);
      } else if (this.messagingMode === "mcp") {
        // Legacy MCP mode (non-MCP agent in MCP session): inbox file + notification
        await this.deliverViaMcp(msg);
      } else if (this.messagingMode === "terminal") {
        // Terminal mode: send directly via tmux (500 char limit)
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
    tmuxSession: string,
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
    // Use messageId as PK to prevent duplicate tracking records on retry
    if (this.database && this.sessionId) {
      try {
        this.database.trackMessageDelivery({
          id: messageId,  // Use messageId as PK for idempotency
          sessionId: this.sessionId,
          messageId,
          agentId,
          status: 'sent',
          enqueuedAt,
          messageSizeBytes,
          priority,
        });
      } catch (err) {
        logger.debug({ err }, "[MessageQueue] Failed to track delivery in DB");
      }
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const msg: QueuedMessage = {
          agentId,
          tmuxSession,
          message,
          timestamp: Date.now(),
          priority,
          ttl: Date.now() + PRIORITY_TTL[priority],
          fromAgentId,
          targetAgentId,
        };

        if (this.mcpAgents.has(agentId)) {
          await this.deliverViaMcpPending(msg);
        } else if (this.messagingMode === "mcp") {
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
            logger.debug({ err }, "[MessageQueue] Failed to update delivery status in DB");
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

  /** MCP mode: write full message to inbox file, send short tmux notification */
  private async deliverViaMcp(msg: QueuedMessage): Promise<void> {
    const messageId = crypto.randomUUID();
    const senderName = msg.message.match(/\[(?:Message|Task|DONE|Question|Broadcast|System) from (.+?)\]/)?.[1]
      || msg.message.match(/\[Message from (.+?)\]/)?.[1]
      || "teammate";

    // Write to SQLite (if enabled)
    if (this.enableSqliteMessages && this.database && this.sessionId) {
      try {
        const expiresAt = msg.ttl || (Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days default
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
          channel: msg.targetAgentId ? null : '#broadcast',
        });
      } catch (err) {
        logger.debug({ err }, "[MessageQueue] Failed to insert message to SQLite, falling back to file");
      }
    }

    // Write full message to inbox file (backward compatibility)
    const inboxDir = path.join(this.runtimeDir, "messages", `inbox-${msg.agentId}`);
    await fs.mkdir(inboxDir, { recursive: true });
    const filename = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.md`;
    await fs.writeFile(path.join(inboxDir, filename), msg.message, "utf-8");

    // Send short notification to tmux
    const notification = `[New message from ${senderName}. Use check_messages tool to read it.]`;
    await this.tmux.sendKeys(msg.tmuxSession, notification, { literal: false });
  }

  /** MCP pending mode: write to mcp-pending store + send tmux notification */
  private async deliverViaMcpPending(msg: QueuedMessage): Promise<void> {
    const messageId = crypto.randomUUID();
    const senderName = msg.message.match(/\[(?:Message|Task|DONE|Question|Broadcast|System)[^\]]*from (.+?)\]/)?.[1] || "unknown";

    // Write to SQLite (if enabled)
    if (this.enableSqliteMessages && this.database && this.sessionId) {
      try {
        const expiresAt = msg.ttl || (Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days default
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
          channel: msg.targetAgentId ? null : '#broadcast',
        });
      } catch (err) {
        logger.debug({ err }, "[MessageQueue] Failed to insert message to SQLite, falling back to file");
      }
    }

    // 1. Write to mcp-pending store (backward compatibility)
    const pendingDir = path.join(this.runtimeDir, "mcp-pending", msg.agentId);
    await fs.mkdir(pendingDir, { recursive: true });
    const filename = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`;
    const payload = {
      from: senderName,
      content: msg.message,
      timestamp: new Date().toISOString(),
    };
    await fs.writeFile(path.join(pendingDir, filename), JSON.stringify(payload), "utf-8");

    // 2. Also send tmux notification as fallback
    const notification = `[New message from ${senderName}. Use check_messages tool to read it.]`;
    await this.tmux.sendKeys(msg.tmuxSession, notification, { literal: false });
  }

  /** Terminal mode: send directly via tmux with 500 char limit */
  private async deliverViaTerminal(msg: QueuedMessage): Promise<void> {
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

    await this.tmux.sendKeys(msg.tmuxSession, cleanMsg, { literal: false });
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

  /** Remove all queued messages for an agent */
  removeAgent(agentId: string): void {
    this.queues.delete(agentId);
    this.mcpAgents.delete(agentId);
    this.agentRoles.delete(agentId);
    this.notificationAttempts.delete(agentId);
    this.lastNotificationTime.delete(agentId);
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
    getAgentTmuxSession: (agentId: string) => string | null,
  ): void {
    this.getUnreadCountFn = getUnreadCount;
    this.getAgentTmuxSessionFn = getAgentTmuxSession;
  }

  /** Reset notification attempts for an agent (called when agent reads messages) */
  resetNotificationAttempts(agentId: string): void {
    this.notificationAttempts.delete(agentId);
    this.lastNotificationTime.delete(agentId);
  }

  /** Get notification attempts count for an agent */
  getNotificationAttempts(agentId: string): number {
    return this.notificationAttempts.get(agentId) || 0;
  }

  /** Send an immediate nudge notification to an agent. Returns unread count. */
  async nudgeAgent(agentId: string, tmuxSession: string): Promise<number> {
    if (!this.getUnreadCountFn) return 0;
    const unread = await this.getUnreadCountFn(agentId);
    if (unread === 0) return 0;

    const notification = `\n>>> 📬 YOU HAVE ${unread} UNREAD MESSAGE(S) — run check_messages NOW <<<\n`;

    // Tier 3: Use direct delivery to bypass queue (nudges are time-sensitive)
    await this.deliverDirect(agentId, tmuxSession, notification, undefined, agentId);

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

  /** Process re-notifications for all MCP agents with unread messages */
  private async processRenotifications(): Promise<void> {
    if (!this.getUnreadCountFn || !this.getAgentTmuxSessionFn) return;

    for (const agentId of this.mcpAgents) {
      try {
        const unread = await this.getUnreadCountFn(agentId);
        if (unread === 0) {
          // Clear attempts when no unread messages
          this.notificationAttempts.delete(agentId);
          this.lastNotificationTime.delete(agentId);
          continue;
        }

        // Rate limit: skip if last notification was <10s ago
        const lastTime = this.lastNotificationTime.get(agentId) || 0;
        if (Date.now() - lastTime < 10_000) continue;

        const tmuxSession = this.getAgentTmuxSessionFn(agentId);
        if (!tmuxSession) continue;

        // Deliver re-notifications immediately — they are small non-disruptive text.
        const attempts = this.notificationAttempts.get(agentId) || 0;
        let notification: string;

        if (attempts === 0) {
          notification = `[You have ${unread} unread message(s). Run check_messages to read.]`;
        } else if (attempts < 3) {
          notification = `\n⚠️ ${unread} UNREAD MESSAGE(S) waiting. Please run check_messages.\n`;
        } else {
          notification = `\n🔴 URGENT: ${unread} unread message(s)! Run check_messages NOW.\n`;
        }

        await this.tmux.sendKeys(tmuxSession, notification, { literal: false });
        this.notificationAttempts.set(agentId, attempts + 1);
        this.lastNotificationTime.set(agentId, Date.now());
      } catch {
        // Agent may be dead — ignore
      }
    }
  }
}
