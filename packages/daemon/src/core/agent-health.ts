import type { AgentState, AgentHealthCheck } from "@kora/shared";
import { HEALTH_CHECK_INTERVAL_MS, MAX_CONSECUTIVE_FAILURES } from "@kora/shared";
import type { IPtyBackend } from "./pty-backend.js";
import { EventEmitter } from "events";

/** Shell prompt patterns that indicate the agent is idle at a command prompt */
const IDLE_PROMPT_PATTERNS = [
  /[$%>#]\s*$/,           // Generic shell prompts
  /\s+\$\s*$/,            // Bash-style
  /\s+%\s*$/,             // Zsh-style
  /\s+>\s*$/,             // PowerShell-style
  /^\s*\[.*?\]\s*[$%>]\s*$/, // Bracketed prompts
];

/** How long to wait without output before considering an agent idle (ms) */
const IDLE_TIMEOUT_MS = 30_000; // 30 seconds

export class AgentHealthMonitor extends EventEmitter {
  private intervals = new Map<string, NodeJS.Timeout>();
  private lastOutputTimestamps = new Map<string, number>();
  private lastOutputCache = new Map<string, string>();
  private agents?: Map<string, AgentState>;

  constructor(
    private tmux: IPtyBackend,
    agents?: Map<string, AgentState>
  ) {
    super();
    this.agents = agents;
  }

  /** Set the agents map for idle detection (called after AgentManager construction) */
  setAgentsMap(agents: Map<string, AgentState>): void {
    this.agents = agents;
  }

  /** Start monitoring an agent */
  startMonitoring(agentId: string, tmuxSession: string): void {
    const interval = setInterval(async () => {
      const alive = await this.tmux.hasSession(tmuxSession);
      if (!alive) {
        this.emit("agent-dead", agentId);
        return;
      }

      const pid = await this.tmux.getPanePID(tmuxSession);
      if (pid === null) {
        this.emit("agent-dead", agentId);
        return;
      }

      this.emit("agent-alive", agentId);

      // Idle detection: check terminal output for activity
      if (this.agents) {
        await this.checkIdleState(agentId, tmuxSession);
      }
    }, HEALTH_CHECK_INTERVAL_MS);
    this.intervals.set(agentId, interval);
    this.lastOutputTimestamps.set(agentId, Date.now());
  }

  /** Check if agent is idle by examining terminal output */
  private async checkIdleState(agentId: string, tmuxSession: string): Promise<void> {
    const agent = this.agents?.get(agentId);
    if (!agent) return;

    try {
      // Capture last 10 lines of terminal output
      const output = await this.tmux.capturePane(tmuxSession, 10, false);
      const lastOutput = this.lastOutputCache.get(agentId) || "";

      // If output has changed, agent is producing output (working)
      if (output !== lastOutput) {
        this.lastOutputCache.set(agentId, output);
        this.lastOutputTimestamps.set(agentId, Date.now());

        // Update activity to "working" if not already
        if (agent.activity !== "working") {
          agent.activity = "working";
          agent.lastActivityAt = new Date().toISOString();
          agent.lastOutputAt = new Date().toISOString();
          delete agent.idleSince;
          this.emit("agent-working", agentId);
        } else {
          // Still working, just update timestamps
          agent.lastOutputAt = new Date().toISOString();
        }
        return;
      }

      // No output change — check if idle timeout exceeded
      const lastOutputTime = this.lastOutputTimestamps.get(agentId) || Date.now();
      const timeSinceOutput = Date.now() - lastOutputTime;

      if (timeSinceOutput > IDLE_TIMEOUT_MS) {
        // Check if terminal shows a shell prompt (idle indicator)
        const lines = output.trim().split('\n').filter(l => l.trim());
        const lastLine = lines[lines.length - 1] || '';

        const isAtPrompt = IDLE_PROMPT_PATTERNS.some(pattern => pattern.test(lastLine));

        if (isAtPrompt && agent.activity !== "idle") {
          agent.activity = "idle";
          agent.lastActivityAt = new Date().toISOString();
          agent.idleSince = new Date().toISOString();
          this.emit("agent-idle", agentId);
        }
      }
    } catch (err) {
      // Ignore errors during idle detection (tmux might be unavailable temporarily)
    }
  }

  /** Stop monitoring an agent */
  stopMonitoring(agentId: string): void {
    const interval = this.intervals.get(agentId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(agentId);
    }
    this.lastOutputTimestamps.delete(agentId);
    this.lastOutputCache.delete(agentId);
  }

  /** Stop all monitoring */
  stopAll(): void {
    for (const [id] of this.intervals) {
      this.stopMonitoring(id);
    }
  }
}
