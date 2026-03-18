import type { IPtyBackend } from "./pty-backend.js";
import { AgentManager } from "./agent-manager.js";
import { EventLog } from "./event-log.js";
import { MessageQueue } from "./message-queue.js";
import type { AgentState, MessagingMode } from "@kora/shared";

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
  private processedMessages = new Set<string>();
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
        const output = await this.tmux.capturePane(agent.config.tmuxSession, 30, false);
        const lastOut = this.lastOutput.get(agent.id) || "";

        if (output === lastOut) return;
        this.lastOutput.set(agent.id, output);

        // Find new lines (diff from last capture)
        const lastLines = new Set(lastOut.split("\n"));
        const newLines = output.split("\n").filter(line => !lastLines.has(line));

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
    this.processedMessages.add(msgKey);
    // Clean up old keys to prevent memory leak
    if (this.processedMessages.size > 1000) {
      const keys = [...this.processedMessages];
      for (let i = 0; i < 500; i++) this.processedMessages.delete(keys[i]);
    }

    // Find target agent(s)
    const allAgents = this.agentManager.listAgents().filter(a => a.status === "running" && a.id !== fromAgent.id);

    if (targetName.toLowerCase() === "all") {
      // Broadcast to all other agents
      for (const target of allAgents) {
        await this.deliverRelay(fromAgent, target, message);
      }
    } else {
      // Find by name (case-insensitive, partial match)
      const target = allAgents.find(a => {
        const name = a.config.name.toLowerCase();
        const search = targetName.toLowerCase();
        return name === search || name.includes(search) || a.id.includes(search);
      });

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
      console.warn(`[AutoRelay] Agent ${from.config.name} is rate limited — too many messages in 60s`);
      return;
    }

    this.incrementRelayCount(from.id);
    const relayMsg = `\x1b[1;36m[Message from ${from.config.name}]\x1b[0m: ${message}`;
    try {
      // Use message queue for prompt-aware delivery if available, otherwise fall back to direct send
      if (this._messageQueue) {
        this._messageQueue.enqueue(to.id, to.config.tmuxSession, relayMsg, from.id);
      } else {
        await this.tmux.sendKeys(to.config.tmuxSession, relayMsg, { literal: true });
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
