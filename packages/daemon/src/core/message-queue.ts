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
  private deliveryInterval: NodeJS.Timeout | null = null;
  private messageCountWindow = new Map<string, { count: number; windowStart: number }>();
  /** Track recent messages to detect loops — key: "from:to", value: count in window */
  private conversationWindow = new Map<string, { count: number; windowStart: number }>();

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
    return true;
  }

  /** Start the delivery loop */
  start(): void {
    if (this.deliveryInterval) return;
    this.deliveryInterval = setInterval(() => this.processQueues(), 2000);
  }

  /** Stop the delivery loop */
  stop(): void {
    if (this.deliveryInterval) {
      clearInterval(this.deliveryInterval);
      this.deliveryInterval = null;
    }
  }

  /** Process all queues — deliver messages to agents that are ready */
  private async processQueues(): Promise<void> {
    for (const [_agentId, queue] of this.queues) {
      if (queue.length === 0) continue;

      const msg = queue[0]; // peek at first message

      // Check if agent is at a prompt (ready for input)
      const ready = await this.isAgentReady(msg.tmuxSession);
      if (ready) {
        queue.shift(); // remove from queue
        await this.deliver(msg);
      } else {
        // Check if message is too old (>60s) — force deliver to avoid stuck messages
        if (Date.now() - msg.timestamp > 60000) {
          queue.shift();
          await this.deliver(msg);
        }
      }
    }
  }

  /** Check if the agent's terminal is at an input prompt */
  private async isAgentReady(tmuxSession: string): Promise<boolean> {
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
      if (this.messagingMode === "mcp") {
        // MCP mode: write full message to file, send short notification to tmux
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

  /** Remove all queued messages for an agent */
  removeAgent(agentId: string): void {
    this.queues.delete(agentId);
  }
}
