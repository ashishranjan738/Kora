import type { AgentState, AgentHealthCheck } from "@kora/shared";
import { HEALTH_CHECK_INTERVAL_MS, MAX_CONSECUTIVE_FAILURES } from "@kora/shared";
import type { IPtyBackend } from "./pty-backend.js";
import { EventEmitter } from "events";

/**
 * Comprehensive ANSI escape sequence regex (matches ansi-regex npm package).
 * Covers:
 * - OSC sequences: ESC ] ... (ST|BEL) — window titles, hyperlinks, etc.
 * - CSI sequences: ESC [ ... letter — colors, cursor movement, erasing
 * - Other C1 escapes: ESC followed by various characters
 *
 * Used to normalize holdpty's raw PTY output before hashing and pattern matching.
 * Without this, cursor blink sequences, window title updates, and other invisible
 * ANSI output causes the hash to change every poll — falsely marking idle agents
 * as "working".
 */
const ANSI_REGEX = /(?:\u001B\][\s\S]*?(?:\u0007|\u001B\u005C|\u009C))|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

/**
 * Strip all ANSI escape sequences from terminal output.
 * Fast path: returns input unchanged if no ESC/CSI characters present.
 */
export function stripAnsi(text: string): string {
  if (!text.includes('\u001B') && !text.includes('\u009B')) {
    return text;
  }
  return text.replace(ANSI_REGEX, '');
}

/** Shell prompt patterns that indicate the agent is idle at a command prompt */
export const IDLE_PROMPT_PATTERNS = [
  /[$%>#\u276F]\s*$/,              // Generic shell prompts (❯, $, %, >, #)
  /\s+[$%>\u276F]\s*$/,            // Shell prompts with leading whitespace
  /\w+@\w+\s+[$%>]\s*$/,           // user@host style (user@host $ )
  /^\s*\[.*?\]\s*[$%>]\s*$/,       // Bracketed prompts ([user@host] $ )
  /\?\s+for shortcuts\s*$/,        // Claude Code "? for shortcuts" prompt
];

/**
 * Keywords in agent messages that indicate the agent is idle/done.
 * When detected in send_message content, immediately infer idle status.
 */
export const IDLE_MESSAGE_KEYWORDS = [
  "standing by",
  "task complete",
  "ready for next",
  "ready for new",
  "waiting for",
  "completed the task",
  "finished the task",
  "done with",
  "all done",
  "reporting idle",
];

/** How long to wait without output before considering an agent idle (ms) */
const IDLE_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * How long an MCP-reported idle status is protected from terminal override (ms).
 * During this window, only clear non-prompt terminal output will override idle.
 * This prevents terminal polling from flapping the status right after an agent
 * explicitly reports itself as idle.
 */
const MCP_IDLE_PROTECTION_MS = 120_000; // 2 minutes

export class AgentHealthMonitor extends EventEmitter {
  private intervals = new Map<string, NodeJS.Timeout>();
  private lastOutputTimestamps = new Map<string, number>();
  private lastOutputCache = new Map<string, string>();
  private agents?: Map<string, AgentState>;

  /**
   * Layer 1: MCP-reported idle timestamps.
   * When an agent calls report_idle or sends a completion message,
   * we record the timestamp here. Terminal polling won't override
   * idle status while within the protection window.
   */
  private mcpIdleTimestamps = new Map<string, number>();

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

  /**
   * Layer 1 (highest confidence): Mark agent as idle from MCP signal.
   * Called when:
   * - Agent calls report_idle MCP tool (via API)
   * - Agent sends a completion message with idle keywords
   *
   * This immediately sets activity to "idle" and protects it from
   * being overridden by terminal polling for MCP_IDLE_PROTECTION_MS.
   */
  markIdleFromMcp(agentId: string, reason?: string): void {
    const agent = this.agents?.get(agentId);
    if (!agent) return;

    this.mcpIdleTimestamps.set(agentId, Date.now());

    if (agent.activity !== "idle") {
      agent.activity = "idle";
      agent.lastActivityAt = new Date().toISOString();
      agent.idleSince = new Date().toISOString();
      this.emit("agent-idle", agentId);
    }
  }

  /**
   * Check if a message contains idle/completion keywords.
   * Used to infer idle status from send_message content.
   */
  static isMessageIdle(content: string): boolean {
    const lower = content.toLowerCase();
    return IDLE_MESSAGE_KEYWORDS.some(kw => lower.includes(kw));
  }

  /**
   * Check if an agent's idle status is protected by a recent MCP report.
   */
  private isMcpIdleProtected(agentId: string): boolean {
    const mcpTime = this.mcpIdleTimestamps.get(agentId);
    if (!mcpTime) return false;
    return (Date.now() - mcpTime) < MCP_IDLE_PROTECTION_MS;
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

  /**
   * Check if agent is idle by examining terminal output.
   *
   * 3-layer confidence system:
   * - Layer 1 (highest): MCP report_idle / completion message -> instant idle (protected)
   * - Layer 2: Terminal prompt pattern matching (❯, $, %) -> idle after match
   * - Layer 3 (lowest): Hash-based change detection -> idle after 30s no change
   */
  private async checkIdleState(agentId: string, tmuxSession: string): Promise<void> {
    const agent = this.agents?.get(agentId);
    if (!agent) return;

    try {
      // Capture last 10 lines of terminal output.
      // capturePane(escapeSequences=false) strips ANSI in holdpty mode.
      const output = await this.tmux.capturePane(tmuxSession, 10, false);
      const lastOutput = this.lastOutputCache.get(agentId) || "";

      // Layer 2: Check if current output shows a shell prompt
      const lines = output.trim().split('\n').filter(l => l.trim());
      const lastLine = lines[lines.length - 1] || '';
      const isAtPrompt = IDLE_PROMPT_PATTERNS.some(pattern => pattern.test(lastLine));

      // If output has changed
      if (output !== lastOutput) {
        this.lastOutputCache.set(agentId, output);

        // If new output is a shell prompt, don't mark as working
        // Instead, check if we should transition to idle
        if (isAtPrompt) {
          const lastOutputTime = this.lastOutputTimestamps.get(agentId) || Date.now();
          const timeSinceOutput = Date.now() - lastOutputTime;

          // If been at prompt for idle timeout, mark as idle
          if (timeSinceOutput > IDLE_TIMEOUT_MS && agent.activity !== "idle") {
            agent.activity = "idle";
            agent.lastActivityAt = new Date().toISOString();
            agent.idleSince = new Date(lastOutputTime).toISOString();
            this.emit("agent-idle", agentId);
          }
          // Don't update timestamp - we're at a prompt, not producing real output
          return;
        }

        // Output changed and NOT at a prompt -> real work is happening
        this.lastOutputTimestamps.set(agentId, Date.now());

        // Layer 1 check: If agent recently reported idle via MCP, don't
        // override to "working" from terminal noise. Only clear MCP idle
        // protection when there's sustained new output (not just one poll).
        if (this.isMcpIdleProtected(agentId)) {
          // MCP says idle — trust it over terminal polling
          return;
        }

        // Update activity to "working" if not already
        if (agent.activity !== "working") {
          agent.activity = "working";
          agent.lastActivityAt = new Date().toISOString();
          agent.lastOutputAt = new Date().toISOString();
          delete agent.idleSince;
          this.mcpIdleTimestamps.delete(agentId); // Clear stale MCP idle
          this.emit("agent-working", agentId);
        } else {
          // Still working, just update timestamps
          agent.lastOutputAt = new Date().toISOString();
        }
        return;
      }

      // Layer 3: No output change — check if idle timeout exceeded
      const lastOutputTime = this.lastOutputTimestamps.get(agentId) || Date.now();
      const timeSinceOutput = Date.now() - lastOutputTime;

      if (timeSinceOutput > IDLE_TIMEOUT_MS && isAtPrompt && agent.activity !== "idle") {
        agent.activity = "idle";
        agent.lastActivityAt = new Date().toISOString();
        agent.idleSince = new Date(lastOutputTime).toISOString();
        this.emit("agent-idle", agentId);
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
    this.mcpIdleTimestamps.delete(agentId);
  }

  /** Stop all monitoring */
  stopAll(): void {
    for (const [id] of this.intervals) {
      this.stopMonitoring(id);
    }
  }
}
