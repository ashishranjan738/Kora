import type { IPtyBackend } from "./pty-backend.js";
import { AgentManager } from "./agent-manager.js";
import { EventLog } from "./event-log.js";
import { MessageQueue } from "./message-queue.js";
import type { AgentState, MessagingMode } from "@kora/shared";
import { logger } from "./logger.js";

/**
 * Monitors agent terminal output for @mention patterns and auto-relays messages.
 *
 * Patterns detected:
 *   @Worker-A: please implement the login page
 *   @Orchestrator: I've finished the task
 *   @all: status update - API review complete
 */
export class AutoRelay {
  private intervals = new Map<string, NodeJS.Timeout>();
  private lastOutput = new Map<string, string>();
  private processedMessages = new Map<string, number>(); // key → timestamp
  private relayCountWindow = new Map<string, { count: number; windowStart: number }>();

  private _messageQueue: MessageQueue | null = null;

  constructor(
    private tmux: IPtyBackend,
    private agentManager: AgentManager,
    private eventLog: EventLog,
    private sessionId: string,
    private messagingMode?: MessagingMode,
  ) {}

  /** Set the message queue for prompt-aware delivery */
  setMessageQueue(queue: MessageQueue): void {
    this._messageQueue = queue;
  }

  /** Start monitoring an agent's terminal output for @mention patterns */
  startMonitoring(agent: AgentState): void {
    // Auto-relay is only active in terminal mode (or when no mode is set and provider is not claude-code)
    if (this.messagingMode === "mcp" || this.messagingMode === "manual") return;

    const interval = setInterval(async () => {
      try {
        const output = await this.tmux.capturePane(agent.config.terminalSession, 30, false);
        const lastOut = this.lastOutput.get(agent.id) || "";

        if (output === lastOut) return;
        this.lastOutput.set(agent.id, output);

        // Find new lines using positional diff (not Set-based, which misses duplicates)
        const lastArr = lastOut.split("\n");
        const newArr = output.split("\n");
        // Find where the new output diverges from the old — skip shared prefix
        let commonPrefix = 0;
        while (commonPrefix < lastArr.length && commonPrefix < newArr.length && lastArr[commonPrefix] === newArr[commonPrefix]) {
          commonPrefix++;
        }
        const newLines = newArr.slice(commonPrefix);

        // Scan for @mention patterns in new lines
        for (const line of newLines) {
          await this.processLine(agent, line.trim());
        }
      } catch {
        // Agent may be dead
      }
    }, 3000); // Check every 3 seconds

    this.intervals.set(agent.id, interval);
  }

  /** Process a single line looking for @mention patterns */
  private async processLine(fromAgent: AgentState, line: string): Promise<void> {
    // Pattern: @AgentName: message
    // Also match: @agent-name: message (with ID)
    // Skip if it's an incoming relay message (starts with [Message from)
    if (line.startsWith("[Message from") || line.startsWith("[System]")) return;

    // Match @Name: message or @all: message
    const mentionMatch = line.match(/@([\w\s-]+?):\s*(.+)/);
    if (!mentionMatch) return;

    const targetName = mentionMatch[1].trim();
    const message = mentionMatch[2].trim();

    if (!message) return;

    // Create a unique key to avoid processing the same message twice
    const msgKey = `${fromAgent.id}:${targetName}:${message.substring(0, 50)}`;
    if (this.processedMessages.has(msgKey)) return;
    this.processedMessages.set(msgKey, Date.now());
    // LRU eviction: remove entries older than 5 minutes when map exceeds 1000
    if (this.processedMessages.size > 1000) {
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [key, ts] of this.processedMessages) {
        if (ts < cutoff) this.processedMessages.delete(key);
      }
      // If still over limit after time-based eviction, remove oldest
      if (this.processedMessages.size > 1000) {
        let oldest = Infinity, oldestKey = "";
        for (const [key, ts] of this.processedMessages) {
          if (ts < oldest) { oldest = ts; oldestKey = key; }
        }
        if (oldestKey) this.processedMessages.delete(oldestKey);
      }
    }

    // Find target agent(s)
    const allAgents = this.agentManager.listAgents().filter(a => a.status === "running" && a.id !== fromAgent.id);

    if (targetName.toLowerCase() === "all") {
      // Broadcast to all other agents
      for (const target of allAgents) {
        await this.deliverRelay(fromAgent, target, message);
      }
    } else {
      // Find by name (case-insensitive) — prioritize exact match over partial
      const search = targetName.toLowerCase();
      const target =
        allAgents.find(a => a.config.name.toLowerCase() === search) ||    // exact name
        allAgents.find(a => a.id.toLowerCase() === search) ||              // exact ID
        allAgents.find(a => a.config.name.toLowerCase().includes(search)); // partial name (fallback)

      if (target) {
        await this.deliverRelay(fromAgent, target, message);
      }
    }
  }

  /** Check if an agent has exceeded the relay rate limit (3 messages per 60s) */
  private isRelayRateLimited(agentId: string): boolean {
    const now = Date.now();
    const window = this.relayCountWindow.get(agentId);

    if (!window || now - window.windowStart > 60000) {
      this.relayCountWindow.set(agentId, { count: 0, windowStart: now });
      return false;
    }

    return window.count >= 3;
  }

  /** Increment the relay count for an agent */
  private incrementRelayCount(agentId: string): void {
    const now = Date.now();
    const window = this.relayCountWindow.get(agentId);
    if (!window || now - window.windowStart > 60000) {
      this.relayCountWindow.set(agentId, { count: 1, windowStart: now });
    } else {
      window.count++;
    }
  }

  /** Deliver a relayed message to the target agent's terminal */
  private async deliverRelay(from: AgentState, to: AgentState, message: string): Promise<void> {
    // Rate limit: if source agent has sent too many @mention messages, stop relaying
    if (this.isRelayRateLimited(from.id)) {
      logger.warn(`[AutoRelay] Agent ${from.config.name} is rate limited — too many messages in 60s`);
      return;
    }

    this.incrementRelayCount(from.id);
    const relayMsg = `\x1b[1;36m[Message from ${from.config.name}]\x1b[0m: ${message}`;
    try {
      // Use message queue for prompt-aware delivery if available, otherwise fall back to direct send
      if (this._messageQueue) {
        this._messageQueue.enqueue(to.id, to.config.terminalSession, relayMsg, from.id);
      } else {
        await this.tmux.sendKeys(to.config.terminalSession, relayMsg, { literal: true });
        await this.tmux.sendKeys(to.config.terminalSession, '', { literal: false });
      }

      await this.eventLog.log({
        sessionId: this.sessionId,
        type: "message-sent",
        data: {
          from: from.id,
          fromName: from.config.name,
          to: to.id,
          toName: to.config.name,
          content: message.substring(0, 200),
          autoRelayed: true,
        },
      });
    } catch {
      // Target may be dead
    }
  }

  /** Stop monitoring an agent */
  stopMonitoring(agentId: string): void {
    const interval = this.intervals.get(agentId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(agentId);
    }
    this.lastOutput.delete(agentId);
  }

  /** Stop all monitoring */
  stopAll(): void {
    for (const [id] of this.intervals) this.stopMonitoring(id);
  }
}
