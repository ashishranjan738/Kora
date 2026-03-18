import { TmuxController } from "./tmux-controller.js";
import type { MessagingMode } from "@kora/shared";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

interface QueuedMessage {
  agentId: string;
  tmuxSession: string;
  message: string;
  timestamp: number;
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

  constructor(
    private tmux: TmuxController,
    private runtimeDir: string = "",
    private messagingMode: MessagingMode = "mcp",
  ) {}

  /** Check if an agent has exceeded the rate limit (3 messages per 60s) */
  private isRateLimited(agentId: string): boolean {
    const now = Date.now();
    const window = this.messageCountWindow.get(agentId);

    // Reset window every 60 seconds
    if (!window || now - window.windowStart > 60000) {
      this.messageCountWindow.set(agentId, { count: 0, windowStart: now });
      return false;
    }

    // Max 10 incoming relay messages per minute per agent
    return window.count >= 10;
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

  /** Queue a message for delivery to an agent. Returns false if dropped. */
  enqueue(agentId: string, tmuxSession: string, message: string, fromAgentId?: string): boolean {
    // Conversation loop detection — max 3 messages between same pair in 2 minutes
    if (fromAgentId) {
      const pairKey = [fromAgentId, agentId].sort().join(":");
      const now = Date.now();
      const conv = this.conversationWindow.get(pairKey);
      if (!conv || now - conv.windowStart > 120000) {
        this.conversationWindow.set(pairKey, { count: 1, windowStart: now });
      } else {
        conv.count++;
        if (conv.count > 8) {
          console.warn(`[MessageQueue] Loop detected: ${pairKey} exchanged ${conv.count} messages in 2min — dropping`);
          return false;
        }
      }
    }

    if (!this.queues.has(agentId)) this.queues.set(agentId, []);
    this.queues.get(agentId)!.push({
      agentId,
      tmuxSession,
      message,
      timestamp: Date.now(),
    });
    // Try to deliver immediately instead of waiting for next poll cycle
    this.processQueues().catch(() => {});
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
    const msg = queue[0];
    const ready = await this.isAgentReady(msg.tmuxSession);
    if (ready) {
      queue.shift();
      await this.deliver(msg);
    } else if (Date.now() - msg.timestamp > 15000) {
      // Force deliver after 15s to avoid stuck messages
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

  /** Actually deliver the message to tmux */
  private async deliver(msg: QueuedMessage): Promise<void> {
    // Rate limit check — drop message if agent is receiving too many
    if (this.isRateLimited(msg.agentId)) {
      console.warn(`[MessageQueue] Rate limited: dropping message for agent ${msg.agentId} — too many messages in 60s`);
      return;
    }

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

  /** MCP mode: write full message to inbox file, send short tmux notification */
  private async deliverViaMcp(msg: QueuedMessage): Promise<void> {
    // Write full message to inbox file
    const inboxDir = path.join(this.runtimeDir, "messages", `inbox-${msg.agentId}`);
    await fs.mkdir(inboxDir, { recursive: true });
    const filename = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.md`;
    await fs.writeFile(path.join(inboxDir, filename), msg.message, "utf-8");

    // Send short notification to tmux
    const senderName = msg.message.match(/\[(?:Message|Task|DONE|Question|Broadcast|System) from (.+?)\]/)?.[1]
      || msg.message.match(/\[Message from (.+?)\]/)?.[1]
      || "teammate";
    const notification = `[New message from ${senderName}. Use check_messages tool to read it.]`;
    await this.tmux.sendKeys(msg.tmuxSession, notification, { literal: true });
  }

  /** MCP pending mode: write to mcp-pending store + send tmux notification */
  private async deliverViaMcpPending(msg: QueuedMessage): Promise<void> {
    // 1. Write to mcp-pending store
    const pendingDir = path.join(this.runtimeDir, "mcp-pending", msg.agentId);
    await fs.mkdir(pendingDir, { recursive: true });
    const filename = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`;
    const payload = {
      from: msg.message.match(/\[(?:Message|Task|DONE|Question|Broadcast|System)[^\]]*from (.+?)\]/)?.[1] || "unknown",
      content: msg.message,
      timestamp: new Date().toISOString(),
    };
    await fs.writeFile(path.join(pendingDir, filename), JSON.stringify(payload), "utf-8");

    // 2. Also send tmux notification as fallback
    const senderName = payload.from;
    const notification = `[New message from ${senderName}. Use check_messages tool to read it.]`;
    await this.tmux.sendKeys(msg.tmuxSession, notification, { literal: true });
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

    await this.tmux.sendKeys(msg.tmuxSession, cleanMsg, { literal: true });
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
    this.notificationAttempts.delete(agentId);
    this.lastNotificationTime.delete(agentId);
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
    try {
      await this.tmux.sendKeys(tmuxSession, notification, { literal: true });
    } catch { /* agent may be dead */ }
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

        // Check if agent is at a prompt (ready to receive)
        const ready = await this.isAgentReady(tmuxSession);
        if (!ready) continue;

        const attempts = this.notificationAttempts.get(agentId) || 0;
        let notification: string;

        if (attempts === 0) {
          notification = `[You have ${unread} unread message(s). Run check_messages to read.]`;
        } else if (attempts < 3) {
          notification = `\n⚠️ ${unread} UNREAD MESSAGE(S) waiting. Please run check_messages.\n`;
        } else {
          notification = `\n🔴 URGENT: ${unread} unread message(s)! Run check_messages NOW.\n`;
        }

        await this.tmux.sendKeys(tmuxSession, notification, { literal: true });
        this.notificationAttempts.set(agentId, attempts + 1);
        this.lastNotificationTime.set(agentId, Date.now());
      } catch {
        // Agent may be dead — ignore
      }
    }
  }
}
